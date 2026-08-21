import type { AppConfig } from "@devmemoir/config";
import type { GithubClient } from "@devmemoir/github";
import { installationInventoryLogicalKey, type JobPort, type SyncJobPayload } from "@devmemoir/jobs";
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

async function enqueueInventorySignal(input: { tenantId: string; installationGithubId: number; operationId: string }, deps: WorkerDependencies): Promise<void> {
  const logicalKey = installationInventoryLogicalKey(input.installationGithubId, input.operationId);
  const payload: SyncJobPayload = {
    kind: "installation_inventory",
    tenantId: input.tenantId,
    installationGithubId: input.installationGithubId,
    installationId: input.installationGithubId,
    inventoryOperationId: input.operationId,
  };
  await deps.store.ensureJob(logicalKey, payload as Record<string, unknown>);
  await deps.jobs.enqueue("installation_inventory", logicalKey, payload);
}

async function processInstallationSignal(input: { deliveryId: string; payload: SyncJobPayload }, deps: WorkerDependencies, now: () => Date): Promise<void> {
  const installationGithubId = input.payload.installationGithubId ?? input.payload.installationId;
  const tenantId = input.payload.tenantId;
  if (!tenantId || !installationGithubId) throw new Error("Installation webhook is missing tenant or installation context");
  const eventName = input.payload.eventName;
  if (eventName === "installation") {
    if (input.payload.action === "suspend") {
      await deps.store.updateInstallationLifecycle(installationGithubId, "suspended", now());
    } else if (input.payload.action === "deleted") {
      await deps.store.updateInstallationLifecycle(installationGithubId, "deleted", now());
    } else if (input.payload.action === "created" || input.payload.action === "unsuspend") {
      await deps.store.updateInstallationLifecycle(installationGithubId, "active", now());
      await enqueueInventorySignal({ tenantId, installationGithubId, operationId: input.deliveryId }, deps);
    }
  } else if (eventName === "installation_repositories" || eventName === "repository") {
    const installation = await deps.store.getInstallation(installationGithubId);
    if (installation?.status === "suspended" || installation?.status === "deleted" || installation?.status === "disconnected") return;
    await enqueueInventorySignal({ tenantId, installationGithubId, operationId: input.deliveryId }, deps);
  }
  await deps.store.updateDelivery(input.deliveryId, { state: "processed", processedAt: now() }, tenantId);
}

export async function processDelivery(input: { deliveryId: string; payload: SyncJobPayload; rawPayload?: string }, deps: WorkerDependencies): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const existing = await deps.store.getDelivery(input.deliveryId, input.payload.tenantId);
  if (!existing) throw new Error("Delivery not found");
  const delivery = await deps.store.claimDeliveryForProcessing(existing.id, existing.tenantId);
  if (!delivery) return;
  try {
    const tenantId = input.payload.tenantId ?? delivery.tenantId;
    if (input.payload.eventName === "installation" || input.payload.eventName === "installation_repositories" || input.payload.eventName === "repository") {
      await processInstallationSignal({ deliveryId: delivery.id, payload: input.payload }, deps, now);
      return;
    }
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
