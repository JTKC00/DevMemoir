import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "./store.js";

describe("in-memory maintenance window claims", () => {
  it("rejects the original accepted job after the window is completed", async () => {
    const store = new InMemoryM1Store();
    const now = new Date("2026-08-29T12:00:00Z");
    expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "job-a", now })).toBe(true);
    expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "job-a", now })).toBe(true);
    await store.completeMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobId: "job-a", now });
    expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "job-a", now })).toBe(false);
    expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "job-b", now })).toBe(false);
    const window = await store.getMaintenanceWindow("delivery_audit", "20260829T12");
    expect(window?.acceptedJobId).toBe("job-a");
    expect(window?.completedAt).toEqual(now);
  });

  it("transfers incomplete window ownership once and never reopens a completed window", async () => {
    const store = new InMemoryM1Store();
    const now = new Date("2026-08-29T12:00:00Z");
    expect(await store.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now })).toBe(true);
    expect(await store.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", expectedAcceptedJobId: "old-job", replacementJobId: "new-job", now })).toBe(true);
    const recovered = await store.getMaintenanceWindow("delivery_audit", "20260829T12");
    expect(recovered?.acceptedJobId).toBe("new-job");
    expect(recovered?.completedAt).toBeUndefined();
    expect(recovered?.lastErrorCode).toBeUndefined();
    expect(await store.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", expectedAcceptedJobId: "old-job", replacementJobId: "other-job", now })).toBe(false);
    expect((await store.getMaintenanceWindow("delivery_audit", "20260829T12"))?.acceptedJobId).toBe("new-job");

    const completed = new InMemoryM1Store();
    expect(await completed.claimMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobKind: "maintenance_audit", jobId: "old-job", now })).toBe(true);
    await completed.completeMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", jobId: "old-job", now });
    expect(await completed.recoverIncompleteMaintenanceWindow({ task: "delivery_audit", bucket: "20260829T12", expectedAcceptedJobId: "old-job", replacementJobId: "new-job", now })).toBe(false);
    expect(await completed.getMaintenanceWindow("delivery_audit", "20260829T12")).toMatchObject({ acceptedJobId: "old-job", completedAt: now });
  });
});
