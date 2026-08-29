import { describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { InMemoryM1Store } from "@devmemoir/db";
import { maintenanceReconciliationRunId, maintenanceWindowBucket } from "@devmemoir/domain";
import type { GithubAppClient, GithubClient } from "@devmemoir/github";
import { InMemoryJobPort, MAINTENANCE_SCHEDULES, type SyncJobPayload } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { processQueueJob, type QueueDependencies } from "./jobs.js";
import { enqueueCurrentMaintenanceTicks, processMaintenanceTick, registerMaintenanceSchedules } from "./maintenance.js";

const githubAppId = 42;
const now = () => new Date("2026-08-29T12:00:00Z");
const stale = new Date("2026-08-01T00:00:00Z");
const recent = new Date("2026-08-28T00:00:00Z");
const PRIVATE_REPO_CANARY = "PRIVATE_REPO_CANARY";
const PRIVATE_COMMIT_CANARY = "PRIVATE_COMMIT_CANARY";
const PRIVATE_PR_TITLE_CANARY = "PRIVATE_PR_TITLE_CANARY";

const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: githubAppId, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

const forbiddenGithub: GithubClient = new Proxy({} as GithubClient, {
  get: () => () => {
    throw new Error(`scheduler_must_not_call_github:${PRIVATE_COMMIT_CANARY}`);
  },
});

const githubApp: GithubAppClient = {
  listAppWebhookDeliveries: async () => {
    throw new Error(`scheduler_must_not_call_github:${PRIVATE_COMMIT_CANARY}`);
  },
  redeliverAppWebhookDelivery: async () => {
    throw new Error(`scheduler_must_not_call_github:${PRIVATE_COMMIT_CANARY}`);
  },
};

type Seed = {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  installationGithubId: number;
  githubRepositoryId: number;
};

const repoA: Seed = { tenantId: "tenant-a", repositoryId: "00000000-0000-4000-8000-00000000000a", installationId: "installation-a", installationGithubId: 1101, githubRepositoryId: 5101 };
const repoB: Seed = { tenantId: "tenant-b", repositoryId: "00000000-0000-4000-8000-00000000000b", installationId: "installation-b", installationGithubId: 1102, githubRepositoryId: 5102 };
const repoC: Seed = { tenantId: "tenant-c", repositoryId: "00000000-0000-4000-8000-00000000000c", installationId: "installation-c", installationGithubId: 1103, githubRepositoryId: 5103 };
const repoD: Seed = { tenantId: "tenant-d", repositoryId: "00000000-0000-4000-8000-00000000000d", installationId: "installation-d", installationGithubId: 1104, githubRepositoryId: 5104 };

async function seedRepository(store: InMemoryM1Store, seed: Seed, extra: { githubPushedAt?: Date; lastSeenAt?: Date; lastAuthoritativeObservedAt?: Date; inaccessible?: boolean } = {}): Promise<void> {
  await store.upsertUser({ userId: `user-${seed.tenantId}`, tenantId: seed.tenantId, githubAccountId: seed.installationGithubId, login: PRIVATE_REPO_CANARY, displayName: PRIVATE_PR_TITLE_CANARY });
  await store.saveInstallation({ id: seed.installationId, tenantId: seed.tenantId, githubInstallationId: seed.installationGithubId, accountGithubAccountId: seed.installationGithubId });
  const saved = await store.saveRepository({
    id: seed.repositoryId,
    tenantId: seed.tenantId,
    installationId: seed.installationId,
    githubRepositoryId: seed.githubRepositoryId,
    ownerLogin: PRIVATE_REPO_CANARY,
    name: PRIVATE_REPO_CANARY,
    fullName: `${PRIVATE_REPO_CANARY}/${PRIVATE_REPO_CANARY}`,
    private: true,
    defaultBranch: "main",
    ...(extra.githubPushedAt ? { githubPushedAt: extra.githubPushedAt } : {}),
    ...(extra.lastSeenAt ? { lastSeenAt: extra.lastSeenAt } : {}),
    ...(extra.lastAuthoritativeObservedAt ? { lastAuthoritativeObservedAt: extra.lastAuthoritativeObservedAt } : {}),
  });
  if (extra.inaccessible) {
    store.repositories.set(`${seed.tenantId}:${seed.githubRepositoryId}`, { ...saved, selected: false, accessStatus: "access_removed" });
  }
}

async function setup() {
  const store = new InMemoryM1Store();
  const jobs = new InMemoryJobPort();
  const capture = createCanarySink();
  await seedRepository(store, repoA, { githubPushedAt: recent });
  await seedRepository(store, repoB);
  await seedRepository(store, repoC, { inaccessible: true, githubPushedAt: recent });
  await seedRepository(store, repoD, { githubPushedAt: stale, lastSeenAt: stale, lastAuthoritativeObservedAt: stale });
  const deps: QueueDependencies = {
    store,
    jobs,
    githubForInstallation: () => forbiddenGithub,
    githubApp,
    logger: createLogger(capture.sink),
    config,
    now,
  };
  return { store, jobs, capture, deps };
}

function operationalText(scope: { jobs: InMemoryJobPort; capture: ReturnType<typeof createCanarySink> }): string {
  return `${JSON.stringify([...scope.jobs.jobs.values()])}\n${JSON.stringify([...scope.jobs.schedules.values()])}\n${JSON.stringify([...scope.jobs.schedulePayloads.values()])}\n${scope.capture.text()}`;
}

function reconciliationJobs(jobs: InMemoryJobPort): SyncJobPayload[] {
  return [...jobs.jobs.values()].filter((job) => job.kind === "repository_reconciliation").map((job) => job.payload as SyncJobPayload);
}

function repositoryIds(payloads: SyncJobPayload[]): string[] {
  return payloads.map((payload) => payload.repositoryId).filter((id): id is string => Boolean(id)).sort();
}

const activePayload: SyncJobPayload = { kind: "maintenance_active", maintenanceTask: "active_reconciliation" };
const dailyPayload: SyncJobPayload = { kind: "maintenance_authorized", maintenanceTask: "authorized_reconciliation" };
const auditPayload: SyncJobPayload = { kind: "maintenance_audit", maintenanceTask: "delivery_audit" };

describe("M5.3 periodic maintenance scheduler", () => {
  it("registers three singleton schedules idempotently", async () => {
    const jobs = new InMemoryJobPort();
    await registerMaintenanceSchedules(jobs);
    await registerMaintenanceSchedules(jobs);
    await registerMaintenanceSchedules(jobs);
    expect(await jobs.getSchedules()).toEqual(MAINTENANCE_SCHEDULES.map((schedule) => ({ name: schedule.kind, cron: schedule.cron })));
  });

  it("enqueues M5.1 work for active repositories A/B and skips inaccessible C without mutating source", async () => {
    const scope = await setup();
    const eventsBefore = scope.store.events.length;
    await processMaintenanceTick(activePayload, scope.deps, "job-active-1");
    const payloads = reconciliationJobs(scope.jobs);
    expect(repositoryIds(payloads)).toEqual([repoA.repositoryId, repoB.repositoryId].sort());
    expect(payloads.some((payload) => payload.repositoryId === repoC.repositoryId)).toBe(false);
    expect(payloads.every((payload) => payload.kind === "repository_reconciliation")).toBe(true);
    expect(scope.store.events).toHaveLength(eventsBefore);
    expect(scope.capture.text()).toContain("\"maintenance_task\":\"active_reconciliation\"");
  });

  it("uses the daily pass for all authorized repositories including stale ones", async () => {
    const scope = await setup();
    await processMaintenanceTick(activePayload, scope.deps, "job-active-1");
    const activeIds = repositoryIds(reconciliationJobs(scope.jobs));
    expect(activeIds).toEqual([repoA.repositoryId, repoB.repositoryId].sort());
    expect(activeIds).not.toContain(repoD.repositoryId);

    await processMaintenanceTick(dailyPayload, scope.deps, "job-daily-1");
    const dailyIds = [...new Set(repositoryIds(reconciliationJobs(scope.jobs)))].sort();
    expect(dailyIds).toEqual([repoA.repositoryId, repoB.repositoryId, repoD.repositoryId].sort());
    expect(dailyIds).not.toContain(repoC.repositoryId);
    expect(reconciliationJobs(scope.jobs).some((payload) => payload.repositoryId === repoD.repositoryId && payload.reconciliationRunId === maintenanceReconciliationRunId("authorized_reconciliation", repoD.repositoryId, now()))).toBe(true);
  });

  it("reuses M5.1 current generations on the accepted window and no-ops a second producer", async () => {
    const scope = await setup();
    const existingRunId = "00000000-0000-4000-8000-0000000000ff";
    await scope.store.startRepositoryReconciliation({
      tenantId: repoA.tenantId,
      repositoryId: repoA.repositoryId,
      installationId: repoA.installationId,
      defaultBranch: "main",
      reconciliationRunId: existingRunId,
      now: now(),
    });
    await processMaintenanceTick(activePayload, scope.deps, "job-active-1");
    expect(reconciliationJobs(scope.jobs).find((row) => row.repositoryId === repoA.repositoryId)?.reconciliationRunId).toBe(existingRunId);
    await processMaintenanceTick(activePayload, scope.deps, "job-active-2");
    expect(reconciliationJobs(scope.jobs).filter((row) => row.repositoryId === repoA.repositoryId)).toHaveLength(1);
    expect(await scope.store.getMaintenanceWindow("active_reconciliation", maintenanceWindowBucket("active_reconciliation", now()))).toMatchObject({ acceptedJobId: "job-active-1" });
  });

  it("claims a delivery-audit window once; a later tick does not bypass pause or start a new generation", async () => {
    const scope = await setup();
    const auditRunId = "00000000-0000-4000-8000-0000000000aa";
    await scope.store.startGithubDeliveryAudit({ githubAppId, auditRunId, now: now() });
    await processQueueJob({ id: "tick-1", kind: "maintenance_audit", logicalKey: "maintenance_audit", payload: auditPayload }, scope.deps);
    const inProgress = await scope.store.getGithubDeliveryAudit(githubAppId);
    expect(inProgress).toMatchObject({ currentRunId: auditRunId, status: "in_progress", generation: 1 });

    const pausedUntil = new Date("2026-08-29T12:15:00Z");
    await scope.store.pauseGithubDeliveryAudit({ githubAppId, auditRunId, pausedUntil, errorCode: "github_primary_rate_limit" });
    await processMaintenanceTick(auditPayload, scope.deps, "tick-2");
    const paused = await scope.store.getGithubDeliveryAudit(githubAppId);
    expect(paused).toMatchObject({ currentRunId: auditRunId, status: "paused", generation: 1 });
    expect(paused?.pausedUntil).toEqual(pausedUntil);
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(1);
  });

  it("does not replay missed intervals as a catch-up storm", async () => {
    const jobs = new InMemoryJobPort();
    await enqueueCurrentMaintenanceTicks(jobs, now());
    await enqueueCurrentMaintenanceTicks(jobs, now());
    await enqueueCurrentMaintenanceTicks(jobs, now());
    expect([...jobs.jobs.values()].map((job) => job.kind).sort()).toEqual(["maintenance_active", "maintenance_audit", "maintenance_authorized"]);
  });

  it("accepts one sequential redeploy per task in the same bucket", async () => {
    const scope = await setup();
    await processMaintenanceTick(activePayload, scope.deps, "worker-a");
    await processMaintenanceTick(dailyPayload, scope.deps, "worker-a");
    await processMaintenanceTick(auditPayload, scope.deps, "worker-a");
    const reconcileAfterFirst = reconciliationJobs(scope.jobs).length;
    const auditAfterFirst = [...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit").length;
    await processMaintenanceTick(activePayload, scope.deps, "worker-b");
    await processMaintenanceTick(dailyPayload, scope.deps, "worker-b");
    await processMaintenanceTick(auditPayload, scope.deps, "worker-b");
    expect(reconciliationJobs(scope.jobs)).toHaveLength(reconcileAfterFirst);
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(auditAfterFirst);
  });

  it("treats 12:05 boot and 12:30 cron as the same audit bucket", async () => {
    const scope = await setup();
    const boot = { ...scope.deps, now: () => new Date("2026-08-29T12:05:00Z") };
    const cron = { ...scope.deps, now: () => new Date("2026-08-29T12:30:00Z") };
    await processMaintenanceTick(auditPayload, boot, "boot-1205");
    await processMaintenanceTick(auditPayload, cron, "cron-1230");
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(1);
    expect(await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12")).toMatchObject({ acceptedJobId: "boot-1205" });
  });

  it("allows the reverse order of cron then redeploy in the same audit bucket", async () => {
    const scope = await setup();
    const cron = { ...scope.deps, now: () => new Date("2026-08-29T12:30:00Z") };
    const deploy = { ...scope.deps, now: () => new Date("2026-08-29T12:45:00Z") };
    await processMaintenanceTick(auditPayload, cron, "cron-1230");
    await processMaintenanceTick(auditPayload, deploy, "boot-1245");
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(1);
    expect((await scope.store.getGithubDeliveryAudit(githubAppId))?.generation).toBe(1);
  });

  it("allows the next 6h and next daily buckets independently", async () => {
    const scope = await setup();
    await processMaintenanceTick(activePayload, { ...scope.deps, now: () => new Date("2026-08-29T12:00:00Z") }, "active-12");
    await processMaintenanceTick(activePayload, { ...scope.deps, now: () => new Date("2026-08-29T18:00:00Z") }, "active-18");
    expect(await scope.store.getMaintenanceWindow("active_reconciliation", "20260829T12")).toMatchObject({ acceptedJobId: "active-12" });
    expect(await scope.store.getMaintenanceWindow("active_reconciliation", "20260829T18")).toMatchObject({ acceptedJobId: "active-18" });
    await processMaintenanceTick(dailyPayload, { ...scope.deps, now: () => new Date("2026-08-29T00:00:00Z") }, "day-29");
    await processMaintenanceTick(dailyPayload, { ...scope.deps, now: () => new Date("2026-08-30T00:00:00Z") }, "day-30");
    expect(await scope.store.getMaintenanceWindow("authorized_reconciliation", "2026-08-29")).toMatchObject({ acceptedJobId: "day-29" });
    expect(await scope.store.getMaintenanceWindow("authorized_reconciliation", "2026-08-30")).toMatchObject({ acceptedJobId: "day-30" });
  });

  it("retries the accepted job after failure and does not let a second producer claim", async () => {
    const scope = await setup();
    const failing = { store: scope.store, jobs: scope.jobs, githubForInstallation: scope.deps.githubForInstallation, logger: scope.deps.logger, config: scope.deps.config, now };
    await expect(processMaintenanceTick(auditPayload, failing, "job-1")).rejects.toThrow("App-JWT GitHub client is required for delivery audit");
    expect(await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12")).toMatchObject({ acceptedJobId: "job-1", lastErrorCode: "tick_failed" });
    expect((await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.completedAt).toBeUndefined();
    await processMaintenanceTick(auditPayload, scope.deps, "job-1");
    expect((await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.completedAt).toEqual(now());
    const generation = (await scope.store.getGithubDeliveryAudit(githubAppId))?.generation;
    await processMaintenanceTick(auditPayload, scope.deps, "job-1");
    await processMaintenanceTick(auditPayload, scope.deps, "job-2");
    expect((await scope.store.getGithubDeliveryAudit(githubAppId))?.generation).toBe(generation);
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(1);
  });

  it("does not start a second M5.2 generation when the same completed maintenance job is redelivered", async () => {
    const scope = await setup();
    await processMaintenanceTick(auditPayload, scope.deps, "audit-job-1");
    const first = await scope.store.getGithubDeliveryAudit(githubAppId);
    expect(first?.generation).toBe(1);
    await scope.store.commitGithubDeliveryAuditPage({
      githubAppId,
      auditRunId: first?.currentRunId as string,
      expectedPage: 1,
      reachedStop: true,
      now: now(),
    });
    expect((await scope.store.getGithubDeliveryAudit(githubAppId))?.status).toBe("completed");
    const auditJobs = [...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit").length;
    await processMaintenanceTick(auditPayload, scope.deps, "audit-job-1");
    expect(await scope.store.getGithubDeliveryAudit(githubAppId)).toMatchObject({ generation: 1, status: "completed" });
    expect([...scope.jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit")).toHaveLength(auditJobs);
    expect(await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12")).toMatchObject({ acceptedJobId: "audit-job-1", completedAt: now() });
  });

  it("keeps private canaries out of scheduler keys, payloads, logs, windows, and schedule metadata", async () => {
    const scope = await setup();
    await registerMaintenanceSchedules(scope.jobs);
    await enqueueCurrentMaintenanceTicks(scope.jobs, now());
    await processMaintenanceTick(activePayload, scope.deps, "job-active-1");
    await processMaintenanceTick(dailyPayload, scope.deps, "job-daily-1");
    await processMaintenanceTick(auditPayload, scope.deps, "job-audit-1");
    const windows = [
      await scope.store.getMaintenanceWindow("active_reconciliation", "20260829T12"),
      await scope.store.getMaintenanceWindow("authorized_reconciliation", "2026-08-29"),
      await scope.store.getMaintenanceWindow("delivery_audit", "20260829T12"),
    ];
    const text = `${operationalText(scope)}\n${JSON.stringify(windows)}`;
    expect(text).not.toMatch(/PRIVATE_REPO_CANARY|PRIVATE_COMMIT_CANARY|PRIVATE_PR_TITLE_CANARY/);
    for (const job of scope.jobs.jobs.values()) {
      expect(job.logicalKey).not.toMatch(/PRIVATE_REPO_CANARY|PRIVATE_COMMIT_CANARY|PRIVATE_PR_TITLE_CANARY/);
      expect(JSON.stringify(job.payload)).not.toMatch(/PRIVATE_REPO_CANARY|PRIVATE_COMMIT_CANARY|PRIVATE_PR_TITLE_CANARY/);
    }
  });
});
