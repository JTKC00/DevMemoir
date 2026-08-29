import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBossJobPort } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for pg-boss job");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeIntegration("real pg-boss adapter", () => {
  it("finds an active singleton from a fresh port and excludes it after completion", async () => {
    const key = `fresh-lookup:${randomUUID()}`;
    const schema = `pgboss_lookup_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const producer = new PgBossJobPort(databaseUrl as string, { schema });
    const freshPort = new PgBossJobPort(databaseUrl as string, { schema });
    let completed = false;
    try {
      await producer.start();
      const jobId = await producer.enqueue("maintenance_audit", key, { kind: "maintenance_audit" });
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
      await producer.stop();

      await freshPort.start();
      expect(await freshPort.findActiveJobByLogicalKey("maintenance_audit", key)).toBe(jobId);
      await freshPort.work("maintenance_audit", async () => { completed = true; });
      await waitFor(() => completed);
      await waitFor(async () => (await freshPort.findActiveJobByLogicalKey("maintenance_audit", key)) === undefined);
    } finally {
      await freshPort.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 60_000);

  it("deduplicates concurrent producers, keeps IDs real, and recovers after a worker restart", async () => {
    const key = `integration:${randomUUID()}`;
    const schema = `pgboss_restart_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const producerA = new PgBossJobPort(databaseUrl as string, { schema });
    const producerB = new PgBossJobPort(databaseUrl as string, { schema });
    const workerC = new PgBossJobPort(databaseUrl as string, { schema });
    const workerD = new PgBossJobPort(databaseUrl as string, { schema });
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
