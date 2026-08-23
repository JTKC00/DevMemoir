import { describe, expect, it, vi } from "vitest";
import {
  assertGithubEndpointAllowed,
  GithubAccessError,
  GithubEndpointDeniedError,
  GithubRateLimitPauseError,
  githubRefParameter,
  InstallationGithubClient,
  InstallationRequestLanes,
  nextPageFromLink,
  type GithubRequestResponse,
  type OctokitGithubClient,
  stripCompareFiles,
} from "./index.js";

type RequestCall = { route: string; parameters?: Record<string, unknown> };

function githubClient(responses: GithubRequestResponse[]): { client: InstallationGithubClient; calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  const base = {
    requestInstallation: async (_installationId: number, route: string, parameters?: Record<string, unknown>) => {
      calls.push({ route, ...(parameters ? { parameters } : {}) });
      const response = responses.shift();
      if (!response) throw new Error("No fixture response");
      return response;
    },
  } as unknown as OctokitGithubClient;
  return { client: new InstallationGithubClient(base, 77), calls };
}

const actor = { id: 9, login: "octocat", type: "User", email: "raw-private@example.test", token: "ghp_PRIVATE" };
const pageLink = '<https://api.github.com/example?page=2>; rel="next", <https://api.github.com/example?page=4>; rel="last"';

describe("GitHub endpoint permit-list", () => {
  it("allows only the reviewed metadata endpoints", () => {
    const allowed = [
      "GET /repos/{owner}/{repo}/commits",
      "GET /repos/{owner}/{repo}/branches",
      "GET /repos/{owner}/{repo}/tags",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/issues",
      "GET /repos/{owner}/{repo}/releases",
    ];
    for (const endpoint of allowed) expect(() => assertGithubEndpointAllowed(endpoint)).not.toThrow();
  });

  it("denies source, archive, GraphQL, and unreviewed endpoints", () => {
    const denied = [
      "GET /repos/{owner}/{repo}/contents/{path}",
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      "GET /repos/{owner}/{repo}/tarball/{ref}",
      "GET /repos/{owner}/{repo}/zipball/{ref}",
      "POST /graphql",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    ];
    for (const endpoint of denied) expect(() => assertGithubEndpointAllowed(endpoint)).toThrow(GithubEndpointDeniedError);
  });

  it("strips compare patches before application data can see them", () => {
    const stripped = stripCompareFiles({ files: [{ filename: "secret.txt", patch: "PRIVATE SOURCE" }] });
    expect(stripped.files?.[0]).toEqual({});
    expect(JSON.stringify(stripped)).not.toContain("PRIVATE SOURCE");
  });
});

describe("metadata-minimal page normalization", () => {
  it("strips commit files, paths, patches, statistics, and raw Git identities", async () => {
    const { client, calls } = githubClient([{ headers: { Link: pageLink }, data: [{
      sha: "abc", author: actor, committer: actor,
      commit: {
        message: "metadata message", author: { date: "2026-01-01T00:00:00Z", email: "raw-private@example.test", name: "Private Name" },
        committer: { date: "2026-01-02T00:00:00Z", email: "raw-private@example.test" }, verification: { verified: true, payload: "PRIVATE PATCH" },
      },
      parents: [{ sha: "parent", url: "https://api.example/private" }], html_url: "https://github.example/commit/abc",
      files: [{ filename: "private/path.ts", patch: "PRIVATE PATCH" }], stats: { additions: 999, deletions: 888 }, token: "ghp_PRIVATE",
    }] }]);
    const page = await client.listCommits({ owner: "private-owner", repo: "private-repo", sha: "head", since: "2026-01-01T00:00:00Z", page: 1, perPage: 100 });

    expect(page.nextPage).toBe(2);
    expect(page.commits[0]).toMatchObject({ sha: "abc", message: "metadata message", verified: true, parents: ["parent"] });
    expect(JSON.stringify(page)).not.toMatch(/raw-private|Private Name|private\/path|PRIVATE PATCH|ghp_PRIVATE|additions|deletions|files|stats/);
    expect(calls[0]).toEqual({ route: "GET /repos/{owner}/{repo}/commits", parameters: { owner: "private-owner", repo: "private-repo", sha: "head", since: "2026-01-01T00:00:00Z", page: 1, per_page: 100 } });
  });

  it("normalizes branch and tag pages without archive or source URLs", async () => {
    const { client, calls } = githubClient([
      { headers: { link: pageLink }, data: [{ name: "main", commit: { sha: "branch-sha", url: "PRIVATE API URL" }, protected: true, protection: { private: true } }] },
      { data: [{ name: "v1", commit: { sha: "tag-sha", url: "PRIVATE API URL" }, zipball_url: "PRIVATE ARCHIVE", tarball_url: "PRIVATE ARCHIVE" }] },
    ]);

    expect(await client.listBranches({ owner: "o", repo: "r", page: 3, perPage: 25 })).toEqual({ branches: [{ name: "main", headSha: "branch-sha", protected: true }], nextPage: 2 });
    expect(await client.listTags({ owner: "o", repo: "r" })).toEqual({ tags: [{ name: "v1", targetSha: "tag-sha" }] });
    expect(JSON.stringify([await Promise.resolve(calls)])).not.toContain("PRIVATE");
    expect(calls[0]?.parameters).toMatchObject({ page: 3, per_page: 25 });
    expect(calls[1]?.parameters).toMatchObject({ page: 1, per_page: 100 });
  });

  it("normalizes PR metadata and strips bodies, labels, reviews, files, and patches", async () => {
    const { client, calls } = githubClient([{ headers: { link: pageLink }, data: [{
      id: 101, number: 12, title: "Private but approved title", state: "closed", draft: false, user: actor, merged_by: { id: 10, login: "merger", type: "User" },
      base: { ref: "main", sha: "base", repo: { clone_url: "PRIVATE CLONE" } }, head: { ref: "feature", sha: "head", repo: { clone_url: "PRIVATE CLONE" } },
      html_url: "https://github.example/pull/12", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-03T00:00:00Z", merged_at: "2026-01-03T00:00:00Z", body: "PRIVATE BODY", labels: [{ name: "PRIVATE LABEL" }],
      reviews: [{ body: "PRIVATE REVIEW" }], files: [{ filename: "private/path", patch: "PRIVATE PATCH" }], token: "ghp_PRIVATE",
    }] }]);

    const page = await client.listPullRequests({ owner: "o", repo: "r", page: 2, perPage: 50, sort: "updated", direction: "asc" });
    expect(page.pullRequests[0]).toMatchObject({ id: 101, number: 12, title: "Private but approved title", state: "closed", baseRef: "main", baseSha: "base", headRef: "feature", headSha: "head" });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE BODY|PRIVATE LABEL|PRIVATE REVIEW|private\/path|PRIVATE PATCH|PRIVATE CLONE|ghp_PRIVATE|raw-private/);
    expect(calls[0]?.parameters).toEqual({ owner: "o", repo: "r", state: "all", sort: "updated", direction: "asc", page: 2, per_page: 50 });
  });

  it("filters pull request objects from issues before normalization", async () => {
    const issue = { id: 201, number: 22, title: "Issue title", state: "closed", state_reason: "completed", user: actor, html_url: "https://github.example/issues/22", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: "2026-01-03T00:00:00Z", body: "PRIVATE BODY", comments: [{ body: "PRIVATE COMMENT" }], labels: [{ name: "PRIVATE LABEL" }] };
    const pullAsIssue = { ...issue, id: 202, number: 23, pull_request: { url: "PRIVATE PR IDENTITY" } };
    const { client, calls } = githubClient([{ headers: { link: pageLink }, data: [issue, pullAsIssue] }]);

    const page = await client.listIssues({ owner: "o", repo: "r", since: "2026-01-01T00:00:00Z", sort: "updated", direction: "desc", page: 4, perPage: 20 });
    expect(page.issues).toHaveLength(1);
    expect(page.issues[0]).toMatchObject({ id: 201, number: 22, title: "Issue title", stateReason: "completed" });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE BODY|PRIVATE COMMENT|PRIVATE LABEL|PRIVATE PR IDENTITY|raw-private/);
    expect(calls[0]?.parameters).toEqual({ owner: "o", repo: "r", state: "all", since: "2026-01-01T00:00:00Z", sort: "updated", direction: "desc", page: 4, per_page: 20 });
  });

  it("normalizes releases without bodies, assets, or archive URLs", async () => {
    const { client } = githubClient([{ data: [{
      id: 301, tag_name: "v1", name: "Release title", draft: false, prerelease: true, author: actor,
      html_url: "https://github.example/releases/301", created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-02T00:00:00Z",
      body: "PRIVATE BODY", assets: [{ name: "PRIVATE ASSET", browser_download_url: "PRIVATE DOWNLOAD" }], tarball_url: "PRIVATE ARCHIVE", zipball_url: "PRIVATE ARCHIVE", token: "ghp_PRIVATE",
    }] }]);

    const page = await client.listReleases({ owner: "o", repo: "r" });
    expect(page.releases[0]).toMatchObject({ id: 301, tagName: "v1", name: "Release title", draft: false, prerelease: true });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE BODY|PRIVATE ASSET|PRIVATE DOWNLOAD|PRIVATE ARCHIVE|ghp_PRIVATE|raw-private/);
  });

  it("rejects pagination outside GitHub's supported 1..100 page size", async () => {
    const { client } = githubClient([]);
    await expect(client.listTags({ owner: "o", repo: "r", perPage: 101 })).rejects.toThrow(RangeError);
    await expect(client.listTags({ owner: "o", repo: "r", page: 0 })).rejects.toThrow(RangeError);
  });
});

describe("installation request rate-limit lanes", () => {
  it("serializes parallel callers for one installation", async () => {
    const lanes = new InstallationRequestLanes();
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const request = () => lanes.run(1, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { data: {} };
    });
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
  });

  it("keeps different installation IDs independent", async () => {
    const lanes = new InstallationRequestLanes();
    let releaseFirst: (() => void) | undefined;
    const blocked = lanes.run(1, async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { data: "one" };
    });
    const independent = lanes.run(2, async () => ({ data: "two" }));
    await expect(independent).resolves.toEqual({ data: "two" });
    releaseFirst?.();
    await expect(blocked).resolves.toEqual({ data: "one" });
  });

  it("supports concurrency 2 but rejects any higher configuration", async () => {
    const lanes = new InstallationRequestLanes(2);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests = [1, 2].map(() => lanes.run(1, async () => { active += 1; maximum = Math.max(maximum, active); await gate; active -= 1; return { data: {} }; }));
    await vi.waitFor(() => expect(maximum).toBe(2));
    release();
    await Promise.all(requests);
    expect(() => new InstallationRequestLanes(3 as 1)).toThrow(RangeError);
  });

  it("classifies primary exhaustion, pauses without retrying, and resumes at reset", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const resetSeconds = (now + 120_000) / 1000;
    const lanes = new InstallationRequestLanes(1, () => now);
    let calls = 0;
    const exhausted = lanes.run(1, async () => {
      calls += 1;
      throw { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) }, message: "PRIVATE REPOSITORY NAME" };
    });
    await expect(exhausted).rejects.toMatchObject({ code: "primary_rate_limit", status: 403, resumeAt: new Date(now + 120_000) });
    await expect(lanes.run(1, async () => { calls += 1; return { data: {} }; })).rejects.toBeInstanceOf(GithubRateLimitPauseError);
    expect(calls).toBe(1);
    now += 120_000;
    await expect(lanes.run(1, async () => { calls += 1; return { data: "resumed" }; })).resolves.toEqual({ data: "resumed" });
    expect(calls).toBe(2);
  });

  it("honors Retry-After and gives secondary limits without it at least 60 seconds", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const retryLanes = new InstallationRequestLanes(1, () => now);
    await expect(retryLanes.run(1, async () => { throw { status: 429, headers: { "Retry-After": "90" } }; })).rejects.toMatchObject({ code: "retry_after", resumeAt: new Date(now + 90_000) });

    const secondaryLanes = new InstallationRequestLanes(1, () => now);
    await expect(secondaryLanes.run(1, async () => { throw { status: 403, response: { status: 403, headers: {}, data: { message: "You have exceeded a secondary rate limit. PRIVATE CANARY" } } }; })).rejects.toMatchObject({ code: "secondary_rate_limit", resumeAt: new Date(now + 60_000) });
  });

  it("uses a successful remaining=0 response to pause subsequent calls", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const lanes = new InstallationRequestLanes(1, () => now);
    let calls = 0;
    await expect(lanes.run(1, async () => { calls += 1; return { status: 200, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((now + 30_000) / 1000) }, data: "last allowed" }; })).resolves.toMatchObject({ data: "last allowed" });
    await expect(lanes.run(1, async () => { calls += 1; return { data: "must not run" }; })).rejects.toMatchObject({ code: "primary_rate_limit", resumeAt: new Date(now + 30_000) });
    expect(calls).toBe(1);
  });

  it("awaits a sanitized durable observer for successful remaining=0 responses", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const observed: Array<{ installationId: number; code: string; resumeAt: Date }> = [];
    const lanes = new InstallationRequestLanes(1, () => now, (installationId, state) => {
      observed.push({ installationId, code: state.code, resumeAt: state.resumeAt });
    });
    await expect(lanes.run(77, async () => ({ status: 200, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((now + 30_000) / 1000) }, data: "last allowed" }))).resolves.toMatchObject({ data: "last allowed" });
    expect(observed).toEqual([{ installationId: 77, code: "primary_rate_limit", resumeAt: new Date(now + 30_000) }]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ] as const)("sanitizes status %s as an opaque access error", async (status, code) => {
    const lanes = new InstallationRequestLanes();
    let caught: unknown;
    try {
      await lanes.run(1, async () => { throw { status, message: "PRIVATE REPOSITORY token=ghp_PRIVATE path=private/file.ts" }; });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubAccessError);
    expect(caught).toMatchObject({ code, status });
    expect(JSON.stringify(caught)).toBe(JSON.stringify({ class: "GithubAccessError", code, status }));
    expect(String(caught)).not.toMatch(/PRIVATE|ghp_|private\/file/);
  });

  it("sanitizes unclassified upstream failures instead of preserving private messages", async () => {
    const lanes = new InstallationRequestLanes();
    let caught: unknown;
    try {
      await lanes.run(1, async () => { throw { status: 500, message: "PRIVATE REPOSITORY private/file.ts ghp_PRIVATE" }; });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toBe("Error: GitHub installation request failed");
    expect(JSON.stringify(caught)).not.toMatch(/PRIVATE|private\/file|ghp_/);
  });

  it("serializes pause errors to opaque operational fields only", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const lanes = new InstallationRequestLanes(1, () => now);
    let caught: unknown;
    try {
      await lanes.run(1, async () => { throw { status: 429, headers: { "retry-after": "60" }, message: "PRIVATE BODY ghp_PRIVATE" }; });
    } catch (error) {
      caught = error;
    }
    expect(JSON.parse(JSON.stringify(caught))).toEqual({ class: "GithubRateLimitPauseError", code: "retry_after", status: 429, resumeAt: "2026-01-01T00:01:00.000Z" });
    expect(String(caught)).not.toMatch(/PRIVATE|ghp_/);
  });
});

describe("reference and pagination helpers", () => {
  it("normalizes branch names for the Git reference endpoint", () => {
    expect(githubRefParameter("main")).toBe("heads/main");
    expect(githubRefParameter("refs/heads/main")).toBe("heads/main");
    expect(githubRefParameter("tags/v1.0.0")).toBe("tags/v1.0.0");
  });

  it("parses the next page from a multi-link response", () => {
    expect(nextPageFromLink(pageLink)).toBe(2);
    expect(nextPageFromLink('<https://api.github.com/example?page=1>; rel="prev"')).toBeUndefined();
  });
});
