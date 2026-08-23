import { describe, expect, it } from "vitest";
import { InMemoryM1Store, type HistoricalSourceCounts, type HistoricalSourceStage } from "@devmemoir/db";
import { GithubAccessError, GithubRateLimitPauseError, type GithubClient, type GithubCommit } from "@devmemoir/github";
import { historicalBackfillLogicalKey, InMemoryJobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { processHistoricalBackfill, type HistoricalDependencies } from "./historical.js";

const tenantId = "tenant-historical";
const repositoryId = "repository-historical";
const installationGithubId = 701;
const installationId = "installation-historical";
const payload: SyncJobPayload = { kind: "repository_backfill", tenantId, repositoryId, installationId: installationGithubId };

function commit(sha: string): GithubCommit {
  return { repositoryId: "", sha, author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: sha, committedAt: new Date("2026-08-20T00:00:00Z"), parents: [] };
}

function github(overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    getUser: async () => ({ id: 7, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "unused" }),
    getInstallation: async () => ({ id: installationGithubId, account: { id: 7, login: "owner", type: "User" } }),
    listInstallationRepositories: async () => ({ repositories: [] }),
    getRepository: async () => ({ id: 99, name: "private-repository", full_name: "owner/private-repository", private: true, default_branch: "main" }),
    listCommits: async () => ({ commits: [] }),
    getCommit: async () => commit("head"),
    getRefHead: async () => "head",
    listBranches: async () => ({ branches: [] }),
    listTags: async () => ({ tags: [] }),
    listPullRequests: async () => ({ pullRequests: [] }),
    listIssues: async () => ({ issues: [] }),
    listReleases: async () => ({ releases: [] }),
    ...overrides,
  };
}

async function scope(client: GithubClient, now = () => new Date("2026-08-23T00:00:00Z")) {
  const store = new InMemoryM1Store();
  const jobs = new InMemoryJobPort();
  await store.upsertUser({ userId: "user-historical", tenantId, githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: 7 });
  await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: 99, ownerLogin: "private-owner", name: "private-repository", fullName: "private-owner/private-repository", private: true, defaultBranch: "main" });
  const capture = createCanarySink();
  const deps: HistoricalDependencies = { store, jobs, githubForInstallation: () => client, logger: createLogger(capture.sink), ownerGithubAccountId: 7, now };
  return { store, jobs, deps, capture };
}

type MatrixStage = Exclude<HistoricalSourceStage, "default_branch_commits">;
type MatrixMode = "zero" | "one" | "exact" | "multi";
type PlannedPage = { indexes: number[]; nextPage?: number; mutation?: boolean };

function matrixGithub(stage: MatrixStage, mode: MatrixMode) {
  let targetCalls = 0;
  let pageTwoAttempts = 0;
  const oldTime = new Date("2020-01-01T00:00:00Z");
  const newTime = new Date("2026-08-22T00:00:00Z");
  const plan = (page: number, overlap: boolean): PlannedPage => {
    targetCalls += 1;
    if (overlap) return { indexes: mode === "zero" ? [] : [0] };
    if (mode === "zero") return { indexes: [] };
    if (mode === "one") return { indexes: [0] };
    if (mode === "exact") return { indexes: Array.from({ length: 100 }, (_, index) => index) };
    if (page === 1) return { indexes: Array.from({ length: 100 }, (_, index) => index), nextPage: 2 };
    if (page === 2) {
      pageTwoAttempts += 1;
      if (pageTwoAttempts === 1) throw new Error("page_n_failure");
      return { indexes: [0, 100], nextPage: 3, mutation: true };
    }
    return { indexes: [] };
  };
  let releaseCalls = 0;
  const client = github({
    ...(stage === "branches" ? { listBranches: async ({ page = 1 }) => {
      const result = plan(page, false);
      return { branches: result.indexes.map((index) => ({ name: `branch-${index}`, headSha: result.mutation && index === 0 ? "branch-new" : `branch-${index}`, protected: index === 0 })), ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } } : {}),
    ...(stage === "tags" ? { listTags: async ({ page = 1 }) => {
      const result = plan(page, false);
      return { tags: result.indexes.map((index) => ({ name: `tag-${index}`, targetSha: result.mutation && index === 0 ? "tag-new" : `tag-${index}` })), ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } } : {}),
    ...(stage === "pull_requests" ? { listPullRequests: async ({ page = 1, sort }) => {
      const result = plan(page, sort === "updated");
      return { pullRequests: result.indexes.map((index) => ({ id: index + 1, number: index + 1, title: result.mutation && index === 0 ? "pull-new" : `pull-${index}`, state: result.mutation && index === 0 ? "closed" : "open", baseRef: "main", baseSha: "base", headRef: `head-${index}`, headSha: `sha-${index}`, createdAt: oldTime, updatedAt: result.mutation && index === 0 ? newTime : oldTime })), ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } } : {}),
    ...(stage === "issues" ? { listIssues: async ({ page = 1, sort }) => {
      const result = plan(page, sort === "updated");
      return { issues: result.indexes.map((index) => ({ id: index + 1, number: index + 1, title: result.mutation && index === 0 ? "issue-new" : `issue-${index}`, state: result.mutation && index === 0 ? "closed" : "open", createdAt: oldTime, updatedAt: result.mutation && index === 0 ? newTime : oldTime })), ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } } : {}),
    ...(stage === "releases" ? { listReleases: async ({ page = 1 }) => {
      const result = plan(page, releaseCalls++ === 0);
      return { releases: result.indexes.map((index) => ({ id: index + 1, tagName: `v${index}`, name: result.mutation && index === 0 ? "release-new" : `release-${index}`, draft: false, prerelease: false, createdAt: oldTime, publishedAt: result.mutation && index === 0 ? newTime : oldTime })), ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    } } : {}),
  });
  return { client, targetCalls: () => targetCalls, pageTwoAttempts: () => pageTwoAttempts };
}

async function reachStage(stage: MatrixStage, store: InMemoryM1Store, deps: HistoricalDependencies): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if ((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.status === "in_progress") return;
    await processHistoricalBackfill(payload, deps);
  }
  throw new Error(`stage_not_reached:${stage}`);
}

async function finishBackfill(store: InMemoryM1Store, deps: HistoricalDependencies): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if ((await store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.status === "completed") return;
    await processHistoricalBackfill(payload, deps);
  }
  throw new Error("completed_stage_not_reached");
}

function countFor(counts: HistoricalSourceCounts, stage: MatrixStage): number {
  if (stage === "branches") return counts.branches;
  if (stage === "tags") return counts.tags;
  if (stage === "pull_requests") return counts.pullRequests;
  if (stage === "issues") return counts.issues;
  return counts.releases;
}

function expectMutation(stage: MatrixStage, store: InMemoryM1Store): void {
  if (stage === "branches") expect(store.historicalBranches.get(`${tenantId}:${repositoryId}:branch-0`)).toMatchObject({ headSha: "branch-new" });
  else if (stage === "tags") expect(store.historicalTags.get(`${tenantId}:${repositoryId}:tag-0`)).toMatchObject({ targetSha: "tag-new" });
  else if (stage === "pull_requests") expect(store.historicalPullRequests.get(`${tenantId}:${repositoryId}:1`)).toMatchObject({ title: "pull-new", state: "closed" });
  else if (stage === "issues") expect(store.historicalIssues.get(`${tenantId}:${repositoryId}:1`)).toMatchObject({ title: "issue-new", state: "closed" });
  else expect(store.historicalReleases.get(`${tenantId}:${repositoryId}:1`)).toMatchObject({ name: "release-new" });
}

describe("restartable historical backfill", () => {
  it("covers commit zero, one, exact-100, page-N failure/restart, duplicate, empty-final, and completed rerun", async () => {
    for (const [size, expected] of [[0, 0], [1, 1], [100, 100]] as const) {
      const client = github({ listCommits: async () => ({ commits: Array.from({ length: size }, (_, index) => commit(`boundary-${size}-${index}`)) }) });
      const { store, deps } = await scope(client);
      await processHistoricalBackfill(payload, deps);
      expect((await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.status).toBe("completed");
      expect((await store.getHistoricalSourceCounts(tenantId, repositoryId)).commits).toBe(expected);
    }

    let pageTwoAttempts = 0;
    const client = github({
      listCommits: async ({ page = 1 }) => {
        if (page === 1) return { commits: Array.from({ length: 100 }, (_, index) => commit(`matrix-${index}`)), nextPage: 2 };
        if (page === 2) {
          pageTwoAttempts += 1;
          if (pageTwoAttempts === 1) throw new Error("commit_page_n_failure");
          return { commits: [commit("matrix-0"), commit("matrix-100")], nextPage: 3 };
        }
        return { commits: [] };
      },
    });
    const { store, deps } = await scope(client);
    await processHistoricalBackfill(payload, deps);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(2);
    expect((await store.getHistoricalSourceCounts(tenantId, repositoryId)).commits).toBe(100);
    await expect(processHistoricalBackfill(payload, deps)).rejects.toThrow("commit_page_n_failure");
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(2);
    expect((await store.getHistoricalSourceCounts(tenantId, repositoryId)).commits).toBe(100);
    const replacement = { ...deps, jobs: new InMemoryJobPort() };
    await processHistoricalBackfill(payload, replacement);
    expect(pageTwoAttempts).toBe(2);
    expect((await store.getHistoricalSourceCounts(tenantId, repositoryId)).commits).toBe(101);
    await processHistoricalBackfill(payload, replacement);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.status).toBe("completed");
    await finishBackfill(store, replacement);
    const completedCounts = await store.getHistoricalSourceCounts(tenantId, repositoryId);
    await processHistoricalBackfill(payload, replacement);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(completedCounts);
  });

  it("resumes page two with a recreated worker, transitions stages, and is monotonic after completion", async () => {
    const calls: number[] = [];
    const commits = Array.from({ length: 101 }, (_, index) => commit(`sha-${index}`));
    const client = github({
      listCommits: async ({ page = 1 }) => {
        calls.push(page);
        return page === 1 ? { commits: commits.slice(0, 100), nextPage: 2 } : { commits: commits.slice(100) };
      },
    });
    const first = await scope(client);
    await processHistoricalBackfill(payload, first.deps);
    expect(await first.store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 100 });
    expect((await first.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.cursor.nextPage).toBe(2);

    const replacementDeps = { ...first.deps, jobs: new InMemoryJobPort() };
    await processHistoricalBackfill(payload, replacementDeps);
    expect(calls).toEqual([1, 2]);
    expect(await first.store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 101 });
    expect((await first.store.getHistoricalProgress(tenantId, repositoryId, "branches"))?.status).toBe("in_progress");

    // The stale page-one physical payload is also an after-commit-before-ack retry.
    await processHistoricalBackfill(payload, replacementDeps);
    expect((await first.store.getHistoricalProgress(tenantId, repositoryId, "tags"))?.status).toBe("in_progress");
    for (let index = 0; index < 10; index += 1) await processHistoricalBackfill(payload, replacementDeps);
    const before = await first.store.getHistoricalSourceCounts(tenantId, repositoryId);
    const callsBefore = calls.length;
    await processHistoricalBackfill(payload, replacementDeps);
    expect(await first.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(before);
    expect(calls).toHaveLength(callsBefore);
    expect((await first.store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.status).toBe("completed");
  });

  it("restarts a traversal when the authoritative head changes and preserves unreachable commits", async () => {
    let head = "C";
    const client = github({
      getRefHead: async () => head,
      listCommits: async ({ sha, page = 1 }) => {
        if (sha === "C" && page === 1) return { commits: [commit("C"), commit("B")], nextPage: 2 };
        if (sha === "Y") return { commits: [commit("Y"), commit("X"), commit("A")] };
        return { commits: [commit("A")] };
      },
    });
    const { store, deps } = await scope(client);
    await processHistoricalBackfill(payload, deps);
    head = "Y";
    await processHistoricalBackfill(payload, deps);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 5 });
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:B`)).toBe(false);
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:C`)).toBe(false);
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:X`)).toBe(true);
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:Y`)).toBe(true);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main"))?.anchorHeadSha).toBe("Y");
  });

  it("converges after a normal fast-forward without losing earlier commits", async () => {
    let head = "C";
    const pages: Array<{ sha: string; page: number }> = [];
    const client = github({
      getRefHead: async () => head,
      listCommits: async ({ sha, page = 1 }) => {
        pages.push({ sha: sha ?? "", page });
        if (sha === "C") return { commits: [commit("C"), commit("B")], nextPage: 2 };
        if (sha === "D") return { commits: [commit("D"), commit("C"), commit("B")] };
        return { commits: [] };
      },
    });
    const { store, deps } = await scope(client);

    await processHistoricalBackfill(payload, deps);
    head = "D";
    await processHistoricalBackfill(payload, deps);

    expect(pages).toEqual([{ sha: "C", page: 1 }, { sha: "D", page: 1 }]);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 3 });
    expect(await store.getBranchHead(tenantId, repositoryId, "main")).toBe("D");
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:B`)).toBe(true);
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:C`)).toBe(true);
    expect(store.commitReachability.get(`${tenantId}:${repositoryId}:main:D`)).toBe(true);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "branches"))?.status).toBe("in_progress");
  });

  it("checkpoints a recent refresh separately while structural pages discover older facts without regression", async () => {
    const updated = new Date("2026-08-22T23:00:00Z");
    const stale = new Date("2026-08-20T00:00:00Z");
    const older = new Date("2020-01-01T00:00:00Z");
    const prCalls: Array<{ page: number | undefined; sort: string | undefined }> = [];
    const client = github({
      listPullRequests: async (input) => {
        prCalls.push({ page: input.page, sort: input.sort });
        if (input.sort === "updated") return { pullRequests: [{ id: 1, number: 1, title: "new-title", state: "closed", baseRef: "main", baseSha: "b", headRef: "topic", headSha: "h", createdAt: older, updatedAt: updated }] };
        if (input.page === 1) return { pullRequests: [{ id: 1, number: 1, title: "stale-title", state: "open", baseRef: "main", baseSha: "b", headRef: "topic", headSha: "h", createdAt: older, updatedAt: stale }], nextPage: 2 };
        return { pullRequests: [{ id: 2, number: 2, title: "old-discovery", state: "open", baseRef: "main", baseSha: "b", headRef: "old", headSha: "o", createdAt: older, updatedAt: older }] };
      },
    });
    const { store, deps } = await scope(client);
    await processHistoricalBackfill(payload, deps); // commits
    await processHistoricalBackfill(payload, deps); // branches
    await processHistoricalBackfill(payload, deps); // tags
    await processHistoricalBackfill(payload, deps); // recent PR checkpoint
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "pull_requests"))?.cursor).toEqual({ nextPage: 1, mode: "structural" });
    await processHistoricalBackfill(payload, deps); // structural page 1
    await processHistoricalBackfill(payload, deps); // structural page 2
    expect(prCalls).toEqual([{ page: 1, sort: "updated" }, { page: 1, sort: undefined }, { page: 2, sort: undefined }]);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ pullRequests: 2 });
    expect(store.historicalPullRequests.get(`${tenantId}:${repositoryId}:1`)).toMatchObject({ title: "new-title", state: "closed", updatedAt: updated });
  });

  it("paginates every non-commit source structurally and deduplicates overlap observations", async () => {
    const sourceTime = new Date("2026-08-22T12:00:00Z");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    const calls = { branches: [] as number[], tags: [] as number[], pulls: [] as string[], issues: [] as string[], releases: [] as string[] };
    const client = github({
      listBranches: async ({ page = 1 }) => {
        calls.branches.push(page);
        return page === 1 ? { branches: [{ name: "main", headSha: "head", protected: true }], nextPage: 2 } : { branches: [{ name: "topic", headSha: "topic", protected: false }] };
      },
      listTags: async ({ page = 1 }) => {
        calls.tags.push(page);
        return page === 1 ? { tags: [{ name: "v2", targetSha: "two" }], nextPage: 2 } : { tags: [{ name: "v1", targetSha: "one" }] };
      },
      listPullRequests: async ({ page = 1, sort }) => {
        calls.pulls.push(`${sort ?? "structural"}:${page}`);
        const first = { id: 1, number: 1, title: "pull one", state: "closed", baseRef: "main", baseSha: "b", headRef: "topic", headSha: "h", createdAt: oldTime, updatedAt: sourceTime };
        if (sort === "updated") return { pullRequests: [first] };
        return page === 1 ? { pullRequests: [first], nextPage: 2 } : { pullRequests: [{ ...first, id: 2, number: 2, title: "pull two", updatedAt: oldTime }] };
      },
      listIssues: async ({ page = 1, sort }) => {
        calls.issues.push(`${sort ?? "structural"}:${page}`);
        const first = { id: 11, number: 11, title: "issue one", state: "closed", createdAt: oldTime, updatedAt: sourceTime };
        if (sort === "updated") return { issues: [first] };
        return page === 1 ? { issues: [first], nextPage: 2 } : { issues: [{ ...first, id: 12, number: 12, title: "issue two", updatedAt: oldTime }] };
      },
      listReleases: async ({ page = 1 }) => {
        const mode = calls.releases.length === 0 ? "overlap" : "structural";
        calls.releases.push(`${mode}:${page}`);
        const first = { id: 21, tagName: "v2", name: "release two", draft: false, prerelease: false, createdAt: sourceTime, publishedAt: sourceTime };
        if (mode === "overlap") return { releases: [first] };
        return page === 1 ? { releases: [first], nextPage: 2 } : { releases: [{ ...first, id: 22, tagName: "v1", name: "release one", createdAt: oldTime, publishedAt: oldTime }] };
      },
    });
    const { store, deps } = await scope(client);

    for (let index = 0; index < 14; index += 1) await processHistoricalBackfill(payload, deps);

    expect(calls.branches).toEqual([1, 2]);
    expect(calls.tags).toEqual([1, 2]);
    expect(calls.pulls).toEqual(["updated:1", "structural:1", "structural:2"]);
    expect(calls.issues).toEqual(["updated:1", "structural:1", "structural:2"]);
    expect(calls.releases).toEqual(["overlap:1", "structural:1", "structural:2"]);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual({ commits: 0, branches: 2, tags: 2, pullRequests: 2, issues: 2, releases: 2 });
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.status).toBe("completed");
  });

  it.each(["branches", "tags", "pull_requests", "issues", "releases"] as const)("covers zero, one, and exact-page boundaries for %s", async (stage) => {
    for (const [mode, expected] of [["zero", 0], ["one", 1], ["exact", 100]] as const) {
      const planned = matrixGithub(stage, mode);
      const { store, deps } = await scope(planned.client);
      await reachStage(stage, store, deps);
      while ((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.status === "in_progress") await processHistoricalBackfill(payload, deps);
      expect(countFor(await store.getHistoricalSourceCounts(tenantId, repositoryId), stage)).toBe(expected);
      expect((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.status).toBe("completed");
      expect(planned.targetCalls()).toBe(stage === "pull_requests" || stage === "issues" || stage === "releases" ? 2 : 1);
    }
  });

  it.each(["branches", "tags", "pull_requests", "issues", "releases"] as const)("handles page-N failure, replacement resume, duplicates, mutation, empty final, and completed rerun for %s", async (stage) => {
    const planned = matrixGithub(stage, "multi");
    const { store, deps } = await scope(planned.client);
    await reachStage(stage, store, deps);
    if (stage === "pull_requests" || stage === "issues" || stage === "releases") await processHistoricalBackfill(payload, deps); // supplemental overlap
    await processHistoricalBackfill(payload, deps); // exact 100-item structural page
    expect(countFor(await store.getHistoricalSourceCounts(tenantId, repositoryId), stage)).toBe(100);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.cursor.nextPage).toBe(2);

    await expect(processHistoricalBackfill(payload, deps)).rejects.toThrow("page_n_failure");
    expect((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.cursor.nextPage).toBe(2);
    expect(countFor(await store.getHistoricalSourceCounts(tenantId, repositoryId), stage)).toBe(100);

    const replacement = { ...deps, jobs: new InMemoryJobPort() };
    await processHistoricalBackfill(payload, replacement);
    expect(planned.pageTwoAttempts()).toBe(2);
    expect(countFor(await store.getHistoricalSourceCounts(tenantId, repositoryId), stage)).toBe(101);
    expectMutation(stage, store);
    await processHistoricalBackfill(payload, replacement); // explicit empty final page
    expect((await store.getHistoricalProgress(tenantId, repositoryId, stage))?.status).toBe("completed");

    await finishBackfill(store, replacement);
    const completedCounts = await store.getHistoricalSourceCounts(tenantId, repositoryId);
    await processHistoricalBackfill(payload, replacement);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(completedCounts);
    expect((await store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.status).toBe("completed");
  });

  it("pauses rate-limited work without advancing and gates access failures behind inventory", async () => {
    const resumeAt = new Date("2026-08-23T01:00:00Z");
    let mode: "rate" | "access" | "ok" = "rate";
    let now = new Date("2026-08-23T00:00:00Z");
    let requests = 0;
    const client = github({
      getRefHead: async () => {
        requests += 1;
        if (mode === "rate") throw new GithubRateLimitPauseError("primary_rate_limit", 403, resumeAt);
        if (mode === "access") throw new GithubAccessError("not_found", 404);
        return "head";
      },
    });
    const { store, jobs, deps, capture } = await scope(client, () => now);
    const activePositionKey = historicalBackfillLogicalKey(repositoryId, "default_branch_commits", 1);
    await jobs.enqueue("repository_backfill", activePositionKey, payload);
    await processHistoricalBackfill(payload, deps);
    let progress = await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    expect(progress).toMatchObject({ status: "paused", cursor: { nextPage: 1 }, pausedUntil: resumeAt, errorCode: "github_primary_rate_limit" });
    expect([...jobs.jobs.values()].some((job) => job.logicalKey === `${activePositionKey}:wake:${resumeAt.getTime()}`)).toBe(true);
    await processHistoricalBackfill(payload, deps);
    expect(requests).toBe(1);

    now = resumeAt;
    mode = "access";
    await processHistoricalBackfill(payload, deps);
    progress = await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    expect(progress).toMatchObject({ status: "paused", cursor: { nextPage: 1 }, errorCode: "github_not_found" });
    expect([...jobs.jobs.values()].some((job) => job.kind === "installation_inventory")).toBe(true);
    await processHistoricalBackfill(payload, deps);
    expect(requests).toBe(2);
    expect(JSON.stringify([...jobs.jobs.values()])).not.toMatch(/private-repository|private-owner/);
    expect(capture.text()).not.toContain("private-repository");
    expect(capture.text()).not.toContain("private-owner");
  });
});
