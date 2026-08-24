import { describe, expect, it } from "vitest";
import {
  deliveryRedeliveryAction,
  defaultTimelineEvents,
  filterContextEvents,
  parseWebhook,
  projectCanonicalFacts,
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

  it("keeps authored and committed roles, visibility, and repository-scoped identity", () => {
    const authoredAt = new Date("2026-01-01T00:00:00Z");
    const committedAt = new Date("2026-01-01T00:01:00Z");
    const events = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: true,
      commits: [{ repositoryId: "repo-a", sha: "same-sha", author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: "message", authoredAt, committedAt, parents: [] }],
      pullRequests: [],
      issues: [],
      releases: [],
    });
    expect(events.map((event) => event.contributionRole)).toEqual(["committer", "author"]);
    expect(events.every((event) => event.visibility === "private")).toBe(true);
    expect(events.every((event) => event.contextKind === "personal")).toBe(true);
    expect(events.every((event) => event.logicalEventKey?.includes("repo-a"))).toBe(true);

    const otherRepository = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-b",
      githubRepositoryId: 102,
      ownerGithubAccountId: 7,
      private: true,
      commits: [{ repositoryId: "repo-b", sha: "same-sha", author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: "message", authoredAt, committedAt, parents: [] }],
      pullRequests: [],
      issues: [],
      releases: [],
    });
    expect(new Set(events.map((event) => event.logicalEventKey)).size).toBe(2);
    expect(new Set(otherRepository.map((event) => event.logicalEventKey)).size).toBe(2);
    expect(events.map((event) => event.logicalEventKey)).not.toEqual(otherRepository.map((event) => event.logicalEventKey));
  });

  it("preserves PR opener/merger/closed facts while collapsing only the default view", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const mergedAt = new Date("2026-01-01T01:00:00Z");
    const closedAt = new Date("2026-01-01T01:00:01Z");
    const events = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: false,
      commits: [],
      pullRequests: [{ githubId: 12, title: "Feature", author: { githubAccountId: 7, actorKind: "user" }, merger: { githubAccountId: 9, actorKind: "user" }, createdAt, updatedAt: closedAt, mergedAt, closedAt }],
      issues: [],
      releases: [],
    });
    expect(events.filter((event) => event.sourceKind === "pull_request").map((event) => event.verb).sort()).toEqual(["closed", "merged", "opened"]);
    const timeline = defaultTimelineEvents(events, 7);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ verb: "merged", actorGithubAccountId: 9, contributionRole: "merger", ownerContributionRole: "opener", contextKind: "project" });

    const closedOnly = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: false,
      commits: [],
      pullRequests: [{ githubId: 13, title: "Closed", author: { githubAccountId: 7, actorKind: "user" }, createdAt, updatedAt: closedAt, closedAt }],
      issues: [],
      releases: [],
    });
    expect(defaultTimelineEvents(closedOnly, 7)).toMatchObject([{ verb: "closed", actorKind: "unknown", ownerContributionRole: "opener" }]);

    const collaboratorOpened = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: false,
      commits: [],
      pullRequests: [{ githubId: 14, title: "Collaborator PR", author: { githubAccountId: 9, actorKind: "user" }, merger: { githubAccountId: 7, actorKind: "user" }, createdAt, updatedAt: mergedAt, mergedAt, closedAt }],
      issues: [],
      releases: [],
    });
    expect(defaultTimelineEvents(collaboratorOpened, 7)).toMatchObject([{ verb: "merged", actorGithubAccountId: 7, contributionRole: "merger", ownerContributionRole: "merger" }]);
  });

  it("never transfers commit authorship between owner and collaborator", () => {
    const authoredAt = new Date("2026-01-01T00:00:00Z");
    const committedAt = new Date("2026-01-01T00:01:00Z");
    const ownerAuthored = projectCanonicalFacts({ tenantId: "tenant-1", repositoryId: "repo-a", githubRepositoryId: 101, ownerGithubAccountId: 7, private: false, commits: [{ repositoryId: "repo-a", sha: "owner-authored", author: { githubAccountId: 7, actorKind: "user" }, committer: { githubAccountId: 9, actorKind: "user" }, message: "owner authored", authoredAt, committedAt, parents: [] }], pullRequests: [], issues: [], releases: [] });
    const collaboratorAuthored = projectCanonicalFacts({ tenantId: "tenant-1", repositoryId: "repo-a", githubRepositoryId: 101, ownerGithubAccountId: 7, private: false, commits: [{ repositoryId: "repo-a", sha: "collaborator-authored", author: { githubAccountId: 9, actorKind: "user" }, committer: { githubAccountId: 7, actorKind: "user" }, message: "collaborator authored", authoredAt, committedAt, parents: [] }], pullRequests: [], issues: [], releases: [] });
    expect(defaultTimelineEvents(ownerAuthored, 7)).toMatchObject([{ verb: "authored", actorGithubAccountId: 7, contributionRole: "author" }]);
    expect(defaultTimelineEvents(collaboratorAuthored, 7)).toMatchObject([{ verb: "committed", actorGithubAccountId: 7, contributionRole: "committer" }]);
  });

  it("retains bot and ghost facts for explicit unknown-context queries without inventing timestamps", () => {
    const events = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: false,
      commits: [
        { repositoryId: "repo-a", sha: "bot-sha", author: { githubAccountId: 99, actorKind: "bot" }, message: "bot", authoredAt: new Date("2026-01-01T00:00:00Z"), parents: [] },
        { repositoryId: "repo-a", sha: "ghost-sha", message: "ghost", committedAt: new Date("2026-01-01T00:01:00Z"), parents: [] },
      ],
      pullRequests: [],
      issues: [],
      releases: [],
    });
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.actorKind === "bot")).toMatchObject({ attributionConfidence: "exact_github_actor", contextKind: "project" });
    expect(events.find((event) => event.actorKind === "unknown")).toMatchObject({ attributionConfidence: "unknown", contextKind: "unknown" });
    expect(filterContextEvents(events, "unknown", true)).toHaveLength(1);
    expect(defaultTimelineEvents(events, 7)).toHaveLength(0);
  });

  it("emits only evidence-backed repository and tag lifecycle facts", () => {
    const renamedAt = new Date("2026-01-01T00:00:00Z");
    const deletedAt = new Date("2026-01-02T00:00:00Z");
    const events = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      private: false,
      githubCreatedAt: renamedAt,
      commits: [],
      pullRequests: [],
      issues: [],
      releases: [],
      repositoryRenames: [{ observedAt: renamedAt }],
      tags: [{ name: "v1", deletedAt }],
    });
    expect(events.map((event) => `${event.sourceKind}:${event.verb}`).sort()).toEqual(["repository:created", "repository:renamed", "tag:deleted"]);
  });

  it("keeps issue and release attribution factual while allowing releases as project milestones", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const closedAt = new Date("2026-01-02T00:00:00Z");
    const events = projectCanonicalFacts({
      tenantId: "tenant-1",
      repositoryId: "repo-a",
      githubRepositoryId: 101,
      ownerGithubAccountId: 7,
      private: false,
      commits: [],
      pullRequests: [],
      issues: [{ githubId: 21, title: "Issue", author: { githubAccountId: 9, actorKind: "user" }, createdAt, updatedAt: closedAt, closedAt }],
      releases: [
        { githubId: 31, name: "owner release", author: { githubAccountId: 7, actorKind: "user" }, publishedAt: createdAt, updatedAt: createdAt },
        { githubId: 32, name: "project release", author: { githubAccountId: 9, actorKind: "user" }, publishedAt: closedAt, updatedAt: closedAt },
      ],
    });
    expect(events.filter((event) => event.sourceKind === "issue").map((event) => event.verb).sort()).toEqual(["closed", "opened"]);
    expect(events.filter((event) => event.sourceKind === "release").every((event) => event.contributionRole === "releaser")).toBe(true);
    expect(defaultTimelineEvents(events, 7).filter((event) => event.sourceKind === "release")).toHaveLength(2);
  });
});
