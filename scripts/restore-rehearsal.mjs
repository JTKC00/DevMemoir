/** Synthetic-only logical restore rehearsal. Never restores over an existing database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, PostgresM1Store } from "../packages/db/dist/index.js";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.env.RESTORE_REHEARSAL_ADMIN_URL;
if (!input) throw new Error("RESTORE_REHEARSAL_ADMIN_URL is required (isolated local PostgreSQL 18)");
const adminUrl = new URL(input);
if (!["postgres:", "postgresql:"].includes(adminUrl.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname)) throw new Error("Rehearsal requires a local PostgreSQL server");
const binary = (name) => process.env.PG_BIN_DIRECTORY ? join(process.env.PG_BIN_DIRECTORY, name) : name;
const name = `devmemoir_rehearsal_${randomUUID().replaceAll("-", "")}`;
const sourceName = `${name}_source`;
const targetName = `${name}_target`;
const urlFor = (database) => { const url = new URL(adminUrl); url.pathname = `/${database}`; return url.toString(); };
const pgEnv = (database) => ({ ...process.env, PGHOST: adminUrl.hostname, PGPORT: adminUrl.port || "5432", PGUSER: decodeURIComponent(adminUrl.username), PGPASSWORD: decodeURIComponent(adminUrl.password), PGDATABASE: database });
const admin = createPool(input, 1);
const created = [];
const pools = [];
const directory = await mkdtemp(join(tmpdir(), "devmemoir-restore-"));
const started = Date.now();
try {
  assert.match(String((await admin.query("show server_version")).rows[0].server_version), /^18\./);
  for (const database of [sourceName, targetName]) {
    // Names are generated above, never accepted from user input. No DROP/clean
    // option is passed to pg_restore; only these freshly created targets exist.
    await admin.query(`create database "${database}"`);
    created.push(database);
  }
  await run(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/migrate.ts"], { cwd: join(root, "packages/db"), env: { ...process.env, DATABASE_MIGRATIONS_URL: urlFor(sourceName) } });
  const source = createPool(urlFor(sourceName), 1);
  const target = createPool(urlFor(targetName), 1);
  pools.push(source, target);
  const store = new PostgresM1Store(source);
  const restored = new PostgresM1Store(target);
  const tenantId = randomUUID();
  const user = { tenantId, userId: randomUUID(), githubAccountId: 900001, login: "synthetic-restore", displayName: "Synthetic restore" };
  const installation = { id: randomUUID(), tenantId, githubInstallationId: 900002, accountGithubAccountId: user.githubAccountId };
  const repository = { id: randomUUID(), tenantId, installationId: installation.id, githubRepositoryId: 900003, ownerLogin: user.login, name: "synthetic", fullName: `${user.login}/synthetic`, private: true, defaultBranch: "main" };
  await store.upsertUser(user);
  await store.saveInstallation(installation);
  await store.saveRepository(repository);
  await store.saveCommit(tenantId, repository.id, { repositoryId: repository.id, sha: "a".repeat(40), parents: [], message: "SYNTHETIC_RESTORE_CANARY" });
  await store.setBranchHead(tenantId, repository.id, "refs/heads/main", "a".repeat(40));
  await store.createSession({ userId: user.userId, tenantId, tokenHash: "synthetic-restored-session", csrfTokenHash: "synthetic", expiresAt: new Date(Date.now() + 3_600_000) });
  const archive = join(directory, "synthetic.dump");
  await run(binary("pg_dump"), ["--format=custom", "--compress=none", "--no-owner", "--schema=public", "--file", archive], { env: pgEnv(sourceName) });
  // Capture a deletion after the backup. In a real recovery the authoritative
  // deletion ledger must come from outside the restored snapshot.
  const requestedAt = new Date();
  await store.requestAccountDeletion(tenantId, user.userId, requestedAt);
  await store.purgeAccountDeletion(tenantId, requestedAt);
  const ledger = [{ tenantId, userId: user.userId, requestedAt }];
  // PostgreSQL creates an empty public schema in a new database; the archive
  // contains its own CREATE SCHEMA. No CASCADE: unexpected contents must fail.
  await target.query("drop schema public");
  await run(binary("pg_restore"), ["--exit-on-error", "--no-owner", "--dbname", targetName, archive], { env: pgEnv(targetName) });
  assert.equal((await restored.getHistoricalSourceCounts(tenantId, repository.id)).commits, 1);
  assert.equal(await restored.getBranchHead(tenantId, repository.id, "refs/heads/main"), "a".repeat(40));
  // Quarantined target has no web/API/worker process and no outbound GitHub
  // calls. Revoke restored sessions and replay deletion before any traffic.
  await target.query("update application_sessions set revoked_at=coalesce(revoked_at,now())");
  for (const entry of ledger) {
    await restored.requestAccountDeletion(entry.tenantId, entry.userId, entry.requestedAt);
    await restored.purgeAccountDeletion(entry.tenantId, new Date());
  }
  assert.equal((await restored.getTenantLifecycle(tenantId)).state, "deleted");
  assert.equal((await target.query("select count(*) from commits")).rows[0].count, "0");
  assert.equal((await target.query("select count(*) from repositories")).rows[0].count, "0");
  assert.equal(await restored.getSession("synthetic-restored-session", new Date()), undefined);
  await assert.rejects(restored.upsertUser(user), { code: "lifecycle_revoked" });
  const isolation = await target.query("select count(*) from pg_class where relname in ('repositories','commits','tenant_lifecycles') and relrowsecurity and relforcerowsecurity");
  assert.equal(isolation.rows[0].count, "3");
  console.log(JSON.stringify({ rehearsal: "synthetic_logical_restore", postgresMajor: 18, sourceCommitCount: 1, restoredCommitCountBeforeLedger: 1, restoredCommitCountAfterLedger: 0, restoredSessionsRejected: true, deletedIdentityRejected: true, forcedRlsRestored: true, durationMs: Date.now() - started, providerPitrVerified: false }));
} finally {
  for (const pool of pools) await pool.end();
  for (const database of created.reverse()) await admin.query(`drop database "${database}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
