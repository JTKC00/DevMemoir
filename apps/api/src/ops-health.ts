import { MAINTENANCE_TASKS, maintenanceWindowBucket, type MaintenanceTask } from "@devmemoir/domain";
import type { GithubDeliveryAudit, GithubDeliveryRepairStatusCounts, HistoricalProgress, MaintenanceWindow, RepositoryOperationalRecord } from "@devmemoir/db";

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
};

const RECOVERABLE = ["pending", "requesting", "requested", "skipped_processing"] as const;
const TERMINAL = ["healthy", "expired", "exhausted", "skipped_terminal"] as const;

function iso(value: Date | undefined): string | undefined { return value?.toISOString(); }
function safeError(value: string | undefined): string | undefined { return value && /^[a-z0-9_:-]{1,120}$/i.test(value) ? value : value ? "operational_error" : undefined; }
function latest(values: Array<Date | undefined>): Date | undefined {
  return values.reduce<Date | undefined>((current, value) => value && (!current || value > current) ? value : current, undefined);
}
function stale(last: Date | undefined, now: Date, threshold: number): boolean { return !last || now.getTime() - last.getTime() > threshold; }
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

export function deriveOwnerOperationalHealth(input: { now: Date; maintenance: MaintenanceWindow[]; audit?: GithubDeliveryAudit; repairCounts: GithubDeliveryRepairStatusCounts; repositories: RepositoryOperationalRecord[] }): OwnerOperationalHealth {
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
  const attention = staleMaintenance || input.repairCounts.exhausted > 0 || repositories.some((row) => row.state === "failed" || row.state === "stale") || deliveryAudit.state === "failed" || deliveryAudit.state === "stale";
  const degraded = recoverable > 0 || repositories.some((row) => row.state === "paused") || deliveryAudit.state === "paused" || maintenance.some((row) => row.state === "running");
  return { overall: attention ? "attention_required" : degraded ? "degraded" : "healthy", generatedAt: input.now.toISOString(), maintenance, deliveryAudit, deliveryRepairs: { recoverable, terminal, byStatus: input.repairCounts }, repositories };
}
