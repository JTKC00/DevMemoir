import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { developmentEvents, githubDeliveryAudits, githubDeliveryRepairs, githubIdentities, commits, issues, maintenanceWindows, pullRequests, releases, reconciliationGenerations, repositoryNameHistory, syncCursors, tags, webhookDeliveries, workerHeartbeats } from "./schema.js";

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
    expect(reconciliationGenerations.reconciliationRunId).toBeDefined();
    expect(reconciliationGenerations.generation).toBeDefined();
    expect(reconciliationGenerations.current).toBeDefined();
    expect(githubDeliveryAudits.currentRunId).toBeDefined();
    expect(githubDeliveryRepairs.githubDeliveryGuid).toBeDefined();
    expect(Object.keys(getTableColumns(githubDeliveryRepairs))).not.toContain("payload");
    expect(Object.keys(getTableColumns(githubDeliveryAudits))).not.toContain("payload");
    expect(Object.keys(getTableColumns(maintenanceWindows))).toEqual(expect.arrayContaining(["task", "bucket", "jobKind", "acceptedJobId", "acceptedAt", "completedAt"]));
    expect(Object.keys(getTableColumns(maintenanceWindows))).not.toContain("tenantId");
    expect(Object.keys(getTableColumns(maintenanceWindows))).not.toContain("payload");
    expect(Object.keys(getTableColumns(workerHeartbeats))).toEqual(["workerInstanceId", "startedAt", "lastHeartbeatAt", "stoppedAt", "updatedAt"]);
    expect(Object.keys(getTableColumns(workerHeartbeats))).not.toEqual(expect.arrayContaining(["hostname", "username", "path", "token", "secret"]));
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

  it("defines versioned canonical event identity and attribution metadata", () => {
    const columns = Object.keys(getTableColumns(developmentEvents));
    expect(columns).toEqual(expect.arrayContaining(["logicalEventKey", "projectionVersion", "attributionConfidence", "visibility", "contextKind", "sourceUrl"]));
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
