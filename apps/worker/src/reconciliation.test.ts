import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import { GithubRateLimitPauseError, type GithubClient } from "@devmemoir/github";
import { InMemoryJobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { enqueueRepositoryReconciliation, processRepositoryReconciliation, type ReconciliationDependencies } from "./reconciliation.js";

const tenantId = "tenant-reconcile";
const repositoryId = "repository-reconcile";
const installationId = "installation-reconcile";
const installationGithubId = 8801;
const reconciliationRunId = "00000000-0000-4000-8000-000000000001";
const privateOwner = "PRIVATE_OWNER_CANARY";
const privateRepository = "PRIVATE_REPOSITORY_CANARY";
const privateTitle = "PRIVATE_TITLE_CANARY";

function authoritativeGithub(overrides: Partial<GithubClient> = {}): GithubClient {
  const sourceTime = new Date("2026-08-28T01:00:00Z");
  return {
    getUser: async () => ({ id: 7, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "unused" }),
    getInstallation: async () => ({ id: installationGithubId, account: { id: 7, login: "owner", type: "User" } }),
    listInstallationRepositories: async () => ({ repositories: [{ id: 991, name: privateRepository, full_name: `${privateOwner}/${privateRepository}`, private: true, default_branch: "main", owner: { id: 7, login: privateOwner, type: "User" } }] }),
    getRepository: async () => ({ id: 991, name: privateRepository, full_name: `${privateOwner}/${privateRepository}`, private: true, default_branch: "main" }),
    listCommits: async () => ({ commits: [] }),
    getCommit: async () => ({ repositoryId, sha: "head", message: "PRIVATE_COMMIT_CANARY", committedAt: sourceTime, parents: [] }),
    getRefHead: async () => "head",
    listBranches: async () => ({ branches: [{ name: "main", headSha: "head", protected: true }] }),
    listTags: async () => ({ tags: [] }),
    listPullRequests: async () => ({ pullRequests: [{ id: 41, number: 41, title: privateTitle, state: "closed", author: { githubAccountId: 7, actorKind: "user" }, mergedBy: { githubAccountId: 7, actorKind: "user" }, baseRef: "main", baseSha: "base", headRef: "topic", headSha: "topic-head", createdAt: sourceTime, updatedAt: sourceTime, closedAt: sourceTime, mergedAt: sourceTime }] }),
    listIssues: async () => ({ issues: [] }),
    listReleases: async () => ({ releases: [] }),
    ...overrides,
  };
}

async function setup(client: GithubClient, now = () => new Date("2026-08-28T02:00:00Z")) {
  const store = new InMemoryM1Store();
  const jobs = new InMemoryJobPort();
  const capture = createCanarySink();
  await store.upsertUser({ userId: "user-reconcile", tenantId, githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: 7 });
  await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: 991, ownerLogin: privateOwner, name: privateRepository, fullName: `${privateOwner}/${privateRepository}`, private: true, defaultBranch: "main" });
  const deps: ReconciliationDependencies = { store, jobs, githubForInstallation: () => client, logger: createLogger(capture.sink), ownerGithubAccountId: 7, now };
  const coordinator: SyncJobPayload = { kind: "repository_reconciliation", tenantId, repositoryId, installationId: installationGithubId, reconciliationRunId };
  return { store, jobs, capture, deps, coordinator };
}

async function finish(scope: Awaited<ReturnType<typeof setup>>, payload = scope.coordinator): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if ((await scope.store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.status === "completed") return;
    await processRepositoryReconciliation({ ...payload, stage: "default_branch_commits" }, scope.deps);
  }
  throw new Error("reconciliation_did_not_complete");
}

describe("M5.1 active repository reconciliation", () => {
  it("repairs a missed supported webhook, reprojects deterministically, and replays without duplicates or private queue/log content", async () => {
    const scope = await setup(authoritativeGithub());
    expect(await enqueueRepositoryReconciliation({ tenantId, repositoryId, installationGithubId, reconciliationRunId }, scope)).toBe(true);
    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    await finish(scope);

    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ pullRequests: 1 });
    expect(scope.store.events.filter((event) => event.sourceKind === "pull_request").map((event) => event.verb).sort()).toEqual(["closed", "merged", "opened"]);
    const sourceCounts = await scope.store.getHistoricalSourceCounts(tenantId, repositoryId);
    const eventKeys = scope.store.events.map((event) => event.logicalEventKey);

    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    await processRepositoryReconciliation({ ...scope.coordinator, stage: "pull_requests" }, scope.deps);
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(sourceCounts);
    expect(scope.store.events.map((event) => event.logicalEventKey)).toEqual(eventKeys);
    expect(new Set(eventKeys).size).toBe(eventKeys.length);

    const operationalText = `${JSON.stringify([...scope.jobs.jobs.values()])}\n${scope.capture.text()}`;
    expect(operationalText).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPOSITORY_CANARY|PRIVATE_TITLE_CANARY|PRIVATE_COMMIT_CANARY/);
    for (const job of scope.jobs.jobs.values()) {
      expect(Object.keys(job.payload as object).sort()).toEqual(expect.arrayContaining(["installationId", "kind", "reconciliationRunId", "repositoryId", "tenantId"]));
      expect(job.payload).not.toHaveProperty("owner");
      expect(job.payload).not.toHaveProperty("repo");
      expect(job.payload).not.toHaveProperty("ref");
      expect(job.payload).not.toHaveProperty("anchorHeadSha");
    }
  });

  it("resumes safely after an interrupted page and after an already-committed page retry", async () => {
    let structuralPullAttempts = 0;
    const base = authoritativeGithub();
    const client = authoritativeGithub({
      listPullRequests: async (input) => {
        if (input.sort !== "updated") {
          structuralPullAttempts += 1;
          if (structuralPullAttempts === 1) throw new Error("PRIVATE_PAGE_FAILURE_CANARY");
        }
        return base.listPullRequests(input);
      },
    });
    const scope = await setup(client);
    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    for (let index = 0; index < 4; index += 1) await processRepositoryReconciliation({ ...scope.coordinator, stage: "default_branch_commits" }, scope.deps);
    const before = await scope.store.getHistoricalProgress(tenantId, repositoryId, "pull_requests");
    expect(before?.cursor).toMatchObject({ nextPage: 1, mode: "structural", reconciliationRunId });
    await expect(processRepositoryReconciliation({ ...scope.coordinator, stage: "pull_requests" }, scope.deps)).rejects.toThrow("PRIVATE_PAGE_FAILURE_CANARY");
    expect((await scope.store.getHistoricalProgress(tenantId, repositoryId, "pull_requests"))?.cursor).toEqual(before?.cursor);

    const restarted = { ...scope, deps: { ...scope.deps, jobs: new InMemoryJobPort() } };
    await processRepositoryReconciliation({ ...scope.coordinator, stage: "pull_requests" }, restarted.deps);
    const countsAfterCommit = await scope.store.getHistoricalSourceCounts(tenantId, repositoryId);
    await processRepositoryReconciliation({ ...scope.coordinator, stage: "pull_requests" }, restarted.deps);
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(countsAfterCommit);
    await finish(restarted);
    expect((await scope.store.getHistoricalProgress(tenantId, repositoryId, "completed"))?.cursor.reconciliationRunId).toBe(reconciliationRunId);
  });

  it("does not advance source or cursor state across a durable rate-limit pause", async () => {
    const resumeAt = new Date("2026-08-28T03:00:00Z");
    let now = new Date("2026-08-28T02:00:00Z");
    let requests = 0;
    const client = authoritativeGithub({
      getInstallation: async () => {
        requests += 1;
        throw new GithubRateLimitPauseError("primary_rate_limit", 403, resumeAt);
      },
    });
    const scope = await setup(client, () => now);
    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    expect(await scope.store.listHistoricalProgress(tenantId, repositoryId)).toEqual([]);
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual({ commits: 0, branches: 0, tags: 0, pullRequests: 0, issues: 0, releases: 0 });
    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    expect(requests).toBe(1);
    expect([...scope.jobs.jobs.values()].some((job) => job.logicalKey.endsWith(`:wake:${resumeAt.getTime()}`))).toBe(true);
    now = resumeAt;
  });

  it("does not reset commit reachability or its checkpoint when the authoritative page is rate limited", async () => {
    const resumeAt = new Date("2026-08-28T03:00:00Z");
    let commitPageRequests = 0;
    const client = authoritativeGithub({
      getRefHead: async () => "new-head",
      listCommits: async () => {
        commitPageRequests += 1;
        throw new GithubRateLimitPauseError("secondary_rate_limit", 429, resumeAt);
      },
    });
    const scope = await setup(client);
    await scope.store.saveCommit(tenantId, repositoryId, { repositoryId, sha: "old-head", message: "existing", parents: [] });
    await scope.store.setBranchHead(tenantId, repositoryId, "main", "old-head");
    await scope.store.setCommitReachability(tenantId, repositoryId, "main", "old-head", true);
    await processRepositoryReconciliation(scope.coordinator, scope.deps);
    const before = await scope.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");

    await processRepositoryReconciliation({ ...scope.coordinator, stage: "default_branch_commits" }, scope.deps);
    const paused = await scope.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    expect(paused).toMatchObject({ status: "paused", pausedUntil: resumeAt, errorCode: "github_secondary_rate_limit" });
    expect(paused?.cursor).toEqual(before?.cursor);
    expect(paused?.anchorHeadSha).toBeUndefined();
    expect(scope.store.commitReachability.get(`${tenantId}:${repositoryId}:main:old-head`)).toBe(true);
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 1 });
    await processRepositoryReconciliation({ ...scope.coordinator, stage: "default_branch_commits" }, scope.deps);
    expect(commitPageRequests).toBe(1);
  });

  it("gates inactive, inaccessible, and unselected repository work before GitHub access", async () => {
    for (const state of ["unselected", "inaccessible", "suspended"] as const) {
      let requests = 0;
      const scope = await setup(authoritativeGithub({ getInstallation: async () => { requests += 1; throw new Error("must_not_request"); } }));
      if (state === "unselected") await scope.store.unselectRepository(tenantId, repositoryId);
      if (state === "inaccessible") {
        const repository = await scope.store.getRepositoryById(tenantId, repositoryId);
        if (repository) scope.store.repositories.set(`${tenantId}:991`, { ...repository, accessStatus: "access_removed", selected: false });
      }
      if (state === "suspended") await scope.store.updateInstallationLifecycle(installationGithubId, "suspended", new Date("2026-08-28T02:00:00Z"));
      expect(await enqueueRepositoryReconciliation({ tenantId, repositoryId, installationGithubId, reconciliationRunId }, scope)).toBe(false);
      await processRepositoryReconciliation(scope.coordinator, scope.deps);
      expect(requests).toBe(0);
      expect(await scope.store.listHistoricalProgress(tenantId, repositoryId)).toEqual([]);
    }
  });

  it("does not let a delayed older coordinator or page job reset a newer generation", async () => {
    const runA = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const runB = "00000000-0000-4000-8000-0000000000bb";
    expect(runA > runB).toBe(true);
    let inventoryRequests = 0;
    let commitPageRequests = 0;
    const client = authoritativeGithub({
      listInstallationRepositories: async () => {
        inventoryRequests += 1;
        return {
          repositories: [{ id: 991, name: privateRepository, full_name: `${privateOwner}/${privateRepository}`, private: true, default_branch: "main", owner: { id: 7, login: privateOwner, type: "User" } }],
        };
      },
      listCommits: async () => {
        commitPageRequests += 1;
        return { commits: [{ repositoryId, sha: `head-${commitPageRequests}`, message: "PRIVATE_COMMIT_CANARY", committedAt: new Date("2026-08-28T01:00:00Z"), parents: [] }], nextPage: 2 };
      },
    });
    const scope = await setup(client);
    const coordinatorA = { ...scope.coordinator, reconciliationRunId: runA };
    const coordinatorB = { ...scope.coordinator, reconciliationRunId: runB };

    await processRepositoryReconciliation(coordinatorA, scope.deps);
    await processRepositoryReconciliation({ ...coordinatorA, stage: "default_branch_commits" }, scope.deps);
    expect((await scope.store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId))?.reconciliationRunId).toBe(runA);

    await processRepositoryReconciliation(coordinatorB, scope.deps);
    await processRepositoryReconciliation({ ...coordinatorB, stage: "default_branch_commits" }, scope.deps);
    const currentB = await scope.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    const countsB = await scope.store.getHistoricalSourceCounts(tenantId, repositoryId);
    const eventKeysB = scope.store.events.map((event) => event.logicalEventKey);
    const generationB = await scope.store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId);
    expect(generationB).toMatchObject({ reconciliationRunId: runB, current: true, generation: 2 });
    const inventoryAfterB = inventoryRequests;
    const pagesAfterB = commitPageRequests;

    await processRepositoryReconciliation(coordinatorA, scope.deps);
    await processRepositoryReconciliation({ ...coordinatorA, stage: "default_branch_commits" }, scope.deps);
    expect(inventoryRequests).toBe(inventoryAfterB);
    expect(commitPageRequests).toBe(pagesAfterB);
    expect(await scope.store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId)).toMatchObject({ reconciliationRunId: runB, current: true, generation: 2 });
    expect(await scope.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main")).toEqual(currentB);
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(countsB);
    expect(scope.store.events.map((event) => event.logicalEventKey)).toEqual(eventKeysB);
    expect(new Set(eventKeysB).size).toBe(eventKeysB.length);

    await processRepositoryReconciliation(coordinatorB, scope.deps);
    expect(await scope.store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main")).toEqual(currentB);
    expect(await scope.store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runB, now: new Date("2026-08-28T02:10:00Z") })).toMatchObject({ cursor: { nextPage: currentB?.nextPage, reconciliationRunId: runB } });
    expect(await scope.store.getHistoricalSourceCounts(tenantId, repositoryId)).toEqual(countsB);
    expect(new Set(scope.store.events.map((event) => event.logicalEventKey)).size).toBe(scope.store.events.length);
  });
});
