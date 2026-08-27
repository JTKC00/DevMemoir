import { describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { InMemoryM1Store } from "@devmemoir/db";
import { defaultTimelineEvents } from "@devmemoir/domain";
import type { GithubClient, GithubRepository } from "@devmemoir/github";
import { InMemoryJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { refreshInstallationInventory } from "./inventory.js";
import { processInstallationInventory } from "./jobs.js";
import { emptyHistoricalGithubMethods } from "./test-github.js";

const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

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
    ...emptyHistoricalGithubMethods,
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

describe("inventory metadata triggers canonical reprojection", () => {
  const ownerId = 7;
  const commitSha = "c".repeat(40);
  const commitUrl = "https://github.example/private/commit";

  function countReproject(store: InMemoryM1Store): { store: InMemoryM1Store; calls: number[] } {
    const original = store.reprojectRepository.bind(store);
    const calls: number[] = [];
    store.reprojectRepository = async (input) => {
      const result = await original(input);
      calls.push(result.eventCount);
      return result;
    };
    return { store, calls };
  }

  async function selectedStore(githubRepo: GithubRepository, at = observedAt): Promise<InMemoryM1Store> {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: at }, githubPages({ 1: { repositories: [githubRepo] } }), store);
    const row = (await store.listRepositoryInventory(tenantId))[0];
    await store.selectRepository(tenantId, row?.id ?? "");
    await store.saveCommit(tenantId, row?.id ?? "", {
      repositoryId: row?.id ?? "",
      sha: commitSha,
      author: { githubAccountId: ownerId, actorKind: "user" },
      committer: { githubAccountId: ownerId, actorKind: "user" },
      message: "owner commit",
      authoredAt: at,
      committedAt: at,
      parents: [],
    }, commitUrl);
    await store.reprojectRepository({ tenantId, repositoryId: row?.id ?? "", ownerGithubAccountId: ownerId });
    return store;
  }

  function jobsFor(store: InMemoryM1Store, github: GithubClient, now: Date) {
    return { config, store, jobs: new InMemoryJobPort(), githubForInstallation: () => github, logger: createLogger(), now: () => now };
  }

  it("reprojects a selected repository rename into a deterministic repository.renamed event", async () => {
    const store = await selectedStore(repository(1, "old-name", { created_at: observedAt.toISOString() }));
    const { store: instrumented, calls } = countReproject(store);
    const renamedAt = new Date(observedAt.getTime() + 1000);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(instrumented, githubPages({ 1: { repositories: [repository(1, "new-name", { created_at: observedAt.toISOString() })] } }), renamedAt));
    const row = await store.getRepositoryByGithubId(tenantId, 1);
    expect(row).toMatchObject({ githubRepositoryId: 1, name: "new-name", fullName: "owner/new-name" });
    expect(store.repositoryNameHistory).toHaveLength(1);
    expect(store.repositoryNameHistory[0]).toMatchObject({ name: "old-name", fullName: "owner/old-name", validTo: renamedAt });
    expect(calls.length).toBeGreaterThan(0);
    const renamed = store.events.filter((event) => event.sourceKind === "repository" && event.verb === "renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ actorKind: "unknown", contributionRole: "unknown_action", occurredAt: renamedAt });
    expect(renamed[0]?.logicalEventKey).toBe(`tenant-inventory:${row?.id}:repository:${row?.githubRepositoryId}:rename:${renamedAt.toISOString()}:repository:renamed:unknown_action`);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(instrumented, githubPages({ 1: { repositories: [repository(1, "new-name", { created_at: observedAt.toISOString() })] } }), new Date(renamedAt.getTime() + 1000)));
    expect(store.events.filter((event) => event.sourceKind === "repository" && event.verb === "renamed")).toHaveLength(1);
    expect(defaultTimelineEvents(store.events, ownerId).filter((event) => event.sourceKind === "repository")).toHaveLength(0);
  });

  it("reprojects visibility changes onto existing canonical events", async () => {
    const store = await selectedStore(repository(1, "repo-1", { private: false, visibility: "public" }));
    expect(store.events.every((event) => event.visibility === "public")).toBe(true);
    const privateAt = new Date(observedAt.getTime() + 1000);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "repo-1", { private: true, visibility: "private" })] } }), privateAt));
    const row = await store.getRepositoryByGithubId(tenantId, 1);
    expect(row).toMatchObject({ githubRepositoryId: 1, private: true, visibility: "private" });
    expect(store.events.every((event) => event.visibility === "private")).toBe(true);
    expect(store.commits.size).toBe(1);
    expect(store.events.some((event) => event.sourceUrl === commitUrl)).toBe(true);
    expect(new Set(store.events.map((event) => event.logicalEventKey)).size).toBe(store.events.length);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "repo-1", { private: false, visibility: "public" })] } }), new Date(privateAt.getTime() + 1000)));
    expect((await store.getRepositoryByGithubId(tenantId, 1))?.private).toBe(false);
    expect(store.events.every((event) => event.visibility === "public")).toBe(true);
  });

  it("emits repository.archived from the first authoritative observation and stays idempotent", async () => {
    const store = await selectedStore(repository(1, "repo-1", { archived: false }));
    const archivedAt = new Date(observedAt.getTime() + 1000);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "repo-1", { archived: true })] } }), archivedAt));
    expect(await store.getRepositoryByGithubId(tenantId, 1)).toMatchObject({ archived: true, archivedAt });
    expect(store.events.filter((event) => event.verb === "archived")).toMatchObject([{ sourceKind: "repository", actorKind: "unknown", occurredAt: archivedAt }]);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "repo-1", { archived: true })] } }), new Date(archivedAt.getTime() + 1000)));
    expect((await store.getRepositoryByGithubId(tenantId, 1))?.archivedAt).toEqual(archivedAt);
    expect(store.events.filter((event) => event.verb === "archived")).toHaveLength(1);
  });

  it("does not duplicate canonical events on identical inventory replay", async () => {
    const store = await selectedStore(repository(1, "stable"));
    const later = new Date(observedAt.getTime() + 1000);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "stable")] } }), later));
    const afterFirst = store.events.map(({ id: _id, ...event }) => event);
    const historyCount = store.repositoryNameHistory.length;
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "stable")] } }), new Date(later.getTime() + 1000)));
    expect(store.events.map(({ id: _id, ...event }) => event)).toEqual(afterFirst);
    expect(store.repositoryNameHistory).toHaveLength(historyCount);
    expect(new Set(store.events.map((event) => event.logicalEventKey)).size).toBe(store.events.length);
  });

  it("keeps inventory facts when projection fails and retries without drift", async () => {
    const store = await selectedStore(repository(1, "old-name"));
    const beforeEvents = store.events.map((event) => ({ ...event }));
    const original = store.reprojectRepository.bind(store);
    let shouldFail = true;
    store.reprojectRepository = async (input) => {
      if (shouldFail) throw new Error("projection_injected_failure");
      return original(input);
    };
    const renamedAt = new Date(observedAt.getTime() + 1000);
    await expect(processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "new-name")] } }), renamedAt))).rejects.toThrow("projection_injected_failure");
    expect(await store.getRepositoryByGithubId(tenantId, 1)).toMatchObject({ name: "new-name", fullName: "owner/new-name" });
    expect(store.repositoryNameHistory).toHaveLength(1);
    expect(store.events).toEqual(beforeEvents);
    shouldFail = false;
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(store, githubPages({ 1: { repositories: [repository(1, "new-name")] } }), new Date(renamedAt.getTime() + 1000)));
    expect(store.events.filter((event) => event.verb === "renamed")).toHaveLength(1);
    expect(store.repositoryNameHistory).toHaveLength(1);
  });

  it("does not reproject an unselected accessible repository", async () => {
    const store = await storeWithInstallation();
    await refreshInstallationInventory({ tenantId, installationGithubId: installationId, now: observedAt }, githubPages({ 1: { repositories: [repository(1, "old-name")] } }), store);
    const { store: instrumented, calls } = countReproject(store);
    await processInstallationInventory({ tenantId, installationGithubId: installationId }, jobsFor(instrumented, githubPages({ 1: { repositories: [repository(1, "new-name")] } }), new Date(observedAt.getTime() + 1000)));
    expect(calls).toEqual([]);
    expect(store.events).toHaveLength(0);
    expect((await store.getRepositoryByGithubId(tenantId, 1))?.name).toBe("new-name");
  });
});
