import { describe, expect, it } from "vitest";
import { GITHUB_DELIVERY_REPAIR_STATUSES, InMemoryM1Store } from "@devmemoir/db";
import { InMemoryJobPort, deliveryAuditLogicalKey, deliveryAuditWakeLogicalKey, maintenanceTickLogicalKey, repositoryReconciliationLogicalKey } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { formatQueueRebuildCounts, rebuildQueue } from "./queue-rebuild.js";
import { processMaintenanceTick } from "./maintenance.js";

const tenantId = "tenant-rebuild";
const repositoryId = "00000000-0000-4000-8000-0000000000aa";
const installationId = "installation-rebuild";
const installationGithubId = 8801;
const githubAppId = 42;
const now = new Date("2026-08-29T12:00:00Z");
const future = new Date("2026-08-29T18:00:00Z");
const runIds = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
] as const;
const auditRunId = "00000000-0000-4000-8000-0000000000bb";
const PRIVATE_REPOSITORY_NAME = "PRIVATE_REPOSITORY_NAME";
const PRIVATE_COMMIT_MESSAGE = "PRIVATE_COMMIT_MESSAGE";
const PRIVATE_PR_TITLE = "PRIVATE_PR_TITLE";
const PRIVATE_WEBHOOK_PAYLOAD = "PRIVATE_WEBHOOK_PAYLOAD";
const PRIVATE_TOKEN = "PRIVATE_TOKEN";
const canary = new RegExp(`${PRIVATE_REPOSITORY_NAME}|${PRIVATE_COMMIT_MESSAGE}|${PRIVATE_PR_TITLE}|${PRIVATE_WEBHOOK_PAYLOAD}|${PRIVATE_TOKEN}`);

const guids = Object.fromEntries(GITHUB_DELIVERY_REPAIR_STATUSES.map((status, index) => [status, `0b989ba4-242f-11e5-81e1-c7b6966d251${index}`])) as Record<(typeof GITHUB_DELIVERY_REPAIR_STATUSES)[number], string>;

async function seedBase(store: InMemoryM1Store): Promise<void> {
  await store.upsertUser({ userId: "user-rebuild", tenantId, githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: 7 });
  await store.saveRepository({
    id: repositoryId,
    tenantId,
    installationId,
    githubRepositoryId: 991,
    ownerLogin: PRIVATE_REPOSITORY_NAME,
    name: PRIVATE_REPOSITORY_NAME,
    fullName: `${PRIVATE_REPOSITORY_NAME}/repo`,
    private: true,
    defaultBranch: "main",
  });
}

async function seedGeneration(store: InMemoryM1Store, extra: { pausedUntil?: Date; blocked?: boolean; completed?: boolean } = {}): Promise<void> {
  for (const reconciliationRunId of runIds) {
    await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId, now });
  }
  for (const progress of store.historicalProgress.values()) {
    if (progress.tenantId !== tenantId || progress.repositoryId !== repositoryId) continue;
    if (progress.cursor.reconciliationRunId !== runIds[3]) continue;
    if (extra.completed) {
      progress.status = "completed";
      progress.completedAt = now;
      continue;
    }
    if (progress.stage === "completed") continue;
    if (progress.stage === "issues") {
      progress.status = extra.blocked || extra.pausedUntil ? "paused" : "in_progress";
      progress.cursor = { nextPage: 3, reconciliationRunId: runIds[3], mode: "structural" };
      progress.nextPage = 3;
      if (extra.pausedUntil) progress.pausedUntil = extra.pausedUntil;
      else delete progress.pausedUntil;
      continue;
    }
    progress.status = "completed";
    progress.completedAt = now;
  }
}

async function seedAudit(store: InMemoryM1Store, extra: { paused?: boolean; completed?: boolean; page?: number } = {}): Promise<void> {
  await store.startGithubDeliveryAudit({ githubAppId, auditRunId, now });
  const audit = store.githubDeliveryAudits.get(githubAppId);
  if (!audit) throw new Error("audit_missing");
  audit.generation = 6;
  audit.pageNumber = extra.page ?? 4;
  audit.listCursor = "cursor-x";
  if (extra.paused) {
    await store.pauseGithubDeliveryAudit({ githubAppId, auditRunId, pausedUntil: future, errorCode: "github_retry_after" });
  }
  if (extra.completed) {
    audit.status = "completed";
    audit.completedAt = now;
  }
}

async function seedRepairs(store: InMemoryM1Store): Promise<void> {
  for (const [index, status] of GITHUB_DELIVERY_REPAIR_STATUSES.entries()) {
    const guid = guids[status];
    await store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: guid,
      githubDeliveryId: 10_000 + index,
      githubAppId,
      auditRunId,
      eventName: PRIVATE_WEBHOOK_PAYLOAD,
      statusCode: status === "healthy" ? 200 : 500,
      deliveredAt: now,
      now,
    });
    const repair = store.githubDeliveryRepairs.get(guid);
    if (!repair) throw new Error("repair_missing");
    repair.status = status;
    repair.attemptCount = 2;
    repair.nextEligibleAt = future;
  }
}

function captureText(jobs: InMemoryJobPort, logs: string, result: unknown): string {
  return `${JSON.stringify(result)}\n${logs}\n${JSON.stringify([...jobs.jobs.values()])}\n${[...jobs.jobs.values()].map((job) => job.logicalKey).join("\n")}`;
}

describe("M5.5 queue rebuild", () => {
  it("counts a missing maintenance replacement as a sanitized failure", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    const capture = createCanarySink();
    await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now });
    jobs.enqueue = async () => undefined as never;
    jobs.findActiveJobByLogicalKey = async () => undefined;
    const result = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(capture.sink), now: () => now });
    expect(result.result).toBe("partial");
    expect(result.maintenance.ownershipRecovered).toBe(0);
    expect((await store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId).toBe("old-job");
    expect(capture.text()).toContain("maintenance_replacement_job_missing");
    expect(capture.text()).not.toMatch(canary);
  });

  it("dry-run inspects durable truth without queue or source mutation", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    const capture = createCanarySink();
    await seedBase(store);
    await seedGeneration(store);
    await seedAudit(store);
    await seedRepairs(store);
    await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now });
    const result = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(capture.sink), now: () => now, dryRun: true });
    expect(result.result).toBe("dry_run");
    expect(formatQueueRebuildCounts(result)).toContain("reconciliation_resume: 1");
    expect(formatQueueRebuildCounts(result)).toContain("delivery_audit_resume: 1");
    expect(formatQueueRebuildCounts(result)).toContain("delivery_repairs_resume: 4");
    expect(formatQueueRebuildCounts(result)).toContain("maintenance_window_recoveries: 1");
    expect(formatQueueRebuildCounts(result)).toContain("schedules_register: 3");
    expect(jobs.jobs.size).toBe(0);
    expect(await jobs.getSchedules()).toEqual([]);
    expect((await store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId).toBe("old-job");
    expect((await store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId))?.generation).toBe(4);
    expect(captureText(jobs, capture.text(), result)).not.toMatch(canary);
  });

  it("resumes the same unfinished generation, audit, recoverable repairs, and incomplete window", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    const capture = createCanarySink();
    await seedBase(store);
    await seedGeneration(store);
    await seedAudit(store);
    await seedRepairs(store);
    await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now });
    await store.recordMaintenanceWindowError({ task: "delivery_audit", bucket: "20260829T12", jobId: "old-job", errorCode: "tick_failed", now });
    const result = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(capture.sink), now: () => now });
    expect(result).toMatchObject({
      result: "completed",
      reconciliation: { discovered: 1, enqueued: 1, paused: 0, blocked: 0, completedSkipped: 0 },
      deliveryAudit: { enqueued: 1, paused: 0, completedSkipped: 0 },
      deliveryRepairs: { recoverableFound: 4, enqueued: 4, skipped: 0 },
      maintenance: { incompleteFound: 1, ownershipRecovered: 1 },
      schedules: { registered: 3 },
    });
    expect((await store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId))).toMatchObject({ reconciliationRunId: runIds[3], generation: 4 });
    expect([...jobs.jobs.values()].some((job) => job.logicalKey === repositoryReconciliationLogicalKey(repositoryId, runIds[3]))).toBe(true);
    expect([...jobs.jobs.values()].some((job) => job.logicalKey === deliveryAuditLogicalKey(githubAppId, auditRunId, 4))).toBe(true);
    const window = await store.getMaintenanceWindow("delivery_audit", "20260829T12");
    expect(window?.acceptedJobId).not.toBe("old-job");
    expect(window?.completedAt).toBeUndefined();
    expect(window?.lastErrorCode).toBe("tick_failed");
    expect(window?.bucket).toBe("20260829T12");
    for (const status of GITHUB_DELIVERY_REPAIR_STATUSES) {
      const repair = await store.getGithubDeliveryRepair(guids[status]);
      expect(repair?.attemptCount).toBe(2);
      expect(repair?.nextEligibleAt).toEqual(future);
      expect(repair?.status).toBe(status);
    }
    const recoveredId = window?.acceptedJobId ?? "";
    const tick = jobs.jobs.get(recoveredId);
    expect(tick?.payload).toMatchObject({ maintenanceTask: "delivery_audit", maintenanceBucket: "20260829T12" });
    expect(captureText(jobs, capture.text(), result)).not.toMatch(canary);
  });

  it("preserves future pauses, blocks access pauses, and skips completed work", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await seedBase(store);
    await seedGeneration(store, { pausedUntil: future });
    await seedAudit(store, { paused: true });
    const result = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    expect(result.reconciliation.paused).toBe(1);
    expect(result.deliveryAudit.paused).toBe(1);
    const reconcileJob = [...jobs.jobs.values()].find((job) => job.kind === "repository_reconciliation");
    const auditJob = [...jobs.jobs.values()].find((job) => job.kind === "github_delivery_audit");
    expect(jobs.startAfter.get(reconcileJob?.id ?? "")).toEqual(future);
    expect(jobs.startAfter.get(auditJob?.id ?? "")).toEqual(future);
    expect(auditJob?.logicalKey).toBe(deliveryAuditWakeLogicalKey(githubAppId, auditRunId, future));

    const blocked = new InMemoryM1Store();
    const blockedJobs = new InMemoryJobPort();
    await seedBase(blocked);
    await seedGeneration(blocked, { blocked: true });
    const blockedResult = await rebuildQueue({ store: blocked, jobs: blockedJobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    expect(blockedResult.reconciliation.blocked).toBe(1);
    expect(blockedResult.reconciliation.enqueued).toBe(0);
    expect(blockedJobs.jobs.size).toBe(0);

    const completed = new InMemoryM1Store();
    const completedJobs = new InMemoryJobPort();
    await seedBase(completed);
    await seedGeneration(completed, { completed: true });
    await seedAudit(completed, { completed: true });
    await completed.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "done-job", now });
    await completed.completeMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobId: "done-job", now });
    const completedResult = await rebuildQueue({ store: completed, jobs: completedJobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    expect(completedResult.reconciliation.completedSkipped).toBe(1);
    expect(completedResult.deliveryAudit.completedSkipped).toBe(1);
    expect(completedResult.maintenance.incompleteFound).toBe(0);
    expect((await completed.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId).toBe("done-job");
  });

  it("is idempotent across repeated rebuilds and recovers the same maintenance owner", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await seedBase(store);
    await seedGeneration(store);
    await seedAudit(store);
    await seedRepairs(store);
    await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now });
    const first = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    const owner = (await store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId;
    const jobCount = jobs.jobs.size;
    const second = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    expect(first.reconciliation.enqueued).toBe(1);
    expect(second.reconciliation.enqueued).toBe(1);
    expect((await store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId))?.generation).toBe(4);
    expect((await store.getGithubDeliveryAudit(githubAppId))?.generation).toBe(6);
    expect((await store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId).toBe(owner);
    expect(jobs.jobs.size).toBe(jobCount);
    expect([...jobs.jobs.values()].filter((job) => job.kind === "repository_reconciliation" && !job.logicalKey.includes(":wake:")).length).toBe(1);
    expect([...jobs.jobs.values()].filter((job) => job.logicalKey === maintenanceTickLogicalKey("maintenance_audit", "20260829T12")).length).toBe(1);
  });

  it("lets a recovered maintenance tick complete the original bucket", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await seedBase(store);
    await store.claimMaintenanceWindow({ task: "active_reconciliation", bucket: "20260829T12", jobKind: "maintenance_active", jobId: "old-job", now });
    const result = await rebuildQueue({ store, jobs, githubAppId, logger: createLogger(createCanarySink().sink), now: () => now });
    expect(result.maintenance.ownershipRecovered).toBe(1);
    const window = await store.getMaintenanceWindow("active_reconciliation", "20260829T12");
    const job = jobs.jobs.get(window?.acceptedJobId ?? "");
    expect(job?.payload).toMatchObject({ maintenanceBucket: "20260829T12", maintenanceTask: "active_reconciliation" });
    await processMaintenanceTick(job?.payload as { maintenanceTask: "active_reconciliation"; maintenanceBucket: string; kind: "maintenance_active" }, {
      store,
      jobs,
      logger: createLogger(createCanarySink().sink),
      config: { GITHUB_APP_ID: githubAppId },
      now: () => now,
    }, window?.acceptedJobId ?? "");
    expect((await store.getMaintenanceWindow("active_reconciliation", "20260829T12"))?.completedAt).toEqual(now);
  });
});
