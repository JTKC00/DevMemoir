import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("M1 PostgreSQL RLS", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const repoA = randomUUID();
  const repoB = randomUUID();
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
      const migration = await readFile(resolve(process.cwd(), "packages/db/migrations/0001_initial.sql"), "utf8");
      await admin.query(migration);
    }
    for (const [capability, roleName] of Object.entries(runtimeRoleNames)) {
      const capabilityRole = capability === "api" ? "devmemoir_api" : capability === "worker" ? "devmemoir_worker" : "devmemoir_web";
      await admin.query(`create role "${roleName}" login password '${rolePassword}'`);
      await admin.query(`grant ${capabilityRole} to "${roleName}"`);
    }
    await admin.query("insert into tenants (id,slug,created_at) values ($1,$2,now()),($3,$4,now())", [tenantA, `rls-a-${tenantA.slice(0, 8)}`, tenantB, `rls-b-${tenantB.slice(0, 8)}`]);
    await admin.query("insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,default_branch,created_at,updated_at) values ($1,$2,101,'owner','a','owner/a',true,'main',now(),now()),($3,$4,102,'owner','b','owner/b',true,'main',now(),now())", [repoA, tenantA, repoB, tenantB]);
  });

  afterAll(async () => {
    await Promise.all(runtimeClients.map((client) => client.end().catch(() => undefined)));
    await admin.query("delete from repositories where id in ($1,$2)", [repoA, repoB]);
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
    await expect(api.query("create table rls_api_ddl_forbidden (id integer)")).rejects.toThrow();
    await api.query("rollback");

    await worker.query("begin");
    await worker.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    await worker.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-worker-canary','message',now(),now())", [randomUUID(), tenantA, repoA]);
    await expect(worker.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-cross-tenant','message',now(),now())", [randomUUID(), tenantB, repoB])).rejects.toThrow();
    await worker.query("rollback");

    await web.query("begin");
    await web.query("select set_config('app.tenant_id',$1,true)", [tenantA]);
    await expect(web.query("insert into commits (id,tenant_id,repository_id,sha,message,first_seen_at,last_seen_at) values ($1,$2,$3,'login-web-canary','message',now(),now())", [randomUUID(), tenantA, repoA])).rejects.toThrow();
    await web.query("rollback");
  });
});
