import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schemaModule from "./schema.js";

export type Database = NodePgDatabase<typeof schemaModule.schema>;

export function createPool(connectionString: string, max = 5): Pool {
  return new Pool({ connectionString, max, application_name: "devmemoir" } satisfies PoolConfig);
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema: schemaModule.schema });
}

export async function withTenant<T>(db: Database, tenantId: string, operation: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return operation(tx as unknown as Database);
  });
}
