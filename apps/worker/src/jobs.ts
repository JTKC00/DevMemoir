import type { HistoricalSourceStage, M1Store } from "@devmemoir/db";
import { GithubAccessError, GithubRateLimitPauseError, type GithubClient } from "@devmemoir/github";
import { commitSyncLogicalKey, installationInventoryLogicalKey, type JobPort, type QueueJob, type SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { processDelivery } from "./processor.js";
import { synchronizeRefHead } from "./sync.js";
import { refreshInstallationInventory } from "./inventory.js";
import { processHistoricalBackfill, resumeHistoricalAfterInventory } from "./historical.js";

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
  const installation = await deps.store.getInstallation(payload.installationId);
  if (!installation || (installation.status && installation.status !== "active")) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository) throw new Error("Repository not found for backfill");
  if (repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) {
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
    const continuationPayload: SyncJobPayload = {
      kind: "sync_commits",
      tenantId: payload.tenantId,
      repositoryId: repository.id,
      installationId: payload.installationId,
      ...(payload.deliveryId ? { deliveryId: payload.deliveryId } : {}),
      before: payload.before ?? "0".repeat(40),
      after,
      forced: payload.forced ?? false,
      nextPage: result.nextPage,
    };
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
  try {
    const result = await refreshInstallationInventory({ tenantId: payload.tenantId, installationGithubId: payload.installationGithubId }, deps.githubForInstallation(payload.installationGithubId), deps.store);
    await resumeHistoricalAfterInventory(payload, { ...deps, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID });
    deps.logger.info({ installation_id: String(payload.installationGithubId), result: `${result.observed}/${result.added}/${result.updated}/${result.removed}` });
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await deps.store.pauseInstallationApi({ tenantId: payload.tenantId, installationId: installation.id, pausedUntil: error.resumeAt, reason: `github_${error.code}` });
      if (payload.repositoryId) {
        const active = (await deps.store.listHistoricalProgress(payload.tenantId, payload.repositoryId)).find((row) => row.stage !== "completed" && row.status === "in_progress");
        if (active) await deps.store.pauseHistoricalStage({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, stage: active.stage as HistoricalSourceStage, ...(active.refName ? { refName: active.refName } : {}), pausedUntil: error.resumeAt, errorCode: `github_${error.code}` });
      }
      const operationId = payload.inventoryOperationId ?? `rate-resume:${payload.repositoryId ?? "installation"}`;
      const wakeOperationId = `${operationId}:wake:${error.resumeAt.getTime()}`;
      const logicalKey = installationInventoryLogicalKey(payload.installationGithubId, wakeOperationId);
      const retryPayload: SyncJobPayload = { ...payload, kind: "installation_inventory", inventoryOperationId: wakeOperationId };
      await deps.store.ensureJob(logicalKey, retryPayload as Record<string, unknown>);
      await deps.jobs.enqueue("installation_inventory", logicalKey, retryPayload, { startAfter: error.resumeAt });
      deps.logger.warn({ installation_id: String(payload.installationGithubId), state: "paused", error_code: `github_${error.code}` });
      return;
    }
    if (error instanceof GithubAccessError) {
      deps.logger.warn({ installation_id: String(payload.installationGithubId), state: "paused", error_code: `github_${error.code}` });
      return;
    }
    throw error;
  }
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
  if (kind.kind === "repository_backfill") {
    await processHistoricalBackfill(kind.payload as SyncJobPayload, { ...deps, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID });
    return;
  }
  await processBackfill(kind.payload as SyncJobPayload, deps);
}
