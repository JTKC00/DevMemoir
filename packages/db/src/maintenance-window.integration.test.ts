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

  it("rejects the original accepted job after the window is completed", async () => {
    const bucket = "20270115T06";
    buckets.push(bucket);
    const pool = createPool(databaseUrl as string, 2);
    const store = new PostgresM1Store(pool);
    const now = new Date("2027-01-15T06:00:00Z");
    try {
      expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-a", now })).toBe(true);
      await store.completeMaintenanceWindow({ task: "delivery_audit", bucket, jobId: "job-a", now });
      const replacementPool = createPool(databaseUrl as string, 2);
      const replacement = new PostgresM1Store(replacementPool);
      try {
        expect(await replacement.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-a", now })).toBe(false);
        expect(await replacement.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "job-b", now })).toBe(false);
        const window = await replacement.getMaintenanceWindow("delivery_audit", bucket);
        expect(window?.acceptedJobId).toBe("job-a");
        expect(window?.completedAt).toEqual(now);
      } finally {
        await replacementPool.end();
      }
    } finally {
      await pool.end();
    }
  });

  it("compare-and-sets incomplete ownership once and refuses completed windows", async () => {
    const bucket = `2031${String(1 + (Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 2), 16) % 12)).padStart(2, "0")}${String(1 + (Number.parseInt(randomUUID().replaceAll("-", "").slice(2, 4), 16) % 28)).padStart(2, "0")}T18`;
    buckets.push(bucket);
    const poolA = createPool(databaseUrl as string, 2);
    const poolB = createPool(databaseUrl as string, 2);
    const storeA = new PostgresM1Store(poolA);
    const storeB = new PostgresM1Store(poolB);
    const now = new Date("2026-08-29T12:00:00Z");
    try {
      expect(await storeA.claimMaintenanceWindow({ task: "delivery_audit", bucket, jobKind: "maintenance_audit", jobId: "old-job", now })).toBe(true);
      await storeA.recordMaintenanceWindowError({ task: "delivery_audit", bucket, jobId: "old-job", errorCode: "tick_failed", now });
      const raced = await Promise.all([
        storeA.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket, expectedAcceptedJobId: "old-job", replacementJobId: "new-job-a", now }),
        storeB.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket, expectedAcceptedJobId: "old-job", replacementJobId: "new-job-b", now }),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      const window = await storeA.getMaintenanceWindow("delivery_audit", bucket);
      expect(["new-job-a", "new-job-b"]).toContain(window?.acceptedJobId);
      expect(window?.completedAt).toBeUndefined();
      expect(window?.lastErrorCode).toBe("tick_failed");
      expect(window?.bucket).toBe(bucket);

      await storeA.completeMaintenanceWindow({ task: "delivery_audit", bucket, jobId: window?.acceptedJobId ?? "", now });
      expect(await storeB.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket, expectedAcceptedJobId: window?.acceptedJobId ?? "", replacementJobId: "new-job-c", now })).toBe(false);
      const completed = await storeB.getMaintenanceWindow("delivery_audit", bucket);
      expect(completed?.acceptedJobId).toBe(window?.acceptedJobId);
      expect(completed?.completedAt).toEqual(now);
    } finally {
      await poolA.end().catch(() => undefined);
      await poolB.end().catch(() => undefined);
    }
  });
});
