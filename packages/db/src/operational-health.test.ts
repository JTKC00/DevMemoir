import { describe, expect, it } from "vitest";
import { InMemoryM1Store, type RepositoryRecord } from "./store.js";

async function setup() {
  const store = new InMemoryM1Store();
  await store.upsertUser({ userId: "user-a", tenantId: "tenant-a", githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: "installation-a", tenantId: "tenant-a", githubInstallationId: 71, accountGithubAccountId: 7 });
  return store;
}

function repository(id: string, githubRepositoryId: number): RepositoryRecord {
  return { id, tenantId: "tenant-a", installationId: "installation-a", githubRepositoryId, ownerLogin: "owner", name: id, fullName: `owner/${id}`, private: true, defaultBranch: "main" };
}

describe("M5.4 InMemory operational repository eligibility", () => {
  it("includes selected accessible repositories with an active installation", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-selected", 101));
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([expect.objectContaining({ repositoryId: "repo-selected", installationGithubId: 71 })]);
  });

  it("includes selected repositories whose accessStatus is missing", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-missing-access", 102));
    const current = store.repositories.get("tenant-a:102")!;
    const { accessStatus: _accessStatus, ...withoutAccess } = current;
    store.repositories.set("tenant-a:102", { ...withoutAccess, selected: true });
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([expect.objectContaining({ repositoryId: "repo-missing-access" })]);
  });

  it("excludes unselected repositories", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-unselected", 103));
    await store.unselectRepository("tenant-a", "repo-unselected");
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([]);
  });

  it("excludes access_removed repositories", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-removed", 104));
    store.repositories.set("tenant-a:104", { ...store.repositories.get("tenant-a:104")!, accessStatus: "access_removed" });
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([]);
  });

  it("excludes repositories on inactive or suspended installations", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-inactive", 105));
    store.installations.set(71, { ...store.installations.get(71)!, status: "suspended" });
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([]);
    store.installations.set(71, { ...store.installations.get(71)!, status: "deleted" });
    expect(await store.listRepositoryOperationalHealth("tenant-a")).toEqual([]);
  });
});
