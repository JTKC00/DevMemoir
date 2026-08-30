import { describe, expect, it } from "vitest";
import { InMemoryM1Store, OPERATIONAL_STUCK_WORK_MS, WORKER_HEARTBEAT_RETENTION_MS, WORKER_HEARTBEAT_STALE_MS, type RepositoryRecord } from "./store.js";

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

describe("M5.6 InMemory worker, lease, and quota queries", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  it("derives heartbeat, graceful stop, stale, and retention cleanup", async () => {
    const store = await setup();
    expect(await store.getWorkerOperationalHealth({ now })).toEqual({ state: "never_seen", liveWorkers: 0, staleWorkers: 0 });
    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000001", startedAt: now, now });
    expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "healthy", liveWorkers: 1, staleWorkers: 0, lastHeartbeatAt: now });
    await store.recordWorkerHeartbeat({ workerInstanceId: "00000000-0000-4000-8000-000000000002", startedAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1), now: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1) });
    expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "healthy", liveWorkers: 1, staleWorkers: 1 });
    await store.markWorkerStopped({ workerInstanceId: "00000000-0000-4000-8000-000000000001", now });
    expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "stale", liveWorkers: 0, staleWorkers: 1 });
    await store.markWorkerStopped({ workerInstanceId: "00000000-0000-4000-8000-000000000002", now });
    expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "stopped", liveWorkers: 0, staleWorkers: 0 });
    expect(await store.pruneOldWorkerHeartbeats({ before: new Date(now.getTime() - WORKER_HEARTBEAT_RETENTION_MS) })).toBe(0);
    expect(await store.pruneOldWorkerHeartbeats({ before: new Date(now.getTime() + 1) })).toBe(2);
    expect(await store.getWorkerOperationalHealth({ now })).toEqual({ state: "never_seen", liveWorkers: 0, staleWorkers: 0 });
  });

  it("alerts expired processing leases and ignores valid or terminal deliveries", async () => {
    const store = await setup();
    const expiresAt = new Date(now.getTime() + 60_000);
    const expired = await store.insertDelivery({ tenantId: "tenant-a", guid: "00000000-0000-4000-8000-000000000011", eventName: "push", payloadExpiresAt: expiresAt, now: new Date(now.getTime() - 6 * 60 * 1000) });
    await store.claimDeliveryForProcessing(expired.record.id, "tenant-a", new Date(now.getTime() - 6 * 60 * 1000));
    const valid = await store.insertDelivery({ tenantId: "tenant-a", guid: "00000000-0000-4000-8000-000000000012", eventName: "push", payloadExpiresAt: expiresAt, now });
    await store.claimDeliveryForProcessing(valid.record.id, "tenant-a", now);
    const terminal = await store.insertDelivery({ tenantId: "tenant-a", guid: "00000000-0000-4000-8000-000000000013", eventName: "push", payloadExpiresAt: expiresAt, now: new Date(now.getTime() - 6 * 60 * 1000) });
    await store.claimDeliveryForProcessing(terminal.record.id, "tenant-a", new Date(now.getTime() - 6 * 60 * 1000));
    await store.updateDelivery(terminal.record.id, { state: "processed" }, "tenant-a");
    expect(await store.getOperationalLeaseAlerts({ tenantId: "tenant-a", githubAppId: 1, now })).toMatchObject({ expiredProcessing: 1 });
  });

  it("classifies stuck vs paused reconciliation, audit, and maintenance", async () => {
    const store = await setup();
    await store.saveRepository(repository("repo-selected", 101));
    const old = new Date(now.getTime() - OPERATIONAL_STUCK_WORK_MS - 1_000);
    const runId = "00000000-0000-4000-8000-000000000021";
    await store.startRepositoryReconciliation({ tenantId: "tenant-a", repositoryId: "repo-selected", installationId: "installation-a", defaultBranch: "main", reconciliationRunId: runId, now: old });
    await store.startGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000022", now: old });
    await store.claimMaintenanceWindow({ task: "active_reconciliation", bucket: "20260830T11", jobKind: "maintenance_active", jobId: "old-window", now: old });
    expect(await store.getOperationalLeaseAlerts({ tenantId: "tenant-a", githubAppId: 1, now })).toMatchObject({ stuckReconciliations: 1, stuckAudits: 1, stuckMaintenanceWindows: 1 });

    await store.pauseHistoricalStage({ tenantId: "tenant-a", repositoryId: "repo-selected", stage: "default_branch_commits", refName: "main", pausedUntil: new Date(now.getTime() + 60_000), errorCode: "github_primary_rate_limit", expectedReconciliationRunId: runId });
    await store.pauseGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000022", pausedUntil: new Date(now.getTime() + 60_000), errorCode: "github_primary_rate_limit" });
    expect(await store.getOperationalLeaseAlerts({ tenantId: "tenant-a", githubAppId: 1, now })).toMatchObject({ stuckReconciliations: 0, stuckAudits: 0, stuckMaintenanceWindows: 1 });

    await store.completeMaintenanceWindow({ task: "active_reconciliation", bucket: "20260830T11", jobId: "old-window", now });
    await store.startRepositoryReconciliation({ tenantId: "tenant-a", repositoryId: "repo-selected", installationId: "installation-a", defaultBranch: "main", reconciliationRunId: "00000000-0000-4000-8000-000000000023", now });
    await store.startGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000024", now });
    expect(await store.getOperationalLeaseAlerts({ tenantId: "tenant-a", githubAppId: 1, now })).toMatchObject({ stuckReconciliations: 0, stuckAudits: 0, stuckMaintenanceWindows: 0 });
  });

  it("aggregates installation quota pauses and App-JWT audit pauses", async () => {
    const store = await setup();
    const resumeAt = new Date(now.getTime() + 90_000);
    await store.pauseInstallationApi({ tenantId: "tenant-a", installationId: "installation-a", pausedUntil: resumeAt, reason: "github_primary_rate_limit" });
    await store.startGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000031", now });
    await store.pauseGithubDeliveryAudit({ githubAppId: 1, auditRunId: "00000000-0000-4000-8000-000000000031", pausedUntil: new Date(now.getTime() + 30_000), errorCode: "github_retry_after" });
    expect(await store.getGithubQuotaOperationalHealth({ tenantId: "tenant-a", githubAppId: 1, now })).toEqual({
      pausedInstallations: 1,
      earliestResumeAt: resumeAt,
      latestResumeAt: resumeAt,
      appAuditPaused: true,
      appAuditResumeAt: new Date(now.getTime() + 30_000),
    });
  });
});
