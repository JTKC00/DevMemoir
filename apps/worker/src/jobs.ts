import type { HistoricalSourceStage, M1Store } from "@devmemoir/db";
import { GithubAccessError, GithubRateLimitPauseError, type GithubAppClient, type GithubClient } from "@devmemoir/github";
import { commitSyncLogicalKey, installationInventoryLogicalKey, type JobPort, type QueueJob, type SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { processDelivery } from "./processor.js";
import { synchronizeRefHead } from "./sync.js";
import { refreshInstallationInventory } from "./inventory.js";
import { processHistoricalBackfill, resumeHistoricalAfterInventory } from "./historical.js";
import { ensureInstallationApiAvailable, guardInstallationGithub } from "./durable-github.js";
import { processRepositoryReconciliation } from "./reconciliation.js";
import { processGithubDeliveryAudit } from "./delivery-audit.js";
import { processMaintenanceTick } from "./maintenance.js";

export type QueueDependencies = {
  store: M1Store;
  jobs: JobPort;
  githubForInstallation: (installationId: number) => GithubClient;
  githubApp?: GithubAppClient;
  logger: Logger;
  config: Parameters<typeof processDelivery>[1]["config"];
  now?: () => Date;
};

function workerNow(deps: QueueDependencies): Date {
  return (deps.now ?? (() => new Date()))();
}

function wakeOperationId(operationId: string, resumeAt: Date): string {
  const base = operationId.replace(/:wake:\d+$/, "");
  return `${base}:wake:${resumeAt.getTime()}`;
}

async function enqueueInventoryWake(payload: SyncJobPayload, deps: QueueDependencies, resumeAt: Date): Promise<void> {
  const operationId = wakeOperationId(payload.inventoryOperationId ?? `rate-resume:${payload.repositoryId ?? "installation"}`, resumeAt);
  const logicalKey = installationInventoryLogicalKey(payload.installationGithubId ?? payload.installationId ?? 0, operationId);
  const retryPayload: SyncJobPayload = { ...payload, kind: "installation_inventory", inventoryOperationId: operationId };
  await deps.store.ensureJob(logicalKey, retryPayload as Record<string, unknown>);
  await deps.jobs.enqueue("installation_inventory", logicalKey, retryPayload, { startAfter: resumeAt });
}

async function pauseSyncForRateLimit(payload: SyncJobPayload, repository: Awaited<ReturnType<M1Store["getRepositoryById"]>>, error: GithubRateLimitPauseError, deps: QueueDependencies): Promise<void> {
  if (!repository || !payload.installationId || !payload.tenantId) return;
  const installation = await deps.store.getInstallation(payload.installationId);
  if (!installation || installation.tenantId !== payload.tenantId) return;
  await deps.store.pauseInstallationApi({ tenantId: payload.tenantId, installationId: installation.id, pausedUntil: error.resumeAt, reason: `github_${error.code}` });
  const ref = payload.ref ?? `refs/heads/${repository.defaultBranch}`;
  const after = payload.after ?? "pending";
  const baseKey = commitSyncLogicalKey(repository.id, ref, after, payload.nextPage);
  const logicalKey = `${baseKey}:wake:${error.resumeAt.getTime()}`;
  const retryPayload: SyncJobPayload = { ...payload, kind: "sync_commits", repositoryId: repository.id, installationId: payload.installationId };
  await deps.store.ensureJob(logicalKey, retryPayload as Record<string, unknown>);
  await deps.jobs.enqueue("sync_commits", logicalKey, retryPayload, { startAfter: error.resumeAt });
  if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "received" }, payload.tenantId);
  deps.logger.warn({ installation_id: String(payload.installationId), repository_id: repository.id, state: "paused", error_code: `github_${error.code}` });
}

export async function processBackfill(payload: SyncJobPayload, deps: QueueDependencies): Promise<void> {
  if (!payload.tenantId) throw new Error("Backfill job is missing tenant context");
  if (!payload.repositoryId || !payload.installationId) throw new Error("Backfill job is missing repository or installation context");
  const installation = await deps.store.getInstallation(payload.installationId);
  if (!installation || installation.tenantId !== payload.tenantId || (installation.status && installation.status !== "active")) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository) throw new Error("Repository not found for backfill");
  if (repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  const ref = payload.ref ?? `refs/heads/${repository.defaultBranch}`;
  const refName = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
  if (!ref.startsWith("refs/heads/") || refName !== repository.defaultBranch) {
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "ignored", processedAt: new Date() }, payload.tenantId);
    return;
  }
  try {
    await ensureInstallationApiAvailable({ tenantId: payload.tenantId, installationGithubId: payload.installationId, store: deps.store, now: workerNow(deps) });
    const github = guardInstallationGithub({ tenantId: payload.tenantId, installationGithubId: payload.installationId, store: deps.store, github: deps.githubForInstallation(payload.installationId), now: () => workerNow(deps) });
    const authoritativeHead = await github.getRefHead({ owner: repository.ownerLogin, repo: repository.name, ref });
    const after = authoritativeHead ?? "0".repeat(40);
    const result = await synchronizeRefHead({ tenantId: payload.tenantId, repository, installationId: payload.installationId, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID, ref, before: payload.before ?? "0".repeat(40), after, forced: payload.forced ?? false }, github, deps.store);
    await deps.store.reprojectRepository({ tenantId: payload.tenantId, repositoryId: repository.id, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID });
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
    if (payload.deliveryId) await deps.store.updateDelivery(payload.deliveryId, { state: "processed", processedAt: workerNow(deps) }, payload.tenantId);
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await pauseSyncForRateLimit(payload, repository, error, deps);
      return;
    }
    throw error;
  }
}

export async function processInstallationInventory(payload: SyncJobPayload, deps: QueueDependencies): Promise<void> {
  if (!payload.tenantId || !payload.installationGithubId) throw new Error("Inventory job is missing tenant or installation context");
  const installation = await deps.store.getInstallation(payload.installationGithubId);
  if (!installation || installation.tenantId !== payload.tenantId || (installation.status && installation.status !== "active")) return;
  const observedAt = workerNow(deps);
  try {
    await ensureInstallationApiAvailable({ tenantId: payload.tenantId, installationGithubId: payload.installationGithubId, store: deps.store, now: observedAt });
    const github = guardInstallationGithub({ tenantId: payload.tenantId, installationGithubId: payload.installationGithubId, store: deps.store, github: deps.githubForInstallation(payload.installationGithubId), now: () => workerNow(deps) });
    const result = await refreshInstallationInventory({ tenantId: payload.tenantId, installationGithubId: payload.installationGithubId, now: observedAt }, github, deps.store);
    const selected = (await deps.store.listRepositories(payload.tenantId))[0];
    let projectionVersion: number | undefined;
    if (selected) {
      try {
        const projection = await deps.store.reprojectRepository({
          tenantId: payload.tenantId,
          repositoryId: selected.id,
          ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID,
        });
        projectionVersion = projection.projectionVersion;
      } catch (error) {
        deps.logger.error({
          installation_id: String(payload.installationGithubId),
          repository_id: selected.id,
          state: "failed",
          error_code: "projection_failed",
        }, error);
        throw error;
      }
    }
    await resumeHistoricalAfterInventory(payload, { ...deps, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID });
    deps.logger.info({
      installation_id: String(payload.installationGithubId),
      ...(selected ? { repository_id: selected.id } : {}),
      result: `${result.observed}/${result.added}/${result.updated}/${result.removed}`,
      changed_count: result.projectionRelevantRepositoryIds.length,
      ...(projectionVersion === undefined ? {} : { projection_version: projectionVersion, state: "projected" }),
    });
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await deps.store.pauseInstallationApi({ tenantId: payload.tenantId, installationId: installation.id, pausedUntil: error.resumeAt, reason: `github_${error.code}` });
      if (payload.repositoryId) {
        const active = (await deps.store.listHistoricalProgress(payload.tenantId, payload.repositoryId)).find((row) => row.stage !== "completed" && (row.status === "in_progress" || row.status === "paused"));
        if (active) await deps.store.pauseHistoricalStage({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, stage: active.stage as HistoricalSourceStage, ...(active.refName ? { refName: active.refName } : {}), pausedUntil: error.resumeAt, errorCode: `github_${error.code}` });
      }
      await enqueueInventoryWake(payload, deps, error.resumeAt);
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
  if (kind.kind === "repository_reconciliation") {
    await processRepositoryReconciliation(kind.payload as SyncJobPayload, { ...deps, ownerGithubAccountId: deps.config.OWNER_GITHUB_USER_ID });
    return;
  }
  if (kind.kind === "github_delivery_audit") {
    if (!deps.githubApp) throw new Error("App-JWT GitHub client is required for delivery audit");
    await processGithubDeliveryAudit(kind.payload as SyncJobPayload, { store: deps.store, jobs: deps.jobs, githubApp: deps.githubApp, logger: deps.logger, ...(deps.now ? { now: deps.now } : {}) });
    return;
  }
  if (kind.kind === "maintenance_active" || kind.kind === "maintenance_authorized" || kind.kind === "maintenance_audit") {
    await processMaintenanceTick(kind.payload as SyncJobPayload, deps);
    return;
  }
  await processBackfill(kind.payload as SyncJobPayload, deps);
}
