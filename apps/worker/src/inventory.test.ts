import { describe, expect, it } from "vitest";
import type { GithubClient, GithubRepository } from "@devmemoir/github";
import { InMemoryM1Store } from "@devmemoir/db";
import { refreshInstallationInventory } from "./inventory.js";

const tenantId = "tenant-inventory";
const installationId = 7001;
const observedAt = new Date("2026-08-21T10:00:00Z");

function repository(id: number, name = `repo-${id}`, overrides: Partial<GithubRepository> = {}): GithubRepository {
  return {
    id,
    name,
    full_name: `owner/${name}`,
    private: true,
    visibility: "private",
    default_branch: "main",
    owner: { login: "owner" },
    ...overrides,
  };
}

function githubPages(pages: Record<number, { repositories: GithubRepository[]; nextPage?: number }>, onPageError?: number): GithubClient {
  return {
    getUser: async () => ({ id: 7, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "unused" }),
    getInstallation: async () => ({ id: installationId, account: { id: 7, login: "owner", type: "User" }, permissions: { Metadata: "read" }, repository_selection: "selected" }),
    listInstallationRepositories: async (page) => {
      if (page === onPageError) throw new Error(`page-${page}-failed`);
      return pages[page] ?? { repositories: [] };
    },
    getRepository: async () => repository(1),
    listCommits: async () => ({ commits: [] }),
    getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
    getRefHead: async () => "a".repeat(40),
  };
}

async function storeWithInstallation(): Promise<InMemoryM1Store> {
  const store = new InMemoryM1Store();
  await store.upsertUser({ userId: "user-inventory", tenantId, githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: "installation-inventory", tenantId, githubInstallationId: installationId, accountGithubAccountId: 7 });
  return store;
}

describe("authoritative installation repository inventory", () => {
  it("handles an empty inventory and does not treat a missing page as success", async () => {
    const store = await storeWithInstallation();
    await store.saveRepository({ id: "old-repo", tenantId, installationId: "installation-inventory", githubRepositoryId: 1, ownerLogin: "owner", name: "old", fullName: "owner/old", private: true, defaultBranch: "main" });
    const result = await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [] } }), store);
    expect(result).toMatchObject({ observed: 0, removed: 1 });
    expect((await store.listRepositoryInventory(tenantId))[0]).toMatchObject({ accessStatus: "access_removed", selected: false });
  });

  it("follows exactly one page and keeps one repository accessible but unselected", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1)] } }), store);
    const rows = await store.listRepositoryInventory(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubRepositoryId: 1, accessStatus: "accessible", selected: false, lastAuthoritativeObservedAt: observedAt });
    expect(store.installations.get(installationId)).toMatchObject({ permissions: { Metadata: "read" }, repositorySelection: "selected", lastInventoryAt: observedAt });
  });

  it("handles more than 100 repositories through complete pagination", async () => {
    const store = await storeWithInstallation();
    const all = Array.from({ length: 101 }, (_, index) => repository(index + 1));
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: all.slice(0, 100), nextPage: 2 }, 2: { repositories: all.slice(100) } }), store);
    expect((await store.listRepositoryInventory(tenantId)).length).toBe(101);
  });

  it("deduplicates a repository repeated across a retried page", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1)], nextPage: 2 }, 2: { repositories: [repository(1, "renamed")] } }), store);
    const rows = await store.listRepositoryInventory(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubRepositoryId: 1, fullName: "owner/renamed" });
  });

  it("is idempotent when the same completed inventory is refreshed again", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1)] } }), store);
    const first = await store.listRepositoryInventory(tenantId);
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1)] } }), store);
    const second = await store.listRepositoryInventory(tenantId);
    expect(second).toEqual(first);
    expect(store.repositoryNameHistory).toHaveLength(0);
  });

  it("leaves prior authoritative inventory intact when page two fails, then repairs on retry", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1)] } }), store);
    const before = await store.listRepositoryInventory(tenantId);
    await expect(refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: new Date(observedAt.getTime() + 1000) }, githubPages({ 1: { repositories: [repository(2)], nextPage: 2 } }, 2), store)).rejects.toThrow("page-2-failed");
    expect(await store.listRepositoryInventory(tenantId)).toEqual(before);

    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: new Date(observedAt.getTime() + 2000) }, githubPages({ 1: { repositories: [repository(2)], nextPage: 2 }, 2: { repositories: [] } }), store);
    expect(await store.listRepositoryInventory(tenantId)).toEqual(expect.arrayContaining([expect.objectContaining({ githubRepositoryId: 2, accessStatus: "accessible" }), expect.objectContaining({ githubRepositoryId: 1, accessStatus: "access_removed" })]));
  });

  it("preserves identity and records name history across rename and metadata changes", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1, "before", { private: true, visibility: "private" })] } }), store);
    const first = (await store.listRepositoryInventory(tenantId))[0];
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: new Date(observedAt.getTime() + 1000) }, githubPages({ 1: { repositories: [repository(1, "after", { owner: { login: "new-owner" }, full_name: "new-owner/after", private: false, visibility: "public", archived: true, disabled: true })] } }), store);
    const second = (await store.listRepositoryInventory(tenantId))[0];
    expect(second).toMatchObject({ id: first?.id, githubRepositoryId: 1, ownerLogin: "new-owner", fullName: "new-owner/after", private: false, visibility: "public", archived: true, disabled: true });
    expect(store.repositoryNameHistory).toHaveLength(1);
    expect(store.repositoryNameHistory[0]).toMatchObject({ repositoryId: first?.id, fullName: "owner/before" });
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: new Date(observedAt.getTime() + 2000) }, githubPages({ 1: { repositories: [repository(1, "final", { owner: { login: "final-owner" }, full_name: "final-owner/final" })] } }), store);
    expect(store.repositoryNameHistory).toHaveLength(2);
    expect(store.repositoryNameHistory[1]).toMatchObject({ fullName: "new-owner/after", validFrom: new Date(observedAt.getTime() + 1000), validTo: new Date(observedAt.getTime() + 2000) });
  });

  it("does not let an older completed refresh overwrite a newer observation", async () => {
    const store = await storeWithInstallation();
    const newer = new Date(observedAt.getTime() + 2000);
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: newer }, githubPages({ 1: { repositories: [repository(2)] } }), store);
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(3)] } }), store);
    expect(await store.listRepositoryInventory(tenantId)).toEqual(expect.arrayContaining([expect.objectContaining({ githubRepositoryId: 2 })]));
    expect(await store.getRepositoryByGithubId(tenantId, 3)).toBeUndefined();
  });

  it("rejects an inventory response for a different installation account", async () => {
    const store = await storeWithInstallation();
    const mismatched = githubPages({ 1: { repositories: [repository(1)] } });
    const original = mismatched.getInstallation;
    mismatched.getInstallation = async () => ({ id: installationId, account: { id: 999, login: "other", type: "User" } });
    await expect(refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, mismatched, store)).rejects.toThrow("account mismatch");
    mismatched.getInstallation = original;
    expect(await store.listRepositoryInventory(tenantId)).toHaveLength(0);
  });
});
