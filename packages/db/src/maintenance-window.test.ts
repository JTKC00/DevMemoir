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
});
