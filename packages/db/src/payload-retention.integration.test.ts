import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";
import { RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS, RAW_WEBHOOK_STANDARD_RETENTION_MS, deadLetterPayloadHardCap, standardPayloadExpiry } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M6.1 PostgreSQL payload-retention tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

const PRIVATE = "PRIVATE_REPOSITORY_NAME PRIVATE_COMMIT_MESSAGE PRIVATE_PR_TITLE PRIVATE_WEBHOOK_PAYLOAD PRIVATE_TOKEN PRIVATE_SECRET";
const t0 = new Date("2099-01-01T10:00:00Z");

describeIntegration("M6.1 PostgreSQL raw webhook payload retention", () => {
  it("enforces first-receipt deadlines, tombstones, normalized-fact survival, and bounded concurrent purge", async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const githubUserId = 930_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 6), 16);
    const installationGithubId = githubUserId + 2;
    const guid = randomUUID();
    const unroutedGuid = randomUUID();
    const pool = createPool(databaseUrl as string, 3);
    const admin = createPool(databaseUrl as string, 2);
    const store = new PostgresM1Store(pool);
    try {
      await store.upsertUser({ userId, tenantId, githubAccountId: githubUserId, login: "owner", displayName: "owner" });
      await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: githubUserId });
      await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: githubUserId + 3, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
      await store.selectRepository(tenantId, repositoryId);
      await store.saveCommit(tenantId, repositoryId, { repositoryId, sha: "a".repeat(40), message: "normalized fact", committedAt: t0, author: { githubAccountId: githubUserId, actorKind: "user" }, committer: { githubAccountId: githubUserId, actorKind: "user" }, parents: [] });

      const first = await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId: githubUserId + 3, payloadCiphertext: PRIVATE, payloadExpiresAt: t0, now: t0 });
      expect(first.record.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
      const claimed = await store.claimDeliveryForProcessing(first.record.id, tenantId, new Date(t0.getTime() + 6 * 24 * 60 * 60 * 1000));
      expect(claimed?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
      expect(claimed?.state).toBe("processing");
      expect(claimed?.leaseExpiresAt).toBeTruthy();

      await store.insertDelivery({ tenantId, guid, eventName: "push", payloadCiphertext: `${PRIVATE}-redelivery`, payloadExpiresAt: new Date(t0.getTime() + 5 * 24 * 60 * 60 * 1000), now: new Date(t0.getTime() + 5 * 24 * 60 * 60 * 1000) });
      expect((await store.getDelivery(first.record.id, tenantId))?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));

      const due = new Date(t0.getTime() + RAW_WEBHOOK_STANDARD_RETENTION_MS);
      const [purgeWhileProcessing] = await Promise.all([
        store.purgeExpiredWebhookPayloads({ now: due }),
        store.updateDelivery(first.record.id, { state: "processing" }, tenantId),
      ]);
      expect(purgeWhileProcessing.routedPurged).toBeGreaterThanOrEqual(0);
      const afterRace = await store.getDelivery(first.record.id, tenantId);
      expect(afterRace?.state).toBe("processing");
      expect(afterRace?.leaseExpiresAt).toBeTruthy();
      expect(afterRace?.payloadCiphertext).toBeUndefined();

      await store.insertDelivery({ tenantId, guid, eventName: "push", payloadCiphertext: `${PRIVATE}-restored`, payloadExpiresAt: standardPayloadExpiry(due), now: new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000) });
      expect((await store.getDelivery(first.record.id, tenantId))?.payloadCiphertext).toBeUndefined();

      const deadLetterGuid = randomUUID();
      const dead = await store.insertDelivery({ tenantId, guid: deadLetterGuid, eventName: "push", payloadCiphertext: PRIVATE, payloadExpiresAt: t0, now: t0 });
      await Promise.all([
        store.updateDelivery(dead.record.id, { state: "dead_letter" }, tenantId),
        store.purgeExpiredWebhookPayloads({ now: due }),
      ]);
      const deadAfter = await store.getDelivery(dead.record.id, tenantId);
      expect(deadAfter?.state).toBe("dead_letter");
      if (deadAfter?.payloadCiphertext) {
        expect(deadAfter.payloadExpiresAt).toEqual(deadLetterPayloadHardCap(t0));
        expect(deadAfter.payloadCiphertext).toBe(PRIVATE);
      } else {
        expect(deadAfter?.payloadCiphertext).toBeUndefined();
      }
      expect(deadAfter?.payloadCiphertext ?? "").not.toContain("restored");

      await store.updateDelivery(dead.record.id, { state: "processed" }, tenantId);
      expect((await store.getDelivery(dead.record.id, tenantId))?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
      await store.purgeExpiredWebhookPayloads({ now: new Date(t0.getTime() + 20 * 24 * 60 * 60 * 1000) });
      expect((await store.getDelivery(dead.record.id, tenantId))?.payloadCiphertext).toBeUndefined();

      const lateDead = await store.insertDelivery({ tenantId, guid: randomUUID(), eventName: "push", payloadCiphertext: PRIVATE, payloadExpiresAt: t0, now: t0 });
      await store.updateDelivery(lateDead.record.id, { state: "dead_letter" }, tenantId);
      expect((await store.purgeExpiredWebhookPayloads({ now: new Date(t0.getTime() + RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS - 1_000) })).routedPurged).toBe(0);
      expect((await store.getDelivery(lateDead.record.id, tenantId))?.payloadCiphertext).toBe(PRIVATE);
      await store.purgeExpiredWebhookPayloads({ now: new Date(t0.getTime() + RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS) });
      expect((await store.getDelivery(lateDead.record.id, tenantId))?.payloadCiphertext).toBeUndefined();

      await store.recordUnroutedWebhook({ guid: unroutedGuid, eventName: "push", payloadCiphertext: PRIVATE, receivedAt: t0, payloadExpiresAt: t0 });
      await store.purgeExpiredWebhookPayloads({ now: due });
      const unrouted = await store.getUnroutedWebhook(unroutedGuid);
      expect(unrouted?.payloadCiphertext).toBeUndefined();
      expect(unrouted?.guid).toBe(unroutedGuid);
      await store.recordUnroutedWebhook({ guid: unroutedGuid, eventName: "push", payloadCiphertext: `${PRIVATE}-later`, receivedAt: new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000), payloadExpiresAt: due });
      expect((await store.getUnroutedWebhook(unroutedGuid))?.payloadCiphertext).toBeUndefined();

      const batchGuids = [randomUUID(), randomUUID(), randomUUID()];
      for (const batchGuid of batchGuids) await store.insertDelivery({ tenantId, guid: batchGuid, eventName: "push", payloadCiphertext: PRIVATE, payloadExpiresAt: t0, now: t0 });
      const firstBatch = await store.purgeExpiredWebhookPayloads({ now: due, limit: 2 });
      expect(firstBatch.routedPurged).toBe(2);
      expect(firstBatch.remainingDue).toBe(true);
      const [left, right] = await Promise.all([
        store.purgeExpiredWebhookPayloads({ now: due, limit: 1 }),
        store.purgeExpiredWebhookPayloads({ now: due, limit: 1 }),
      ]);
      expect(left.routedPurged + right.routedPurged).toBeGreaterThanOrEqual(1);
      expect(left.routedPurged + right.routedPurged).toBeLessThanOrEqual(2);

      const facts = await admin.query<{ sha: string }>("select sha from commits where tenant_id=$1", [tenantId]);
      expect(facts.rows).toEqual([{ sha: "a".repeat(40) }]);
      expect((await store.getDelivery(first.record.id, tenantId))?.guid).toBe(guid);
      expect(JSON.stringify({ delivery: await store.getDelivery(first.record.id, tenantId), unrouted: await store.getUnroutedWebhook(unroutedGuid), facts: facts.rows })).not.toMatch(/PRIVATE_/);

      await admin.query("begin");
      await admin.query("set local role devmemoir_web");
      await expect(admin.query("update unrouted_webhook_deliveries set payload_ciphertext=$2 where github_delivery_guid=$1", [unroutedGuid, PRIVATE])).rejects.toThrow();
      await admin.query("rollback");
    } finally {
      await admin.query("delete from unrouted_webhook_deliveries where github_delivery_guid=$1", [unroutedGuid]);
      await admin.query("delete from webhook_deliveries where tenant_id=$1", [tenantId]);
      await admin.query("delete from commits where tenant_id=$1", [tenantId]);
      await admin.query("delete from repository_access where tenant_id=$1", [tenantId]);
      await admin.query("delete from repositories where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_installations where tenant_id=$1", [tenantId]);
      await admin.query("delete from installation_routes where tenant_id=$1", [tenantId]);
      await admin.query("delete from github_identities where user_id=$1", [userId]);
      await admin.query("delete from tenant_members where tenant_id=$1", [tenantId]);
      await admin.query("delete from users where id=$1", [userId]);
      await admin.query("delete from github_accounts where github_account_id=$1", [githubUserId]);
      await admin.query("delete from tenants where id=$1", [tenantId]);
      await pool.end();
      await admin.end();
    }
  });
});
