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
});
