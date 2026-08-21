import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { resolveMigrationConnectionString } from "../src/migration-config.js";

const connectionString = resolveMigrationConnectionString();
const client = new Client({ connectionString });
await client.connect();
try {
  const migrationFiles = (await readdir(resolve(process.cwd(), "migrations")))
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();
  for (const file of migrationFiles) await client.query(await readFile(resolve(process.cwd(), "migrations", file), "utf8"));
} finally {
  await client.end();
}
