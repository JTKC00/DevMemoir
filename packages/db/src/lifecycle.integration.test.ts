import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";
import { withTenantWork } from "./lifecycle.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for lifecycle tests");

(databaseUrl ? describe : describe.skip)("PostgreSQL tenant lifecycle", () => {
  it("serializes revocation, purges raw payloads, and fences old work after reconnect with runtime roles", async () => {
    const admin = createPool(databaseUrl as string, 3);
    const api = createPool(databaseUrl as string, 1);
    const worker = createPool(databaseUrl as string, 1);
    const store = new PostgresM1Store(admin);
    const apiStore = new PostgresM1Store(api);
    const workerStore = new PostgresM1Store(worker);
    const tenantId = randomUUID();
    const userId = randomUUID();
    const githubId = 3_000_000_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
    const installation = { id: randomUUID(), tenantId, githubInstallationId: githubId + 1, accountGithubAccountId: githubId };
    const repository = { id: randomUUID(), tenantId, installationId: installation.id, githubRepositoryId: githubId + 2, ownerLogin: "fixture", name: "repo", fullName: "fixture/repo", private: true, defaultBranch: "main" };
    const now = new Date();
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubId, login: "fixture", displayName: "Fixture" });
      await store.saveInstallation(installation);
      await store.saveRepository(repository);
      const delivery = await store.insertDelivery({ tenantId, guid: randomUUID(), eventName: "push", payloadCiphertext: "synthetic-ciphertext", payloadExpiresAt: now, now });
      await api.query("set role devmemoir_api");
      await worker.query("set role devmemoir_worker");
      await expect(workerStore.disconnectTenant(tenantId, now)).rejects.toMatchObject({ code: "42501" });

      const holder = await admin.connect();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock_shared(174031,hashtext($1))", [tenantId]);
        const disconnect = apiStore.disconnectTenant(tenantId, now);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const locks = await admin.query("select exists(select 1 from pg_locks where locktype='advisory' and classid=174031 and not granted) as waiting");
          waiting = locks.rows[0]?.waiting === true;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await holder.query("commit");
        expect(await disconnect).toMatchObject({ state: "disconnected", version: 1 });
      } finally { await holder.query("rollback"); holder.release(); }

      expect(await apiStore.disconnectTenant(tenantId, new Date(now.getTime() + 1000))).toMatchObject({ version: 1 });
      expect((await store.getDelivery(delivery.record.id, tenantId))?.payloadCiphertext).toBeUndefined();
      expect(await apiStore.listActivity(tenantId)).toEqual([]);
      await worker.query("select set_config('app.tenant_id',$1,false)", [tenantId]);
      expect((await worker.query("select id from repositories where tenant_id=$1", [tenantId])).rows).toEqual([]);
      await expect(worker.query("insert into branches (id,tenant_id,repository_id,name) values ($1,$2,$3,'stale')", [randomUUID(), tenantId, repository.id])).rejects.toMatchObject({ code: "42501" });
      await worker.query("select set_config('app.tenant_id','',false)");
      await expect(apiStore.insertDelivery({ tenantId, guid: randomUUID(), eventName: "push", payloadCiphertext: "later", payloadExpiresAt: now, now })).rejects.toMatchObject({ code: "lifecycle_revoked" });
      await apiStore.saveInstallation(installation);
      expect(await apiStore.getTenantLifecycle(tenantId)).toMatchObject({ state: "active", version: 2 });
      const commit = { repositoryId: repository.id, sha: "a".repeat(40), message: "synthetic commit", parents: [] };
      await expect(withTenantWork({ tenantId, version: 0 }, () => workerStore.saveCommit(tenantId, repository.id, commit))).rejects.toMatchObject({ code: "lifecycle_revoked" });
      expect((await store.getHistoricalSourceCounts(tenantId, repository.id)).commits).toBe(0);
      await withTenantWork({ tenantId, version: 2 }, () => workerStore.saveCommit(tenantId, repository.id, commit));
      expect((await store.getHistoricalSourceCounts(tenantId, repository.id)).commits).toBe(1);
      const user = (await apiStore.getUserById(userId))!;
      const session = { userId, tenantId, tokenHash: randomUUID(), csrfTokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 60_000) };
      await apiStore.createSession(session);
      const stateHash = randomUUID();
      await apiStore.createAuthTransaction({ id: randomUUID(), stateHash, userId, codeVerifierCiphertext: "synthetic", returnPath: "/", expiresAt: session.expiresAt });
      const deletion = await apiStore.requestAccountDeletion(tenantId, userId, now);
      expect(deletion.state).toBe("deletion_requested");
      expect(await apiStore.requestAccountDeletion(tenantId, userId, now)).toEqual(deletion);
      expect(await apiStore.getSession(session.tokenHash, now)).toBeUndefined();
      expect(await apiStore.consumeAuthState(stateHash, now)).toBeUndefined();
      await expect(apiStore.createSession({ ...session, tokenHash: randomUUID() })).rejects.toMatchObject({ code: "lifecycle_revoked" });
      await expect(apiStore.upsertUser(user)).rejects.toMatchObject({ code: "lifecycle_revoked" });
      await expect(apiStore.saveInstallation(installation)).rejects.toMatchObject({ code: "lifecycle_revoked" });
      await expect(apiStore.purgeAccountDeletion(tenantId, now)).rejects.toMatchObject({ code: "42501" });
      // A fresh store represents a worker restarting after the durable request.
      const restartedWorker = new PostgresM1Store(worker);
      expect(await restartedWorker.listPendingAccountDeletions(100)).toContain(tenantId);
      await restartedWorker.purgeAccountDeletion(tenantId, now);
      await restartedWorker.purgeAccountDeletion(tenantId, now);
      expect(await restartedWorker.listPendingAccountDeletions(100)).not.toContain(tenantId);
      expect(await apiStore.getTenantLifecycle(tenantId)).toMatchObject({ state: "deleted" });
      for (const table of ["repositories", "commits", "webhook_deliveries", "sync_jobs"]) expect((await admin.query(`select count(*) from ${table} where tenant_id=$1`, [tenantId])).rows[0].count).toBe("0");
      expect(await apiStore.getUserByGithubAccountId(githubId)).toMatchObject({ deletedAt: now, displayName: "" });
      await expect(apiStore.upsertUser(user)).rejects.toMatchObject({ code: "lifecycle_revoked" });

    } finally {
      await api.end(); await worker.end();
      for (const table of ["sync_jobs", "webhook_deliveries", "commit_refs", "development_events", "commits", "branches", "repository_access", "repositories"]) await admin.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id=$1", [userId]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from application_sessions where user_id=$1", [userId]);
      await admin.query("delete from auth_transactions where user_id=$1", [userId]);
      await admin.query("delete from users where id=$1", [userId]);
      await admin.query("delete from github_accounts where github_account_id=$1", [githubId]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await admin.end();
    }
  });
});
