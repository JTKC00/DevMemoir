import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "@devmemoir/db";
import { GithubRateLimitPauseError, type AppWebhookDelivery, type GithubAppClient, type GithubClient } from "@devmemoir/github";
import { InMemoryJobPort } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { enqueueGithubDeliveryAudit, processGithubDeliveryAudit, type DeliveryAuditDependencies } from "./delivery-audit.js";
import { processQueueJob } from "./jobs.js";
import { processDelivery } from "./processor.js";
import { emptyHistoricalGithubMethods } from "./test-github.js";
import type { AppConfig } from "@devmemoir/config";

const githubAppId = 42;
const auditRunId = "00000000-0000-4000-8000-0000000000aa";
const guid = "0b989ba4-242f-11e5-81e1-c7b6966d2516";
const tenantId = "tenant-audit";
const repositoryId = "repository-audit";
const installationId = "installation-audit";
const installationGithubId = 22;
const privateOwner = "PRIVATE_OWNER_CANARY";
const privateRepository = "PRIVATE_REPOSITORY_CANARY";
const privateCommit = "PRIVATE_COMMIT_CANARY";
const now = () => new Date("2026-08-29T12:00:00Z");

const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: githubAppId, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

function failedDelivery(overrides: Partial<AppWebhookDelivery> = {}): AppWebhookDelivery {
  return {
    id: 99,
    guid,
    deliveredAt: new Date("2026-08-29T11:00:00Z"),
    redelivery: false,
    statusCode: 502,
    eventName: "push",
    installationGithubId,
    repositoryGithubId: 10,
    ...overrides,
  };
}

function appClient(input: { deliveries?: AppWebhookDelivery[]; nextCursor?: string; onList?: () => void; onRedeliver?: (id: number) => void; listError?: Error }): GithubAppClient & { redelivered: number[]; listed: number } {
  const client = {
    redelivered: [] as number[],
    listed: 0,
    listAppWebhookDeliveries: async () => {
      client.listed += 1;
      input.onList?.();
      if (input.listError) throw input.listError;
      return { deliveries: input.deliveries ?? [failedDelivery()], ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}) };
    },
    redeliverAppWebhookDelivery: async (id: number) => {
      input.onRedeliver?.(id);
      client.redelivered.push(id);
    },
  };
  return client;
}

async function setup(app: GithubAppClient) {
  const store = new InMemoryM1Store();
  const jobs = new InMemoryJobPort();
  const capture = createCanarySink();
  await store.upsertUser({ userId: "user-audit", tenantId, githubAccountId: 7, login: "owner", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: 7 });
  await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: 10, ownerLogin: privateOwner, name: privateRepository, fullName: `${privateOwner}/${privateRepository}`, private: true, defaultBranch: "main" });
  const deps: DeliveryAuditDependencies = { store, jobs, githubApp: app, logger: createLogger(capture.sink), now };
  return { store, jobs, capture, deps };
}

function operationalText(scope: { jobs: InMemoryJobPort; capture: ReturnType<typeof createCanarySink> }, extra: unknown = {}): string {
  return `${JSON.stringify([...scope.jobs.jobs.values()])}\n${JSON.stringify([...scope.jobs.jobs.keys()])}\n${scope.capture.text()}\n${JSON.stringify(extra)}`;
}

describe("M5.2 GitHub App failed-delivery audit", () => {
  it("requests same-GUID redelivery for a retryable local delivery and resumes without duplicate facts", async () => {
    const app = appClient({});
    const scope = await setup(app);
    const first = await scope.store.insertDelivery({
      tenantId, guid, eventName: "push", installationGithubId, repositoryGithubId: 10,
      ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false,
      payloadExpiresAt: new Date("2026-09-05T00:00:00Z"), now: now(),
    });
    await scope.store.updateDelivery(first.record.id, { state: "failed" }, tenantId);
    const runId = await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId: runId, page: 1 }, scope.deps);

    expect(app.redelivered).toEqual([99]);
    expect((await scope.store.getGithubDeliveryRepair(guid))?.status).toBe("requested");
    const resumed = await scope.store.insertDelivery({
      tenantId, guid, eventName: "push", installationGithubId, repositoryGithubId: 10,
      ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false,
      payloadExpiresAt: new Date("2026-09-05T00:00:00Z"), now: new Date("2026-08-29T12:01:00Z"),
    });
    expect(resumed.created).toBe(false);
    expect(resumed.record.id).toBe(first.record.id);
    expect(resumed.action).toBe("requeue");
    expect(resumed.record.receiptCount).toBe(2);

    const github: GithubClient = {
      ...emptyHistoricalGithubMethods,
      getUser: async () => { throw new Error("user token path invoked"); },
      exchangeOAuthCode: async () => { throw new Error("user token path invoked"); },
      getInstallation: async () => ({ id: installationGithubId, account: { id: 7, login: "owner", type: "User" } }),
      listInstallationRepositories: async () => ({ repositories: [] }),
      getRepository: async () => ({ id: 10, name: privateRepository, full_name: `${privateOwner}/${privateRepository}`, private: true, default_branch: "main" }),
      getRefHead: async () => "b".repeat(40),
      listCommits: async () => ({ commits: [{ repositoryId, sha: "b".repeat(40), author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: privateCommit, parents: [] }] }),
      getCommit: async () => ({ repositoryId, sha: "b".repeat(40), message: privateCommit, parents: [] }),
    };
    await processDelivery({ deliveryId: first.record.id, payload: { tenantId, deliveryId: first.record.id, installationGithubId, repositoryGithubId: 10, ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false } }, { config, store: scope.store, jobs: scope.jobs, githubForInstallation: () => github, logger: createLogger(scope.capture.sink), now });
    await processDelivery({ deliveryId: first.record.id, payload: { tenantId, deliveryId: first.record.id, installationGithubId, repositoryGithubId: 10, ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), forced: false } }, { config, store: scope.store, jobs: scope.jobs, githubForInstallation: () => github, logger: createLogger(scope.capture.sink), now });
    expect([...scope.store.commits.values()].filter((row) => row.repositoryId === repositoryId)).toHaveLength(1);
    expect(scope.store.events.filter((event) => event.repositoryId === repositoryId).map((event) => event.logicalEventKey)).toEqual([
      ...new Set(scope.store.events.filter((event) => event.repositoryId === repositoryId).map((event) => event.logicalEventKey)),
    ]);

    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId: runId, page: 1 }, scope.deps);
    expect(app.redelivered).toEqual([99]);
    expect(operationalText(scope)).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPOSITORY_CANARY|PRIVATE_COMMIT_CANARY/);
  });

  it("requests authoritative redelivery for a missed supported delivery without synthesizing source facts", async () => {
    const app = appClient({});
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    expect(app.redelivered).toEqual([99]);
    expect(scope.store.deliveries.size).toBe(0);
    expect(scope.store.commits.size).toBe(0);
    expect(scope.store.events).toHaveLength(0);
    expect((await scope.store.getGithubDeliveryRepair(guid))?.githubDeliveryId).toBe(99);
  });

  it("does not reopen processed or ignored local work", async () => {
    for (const state of ["processed", "ignored"] as const) {
      const app = appClient({ deliveries: [failedDelivery({ guid: `${guid.slice(0, -1)}${state === "processed" ? "1" : "2"}` })] });
      const scope = await setup(app);
      const rowGuid = failedDelivery({ guid: `${guid.slice(0, -1)}${state === "processed" ? "1" : "2"}` }).guid;
      const delivery = await scope.store.insertDelivery({ tenantId, guid: rowGuid, eventName: "push", installationGithubId, payloadExpiresAt: new Date("2026-09-05T00:00:00Z"), now: now() });
      await scope.store.updateDelivery(delivery.record.id, { state }, tenantId);
      await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
      await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
      expect(app.redelivered).toEqual([]);
      expect((await scope.store.getDelivery(delivery.record.id))?.state).toBe(state);
      expect((await scope.store.getGithubDeliveryRepair(rowGuid))?.status).toBe("skipped_terminal");
    }
  });

  it("re-checks local processing state before requesting redelivery", async () => {
    const app = appClient({});
    const scope = await setup(app);
    const delivery = await scope.store.insertDelivery({ tenantId, guid, eventName: "push", installationGithubId, payloadExpiresAt: new Date("2026-09-05T00:00:00Z"), now: now() });
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    const originalClaim = scope.store.claimGithubDeliveryRedelivery.bind(scope.store);
    scope.store.claimGithubDeliveryRedelivery = async (input) => {
      await scope.store.updateDelivery(delivery.record.id, { state: "processing" }, tenantId);
      return originalClaim(input);
    };
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    expect(app.redelivered).toEqual([]);
    expect((await scope.store.getGithubDeliveryRepair(guid))?.status).toBe("skipped_processing");
  });

  it("replays an identical audit page without duplicate repairs or extra redelivery", async () => {
    const app = appClient({});
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    expect(app.redelivered).toEqual([99]);
    expect(scope.store.githubDeliveryRepairs.size).toBe(1);
    expect((await scope.store.getGithubDeliveryRepair(guid))?.attemptCount).toBe(1);
  });

  it("resumes after a worker stop without duplicating local delivery or source rows", async () => {
    const app = appClient({});
    const first = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, first.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, first.deps);
    const replacement = { store: first.store, jobs: new InMemoryJobPort(), githubApp: app, logger: createLogger(first.capture.sink), now };
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, replacement);
    expect(app.redelivered).toEqual([99]);
    expect(first.store.deliveries.size).toBe(0);
    expect(first.store.commits.size).toBe(0);
    expect(first.store.githubDeliveryRepairs.size).toBe(1);
  });

  it("does not advance the success checkpoint when listing is rate limited", async () => {
    const resumeAt = new Date("2026-08-29T12:15:00Z");
    const app = appClient({ listError: new GithubRateLimitPauseError("primary_rate_limit", 403, resumeAt) });
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    const audit = await scope.store.getGithubDeliveryAudit(githubAppId);
    expect(audit?.status).toBe("paused");
    expect(audit?.pageNumber).toBe(1);
    expect(audit?.highWaterDeliveredAt).toBeUndefined();
    expect(audit?.listCursor).toBeUndefined();
    expect(app.redelivered).toEqual([]);
    const wake = [...scope.jobs.jobs.values()].find((job) => job.logicalKey.includes(":wake:"));
    expect(wake?.payload).toMatchObject({ githubAppId, auditRunId, page: 1 });
  });

  it("does not use a user OAuth token or installation client for audit/redelivery", async () => {
    const app = appClient({});
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processQueueJob(
      { id: "audit-job", kind: "github_delivery_audit", logicalKey: "delivery-audit", payload: { kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 } },
      {
        config,
        store: scope.store,
        jobs: scope.jobs,
        githubApp: app,
        githubForInstallation: () => { throw new Error("installation token path invoked"); },
        logger: createLogger(scope.capture.sink),
        now,
      },
    );
    expect(app.listed).toBe(1);
    expect(app.redelivered).toEqual([99]);
  });

  it("ignores unsupported events and successful newest attempts", async () => {
    const app = appClient({
      deliveries: [
        failedDelivery({ id: 1, guid: "11111111-1111-1111-1111-111111111111", eventName: "workflow_run", statusCode: 500 }),
        failedDelivery({ id: 2, guid: "22222222-2222-2222-2222-222222222222", eventName: "push", statusCode: 200 }),
      ],
    });
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    expect(app.redelivered).toEqual([]);
    expect(scope.store.githubDeliveryRepairs.size).toBe(1);
    expect((await scope.store.getGithubDeliveryRepair("22222222-2222-2222-2222-222222222222"))?.status).toBe("healthy");
  });

  it("keeps private canaries out of queue payloads, keys, logs, and audit records", async () => {
    const app = appClient({
      deliveries: [failedDelivery()],
    });
    const scope = await setup(app);
    await enqueueGithubDeliveryAudit({ githubAppId, auditRunId }, scope.deps);
    await processGithubDeliveryAudit({ kind: "github_delivery_audit", githubAppId, auditRunId, page: 1 }, scope.deps);
    const audit = await scope.store.getGithubDeliveryAudit(githubAppId);
    const repair = await scope.store.getGithubDeliveryRepair(guid);
    const text = operationalText(scope, { audit, repair });
    expect(text).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPOSITORY_CANARY|PRIVATE_COMMIT_CANARY|ghp_/);
    for (const job of scope.jobs.jobs.values()) {
      expect(job.logicalKey).not.toMatch(/PRIVATE|canary/i);
      expect(job.payload).not.toHaveProperty("owner");
      expect(job.payload).not.toHaveProperty("repo");
      expect(job.payload).not.toHaveProperty("title");
    }
  });
});
