import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { githubIdentities, commits, issues, pullRequests, releases, repositoryNameHistory, syncCursors, tags, webhookDeliveries } from "./schema.js";

if (process.env.CI && !process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required in CI");

describe("M2 schema contract", () => {
  it("defines tenant and identity tables with delivery fields", () => {
    expect(githubIdentities).toBeDefined();
    expect(commits).toBeDefined();
    expect(webhookDeliveries).toBeDefined();
    expect(repositoryNameHistory).toBeDefined();
  });

  it("defines metadata-only historical sources and durable progress", () => {
    expect(tags).toBeDefined();
    expect(syncCursors.status).toBeDefined();
    expect(syncCursors.completenessState).toBeDefined();
    for (const table of [pullRequests, issues, releases]) {
      const columns = Object.keys(getTableColumns(table));
      expect(columns).not.toContain("body");
      expect(columns).not.toContain("labels");
      expect(columns).not.toContain("comments");
      expect(columns).not.toContain("files");
      expect(columns).not.toContain("patch");
      expect(columns).not.toContain("assets");
      expect(columns).not.toContain("rawJson");
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("runs against real PostgreSQL when TEST_DATABASE_URL is provided", async () => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    const result = await client.query<{ one: number }>("select 1 as one");
    await client.end();
    expect(result.rows[0]?.one).toBe(1);
  });
});
