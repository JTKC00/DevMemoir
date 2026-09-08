import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";
import type { ActivityResponse } from "./activity";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "test-session" }) }));
afterEach(() => { vi.unstubAllGlobals(); });

describe("activity page states", () => {
  const events: ActivityResponse["events"] = [
    { id: "a", repositoryId: "repo", sourceKind: "commit", sourceExternalId: "sha", eventType: "commit", occurredAt: "2026-09-07T03:00:00Z", verb: "authored", contributionRole: "author", contextKind: "personal", actorKind: "human", attributionConfidence: "verified", completenessState: "observed", visibility: "private", projectionVersion: 1, message: "Add timeline grouping" },
    { id: "b", repositoryId: "repo", sourceKind: "pull_request", sourceExternalId: "1", eventType: "pull_request", occurredAt: "2026-09-06T03:00:00Z", verb: "merged", contributionRole: "merger", contextKind: "project", actorKind: "human", attributionConfidence: "verified", completenessState: "observed", visibility: "private", projectionVersion: 1, title: "Improve activity navigation" },
  ];

  it("groups by UTC day and filters the returned activity by type", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ completeness: "Newest 100 commits", repository: { id: "repo", fullName: "owner/repo", private: true }, events }));
    vi.stubGlobal("fetch", fetchMock);
    const all = renderToStaticMarkup(await HomePage({}));
    expect(all.indexOf("Activity on 2026-09-07")).toBeLessThan(all.indexOf("Activity on 2026-09-06"));
    const filtered = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({ type: "pull_request", context: "project", includeBots: "true" }) }));
    expect(filtered).toContain("Improve activity navigation");
    expect(filtered).not.toContain("Add timeline grouping");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("context=project&includeBots=true"), expect.anything());
    expect(filtered).toContain("<details><summary>Activity details</summary>");
  });

  it("distinguishes no matches from a repository with no observed activity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ completeness: "Newest 100 commits", repository: { id: "repo", fullName: "owner/repo", private: true }, events })));
    expect(renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({ type: "release" }) }))).toContain("No activity matches these filters.");
  });
  it("offers login only when the API rejects the session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect(renderToStaticMarkup(await HomePage({}))).toContain("Continue with GitHub");
  });

  it.each([403, 500, 503])("offers retry rather than login for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const html = renderToStaticMarkup(await HomePage({}));
    expect(html).toContain("Activity is temporarily unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Continue with GitHub");
  });

  it("handles transport failure without exposing the internal error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("PRIVATE_INTERNAL_ERROR")));
    const html = renderToStaticMarkup(await HomePage({}));
    expect(html).toContain("Retry");
    expect(html).not.toContain("PRIVATE_INTERNAL_ERROR");
  });

  it("shows the connect state for an authenticated owner with no repository", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ completeness: "Observed history", events: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(await HomePage({}));
    expect(html).toContain("No repository connected");
    expect(html).not.toContain("Continue with GitHub");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/activity"), expect.objectContaining({ cache: "no-store", headers: { cookie: "test-session" } }));
  });
});
