import { createHmac } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { InMemoryM1Store } from "@devmemoir/db";
import { createId, createOpaqueToken, encryptSecret, hashOpaqueToken } from "@devmemoir/domain";
import type { GithubClient } from "@devmemoir/github";
import { InMemoryJobPort, type JobKind, type JobPort } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { buildApi } from "./app.js";

const secret = "current-secret-123456";
const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_WEBHOOK_SECRET: secret, GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long",
  AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

const github: GithubClient = {
  getUser: async () => ({ id: 7, login: "owner", type: "User" }),
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }),
  listInstallationRepositories: async () => ({ repositories: [] }),
  getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
  listCommits: async () => ({ commits: [] }),
  getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
  getRefHead: async () => "a".repeat(40),
};

class NullEnqueueJobPort implements JobPort {
  private readonly delegate = new InMemoryJobPort();

  async start(): Promise<void> { return this.delegate.start(); }
  async stop(): Promise<void> { return this.delegate.stop(); }
  async enqueue<T>(_kind: JobKind, _logicalKey: string, _payload: T): Promise<string | undefined> { return undefined; }
  async work<T extends object>(kind: JobKind, handler: (job: { id: string; kind: JobKind; logicalKey: string; payload: T }) => Promise<void>): Promise<void> { return this.delegate.work(kind, handler); }
  async has(jobId: string, kind: JobKind): Promise<boolean> { return this.delegate.has(jobId, kind); }
  async retry(jobId: string): Promise<void> { return this.delegate.retry(jobId); }
  async cancel(jobId: string): Promise<void> { return this.delegate.cancel(jobId); }
}

describe("M1 webhook receipt", () => {
  const store = new InMemoryM1Store();
  const jobs = new InMemoryJobPort();
  const capture = createCanarySink();
  let app: Awaited<ReturnType<typeof buildApi>>;

  beforeEach(async () => {
    store.deliveries.clear();
    store.unroutedWebhooks.clear();
    store.jobs.clear();
    jobs.jobs.clear();
    await store.upsertUser({ userId: "user-1", tenantId: "tenant-1", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: "installation-1", tenantId: "tenant-1", githubInstallationId: 22, accountGithubAccountId: 7 });
    app = await buildApi({ config, store, github, jobs, logger: createLogger(capture.sink) });
  });

  afterEach(async () => { await app.close(); });

  async function send(guid: string, eventName: string, body: Record<string, unknown>, signingSecret = secret) {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    return app.inject({ method: "POST", url: "/webhooks/github", headers: { "content-type": "application/json", "x-github-event": eventName, "x-github-delivery": guid, "x-hub-signature-256": `sha256=${createHmac("sha256", signingSecret).update(raw).digest("hex")}` }, payload: raw });
  }

  it("durably receives a minimal push signal and is idempotent by GUID", async () => {
    const body = { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false, installation: { id: 22 }, repository: { id: 10 }, commits: [{ message: "PRIVATE_PUSH_COMMIT_CANARY" }] };
    const first = await send("guid-1", "push", body);
    expect(first.statusCode).toBe(202);
    expect(store.deliveries.size).toBe(1);
    expect(jobs.jobs.size).toBe(1);
    expect(JSON.stringify([...jobs.jobs.values()])).not.toContain("PRIVATE_PUSH_COMMIT_CANARY");
    const second = await send("guid-1", "push", body);
    expect(second.statusCode).toBe(202);
    expect(jobs.jobs.size).toBe(1);
  });

  it("reopens failed deliveries without inventing another job", async () => {
    await send("guid-failed", "push", { ref: "refs/heads/main", before: "a", after: "b", installation: { id: 22 }, repository: { id: 10 } });
    const record = store.deliveries.get("guid-failed");
    expect(record).toBeDefined();
    await store.updateDelivery(record?.id ?? "", { state: "failed" });
    const redelivery = await send("guid-failed", "push", { ref: "refs/heads/main", before: "a", after: "b", installation: { id: 22 }, repository: { id: 10 } });
    expect(jobs.jobs.size).toBe(1);
    expect(store.deliveries.get("guid-failed")?.state).toBe("received");
    expect(redelivery.json<{ state: string }>().state).toBe("received");
  });

  it("does not persist a logical key as job_id when another process owns the singleton", async () => {
    const competingJobs = new NullEnqueueJobPort();
    const competingApp = await buildApi({ config, store, github, jobs: competingJobs, logger: createLogger(capture.sink) });
    const body = { ref: "refs/heads/main", before: "a", after: "b", installation: { id: 22 }, repository: { id: 10 } };
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    try {
      const response = await competingApp.inject({ method: "POST", url: "/webhooks/github", headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "guid-cross-process", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` }, payload: raw });
      expect(response.statusCode).toBe(202);
      expect(store.deliveries.get("guid-cross-process")?.jobId).toBeNull();
      expect(store.jobs.size).toBe(1);
    } finally {
      await competingApp.close();
    }
  });

  it("keeps the first receipt as canonical when a redelivery body disagrees", async () => {
    await send("guid-disagree", "push", { ref: "refs/heads/main", before: "a", after: "first", installation: { id: 22 }, repository: { id: 10 } });
    await send("guid-disagree", "push", { ref: "refs/heads/main", before: "b", after: "second", installation: { id: 22 }, repository: { id: 10 } });
    const payload = [...jobs.jobs.values()][0]?.payload as { after?: string } | undefined;
    expect(payload?.after).toBe("first");
    expect(store.deliveries.get("guid-disagree")?.after).toBe("first");
  });

  it("completes installation setup from state without an API session cookie", async () => {
    const state = createOpaqueToken(32);
    await store.createAuthTransaction({ id: createId(), stateHash: hashOpaqueToken(state, config.SESSION_SECRET), codeVerifierCiphertext: encryptSecret("unused", config.ENCRYPTION_KEY_BASE64), userId: "user-1", returnPath: "/connect", expiresAt: new Date(Date.now() + 60_000) });
    const response = await app.inject({ method: "GET", url: `/github/setup?installation_id=22&setup_action=install&state=${encodeURIComponent(state)}` });
    expect(response.statusCode).toBe(302);
    expect(store.installations.get(22)?.tenantId).toBe("tenant-1");
    expect([...jobs.jobs.values()].map((job) => job.kind)).toEqual(["installation_inventory"]);
  });

  it("handles signed ping and unsupported actions as acknowledged states", async () => {
    expect((await send("guid-ping", "ping", { zen: "hello" })).statusCode).toBe(202);
    expect((await send("guid-unknown", "issues", { action: "transferred" })).statusCode).toBe(202);
    expect(store.unroutedWebhooks.has("guid-unknown")).toBe(true);
  });

  it("routes installation repository changes to a worker refresh without trusting payload arrays", async () => {
    const response = await send("guid-inventory", "installation_repositories", { action: "added", installation: { id: 22 }, repositories_added: [{ id: 999, name: "private-name-must-not-be-a-source" }] });
    expect(response.statusCode).toBe(202);
    const queued = [...jobs.jobs.values()];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("webhook_delivery");
    expect(JSON.stringify(queued[0]?.payload)).not.toContain("private-name-must-not-be-a-source");
    expect((queued[0]?.payload as { eventName?: string }).eventName).toBe("installation_repositories");
  });

  it("routes current repository lifecycle actions to authoritative refresh", async () => {
    const actions = ["created", "edited", "renamed", "transferred", "archived", "unarchived", "deleted", "privatized", "publicized"];
    for (const [index, action] of actions.entries()) {
      const response = await send(`guid-repository-${index}`, "repository", { action, installation: { id: 22 }, repository: { id: 10, name: "repo", full_name: "owner/repo" } });
      expect(response.statusCode).toBe(202);
    }
    expect(store.deliveries.size).toBe(actions.length);
    expect(jobs.jobs.size).toBe(actions.length);
  });

  it("routes installation permission changes to authoritative refresh", async () => {
    const response = await send("guid-permissions", "installation", { action: "new_permissions_accepted", installation: { id: 22 }, repositories: [{ id: 999, name: "permission-payload-must-not-be-trusted" }] });
    expect(response.statusCode).toBe(202);
    expect(store.deliveries.get("guid-permissions")).toMatchObject({ eventName: "installation", action: "new_permissions_accepted", state: "received" });
    const queued = [...jobs.jobs.values()];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("webhook_delivery");
    expect(queued[0]?.payload).toMatchObject({ eventName: "installation", action: "new_permissions_accepted" });
    expect(JSON.stringify(queued[0]?.payload)).not.toContain("permission-payload-must-not-be-trusted");
  });

  it("rejects invalid signatures and bodies over 2 MB before persistence", async () => {
    const invalid = await send("guid-invalid", "push", { ref: "refs/heads/main", before: "a", after: "b" }, "wrong-secret-123456");
    expect(invalid.statusCode).toBe(401);
    expect(store.deliveries.size).toBe(0);
    const tooLarge = await send("guid-large", "push", { ref: "refs/heads/main", before: "a", after: "b", filler: "x".repeat(2 * 1024 * 1024) });
    expect(tooLarge.statusCode).toBe(413);
    expect(store.deliveries.size).toBe(0);
  });
});
