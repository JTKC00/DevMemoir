import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("M1 durable delivery state", () => {
  const tenantId = randomUUID();
  const guid = `delivery-${randomUUID()}`;
  const repositoryGithubId = 987654;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const admin = new Client({ connectionString: databaseUrl });
  const pool = createPool(databaseUrl as string, 2);
  const store = new PostgresM1Store(pool);
  let deliveryId = "";

  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into tenants (id,slug,created_at) values ($1,$2,now())", [tenantId, `delivery-${tenantId.slice(0, 8)}`]);
  });

  afterAll(async () => {
    await admin.query("delete from sync_jobs where tenant_id=$1", [tenantId]);
    await admin.query("delete from webhook_deliveries where tenant_id=$1", [tenantId]);
    await admin.query("delete from tenants where id=$1", [tenantId]);
    await admin.end();
    await pool.end();
  });

  it("keeps the first receipt canonical and reopens one durable logical job", async () => {
    const first = await store.insertDelivery({
      tenantId,
      guid,
      eventName: "push",
      installationGithubId: 123,
      repositoryGithubId,
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "first".padEnd(40, "0"),
      forced: false,
      payloadCiphertext: "first-ciphertext",
      payloadExpiresAt: expiresAt,
      now,
    });
    deliveryId = first.record.id;
    expect(first.created).toBe(true);
    expect(first.action).toBe("ensure_job");

    const logicalKey = `delivery:${deliveryId}`;
    const firstJob = await store.ensureJob(logicalKey, { kind: "webhook_delivery", tenantId, deliveryId, after: first.record.after });
    const redelivery = await store.insertDelivery({
      tenantId,
      guid,
      eventName: "push",
      installationGithubId: 123,
      repositoryGithubId,
      ref: "refs/heads/main",
      before: "b".repeat(40),
      after: "second".padEnd(40, "0"),
      forced: true,
      payloadCiphertext: "second-ciphertext",
      payloadExpiresAt: expiresAt,
      now: new Date(now.getTime() + 1_000),
    });
    const secondJob = await store.ensureJob(logicalKey, { kind: "webhook_delivery", tenantId, deliveryId, after: "second" });

    expect(redelivery.created).toBe(false);
    expect(redelivery.action).toBe("requeue");
    expect(redelivery.record.id).toBe(deliveryId);
    expect(redelivery.record.after).toBe(first.record.after);
    expect(redelivery.record.forced).toBe(false);
    expect(secondJob).toBe(firstJob);
    const durableJob = await admin.query<{ after: string }>("select payload->>'after' as after from sync_jobs where logical_key=$1", [logicalKey]);
    expect(durableJob.rows[0]?.after).toBe(first.record.after);

    await store.updateDelivery(deliveryId, { state: "processing" }, tenantId);
    expect((await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId, payloadExpiresAt: expiresAt, now })).action).toBe("ensure_job");
    await store.updateDelivery(deliveryId, { state: "failed" }, tenantId);
    expect((await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId, payloadExpiresAt: expiresAt, now })).action).toBe("requeue");
    await store.updateDelivery(deliveryId, { state: "dead_letter" }, tenantId);
    expect((await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId, payloadExpiresAt: expiresAt, now })).action).toBe("requeue");
    await store.updateDelivery(deliveryId, { state: "processed" }, tenantId);
    expect((await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId, payloadExpiresAt: expiresAt, now })).action).toBe("noop");
    await store.updateDelivery(deliveryId, { state: "ignored" }, tenantId);
    expect((await store.insertDelivery({ tenantId, guid, eventName: "push", repositoryGithubId, payloadExpiresAt: expiresAt, now })).action).toBe("noop");
  });
});
