import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { GithubRateLimitPauseError, type AppWebhookDelivery, type GithubAppClient } from "@devmemoir/github";
import { InMemoryJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { enqueueGithubDeliveryAudit, processGithubDeliveryAudit, resumeGithubDeliveryRepairs, type DeliveryAuditDependencies } from "./delivery-audit.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.2 PostgreSQL delivery-audit worker tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

type Scope = {
  tenantId: string;
  githubAppId: number;
  installationGithubId: number;
  guid: string;
  admin: ReturnType<typeof createPool>;
  pool: ReturnType<typeof createPool>;
  store: PostgresM1Store;
};

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const githubAppId = 900_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
  const installationGithubId = 91_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(6, 10), 16);
  const guid = randomUUID();
  const admin = createPool(databaseUrl as string, 2);
  const pool = createPool(databaseUrl as string, 3);
  const store = new PostgresM1Store(pool);
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: githubAppId, login: `owner-${tenantId.slice(0, 8)}`, displayName: "owner" });
  await store.saveInstallation({ id: randomUUID(), tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubAppId });
  return { tenantId, githubAppId, installationGithubId, guid, admin, pool, store };
}

async function cleanup(scope: Scope): Promise<void> {
  await scope.admin.query("delete from github_delivery_repairs where github_app_id=$1", [scope.githubAppId]);
  await scope.admin.query("delete from github_delivery_audits where github_app_id=$1", [scope.githubAppId]);
  await scope.admin.query("delete from webhook_deliveries where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_access where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_installations where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from installation_routes where tenant_id=$1", [scope.tenantId]);
  const users = await scope.admin.query<{ id: string; account_id: string }>("select u.id,ga.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts ga on ga.id=i.github_account_id where u.primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
  await scope.admin.query("delete from tenant_members where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from users where primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
  await scope.admin.query("delete from tenants where id=$1", [scope.tenantId]);
  await scope.pool.end();
  await scope.admin.end();
}

function delivery(scope: Scope, overrides: Partial<AppWebhookDelivery> = {}): AppWebhookDelivery {
  return {
    id: 55,
    guid: scope.guid,
    deliveredAt: new Date("2026-08-29T11:00:00Z"),
    redelivery: false,
    statusCode: 502,
    eventName: "pull_request",
    installationGithubId: scope.installationGithubId,
    ...overrides,
  };
}

describeIntegration("M5.2 worker PostgreSQL audit restart and checkpoint", () => {
  const scopes: Scope[] = [];
  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("commits repair state, restarts, and does not duplicate redelivery or local rows", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const redelivered: number[] = [];
    const app: GithubAppClient = {
      listAppWebhookDeliveries: async () => ({ deliveries: [delivery(scope)] }),
      redeliverAppWebhookDelivery: async (id) => { redelivered.push(id); },
    };
    const jobs = new InMemoryJobPort();
    const now = () => new Date("2026-08-29T12:00:00Z");
    const deps: DeliveryAuditDependencies = { store: scope.store, jobs, githubApp: app, logger: createLogger(() => undefined), now };
    await scope.store.insertDelivery({
      tenantId: scope.tenantId,
      guid: scope.guid,
      eventName: "pull_request",
      installationGithubId: scope.installationGithubId,
      payloadExpiresAt: new Date("2026-09-05T00:00:00Z"),
      now: now(),
    });
    const runId = await enqueueGithubDeliveryAudit({ githubAppId: scope.githubAppId }, deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId: scope.githubAppId, auditRunId: runId, page: 1 }, deps);
    const replacement: DeliveryAuditDependencies = { store: scope.store, jobs: new InMemoryJobPort(), githubApp: app, logger: createLogger(() => undefined), now };
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId: scope.githubAppId, auditRunId: runId, page: 1 }, replacement);
    expect(redelivered).toEqual([55]);
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.attemptCount).toBe(1);
    expect((await scope.store.getDeliveryByGuid(scope.guid, scope.tenantId))?.receiptCount).toBe(1);
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))?.status).toBe("completed");
  });

  it("leaves the durable cursor unchanged when the App JWT list is rate limited", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const resumeAt = new Date("2026-08-29T12:20:00Z");
    const app: GithubAppClient = {
      listAppWebhookDeliveries: async () => { throw new GithubRateLimitPauseError("secondary_rate_limit", 403, resumeAt); },
      redeliverAppWebhookDelivery: async () => { throw new Error("must not redeliver"); },
    };
    const jobs = new InMemoryJobPort();
    const deps: DeliveryAuditDependencies = { store: scope.store, jobs, githubApp: app, logger: createLogger(() => undefined), now: () => new Date("2026-08-29T12:00:00Z") };
    const runId = await enqueueGithubDeliveryAudit({ githubAppId: scope.githubAppId }, deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId: scope.githubAppId, auditRunId: runId, page: 1 }, deps);
    const audit = await scope.store.getGithubDeliveryAudit(scope.githubAppId);
    expect(audit?.status).toBe("paused");
    expect(audit?.pageNumber).toBe(1);
    expect(audit?.highWaterDeliveredAt).toBeUndefined();
    expect(audit?.lastSuccessAt).toBeUndefined();
  });

  it("recovers a PostgreSQL requesting claim after worker replacement and accepts one POST", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const redelivered: number[] = [];
    let failOnce = true;
    const app: GithubAppClient = {
      listAppWebhookDeliveries: async () => ({ deliveries: [delivery(scope)] }),
      redeliverAppWebhookDelivery: async (id) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected_worker_crash");
        }
        redelivered.push(id);
      },
    };
    const claimedAt = () => new Date("2026-08-29T12:00:00Z");
    const jobs = new InMemoryJobPort();
    const deps: DeliveryAuditDependencies = { store: scope.store, jobs, githubApp: app, logger: createLogger(() => undefined), now: claimedAt };
    const runId = await enqueueGithubDeliveryAudit({ githubAppId: scope.githubAppId }, deps);
    await expect(processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId: scope.githubAppId, auditRunId: runId, page: 1 }, deps)).rejects.toThrow("injected_worker_crash");
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.status).toBe("requesting");
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.attemptCount).toBe(0);

    const recovered: DeliveryAuditDependencies = { store: scope.store, jobs: new InMemoryJobPort(), githubApp: app, logger: createLogger(() => undefined), now: () => new Date("2026-08-29T12:01:00Z") };
    await resumeGithubDeliveryRepairs(scope.githubAppId, recovered);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId: scope.githubAppId, auditRunId: runId, deliveryGuid: scope.guid, githubDeliveryId: 55 }, recovered);
    expect(redelivered).toEqual([55]);
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.status).toBe("requested");
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.attemptCount).toBe(1);
  });
});
