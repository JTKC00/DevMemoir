import { describe, expect, it } from "vitest";
import {
  deliveryRedeliveryAction,
  defaultTimelineEvents,
  parseWebhook,
  projectCommitFacts,
} from "./index.js";

describe("delivery state semantics", () => {
  it("only treats processed and ignored as terminal no-ops", () => {
    expect(deliveryRedeliveryAction("processed")).toBe("noop");
    expect(deliveryRedeliveryAction("ignored")).toBe("noop");
    expect(deliveryRedeliveryAction("failed")).toBe("requeue");
    expect(deliveryRedeliveryAction("dead_letter")).toBe("requeue");
    expect(deliveryRedeliveryAction("processing")).toBe("ensure_job");
  });
});

describe("webhook contracts", () => {
  it("strips unknown fields and keeps only a push signal", () => {
    const parsed = parseWebhook("push", {
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      forced: false,
      commits: [{ id: "not-authoritative", message: "canary" }],
      repository: { id: 42, full_name: "owner/repo", secret_private_field: "hidden" },
    });
    expect(parsed.kind).toBe("push");
    expect(parsed.push).toEqual(expect.objectContaining({ ref: "refs/heads/main", after: "b".repeat(40) }));
    expect(JSON.stringify(parsed)).not.toContain("canary");
  });

  it("ignores unknown event types", () => {
    expect(parseWebhook("future_event", { action: "new", private_value: "secret" }).kind).toBe("ignored");
  });
});

describe("canonical commit events", () => {
  it("collapses same author and committer and hides bots in the default view", () => {
    const events = projectCommitFacts({
      repositoryId: "repo",
      sha: "sha-1",
      author: { githubAccountId: 7, actorKind: "user" },
      committer: { githubAccountId: 7, actorKind: "user" },
      message: "private commit message",
      committedAt: new Date("2026-01-01T00:00:00Z"),
      parents: [],
    }, 7);
    expect(events).toHaveLength(1);
    expect(defaultTimelineEvents(events, 7)).toHaveLength(1);
  });
});
