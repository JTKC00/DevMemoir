import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import type { GithubClient } from "@devmemoir/github";
import { InMemoryJobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { processRepositoryReconciliation, type ReconciliationDependencies } from "./reconciliation.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.1 PostgreSQL reconciliation generation tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

type Scope = {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  installationGithubId: number;
  accountGithubId: number;
  githubRepositoryId: number;
  admin: ReturnType<typeof createPool>;
  pool: ReturnType<typeof createPool>;
  store: PostgresM1Store;
};

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();
  const accountGithubId = 900_000_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const installationGithubId = 90_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(8, 12), 16);
  const githubRepositoryId = accountGithubId + 1;
  const admin = createPool(databaseUrl as string, 2);
  const pool = createPool(databaseUrl as string, 3);
  const store = new PostgresM1Store(pool);
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: `owner-${tenantId.slice(0, 8)}`, displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: accountGithubId });
  await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId, ownerLogin: "private-owner", name: "private-repository", fullName: "private-owner/private-repository", private: true, defaultBranch: "main" });
  return { tenantId, repositoryId, installationId, installationGithubId, accountGithubId, githubRepositoryId, admin, pool, store };
}

async function cleanup(scope: Scope): Promise<void> {
  await scope.admin.query("delete from releases where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from issues where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from pull_requests where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from tags where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commit_refs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from development_events where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commits where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from branches where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from sync_cursors where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from reconciliation_generations where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from sync_jobs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_access where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repositories where tenant_id=$1", [scope.tenantId]);
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

function authoritativeGithub(scope: Scope, counters: { inventory: number; pages: number }, overrides: Partial<GithubClient> = {}): GithubClient {
  const sourceTime = new Date("2026-08-28T01:00:00Z");
  return {
    getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "unused" }),
    getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
    listInstallationRepositories: async () => {
      counters.inventory += 1;
      return { repositories: [{ id: scope.githubRepositoryId, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main", owner: { id: scope.accountGithubId, login: "private-owner", type: "User" } }] };
    },
    getRepository: async () => ({ id: scope.githubRepositoryId, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main" }),
    listCommits: async () => {
      counters.pages += 1;
      return { commits: [{ repositoryId: scope.repositoryId, sha: `head-${counters.pages}`, message: "PRIVATE_COMMIT_CANARY", committedAt: sourceTime, parents: [] }], nextPage: 2 };
    },
    getCommit: async () => ({ repositoryId: scope.repositoryId, sha: "head", message: "PRIVATE_COMMIT_CANARY", committedAt: sourceTime, parents: [] }),
    getRefHead: async () => "head",
    listBranches: async () => ({ branches: [{ name: "main", headSha: "head", protected: true }] }),
    listTags: async () => ({ tags: [] }),
    listPullRequests: async () => ({ pullRequests: [] }),
    listIssues: async () => ({ issues: [] }),
    listReleases: async () => ({ releases: [] }),
    ...overrides,
  };
}

describeIntegration("M5.1 PostgreSQL reconciliation generation supersession", () => {
  const scopes: Scope[] = [];
  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("does not let a delayed older coordinator or page job reset a newer generation", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const runA = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const runB = "00000000-0000-4000-8000-0000000000bb";
    expect(runA > runB).toBe(true);
    const counters = { inventory: 0, pages: 0 };
    const jobs = new InMemoryJobPort();
    const deps: ReconciliationDependencies = {
      store: scope.store,
      jobs,
      githubForInstallation: () => authoritativeGithub(scope, counters),
      logger: createLogger(() => undefined),
      ownerGithubAccountId: scope.accountGithubId,
      now: () => new Date("2026-08-28T02:00:00Z"),
    };
    const coordinatorA: SyncJobPayload = { kind: "repository_reconciliation", tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationGithubId, reconciliationRunId: runA };
    const coordinatorB: SyncJobPayload = { ...coordinatorA, reconciliationRunId: runB };

    await processRepositoryReconciliation(coordinatorA, deps);
    await processRepositoryReconciliation({ ...coordinatorA, stage: "default_branch_commits" }, deps);
    expect((await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId))?.reconciliationRunId).toBe(runA);

    await processRepositoryReconciliation(coordinatorB, deps);
    await processRepositoryReconciliation({ ...coordinatorB, stage: "default_branch_commits" }, deps);
    const currentB = await scope.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main");
    const countsB = await scope.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId);
    const eventsB = await scope.store.listActivity(scope.tenantId, scope.repositoryId, { context: "default", includeBots: true });
    const generationB = await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId);
    expect(generationB?.reconciliationRunId).toBe(runB);
    expect(generationB?.current).toBe(true);
    const generationA = await scope.store.getRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId, runA);
    expect(generationA?.current).toBe(false);
    expect(generationB && generationA ? generationB.generation > generationA.generation : false).toBe(true);
    const inventoryAfterB = counters.inventory;
    const pagesAfterB = counters.pages;

    await processRepositoryReconciliation(coordinatorA, deps);
    await processRepositoryReconciliation({ ...coordinatorA, stage: "default_branch_commits" }, deps);
    expect(counters.inventory).toBe(inventoryAfterB);
    expect(counters.pages).toBe(pagesAfterB);
    expect(await scope.store.getCurrentRepositoryReconciliationGeneration(scope.tenantId, scope.repositoryId)).toMatchObject({ reconciliationRunId: runB, current: true });
    expect(await scope.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main")).toEqual(currentB);
    expect(await scope.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).toEqual(countsB);
    expect((await scope.store.listActivity(scope.tenantId, scope.repositoryId, { context: "default", includeBots: true })).map((event) => event.logicalEventKey)).toEqual(eventsB.map((event) => event.logicalEventKey));
    expect(new Set(eventsB.map((event) => event.logicalEventKey)).size).toBe(eventsB.length);

    await processRepositoryReconciliation(coordinatorB, deps);
    expect(await scope.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main")).toEqual(currentB);
    expect(await scope.store.startRepositoryReconciliation({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationId, defaultBranch: "main", reconciliationRunId: runB, now: new Date("2026-08-28T02:10:00Z") })).toMatchObject({ cursor: { nextPage: currentB?.nextPage, reconciliationRunId: runB } });
  });
});
