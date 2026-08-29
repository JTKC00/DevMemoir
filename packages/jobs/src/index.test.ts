import { describe, expect, it } from "vitest";
import { InMemoryJobPort, commitSyncLogicalKey, deliveryAuditLogicalKey, deliveryLogicalKey, deliveryRepairWakeLogicalKey, historicalBackfillLogicalKey, repositoryReconciliationLogicalKey } from "./index.js";

describe("JobPort logical keys", () => {
  it("deduplicates the same logical delivery", async () => {
    const jobs = new InMemoryJobPort();
    const first = await jobs.enqueue("webhook_delivery", deliveryLogicalKey("d-1"), { deliveryId: "d-1" });
    const second = await jobs.enqueue("webhook_delivery", deliveryLogicalKey("d-1"), { deliveryId: "d-1" });
    expect(second).toBe(first);
    expect(jobs.jobs.size).toBe(1);
    expect(commitSyncLogicalKey("repo", "refs/heads/private-project", "sha")).toBe("sync:repo:sha");
    expect(historicalBackfillLogicalKey("repo", "pull_requests", 2)).toBe("backfill:repo:pull_requests:page:2");
    expect(repositoryReconciliationLogicalKey("repo", "00000000-0000-4000-8000-000000000001", "issues", 3)).toBe("reconcile:repo:00000000-0000-4000-8000-000000000001:issues:page:3");
    expect(() => repositoryReconciliationLogicalKey("repo", "PRIVATE_REPOSITORY_NAME")).toThrow("Invalid opaque reconciliation run id");
    expect(deliveryAuditLogicalKey(42, "00000000-0000-4000-8000-0000000000aa", 2)).toBe("delivery-audit:42:00000000-0000-4000-8000-0000000000aa:page:2");
    expect(deliveryRepairWakeLogicalKey(42, "0b989ba4-242f-11e5-81e1-c7b6966d2516", new Date(0))).toBe("delivery-audit:42:repair:0b989ba4-242f-11e5-81e1-c7b6966d2516:wake:0");
    expect(() => deliveryAuditLogicalKey(42, "PRIVATE_REPOSITORY_NAME")).toThrow("Invalid opaque delivery audit run id");
  });
});
