import { decryptSecret, parseWebhook } from "@devmemoir/domain";
import type { AppConfig } from "@devmemoir/config";
import type { GithubClient } from "@devmemoir/github";
import type { JobPort, SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import type { M1Store } from "@devmemoir/db";
import { synchronizeRefHead } from "./sync.js";

export type WorkerDependencies = {
  config: AppConfig;
  store: M1Store;
  jobs: JobPort;
  githubForInstallation: (installationId: number) => GithubClient;
  logger: Logger;
  now?: () => Date;
};

export async function processDelivery(input: { deliveryId: string; payload: SyncJobPayload; rawPayload?: string }, deps: WorkerDependencies): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const delivery = await deps.store.getDelivery(input.deliveryId, input.payload.tenantId);
  if (!delivery) throw new Error("Delivery not found");
  await deps.store.updateDelivery(delivery.id, { state: "processing", processingAttempts: delivery.processingAttempts + 1 }, delivery.tenantId);
  try {
    const github = deps.githubForInstallation(input.payload.installationId);
    const tenantId = input.payload.tenantId ?? delivery.tenantId;
    const repository = tenantId ? await deps.store.getRepositoryById(tenantId, input.payload.repositoryId) : undefined;
    if (!repository) {
      if (input.rawPayload) parseWebhook(delivery.eventName, JSON.parse(decryptSecret(input.rawPayload, deps.config.ENCRYPTION_KEY_BASE64)));
      await deps.store.updateDelivery(delivery.id, { state: "ignored", processedAt: now() }, delivery.tenantId);
      return;
    }
    if (input.payload.ref) {
      await synchronizeRefHead({ tenantId: repository.tenantId, repository, installationId: input.payload.installationId, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID, ref: input.payload.ref, before: input.payload.before, after: input.payload.after, forced: input.payload.forced }, github, deps.store);
    }
    await deps.store.updateDelivery(delivery.id, { state: "processed", processedAt: now() }, delivery.tenantId);
  } catch (error) {
    const attempts = delivery.processingAttempts + 1;
    const state = attempts >= 5 ? "dead_letter" : "failed";
    await deps.store.updateDelivery(delivery.id, { state, errorCode: error instanceof Error ? error.name : "processing_error" }, delivery.tenantId);
    deps.logger.error({ delivery_guid: delivery.guid, state, attempt: attempts, result: "failed" }, error);
    throw error;
  }
}
