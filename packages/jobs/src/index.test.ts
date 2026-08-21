import { describe, expect, it } from "vitest";
import { InMemoryJobPort, commitSyncLogicalKey, deliveryLogicalKey } from "./index.js";

describe("JobPort logical keys", () => {
  it("deduplicates the same logical delivery", async () => {
    const jobs = new InMemoryJobPort();
    const first = await jobs.enqueue("webhook_delivery", deliveryLogicalKey("d-1"), { deliveryId: "d-1" });
    const second = await jobs.enqueue("webhook_delivery", deliveryLogicalKey("d-1"), { deliveryId: "d-1" });
    expect(second).toBe(first);
    expect(jobs.jobs.size).toBe(1);
    expect(commitSyncLogicalKey("repo", "refs/heads/main", "sha")).toBe("sync:repo:refs/heads/main:sha");
  });
});
