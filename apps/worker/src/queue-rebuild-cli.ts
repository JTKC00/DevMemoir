import { loadConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { PgBossJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { formatQueueRebuildCounts, rebuildQueue } from "./queue-rebuild.js";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig();
const pool = createPool(config.DATABASE_WORKER_URL, config.DATABASE_POOL_MAX);
const store = new PostgresM1Store(pool);
const logger = createLogger();
const jobs = dryRun ? undefined : new PgBossJobPort(config.DATABASE_QUEUE_URL);

try {
  if (jobs) await jobs.start();
  const result = await rebuildQueue({
    store,
    githubAppId: config.GITHUB_APP_ID,
    logger,
    ...(jobs ? { jobs } : {}),
    dryRun,
  });
  process.stdout.write(`${formatQueueRebuildCounts(result)}\n`);
  if (result.result === "failed" || result.result === "partial") process.exitCode = 1;
} catch (error) {
  logger.error({ event_type: "queue_rebuild", result: "failed" }, error);
  process.exitCode = 1;
} finally {
  if (jobs) await jobs.stop().catch(() => undefined);
  await pool.end();
}
