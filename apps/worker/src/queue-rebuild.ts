import type { M1Store, QueueRebuildReconciliationTarget } from "@devmemoir/db";
import {
  MAINTENANCE_JOB_KINDS,
  MAINTENANCE_SCHEDULES,
  PRIVACY_PAYLOAD_PURGE_KIND,
  maintenanceTickLogicalKey,
  type JobPort,
  type MaintenanceJobKind,
  type SyncJobPayload,
} from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { enqueueGithubDeliveryAudit, resumeGithubDeliveryRepairs } from "./delivery-audit.js";
import { registerOperationalSchedules } from "./maintenance.js";
import { enqueueRepositoryReconciliation } from "./reconciliation.js";

export type QueueRebuildResult = {
  result: "completed" | "partial" | "failed" | "dry_run";
  reconciliation: {
    discovered: number;
    enqueued: number;
    paused: number;
    blocked: number;
    completedSkipped: number;
  };
  deliveryAudit: {
    enqueued: number;
    paused: number;
    completedSkipped: number;
  };
  deliveryRepairs: {
    recoverableFound: number;
    enqueued: number;
    skipped: number;
  };
  maintenance: {
    incompleteFound: number;
    ownershipRecovered: number;
    completedSkipped: number;
  };
  schedules: {
    registered: number;
  };
};

export type QueueRebuildDependencies = {
  store: M1Store;
  githubAppId: number;
  logger: Logger;
  jobs?: JobPort;
  now?: () => Date;
  dryRun?: boolean;
};

function currentTime(deps: QueueRebuildDependencies): Date {
  return (deps.now ?? (() => new Date()))();
}

function laterDate(left?: Date, right?: Date): Date | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function resumeAt(target: QueueRebuildReconciliationTarget, now: Date): Date | undefined {
  const paused = target.pausedUntil && target.pausedUntil > now ? target.pausedUntil : undefined;
  const apiPaused = target.installationApiPausedUntil && target.installationApiPausedUntil > now ? target.installationApiPausedUntil : undefined;
  return laterDate(paused, apiPaused);
}

function isMaintenanceJobKind(value: string): value is MaintenanceJobKind {
  return (MAINTENANCE_JOB_KINDS as readonly string[]).includes(value);
}

export function emptyQueueRebuildResult(result: QueueRebuildResult["result"] = "completed"): QueueRebuildResult {
  return {
    result,
    reconciliation: { discovered: 0, enqueued: 0, paused: 0, blocked: 0, completedSkipped: 0 },
    deliveryAudit: { enqueued: 0, paused: 0, completedSkipped: 0 },
    deliveryRepairs: { recoverableFound: 0, enqueued: 0, skipped: 0 },
    maintenance: { incompleteFound: 0, ownershipRecovered: 0, completedSkipped: 0 },
    schedules: { registered: 0 },
  };
}

export function formatQueueRebuildCounts(result: QueueRebuildResult): string {
  return [
    `reconciliation_resume: ${result.reconciliation.enqueued}`,
    `delivery_audit_resume: ${result.deliveryAudit.enqueued}`,
    `delivery_repairs_resume: ${result.deliveryRepairs.enqueued}`,
    `maintenance_window_recoveries: ${result.maintenance.ownershipRecovered}`,
    `schedules_register: ${result.schedules.registered}`,
    `blocked: ${result.reconciliation.blocked}`,
  ].join("\n");
}

function logRebuild(deps: QueueRebuildDependencies, result: QueueRebuildResult): void {
  deps.logger.info({
    event_type: "queue_rebuild",
    result: result.result,
    reconciliation_count: result.reconciliation.enqueued,
    audit_count: result.deliveryAudit.enqueued,
    repair_count: result.deliveryRepairs.enqueued,
    maintenance_count: result.maintenance.ownershipRecovered,
    blocked_count: result.reconciliation.blocked,
  });
}

async function rebuildReconciliation(deps: QueueRebuildDependencies, result: QueueRebuildResult, now: Date): Promise<number> {
  const targets = await deps.store.listQueueRebuildReconciliationTargets();
  result.reconciliation.discovered = targets.length;
  let failures = 0;
  for (const target of targets) {
    if (target.completed) {
      result.reconciliation.completedSkipped += 1;
      continue;
    }
    if (target.blocked) {
      result.reconciliation.blocked += 1;
      continue;
    }
    const startAfter = resumeAt(target, now);
    if (deps.dryRun) {
      result.reconciliation.enqueued += 1;
      if (startAfter) result.reconciliation.paused += 1;
      continue;
    }
    if (!deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
    try {
      const ok = await enqueueRepositoryReconciliation(
        {
          tenantId: target.tenantId,
          repositoryId: target.repositoryId,
          installationGithubId: target.installationGithubId,
          reconciliationRunId: target.reconciliationRunId,
        },
        { store: deps.store, jobs: deps.jobs },
        startAfter,
      );
      if (!ok) {
        result.reconciliation.blocked += 1;
        continue;
      }
      result.reconciliation.enqueued += 1;
      if (startAfter) result.reconciliation.paused += 1;
    } catch (error) {
      failures += 1;
      deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "reconciliation_enqueue_failed", repository_id: target.repositoryId }, error);
    }
  }
  return failures;
}

async function rebuildDeliveryAudit(deps: QueueRebuildDependencies, result: QueueRebuildResult, now: Date): Promise<number> {
  const audit = await deps.store.getQueueRebuildDeliveryAudit(deps.githubAppId);
  if (!audit) return 0;
  if (audit.status === "completed") {
    result.deliveryAudit.completedSkipped += 1;
    return 0;
  }
  if (audit.status !== "in_progress" && audit.status !== "paused" && audit.status !== "pending") {
    result.deliveryAudit.completedSkipped += 1;
    return 0;
  }
  const startAfter = audit.pausedUntil && audit.pausedUntil > now ? audit.pausedUntil : undefined;
  if (deps.dryRun) {
    result.deliveryAudit.enqueued += 1;
    if (startAfter) result.deliveryAudit.paused += 1;
    return 0;
  }
  if (!deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
  try {
    await enqueueGithubDeliveryAudit(
      { githubAppId: audit.githubAppId, auditRunId: audit.currentRunId },
      { store: deps.store, jobs: deps.jobs, now: () => now },
      startAfter,
    );
    result.deliveryAudit.enqueued += 1;
    if (startAfter) result.deliveryAudit.paused += 1;
    return 0;
  } catch (error) {
    deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "audit_enqueue_failed", audit_run_id: audit.currentRunId }, error);
    return 1;
  }
}

async function rebuildDeliveryRepairs(deps: QueueRebuildDependencies, result: QueueRebuildResult, now: Date): Promise<number> {
  const repairs = await deps.store.listRecoverableGithubDeliveryRepairs(deps.githubAppId);
  result.deliveryRepairs.recoverableFound = repairs.length;
  if (deps.dryRun) {
    result.deliveryRepairs.enqueued = repairs.length;
    return 0;
  }
  if (!deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
  try {
    const enqueued = await resumeGithubDeliveryRepairs(deps.githubAppId, { store: deps.store, jobs: deps.jobs, now: () => now });
    result.deliveryRepairs.enqueued = enqueued;
    result.deliveryRepairs.skipped = Math.max(0, repairs.length - enqueued);
    return 0;
  } catch (error) {
    deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "repair_enqueue_failed" }, error);
    return 1;
  }
}

async function rebuildMaintenanceWindows(deps: QueueRebuildDependencies, result: QueueRebuildResult, now: Date): Promise<number> {
  const incomplete = await deps.store.listIncompleteMaintenanceWindows();
  result.maintenance.incompleteFound = incomplete.length;
  let failures = 0;
  for (const window of incomplete) {
    if (deps.dryRun) {
      result.maintenance.ownershipRecovered += 1;
      continue;
    }
    if (!deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
    if (!isMaintenanceJobKind(window.jobKind)) {
      failures += 1;
      deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "unknown_maintenance_kind", maintenance_task: window.task });
      continue;
    }
    try {
      const payload: SyncJobPayload = { kind: window.jobKind, maintenanceTask: window.task, maintenanceBucket: window.bucket };
      const logicalKey = maintenanceTickLogicalKey(window.jobKind, window.bucket);
      const enqueuedJobId = await deps.jobs.enqueue(window.jobKind, logicalKey, payload);
      const jobId = enqueuedJobId ?? await deps.jobs.findActiveJobByLogicalKey(window.jobKind, logicalKey);
      if (!jobId) {
        failures += 1;
        deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "maintenance_replacement_job_missing", maintenance_task: window.task });
        continue;
      }
      if (jobId === window.acceptedJobId) continue;
      const recovered = await deps.store.recoverIncompleteMaintenanceWindow({
        task: window.task,
        bucket: window.bucket,
        expectedAcceptedJobId: window.acceptedJobId,
        replacementJobId: jobId,
        now,
      });
      if (recovered) {
        result.maintenance.ownershipRecovered += 1;
        continue;
      }
      const current = await deps.store.getMaintenanceWindow(window.task, window.bucket);
      if (current?.completedAt) result.maintenance.completedSkipped += 1;
    } catch (error) {
      failures += 1;
      deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "maintenance_recover_failed", maintenance_task: window.task }, error);
    }
  }
  return failures;
}

async function rebuildSchedules(deps: QueueRebuildDependencies, result: QueueRebuildResult): Promise<number> {
  if (deps.dryRun) {
    result.schedules.registered = MAINTENANCE_SCHEDULES.length + 1;
    return 0;
  }
  if (!deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
  try {
    await registerOperationalSchedules(deps.jobs);
    const names = new Set<string>([...MAINTENANCE_JOB_KINDS, PRIVACY_PAYLOAD_PURGE_KIND]);
    result.schedules.registered = (await deps.jobs.getSchedules()).filter((schedule) => names.has(schedule.name)).length;
    return 0;
  } catch (error) {
    deps.logger.error({ event_type: "queue_rebuild", result: "failed", error_code: "schedule_register_failed" }, error);
    return 1;
  }
}

export async function rebuildQueue(deps: QueueRebuildDependencies): Promise<QueueRebuildResult> {
  const now = currentTime(deps);
  const result = emptyQueueRebuildResult(deps.dryRun ? "dry_run" : "completed");
  if (!deps.dryRun && !deps.jobs) throw new Error("Queue rebuild requires a JobPort unless --dry-run");
  let failures = 0;
  failures += await rebuildSchedules(deps, result);
  failures += await rebuildReconciliation(deps, result, now);
  failures += await rebuildDeliveryAudit(deps, result, now);
  failures += await rebuildDeliveryRepairs(deps, result, now);
  failures += await rebuildMaintenanceWindows(deps, result, now);
  if (!deps.dryRun && failures > 0) result.result = result.reconciliation.enqueued + result.deliveryAudit.enqueued + result.deliveryRepairs.enqueued + result.maintenance.ownershipRecovered + result.schedules.registered > 0 ? "partial" : "failed";
  logRebuild(deps, result);
  return result;
}
