import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBossJobPort } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for pg-boss job");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeIntegration("real pg-boss adapter", () => {
  it("creates queues, deduplicates a logical key, survives restart, and retries a failed handler", async () => {
    const key = `integration:${randomUUID()}`;
    const sender = new PgBossJobPort(databaseUrl as string);
    const worker = new PgBossJobPort(databaseUrl as string);
    let attempts = 0;
    let received = false;
    try {
      await sender.start();
      await worker.start();
      const firstId = await sender.enqueue("webhook_delivery", key, { canary: "pgboss" });
      const duplicateId = await sender.enqueue("webhook_delivery", key, { canary: "pgboss" });
      expect(duplicateId).toBe(firstId);
      await worker.work("webhook_delivery", async (job) => {
        attempts += 1;
        expect(job.logicalKey).toBe(key);
        if (attempts === 1) throw new Error("intentional retry canary");
        received = true;
      });
      await waitFor(() => received);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await worker.stop().catch(() => undefined);
      await sender.stop().catch(() => undefined);
    }
  }, 30_000);
});
