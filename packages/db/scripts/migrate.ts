import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { resolveMigrationConnectionString } from "../src/migration-config.js";

const connectionString = resolveMigrationConnectionString();
const client = new Client({ connectionString });
await client.connect();
try {
  const migration = await readFile(resolve(process.cwd(), "migrations/0001_initial.sql"), "utf8");
  await client.query(migration);
} finally {
  await client.end();
}
