import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import type { AppConfig } from "@devmemoir/config";
import { GithubRateLimitPauseError, type GithubClient } from "@devmemoir/github";
import { InMemoryJobPort, installationInventoryLogicalKey } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { processInstallationInventory } from "./jobs.js";
import { processDelivery } from "./processor.js";
import { emptyHistoricalGithubMethods } from "./test-github.js";

const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

describe("worker delivery contract", () => {
  it("resolves external repository IDs and ignores the push payload head", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.saveRepository({ id: "repository-1", tenantId: "tenant-1", installationId: "installation-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
    const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: "delivery-1", eventName: "push", installationGithubId: 22, repositoryGithubId: 10, ref: "refs/heads/main", before: "before", after: "payload-head", forced: false, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    let requestedHead = "";
    const github: GithubClient = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => ({ id: 7, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "token" }),
      getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main" }),
      getRefHead: async () => "authoritative-head",
      listCommits: async (input) => { requestedHead = input.sha ?? ""; return { commits: [{ repositoryId: "", sha: "authoritative-head", author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: "authoritative", parents: [] }] }; },
      getCommit: async () => ({ repositoryId: "", sha: "authoritative-head", message: "authoritative", parents: [] }),
    };
    await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, installationGithubId: 22, repositoryGithubId: 10, ref: "refs/heads/main", before: "before", after: "payload-head", forced: false } }, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });
    expect(requestedHead).toBe("authoritative-head");
    expect(store.deliveries.get("delivery-1")?.state).toBe("processed");
    expect(store.commits.has("tenant-1:repository-1:authoritative-head")).toBe(true);
  });

  it("does not reopen a terminal delivery from a stale queued job", async () => {
    for (const state of ["processed", "ignored"] as const) {
      const store = new InMemoryM1Store();
      const jobs = new InMemoryJobPort();
      const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: `terminal-${state}`, eventName: "push", repositoryGithubId: 10, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
      await store.updateDelivery(delivery.record.id, { state }, "tenant-1");
      await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, repositoryGithubId: 10 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
      expect(store.deliveries.get(delivery.record.guid)?.state).toBe(state);
      expect(store.deliveries.get(delivery.record.guid)?.processingAttempts).toBe(0);
    }
  });

  it("turns installation_repositories into one authoritative inventory job", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: "inventory-signal", eventName: "installation_repositories", action: "added", installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "installation_repositories", action: "added", installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "installation_repositories", action: "added", installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    expect(store.deliveries.get("inventory-signal")?.state).toBe("processed");
    expect([...jobs.jobs.values()].map((job) => job.kind)).toEqual(["installation_inventory"]);
    expect([...jobs.jobs.values()][0]?.payload).not.toHaveProperty("repositories");
  });

  it("preserves a selected repository when new permissions are accepted and access remains authoritative", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.saveRepository({ id: "repository-1", tenantId: "tenant-1", installationId: "installation-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
    const github: GithubClient = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => ({ id: 7, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" }, permissions: { metadata: "read", contents: "read" }, repository_selection: "selected" }),
      listInstallationRepositories: async () => ({ repositories: [{ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }] }),
      getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
      listCommits: async () => ({ commits: [] }),
      getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
      getRefHead: async () => "a".repeat(40),
    };
    const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: "permissions-accepted", eventName: "installation", action: "new_permissions_accepted", installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    const payload = { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "installation", action: "new_permissions_accepted", installationGithubId: 22 } as const;

    await processDelivery({ deliveryId: delivery.record.id, payload }, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });
    await processDelivery({ deliveryId: delivery.record.id, payload }, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });

    expect(store.installations.get(22)?.status).toBe("active");
    expect((await store.listRepositoryInventory("tenant-1"))[0]).toMatchObject({ accessStatus: "accessible", selected: true });
    expect([...jobs.jobs.values()]).toHaveLength(1);
    expect(store.deliveries.get("permissions-accepted")).toMatchObject({ state: "processed", processingAttempts: 1 });

    const inventoryJob = [...jobs.jobs.values()][0];
    await processInstallationInventory(inventoryJob?.payload ?? {}, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });

    expect(store.installations.get(22)).toMatchObject({ status: "active", permissions: { metadata: "read", contents: "read" }, repositorySelection: "selected" });
    expect((await store.listRepositoryInventory("tenant-1"))[0]).toMatchObject({ accessStatus: "accessible", selected: true });
  });

  it("suspends and deletes installations without minting or reading repositories", async () => {
    for (const [action, expectedStatus, expectedAccess] of [["suspend", "suspended", "installation_suspended"], ["deleted", "deleted", "disconnected"]] as const) {
      const store = new InMemoryM1Store();
      const jobs = new InMemoryJobPort();
      await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
      await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
      await store.saveRepository({ id: "repository-1", tenantId: "tenant-1", installationId: "installation-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
      const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: `lifecycle-${action}`, eventName: "installation", action, installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
      await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "installation", action, installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => { throw new Error("must not mint installation client"); }, logger: createLogger() });
      expect(store.installations.get(22)?.status).toBe(expectedStatus);
      expect((await store.listRepositoryInventory("tenant-1"))[0]).toMatchObject({ accessStatus: expectedAccess, selected: false });
    }
  });

  it("keeps repositories unavailable and unselected until an unsuspend inventory refresh completes", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.saveRepository({ id: "repository-1", tenantId: "tenant-1", installationId: "installation-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
    const suspended = await store.insertDelivery({ tenantId: "tenant-1", guid: "unsuspend-suspend", eventName: "installation", action: "suspend", installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    await processDelivery({ deliveryId: suspended.record.id, payload: { tenantId: "tenant-1", deliveryId: suspended.record.id, eventName: "installation", action: "suspend", installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    const unsuspended = await store.insertDelivery({ tenantId: "tenant-1", guid: "unsuspend-active", eventName: "installation", action: "unsuspend", installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    await processDelivery({ deliveryId: unsuspended.record.id, payload: { tenantId: "tenant-1", deliveryId: unsuspended.record.id, eventName: "installation", action: "unsuspend", installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    expect(store.installations.get(22)?.status).toBe("active");
    expect((await store.listRepositoryInventory("tenant-1"))[0]).toMatchObject({ accessStatus: "unavailable", selected: false });
    expect([...jobs.jobs.values()].map((job) => job.kind)).toEqual(["installation_inventory"]);

    const github: GithubClient = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => ({ id: 7, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [{ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }] }),
      getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
      listCommits: async () => ({ commits: [] }),
      getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
      getRefHead: async () => "a".repeat(40),
    };
    const inventoryJob = [...jobs.jobs.values()][0];
    await processInstallationInventory(inventoryJob?.payload ?? {}, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });

    expect((await store.listRepositoryInventory("tenant-1"))[0]).toMatchObject({ accessStatus: "accessible", selected: false });
    expect(store.deliveries.get("unsuspend-active")?.state).toBe("processed");
  });

  it("terminalizes a repository signal after suspension and keeps duplicate delivery a no-op", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.saveRepository({ id: "repository-1", tenantId: "tenant-1", installationId: "installation-1", githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
    await store.updateInstallationLifecycle(22, "suspended", new Date());
    const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: "stale-after-suspend", eventName: "repository", action: "edited", installationGithubId: 22, repositoryGithubId: 10, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    const payload = { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "repository", action: "edited", installationGithubId: 22, repositoryGithubId: 10 } as const;
    await processDelivery({ deliveryId: delivery.record.id, payload }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    expect(store.deliveries.get("stale-after-suspend")).toMatchObject({ state: "ignored", processingAttempts: 1, processedAt: expect.any(Date) });
    await processDelivery({ deliveryId: delivery.record.id, payload }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    expect(store.deliveries.get("stale-after-suspend")?.state).toBe("ignored");
    expect(store.deliveries.get("stale-after-suspend")?.processingAttempts).toBe(1);
  });

  it("terminalizes an installation repository signal after deletion", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.updateInstallationLifecycle(22, "deleted", new Date());
    const delivery = await store.insertDelivery({ tenantId: "tenant-1", guid: "stale-after-delete", eventName: "installation_repositories", action: "removed", installationGithubId: 22, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    await processDelivery({ deliveryId: delivery.record.id, payload: { tenantId: "tenant-1", deliveryId: delivery.record.id, eventName: "installation_repositories", action: "removed", installationGithubId: 22 } }, { config, store, jobs, githubForInstallation: () => ({}) as GithubClient, logger: createLogger() });
    expect(store.deliveries.get("stale-after-delete")).toMatchObject({ state: "ignored", processingAttempts: 1, processedAt: expect.any(Date) });
    expect(jobs.jobs.size).toBe(0);
  });

  it("logs inventory counts without private repository metadata", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    const github: GithubClient = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => ({ id: 7, login: "owner", type: "User" }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [{ id: 10, name: "private-repository-name", full_name: "owner/private-repository-name", private: true, default_branch: "main", owner: { login: "owner" } }] }),
      getRepository: async () => ({ id: 10, name: "private-repository-name", full_name: "owner/private-repository-name", private: true, default_branch: "main", owner: { login: "owner" } }),
      listCommits: async () => ({ commits: [] }),
      getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
      getRefHead: async () => "a".repeat(40),
    };
    const capture = createCanarySink();
    await processInstallationInventory({ tenantId: "tenant-1", installationGithubId: 22 }, { config, store, jobs, githubForInstallation: () => github, logger: createLogger(capture.sink) });
    expect(capture.text()).not.toContain("private-repository-name");
    expect(capture.text()).toContain('"installation_id":"22"');
  });

  it("schedules an inventory rate-limit wake under a key distinct from the active stately job", async () => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    const resumeAt = new Date("2026-08-23T01:00:00Z");
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    const operationId = "access-recheck";
    const activeKey = installationInventoryLogicalKey(22, operationId);
    const payload = { kind: "installation_inventory" as const, tenantId: "tenant-1", installationGithubId: 22, inventoryOperationId: operationId };
    await jobs.enqueue("installation_inventory", activeKey, payload);
    const github = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => ({ id: 7, login: "owner", type: "User" as const }),
      exchangeOAuthCode: async () => ({ accessToken: "unused" }),
      getInstallation: async () => { throw new GithubRateLimitPauseError("primary_rate_limit", 403, resumeAt); },
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
      listCommits: async () => ({ commits: [] }),
      getCommit: async () => ({ repositoryId: "", sha: "head", message: "", parents: [] }),
      getRefHead: async () => "head",
    } satisfies GithubClient;

    await processInstallationInventory(payload, { config, store, jobs, githubForInstallation: () => github, logger: createLogger() });

    const wakeKey = installationInventoryLogicalKey(22, `${operationId}:wake:${resumeAt.getTime()}`);
    expect([...jobs.jobs.values()].some((job) => job.logicalKey === wakeKey)).toBe(true);
    expect(store.installations.get(22)).toMatchObject({ apiPausedUntil: resumeAt, apiPauseReason: "github_primary_rate_limit" });
  });
});
