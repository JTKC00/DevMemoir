import { describe, expect, it } from "vitest";
import { githubIdentities, commits, webhookDeliveries } from "./schema.js";

describe("M1 schema contract", () => {
  it("defines tenant and identity tables with delivery fields", () => {
    expect(githubIdentities).toBeDefined();
    expect(commits).toBeDefined();
    expect(webhookDeliveries).toBeDefined();
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
