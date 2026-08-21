import type { AppConfig } from "@devmemoir/config";
import type { GithubClient } from "@devmemoir/github";
import type { JobPort, SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import type { M1Store } from "@devmemoir/db";
import { processBackfill } from "./jobs.js";

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
  const existing = await deps.store.getDelivery(input.deliveryId, input.payload.tenantId);
  if (!existing) throw new Error("Delivery not found");
  const delivery = await deps.store.claimDeliveryForProcessing(existing.id, existing.tenantId);
  if (!delivery) return;
  try {
    const tenantId = input.payload.tenantId ?? delivery.tenantId;
    const repository = tenantId
      ? input.payload.repositoryId
        ? await deps.store.getRepositoryById(tenantId, input.payload.repositoryId)
        : input.payload.repositoryGithubId
          ? await deps.store.getRepositoryByGithubId(tenantId, input.payload.repositoryGithubId)
          : undefined
      : undefined;
    if (!repository) {
      await deps.store.updateDelivery(delivery.id, { state: "ignored", processedAt: now() }, delivery.tenantId);
      return;
    }
    const ref = input.payload.ref ?? `refs/heads/${repository.defaultBranch}`;
    const refName = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    if (!ref.startsWith("refs/heads/") || refName !== repository.defaultBranch) {
      await deps.store.updateDelivery(delivery.id, { state: "ignored", processedAt: now() }, delivery.tenantId);
      return;
    }
    const installationId = input.payload.installationId ?? input.payload.installationGithubId;
    if (!installationId) throw new Error("Webhook job is missing installation context");
    await processBackfill({ ...input.payload, tenantId: repository.tenantId, repositoryId: repository.id, installationId, deliveryId: delivery.id, ref }, deps);
  } catch (error) {
    const attempts = delivery.processingAttempts + 1;
    const state = attempts >= 5 ? "dead_letter" : "failed";
    await deps.store.updateDelivery(delivery.id, { state, errorCode: error instanceof Error ? error.name : "processing_error" }, delivery.tenantId);
    deps.logger.error({ delivery_guid: delivery.guid, state, attempt: attempts, result: "failed" }, error);
    throw error;
  }
}
