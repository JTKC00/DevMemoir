import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import type { GithubClient, GithubCommit } from "@devmemoir/github";
import { synchronizeRefHead } from "./sync.js";
import { emptyHistoricalGithubMethods } from "./test-github.js";

const repository = { id: "repo-1", tenantId: "tenant-1", installationId: "inst-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" };
const github: GithubClient = {
  ...emptyHistoricalGithubMethods,
  getUser: async () => ({ id: 1, login: "owner", type: "User" }),
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  getInstallation: async () => ({ id: 99, account: { id: 1, login: "owner", type: "User" } }),
  listInstallationRepositories: async () => ({ repositories: [] }),
  getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
  listCommits: async ({ page }) => page === 1 ? { commits: [{ repositoryId: "", sha: "b".repeat(40), author: { githubAccountId: 1, actorKind: "user" }, committer: { githubAccountId: 1, actorKind: "user" }, message: "authoritative", parents: [] }] } : { commits: [] },
  getCommit: async () => ({ repositoryId: "", sha: "b".repeat(40), message: "authoritative", parents: [] }),
  getRefHead: async () => "b".repeat(40),
};

function commit(sha: string, actor = 1) {
  return { repositoryId: "", sha, author: { githubAccountId: actor, actorKind: "user" as const }, committer: { githubAccountId: actor, actorKind: "user" as const }, message: sha, parents: [] };
}

function githubPages(pages: Record<number, { commits: GithubCommit[]; nextPage?: number }>): GithubClient {
  return { ...github, listCommits: async ({ page = 1 }) => pages[page] ?? { commits: [] } };
}

describe("authoritative ref-head sync", () => {
  it("uses API commits and is idempotent for the same head", async () => {
    const store = new InMemoryM1Store();
    const input = { tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "refs/heads/main", before: "0".repeat(40), after: "b".repeat(40), forced: false };
    const first = await synchronizeRefHead(input, github, store);
    const second = await synchronizeRefHead(input, github, store);
    expect(first.importedCommits).toBe(1);
    expect(second.status).toBe("no-op");
    expect(store.commits.size).toBe(1);
  });

  it("does not invent history for branch deletion", async () => {
    const store = new InMemoryM1Store();
    const result = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "refs/heads/feature", before: "b".repeat(40), after: "0".repeat(40), forced: false }, github, store);
    expect(result.status).toBe("deleted");
    expect(store.commits.size).toBe(0);
  });

  it("imports only the newest 100 commits on first connection", async () => {
    const store = new InMemoryM1Store();
    const commits = Array.from({ length: 101 }, (_, index) => commit(`initial-${index}`));
    const result = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "refs/heads/main", before: "0".repeat(40), after: "head-initial", forced: false }, githubPages({ 1: { commits: commits.slice(0, 100), nextPage: 2 }, 2: { commits: commits.slice(100) } }), store);
    expect(result.status).toBe("synced");
    expect(store.commits.size).toBe(100);
  });

  it("walks beyond the first page until an existing head is found", async () => {
    const store = new InMemoryM1Store();
    const oldHead = commit("old-head");
    await store.saveCommit("tenant-1", repository.id, oldHead);
    await store.setBranchHead("tenant-1", repository.id, "refs/heads/main", oldHead.sha);
    const calls: number[] = [];
    const pages = githubPages({
      1: { commits: Array.from({ length: 100 }, (_, index) => commit(`new-${index}`)), nextPage: 2 },
      2: { commits: [oldHead] },
    });
    const result = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "refs/heads/main", before: oldHead.sha, after: "new-head", forced: false }, { ...pages, listCommits: async (input) => { calls.push(input.page ?? 1); return pages.listCommits(input); } }, store);
    expect(calls).toEqual([1, 2]);
    expect(result.importedCommits).toBe(101);
    expect(await store.getBranchHead("tenant-1", repository.id, "main")).toBe("new-head");
  });

  it("persists a continuation and resumes it after a bounded run", async () => {
    const store = new InMemoryM1Store();
    const oldHead = commit("resume-old");
    await store.saveCommit("tenant-1", repository.id, oldHead);
    await store.setBranchHead("tenant-1", repository.id, "main", oldHead.sha);
    const pages = githubPages({ 1: { commits: [commit("resume-new")], nextPage: 2 }, 2: { commits: [oldHead] } });
    const first = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "main", before: oldHead.sha, after: "resume-head", forced: false, maxPages: 1 }, pages, store);
    expect(first.status).toBe("partial");
    expect(await store.getBranchHead("tenant-1", repository.id, "main")).toBe(oldHead.sha);
    const second = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "main", before: oldHead.sha, after: "resume-head", forced: false, maxPages: 1 }, pages, store);
    expect(second.status).toBe("synced");
    expect(await store.getRefSyncContinuation("tenant-1", repository.id, "main")).toBeUndefined();
  });

  it("retains a ghost source commit when no event can be projected", async () => {
    const store = new InMemoryM1Store();
    const ghost = { repositoryId: "", sha: "ghost", message: "ghost commit", parents: [] };
    const result = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "main", before: "0", after: "ghost-head", forced: false }, githubPages({ 1: { commits: [ghost] }}), store);
    expect(result.status).toBe("synced");
    expect(store.commits.size).toBe(1);
    expect(store.events).toHaveLength(0);
  });

  it("marks old refs unreachable after divergence while preserving source rows", async () => {
    const store = new InMemoryM1Store();
    const oldHead = commit("diverged-old");
    const newHead = commit("diverged-new");
    await store.saveCommit("tenant-1", repository.id, oldHead);
    await store.setBranchHead("tenant-1", repository.id, "main", oldHead.sha);
    await store.setCommitReachability("tenant-1", repository.id, "main", oldHead.sha, true);
    const result = await synchronizeRefHead({ tenantId: "tenant-1", repository, installationId: 99, ownerGithubAccountId: 1, ref: "main", before: oldHead.sha, after: newHead.sha, forced: true }, githubPages({ 1: { commits: [newHead] } }), store);
    expect(result.status).toBe("synced");
    expect(store.commits.has("tenant-1:repo-1:diverged-old")).toBe(true);
    expect(store.commitReachability.get("tenant-1:repo-1:main:diverged-old")).toBe(false);
    expect(store.commitReachability.get("tenant-1:repo-1:main:diverged-new")).toBe(true);
  });
});
