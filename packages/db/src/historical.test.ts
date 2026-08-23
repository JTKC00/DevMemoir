import { describe, expect, it } from "vitest";
import { InMemoryM1Store, type HistoricalCursor, type HistoricalPageCommit, type RepositoryRecord } from "./store.js";

async function selectedStore(tenantId = "tenant-a", repositoryId = "repo-a", installationId = "installation-a") {
  const store = new InMemoryM1Store();
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: tenantId === "tenant-a" ? 101 : 202, accountGithubAccountId: tenantId === "tenant-a" ? 1001 : 2002 });
  const repository: RepositoryRecord = { id: repositoryId, tenantId, installationId, githubRepositoryId: tenantId === "tenant-a" ? 501 : 502, ownerLogin: "owner", name: repositoryId, fullName: `owner/${repositoryId}`, private: true, defaultBranch: "main" };
  await store.saveRepository(repository);
  return { store, repository };
}

async function initialize(store: InMemoryM1Store, tenantId: string, repositoryId: string, installationId: string, now = new Date("2026-01-01T00:00:00Z")) {
  await store.startHistoricalBackfill({ tenantId, repositoryId, installationId, defaultBranch: "main", now });
  const reset = await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "head-a", now });
  if (!reset) throw new Error("reset failed");
  return reset;
}

type EmptyPageBase = { tenantId: string; repositoryId: string; installationId: string; observedAt: Date } & (
  | { stage: "default_branch_commits"; refName: string; anchorHeadSha: string }
  | { stage: "branches" | "tags" | "pull_requests" | "issues" | "releases" }
);

async function commitEmptyPage(store: InMemoryM1Store, base: EmptyPageBase, expectedCursor: HistoricalCursor) {
  return store.commitHistoricalPage({ ...base, expectedCursor, nextCursor: { nextPage: expectedCursor.nextPage + 1 }, facts: [], finalPage: true } as HistoricalPageCommit);
}

describe("M3 historical persistence", () => {
  it("keeps stable commit identity and does not double-advance an after-commit retry", async () => {
    const { store, repository } = await selectedStore();
    const progress = await initialize(store, "tenant-a", repository.id, "installation-a");
    const page: HistoricalPageCommit = {
      tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "default_branch_commits", refName: "main", anchorHeadSha: "head-a",
      expectedCursor: progress.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:01:00Z"), finalPage: false,
      facts: [{ commit: { repositoryId: repository.id, sha: "sha-1", message: "message", parents: [] } }],
    };
    expect((await store.commitHistoricalPage(page)).applied).toBe(true);
    const retry = await store.commitHistoricalPage(page);
    expect(retry).toMatchObject({ applied: false, reason: "checkpoint_mismatch", progress: { nextPage: 2 } });
    expect(await store.getHistoricalSourceCounts("tenant-a", repository.id)).toMatchObject({ commits: 1 });
  });

  it("never shortens a later durable installation pause", async () => {
    const { store } = await selectedStore();
    const later = new Date("2026-01-01T01:00:00Z");
    const earlier = new Date("2026-01-01T00:30:00Z");
    await store.pauseInstallationApi({ tenantId: "tenant-a", installationId: "installation-a", pausedUntil: later, reason: "github_primary_rate_limit" });
    await store.pauseInstallationApi({ tenantId: "tenant-a", installationId: "installation-a", pausedUntil: earlier, reason: "github_retry_after" });
    expect(store.installations.get(101)).toMatchObject({ apiPausedUntil: later, apiPauseReason: "github_primary_rate_limit" });
  });

  it("does not regress mutable metadata from an older source timestamp", async () => {
    const { store, repository } = await selectedStore();
    const commits = await initialize(store, "tenant-a", repository.id, "installation-a");
    const commitDone = await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "default_branch_commits", refName: "main", anchorHeadSha: "head-a", observedAt: new Date("2026-01-01T00:01:00Z") }, commits.cursor);
    const branches = await store.getHistoricalProgress("tenant-a", repository.id, "branches");
    if (!branches) throw new Error("branches missing");
    await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "branches", observedAt: new Date("2026-01-01T00:02:00Z") }, branches.cursor);
    const tags = await store.getHistoricalProgress("tenant-a", repository.id, "tags");
    if (!tags || !commitDone.applied) throw new Error("tags missing");
    await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "tags", observedAt: new Date("2026-01-01T00:03:00Z") }, tags.cursor);
    const pulls = await store.getHistoricalProgress("tenant-a", repository.id, "pull_requests");
    if (!pulls) throw new Error("pulls missing");
    const newer = { githubId: 99, number: 7, title: "new", state: "closed", draft: false, createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:10:00Z") };
    const first = await store.commitHistoricalPage({ tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "pull_requests", expectedCursor: pulls.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:11:00Z"), finalPage: false, facts: [newer] });
    const older = { ...newer, title: "old", state: "open", updatedAt: new Date("2026-01-01T00:05:00Z") };
    await store.commitHistoricalPage({ tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "pull_requests", expectedCursor: first.progress.cursor, nextCursor: { nextPage: 3 }, observedAt: new Date("2026-01-01T00:12:00Z"), finalPage: false, facts: [older] });
    expect(store.historicalPullRequests.get(`tenant-a:${repository.id}:99`)).toMatchObject({ title: "new", state: "closed" });
    expect(await store.getHistoricalSourceCounts("tenant-a", repository.id)).toMatchObject({ pullRequests: 1 });

    const pullProgress = await store.getHistoricalProgress("tenant-a", repository.id, "pull_requests");
    if (!pullProgress) throw new Error("pull progress missing");
    await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "pull_requests", observedAt: new Date("2026-01-01T00:13:00Z") }, pullProgress.cursor);
    const issues = await store.getHistoricalProgress("tenant-a", repository.id, "issues");
    if (!issues) throw new Error("issue progress missing");
    await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "issues", observedAt: new Date("2026-01-01T00:14:00Z") }, issues.cursor);
    const releases = await store.getHistoricalProgress("tenant-a", repository.id, "releases");
    if (!releases) throw new Error("release progress missing");
    const releaseTimestamp = new Date("2026-01-01T00:15:00Z");
    const release = { githubId: 501, tagName: "v1", name: "new release", draft: false, prerelease: false, createdAt: releaseTimestamp, updatedAt: releaseTimestamp };
    const releaseFirst = await store.commitHistoricalPage({ tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "releases", expectedCursor: releases.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:16:00Z"), finalPage: false, facts: [release] });
    await store.commitHistoricalPage({ tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "releases", expectedCursor: releaseFirst.progress.cursor, nextCursor: { nextPage: 3 }, observedAt: new Date("2026-01-01T00:17:00Z"), finalPage: false, facts: [{ ...release, name: "equal-clock stale release" }] });
    expect(store.historicalReleases.get(`tenant-a:${repository.id}:501`)).toMatchObject({ name: "new release" });
  });

  it("scopes final branch generation tombstones to one tenant and repository", async () => {
    const { store, repository } = await selectedStore();
    const otherInstallationId = "installation-b";
    await store.saveInstallation({ id: otherInstallationId, tenantId: "tenant-b", githubInstallationId: 202, accountGithubAccountId: 2002 });
    await store.saveRepository({ id: "repo-b", tenantId: "tenant-b", installationId: otherInstallationId, githubRepositoryId: 502, ownerLogin: "owner", name: "repo-b", fullName: "owner/repo-b", private: true, defaultBranch: "main" });
    const commits = await initialize(store, "tenant-a", repository.id, "installation-a");
    await commitEmptyPage(store, { tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "default_branch_commits", refName: "main", anchorHeadSha: "head-a", observedAt: new Date("2026-01-02T00:00:00Z") }, commits.cursor);
    store.historicalBranches.set("tenant-b:repo-b:keep", { name: "keep", headSha: "b", protected: false, reachable: true, generation: new Date("2025-01-01T00:00:00Z") });
    const branches = await store.getHistoricalProgress("tenant-a", repository.id, "branches");
    if (!branches) throw new Error("branches missing");
    await store.commitHistoricalPage({ tenantId: "tenant-a", repositoryId: repository.id, installationId: "installation-a", stage: "branches", expectedCursor: branches.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-02T00:01:00Z"), finalPage: true, facts: [] });
    expect(store.historicalBranches.get("tenant-b:repo-b:keep")?.reachable).toBe(true);
  });
});
