import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "./store.js";

async function seededProjectionStore() {
  const store = new InMemoryM1Store();
  await store.saveInstallation({ id: "installation-a", tenantId: "tenant-a", githubInstallationId: 101, accountGithubAccountId: 7 });
  await store.saveRepository({ id: "repo-a", tenantId: "tenant-a", installationId: "installation-a", githubRepositoryId: 501, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
  await store.saveCommit("tenant-a", "repo-a", { repositoryId: "repo-a", sha: "sha-a", author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 9, actorKind: "user" }, message: "commit", authoredAt: new Date("2026-01-01T00:00:00Z"), committedAt: new Date("2026-01-01T00:01:00Z"), parents: [] }, "https://github.example/commit/sha-a");
  store.historicalPullRequests.set("tenant-a:repo-a:12", {
    githubId: 12,
    number: 12,
    title: "Feature",
    state: "closed",
    draft: false,
    author: { githubAccountId: 7, actorKind: "user" },
    merger: { githubAccountId: 9, actorKind: "user" },
    createdAt: new Date("2026-01-02T00:00:00Z"),
    updatedAt: new Date("2026-01-02T01:00:00Z"),
    closedAt: new Date("2026-01-02T01:00:00Z"),
    mergedAt: new Date("2026-01-02T00:59:00Z"),
  });
  return store;
}

describe("canonical repository reprojection", () => {
  it("is deterministic, idempotent, and preserves source facts", async () => {
    const store = await seededProjectionStore();
    const first = await store.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    const firstFacts = store.events.map(({ id: _id, ...event }) => event);
    const second = await store.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    const secondFacts = store.events.map(({ id: _id, ...event }) => event);
    expect(first).toEqual(second);
    expect(firstFacts).toEqual(secondFacts);
    expect(new Set(store.events.map((event) => event.logicalEventKey)).size).toBe(store.events.length);
    expect(store.commits.size).toBe(1);
  });

  it("rolls back the visible projection after an injected failure", async () => {
    const store = await seededProjectionStore();
    await store.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    const before = store.events.map((event) => ({ ...event }));
    const sourceCount = store.commits.size;
    await expect(store.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7, failureAfterEvents: 1 })).rejects.toThrow("projection_injected_failure");
    expect(store.events).toEqual(before);
    expect(store.commits.size).toBe(sourceCount);
  });

  it("converges incremental source updates with a clean full projection", async () => {
    const incremental = await seededProjectionStore();
    await incremental.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    await incremental.saveCommit("tenant-a", "repo-a", { repositoryId: "repo-a", sha: "sha-b", author: { githubAccountId: 7, actorKind: "user" }, message: "second", committedAt: new Date("2026-01-03T00:00:00Z"), parents: ["sha-a"] });
    await incremental.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    const incrementalRows = incremental.events.map(({ id: _id, ...event }) => event);

    const clean = await seededProjectionStore();
    await clean.saveCommit("tenant-a", "repo-a", { repositoryId: "repo-a", sha: "sha-b", author: { githubAccountId: 7, actorKind: "user" }, message: "second", committedAt: new Date("2026-01-03T00:00:00Z"), parents: ["sha-a"] });
    await clean.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    const cleanRows = clean.events.map(({ id: _id, ...event }) => event);
    expect(incrementalRows).toEqual(cleanRows);
  });

  it("keeps an observed commit event queryable after reachability changes", async () => {
    const store = await seededProjectionStore();
    await store.reprojectRepository({ tenantId: "tenant-a", repositoryId: "repo-a", ownerGithubAccountId: 7 });
    await store.setCommitReachability("tenant-a", "repo-a", "main", "sha-a", false);
    expect((await store.listActivity("tenant-a", "repo-a", { context: "default", includeBots: true })).some((event) => event.sourceExternalId === "sha-a")).toBe(true);
  });
});
