import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const connectionString = process.env.DATABASE_MIGRATIONS_URL ?? process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_MIGRATIONS_URL, DATABASE_DIRECT_URL, or DATABASE_URL is required");
const client = new Client({ connectionString });
await client.connect();
try {
  const migration = await readFile(resolve(process.cwd(), "migrations/0001_initial.sql"), "utf8");
  await client.query(migration);
} finally {
  await client.end();
}
