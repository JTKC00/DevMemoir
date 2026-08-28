import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required in CI");
const describeIntegration = databaseUrl ? describe : describe.skip;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

describeIntegration("M4 PostgreSQL canonical projection", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresM1Store(pool);
  const tenantId = randomUUID();
  const userId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();

  beforeAll(async () => {
    for (const file of ["0001_initial.sql", "0002_m2_repository_inventory.sql", "0003_m3_historical_backfill.sql", "0004_m4_canonical_projection.sql", "0005_m5_reconciliation_generations.sql"]) {
      await pool.query(await readFile(resolve(migrationsDir, file), "utf8"));
    }
    await store.upsertUser({ userId, tenantId, githubAccountId: 7001, login: "owner", displayName: "owner" });
    await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: 7002, accountGithubAccountId: 7001 });
    await store.saveRepository({ id: repositoryId, tenantId, installationId, githubRepositoryId: 7003, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main" });
    await store.saveCommit(tenantId, repositoryId, {
      repositoryId,
      sha: "m4-projection-sha",
      author: { githubAccountId: 7001, actorKind: "user" },
      committer: { githubAccountId: 7001, actorKind: "user" },
      message: "canonical source",
      authoredAt: new Date("2026-01-01T00:00:00Z"),
      committedAt: new Date("2026-01-01T00:01:00Z"),
      parents: [],
    }, "https://github.example/commit/m4-projection-sha");
  });

  afterAll(async () => {
    await pool.query("delete from development_events where tenant_id=$1", [tenantId]);
    await pool.query("delete from commits where tenant_id=$1", [tenantId]);
    await pool.query("delete from reconciliation_generations where tenant_id=$1", [tenantId]);
    await pool.query("delete from repository_access where tenant_id=$1", [tenantId]);
    await pool.query("delete from repositories where tenant_id=$1", [tenantId]);
    await pool.query("delete from installation_routes where tenant_id=$1", [tenantId]);
    await pool.query("delete from github_installations where tenant_id=$1", [tenantId]);
    await pool.query("delete from github_identities where user_id=$1", [userId]);
    await pool.query("delete from tenant_members where tenant_id=$1", [tenantId]);
    await pool.query("delete from users where id=$1", [userId]);
    await pool.query("delete from github_accounts where github_account_id in (7001,7002)");
    await pool.query("delete from tenants where id=$1", [tenantId]);
    await pool.end();
  });

  it("reprojects the same source facts deterministically without duplicates", async () => {
    const first = await store.reprojectRepository({ tenantId, repositoryId, ownerGithubAccountId: 7001 });
    const firstRows = await store.listActivity(tenantId, repositoryId, { context: "default", includeBots: true });
    const second = await store.reprojectRepository({ tenantId, repositoryId, ownerGithubAccountId: 7001 });
    const secondRows = await store.listActivity(tenantId, repositoryId, { context: "default", includeBots: true });
    const withoutIds = (rows: typeof firstRows) => rows.map(({ id: _id, ...row }) => row);
    expect(first).toEqual({ projectionVersion: 1, eventCount: 2 });
    expect(second).toEqual(first);
    expect(withoutIds(secondRows)).toEqual(withoutIds(firstRows));
    expect(new Set(secondRows.map((row) => row.logicalEventKey)).size).toBe(secondRows.length);
    expect(secondRows.every((row) => row.visibility === "private" && row.sourceUrl === "https://github.example/commit/m4-projection-sha")).toBe(true);
    expect((await pool.query<{ count: string }>("select count(*) from commits where tenant_id=$1 and repository_id=$2", [tenantId, repositoryId])).rows[0]?.count).toBe("1");
  });

  it("rolls back a failed replacement and keeps the previous projection visible", async () => {
    const before = await store.listActivity(tenantId, repositoryId, { context: "default", includeBots: true });
    await expect(store.reprojectRepository({ tenantId, repositoryId, ownerGithubAccountId: 7001, failureAfterEvents: 1 })).rejects.toThrow("projection_injected_failure");
    const after = await store.listActivity(tenantId, repositoryId, { context: "default", includeBots: true });
    expect(after).toEqual(before);
    expect((await pool.query<{ count: string }>("select count(*) from development_events where tenant_id=$1 and repository_id=$2", [tenantId, repositoryId])).rows[0]?.count).toBe("2");
  });

  it("upgrades projection rows in place when the deterministic rule version changes", async () => {
    const upgraded = await store.reprojectRepository({ tenantId, repositoryId, ownerGithubAccountId: 7001, projectionVersion: 2 });
    const rows = await store.listActivity(tenantId, repositoryId, { context: "default", includeBots: true });
    expect(upgraded).toEqual({ projectionVersion: 2, eventCount: 2 });
    expect(rows.every((row) => row.projectionVersion === 2)).toBe(true);
    expect(new Set(rows.map((row) => row.logicalEventKey)).size).toBe(2);
  });
});
