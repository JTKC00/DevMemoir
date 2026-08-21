import type { M1Store } from "@devmemoir/db";
import type { GithubClient } from "@devmemoir/github";
import type { JobPort, QueueJob, SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { processDelivery } from "./processor.js";
import { synchronizeRefHead } from "./sync.js";

export type QueueDependencies = {
  store: M1Store;
  jobs: JobPort;
  githubForInstallation: (installationId: number) => GithubClient;
  logger: Logger;
  config: Parameters<typeof processDelivery>[1]["config"];
};

export async function processBackfill(payload: SyncJobPayload, deps: QueueDependencies): Promise<void> {
  if (!payload.tenantId) throw new Error("Backfill job is missing tenant context");
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository) throw new Error("Repository not found for backfill");
  const github = deps.githubForInstallation(payload.installationId);
  await synchronizeRefHead({ tenantId: payload.tenantId, repository, installationId: payload.installationId, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID, ref: payload.ref, before: payload.before, after: payload.after, forced: payload.forced }, github, deps.store);
}

export async function processQueueJob(kind: QueueJob, deps: QueueDependencies): Promise<void> {
  if (kind.kind === "webhook_delivery") {
    const payload = kind.payload as SyncJobPayload;
    if (!payload.deliveryId) throw new Error("Webhook job is missing delivery id");
    await processDelivery({ deliveryId: payload.deliveryId, payload }, deps);
    return;
  }
  await processBackfill(kind.payload as SyncJobPayload, deps);
}
