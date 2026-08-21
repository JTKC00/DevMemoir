import { loadConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { createInstallationGithubClient, OctokitGithubClient } from "@devmemoir/github";
import { PgBossJobPort } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { buildApi } from "./app.js";

const config = loadConfig();
const github = new OctokitGithubClient({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY, apiVersion: config.GITHUB_API_VERSION, webhookSecret: config.GITHUB_WEBHOOK_SECRET });
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const store = new PostgresM1Store(pool);
const jobs = new PgBossJobPort(config.DATABASE_DIRECT_URL);
await jobs.start();
const app = await buildApi({ config, store, github, installationGithub: (installationId) => createInstallationGithubClient(github, installationId), jobs, logger: createLogger() });
await app.listen({ host: config.HOST, port: config.PORT });

const shutdown = async () => {
  await app.close();
  await jobs.stop();
  await pool.end();
};
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
