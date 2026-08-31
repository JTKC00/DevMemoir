import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import type { GithubAppClient, GithubClient } from "@devmemoir/github";
import { PgBossJobPort, resetPgBossOperationalSchema } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { processQueueJob, type QueueDependencies } from "./jobs.js";
import { rebuildQueue } from "./queue-rebuild.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.5 PostgreSQL / pg-boss queue-rebuild tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

const PRIVATE_REPOSITORY_NAME = "PRIVATE_REPOSITORY_NAME";
const PRIVATE_COMMIT_MESSAGE = "PRIVATE_COMMIT_MESSAGE";
const PRIVATE_PR_TITLE = "PRIVATE_PR_TITLE";
const PRIVATE_WEBHOOK_PAYLOAD = "PRIVATE_WEBHOOK_PAYLOAD";
const PRIVATE_TOKEN = "PRIVATE_TOKEN";
const canary = new RegExp(`${PRIVATE_REPOSITORY_NAME}|${PRIVATE_COMMIT_MESSAGE}|${PRIVATE_PR_TITLE}|${PRIVATE_WEBHOOK_PAYLOAD}|${PRIVATE_TOKEN}`);

type Scope = {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  installationGithubId: number;
  accountGithubId: number;
  githubRepositoryId: number;
  githubAppId: number;
  schema: string;
  bucket: string;
  admin: ReturnType<typeof createPool>;
  pool: ReturnType<typeof createPool>;
  store: PostgresM1Store;
};

const scopes: Scope[] = [];

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();
  const nonce = Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
  const accountGithubId = 940_000_000 + nonce;
  const installationGithubId = 97_000 + (nonce % 10_000);
  const githubRepositoryId = accountGithubId + 1;
  const githubAppId = 970_000 + (nonce % 10_000);
  const schema = `pgboss_m55_${tenantId.replaceAll("-", "").slice(0, 12)}`;
  const bucket = `2033${String(1 + (nonce % 12)).padStart(2, "0")}${String(1 + ((nonce >> 4) % 28)).padStart(2, "0")}T06`;
  const admin = createPool(databaseUrl as string, 2);
  const pool = createPool(databaseUrl as string, 3);
  const store = new PostgresM1Store(pool);
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: accountGithubId });
  await store.saveRepository({
    id: repositoryId,
    tenantId,
    installationId,
    githubRepositoryId,
    ownerLogin: PRIVATE_REPOSITORY_NAME,
    name: PRIVATE_REPOSITORY_NAME,
    fullName: `${PRIVATE_REPOSITORY_NAME}/repo`,
    private: true,
    defaultBranch: "main",
  });
  const scope: Scope = { tenantId, repositoryId, installationId, installationGithubId, accountGithubId, githubRepositoryId, githubAppId, schema, bucket, admin, pool, store };
  scopes.push(scope);
  return scope;
}

async function cleanup(scope: Scope): Promise<void> {
  await resetPgBossOperationalSchema((text) => scope.admin.query(text), scope.schema).catch(() => undefined);
  await scope.admin.query("delete from maintenance_windows where bucket=$1", [scope.bucket]).catch(() => undefined);
  await scope.admin.query("delete from github_delivery_repairs where github_app_id=$1", [scope.githubAppId]).catch(() => undefined);
  await scope.admin.query("delete from github_delivery_audits where github_app_id=$1", [scope.githubAppId]).catch(() => undefined);
  await scope.admin.query("delete from development_events where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from issues where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from pull_requests where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from sync_cursors where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from reconciliation_generations where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from sync_jobs where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from repository_access where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from repositories where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from github_installations where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  await scope.admin.query("delete from installation_routes where tenant_id=$1", [scope.tenantId]).catch(() => undefined);
  const users = await scope.admin.query<{ id: string; account_id: string }>("select u.id,ga.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts ga on ga.id=i.github_account_id where u.primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
  await scope.admin.query("delete from tenant_members where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from users where primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
  await scope.admin.query("delete from tenants where id=$1", [scope.tenantId]);
  await scope.pool.end();
  await scope.admin.end();
}

afterEach(async () => {
  while (scopes.length > 0) {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  }
});

function configFor(githubAppId: number): AppConfig {
  return {
    NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
    GITHUB_APP_ID: githubAppId, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
    ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for queue rebuild resume");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function seedUnfinished(scope: Scope, extra: { pausedUntil?: Date } = {}): Promise<{ runId: string; auditRunId: string; guid: string; attemptCount: number }> {
  const now = new Date("2026-08-29T12:00:00Z");
  const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const reconciliationRunId of runIds) {
    await scope.store.startRepositoryReconciliation({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationId, defaultBranch: "main", reconciliationRunId, now });
  }
  await scope.admin.query(
    "update sync_cursors set status='completed', completed_at=$3 where tenant_id=$1 and repository_id=$2 and resource_type in ('default_branch_commits','branches','tags','pull_requests')",
    [scope.tenantId, scope.repositoryId, now],
  );
  if (extra.pausedUntil) {
    await scope.admin.query(
      "update sync_cursors set status='paused', paused_until=$3, cursor = cursor || jsonb_build_object('nextPage', 3, 'mode', 'structural') where tenant_id=$1 and repository_id=$2 and resource_type='issues'",
      [scope.tenantId, scope.repositoryId, extra.pausedUntil],
    );
  } else {
    await scope.admin.query(
      "update sync_cursors set status='in_progress', cursor = cursor || jsonb_build_object('nextPage', 3, 'mode', 'structural') where tenant_id=$1 and repository_id=$2 and resource_type='issues'",
      [scope.tenantId, scope.repositoryId],
    );
  }
  const auditRunId = randomUUID();
  await scope.store.startGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId, now });
  await scope.admin.query("update github_delivery_audits set generation=6, page_number=4, list_cursor=$2 where github_app_id=$1", [scope.githubAppId, "cursor-x"]);
  if (extra.pausedUntil) {
    await scope.store.pauseGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId, pausedUntil: extra.pausedUntil, errorCode: "github_retry_after" });
  }
  const guid = randomUUID();
  await scope.store.observeGithubDeliveryAttempt({
    githubDeliveryGuid: guid,
    githubDeliveryId: scope.githubAppId + 9,
    githubAppId: scope.githubAppId,
    auditRunId,
    eventName: "push",
    statusCode: 500,
    deliveredAt: now,
    now,
  });
  const claimed = await scope.store.claimGithubDeliveryRedelivery({ guid, githubDeliveryId: scope.githubAppId + 9, now, maxAttempts: 8 });
  expect(claimed.allowed).toBe(true);
  const accepted = await scope.store.acceptGithubDeliveryRedelivery({ guid, now });
  await scope.store.claimMaintenanceWindow({ task: "active_reconciliation", bucket: scope.bucket, jobKind: "maintenance_active", jobId: "old-job", now });
  expect(await scope.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "issues")).toMatchObject({
    status: extra.pausedUntil ? "paused" : "in_progress",
    nextPage: 3,
  });
  return { runId: runIds[3] ?? "", auditRunId, guid, attemptCount: accepted?.attemptCount ?? 0 };
}

function github(scope: Scope, counters: { issues: number[]; auditCursors: Array<string | undefined>; redeliveries: number }): { client: GithubClient; app: GithubAppClient } {
  const sourceTime = new Date("2026-08-28T01:00:00Z");
  const client: GithubClient = {
    getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: PRIVATE_TOKEN }),
    getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
    listInstallationRepositories: async () => ({ repositories: [{ id: scope.githubRepositoryId, name: PRIVATE_REPOSITORY_NAME, full_name: `${PRIVATE_REPOSITORY_NAME}/repo`, private: true, default_branch: "main", owner: { id: scope.accountGithubId, login: PRIVATE_REPOSITORY_NAME, type: "User" } }] }),
    getRepository: async () => ({ id: scope.githubRepositoryId, name: PRIVATE_REPOSITORY_NAME, full_name: `${PRIVATE_REPOSITORY_NAME}/repo`, private: true, default_branch: "main" }),
    listCommits: async () => ({ commits: [{ repositoryId: scope.repositoryId, sha: "head", message: PRIVATE_COMMIT_MESSAGE, committedAt: sourceTime, parents: [] }] }),
    getCommit: async () => ({ repositoryId: scope.repositoryId, sha: "head", message: PRIVATE_COMMIT_MESSAGE, committedAt: sourceTime, parents: [] }),
    getRefHead: async () => "head",
    listBranches: async () => ({ branches: [{ name: "main", headSha: "head", protected: true }] }),
    listTags: async () => ({ tags: [] }),
    listPullRequests: async () => ({ pullRequests: [{ id: 41, number: 41, title: PRIVATE_PR_TITLE, state: "closed", author: { githubAccountId: scope.accountGithubId, actorKind: "user" }, baseRef: "main", baseSha: "base", headRef: "topic", headSha: "head", createdAt: sourceTime, updatedAt: sourceTime }] }),
    listIssues: async (input) => {
      counters.issues.push(input.page ?? 1);
      return { issues: [] };
    },
    listReleases: async () => ({ releases: [] }),
  };
  const app: GithubAppClient = {
    listAppWebhookDeliveries: async (input) => {
      counters.auditCursors.push(input?.cursor);
      return { deliveries: [] };
    },
    redeliverAppWebhookDelivery: async () => {
      counters.redeliveries += 1;
    },
  };
  return { client, app };
}

describeIntegration("M5.5 pg-boss wipe, rebuild, and resume", () => {
  it("recovers an enqueued maintenance singleton after CAS failure and a fresh-process rerun", async () => {
    const scope = await createScope();
    const at = new Date("2026-08-29T12:00:00Z");
    await scope.store.claimMaintenanceWindow({ task: "active_reconciliation", bucket: scope.bucket, jobKind: "maintenance_active", jobId: "old-job", now: at });
    await resetPgBossOperationalSchema((text) => scope.admin.query(text), scope.schema);
    const capture = createCanarySink();
    const firstPort = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    await firstPort.start();
    let failCas = true;
    const failAfterEnqueueStore = new Proxy(scope.store, {
      get(target, property) {
        if (property === "recoverIncompleteMaintenanceWindow") {
          return async (input: Parameters<PostgresM1Store["recoverIncompleteMaintenanceWindow"]>[0]) => {
            if (failCas) {
              failCas = false;
              throw new Error("intentional_post_enqueue_cas_failure");
            }
            return target.recoverIncompleteMaintenanceWindow(input);
          };
        }
        const value = target[property as keyof PostgresM1Store];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const logicalKey = `maintenance:maintenance_active:${scope.bucket}`;
    const first = await rebuildQueue({ store: failAfterEnqueueStore, jobs: firstPort, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => at });
    expect(first.result).toBe("partial");
    const replacementJobId = await firstPort.findActiveJobByLogicalKey("maintenance_active", logicalKey);
    expect(replacementJobId).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.acceptedJobId).toBe("old-job");
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.completedAt).toBeUndefined();
    await firstPort.stop();

    const freshPort = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    await freshPort.start();
    expect(await freshPort.findActiveJobByLogicalKey("maintenance_active", logicalKey)).toBe(replacementJobId);
    const second = await rebuildQueue({ store: scope.store, jobs: freshPort, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => at });
    expect(second.maintenance.ownershipRecovered).toBe(1);
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.acceptedJobId).toBe(replacementJobId);
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.completedAt).toBeUndefined();

    await rebuildQueue({ store: scope.store, jobs: freshPort, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => at });
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.acceptedJobId).toBe(replacementJobId);
    const queued = await scope.admin.query<{ id: string }>(
      `select id::text as id from ${scope.schema}.job where name=$1 and singleton_key=$2`,
      ["maintenance_active", logicalKey],
    );
    expect(queued.rows.map((row) => row.id)).toEqual([replacementJobId]);

    const clients = github(scope, { issues: [], auditCursors: [], redeliveries: 0 });
    const deps: QueueDependencies = {
      store: scope.store,
      jobs: freshPort,
      githubForInstallation: () => clients.client,
      githubApp: clients.app,
      logger: createLogger(capture.sink),
      config: configFor(scope.githubAppId),
      now: () => at,
    };
    await freshPort.work("maintenance_active", async (job) => processQueueJob(job, deps));
    await waitFor(async () => Boolean((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.completedAt));
    expect(await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket)).toMatchObject({ acceptedJobId: replacementJobId, completedAt: at });
    expect(await freshPort.findActiveJobByLogicalKey("maintenance_active", logicalKey)).toBeUndefined();
    const terminal = await rebuildQueue({ store: scope.store, jobs: freshPort, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => at });
    expect(terminal.maintenance.incompleteFound).toBe(0);
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.acceptedJobId).toBe(replacementJobId);
    expect(capture.text()).not.toMatch(canary);
    await freshPort.stop();
  }, 60_000);

  it("rebuilds unfinished durable work onto a fresh queue and resumes the same identities", async () => {
    const scope = await createScope();
    const seeded = await seedUnfinished(scope);
    const counters = { issues: [] as number[], auditCursors: [] as Array<string | undefined>, redeliveries: 0 };
    const clients = github(scope, counters);
    const capture = createCanarySink();
    const oldQueue = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    await oldQueue.start();
    const lostJob = await oldQueue.enqueue("webhook_delivery", `lost:${scope.tenantId}`, { kind: "webhook_delivery" });
    expect(lostJob).toBeTruthy();
    await oldQueue.stop();

    await resetPgBossOperationalSchema((text) => scope.admin.query(text), scope.schema);
    const rebuilt = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    await rebuilt.start();
    expect(lostJob ? await rebuilt.has(lostJob, "webhook_delivery") : true).toBe(false);

    const result = await rebuildQueue({
      store: scope.store,
      jobs: rebuilt,
      githubAppId: scope.githubAppId,
      logger: createLogger(capture.sink),
      now: () => new Date("2026-08-29T12:00:00Z"),
    });
    expect(counters.issues).toEqual([]);
    expect(counters.auditCursors).toEqual([]);
    expect(result.reconciliation.enqueued).toBe(1);
    expect(result.deliveryAudit.enqueued).toBe(1);
    expect(result.deliveryRepairs.enqueued).toBe(1);
    expect(result.maintenance.ownershipRecovered).toBe(1);
    expect(result.schedules.registered).toBe(4);
    expect((await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId))).toMatchObject({ reconciliationRunId: seeded.runId, generation: 4 });
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))).toMatchObject({ currentRunId: seeded.auditRunId, generation: 6, pageNumber: 4, listCursor: "cursor-x" });
    expect((await scope.store.getGithubDeliveryRepair(seeded.guid))?.attemptCount).toBe(seeded.attemptCount);
    const eventsBefore = await scope.store.listActivity(scope.tenantId, scope.repositoryId);
    expect(`${capture.text()}${JSON.stringify(result)}`).not.toMatch(canary);

    const deps: QueueDependencies = {
      store: scope.store,
      jobs: rebuilt,
      githubForInstallation: () => clients.client,
      githubApp: clients.app,
      logger: createLogger(capture.sink),
      config: configFor(scope.githubAppId),
      now: () => new Date("2026-08-29T12:00:00Z"),
    };
    await rebuilt.work("repository_reconciliation", async (job) => processQueueJob(job, deps));
    await rebuilt.work("github_delivery_audit", async (job) => processQueueJob(job, deps));
    await rebuilt.work("maintenance_active", async (job) => processQueueJob(job, deps));
    await waitFor(async () => {
      const audit = await scope.store.getGithubDeliveryAudit(scope.githubAppId);
      const window = await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket);
      return counters.issues.includes(3) && audit?.status === "completed" && Boolean(window?.completedAt);
    });
    expect(counters.issues).toContain(3);
    expect(counters.auditCursors).toContain("cursor-x");
    expect((await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId))?.reconciliationRunId).toBe(seeded.runId);
    expect((await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId))?.generation).toBe(4);
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))).toMatchObject({ currentRunId: seeded.auditRunId, generation: 6, status: "completed" });
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.completedAt).toBeTruthy();
    expect((await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket))?.acceptedJobId).not.toBe("old-job");
    const eventsAfter = await scope.store.listActivity(scope.tenantId, scope.repositoryId);
    expect(eventsAfter.map((event) => event.logicalEventKey)).toEqual(eventsBefore.map((event) => event.logicalEventKey));
    expect(capture.text()).not.toMatch(canary);
    await rebuilt.stop();
  }, 60_000);

  it("preserves a future pause without calling GitHub and lets only one concurrent rebuild take maintenance ownership", async () => {
    const scope = await createScope();
    const resumeAt = new Date("2099-01-01T00:00:00Z");
    await seedUnfinished(scope, { pausedUntil: resumeAt });
    const counters = { issues: [] as number[], auditCursors: [] as Array<string | undefined>, redeliveries: 0 };
    const clients = github(scope, counters);
    await resetPgBossOperationalSchema((text) => scope.admin.query(text), scope.schema);
    const portA = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    const portB = new PgBossJobPort(databaseUrl as string, { schema: scope.schema });
    await portA.start();
    await portB.start();
    const capture = createCanarySink();
    const [first, second] = await Promise.all([
      rebuildQueue({ store: scope.store, jobs: portA, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => new Date("2026-08-29T12:00:00Z") }),
      rebuildQueue({ store: scope.store, jobs: portB, githubAppId: scope.githubAppId, logger: createLogger(capture.sink), now: () => new Date("2026-08-29T12:00:00Z") }),
    ]);
    expect(first.maintenance.ownershipRecovered + second.maintenance.ownershipRecovered).toBe(1);
    expect(counters.issues).toEqual([]);
    expect(counters.auditCursors).toEqual([]);
    const deps: QueueDependencies = {
      store: scope.store,
      jobs: portA,
      githubForInstallation: () => clients.client,
      githubApp: clients.app,
      logger: createLogger(capture.sink),
      config: configFor(scope.githubAppId),
      now: () => new Date("2026-08-29T12:00:00Z"),
    };
    await portA.work("repository_reconciliation", async (job) => processQueueJob(job, deps));
    await portA.work("github_delivery_audit", async (job) => processQueueJob(job, deps));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(counters.issues).toEqual([]);
    expect(counters.auditCursors).toEqual([]);
    expect((await scope.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "issues"))).toMatchObject({ status: "paused", nextPage: 3 });
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))?.status).toBe("paused");
    const window = await scope.store.getMaintenanceWindow("active_reconciliation", scope.bucket);
    expect(window?.completedAt).toBeUndefined();
    expect(window?.acceptedJobId).not.toBe("old-job");
    expect(capture.text()).not.toMatch(canary);
    await portA.stop();
    await portB.stop();
  }, 60_000);
});
