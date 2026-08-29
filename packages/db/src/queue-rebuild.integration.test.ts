import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.5 PostgreSQL queue-rebuild discovery tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("M5.5 PostgreSQL queue rebuild discovery", () => {
  it("lists the current generation, audit, recoverable repairs, and incomplete windows without private content", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const githubAppId = 910_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
    const githubUserId = githubAppId + 1;
    const installationGithubId = githubAppId + 2;
    const guidPending = randomUUID();
    const guidHealthy = randomUUID();
    const now = new Date("2026-08-29T12:00:00Z");
    const pool = createPool(databaseUrl as string, 3);
    const admin = createPool(databaseUrl as string, 2);
    const store = new PostgresM1Store(pool);
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubUserId, login: "PRIVATE_OWNER_CANARY", displayName: "owner" });
      await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubUserId });
      await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: githubAppId + 3, ownerLogin: "PRIVATE_REPOSITORY_NAME", name: "PRIVATE_REPOSITORY_NAME", fullName: "PRIVATE_REPOSITORY_NAME/repo", private: true, defaultBranch: "main" });
      for (const reconciliationRunId of runIds) {
        await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId, now });
      }
      await admin.query(
        "update sync_cursors set status='completed', completed_at=$3 where tenant_id=$1 and repository_id=$2 and resource_type in ('default_branch_commits','branches','tags','pull_requests')",
        [tenantId, repositoryId, now],
      );
      await admin.query(
        "update sync_cursors set status='in_progress', cursor = cursor || jsonb_build_object('nextPage', 3, 'mode', 'structural') where tenant_id=$1 and repository_id=$2 and resource_type='issues'",
        [tenantId, repositoryId],
      );
      const audit = await store.startGithubDeliveryAudit({ githubAppId, auditRunId: randomUUID(), now });
      await admin.query("update github_delivery_audits set generation=6, page_number=4, list_cursor=$2 where github_app_id=$1", [githubAppId, "cursor-x"]);
      await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: guidPending, githubDeliveryId: githubAppId + 4, githubAppId, auditRunId: audit.currentRunId, eventName: "push", statusCode: 500, deliveredAt: now, now });
      await store.observeGithubDeliveryAttempt({ githubDeliveryGuid: guidHealthy, githubDeliveryId: githubAppId + 5, githubAppId, auditRunId: audit.currentRunId, eventName: "push", statusCode: 200, deliveredAt: now, now });
      await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now });

      const targets = await store.listQueueRebuildReconciliationTargets();
      expect(targets).toEqual([expect.objectContaining({
        tenantId,
        repositoryId,
        installationGithubId,
        reconciliationRunId: runIds[3],
        generation: 4,
        stage: "issues",
        status: "in_progress",
        nextPage: 3,
        completed: false,
        blocked: false,
      })]);
      expect(await store.getQueueRebuildDeliveryAudit(githubAppId)).toMatchObject({ githubAppId, generation: 6, pageNumber: 4, listCursor: "cursor-x", currentRunId: audit.currentRunId });
      const repairs = await store.listRecoverableGithubDeliveryRepairs(githubAppId);
      expect(repairs.map((row) => row.githubDeliveryGuid).sort()).toEqual([guidPending]);
      expect(await store.listIncompleteMaintenanceWindows()).toEqual([expect.objectContaining({ task: "delivery_audit", bucket: "20260829T12", acceptedJobId: "old-job" })]);
      const serialized = JSON.stringify({ targets, audit: await store.getQueueRebuildDeliveryAudit(githubAppId), repairs, windows: await store.listIncompleteMaintenanceWindows() });
      expect(serialized).not.toMatch(/PRIVATE_OWNER_CANARY|PRIVATE_REPOSITORY_NAME|PRIVATE_COMMIT_MESSAGE|PRIVATE_PR_TITLE|PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_TOKEN/);
    } finally {
      await admin.query("delete from maintenance_windows where accepted_job_id=$1", ["old-job"]);
      await admin.query("delete from github_delivery_repairs where github_app_id=$1", [githubAppId]);
      await admin.query("delete from github_delivery_audits where github_app_id=$1", [githubAppId]);
      await admin.query("delete from sync_cursors where tenant_id=$1", [tenantId]);
      await admin.query("delete from reconciliation_generations where tenant_id=$1", [tenantId]);
      await admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
      await admin.query("delete from repositories where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      const users = await admin.query<{ id: string; account_id: string }>("select u.id,ga.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts ga on ga.id=i.github_account_id where u.primary_tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from users where primary_tenant_id=$1", [tenantId]);
      await admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await pool.end();
      await admin.end();
    }
  });
});
