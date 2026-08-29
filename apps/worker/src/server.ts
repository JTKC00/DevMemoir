import { loadConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { createInstallationGithubClient, OctokitGithubClient } from "@devmemoir/github";
import { PgBossJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { enqueueGithubDeliveryAudit, resumeGithubDeliveryRepairs } from "./delivery-audit.js";
import { processQueueJob, type QueueDependencies } from "./jobs.js";
import { enqueueCurrentMaintenanceTicks, registerMaintenanceSchedules } from "./maintenance.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_WORKER_URL, config.DATABASE_POOL_MAX);
const store = new PostgresM1Store(pool);
const baseGithub = new OctokitGithubClient({
  appId: config.GITHUB_APP_ID,
  privateKey: config.GITHUB_APP_PRIVATE_KEY,
  apiVersion: config.GITHUB_API_VERSION,
  webhookSecret: config.GITHUB_WEBHOOK_SECRET,
  onRateLimitState: async (githubInstallationId, state) => {
    const installation = await store.getInstallation(githubInstallationId);
    if (!installation) return;
    await store.pauseInstallationApi({ tenantId: installation.tenantId, installationId: installation.id, pausedUntil: state.resumeAt, reason: `github_${state.code}` });
  },
});
const jobs = new PgBossJobPort(config.DATABASE_QUEUE_URL);
const logger = createLogger();
await jobs.start();
await registerMaintenanceSchedules(jobs);
const dependencies: QueueDependencies = { config, store, jobs, githubForInstallation: (installationId) => createInstallationGithubClient(baseGithub, installationId), githubApp: baseGithub, logger };
await jobs.work("webhook_delivery", async (job) => processQueueJob(job, dependencies));
await jobs.work("repository_backfill", async (job) => processQueueJob(job, dependencies));
await jobs.work("sync_commits", async (job) => processQueueJob(job, dependencies));
await jobs.work("installation_inventory", async (job) => processQueueJob(job, dependencies));
await jobs.work("repository_reconciliation", async (job) => processQueueJob(job, dependencies));
await jobs.work("github_delivery_audit", async (job) => processQueueJob(job, dependencies));
await jobs.work("maintenance_active", async (job) => processQueueJob(job, dependencies));
await jobs.work("maintenance_authorized", async (job) => processQueueJob(job, dependencies));
await jobs.work("maintenance_audit", async (job) => processQueueJob(job, dependencies));
await enqueueCurrentMaintenanceTicks(jobs);
const existingAudit = await store.getGithubDeliveryAudit(config.GITHUB_APP_ID);
const auditDeps = { store, jobs, githubApp: baseGithub, logger };
if (existingAudit && (existingAudit.status === "in_progress" || existingAudit.status === "paused")) {
  await enqueueGithubDeliveryAudit({ githubAppId: config.GITHUB_APP_ID, auditRunId: existingAudit.currentRunId }, auditDeps, existingAudit.pausedUntil && existingAudit.pausedUntil > new Date() ? existingAudit.pausedUntil : undefined);
}
await resumeGithubDeliveryRepairs(config.GITHUB_APP_ID, auditDeps);
logger.info({ result: "started" });

const shutdown = async () => {
  await jobs.stop();
  await pool.end();
};
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
