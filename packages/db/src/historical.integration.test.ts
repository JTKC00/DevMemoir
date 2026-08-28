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

describeIntegration("M3 PostgreSQL historical page transactions", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresM1Store(pool);
  const tenantId = randomUUID();
  const repositoryId = randomUUID();
  const installationId = randomUUID();
  const accountId = randomUUID();

  beforeAll(async () => {
    if (!(await pool.query("select to_regclass('public.tenants') as relation")).rows[0]?.relation) await pool.query(await readFile(resolve(migrationsDir, "0001_initial.sql"), "utf8"));
    if (!(await pool.query("select to_regclass('public.repository_name_history') as relation")).rows[0]?.relation) await pool.query(await readFile(resolve(migrationsDir, "0002_m2_repository_inventory.sql"), "utf8"));
    const migration = await readFile(resolve(migrationsDir, "0003_m3_historical_backfill.sql"), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    await pool.query(await readFile(resolve(migrationsDir, "0004_m4_canonical_projection.sql"), "utf8"));
    await pool.query(await readFile(resolve(migrationsDir, "0005_m5_reconciliation_generations.sql"), "utf8"));
    await pool.query(await readFile(resolve(migrationsDir, "0005_m5_reconciliation_generations.sql"), "utf8"));
    await pool.query("insert into tenants (id,slug,created_at) values ($1,$2,now())", [tenantId, `m3-${tenantId}`]);
    await pool.query("insert into github_accounts (id,github_account_id,account_type,actor_kind) values ($1,$2,'User','user')", [accountId, Math.floor(Math.random() * 1_000_000_000) + 10_000]);
    await pool.query("insert into github_installations (id,tenant_id,github_installation_id,account_github_account_id,status,created_at,updated_at) values ($1,$2,$3,$4,'active',now(),now())", [installationId, tenantId, Math.floor(Math.random() * 1_000_000_000) + 10_000, accountId]);
    await pool.query("insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,default_branch,created_at,updated_at) values ($1,$2,$3,'owner','repo','owner/repo',true,'main',now(),now())", [repositoryId, tenantId, Math.floor(Math.random() * 1_000_000_000) + 10_000]);
    await pool.query("insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at) values ($1,$2,$3,$4,'accessible',true,now())", [randomUUID(), tenantId, repositoryId, installationId]);
  });

  afterAll(async () => {
    await pool.query("delete from releases where tenant_id=$1", [tenantId]);
    await pool.query("delete from issues where tenant_id=$1", [tenantId]);
    await pool.query("delete from pull_requests where tenant_id=$1", [tenantId]);
    await pool.query("delete from tags where tenant_id=$1", [tenantId]);
    await pool.query("delete from commit_refs where tenant_id=$1", [tenantId]);
    await pool.query("delete from development_events where tenant_id=$1", [tenantId]);
    await pool.query("delete from commits where tenant_id=$1", [tenantId]);
    await pool.query("delete from branches where tenant_id=$1", [tenantId]);
    await pool.query("delete from sync_cursors where tenant_id=$1", [tenantId]);
    await pool.query("delete from reconciliation_generations where tenant_id=$1", [tenantId]);
    await pool.query("delete from repository_access where tenant_id=$1", [tenantId]);
    await pool.query("delete from repositories where tenant_id=$1", [tenantId]);
    await pool.query("delete from github_installations where tenant_id=$1", [tenantId]);
    await pool.query("delete from github_accounts where id=$1", [accountId]);
    await pool.query("delete from tenants where id=$1", [tenantId]);
    await pool.end();
  });

  it("rolls back every fact and the checkpoint when one page fact fails", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await store.startHistoricalBackfill({ tenantId, repositoryId, installationId, defaultBranch: "main", now: startedAt });
    const progress = await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "head-a", now: startedAt });
    if (!progress) throw new Error("reset failed");
    const functionName = `m3_fail_${tenantId.replaceAll("-", "")}`;
    await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$ begin if new.sha='fail-page' then raise exception 'page rejected'; end if; return new; end $$`);
    await pool.query(`create trigger ${functionName} before insert on commits for each row execute function ${functionName}()`);
    await expect(store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "default_branch_commits", refName: "main", anchorHeadSha: "head-a", expectedCursor: progress.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:01:00Z"), finalPage: false, facts: [
      { commit: { repositoryId, sha: "would-roll-back", message: "one", parents: [] } },
      { commit: { repositoryId, sha: "fail-page", message: "two", parents: [] } },
    ] })).rejects.toThrow("page rejected");
    await pool.query(`drop trigger ${functionName} on commits`);
    await pool.query(`drop function ${functionName}()`);
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 0 });
    expect(await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main")).toMatchObject({ nextPage: 1, status: "in_progress" });
  });

  it("commits facts and checkpoint together, then rejects an after-commit replay", async () => {
    const progress = await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    if (!progress) throw new Error("progress missing");
    const page = { tenantId, repositoryId, installationId, stage: "default_branch_commits" as const, refName: "main", anchorHeadSha: "head-a", expectedCursor: progress.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:02:00Z"), finalPage: false, facts: [{ commit: { repositoryId, sha: "stable-sha", message: "stable", parents: [] } }] };
    expect(await store.commitHistoricalPage(page)).toMatchObject({ applied: true, progress: { nextPage: 2 } });
    expect(await store.commitHistoricalPage(page)).toMatchObject({ applied: false, reason: "checkpoint_mismatch", progress: { nextPage: 2 } });
    expect(await store.getHistoricalSourceCounts(tenantId, repositoryId)).toMatchObject({ commits: 1 });
  });

  it("uses source timestamps to reject stale mutable updates", async () => {
    await pool.query("update sync_cursors set status='in_progress',started_at=now(),cursor='{\"nextPage\":1}' where tenant_id=$1 and repository_id=$2 and resource_type='pull_requests'", [tenantId, repositoryId]);
    const progress = await store.getHistoricalProgress(tenantId, repositoryId, "pull_requests");
    if (!progress) throw new Error("pull progress missing");
    const newer = { githubId: 7001, number: 7, title: "new", state: "closed", draft: false, createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:10:00Z") };
    const first = await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "pull_requests", expectedCursor: progress.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:11:00Z"), finalPage: false, facts: [newer] });
    await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "pull_requests", expectedCursor: first.progress.cursor, nextCursor: { nextPage: 3 }, observedAt: new Date("2026-01-01T00:12:00Z"), finalPage: false, facts: [{ ...newer, title: "old", state: "open", updatedAt: new Date("2026-01-01T00:05:00Z") }] });
    expect((await pool.query("select title,state from pull_requests where tenant_id=$1 and repository_id=$2", [tenantId, repositoryId])).rows[0]).toMatchObject({ title: "new", state: "closed" });

    await pool.query("update sync_cursors set status='in_progress',started_at=now(),cursor='{\"nextPage\":1}' where tenant_id=$1 and repository_id=$2 and resource_type='releases'", [tenantId, repositoryId]);
    const releaseProgress = await store.getHistoricalProgress(tenantId, repositoryId, "releases");
    if (!releaseProgress) throw new Error("release progress missing");
    const sourceTime = new Date("2026-01-01T00:20:00Z");
    const release = { githubId: 8001, tagName: "v1", name: "new release", draft: false, prerelease: false, createdAt: sourceTime, updatedAt: sourceTime };
    const releaseFirst = await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "releases", expectedCursor: releaseProgress.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-01T00:21:00Z"), finalPage: false, facts: [release] });
    await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "releases", expectedCursor: releaseFirst.progress.cursor, nextCursor: { nextPage: 3 }, observedAt: new Date("2026-01-01T00:22:00Z"), finalPage: false, facts: [{ ...release, name: "equal-clock stale release" }] });
    expect((await pool.query("select name from releases where tenant_id=$1 and repository_id=$2 and github_release_id=8001", [tenantId, repositoryId])).rows[0]).toMatchObject({ name: "new release" });
  });

  it("persists and idempotently resumes an opaque reconciliation generation", async () => {
    const runId = randomUUID();
    const started = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runId, now: new Date("2026-01-02T00:00:00Z") });
    expect(started?.cursor).toMatchObject({ nextPage: 1, reconciliationRunId: runId });
    const traversal = await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "reconcile-head", now: new Date("2026-01-02T00:01:00Z") });
    if (!traversal) throw new Error("reconciliation traversal missing");
    expect(traversal.cursor.reconciliationRunId).toBe(runId);
    await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "default_branch_commits", refName: "main", anchorHeadSha: "reconcile-head", expectedCursor: traversal.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-02T00:02:00Z"), finalPage: false, facts: [] });

    const replay = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runId, now: new Date("2026-01-02T00:03:00Z") });
    expect(replay?.cursor).toMatchObject({ nextPage: 2, reconciliationRunId: runId });
    const nextRunId = randomUUID();
    const next = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: nextRunId, now: new Date("2026-01-02T00:04:00Z") });
    expect(next?.cursor).toMatchObject({ nextPage: 1, reconciliationRunId: nextRunId });
  });

  it("does not let a delayed older reconciliation generation reset or mutate a newer one", async () => {
    const runA = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const runB = "00000000-0000-4000-8000-0000000000bb";
    expect(runA > runB).toBe(true);
    const startedA = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runA, now: new Date("2026-01-03T00:00:00Z") });
    if (!startedA) throw new Error("run A missing");
    const traversalA = await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "stale-head", now: new Date("2026-01-03T00:01:00Z"), expectedReconciliationRunId: runA });
    if (!traversalA) throw new Error("run A traversal missing");
    await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "default_branch_commits", refName: "main", anchorHeadSha: "stale-head", expectedCursor: traversalA.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-03T00:02:00Z"), finalPage: false, facts: [{ commit: { repositoryId, sha: "sha-stale-a", message: "from-a", parents: [] } }] });

    const startedB = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runB, now: new Date("2026-01-03T00:03:00Z") });
    if (!startedB) throw new Error("run B missing");
    const traversalB = await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "current-head", now: new Date("2026-01-03T00:04:00Z"), expectedReconciliationRunId: runB });
    if (!traversalB) throw new Error("run B traversal missing");
    await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "default_branch_commits", refName: "main", anchorHeadSha: "current-head", expectedCursor: traversalB.cursor, nextCursor: { nextPage: 2 }, observedAt: new Date("2026-01-03T00:05:00Z"), finalPage: false, facts: [{ commit: { repositoryId, sha: "sha-current-b", message: "from-b", parents: [] } }] });
    const currentB = await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main");
    const generationA = await store.getRepositoryReconciliationGeneration(tenantId, repositoryId, runA);
    const generationB = await store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId);
    expect(generationB?.reconciliationRunId).toBe(runB);
    expect(generationB?.current).toBe(true);
    expect(generationA?.current).toBe(false);
    expect(generationB && generationA ? generationB.generation > generationA.generation : false).toBe(true);

    expect(await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runA, now: new Date("2026-01-03T00:06:00Z") })).toBeUndefined();
    expect(await store.pauseHistoricalStage({ tenantId, repositoryId, stage: "default_branch_commits", refName: "main", errorCode: "stale_run_a", expectedReconciliationRunId: runA })).toBeUndefined();
    expect(await store.resetCommitTraversal({ tenantId, repositoryId, installationId, refName: "main", anchorHeadSha: "stale-head", now: new Date("2026-01-03T00:07:00Z"), expectedReconciliationRunId: runA })).toBeUndefined();
    expect(await store.commitHistoricalPage({ tenantId, repositoryId, installationId, stage: "default_branch_commits", refName: "main", anchorHeadSha: "stale-head", expectedCursor: traversalA.cursor, nextCursor: { nextPage: 3 }, observedAt: new Date("2026-01-03T00:08:00Z"), finalPage: false, facts: [{ commit: { repositoryId, sha: "must-not-apply", message: "stale", parents: [] } }] })).toMatchObject({ applied: false, reason: "checkpoint_mismatch" });

    expect(await store.getHistoricalProgress(tenantId, repositoryId, "default_branch_commits", "main")).toEqual(currentB);
    expect(await store.getCurrentRepositoryReconciliationGeneration(tenantId, repositoryId)).toMatchObject({ reconciliationRunId: runB, current: true });
    const replay = await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId: runB, now: new Date("2026-01-03T00:09:00Z") });
    expect(replay?.cursor).toMatchObject({ nextPage: 2, reconciliationRunId: runB });
    expect((await pool.query("select sha from commits where tenant_id=$1 and repository_id=$2 and sha=any($3::text[]) order by sha", [tenantId, repositoryId, ["sha-stale-a", "sha-current-b", "must-not-apply"]])).rows.map((row) => row.sha)).toEqual(["sha-current-b", "sha-stale-a"]);
  });
});
