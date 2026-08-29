import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.2 PostgreSQL delivery-audit tests");
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
  const githubAppId = 800_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
  const installationGithubId = 81_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(6, 10), 16);
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

describeIntegration("M5.2 PostgreSQL delivery audit and repair", () => {
  const scopes: Scope[] = [];
  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("reuses same-GUID local state, protects terminal rows, and keeps retry metadata", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const now = new Date("2026-08-29T12:00:00Z");
    const runId = randomUUID();
    const audit = await scope.store.startGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: runId, now });
    expect(audit.status).toBe("in_progress");
    expect(audit.generation).toBe(1);

    const delivery = await scope.store.insertDelivery({
      tenantId: scope.tenantId,
      guid: scope.guid,
      eventName: "push",
      installationGithubId: scope.installationGithubId,
      payloadExpiresAt: new Date(now.getTime() + 86_400_000),
      now,
    });
    const observed = await scope.store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: scope.guid,
      githubDeliveryId: 99,
      githubAppId: scope.githubAppId,
      auditRunId: runId,
      eventName: "push",
      installationGithubId: scope.installationGithubId,
      statusCode: 502,
      deliveredAt: now,
      now,
    });
    expect(observed.status).toBe("pending");
    const claimed = await scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 99, now, maxAttempts: 8 });
    expect(claimed.allowed).toBe(true);
    expect(claimed.repair.status).toBe("requesting");
    expect(claimed.localDelivery?.id).toBe(delivery.record.id);
    expect(claimed.repair.attemptCount).toBe(0);
    expect(claimed.repair.nextEligibleAt).toBeTruthy();

    const replay = await scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 99, now, maxAttempts: 8 });
    expect(replay.allowed).toBe(false);
    expect(replay.reason).toBe("cooldown");
    expect(replay.repair.attemptCount).toBe(0);
    const accepted = await scope.store.acceptGithubDeliveryRedelivery({ guid: scope.guid, now });
    expect(accepted?.status).toBe("requested");
    expect(accepted?.attemptCount).toBe(1);

    await scope.store.updateDelivery(delivery.record.id, { state: "processed" }, scope.tenantId);
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await scope.store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: scope.guid,
      githubDeliveryId: 100,
      githubAppId: scope.githubAppId,
      auditRunId: runId,
      eventName: "push",
      installationGithubId: scope.installationGithubId,
      statusCode: 502,
      deliveredAt: later,
      now: later,
    });
    const terminal = await scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 100, now: later, maxAttempts: 8 });
    expect(terminal.allowed).toBe(false);
    expect(terminal.reason).toBe("terminal");
    expect((await scope.store.getDeliveryByGuid(scope.guid, scope.tenantId))?.state).toBe("processed");
  });

  it("does not advance a stale page cursor and resumes the same generation after pause", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const now = new Date("2026-08-29T12:00:00Z");
    const runId = randomUUID();
    await scope.store.startGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: runId, now });
    const stale = await scope.store.commitGithubDeliveryAuditPage({ githubAppId: scope.githubAppId, auditRunId: runId, expectedPage: 9, reachedStop: false, now, nextCursor: "v1_other" });
    expect(stale).toBeUndefined();
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))?.pageNumber).toBe(1);

    const pausedUntil = new Date(now.getTime() + 60_000);
    await scope.store.pauseGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: runId, pausedUntil, errorCode: "github_primary_rate_limit" });
    expect((await scope.store.getGithubDeliveryAudit(scope.githubAppId))?.status).toBe("paused");
    const tooEarly = await scope.store.resumeGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: runId, now });
    expect(tooEarly?.status).toBe("paused");
    const resumed = await scope.store.resumeGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: runId, now: pausedUntil });
    expect(resumed?.status).toBe("in_progress");
    expect(resumed?.pageNumber).toBe(1);

    const other = await scope.store.startGithubDeliveryAudit({ githubAppId: scope.githubAppId, auditRunId: randomUUID(), now: pausedUntil });
    expect(other.currentRunId).toBe(runId);
  });

  it("allows only one concurrent redelivery claim for a GUID", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const now = new Date("2026-08-29T12:00:00Z");
    const runId = randomUUID();
    await scope.store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: scope.guid,
      githubDeliveryId: 77,
      githubAppId: scope.githubAppId,
      auditRunId: runId,
      eventName: "issues",
      installationGithubId: scope.installationGithubId,
      statusCode: 500,
      deliveredAt: now,
      now,
    });
    const [first, second] = await Promise.all([
      scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 77, now, maxAttempts: 8 }),
      scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 77, now, maxAttempts: 8 }),
    ]);
    const allowed = [first, second].filter((claim) => claim.allowed);
    expect(allowed).toHaveLength(1);
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.status).toBe("requesting");
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.attemptCount).toBe(0);
  });

  it("recovers a stranded requesting claim after process replacement without dual ownership", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const claimedAt = new Date("2026-08-29T12:00:00Z");
    const recoveredAt = new Date("2026-08-29T12:01:00Z");
    const runId = randomUUID();
    await scope.store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: scope.guid,
      githubDeliveryId: 88,
      githubAppId: scope.githubAppId,
      auditRunId: runId,
      eventName: "push",
      installationGithubId: scope.installationGithubId,
      statusCode: 502,
      deliveredAt: claimedAt,
      now: claimedAt,
    });
    const first = await scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 88, now: claimedAt, maxAttempts: 8 });
    expect(first.allowed).toBe(true);
    expect(first.repair.status).toBe("requesting");
    expect(first.repair.attemptCount).toBe(0);

    const [replacement, rival] = await Promise.all([
      scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 88, now: recoveredAt, maxAttempts: 8 }),
      scope.store.claimGithubDeliveryRedelivery({ guid: scope.guid, githubDeliveryId: 88, now: recoveredAt, maxAttempts: 8 }),
    ]);
    expect([replacement, rival].filter((claim) => claim.allowed)).toHaveLength(1);
    await scope.store.acceptGithubDeliveryRedelivery({ guid: scope.guid, now: recoveredAt });
    await scope.store.acceptGithubDeliveryRedelivery({ guid: scope.guid, now: recoveredAt });
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.status).toBe("requested");
    expect((await scope.store.getGithubDeliveryRepair(scope.guid))?.attemptCount).toBe(1);
  });
});
