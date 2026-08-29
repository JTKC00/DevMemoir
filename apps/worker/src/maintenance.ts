import { MAINTENANCE_ACTIVE_WINDOW_MS, maintenanceReconciliationRunId, maintenanceWindowBucket, type MaintenanceTask } from "@devmemoir/domain";
import type { M1Store, MaintenanceTarget } from "@devmemoir/db";
import type { GithubAppClient } from "@devmemoir/github";
import { MAINTENANCE_SCHEDULES, maintenanceTickLogicalKey, type JobPort, type SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { enqueueGithubDeliveryAudit } from "./delivery-audit.js";
import { enqueueRepositoryReconciliation } from "./reconciliation.js";

export type MaintenanceDependencies = {
  store: M1Store;
  jobs: JobPort;
  logger: Logger;
  config: { GITHUB_APP_ID: number };
  now?: () => Date;
  githubApp?: GithubAppClient;
};

function currentTime(deps: MaintenanceDependencies): Date {
  return (deps.now ?? (() => new Date()))();
}

export async function registerMaintenanceSchedules(jobs: JobPort): Promise<void> {
  for (const schedule of MAINTENANCE_SCHEDULES) {
    await jobs.schedule(schedule.kind, schedule.cron, { kind: schedule.kind, maintenanceTask: schedule.task }, { tz: "UTC" });
  }
}

export async function enqueueCurrentMaintenanceTicks(jobs: JobPort, now = new Date()): Promise<void> {
  for (const schedule of MAINTENANCE_SCHEDULES) {
    const payload: SyncJobPayload = { kind: schedule.kind, maintenanceTask: schedule.task };
    await jobs.enqueue(schedule.kind, maintenanceTickLogicalKey(schedule.kind, maintenanceWindowBucket(schedule.task, now)), payload);
  }
}

async function reconciliationRunForTarget(
  target: MaintenanceTarget,
  task: Exclude<MaintenanceTask, "delivery_audit">,
  now: Date,
  store: M1Store,
): Promise<{ reconciliationRunId: string; startAfter?: Date }> {
  const current = await store.getCurrentRepositoryReconciliationGeneration(target.tenantId, target.repositoryId);
  if (current) {
    const progress = await store.listHistoricalProgress(target.tenantId, target.repositoryId);
    const active = progress.find((row) => row.status === "in_progress" || row.status === "paused");
    if (active) {
      const startAfter = active.status === "paused" && active.pausedUntil && active.pausedUntil > now ? active.pausedUntil : undefined;
      return startAfter ? { reconciliationRunId: current.reconciliationRunId, startAfter } : { reconciliationRunId: current.reconciliationRunId };
    }
  }
  return { reconciliationRunId: maintenanceReconciliationRunId(task, target.repositoryId, now) };
}

async function tickReconciliation(task: Exclude<MaintenanceTask, "delivery_audit">, deps: MaintenanceDependencies, now: Date): Promise<void> {
  const activeSince = task === "active_reconciliation" ? new Date(now.getTime() - MAINTENANCE_ACTIVE_WINDOW_MS) : undefined;
  const targets = await deps.store.listMaintenanceTargets(activeSince ? { activeSince } : undefined);
  let enqueued = 0;
  let skipped = 0;
  for (const target of targets) {
    const run = await reconciliationRunForTarget(target, task, now, deps.store);
    try {
      const ok = await enqueueRepositoryReconciliation(
        { tenantId: target.tenantId, repositoryId: target.repositoryId, installationGithubId: target.installationGithubId, reconciliationRunId: run.reconciliationRunId },
        deps,
        run.startAfter,
      );
      if (ok) enqueued += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
      deps.logger.warn({ maintenance_task: task, repository_id: target.repositoryId, result: "skipped", error_code: "enqueue_failed" });
    }
  }
  deps.logger.info({ maintenance_task: task, result: "enqueued", eligible_count: targets.length, enqueued_count: enqueued, skipped_count: skipped });
}

async function tickDeliveryAudit(deps: MaintenanceDependencies, now: Date): Promise<void> {
  if (!deps.githubApp) throw new Error("App-JWT GitHub client is required for delivery audit");
  const existing = await deps.store.getGithubDeliveryAudit(deps.config.GITHUB_APP_ID);
  const startAfter = existing?.status === "paused" && existing.pausedUntil && existing.pausedUntil > now ? existing.pausedUntil : undefined;
  await enqueueGithubDeliveryAudit({ githubAppId: deps.config.GITHUB_APP_ID }, { store: deps.store, jobs: deps.jobs, githubApp: deps.githubApp, logger: deps.logger, now: () => now }, startAfter);
  deps.logger.info({ maintenance_task: "delivery_audit", result: "enqueued", eligible_count: 1, enqueued_count: 1, skipped_count: 0 });
}

export async function processMaintenanceTick(payload: SyncJobPayload, deps: MaintenanceDependencies, jobId: string): Promise<void> {
  const task = payload.maintenanceTask ?? MAINTENANCE_SCHEDULES.find((schedule) => schedule.kind === payload.kind)?.task;
  if (!task) throw new Error("Unknown maintenance task");
  const now = currentTime(deps);
  const bucket = maintenanceWindowBucket(task, now);
  const jobKind = payload.kind ?? MAINTENANCE_SCHEDULES.find((schedule) => schedule.task === task)?.kind;
  if (!jobKind) throw new Error("Unknown maintenance job kind");
  const claimed = await deps.store.claimMaintenanceWindow({ task, bucket, jobKind, jobId, now });
  if (!claimed) {
    deps.logger.info({ maintenance_task: task, result: "skipped", eligible_count: 0, enqueued_count: 0, skipped_count: 1 });
    return;
  }
  try {
    if (task === "delivery_audit") await tickDeliveryAudit(deps, now);
    else await tickReconciliation(task, deps, now);
    await deps.store.completeMaintenanceWindow({ task, bucket, jobId, now: currentTime(deps) });
  } catch (error) {
    await deps.store.recordMaintenanceWindowError({ task, bucket, jobId, errorCode: "tick_failed", now: currentTime(deps) });
    deps.logger.error({ maintenance_task: task, result: "failed", error_code: "tick_failed" }, error);
    throw error;
  }
}
