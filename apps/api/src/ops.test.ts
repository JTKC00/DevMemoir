import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { DELIVERY_REPAIR_LARGE_BACKLOG_THRESHOLD, InMemoryM1Store, OPERATIONAL_STUCK_WORK_MS, WORKER_HEARTBEAT_STALE_MS } from "@devmemoir/db";
import { hashOpaqueToken } from "@devmemoir/domain";
import type { GithubClient } from "@devmemoir/github";
import { InMemoryJobPort } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { buildApi } from "./app.js";
import { resetOperationalWarningThrottle } from "./ops-health.js";

const now = new Date("2026-08-29T12:00:00Z");
const config = { NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000", DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2, GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "webhook-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7, ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1" } satisfies AppConfig;
const github = { getUser: async () => ({ id: 7, login: "owner", type: "User" }), exchangeOAuthCode: async () => ({ accessToken: "token" }), getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }), listInstallationRepositories: async () => ({ repositories: [] }), getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }), listCommits: async () => ({ commits: [] }), listBranches: async () => ({ branches: [] }), listTags: async () => ({ tags: [] }), listPullRequests: async () => ({ pullRequests: [] }), listIssues: async () => ({ issues: [] }), listReleases: async () => ({ releases: [] }), getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }), getRefHead: async () => "a".repeat(40) } satisfies GithubClient;

describe("M5.4 owner operations API", () => {
  let store: InMemoryM1Store; let jobs: InMemoryJobPort; let app: Awaited<ReturnType<typeof buildApi>>; let capture: ReturnType<typeof createCanarySink>;
  const headersFor = (token: string) => ({ authorization: `Bearer ${token}`, "x-devmemoir-csrf": "csrf" });
  beforeEach(async () => {
    store = new InMemoryM1Store(); jobs = new InMemoryJobPort(); capture = createCanarySink();
    await store.upsertUser({ userId: "owner-user", tenantId: "tenant", githubAccountId: 7, login: "owner", displayName: "owner" });
    await store.upsertUser({ userId: "other-user", tenantId: "other", githubAccountId: 8, login: "other", displayName: "other" });
    for (const [token, userId, tenantId] of [["owner-token", "owner-user", "tenant"], ["other-token", "other-user", "other"]] as const) await store.createSession({ userId, tenantId, tokenHash: hashOpaqueToken(token, config.SESSION_SECRET), csrfTokenHash: hashOpaqueToken("csrf", config.SESSION_SECRET), expiresAt: new Date(now.getTime() + 60_000) });
    await store.saveInstallation({ id: "installation", tenantId: "tenant", githubInstallationId: 22, accountGithubAccountId: 7 });
    await store.saveRepository({ id: "repo-opaque", tenantId: "tenant", installationId: "installation", githubRepositoryId: 10, ownerLogin: "PRIVATE_REPO_CANARY", name: "PRIVATE_REPO_CANARY", fullName: "PRIVATE_REPO_CANARY/repo", private: true, defaultBranch: "main", selected: true, accessStatus: "accessible" });
    for (const [index, task] of ["active_reconciliation", "authorized_reconciliation", "delivery_audit"].entries()) { const bucket = index === 1 ? "2026-08-29" : "20260829T12"; await store.claimMaintenanceWindow({ task: task as "active_reconciliation", bucket, jobKind: `maintenance_${index}`, jobId: `job-${index}`, now }); await store.completeMaintenanceWindow({ task: task as "active_reconciliation", bucket, jobId: `job-${index}`, now }); }
    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000099", startedAt: now, now });
    resetOperationalWarningThrottle();
    app = await buildApi({ config, store, github, jobs, logger: createLogger(capture.sink), now: () => now });
  });
  afterEach(async () => app.close());

  it("returns 401 unauthenticated, 403 to a non-owner, and sanitized metadata to the owner", async () => {
    expect((await app.inject({ method: "GET", url: "/api/ops/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("other-token") })).statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("owner-token") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      overall: "healthy",
      repositories: [{ repositoryId: "repo-opaque", installationGithubId: 22, state: "never_run" }],
      deliveryRepairs: { recoverable: 0, terminal: 0 },
      operations: {
        worker: { state: "healthy", liveWorkers: 1, staleWorkers: 0, lastHeartbeatAt: now.toISOString() },
        reconciliation: { activeAgeSeconds: 0, authorizedAgeSeconds: 0, stuckCount: 0 },
        githubQuota: { pausedInstallations: 0, appAuditPaused: false },
        leases: { expiredProcessing: 0, stuckReconciliations: 0, stuckAudits: 0, stuckMaintenanceWindows: 0 },
        repairs: { recoverableBacklog: 0, pausedRecoverable: 0, readyRecoverable: 0, exhausted: 0, needsAttention: false },
      },
    });
    expect(response.body).not.toContain("PRIVATE_REPO_CANARY");
  });

  it("omits unselected and access-removed repositories from owner health", async () => {
    const included = await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("owner-token") });
    expect(included.json<{ repositories: Array<{ repositoryId: string }> }>().repositories).toEqual([expect.objectContaining({ repositoryId: "repo-opaque" })]);
    store.repositories.set("tenant:10", { ...store.repositories.get("tenant:10")!, selected: false });
    const unselected = await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("owner-token") });
    expect(unselected.statusCode).toBe(200);
    expect(unselected.json<{ repositories: unknown[] }>().repositories).toEqual([]);
    store.repositories.set("tenant:10", { ...store.repositories.get("tenant:10")!, selected: true, accessStatus: "access_removed" });
    const removed = await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("owner-token") });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ repositories: unknown[] }>().repositories).toEqual([]);
  });

  it("enforces the same owner authorization on every recovery endpoint", async () => {
    for (const [url, method] of [["/api/ops/repositories/repo-opaque/reconcile", "POST"], ["/api/ops/delivery-audit/retry", "POST"], ["/api/ops/delivery-repairs/resume", "POST"]] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: headersFor("other-token") })).statusCode).toBe(403);
    }
  });

  it("deduplicates concurrent reconciliation, preserves future pause, and rejects ineligible repositories", async () => {
    const requests = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })));
    expect(requests.map((response) => response.statusCode)).toEqual([202, 202]);
    expect([...jobs.jobs.values()].filter((job) => job.kind === "repository_reconciliation")).toHaveLength(1);
    const runId = (jobs.jobs.values().next().value?.payload as { reconciliationRunId: string }).reconciliationRunId;
    await store.startRepositoryReconciliation({ tenantId: "tenant", repositoryId: "repo-opaque", installationId: "installation", defaultBranch: "main", reconciliationRunId: runId, now });
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "already_in_progress" });
    await store.pauseHistoricalStage({ tenantId: "tenant", repositoryId: "repo-opaque", stage: "default_branch_commits", refName: "main", pausedUntil: new Date(now.getTime() + 60_000), errorCode: "github_primary_rate_limit", expectedReconciliationRunId: runId });
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "paused", retryAfter: new Date(now.getTime() + 60_000).toISOString() });
    store.repositories.set("tenant:10", { ...store.repositories.get("tenant:10")!, selected: false });
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "not_eligible" });
    store.repositories.set("tenant:10", { ...store.repositories.get("tenant:10")!, selected: true, accessStatus: "access_removed" });
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "not_eligible" });
    store.repositories.set("tenant:10", { ...store.repositories.get("tenant:10")!, accessStatus: "accessible" });
    await store.updateInstallationLifecycle(22, "suspended", now);
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/repo-opaque/reconcile", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "not_eligible" });
    expect((await app.inject({ method: "POST", url: "/api/ops/repositories/unknown/reconcile", headers: headersFor("owner-token") })).statusCode).toBe(404);
  });

  it("deduplicates audit retry and resumes only recoverable repairs without resetting terminal metadata", async () => {
    const audit = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/ops/delivery-audit/retry", headers: headersFor("owner-token") })));
    expect(audit.map((response) => response.json<{ result: string }>().result)).toEqual(["enqueued", "enqueued"]);
    const recoveryJobs = [...jobs.jobs.values()].filter((job) => job.kind === "github_delivery_audit_recovery");
    expect(recoveryJobs).toHaveLength(1);
    const runId = (recoveryJobs[0]!.payload as { auditRunId: string }).auditRunId;
    await store.startGithubDeliveryAudit({ githubAppId: 1, auditRunId: runId, now });
    const pausedUntil = new Date(now.getTime() + 60_000);
    await store.pauseGithubDeliveryAudit({ githubAppId: 1, auditRunId: runId, pausedUntil, errorCode: "github_primary_rate_limit" });
    expect((await app.inject({ method: "POST", url: "/api/ops/delivery-audit/retry", headers: headersFor("owner-token") })).json()).toMatchObject({ result: "paused", retryAfter: pausedUntil.toISOString() });
    const statusByGuid = new Map([["00000000-0000-4000-8000-000000000010", "pending"], ["00000000-0000-4000-8000-000000000011", "exhausted"], ["00000000-0000-4000-8000-000000000012", "expired"], ["00000000-0000-4000-8000-000000000013", "skipped_terminal"], ["00000000-0000-4000-8000-000000000014", "healthy"]] as const);
    let githubDeliveryId = 10;
    for (const [guid, status] of statusByGuid) {
      await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: guid, githubDeliveryId: githubDeliveryId++, githubAppId: 1, auditRunId: runId, eventName: "PRIVATE_EVENT_CANARY", statusCode: status === "healthy" ? 200 : 500, deliveredAt: now, now });
      if (status !== "pending" && status !== "healthy") await store.markGithubDeliveryRepair({ guid, status, errorCode: `terminal_${status}`, now });
    }
    const terminalBefore = new Map(await Promise.all([...statusByGuid].filter(([, status]) => status !== "pending").map(async ([guid]) => [guid, await store.getGithubDeliveryRepair(guid)] as const)));
    const response = await app.inject({ method: "POST", url: "/api/ops/delivery-repairs/resume", headers: headersFor("owner-token") });
    expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({ recoverableFound: 1, enqueued: 1, skipped: 0 });
    for (const [guid, record] of terminalBefore) expect(await store.getGithubDeliveryRepair(guid)).toEqual(record);
    expect(response.body + capture.text()).not.toContain("PRIVATE_EVENT_CANARY");
  });

  it("reports worker heartbeat age, stale/live mix, graceful stop, and never-seen", async () => {
    const owner = headersFor("owner-token");
    const fresh = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(fresh.json()).toMatchObject({ overall: "healthy", operations: { worker: { state: "healthy", liveWorkers: 1, staleWorkers: 0 } } });

    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000098", startedAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000), now: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000) });
    const mixed = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(mixed.json()).toMatchObject({ overall: "healthy", operations: { worker: { state: "healthy", liveWorkers: 1, staleWorkers: 1 } } });

    store.workerHeartbeats.clear();
    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000097", startedAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000), now: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000) });
    const stale = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(stale.json()).toMatchObject({ overall: "attention_required", operations: { worker: { state: "stale", liveWorkers: 0, staleWorkers: 1 } } });

    await store.markWorkerStopped({ workerInstanceId: "00000000-0000-4000-8000-000000000097", now });
    const stopped = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(stopped.json()).toMatchObject({ overall: "degraded", operations: { worker: { state: "stopped", liveWorkers: 0, staleWorkers: 0 } } });

    store.workerHeartbeats.clear();
    const unseen = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(unseen.json()).toMatchObject({ overall: "degraded", operations: { worker: { state: "never_seen", liveWorkers: 0, staleWorkers: 0 } } });
  });

  it("reports stuck work, valid pauses, quota, repair exhaustion, and omits private canaries", async () => {
    const owner = headersFor("owner-token");
    const old = new Date(now.getTime() - OPERATIONAL_STUCK_WORK_MS - 1_000);
    const runId = "00000000-0000-4000-8000-000000000040";
    await store.startRepositoryReconciliation({ tenantId: "tenant", repositoryId: "repo-opaque", installationId: "installation", defaultBranch: "main", reconciliationRunId: runId, now: old });
    await store.startGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000041", now: old });
    const delivery = await store.insertDelivery({ tenantId: "tenant", guid: "00000000-0000-4000-8000-000000000042", eventName: "push", payloadExpiresAt: new Date(now.getTime() + 60_000), now: old });
    await store.claimDeliveryForProcessing(delivery.record.id, "tenant", old);
    await store.claimMaintenanceWindow({ task: "active_reconciliation", bucket: "20260828T12", jobKind: "maintenance_active", jobId: "stuck-window", now: old });
    await store.pauseInstallationApi({ tenantId: "tenant", installationId: "installation", pausedUntil: new Date(now.getTime() + 60_000), reason: "github_primary_rate_limit" });
    await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: "00000000-0000-4000-8000-000000000043", githubDeliveryId: 43, githubAppId: 1, auditRunId: runId, eventName: "PRIVATE_WEBHOOK_PAYLOAD", statusCode: 500, deliveredAt: now, now });
    await store.markGithubDeliveryRepair({ guid: "00000000-0000-4000-8000-000000000043", status: "exhausted", errorCode: "repair_exhausted", now });

    const stuck = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(stuck.json()).toMatchObject({
      overall: "attention_required",
      operations: {
        reconciliation: { stuckCount: 1 },
        githubQuota: { pausedInstallations: 1, earliestResumeAt: new Date(now.getTime() + 60_000).toISOString() },
        leases: { expiredProcessing: 1, stuckReconciliations: 1, stuckAudits: 1, stuckMaintenanceWindows: 1 },
        repairs: { exhausted: 1 },
      },
    });
    expect(stuck.body + capture.text()).not.toMatch(/PRIVATE_REPOSITORY_NAME|PRIVATE_COMMIT_MESSAGE|PRIVATE_PR_TITLE|PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_TOKEN|PRIVATE_SECRET|PRIVATE_REPO_CANARY/);

    store.workerHeartbeats.clear();
    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000099", startedAt: now, now });
    await store.pauseHistoricalStage({ tenantId: "tenant", repositoryId: "repo-opaque", stage: "default_branch_commits", refName: "main", pausedUntil: new Date(now.getTime() + 120_000), errorCode: "github_primary_rate_limit", expectedReconciliationRunId: runId });
    await store.pauseGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000041", pausedUntil: new Date(now.getTime() + 90_000), errorCode: "github_primary_rate_limit" });
    const paused = await app.inject({ method: "GET", url: "/api/ops/health", headers: owner });
    expect(paused.json()).toMatchObject({
      operations: {
        leases: { stuckReconciliations: 0, stuckAudits: 0 },
        githubQuota: { appAuditPaused: true, appAuditResumeAt: new Date(now.getTime() + 90_000).toISOString() },
      },
    });
    expect(paused.json().operations.leases.expiredProcessing).toBe(1);
    expect(["degraded", "attention_required"]).toContain(paused.json().overall);
  });

  it("does not raise attention_required for a large recoverable backlog that is almost entirely cooling down", async () => {
    const future = new Date(now.getTime() + 60_000);
    const auditRunId = "00000000-0000-4000-8000-000000000060";
    for (let index = 0; index < DELIVERY_REPAIR_LARGE_BACKLOG_THRESHOLD; index += 1) {
      const guid = `00000000-0000-4000-8a00-${String(index).padStart(12, "0")}`;
      await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: guid, githubDeliveryId: 200 + index, githubAppId: 1, auditRunId, eventName: "push", statusCode: 500, deliveredAt: now, now });
      if (index < DELIVERY_REPAIR_LARGE_BACKLOG_THRESHOLD - 1) await store.deferGithubDeliveryRedelivery({ guid, resumeAt: future, errorCode: "github_primary_rate_limit", now });
    }
    const response = await app.inject({ method: "GET", url: "/api/ops/health", headers: headersFor("owner-token") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      overall: "degraded",
      operations: { repairs: { recoverableBacklog: 25, pausedRecoverable: 24, readyRecoverable: 1, exhausted: 0, needsAttention: false } },
    });
    expect(capture.text()).not.toContain("delivery_repair_attention");
  });
});
