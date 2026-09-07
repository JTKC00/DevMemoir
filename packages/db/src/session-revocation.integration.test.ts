import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { PostgresM1Store } from "./postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for session revocation tests");

(databaseUrl ? describe : describe.skip)("PostgreSQL session revocation", () => {
  it("uses API privileges and keeps revocation scoped and idempotent", async () => {
    const pool = createPool(databaseUrl as string, 1);
    const store = new PostgresM1Store(pool);
    const users = [0, 1].map(() => ({ userId: randomUUID(), tenantId: randomUUID(), githubAccountId: 2_000_000_000 + Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16), login: "session-test", displayName: "Session Test" }));
    const tokens = [randomUUID(), randomUUID(), randomUUID()];
    const now = new Date("2099-01-01T00:00:00Z");
    try {
      for (const user of users) await store.upsertUser(user);
      await pool.query("set role devmemoir_api");
      for (let index = 0; index < tokens.length; index++) {
        const user = users[index === 2 ? 1 : 0]!;
        await store.createSession({ userId: user.userId, tenantId: user.tenantId, tokenHash: tokens[index]!, csrfTokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 60_000) });
      }
      await store.revokeSessions({ userId: users[0]!.userId, tokenHash: tokens[2]!, now });
      expect(await store.getSession(tokens[2]!, now)).toBeDefined();
      await store.revokeSessions({ userId: users[0]!.userId, tokenHash: tokens[0]!, now });
      expect(await store.getSession(tokens[0]!, now)).toBeUndefined();
      expect(await store.getSession(tokens[1]!, now)).toBeDefined();
      await store.revokeSessions({ userId: users[0]!.userId, now });
      await store.revokeSessions({ userId: users[0]!.userId, now: new Date(now.getTime() + 1000) });
      expect(await store.getSession(tokens[1]!, now)).toBeUndefined();
      expect(await store.getSession(tokens[2]!, now)).toBeDefined();
      const rows = await pool.query("select revoked_at from application_sessions where user_id=$1", [users[0]!.userId]);
      expect(rows.rows.map((row) => row.revoked_at)).toEqual([now, now]);
    } finally {
      await pool.query("reset role");
      for (const user of users) {
        await pool.query("delete from application_sessions where user_id=$1", [user.userId]);
        await pool.query("delete from github_identities where user_id=$1", [user.userId]);
        await pool.query("delete from tenant_members where tenant_id=$1", [user.tenantId]);
        await pool.query("delete from users where id=$1", [user.userId]);
        await pool.query("delete from github_accounts where github_account_id=$1", [user.githubAccountId]);
        await pool.query("delete from tenants where id=$1", [user.tenantId]);
      }
      await pool.end();
    }
  });
});
