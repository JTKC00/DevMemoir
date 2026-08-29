import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import type { GithubAppClient } from "@devmemoir/github";
import { InMemoryJobPort, MAINTENANCE_SCHEDULES, PgBossJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { enqueueCurrentMaintenanceTicks, processMaintenanceTick, registerMaintenanceSchedules } from "./maintenance.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.3 PostgreSQL maintenance scheduler tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

const githubApp: GithubAppClient = {
  listAppWebhookDeliveries: async () => ({ deliveries: [] }),
  redeliverAppWebhookDelivery: async () => undefined,
};

type Scope = {
  tenantA: string;
  tenantB: string;
  tenantC: string;
  repoA: string;
  repoB: string;
  repoC: string;
  installationGithubA: number;
  installationGithubB: number;
  installationGithubC: number;
  admin: ReturnType<typeof createPool>;
  pool: ReturnType<typeof createPool>;
  store: PostgresM1Store;
};

const scopes: Scope[] = [];

async function createTenant(admin: ReturnType<typeof createPool>, store: PostgresM1Store, suffix: number, extra: { inaccessible?: boolean; stale?: boolean } = {}) {
  const tenantId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();
  const accountGithubId = 930_000_000 + suffix;
  const installationGithubId = 95_000 + suffix;
  const githubRepositoryId = accountGithubId + 1;
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: `owner-${tenantId.slice(0, 8)}`, displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: accountGithubId });
  await store.saveRepository({
    id: repositoryId,
    tenantId,
    installationId,
    githubRepositoryId,
    ownerLogin: "private-owner",
    name: "private-repository",
    fullName: "private-owner/private-repository",
    private: true,
    defaultBranch: "main",
    githubPushedAt: extra.stale ? new Date("2026-08-01T00:00:00Z") : new Date("2026-08-28T00:00:00Z"),
    lastSeenAt: extra.stale ? new Date("2026-08-01T00:00:00Z") : new Date("2026-08-28T00:00:00Z"),
    lastAuthoritativeObservedAt: extra.stale ? new Date("2026-08-01T00:00:00Z") : new Date("2026-08-28T00:00:00Z"),
  });
  await admin.query(
    "update repositories set github_pushed_at=$2, last_seen_at=$2, last_authoritative_observed_at=$2 where tenant_id=$1 and id=$3",
    [tenantId, extra.stale ? new Date("2026-08-01T00:00:00Z") : new Date("2026-08-28T00:00:00Z"), repositoryId],
  );
  if (extra.inaccessible) {
    await admin.query("update repository_access set selected=false, access_status='access_removed' where tenant_id=$1 and repository_id=$2", [tenantId, repositoryId]);
  }
  return { tenantId, repositoryId, installationGithubId };
}

async function createScope(): Promise<Scope> {
  const admin = createPool(databaseUrl as string, 2);
  const pool = createPool(databaseUrl as string, 3);
  const store = new PostgresM1Store(pool);
  try {
    const nonce = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 6), 16);
    const a = await createTenant(admin, store, nonce);
    const b = await createTenant(admin, store, nonce + 1, { stale: true });
    const c = await createTenant(admin, store, nonce + 2, { inaccessible: true });
    const scope: Scope = {
      tenantA: a.tenantId,
      tenantB: b.tenantId,
      tenantC: c.tenantId,
      repoA: a.repositoryId,
      repoB: b.repositoryId,
      repoC: c.repositoryId,
      installationGithubA: a.installationGithubId,
      installationGithubB: b.installationGithubId,
      installationGithubC: c.installationGithubId,
      admin,
      pool,
      store,
    };
    scopes.push(scope);
    return scope;
  } catch (error) {
    await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }
}

async function cleanup(scope: Scope): Promise<void> {
  for (const tenantId of [scope.tenantA, scope.tenantB, scope.tenantC]) {
    await scope.admin.query("delete from sync_jobs where tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from repositories where tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
    const users = await scope.admin.query<{ id: string; account_id: string }>("select u.id,ga.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts ga on ga.id=i.github_account_id where u.primary_tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
    await scope.admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from users where primary_tenant_id=$1", [tenantId]);
    await scope.admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
    await scope.admin.query("delete from tenants where id=$1", [tenantId]);
  }
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

describeIntegration("M5.3 PostgreSQL maintenance scheduler", () => {
  it("discovers authorized vs active repositories and does not enqueue inaccessible ones", async () => {
    const scope = await createScope();
    const jobs = new InMemoryJobPort();
    const deps = {
      store: scope.store,
      jobs,
      logger: createLogger(),
      config: configFor(42),
      githubApp,
      now: () => new Date("2026-08-29T12:00:00Z"),
    };
    await processMaintenanceTick({ kind: "maintenance_active", maintenanceTask: "active_reconciliation" }, deps);
    const active = [...jobs.jobs.values()].filter((job) => job.kind === "repository_reconciliation").map((job) => (job.payload as { repositoryId?: string }).repositoryId);
    expect(active).toContain(scope.repoA);
    expect(active).not.toContain(scope.repoB);
    expect(active).not.toContain(scope.repoC);

    await processMaintenanceTick({ kind: "maintenance_authorized", maintenanceTask: "authorized_reconciliation" }, deps);
    const daily = [...jobs.jobs.values()].filter((job) => job.kind === "repository_reconciliation").map((job) => (job.payload as { repositoryId?: string }).repositoryId);
    expect(daily).toContain(scope.repoA);
    expect(daily).toContain(scope.repoB);
    expect(daily).not.toContain(scope.repoC);
    expect(JSON.stringify([...jobs.jobs.values()])).not.toMatch(/private-owner|private-repository|PRIVATE_REPO_CANARY/);
  });

  it("registers pg-boss schedules once under concurrent workers and executes a catch-up tick", async () => {
    const workerA = new PgBossJobPort(databaseUrl as string);
    const workerB = new PgBossJobPort(databaseUrl as string);
    try {
      await workerA.start();
      await workerB.start();
      await Promise.all([registerMaintenanceSchedules(workerA), registerMaintenanceSchedules(workerB)]);
      const names = (await workerA.getSchedules()).filter((row) => row.name.startsWith("maintenance_")).map((row) => row.name).sort();
      expect(names).toEqual(["maintenance_active", "maintenance_audit", "maintenance_authorized"]);
      expect((await workerA.getSchedules()).filter((row) => row.name === "maintenance_active")).toHaveLength(1);
      expect(MAINTENANCE_SCHEDULES.map((schedule) => schedule.cron)).toEqual(["0 */6 * * *", "0 0 * * *", "30 */6 * * *"]);

      await workerA.stop();
      await registerMaintenanceSchedules(workerB);
      expect((await workerB.getSchedules()).filter((row) => row.name.startsWith("maintenance_"))).toHaveLength(3);

      await enqueueCurrentMaintenanceTicks(workerB);
      await enqueueCurrentMaintenanceTicks(workerB);
      let processed = 0;
      await workerB.work("maintenance_authorized", async () => {
        processed += 1;
      });
      const started = Date.now();
      while (processed < 1 && Date.now() - started < 20_000) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(processed).toBeGreaterThanOrEqual(1);
      expect(processed).toBeLessThanOrEqual(2);
    } finally {
      await workerB.stop().catch(() => undefined);
      await workerA.stop().catch(() => undefined);
    }
  }, 60_000);
});
