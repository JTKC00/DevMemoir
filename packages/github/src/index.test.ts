import { describe, expect, it } from "vitest";
import { assertGithubEndpointAllowed, GithubEndpointDeniedError, githubRefParameter, stripCompareFiles } from "./index.js";

describe("GitHub endpoint permit-list", () => {
  it("allows commit JSON and denies source-content endpoints", () => {
    expect(() => assertGithubEndpointAllowed("GET /repos/{owner}/{repo}/commits")).not.toThrow();
    expect(() => assertGithubEndpointAllowed("GET /contents")).toThrow(GithubEndpointDeniedError);
  });

  it("strips compare patches before application data can see them", () => {
    const stripped = stripCompareFiles({ files: [{ filename: "secret.txt", patch: "PRIVATE SOURCE" }] });
    expect(stripped.files?.[0]).toEqual({});
    expect(JSON.stringify(stripped)).not.toContain("PRIVATE SOURCE");
  });

  it("normalizes branch names for the Git reference endpoint", () => {
    expect(githubRefParameter("main")).toBe("heads/main");
    expect(githubRefParameter("refs/heads/main")).toBe("heads/main");
    expect(githubRefParameter("tags/v1.0.0")).toBe("tags/v1.0.0");
  });
});
