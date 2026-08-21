import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import type { AppConfig } from "@devmemoir/config";
import type { GithubClient } from "@devmemoir/github";
import { InMemoryJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { processDelivery } from "./processor.js";

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
});
