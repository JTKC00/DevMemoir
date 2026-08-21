import { loadConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { createInstallationGithubClient, OctokitGithubClient } from "@devmemoir/github";
import { PgBossJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { processQueueJob, type QueueDependencies } from "./jobs.js";

const config = loadConfig();
const baseGithub = new OctokitGithubClient({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY, apiVersion: config.GITHUB_API_VERSION, webhookSecret: config.GITHUB_WEBHOOK_SECRET });
const pool = createPool(config.DATABASE_WORKER_URL, config.DATABASE_POOL_MAX);
const store = new PostgresM1Store(pool);
const jobs = new PgBossJobPort(config.DATABASE_QUEUE_URL);
const logger = createLogger();
await jobs.start();
const dependencies: QueueDependencies = { config, store, jobs, githubForInstallation: (installationId) => createInstallationGithubClient(baseGithub, installationId), logger };
await jobs.work("webhook_delivery", async (job) => processQueueJob(job, dependencies));
await jobs.work("repository_backfill", async (job) => processQueueJob(job, dependencies));
await jobs.work("sync_commits", async (job) => processQueueJob(job, dependencies));
await jobs.work("installation_inventory", async (job) => processQueueJob(job, dependencies));
logger.info({ result: "started" });

const shutdown = async () => {
  await jobs.stop();
  await pool.end();
};
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
