import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required in CI");
const describeIntegration = databaseUrl ? describe : describe.skip;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

describeIntegration("M2 PostgreSQL RLS", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const repoA = randomUUID();
  const repoB = randomUUID();
  const installationA = randomUUID();
  const installationB = randomUUID();
  const accountA = randomUUID();
  const accountB = randomUUID();
  const admin = new Client({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const rolePassword = `test-${randomUUID().replaceAll("-", "")}`;
  const runtimeRoleNames = {
    api: `dm_api_${suffix}`,
    worker: `dm_worker_${suffix}`,
    web: `dm_web_${suffix}`,
  } as const;
  const runtimeClients: Client[] = [];

  function runtimeConnection(roleName: string): string {
    const url = new URL(databaseUrl as string);
    url.username = roleName;
    url.password = rolePassword;
    return url.toString();
  }

  beforeAll(async () => {
    await admin.connect();
    const table = await admin.query<{ exists: boolean }>("select to_regclass('public.repositories') is not null as exists");
    if (!table.rows[0]?.exists) {
      const migration = await readFile(resolve(migrationsDir, "0001_initial.sql"), "utf8");
      await admin.query(migration);
    }
    const inventoryTable = await admin.query<{ exists: boolean }>("select to_regclass('public.repository_name_history') is not null as exists");
    if (!inventoryTable.rows[0]?.exists) {
      const migration = await readFile(resolve(migrationsDir, "0002_m2_repository_inventory.sql"), "utf8");
      await admin.query(migration);
    }
    await admin.query(await readFile(resolve(migrationsDir, "0003_m3_historical_backfill.sql"), "utf8"));
    await admin.query(await readFile(resolve(migrationsDir, "0004_m4_canonical_projection.sql"), "utf8"));
    await admin.query(await readFile(resolve(migrationsDir, "0005_m5_reconciliation_generations.sql"), "utf8"));
    for (const [capability, roleName] of Object.entries(runtimeRoleNames)) {
      const capabilityRole = capability === "api" ? "devmemoir_api" : capability === "worker" ? "devmemoir_worker" : "devmemoir_web";
      await admin.query(`create role "${roleName}" login password '${rolePassword}'`);
      await admin.query(`grant ${capabilityRole} to "${roleName}"`);
    }
    await admin.query("insert into tenants (id,slug,created_at) values ($1,$2,now()),($3,$4,now())", [tenantA, `rls-a-${tenantA.slice(0, 8)}`, tenantB, `rls-b-${tenantB.slice(0, 8)}`]);
    await admin.query("insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,default_branch,created_at,updated_at) values ($1,$2,101,'owner','a','owner/a',true,'main',now(),now()),($3,$4,102,'owner','b','owner/b',true,'main',now(),now())", [repoA, tenantA, repoB, tenantB]);
    await admin.query("insert into github_accounts (id,github_account_id,account_type,actor_kind,login) values ($1,1001,'User','user','owner-a'),($2,1002,'User','user','owner-b')", [accountA, accountB]);
    const accountRows = await admin.query<{ id: string; github_account_id: string }>("select id,github_account_id from github_accounts where github_account_id in (1001,1002) order by github_account_id");
    await admin.query("insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,actor_github_account_id,actor_kind,contribution_role,context_kind,occurred_at,title,summary_input,source_url,completeness_state,visibility,attribution_confidence,projection_version,logical_event_key) values ($1,$2,$3,'github','commit','rls-a','commit','authored',$4,'user','author','personal',now(),'private-event-a','private-message-a','https://github.example/private-a','observed','private','exact_github_actor',1,$5),($6,$7,$8,'github','commit','rls-b','commit','authored',$9,'user','author','personal',now(),'private-event-b','private-message-b','https://github.example/private-b','observed','private','exact_github_actor',1,$10)", [randomUUID(), tenantA, repoA, accountRows.rows[0]?.id, `${tenantA}:${repoA}:commit:rls-a:commit:authored:author`, randomUUID(), tenantB, repoB, accountRows.rows[1]?.id, `${tenantB}:${repoB}:commit:rls-b:commit:authored:author`]);
    await admin.query("insert into github_installations (id,tenant_id,github_installation_id,account_github_account_id,created_at,updated_at) values ($1,$2,201,$3,now(),now()),($4,$5,202,$6,now(),now())", [installationA, tenantA, accountRows.rows[0]?.id, installationB, tenantB, accountRows.rows[1]?.id]);
    await admin.query("insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at) values ($1,$2,$3,$4,'accessible',true,now()),($5,$6,$7,$8,'accessible',true,now())", [randomUUID(), tenantA, repoA, installationA, randomUUID(), tenantB, repoB, installationB]);
    await admin.query("insert into repository_name_history (id,tenant_id,repository_id,owner_login,name,full_name,valid_from) values ($1,$2,$3,'owner','a','owner/a',now()),($4,$5,$6,'owner','b','owner/b',now())", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into tags (id,tenant_id,repository_id,name,target_sha,first_seen_at,last_seen_at,last_authoritative_observed_at,observation_generation) values ($1,$2,$3,'private-a','a',now(),now(),now(),now()),($4,$5,$6,'private-b','b',now(),now(),now(),now())", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into pull_requests (id,tenant_id,repository_id,github_pull_request_id,number,title,state,github_created_at,github_updated_at,first_seen_at,last_seen_at) values ($1,$2,$3,3001,1,'private-pr-a','open',now(),now(),now(),now()),($4,$5,$6,3002,1,'private-pr-b','open',now(),now(),now(),now())", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into issues (id,tenant_id,repository_id,github_issue_id,number,title,state,github_created_at,github_updated_at,first_seen_at,last_seen_at) values ($1,$2,$3,4001,2,'private-issue-a','open',now(),now(),now(),now()),($4,$5,$6,4002,2,'private-issue-b','open',now(),now(),now(),now())", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into releases (id,tenant_id,repository_id,github_release_id,tag_name,name,github_created_at,github_updated_at,first_seen_at,last_seen_at) values ($1,$2,$3,5001,'v1','private-release-a',now(),now(),now(),now()),($4,$5,$6,5002,'v1','private-release-b',now(),now(),now(),now())", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into sync_cursors (id,tenant_id,repository_id,resource_type,ref_name,cursor) values ($1,$2,$3,'pull_requests','', '{\"nextPage\":1}'),($4,$5,$6,'pull_requests','', '{\"nextPage\":1}')", [randomUUID(), tenantA, repoA, randomUUID(), tenantB, repoB]);
    await admin.query("insert into reconciliation_generations (id,tenant_id,repository_id,reconciliation_run_id,generation,current,started_at) values ($1,$2,$3,$4,1,true,now()),($5,$6,$7,$8,1,true,now())", [randomUUID(), tenantA, repoA, randomUUID(), randomUUID(), tenantB, repoB, randomUUID()]);
  });

  afterAll(async () => {
    await Promise.all(runtimeClients.map((client) => client.end().catch(() => undefined)));
    await admin.query("delete from development_events where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from reconciliation_generations where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from sync_cursors where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from releases where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from issues where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from pull_requests where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from tags where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from repository_name_history where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from repository_access where repository_id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from repositories where id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from github_installations where id in ($1,$2)", [installationA, installationB]);
    await admin.query("delete from github_accounts where id in ($1,$2)", [accountA, accountB]);
    await admin.query("delete from tenants where id in ($1,$2)", [tenantA, tenantB]);
    for (const roleName of Object.values(runtimeRoleNames)) await admin.query(`drop role if exists "${roleName}"`);
    await admin.end();
  });

  async function connectRuntimeRole(roleName: string): Promise<Client> {
    const client = new Client({ connectionString: runtimeConnection(roleName) });
    runtimeClients.push(client);
    await client.connect();
    return client;
  }

  it("cannot read or write another tenant", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_api");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    const visible = await admin.query<{ id: string }>("select id from repositories order by id");
    expect(visible.rows.map((row) => row.id)).toEqual([repoA]);
    expect((await admin.query<{ tenant_id: string; summary_input: string }>("select tenant_id,summary_input from development_events order by id")).rows).toMatchObject([{ tenant_id: tenantA, summary_input: "private-message-a" }]);
    const update = await admin.query("update repositories set name='should-not-write' where id=$1", [repoB]);
    expect(update.rowCount).toBe(0);
    await expect(admin.query("insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,default_branch,created_at,updated_at) values ($1,$2,103,'owner','cross','owner/cross',true,'main',now(),now())", [randomUUID(), tenantB])).rejects.toThrow();
    await admin.query("rollback");
  });

  it("web role cannot mutate GitHub-derived facts", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_web");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    await expect(admin.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'canary','message',now(),now())", [randomUUID(), tenantA, repoA])).rejects.toThrow();
    await expect(admin.query("update pull_requests set title='forbidden' where tenant_id=$1", [tenantA])).rejects.toThrow();
    await expect(admin.query("update development_events set summary_input='forbidden' where tenant_id=$1", [tenantA])).rejects.toThrow();
    await admin.query("rollback");
  });

  it("isolates every M3 source and progress row", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_worker");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    for (const table of ["tags", "pull_requests", "issues", "releases", "sync_cursors", "reconciliation_generations", "development_events"]) {
      const visible = await admin.query<{ tenant_id: string }>(`select tenant_id from ${table}`);
      expect(visible.rows.map((row) => row.tenant_id)).toEqual([tenantA]);
      expect((await admin.query(`update ${table} set tenant_id=tenant_id where tenant_id=$1`, [tenantB])).rowCount).toBe(0);
    }
    await expect(admin.query("insert into tags (id,tenant_id,repository_id,name,target_sha,first_seen_at,last_seen_at,last_authoritative_observed_at,observation_generation) values ($1,$2,$3,'cross','x',now(),now(),now(),now())", [randomUUID(), tenantB, repoB])).rejects.toThrow();
    await expect(admin.query("insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,contribution_role,occurred_at,attribution_confidence,projection_version,logical_event_key) values ($1,$2,$3,'github','commit','cross','commit','authored','author',now(),'unknown',1,$4)", [randomUUID(), tenantB, repoB, `${tenantB}:${repoB}:commit:cross:commit:authored:author`])).rejects.toThrow();
    await admin.query("rollback");
  });

  it("keeps inventory name history tenant-scoped, including removed repository facts", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_api");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    expect((await admin.query<{ repository_id: string }>("select repository_id from repository_name_history order by repository_id")).rows.map((row) => row.repository_id)).toEqual([repoA]);
    expect((await admin.query("update repository_name_history set name='cross-tenant' where repository_id=$1", [repoB])).rowCount).toBe(0);
    await expect(admin.query("insert into repository_name_history (id,tenant_id,repository_id,owner_login,name,full_name,valid_from) values ($1,$2,$3,'owner','cross','owner/cross',now())", [randomUUID(), tenantB, repoB])).rejects.toThrow();
    await admin.query("rollback");
  });

  it("does not allow cross-tenant repository access selection or mutation", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_api");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    expect((await admin.query<{ repository_id: string }>("select repository_id from repository_access order by repository_id")).rows.map((row) => row.repository_id)).toEqual([repoA]);
    expect((await admin.query("update repository_access set selected=false where repository_id=$1", [repoB])).rowCount).toBe(0);
    await expect(admin.query("insert into repository_access (id,tenant_id,repository_id,installation_id,access_status,selected,selected_at) values ($1,$2,$3,$4,'accessible',false,now())", [randomUUID(), tenantB, repoB, installationB])).rejects.toThrow();
    await admin.query("rollback");

    await admin.query("begin");
    await admin.query("set local role devmemoir_worker");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    expect((await admin.query("update repository_access set access_status='access_removed' where repository_id=$1", [repoB])).rowCount).toBe(0);
    await admin.query("rollback");
  });

  it("worker role can write only the tenant selected in its transaction", async () => {
    await admin.query("begin");
    await admin.query("set local role devmemoir_worker");
    await admin.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    const visible = await admin.query<{ id: string }>("select id from repositories order by id");
    expect(visible.rows.map((row) => row.id)).toEqual([repoA]);
    await admin.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'worker-canary','message',now(),now())", [randomUUID(), tenantA, repoA]);
    await expect(admin.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'cross-tenant','message',now(),now())", [randomUUID(), tenantB, repoB])).rejects.toThrow();
    await admin.query("rollback");
  });

  it("enforces the same boundaries through LOGIN principals inheriting capability roles", async () => {
    const api = await connectRuntimeRole(runtimeRoleNames.api);
    const worker = await connectRuntimeRole(runtimeRoleNames.worker);
    const web = await connectRuntimeRole(runtimeRoleNames.web);
    const roles = await admin.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>("select rolname,rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname = any($1::text[])", [["devmemoir_api", "devmemoir_worker", "devmemoir_web"]]);
    expect(roles.rows).toHaveLength(3);
    expect(roles.rows.every((role) => !role.rolcanlogin && !role.rolsuper && !role.rolbypassrls)).toBe(true);

    await api.query("begin");
    await api.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    expect((await api.query<{ id: string }>("select id from repositories order by id")).rows.map((row) => row.id)).toEqual([repoA]);
    expect((await api.query("update repositories set name='api-cross-tenant' where id=$1", [repoB])).rowCount).toBe(0);
    await expect(api.query("update pull_requests set title='api-must-not-normalize' where repository_id=$1", [repoA])).rejects.toThrow();
    await expect(api.query("update sync_cursors set status='completed' where repository_id=$1", [repoA])).rejects.toThrow();
    await expect(api.query("update reconciliation_generations set current=false where repository_id=$1", [repoA])).rejects.toThrow();
    await expect(api.query("create table rls_api_ddl_forbidden (id integer)")).rejects.toThrow();
    await api.query("rollback");

    await worker.query("begin");
    await worker.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    await worker.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-worker-canary','message',now(),now())", [randomUUID(), tenantA, repoA]);
    await expect(worker.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-cross-tenant','message',now(),now())", [randomUUID(), tenantB, repoB])).rejects.toThrow();
    await expect(worker.query("insert into development_events (id,tenant_id,repository_id,source_system,source_kind,source_external_id,event_type,verb,contribution_role,occurred_at,attribution_confidence,projection_version,logical_event_key) values ($1,$2,$3,'github','commit','login-cross-tenant','commit','authored','author',now(),'unknown',1,$4)", [randomUUID(), tenantB, repoB, `${tenantB}:${repoB}:commit:login-cross-tenant:commit:authored:author`])).rejects.toThrow();
    await worker.query("rollback");

    await web.query("begin");
    await web.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    await expect(web.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-web-canary','message',now(),now())", [randomUUID(), tenantA, repoA])).rejects.toThrow();
    await web.query("rollback");
  });
});
