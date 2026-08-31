import { describe, expect, it } from "vitest";
import {
  InMemoryM1Store,
  RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS,
  RAW_WEBHOOK_PURGE_BATCH_SIZE,
  RAW_WEBHOOK_STANDARD_RETENTION_MS,
  WEBHOOK_PROCESSING_LEASE_MS,
  deadLetterPayloadHardCap,
  standardPayloadExpiry,
} from "./store.js";

const t0 = new Date("2026-09-01T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const PRIVATE = "PRIVATE_REPOSITORY_NAME PRIVATE_COMMIT_MESSAGE PRIVATE_PR_TITLE PRIVATE_WEBHOOK_PAYLOAD PRIVATE_TOKEN PRIVATE_SECRET";

async function routed(store: InMemoryM1Store, extra: { guid?: string; now?: Date; ciphertext?: string } = {}) {
  return store.insertDelivery({
    tenantId: "tenant-a",
    guid: extra.guid ?? "00000000-0000-4000-8000-000000000101",
    eventName: "push",
    payloadCiphertext: extra.ciphertext ?? PRIVATE,
    payloadExpiresAt: standardPayloadExpiry(extra.now ?? t0),
    now: extra.now ?? t0,
  });
}

describe("M6.1 InMemory raw webhook payload retention", () => {
  it("sets first-receipt 7-day expiry and does not extend for processing, retries, or same-GUID redelivery", async () => {
    const store = new InMemoryM1Store();
    const first = await routed(store);
    expect(first.record.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    expect(first.record.payloadCiphertext).toBe(PRIVATE);

    await store.claimDeliveryForProcessing(first.record.id, "tenant-a", at(6 * 24 * 60 * 60 * 1000));
    const processing = await store.getDelivery(first.record.id);
    expect(processing?.state).toBe("processing");
    expect(processing?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));

    await store.updateDelivery(first.record.id, { state: "failed" }, "tenant-a");
    await store.updateDelivery(first.record.id, { state: "received" }, "tenant-a");
    const retried = await store.getDelivery(first.record.id);
    expect(retried?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));

    const redelivery = await routed(store, { now: at(5 * 24 * 60 * 60 * 1000) });
    expect(redelivery.created).toBe(false);
    expect(redelivery.record.receiptCount).toBe(2);
    expect(redelivery.record.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    expect(redelivery.record.payloadCiphertext).toBe(PRIVATE);
  });

  it("purges ordinary payloads at first receipt + 7 days and never rehydrates the same GUID", async () => {
    const store = new InMemoryM1Store();
    const first = await routed(store);
    expect((await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS - 60_000) })).routedPurged).toBe(0);
    expect((await store.getDelivery(first.record.id))?.payloadCiphertext).toBe(PRIVATE);

    const purged = await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS) });
    expect(purged).toEqual({ routedPurged: 1, unroutedPurged: 0, remainingDue: false });
    const after = await store.getDelivery(first.record.id);
    expect(after?.payloadCiphertext).toBeUndefined();
    expect(after?.guid).toBe(first.record.guid);
    expect(after?.state).toBe("received");
    expect(JSON.stringify(after)).not.toMatch(/PRIVATE_/);

    const later = await routed(store, { now: at(8 * 24 * 60 * 60 * 1000), ciphertext: `${PRIVATE}-restored` });
    expect(later.record.payloadCiphertext).toBeUndefined();
    expect(later.record.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
  });

  it("applies a first-receipt 30-day dead-letter cap and shortens recovered rows back to 7 days", async () => {
    const store = new InMemoryM1Store();
    const first = await routed(store);
    await store.updateDelivery(first.record.id, { state: "dead_letter" }, "tenant-a");
    expect((await store.getDelivery(first.record.id))?.payloadExpiresAt).toEqual(deadLetterPayloadHardCap(t0));

    await store.updateDelivery(first.record.id, { state: "failed" }, "tenant-a");
    await store.updateDelivery(first.record.id, { state: "dead_letter" }, "tenant-a");
    expect((await store.getDelivery(first.record.id))?.payloadExpiresAt).toEqual(deadLetterPayloadHardCap(t0));

    expect((await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS - 60_000) })).routedPurged).toBe(0);
    expect((await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS) })).routedPurged).toBe(1);
    expect((await store.getDelivery(first.record.id))?.payloadCiphertext).toBeUndefined();

    const recovered = await routed(store, { guid: "00000000-0000-4000-8000-000000000102" });
    await store.updateDelivery(recovered.record.id, { state: "dead_letter" }, "tenant-a");
    await store.updateDelivery(recovered.record.id, { state: "processed" }, "tenant-a");
    expect((await store.getDelivery(recovered.record.id))?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    expect((await store.purgeExpiredWebhookPayloads({ now: at(20 * 24 * 60 * 60 * 1000) })).routedPurged).toBe(1);
    expect((await store.getDelivery(recovered.record.id))?.payloadCiphertext).toBeUndefined();
  });

  it("shortens a dead-letter claim to first receipt + 7 days without changing lease semantics", async () => {
    const store = new InMemoryM1Store();
    const first = await routed(store, { guid: "00000000-0000-4000-8000-000000000103" });
    await store.updateDelivery(first.record.id, { state: "dead_letter" }, "tenant-a");
    expect((await store.getDelivery(first.record.id))?.payloadExpiresAt).toEqual(deadLetterPayloadHardCap(t0));

    const claimTime = at(20 * 24 * 60 * 60 * 1000);
    const claimed = await store.claimDeliveryForProcessing(first.record.id, "tenant-a", claimTime);
    expect(claimed?.state).toBe("processing");
    expect(claimed?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    expect(claimed?.processingAttempts).toBe(1);
    expect(claimed?.leaseExpiresAt).toEqual(new Date(claimTime.getTime() + WEBHOOK_PROCESSING_LEASE_MS));
    expect(claimed?.payloadCiphertext).toBe(PRIVATE);
  });

  it("keeps failed retries on first-receipt retention and never rehydrates a purged dead-letter claim", async () => {
    const store = new InMemoryM1Store();
    const failed = await routed(store, { guid: "00000000-0000-4000-8000-000000000104" });
    await store.updateDelivery(failed.record.id, { state: "failed" }, "tenant-a");
    const failedClaim = await store.claimDeliveryForProcessing(failed.record.id, "tenant-a", at(5 * 24 * 60 * 60 * 1000));
    expect(failedClaim?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));

    const purged = await routed(store, { guid: "00000000-0000-4000-8000-000000000105" });
    await store.updateDelivery(purged.record.id, { state: "dead_letter" }, "tenant-a");
    await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS) });
    expect((await store.getDelivery(purged.record.id))?.payloadCiphertext).toBeUndefined();

    const recovered = await store.claimDeliveryForProcessing(purged.record.id, "tenant-a", at(RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS + 60_000));
    expect(recovered?.state).toBe("processing");
    expect(recovered?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    expect(recovered?.payloadCiphertext).toBeUndefined();
  });

  it("keeps unrouted tombstones and does not rehydrate them", async () => {
    const store = new InMemoryM1Store();
    await store.recordUnroutedWebhook({ guid: "unrouted-1", eventName: "push", payloadCiphertext: PRIVATE, receivedAt: t0, payloadExpiresAt: at(1) });
    expect((await store.getUnroutedWebhook("unrouted-1"))?.payloadExpiresAt).toEqual(standardPayloadExpiry(t0));
    await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS) });
    const tombstone = await store.getUnroutedWebhook("unrouted-1");
    expect(tombstone?.payloadCiphertext).toBeUndefined();
    expect(tombstone?.guid).toBe("unrouted-1");
    await store.recordUnroutedWebhook({ guid: "unrouted-1", eventName: "push", payloadCiphertext: `${PRIVATE}-later`, receivedAt: at(8 * 24 * 60 * 60 * 1000), payloadExpiresAt: standardPayloadExpiry(at(8 * 24 * 60 * 60 * 1000)) });
    expect((await store.getUnroutedWebhook("unrouted-1"))?.payloadCiphertext).toBeUndefined();
  });

  it("bounds purge batches and treats a second pass as idempotent", async () => {
    const store = new InMemoryM1Store();
    for (let index = 0; index < 3; index += 1) await routed(store, { guid: `00000000-0000-4000-8000-00000000011${index}` });
    const first = await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS), limit: 2 });
    expect(first).toEqual({ routedPurged: 2, unroutedPurged: 0, remainingDue: true });
    const second = await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS), limit: RAW_WEBHOOK_PURGE_BATCH_SIZE });
    expect(second.routedPurged).toBe(1);
    expect((await store.purgeExpiredWebhookPayloads({ now: at(RAW_WEBHOOK_STANDARD_RETENTION_MS) })).routedPurged).toBe(0);
  });
});
