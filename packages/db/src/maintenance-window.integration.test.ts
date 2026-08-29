import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.3 PostgreSQL maintenance-window tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

const buckets: string[] = [];

afterEach(async () => {
  if (!databaseUrl || buckets.length === 0) return;
  const admin = createPool(databaseUrl, 1);
  try {
    await admin.query("delete from maintenance_windows where bucket = any($1::text[])", [buckets.splice(0)]);
  } finally {
    await admin.end();
  }
});

describeIntegration("maintenance window claims", () => {
  it("accepts exactly one concurrent insert and survives a new store process", async () => {
    const bucket = `202701${String(1 + (Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 2), 16) % 28)).padStart(2, "0")}T00`;
    buckets.push(bucket);
    const poolA = createPool(databaseUrl as string, 2);
    const poolB = createPool(databaseUrl as string, 2);
    const storeA = new PostgresM1Store(poolA);
    const storeB = new PostgresM1Store(poolB);
    const now = new Date("2027-01-01T00:00:00Z");
    try {
      const results = await Promise.all([
        storeA.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-a", now }),
        storeB.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-b", now }),
        storeA.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-c", now }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? "job-a" : results[1] ? "job-b" : "job-c";
      expect(await storeA.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: winner, now })).toBe(true);
      const poolC = createPool(databaseUrl as string, 2);
      const storeC = new PostgresM1Store(poolC);
      try {
        expect(await storeC.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-restart", now })).toBe(false);
        const window = await storeC.getMaintenanceWindow("delivery_audit", bucket);
        expect(window?.acceptedJobId).toBe(winner);
        expect(JSON.stringify(window)).not.toMatch(/PRIVATE_REPO_CANARY|PRIVATE_COMMIT_CANARY|PRIVATE_PR_TITLE_CANARY/);
      } finally {
        await poolC.end();
      }
    } finally {
      await poolA.end().catch(() => undefined);
      await poolB.end().catch(() => undefined);
    }
  });
});
