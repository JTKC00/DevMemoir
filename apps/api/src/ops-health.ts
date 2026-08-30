import { MAINTENANCE_TASKS, maintenanceWindowBucket, type MaintenanceTask } from "@devmemoir/domain";
import {
  DELIVERY_REPAIR_LARGE_BACKLOG_THRESHOLD,
  OPERATIONAL_STUCK_WORK_MS,
  type DeliveryRepairOperationalHealth,
  type GithubDeliveryAudit,
  type GithubDeliveryRepairStatusCounts,
  type GithubQuotaOperationalHealth,
  type HistoricalProgress,
  type MaintenanceOperationalSummary,
  type MaintenanceWindow,
  type OperationalLeaseAlerts,
  type RepositoryOperationalRecord,
  type WorkerOperationalHealth,
} from "@devmemoir/db";

export const ACTIVE_RECONCILIATION_STALE_MS = 12 * 60 * 60 * 1000;
export const AUTHORIZED_RECONCILIATION_STALE_MS = 36 * 60 * 60 * 1000;
export const DELIVERY_AUDIT_STALE_MS = 12 * 60 * 60 * 1000;

export type OperationalState = "healthy" | "in_progress" | "paused" | "failed" | "stale" | "never_run";
export type OverallOperationalState = "healthy" | "degraded" | "attention_required";

export type OwnerOperationalHealth = {
  overall: OverallOperationalState;
  generatedAt: string;
  maintenance: Array<{ task: MaintenanceTask; bucket: string; state: "completed" | "running" | "failed_or_incomplete"; acceptedAt?: string; completedAt?: string; errorCode?: string }>;
  deliveryAudit: { state: OperationalState; generation?: number; page?: number; startedAt?: string; updatedAt?: string; completedAt?: string; lastSuccessAt?: string; pausedUntil?: string; errorCode?: string };
  deliveryRepairs: { recoverable: number; terminal: number; byStatus: GithubDeliveryRepairStatusCounts };
  repositories: Array<{ repositoryId: string; installationGithubId: number; state: OperationalState; generation?: number; stage?: string; lastSuccessAt?: string; completedAt?: string; pausedUntil?: string; errorCode?: string }>;
  operations: {
    worker: { state: WorkerOperationalHealth["state"]; liveWorkers: number; staleWorkers: number; lastHeartbeatAt?: string };
    reconciliation: { activeAgeSeconds?: number; authorizedAgeSeconds?: number; stuckCount: number; oldestActivityAt?: string };
    githubQuota: { pausedInstallations: number; earliestResumeAt?: string; latestResumeAt?: string; appAuditPaused: boolean; appAuditResumeAt?: string };
    leases: { expiredProcessing: number; stuckReconciliations: number; stuckAudits: number; stuckMaintenanceWindows: number };
    repairs: { recoverableBacklog: number; pausedRecoverable: number; readyRecoverable: number; exhausted: number; oldestRecoverableAgeSeconds?: number; needsAttention: boolean };
  };
};

export type OperationalWarning = {
  eventType: "worker_heartbeat_stale" | "processing_lease_expired" | "reconciliation_stuck" | "delivery_audit_stuck" | "maintenance_window_stuck" | "github_quota_paused" | "delivery_repair_attention";
  count: number;
};

const RECOVERABLE = ["pending", "requesting", "requested", "skipped_processing"] as const;
const TERMINAL = ["healthy", "expired", "exhausted", "skipped_terminal"] as const;

function iso(value: Date | undefined): string | undefined { return value?.toISOString(); }
function safeError(value: string | undefined): string | undefined { return value && /^[a-z0-9_:-]{1,120}$/i.test(value) ? value : value ? "operational_error" : undefined; }
function latest(values: Array<Date | undefined>): Date | undefined {
  return values.reduce<Date | undefined>((current, value) => value && (!current || value > current) ? value : current, undefined);
}
function stale(last: Date | undefined, now: Date, threshold: number): boolean { return !last || now.getTime() - last.getTime() > threshold; }
function ageSeconds(value: Date | undefined, now: Date): number | undefined { return value ? Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000)) : undefined; }
function progressForGeneration(source: RepositoryOperationalRecord): HistoricalProgress[] {
  if (!source.generation) return [];
  return source.progress.filter((row) => row.cursor.reconciliationRunId === source.generation?.reconciliationRunId);
}

export function deriveRepositoryHealth(source: RepositoryOperationalRecord, now: Date): OwnerOperationalHealth["repositories"][number] {
  const progress = progressForGeneration(source);
  if (!source.generation) return { repositoryId: source.repositoryId, installationGithubId: source.installationGithubId, state: "never_run" as const };
  const active = progress.find((row) => row.status === "paused") ?? progress.find((row) => row.status === "in_progress") ?? progress.find((row) => row.status === "pending");
  const completed = progress.find((row) => row.stage === "completed" && row.status === "completed");
  const lastSuccess = latest(progress.map((row) => row.lastSuccessAt));
  const lastActivity = latest([...progress.map((row) => row.lastSuccessAt), ...progress.map((row) => row.startedAt), ...progress.map((row) => row.completedAt), source.generation.startedAt]);
  const errorCode = safeError(active?.errorCode ?? progress.find((row) => row.errorCode)?.errorCode);
  let state: OperationalState;
  if (active?.status === "paused" && active.pausedUntil && active.pausedUntil > now) state = "paused";
  else if (errorCode && !completed) state = "failed";
  else if (stale(lastActivity, now, ACTIVE_RECONCILIATION_STALE_MS)) state = "stale";
  else if (completed) state = "healthy";
  else state = "in_progress";
  const stage = active?.stage ?? completed?.stage;
  const lastSuccessAt = iso(lastSuccess);
  const completedAt = iso(completed?.completedAt);
  const pausedUntil = iso(active?.pausedUntil);
  return {
    repositoryId: source.repositoryId,
    installationGithubId: source.installationGithubId,
    state,
    generation: source.generation.generation,
    ...(stage ? { stage } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(pausedUntil ? { pausedUntil } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function deriveDeliveryAuditHealth(audit: GithubDeliveryAudit | undefined, now: Date): OwnerOperationalHealth["deliveryAudit"] {
  if (!audit) return { state: "never_run" };
  const lastActivity = audit.lastSuccessAt ?? audit.updatedAt ?? audit.startedAt;
  let state: OperationalState;
  if (audit.status === "paused" && audit.pausedUntil && audit.pausedUntil > now) state = "paused";
  else if (audit.lastErrorCode && audit.status !== "completed") state = "failed";
  else if (stale(lastActivity, now, DELIVERY_AUDIT_STALE_MS)) state = "stale";
  else if (audit.status === "completed") state = "healthy";
  else state = "in_progress";
  const errorCode = safeError(audit.lastErrorCode ?? audit.pauseReason);
  const completedAt = iso(audit.completedAt);
  const lastSuccessAt = iso(audit.lastSuccessAt);
  const pausedUntil = iso(audit.pausedUntil);
  return { state, generation: audit.generation, page: audit.pageNumber, startedAt: audit.startedAt.toISOString(), updatedAt: audit.updatedAt.toISOString(), ...(completedAt ? { completedAt } : {}), ...(lastSuccessAt ? { lastSuccessAt } : {}), ...(pausedUntil ? { pausedUntil } : {}), ...(errorCode ? { errorCode } : {}) };
}

function maintenanceThreshold(task: MaintenanceTask): number { return task === "authorized_reconciliation" ? AUTHORIZED_RECONCILIATION_STALE_MS : task === "delivery_audit" ? DELIVERY_AUDIT_STALE_MS : ACTIVE_RECONCILIATION_STALE_MS; }

function deriveRepairAttention(input: {
  recoverableBacklog: number;
  pausedRecoverable: number;
  exhausted: number;
  oldestReadyAgeSeconds?: number;
}): { readyRecoverable: number; needsAttention: boolean } {
  const readyRecoverable = Math.max(0, input.recoverableBacklog - input.pausedRecoverable);
  const readyBacklogLarge = readyRecoverable >= DELIVERY_REPAIR_LARGE_BACKLOG_THRESHOLD;
  const readyBacklogAged = readyRecoverable > 0 && (input.oldestReadyAgeSeconds ?? 0) > OPERATIONAL_STUCK_WORK_MS / 1000;
  return { readyRecoverable, needsAttention: input.exhausted > 0 || readyBacklogLarge || readyBacklogAged };
}

export function deriveOwnerOperationalHealth(input: {
  now: Date;
  maintenance: MaintenanceWindow[];
  maintenanceSummary?: MaintenanceOperationalSummary[];
  audit?: GithubDeliveryAudit;
  repairCounts: GithubDeliveryRepairStatusCounts;
  repositories: RepositoryOperationalRecord[];
  worker?: WorkerOperationalHealth;
  leaseAlerts?: OperationalLeaseAlerts;
  quota?: GithubQuotaOperationalHealth;
  repairHealth?: DeliveryRepairOperationalHealth;
}): OwnerOperationalHealth {
  const byTask = new Map(input.maintenance.map((window) => [window.task, window]));
  let staleMaintenance = false;
  const maintenance: OwnerOperationalHealth["maintenance"] = MAINTENANCE_TASKS.map((task) => {
    const window = byTask.get(task);
    if (!window) { staleMaintenance = true; return { task, bucket: maintenanceWindowBucket(task, input.now), state: "failed_or_incomplete" as const }; }
    const tooOld = stale(window.completedAt ?? window.updatedAt ?? window.acceptedAt, input.now, maintenanceThreshold(task));
    if (tooOld) staleMaintenance = true;
    let state: OwnerOperationalHealth["maintenance"][number]["state"];
    if (tooOld) state = "failed_or_incomplete";
    else if (window.completedAt) state = "completed";
    else if (!window.lastErrorCode) state = "running";
    else state = "failed_or_incomplete";
    const completedAt = iso(window.completedAt);
    const errorCode = safeError(window.lastErrorCode);
    return { task, bucket: window.bucket, state, acceptedAt: window.acceptedAt.toISOString(), ...(completedAt ? { completedAt } : {}), ...(errorCode ? { errorCode } : {}) };
  });
  const repositories = input.repositories.map((source) => deriveRepositoryHealth(source, input.now));
  const deliveryAudit = deriveDeliveryAuditHealth(input.audit, input.now);
  const recoverable = RECOVERABLE.reduce((sum, status) => sum + input.repairCounts[status], 0);
  const terminal = TERMINAL.reduce((sum, status) => sum + input.repairCounts[status], 0);
  const worker = input.worker ?? { state: "healthy", liveWorkers: 1, staleWorkers: 0, lastHeartbeatAt: input.now };
  const leaseAlerts = input.leaseAlerts ?? { expiredProcessing: 0, stuckReconciliations: 0, stuckAudits: 0, stuckMaintenanceWindows: 0 };
  const quota = input.quota ?? { pausedInstallations: 0, appAuditPaused: false };
  const repairHealth = input.repairHealth ?? { recoverableBacklog: recoverable, pausedRecoverable: 0, exhausted: input.repairCounts.exhausted };
  const summary = new Map(input.maintenanceSummary?.map((row) => [row.task, row]));
  const activeAgeSeconds = ageSeconds(summary.get("active_reconciliation")?.lastCompletedAt, input.now);
  const authorizedAgeSeconds = ageSeconds(summary.get("authorized_reconciliation")?.lastCompletedAt, input.now);
  const oldestRecoverableAgeSeconds = ageSeconds(repairHealth.oldestRecoverableAt, input.now);
  const oldestReadyAgeSeconds = ageSeconds(repairHealth.oldestReadyRecoverableAt, input.now);
  const { readyRecoverable, needsAttention: repairNeedsAttention } = deriveRepairAttention({
    recoverableBacklog: repairHealth.recoverableBacklog,
    pausedRecoverable: repairHealth.pausedRecoverable,
    exhausted: repairHealth.exhausted,
    ...(oldestReadyAgeSeconds !== undefined ? { oldestReadyAgeSeconds } : {}),
  });
  const stuckExists = leaseAlerts.expiredProcessing > 0 || leaseAlerts.stuckReconciliations > 0 || leaseAlerts.stuckAudits > 0 || leaseAlerts.stuckMaintenanceWindows > 0;
  const attention = staleMaintenance || worker.state === "stale" || stuckExists || repairNeedsAttention || repositories.some((row) => row.state === "failed" || row.state === "stale") || deliveryAudit.state === "failed" || deliveryAudit.state === "stale";
  const quotaPaused = quota.pausedInstallations > 0 || quota.appAuditPaused;
  const workerUnavailable = worker.state === "stopped" || worker.state === "never_seen";
  const degraded = recoverable > 0 || quotaPaused || workerUnavailable || repositories.some((row) => row.state === "paused") || deliveryAudit.state === "paused" || maintenance.some((row) => row.state === "running");
  const oldestActivityAt = iso(leaseAlerts.oldestRepositoryReconciliationActivityAt);
  const lastHeartbeatAt = iso(worker.lastHeartbeatAt);
  const earliestResumeAt = iso(quota.earliestResumeAt);
  const latestResumeAt = iso(quota.latestResumeAt);
  const appAuditResumeAt = iso(quota.appAuditResumeAt);
  return {
    overall: attention ? "attention_required" : degraded ? "degraded" : "healthy",
    generatedAt: input.now.toISOString(),
    maintenance,
    deliveryAudit,
    deliveryRepairs: { recoverable, terminal, byStatus: input.repairCounts },
    repositories,
    operations: {
      worker: { state: worker.state, liveWorkers: worker.liveWorkers, staleWorkers: worker.staleWorkers, ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}) },
      reconciliation: { ...(activeAgeSeconds !== undefined ? { activeAgeSeconds } : {}), ...(authorizedAgeSeconds !== undefined ? { authorizedAgeSeconds } : {}), stuckCount: leaseAlerts.stuckReconciliations, ...(oldestActivityAt ? { oldestActivityAt } : {}) },
      githubQuota: { pausedInstallations: quota.pausedInstallations, ...(earliestResumeAt ? { earliestResumeAt } : {}), ...(latestResumeAt ? { latestResumeAt } : {}), appAuditPaused: quota.appAuditPaused, ...(appAuditResumeAt ? { appAuditResumeAt } : {}) },
      leases: { expiredProcessing: leaseAlerts.expiredProcessing, stuckReconciliations: leaseAlerts.stuckReconciliations, stuckAudits: leaseAlerts.stuckAudits, stuckMaintenanceWindows: leaseAlerts.stuckMaintenanceWindows },
      repairs: { recoverableBacklog: repairHealth.recoverableBacklog, pausedRecoverable: repairHealth.pausedRecoverable, readyRecoverable, exhausted: repairHealth.exhausted, ...(oldestRecoverableAgeSeconds !== undefined ? { oldestRecoverableAgeSeconds } : {}), needsAttention: repairNeedsAttention },
    },
  };
}

export function operationalWarnings(health: OwnerOperationalHealth): OperationalWarning[] {
  const warnings: OperationalWarning[] = [];
  if (health.operations.worker.staleWorkers > 0) warnings.push({ eventType: "worker_heartbeat_stale", count: health.operations.worker.staleWorkers });
  if (health.operations.leases.expiredProcessing > 0) warnings.push({ eventType: "processing_lease_expired", count: health.operations.leases.expiredProcessing });
  if (health.operations.leases.stuckReconciliations > 0) warnings.push({ eventType: "reconciliation_stuck", count: health.operations.leases.stuckReconciliations });
  if (health.operations.leases.stuckAudits > 0) warnings.push({ eventType: "delivery_audit_stuck", count: health.operations.leases.stuckAudits });
  if (health.operations.leases.stuckMaintenanceWindows > 0) warnings.push({ eventType: "maintenance_window_stuck", count: health.operations.leases.stuckMaintenanceWindows });
  const quotaPauses = health.operations.githubQuota.pausedInstallations + Number(health.operations.githubQuota.appAuditPaused);
  if (quotaPauses > 0) warnings.push({ eventType: "github_quota_paused", count: quotaPauses });
  if (health.operations.repairs.needsAttention) warnings.push({ eventType: "delivery_repair_attention", count: health.operations.repairs.exhausted + health.operations.repairs.readyRecoverable });
  return warnings;
}

export const OPERATIONAL_WARNING_THROTTLE_MS = 5 * 60 * 1000;

type WarningLogger = { warn: (fields: { event_type: string; count: number }) => void };
const lastEmittedWarnings = new Map<OperationalWarning["eventType"], { at: number; count: number }>();

export function resetOperationalWarningThrottle(): void {
  lastEmittedWarnings.clear();
}

export function emitOperationalWarnings(input: {
  health: OwnerOperationalHealth;
  logger: WarningLogger;
  now?: Date;
  throttleMs?: number;
}): OperationalWarning[] {
  const nowMs = (input.now ?? new Date(input.health.generatedAt)).getTime();
  const throttleMs = input.throttleMs ?? OPERATIONAL_WARNING_THROTTLE_MS;
  const warnings = operationalWarnings(input.health);
  for (const warning of warnings) {
    const previous = lastEmittedWarnings.get(warning.eventType);
    if (previous && previous.count === warning.count && nowMs - previous.at < throttleMs) continue;
    input.logger.warn({ event_type: warning.eventType, count: warning.count });
    lastEmittedWarnings.set(warning.eventType, { at: nowMs, count: warning.count });
  }
  return warnings;
}
