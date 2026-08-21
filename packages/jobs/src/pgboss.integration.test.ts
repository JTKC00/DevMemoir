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
  it("deduplicates concurrent producers, keeps IDs real, and recovers after a worker restart", async () => {
    const key = `integration:${randomUUID()}`;
    const producerA = new PgBossJobPort(databaseUrl as string);
    const producerB = new PgBossJobPort(databaseUrl as string);
    const workerC = new PgBossJobPort(databaseUrl as string);
    const workerD = new PgBossJobPort(databaseUrl as string);
    let attempts = 0;
    let businessEffects = 0;
    let succeeded = false;
    let firstFailureObserved = false;
    try {
      await producerA.start();
      await producerB.start();

      const concurrentIds = await Promise.all([
        producerA.enqueue("webhook_delivery", key, { canary: "pgboss" }),
        producerB.enqueue("webhook_delivery", key, { canary: "pgboss" }),
      ]);
      const realIds = concurrentIds.filter((id): id is string => Boolean(id));
      expect(realIds).toHaveLength(1);
      expect(concurrentIds).not.toContain(key);
      expect(realIds[0]).toMatch(/^[0-9a-f-]{36}$/i);

      const duplicateId = await producerA.enqueue("webhook_delivery", key, { canary: "pgboss-duplicate" });
      expect(duplicateId).not.toBe(key);
      expect(duplicateId === undefined || duplicateId === realIds[0]).toBe(true);

      await producerA.stop();
      await producerB.stop();
      await workerC.start();
      expect(await workerC.has(realIds[0] as string, "webhook_delivery")).toBe(true);

      await workerC.work("webhook_delivery", async (job) => {
        attempts += 1;
        expect(job.logicalKey).toBe(key);
        if (attempts === 1) {
          firstFailureObserved = true;
          throw new Error("intentional retry canary");
        }
        businessEffects += 1;
        succeeded = true;
      });
      await waitFor(() => firstFailureObserved);
      await workerC.stop();

      await workerD.start();
      expect(await workerD.has(realIds[0] as string, "webhook_delivery")).toBe(true);
      await workerD.work("webhook_delivery", async (job) => {
        attempts += 1;
        expect(job.logicalKey).toBe(key);
        businessEffects += 1;
        succeeded = true;
      });
      await waitFor(() => succeeded, 30_000);
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(businessEffects).toBe(1);
    } finally {
      await workerD.stop().catch(() => undefined);
      await workerC.stop().catch(() => undefined);
      await producerB.stop().catch(() => undefined);
      await producerA.stop().catch(() => undefined);
    }
  }, 60_000);
});
