import { describe, expect, it } from "vitest";
import { createCanarySink, createLogger } from "./index.js";

describe("allowlist logger", () => {
  it("does not emit private canary fields or error messages", () => {
    const capture = createCanarySink();
    const logger = createLogger(capture.sink);
    const privateMessage = "private-repository-name commit-canary fake-token fake-secret fake-path";
    logger.error(
      {
        repository_id: "repo-1",
        message: privateMessage,
        body: privateMessage,
        payload: privateMessage,
        token: privateMessage,
      },
      new Error(privateMessage),
    );
    expect(capture.text()).not.toContain(privateMessage);
    expect(capture.text()).toContain("repo-1");
    expect(capture.text()).not.toContain("message");
  });

  it("emits queue rebuild counts and drops private fields", async () => {
    const capture = createCanarySink();
    const logger = createLogger(capture.sink);
    logger.info({
      event_type: "queue_rebuild",
      result: "completed",
      reconciliation_count: 2,
      audit_count: 1,
      repair_count: 4,
      maintenance_count: 1,
      blocked_count: 1,
      repository_name: "PRIVATE_REPOSITORY_NAME",
      token: "PRIVATE_TOKEN",
    });
    expect(capture.text()).toContain("queue_rebuild");
    expect(capture.text()).toContain("\"reconciliation_count\":2");
    expect(capture.text()).not.toMatch(/PRIVATE_REPOSITORY_NAME|PRIVATE_TOKEN/);
  });

  it("emits opaque operational warning counts and drops private fields", () => {
    const capture = createCanarySink();
    const logger = createLogger(capture.sink);
    logger.warn({
      event_type: "worker_heartbeat_stale",
      count: 2,
      repository_name: "PRIVATE_REPOSITORY_NAME",
      token: "PRIVATE_TOKEN",
    });
    expect(capture.text()).toContain("worker_heartbeat_stale");
    expect(capture.text()).toContain("\"count\":2");
    expect(capture.text()).not.toMatch(/PRIVATE_REPOSITORY_NAME|PRIVATE_TOKEN/);
  });
});
