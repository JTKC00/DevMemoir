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

  beforeAll(async () => {
    await admin.connect();
    const table = await admin.query<{ exists: boolean }>("select to_regclass('public.repositories') is not null as exists");
    if (!table.rows[0]?.exists) {
      const migration = await readFile(resolve(process.cwd(), "packages/db/migrations/0001_initial.sql"), "utf8");
      await admin.query(migration);
    }
    await admin.query("insert into tenants (id,slug,created_at) values ($1,$2,now()),($3,$4,now())", [tenantA, `rls-a-${tenantA.slice(0, 8)}`, tenantB, `rls-b-${tenantB.slice(0, 8)}`]);
    await admin.query("insert into repositories (id,tenant_id,github_repository_id,owner_login,name,full_name,private,default_branch,created_at,updated_at) values ($1,$2,101,'owner','a','owner/a',true,'main',now(),now()),($3,$4,102,'owner','b','owner/b',true,'main',now(),now())", [repoA, tenantA, repoB, tenantB]);
  });

  afterAll(async () => {
    await admin.query("delete from repositories where id in ($1,$2)", [repoA, repoB]);
    await admin.query("delete from tenants where id in ($1,$2)", [tenantA, tenantB]);
    await admin.end();
  });

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
});
