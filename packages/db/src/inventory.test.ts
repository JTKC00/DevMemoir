import { describe, expect, it } from "vitest";
import { InMemoryM1Store, RepositorySelectionError } from "./store.js";

async function setup() {
  const store = new InMemoryM1Store();
  await store.upsertUser({ userId: "user-a", tenantId: "tenant-a", githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: "installation-a", tenantId: "tenant-a", githubInstallationId: 71, accountGithubAccountId: 7 });
  return store;
}

function inventoryRepository(id: string, githubRepositoryId: number, name: string) {
  return { id, tenantId: "tenant-a", installationId: "inventory-resolution", githubRepositoryId, ownerLogin: "owner", name, fullName: `owner/${name}`, private: true, defaultBranch: "main" };
}

describe("repository access inventory semantics", () => {
  it("separates accessible/unselected from selected and retains removed identity", async () => {
    const store = await setup();
    await store.reconcileInstallationInventory({ tenantId: "tenant-a", githubInstallationId: 71, observedAt: new Date("2026-08-21T00:00:00Z"), repositories: [inventoryRepository("candidate-a", 101, "a"), inventoryRepository("candidate-b", 102, "b")] });
    const candidate = await store.getRepositoryByFullName("tenant-a", "owner/a");
    expect(candidate?.accessStatus).toBe("accessible");
    await store.selectRepository("tenant-a", candidate?.id ?? "");
    expect((await store.listRepositories("tenant-a")).map((repository) => repository.githubRepositoryId)).toEqual([101]);
    await expect(store.selectRepository("tenant-a", (await store.getRepositoryByFullName("tenant-a", "owner/b"))?.id ?? "")).rejects.toBeInstanceOf(RepositorySelectionError);

    await store.reconcileInstallationInventory({ tenantId: "tenant-a", githubInstallationId: 71, observedAt: new Date("2026-08-21T00:01:00Z"), repositories: [inventoryRepository("ignored-id", 102, "b")] });
    const removed = await store.getRepositoryByGithubId("tenant-a", 101);
    expect(removed).toMatchObject({ id: candidate?.id, accessStatus: "access_removed", githubRepositoryId: 101 });
    expect(await store.listRepositories("tenant-a")).toHaveLength(0);

    await store.reconcileInstallationInventory({ tenantId: "tenant-a", githubInstallationId: 71, observedAt: new Date("2026-08-21T00:02:00Z"), repositories: [inventoryRepository("new-id-is-ignored", 101, "a-renamed"), inventoryRepository("ignored-id", 102, "b")] });
    const readded = await store.getRepositoryByGithubId("tenant-a", 101);
    expect(readded).toMatchObject({ id: candidate?.id, accessStatus: "accessible", selected: true, fullName: "owner/a-renamed" });
  });

  it("does not enumerate or mutate another tenant's inventory", async () => {
    const store = await setup();
    await store.upsertUser({ userId: "user-b", tenantId: "tenant-b", githubAccountId: 8, login: "other", displayName: "other" });
    await store.saveInstallation({ id: "installation-b", tenantId: "tenant-b", githubInstallationId: 72, accountGithubAccountId: 8 });
    await store.reconcileInstallationInventory({ tenantId: "tenant-b", githubInstallationId: 72, observedAt: new Date(), repositories: [inventoryRepository("tenant-b-row", 201, "b")] });
    expect(await store.listRepositoryInventory("tenant-a")).toHaveLength(0);
    expect(await store.getRepositoryByGithubId("tenant-a", 201)).toBeUndefined();
    expect(await store.selectRepository("tenant-a", "tenant-b-row")).toBeUndefined();
  });
});
