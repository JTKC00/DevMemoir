import type { M1Store } from "@devmemoir/db";
import type { GithubClient } from "@devmemoir/github";
import { commitSyncLogicalKey, type JobPort, type QueueJob, type SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { processDelivery } from "./processor.js";
import { synchronizeRefHead } from "./sync.js";
import { refreshInstallationInventory } from "./inventory.js";

export type QueueDependencies = {
  store: M1Store;
  jobs: JobPort;
  githubForInstallation: (installationId: number) => GithubClient;
  logger: Logger;
  config: Parameters<typeof processDelivery>[1]["config"];
};

export async function processBackfill(payload: SyncJobPayload, deps: QueueDependencies): Promise<void> {
  if (!payload.tenantId) throw new Error("Backfill job is missing tenant context");
  if (!payload.repositoryId || !payload.installationId) throw new Error("Backfill job is missing repository or installation context");
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository) throw new Error("Repository not found for backfill");
  if (repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const installation = await deps.store.getInstallation(payload.installationId);
  if (installation && installation.status && installation.status !== "active") {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const github = deps.githubForInstallation(payload.installationId);
  const ref = payload.ref ?? `refs/heads/${repository.defaultBranch}`;
  const refName = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!ref.startsWith("refs/heads/") || refName !== repository.defaultBranch) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const authoritativeHead = await github.getRefHead({ owner: repository.ownerLogin, repo: repository.name, ref });
  const after = authoritativeHead ?? "0".repeat(40);
  const result = await synchronizeRefHead({ tenantId: payload.tenantId, repository, installationId: payload.installationId, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID, ref, before: payload.before ?? "0".repeat(40), after, forced: payload.forced ?? false }, github, deps.store);
  if (result.status === "partial" && result.nextPage) {
    const continuationPayload: SyncJobPayload = { ...payload, tenantId: payload.tenantId, repositoryId: repository.id, installationId: payload.installationId, owner: repository.ownerLogin, repo: repository.name, ref, before: payload.before ?? "0".repeat(40), after, forced: payload.forced ?? false, nextPage: result.nextPage };
    const logicalKey = commitSyncLogicalKey(repository.id, ref, after, result.nextPage);
    await deps.store.ensureJob(logicalKey, { kind: "sync_commits", ...continuationPayload });
    await deps.jobs.enqueue("sync_commits", logicalKey, continuationPayload);
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "received" }, payload.tenantId);
    return;
  }
  if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "processed", processedAt: new Date() }, payload.tenantId);
}

export async function processInstallationInventory(payload: SyncJobPayload, deps: QueueDependencies): Promise<void> {
  if (!payload.tenantId || !payload.installationGithubId) throw new Error("Inventory job is missing tenant or installation context");
  const installation = await deps.store.getInstallation(payload.installationGithubId);
  if (!installation || (installation.status && installation.status !== "active")) return;
  const result = await refreshInstallationInventory({ tenantId: payload.tenantId, installationGithubId: payload.installationGithubId }, deps.githubForInstallation(payload.installationGithubId), deps.store);
  deps.logger.info({ installation_id: String(payload.installationGithubId), result: `${result.observed}/${result.added}/${result.updated}/${result.removed}` });
}

export async function processQueueJob(kind: QueueJob, deps: QueueDependencies): Promise<void> {
  if (kind.kind === "webhook_delivery") {
    const payload = kind.payload as SyncJobPayload;
    if (!payload.deliveryId) throw new Error("Webhook job is missing delivery id");
    await processDelivery({ deliveryId: payload.deliveryId, payload }, deps);
    return;
  }
  if (kind.kind === "installation_inventory") {
    await processInstallationInventory(kind.payload as SyncJobPayload, deps);
    return;
  }
  await processBackfill(kind.payload as SyncJobPayload, deps);
}
