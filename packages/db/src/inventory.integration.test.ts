import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { InstallationResolutionError, PostgresM1Store, RepositorySelectionError, type RepositoryRecord } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M2 PostgreSQL inventory integration tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

type Scope = {
  tenantId: string;
  accountGithubId: number;
  oldGithubInstallationId: number;
  oldInstallationId: string;
  pool: ReturnType<typeof createPool>;
  admin: Client;
  store: PostgresM1Store;
};

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const accountGithubId = 700_000_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const oldInstallationId = randomUUID();
  const admin = new Client({ connectionString: databaseUrl as string });
  const pool = createPool(databaseUrl as string, 4);
  const store = new PostgresM1Store(pool);
  await admin.connect();
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: "owner-" + tenantId.slice(0, 8), displayName: "test owner" });
  await store.saveInstallation({ id: oldInstallationId, tenantId, githubInstallationId: 22, accountGithubAccountId: accountGithubId });
  return { tenantId, accountGithubId, oldGithubInstallationId: 22, oldInstallationId, pool, admin, store };
}

async function cleanup(scope: Scope): Promise<void> {
  await scope.admin.query("delete from sync_jobs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from webhook_deliveries where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_name_history where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_access where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from branches where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commit_refs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commits where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from development_events where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from sync_cursors where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from reconciliation_generations where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from outbox where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repositories where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_installations where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from installation_routes where tenant_id=$1", [scope.tenantId]);
  const users = await scope.admin.query<{ id: string; account_id: string }>("select u.id,gi.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts gi on gi.id=i.github_account_id where u.primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
  await scope.admin.query("delete from tenant_members where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from users where primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
  await scope.admin.query("delete from tenants where id=$1", [scope.tenantId]);
  await scope.admin.end();
  await scope.pool.end();
}

function repository(scope: Scope, githubRepositoryId: number, name: string, observedAt: Date): RepositoryRecord {
  return {
    id: randomUUID(),
    tenantId: scope.tenantId,
    installationId: scope.oldInstallationId,
    githubRepositoryId,
    ownerLogin: "owner",
    name,
    fullName: "owner/" + name,
    private: true,
    defaultBranch: "main",
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastAuthoritativeObservedAt: observedAt,
  };
}

describeIntegration("M2 PostgreSQL inventory lifecycle", () => {
  const scopes: Scope[] = [];

  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("clears selected state on removal, preserves it on re-add, and handles suspension", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const firstObservedAt = new Date("2026-08-22T00:00:00Z");
    const repoA = repository(scope, 101, "a", firstObservedAt);
    const repoB = repository(scope, 102, "b", firstObservedAt);
    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: scope.oldGithubInstallationId, observedAt: firstObservedAt, repositories: [repoA, repoB] });
    const savedA = await scope.store.getRepositoryByGithubId(scope.tenantId, 101);
    const savedB = await scope.store.getRepositoryByGithubId(scope.tenantId, 102);
    await scope.store.selectRepository(scope.tenantId, savedA?.id ?? "");

    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: scope.oldGithubInstallationId, observedAt: new Date("2026-08-22T00:01:00Z"), repositories: [repoB] });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 101)).toMatchObject({ accessStatus: "access_removed", selected: false });
    await expect(scope.store.selectRepository(scope.tenantId, savedB?.id ?? "")).resolves.toMatchObject({ selected: true });

    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: scope.oldGithubInstallationId, observedAt: new Date("2026-08-22T00:02:00Z"), repositories: [repository(scope, 101, "a-renamed", new Date("2026-08-22T00:02:00Z")), repoB] });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 101)).toMatchObject({ accessStatus: "accessible", selected: false, fullName: "owner/a-renamed" });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 102)).toMatchObject({ selected: true });
    await expect(scope.store.selectRepository(scope.tenantId, savedA?.id ?? "")).rejects.toBeInstanceOf(RepositorySelectionError);

    await scope.store.updateInstallationLifecycle(scope.oldGithubInstallationId, "suspended", new Date("2026-08-22T00:03:00Z"));
    const suspendedRows = await scope.store.listRepositoryInventory(scope.tenantId, scope.oldInstallationId);
    expect(suspendedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ githubRepositoryId: 101, accessStatus: "installation_suspended", selected: false }),
      expect.objectContaining({ githubRepositoryId: 102, accessStatus: "installation_suspended", selected: false }),
    ]));
    await scope.store.updateInstallationLifecycle(scope.oldGithubInstallationId, "active", new Date("2026-08-22T00:04:00Z"));
    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: scope.oldGithubInstallationId, observedAt: new Date("2026-08-22T00:05:00Z"), repositories: [repository(scope, 101, "a-renamed", new Date("2026-08-22T00:05:00Z")), repoB] });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 101)).toMatchObject({ accessStatus: "accessible", selected: false });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 102)).toMatchObject({ accessStatus: "accessible", selected: false });
  });

  it("resolves the new active installation and reuses repository identity after reinstall", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const observedAt = new Date("2026-08-22T01:00:00Z");
    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: 22, observedAt, repositories: [repository(scope, 123, "before", observedAt)] });
    const before = await scope.store.getRepositoryByGithubId(scope.tenantId, 123);
    await scope.store.updateInstallationLifecycle(22, "deleted", new Date("2026-08-22T01:01:00Z"));

    const newInstallationId = randomUUID();
    await scope.store.saveInstallation({ id: newInstallationId, tenantId: scope.tenantId, githubInstallationId: 35, accountGithubAccountId: scope.accountGithubId });
    await expect(scope.store.getActiveInstallationForTenant(scope.tenantId)).resolves.toMatchObject({ id: newInstallationId, githubInstallationId: 35 });
    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: 35, observedAt: new Date("2026-08-22T01:02:00Z"), repositories: [repository(scope, 123, "after", new Date("2026-08-22T01:02:00Z"))] });

    const after = await scope.store.getRepositoryByGithubId(scope.tenantId, 123);
    const counts = await scope.admin.query<{ repositories: string; access_rows: string }>("select (select count(*) from repositories where tenant_id=$1 and github_repository_id=123)::text as repositories,(select count(*) from repository_access where tenant_id=$1 and repository_id=(select id from repositories where tenant_id=$1 and github_repository_id=123))::text as access_rows", [scope.tenantId]);
    expect(after).toMatchObject({ id: before?.id, installationId: newInstallationId, fullName: "owner/after", selected: false });
    expect(counts.rows[0]).toEqual({ repositories: "1", access_rows: "2" });
    expect(await scope.store.listRepositoryInventory(scope.tenantId, scope.oldInstallationId)).toEqual([expect.objectContaining({ accessStatus: "disconnected", selected: false })]);

    const thirdInstallationId = randomUUID();
    await scope.store.saveInstallation({ id: thirdInstallationId, tenantId: scope.tenantId, githubInstallationId: 36, accountGithubAccountId: scope.accountGithubId });
    await expect(scope.store.getActiveInstallationForTenant(scope.tenantId)).rejects.toBeInstanceOf(InstallationResolutionError);
  });

  it("serializes concurrent observations and keeps the newer completed inventory", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const baseAt = new Date("2026-08-22T02:00:00Z");
    await scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: 22, observedAt: baseAt, repositories: [repository(scope, 201, "base", baseAt), repository(scope, 202, "kept", baseAt)] });
    const olderAt = new Date("2026-08-22T02:01:00Z");
    const newerAt = new Date("2026-08-22T02:02:00Z");
    const older = scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: 22, observedAt: olderAt, repositories: [repository(scope, 201, "older", olderAt)] });
    const newer = scope.store.reconcileInstallationInventory({ tenantId: scope.tenantId, githubInstallationId: 22, observedAt: newerAt, repositories: [repository(scope, 201, "newer", newerAt)] });
    await Promise.all([older, newer]);

    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 201)).toMatchObject({ fullName: "owner/newer", lastAuthoritativeObservedAt: newerAt });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 202)).toMatchObject({ accessStatus: "access_removed", selected: false });
    await expect(scope.store.getActiveInstallationForTenant(scope.tenantId)).resolves.toMatchObject({ lastInventoryAt: newerAt });
  });
});
