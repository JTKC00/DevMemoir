import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";
import { OPERATIONAL_STUCK_WORK_MS, WORKER_HEARTBEAT_RETENTION_MS, WORKER_HEARTBEAT_STALE_MS } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.4 PostgreSQL operational-health tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("M5.4 PostgreSQL operational aggregation", () => {
  it("reads owner-visible M5.1/M5.2 state, maintenance windows, and exact repair counts without private content", async () => {
    const tenantId = randomUUID(); const userId = randomUUID(); const installationId = randomUUID(); const repositoryId = randomUUID(); const runId = randomUUID(); const guid = randomUUID();
    const githubAppId = 900_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
    const githubUserId = githubAppId + 1; const installationGithubId = githubAppId + 2;
    const day = String(1 + (Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16) % 28)).padStart(2, "0");
    const bucket = `209912${day}T00`; const jobId = `ops-${tenantId}`;
    const pool = createPool(databaseUrl as string, 3); const admin = createPool(databaseUrl as string, 2); const store = new PostgresM1Store(pool); const now = new Date(`2099-12-${day}T00:00:00Z`);
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubUserId, login: "PRIVATE_OWNER_CANARY", displayName: "owner" });
      await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubUserId });
      await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: githubAppId + 3, ownerLogin: "PRIVATE_REPO_CANARY", name: "PRIVATE_REPO_CANARY", fullName: "PRIVATE_REPO_CANARY/repo", private: true, defaultBranch: "main" });
      await store.selectRepository(tenantId, repositoryId);
      await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runId, now });
      await store.startGithubDeliveryAudit({ githubAppId, auditRunId: randomUUID(), now });
      await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: guid, githubDeliveryId: githubAppId + 4, githubAppId, auditRunId: runId, eventName: "PRIVATE_EVENT_CANARY", statusCode: 500, deliveredAt: now, now });
      await store.claimMaintenanceWindow({ task: "active_reconciliation", bucket, jobKind: "maintenance_active", jobId, now });
      await store.completeMaintenanceWindow({ task: "active_reconciliation", bucket, jobId, now });

      const repositories = await store.listRepositoryOperationalHealth(tenantId);
      const audit = await store.getGithubDeliveryAudit(githubAppId);
      const repairs = await store.getDeliveryRepairStatusCounts(githubAppId);
      const maintenance = await store.listMaintenanceOperationalHealth();
      expect(repositories).toMatchObject([{ repositoryId, installationGithubId, generation: { generation: 1, reconciliationRunId: runId } }]);
      expect(repositories[0]?.progress).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "default_branch_commits", status: "in_progress" })]));
      expect(audit).toMatchObject({ githubAppId, generation: 1, status: "in_progress" });
      expect(repairs).toEqual({ pending: 1, requesting: 0, requested: 0, skipped_processing: 0, healthy: 0, expired: 0, exhausted: 0, skipped_terminal: 0 });
      expect(maintenance).toEqual(expect.arrayContaining([expect.objectContaining({ task: "active_reconciliation", bucket, completedAt: now })]));
      expect(JSON.stringify({ repositories, audit, repairs, maintenance: maintenance.filter((row) => row.bucket === bucket) })).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPO_CANARY|PRIVATE_EVENT_CANARY/);
    } finally {
      await admin.query("delete from maintenance_windows where accepted_job_id=$1", [jobId]);
      await admin.query("delete from github_delivery_repairs where github_app_id=$1", [githubAppId]);
      await admin.query("delete from github_delivery_audits where github_app_id=$1", [githubAppId]);
      await admin.query("delete from sync_cursors where tenant_id=$1", [tenantId]);
      await admin.query("delete from reconciliation_generations where tenant_id=$1", [tenantId]);
      await admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
      await admin.query("delete from repositories where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id=$1", [userId]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from users where id=$1", [userId]);
      await admin.query("delete from github_accounts where github_account_id=$1", [githubUserId]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await pool.end(); await admin.end();
    }
  });

  it("includes only selected accessible repositories on an active installation", async () => {
    const tenantId = randomUUID(); const userId = randomUUID(); const installationId = randomUUID();
    const githubAppId = 800_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
    const githubUserId = githubAppId + 1; const installationGithubId = githubAppId + 2;
    const selectedGithubId = githubAppId + 3; const unselectedGithubId = githubAppId + 4;
    const pool = createPool(databaseUrl as string, 3); const admin = createPool(databaseUrl as string, 2); const store = new PostgresM1Store(pool);
    const now = new Date("2099-11-01T00:00:00Z");
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubUserId, login: "owner", displayName: "owner" });
      await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubUserId });
      await store.reconcileInstallationInventory({
        tenantId,
        githubInstallationId: installationGithubId,
        observedAt: now,
        repositories: [
          { id: randomUUID(), tenantId, installationId, githubRepositoryId: selectedGithubId, ownerLogin: "owner", name: "selected", fullName: "owner/selected", private: true, defaultBranch: "main" },
          { id: randomUUID(), tenantId, installationId, githubRepositoryId: unselectedGithubId, ownerLogin: "owner", name: "unselected", fullName: "owner/unselected", private: true, defaultBranch: "main" },
        ],
      });
      const selected = await store.getRepositoryByGithubId(tenantId, selectedGithubId);
      const unselected = await store.getRepositoryByGithubId(tenantId, unselectedGithubId);
      expect(selected && unselected).toBeTruthy();
      await store.selectRepository(tenantId, selected!.id);
      expect(await store.listRepositoryOperationalHealth(tenantId)).toEqual([expect.objectContaining({ repositoryId: selected!.id, installationGithubId })]);

      await store.unselectRepository(tenantId, selected!.id);
      expect(await store.listRepositoryOperationalHealth(tenantId)).toEqual([]);

      await store.selectRepository(tenantId, selected!.id);
      await store.reconcileInstallationInventory({
        tenantId,
        githubInstallationId: installationGithubId,
        observedAt: new Date(now.getTime() + 1_000),
        repositories: [{ id: unselected!.id, tenantId, installationId, githubRepositoryId: unselectedGithubId, ownerLogin: "owner", name: "unselected", fullName: "owner/unselected", private: true, defaultBranch: "main" }],
      });
      expect(await store.getRepositoryByGithubId(tenantId, selectedGithubId)).toMatchObject({ accessStatus: "access_removed", selected: false });
      expect(await store.listRepositoryOperationalHealth(tenantId)).toEqual([]);

      await store.selectRepository(tenantId, unselected!.id);
      expect(await store.listRepositoryOperationalHealth(tenantId)).toEqual([expect.objectContaining({ repositoryId: unselected!.id })]);

      await store.updateInstallationLifecycle(installationGithubId, "suspended", now);
      expect(await store.listRepositoryOperationalHealth(tenantId)).toEqual([]);
    } finally {
      await admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
      await admin.query("delete from repositories where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id=$1", [userId]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from users where id=$1", [userId]);
      await admin.query("delete from github_accounts where github_account_id=$1", [githubUserId]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await pool.end(); await admin.end();
    }
  });
});

describeIntegration("M5.6 PostgreSQL worker health, quota, and stuck-work queries", () => {
  it("persists heartbeats, derives states, and aggregates opaque pause/stuck counts without private content", async () => {
    const tenantId = randomUUID(); const userId = randomUUID(); const installationId = randomUUID(); const repositoryId = randomUUID();
    const liveWorker = randomUUID(); const staleWorker = randomUUID();
    const githubAppId = 910_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
    const githubUserId = githubAppId + 1; const installationGithubId = githubAppId + 2;
    const guid = randomUUID(); const runId = randomUUID(); const auditRunId = randomUUID();
    const pool = createPool(databaseUrl as string, 3); const admin = createPool(databaseUrl as string, 2); const store = new PostgresM1Store(pool);
    const now = new Date("2099-10-15T00:00:00Z");
    const old = new Date(now.getTime() - OPERATIONAL_STUCK_WORK_MS - 5_000);
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubUserId, login: "PRIVATE_OWNER_CANARY", displayName: "owner" });
      await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubUserId });
      await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: githubAppId + 3, ownerLogin: "PRIVATE_REPO_CANARY", name: "PRIVATE_REPO_CANARY", fullName: "PRIVATE_REPO_CANARY/repo", private: true, defaultBranch: "main" });
      await store.selectRepository(tenantId, repositoryId);

      expect(await store.getWorkerOperationalHealth({ now })).toEqual({ state: "never_seen", liveWorkers: 0, staleWorkers: 0 });
      await store.recordWorkerHeartbeat({ workerInstanceId: liveWorker, startedAt: now, now });
      await store.recordWorkerHeartbeat({ workerInstanceId: staleWorker, startedAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000), now: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1_000) });
      expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "healthy", liveWorkers: 1, staleWorkers: 1, lastHeartbeatAt: now });
      await store.markWorkerStopped({ workerInstanceId: liveWorker, now });
      expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "stale", liveWorkers: 0, staleWorkers: 1 });
      await store.markWorkerStopped({ workerInstanceId: staleWorker, now });
      expect(await store.getWorkerOperationalHealth({ now })).toMatchObject({ state: "stopped", liveWorkers: 0, staleWorkers: 0 });
      expect(await store.pruneOldWorkerHeartbeats({ before: new Date(now.getTime() - WORKER_HEARTBEAT_RETENTION_MS) })).toBe(0);
      expect(await store.pruneOldWorkerHeartbeats({ before: new Date(now.getTime() + 1) })).toBe(2);
      expect(await store.getWorkerOperationalHealth({ now })).toEqual({ state: "never_seen", liveWorkers: 0, staleWorkers: 0 });
      await store.recordWorkerHeartbeat({ workerInstanceId: liveWorker, startedAt: now, now });

      await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runId, now: old });
      await store.startGithubDeliveryAudit({ githubAppId, auditRunId, now: old });
      const delivery = await store.insertDelivery({ tenantId, guid, eventName: "push", payloadExpiresAt: new Date(now.getTime() + 60_000), now: old });
      await store.claimDeliveryForProcessing(delivery.record.id, tenantId, old);
      await store.claimMaintenanceWindow({ task: "authorized_reconciliation", bucket: "2099-10-14", jobKind: "maintenance_authorized", jobId: `ops-stuck-${tenantId}`, now: old });
      await store.pauseInstallationApi({ tenantId, installationId, pausedUntil: new Date(now.getTime() + 45_000), reason: "github_primary_rate_limit" });
      const stuck = await store.getOperationalLeaseAlerts({ tenantId, githubAppId, now });
      const quota = await store.getGithubQuotaOperationalHealth({ tenantId, githubAppId, now });
      expect(stuck).toMatchObject({ expiredProcessing: 1, stuckReconciliations: 1, stuckAudits: 1, stuckMaintenanceWindows: 1 });
      expect(quota).toMatchObject({ pausedInstallations: 1, appAuditPaused: false, earliestResumeAt: new Date(now.getTime() + 45_000) });

      await store.pauseHistoricalStage({ tenantId, repositoryId, stage: "default_branch_commits", refName: "main", pausedUntil: new Date(now.getTime() + 60_000), errorCode: "github_primary_rate_limit", expectedReconciliationRunId: runId });
      await store.pauseGithubDeliveryAudit({ githubAppId, auditRunId, pausedUntil: new Date(now.getTime() + 90_000), errorCode: "github_retry_after" });
      const paused = await store.getOperationalLeaseAlerts({ tenantId, githubAppId, now });
      const pausedQuota = await store.getGithubQuotaOperationalHealth({ tenantId, githubAppId, now });
      expect(paused).toMatchObject({ expiredProcessing: 1, stuckReconciliations: 0, stuckAudits: 0 });
      expect(pausedQuota).toMatchObject({ pausedInstallations: 1, appAuditPaused: true, appAuditResumeAt: new Date(now.getTime() + 90_000) });
      expect(JSON.stringify({ stuck, quota, paused, pausedQuota, worker: await store.getWorkerOperationalHealth({ now }) })).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPO_CANARY|PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_TOKEN/);
    } finally {
      await admin.query("delete from worker_heartbeats where worker_instance_id=any($1::uuid[])", [[liveWorker, staleWorker]]);
      await admin.query("delete from maintenance_windows where accepted_job_id=$1", [`ops-stuck-${tenantId}`]);
      await admin.query("delete from github_delivery_audits where github_app_id=$1", [githubAppId]);
      await admin.query("delete from webhook_deliveries where tenant_id=$1", [tenantId]);
      await admin.query("delete from sync_cursors where tenant_id=$1", [tenantId]);
      await admin.query("delete from reconciliation_generations where tenant_id=$1", [tenantId]);
      await admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
      await admin.query("delete from repositories where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id=$1", [userId]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from users where id=$1", [userId]);
      await admin.query("delete from github_accounts where github_account_id=$1", [githubUserId]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await pool.end(); await admin.end();
    }
  });
});
