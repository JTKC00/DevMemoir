import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { GithubRateLimitPauseError, InstallationRequestLanes, type GithubClient, type GithubCommit, type GithubRequestResponse } from "@devmemoir/github";
import { historicalBackfillLogicalKey, PgBossJobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { processHistoricalBackfill } from "./historical.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M3 PostgreSQL + pg-boss restart integration tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

type Scope = {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  installationGithubId: number;
  accountGithubId: number;
  admin: ReturnType<typeof createPool>;
  pools: Array<ReturnType<typeof createPool>>;
  bosses: PgBossJobPort[];
};

function commit(sha: string): GithubCommit {
  return { repositoryId: "", sha, author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: sha, committedAt: new Date("2026-08-20T00:00:00Z"), parents: [] };
}

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();
  const accountGithubId = 700_000_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const installationGithubId = 70_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(8, 12), 16);
  const admin = createPool(databaseUrl as string, 3);
  const pool = createPool(databaseUrl as string, 3);
  const store = new PostgresM1Store(pool);
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: `owner-${tenantId.slice(0, 8)}`, displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: accountGithubId });
  await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: accountGithubId + 1, ownerLogin: "private-owner", name: "private-repository", fullName: "private-owner/private-repository", private: true, defaultBranch: "main" });
  return { tenantId, repositoryId, installationId, installationGithubId, accountGithubId, admin, pools: [pool], bosses: [] };
}

async function cleanup(scope: Scope): Promise<void> {
  for (const boss of scope.bosses) await boss.stop().catch(() => undefined);
  await scope.admin.query("delete from releases where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from issues where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from pull_requests where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from tags where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commit_refs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from development_events where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commits where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from branches where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from sync_cursors where tenant_id=$1", [scope.tenantId]);
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
  for (const pool of scope.pools) await pool.end();
  await scope.admin.end();
}

async function waitUntil(assertion: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!await assertion()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for historical pg-boss worker");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeIntegration("M3 PostgreSQL + pg-boss historical restart boundaries", () => {
  const scopes: Scope[] = [];

  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("recreates adapters across rollback, page advance, after-commit retry, and stage transition", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const allCommits = Array.from({ length: 101 }, (_, index) => commit(`sha-${index}`));
    let failBeforeCheckpoint = true;
    const client: GithubClient = {
      getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: scope.accountGithubId + 1, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main" }),
      getRefHead: async () => "head",
      getCommit: async () => commit("head"),
      listCommits: async ({ page = 1 }) => {
        if (page === 1 && failBeforeCheckpoint) throw new Error("injected_before_checkpoint");
        return page === 1 ? { commits: allCommits.slice(0, 100), nextPage: 2 } : { commits: allCommits.slice(100) };
      },
      listBranches: async () => ({ branches: [] }),
      listTags: async () => ({ tags: [] }),
      listPullRequests: async () => ({ pullRequests: [] }),
      listIssues: async () => ({ issues: [] }),
      listReleases: async () => ({ releases: [] }),
    };
    const payload: SyncJobPayload = { kind: "repository_backfill", tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationGithubId };

    const recreate = async () => {
      const pool = createPool(databaseUrl as string, 3);
      const store = new PostgresM1Store(pool);
      const boss = new PgBossJobPort(databaseUrl as string);
      scope.pools.push(pool);
      scope.bosses.push(boss);
      try {
        await boss.start();
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "40P01")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        await boss.start();
      }
      return { store, boss, deps: { store, jobs: boss, githubForInstallation: () => client, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId } };
    };

    const beforeCommit = await recreate();
    await expect(processHistoricalBackfill(payload, beforeCommit.deps)).rejects.toThrow("injected_before_checkpoint");
    expect((await beforeCommit.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(1);
    expect((await beforeCommit.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).commits).toBe(0);
    await beforeCommit.boss.stop();

    failBeforeCheckpoint = false;
    const pageOne = await recreate();
    await processHistoricalBackfill(payload, pageOne.deps);
    expect((await pageOne.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(2);
    expect((await pageOne.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).commits).toBe(100);
    await pageOne.boss.stop();

    // Retry the same physical page-one payload after commit but before acknowledgement.
    const afterCommitRetry = await recreate();
    await processHistoricalBackfill(payload, afterCommitRetry.deps);
    expect((await afterCommitRetry.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).commits).toBe(101);
    expect((await afterCommitRetry.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "branches"))?.status).toBe("in_progress");
    await afterCommitRetry.boss.stop();

    const stageReplacement = await recreate();
    await processHistoricalBackfill(payload, stageReplacement.deps);
    expect((await stageReplacement.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "tags"))?.status).toBe("in_progress");
    for (let index = 0; index < 8; index += 1) await processHistoricalBackfill(payload, stageReplacement.deps);
    const completedCounts = await stageReplacement.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId);
    expect(completedCounts).toMatchObject({ commits: 101, branches: 1, tags: 0, pullRequests: 0, issues: 0, releases: 0 });
    expect((await stageReplacement.store.getHistoricalProgress(scope.tenantId, scope.repositoryId, "completed"))?.status).toBe("completed");
    await processHistoricalBackfill(payload, stageReplacement.deps);
    expect(await stageReplacement.store.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).toEqual(completedCounts);
    expect((await scope.admin.query<{ reachable: boolean }>("select cr.reachable from commit_refs cr join commits c on c.tenant_id=cr.tenant_id and c.id=cr.commit_id where cr.tenant_id=$1 and c.repository_id=$2", [scope.tenantId, scope.repositoryId])).rows.every((row) => row.reachable)).toBe(true);
  }, 90_000);

  it("executes through pg-boss and recovers after commit-before-ack worker failure", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const commits = Array.from({ length: 101 }, (_, index) => commit(`queued-sha-${index}`));
    const commitPages: number[] = [];
    let branchStarts = 0;
    const client: GithubClient = {
      getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: scope.accountGithubId + 1, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main" }),
      getRefHead: async () => "queued-head",
      getCommit: async () => commit("queued-head"),
      listCommits: async ({ page = 1 }) => {
        commitPages.push(page);
        return page === 1 ? { commits: commits.slice(0, 100), nextPage: 2 } : { commits: commits.slice(100) };
      },
      listBranches: async () => { branchStarts += 1; return { branches: [] }; },
      listTags: async () => ({ tags: [] }),
      listPullRequests: async () => ({ pullRequests: [] }),
      listIssues: async () => ({ issues: [] }),
      listReleases: async () => ({ releases: [] }),
    };
    const payload: SyncJobPayload = { kind: "repository_backfill", tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationGithubId };
    const dependencies = (store: PostgresM1Store, jobs: PgBossJobPort) => ({ store, jobs, githubForInstallation: () => client, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId });

    const firstPool = createPool(databaseUrl as string, 3);
    const firstStore = new PostgresM1Store(firstPool);
    const firstBoss = new PgBossJobPort(databaseUrl as string);
    scope.bosses.push(firstBoss);
    await firstBoss.start();
    let committed!: () => void;
    const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
    await firstBoss.work<SyncJobPayload>("repository_backfill", async (job) => {
      if (job.payload.repositoryId !== scope.repositoryId) return;
      await processHistoricalBackfill(job.payload, dependencies(firstStore, firstBoss));
      committed();
      throw new Error("simulated_worker_loss_before_ack");
    });
    await firstBoss.enqueue("repository_backfill", historicalBackfillLogicalKey(scope.repositoryId, "coordinator"), payload);
    await committedPromise;
    await waitUntil(async () => (await firstStore.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).commits === 100);
    await firstBoss.stop();

    const replacementPool = createPool(databaseUrl as string, 3);
    const replacementStore = new PostgresM1Store(replacementPool);
    const replacementBoss = new PgBossJobPort(databaseUrl as string);
    scope.pools.push(replacementPool);
    scope.bosses.push(replacementBoss);
    await replacementBoss.start();
    await replacementBoss.work<SyncJobPayload>("repository_backfill", async (job) => {
      if (job.payload.repositoryId !== scope.repositoryId) return;
      await processHistoricalBackfill(job.payload, dependencies(replacementStore, replacementBoss));
    });
    await waitUntil(async () => (await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "completed"))?.status === "completed");

    expect(commitPages).toEqual([1, 2]);
    expect(branchStarts).toBeGreaterThan(0);
    expect(await replacementStore.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).toMatchObject({ commits: 101 });
    expect((await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "completed"))?.status).toBe("completed");
  }, 90_000);

  it("keeps an explicit rate-limit pause durable across a replacement worker", async () => {
    const scope = await createScope();
    scopes.push(scope);
    let nowMs = Date.parse("2026-08-23T00:00:00Z");
    const resumeAt = new Date(nowMs + 30_000);
    let mode: "rate" | "ok" = "rate";
    let requestCount = 0;
    const client: GithubClient = {
      getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: scope.accountGithubId + 1, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main" }),
      getRefHead: async () => {
        requestCount += 1;
        if (mode === "rate") throw new GithubRateLimitPauseError("secondary_rate_limit", 429, resumeAt);
        return "head";
      },
      listCommits: async () => { requestCount += 1; return { commits: [commit("explicit-pause-sha")] }; },
      getCommit: async () => commit("head"),
      listBranches: async () => ({ branches: [] }),
      listTags: async () => ({ tags: [] }),
      listPullRequests: async () => ({ pullRequests: [] }),
      listIssues: async () => ({ issues: [] }),
      listReleases: async () => ({ releases: [] }),
    };
    const payload: SyncJobPayload = { kind: "repository_backfill", tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationGithubId };
    const firstPool = createPool(databaseUrl as string, 3);
    const firstStore = new PostgresM1Store(firstPool);
    const firstBoss = new PgBossJobPort(databaseUrl as string);
    scope.bosses.push(firstBoss);
    await firstBoss.start();
    const firstDeps = { store: firstStore, jobs: firstBoss, githubForInstallation: () => client, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId, now: () => new Date(nowMs) };

    await processHistoricalBackfill(payload, firstDeps);
    expect(requestCount).toBe(1);
    await expect(firstStore.getInstallation(scope.installationGithubId)).resolves.toMatchObject({ apiPausedUntil: resumeAt, apiPauseReason: "github_secondary_rate_limit" });
    await expect(firstStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main")).resolves.toMatchObject({ status: "paused", cursor: { nextPage: 1 } });
    await processHistoricalBackfill(payload, firstDeps);
    expect(requestCount).toBe(1);
    await firstBoss.stop();
    await firstPool.end();

    const replacementPool = createPool(databaseUrl as string, 3);
    const replacementStore = new PostgresM1Store(replacementPool);
    const replacementBoss = new PgBossJobPort(databaseUrl as string);
    scope.pools.push(replacementPool);
    scope.bosses.push(replacementBoss);
    await replacementBoss.start();
    const replacementDeps = { store: replacementStore, jobs: replacementBoss, githubForInstallation: () => client, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId, now: () => new Date(nowMs) };

    await processHistoricalBackfill(payload, replacementDeps);
    expect(requestCount).toBe(1);
    expect((await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(1);
    const wakeRows = await scope.admin.query<{ count: string }>("select count(*)::text as count from sync_jobs where tenant_id=$1 and logical_key like $2", [scope.tenantId, `backfill:${scope.repositoryId}:default_branch_commits:%:wake:%`]);
    expect(wakeRows.rows[0]?.count).toBe("1");

    nowMs = resumeAt.getTime();
    mode = "ok";
    await processHistoricalBackfill(payload, replacementDeps);
    expect(requestCount).toBe(4);
    expect(await replacementStore.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).toMatchObject({ commits: 1 });
    expect((await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "branches"))?.status).toBe("in_progress");
    expect((await replacementStore.getInstallation(scope.installationGithubId))?.apiPausedUntil).toBeUndefined();
  }, 90_000);

  it("persists a successful remaining-zero response across fresh store, lane, and pg-boss adapters", async () => {
    const scope = await createScope();
    scopes.push(scope);
    let nowMs = Date.parse("2026-08-23T00:00:00Z");
    const resetAt = new Date(nowMs + 30_000);
    let requestCount = 0;
    const makeGithub = (lane: InstallationRequestLanes): GithubClient => {
      const response = async <T>(data: T, headers: Record<string, string> = {}): Promise<GithubRequestResponse<T>> => {
        requestCount += 1;
        return { status: 200, headers, data };
      };
      return {
        getUser: async () => ({ id: scope.accountGithubId, login: "owner", type: "User" }),
        exchangeOAuthCode: async () => ({ accessToken: "unused" }),
        getInstallation: async () => ({ id: scope.installationGithubId, account: { id: scope.accountGithubId, login: "owner", type: "User" } }),
        listInstallationRepositories: async () => ({ repositories: [] }),
        getRepository: async () => ({ id: scope.accountGithubId + 1, name: "private-repository", full_name: "private-owner/private-repository", private: true, default_branch: "main" }),
        getRefHead: async () => {
          const raw = await lane.run(scope.installationGithubId, () => response({ object: { sha: "head" } }, { "X-RateLimit-Remaining": "1" }));
          return (raw.data as { object: { sha: string } }).object.sha;
        },
        listCommits: async ({ page = 1 }) => {
          const headers = page === 1 && nowMs < resetAt.getTime()
            ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt.getTime() / 1000) }
            : { "X-RateLimit-Remaining": "1" };
          const raw = await lane.run(scope.installationGithubId, () => response({ commits: [{ ...commit("durable-sha"), repositoryId: "" }], ...(page === 1 && nowMs < resetAt.getTime() ? { nextPage: 2 } : {}) }, headers));
          return raw.data as { commits: GithubCommit[]; nextPage?: number };
        },
        getCommit: async () => commit("head"),
        listBranches: async () => ({ branches: [] }),
        listTags: async () => ({ tags: [] }),
        listPullRequests: async () => ({ pullRequests: [] }),
        listIssues: async () => ({ issues: [] }),
        listReleases: async () => ({ releases: [] }),
      };
    };

    const firstPool = createPool(databaseUrl as string, 3);
    const firstStore = new PostgresM1Store(firstPool);
    const firstBoss = new PgBossJobPort(databaseUrl as string);
    scope.bosses.push(firstBoss);
    await firstBoss.start();
    const firstLane = new InstallationRequestLanes(1, () => nowMs, async (installationId, state) => {
      const installation = await firstStore.getInstallation(installationId);
      if (installation) await firstStore.pauseInstallationApi({ tenantId: installation.tenantId, installationId: installation.id, pausedUntil: state.resumeAt, reason: `github_${state.code}` });
    });
    const firstGithub = makeGithub(firstLane);
    const payload: SyncJobPayload = { kind: "repository_backfill", tenantId: scope.tenantId, repositoryId: scope.repositoryId, installationId: scope.installationGithubId };
    const firstDeps = { store: firstStore, jobs: firstBoss, githubForInstallation: () => firstGithub, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId, now: () => new Date(nowMs) };

    await firstBoss.enqueue("repository_backfill", historicalBackfillLogicalKey(scope.repositoryId, "coordinator"), payload);
    await processHistoricalBackfill(payload, firstDeps);
    expect(requestCount).toBe(2);
    await expect(firstStore.getInstallation(scope.installationGithubId)).resolves.toMatchObject({ apiPausedUntil: resetAt, apiPauseReason: "github_primary_rate_limit" });
    expect((await firstStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(1);
    await firstBoss.stop();
    await firstPool.end();

    const replacementPool = createPool(databaseUrl as string, 3);
    const replacementStore = new PostgresM1Store(replacementPool);
    const replacementBoss = new PgBossJobPort(databaseUrl as string);
    scope.pools.push(replacementPool);
    scope.bosses.push(replacementBoss);
    await replacementBoss.start();
    const replacementLane = new InstallationRequestLanes(1, () => nowMs);
    const replacementGithub = makeGithub(replacementLane);
    const replacementDeps = { store: replacementStore, jobs: replacementBoss, githubForInstallation: () => replacementGithub, logger: createLogger(() => undefined), ownerGithubAccountId: scope.accountGithubId, now: () => new Date(nowMs) };

    await processHistoricalBackfill(payload, replacementDeps);
    expect(requestCount).toBe(2);
    expect((await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(1);
    expect(await replacementStore.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).toMatchObject({ commits: 0 });

    nowMs = resetAt.getTime();
    await processHistoricalBackfill(payload, replacementDeps);
    expect((await replacementStore.getHistoricalSourceCounts(scope.tenantId, scope.repositoryId)).commits).toBe(1);
    expect((await replacementStore.getHistoricalProgress(scope.tenantId, scope.repositoryId, "branches"))?.status).toBe("in_progress");
    expect((await replacementStore.getInstallation(scope.installationGithubId))?.apiPausedUntil).toBeUndefined();
    expect(requestCount).toBe(5);
  }, 90_000);
});
