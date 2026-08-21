import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import type { GithubClient } from "@devmemoir/github";
import { synchronizeRefHead } from "./sync.js";

const repository = { id: "repo-1", tenantId: "tenant-1", installationId: "inst-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" };
const github: GithubClient = {
  getUser: async () => ({ id: 1, login: "owner", type: "User" }),
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  getInstallation: async () => ({ id: 99, account: { id: 1, login: "owner", type: "User" } }),
  listInstallationRepositories: async () => ({ repositories: [] }),
  getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
  listCommits: async ({ page }) => page === 1 ? { commits: [{ repositoryId: "", sha: "b".repeat(40), author: { githubAccountId: 1, actorKind: "user" }, committer: { githubAccountId: 1, actorKind: "user" }, message: "authoritative", parents: [] }] } : { commits: [] },
  getCommit: async () => ({ repositoryId: "", sha: "b".repeat(40), message: "authoritative", parents: [] }),
  getRefHead: async () => "b".repeat(40),
};

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
});
