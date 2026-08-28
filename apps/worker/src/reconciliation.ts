import type { M1Store } from "@devmemoir/db";
import { GithubAccessError, GithubRateLimitPauseError, type GithubClient } from "@devmemoir/github";
import { repositoryReconciliationLogicalKey, type JobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { ensureInstallationApiAvailable, guardInstallationGithub } from "./durable-github.js";
import { enqueueCurrentHistoricalPosition, processHistoricalBackfill, type HistoricalDependencies } from "./historical.js";
import { refreshInstallationInventory } from "./inventory.js";

export type ReconciliationDependencies = HistoricalDependencies;

function currentTime(deps: ReconciliationDependencies): Date {
  return (deps.now ?? (() => new Date()))();
}

export async function enqueueRepositoryReconciliation(
  input: { tenantId: string; repositoryId: string; installationGithubId: number; reconciliationRunId: string },
  deps: { store: M1Store; jobs: JobPort },
  startAfter?: Date,
): Promise<boolean> {
  const installation = await deps.store.getInstallation(input.installationGithubId);
  if (!installation || installation.tenantId !== input.tenantId || (installation.status && installation.status !== "active")) return false;
  const repository = await deps.store.getRepositoryById(input.tenantId, input.repositoryId);
  if (!repository || repository.installationId !== installation.id || repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) return false;
  const canonicalKey = repositoryReconciliationLogicalKey(input.repositoryId, input.reconciliationRunId);
  const logicalKey = startAfter ? `${canonicalKey}:wake:${startAfter.getTime()}` : canonicalKey;
  const payload: SyncJobPayload = {
    kind: "repository_reconciliation",
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    installationId: input.installationGithubId,
    reconciliationRunId: input.reconciliationRunId,
  };
  await deps.store.ensureJob(logicalKey, payload as Record<string, unknown>);
  await deps.jobs.enqueue("repository_reconciliation", logicalKey, payload, startAfter ? { startAfter } : undefined);
  return true;
}

async function processCoordinator(payload: SyncJobPayload, deps: ReconciliationDependencies): Promise<void> {
  if (!payload.tenantId || !payload.repositoryId || !payload.installationId || !payload.reconciliationRunId) throw new Error("Reconciliation job is missing opaque scope");
  const installation = await deps.store.getInstallation(payload.installationId);
  if (!installation || installation.tenantId !== payload.tenantId || (installation.status && installation.status !== "active")) return;
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository || repository.installationId !== installation.id || repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) return;
  const generation = await deps.store.getRepositoryReconciliationGeneration(payload.tenantId, payload.repositoryId, payload.reconciliationRunId);
  if (generation && !generation.current) return;
  const existing = (await deps.store.listHistoricalProgress(payload.tenantId, payload.repositoryId)).filter((progress) => progress.cursor.reconciliationRunId === payload.reconciliationRunId);
  if (existing.some((progress) => progress.stage === "completed" && progress.status === "completed")) return;
  if (generation?.current || existing.length > 0) {
    const active = existing.find((progress) => progress.status === "in_progress" || progress.status === "paused");
    if (active?.status === "paused" && !active.pausedUntil) return;
    await enqueueCurrentHistoricalPosition({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, installationId: payload.installationId }, deps);
    return;
  }
  const observedAt = currentTime(deps);
  try {
    await ensureInstallationApiAvailable({ tenantId: payload.tenantId, installationGithubId: payload.installationId, store: deps.store, now: observedAt });
    const github = guardInstallationGithub({ tenantId: payload.tenantId, installationGithubId: payload.installationId, store: deps.store, github: deps.githubForInstallation(payload.installationId), now: () => currentTime(deps) });
    await refreshInstallationInventory({ tenantId: payload.tenantId, installationGithubId: payload.installationId, now: observedAt }, github, deps.store);
    const refreshedInstallation = await deps.store.getInstallation(payload.installationId);
    const refreshedRepository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
    if (!refreshedInstallation || refreshedInstallation.tenantId !== payload.tenantId || (refreshedInstallation.status && refreshedInstallation.status !== "active")) return;
    if (!refreshedRepository || refreshedRepository.installationId !== refreshedInstallation.id || refreshedRepository.selected !== true || (refreshedRepository.accessStatus && refreshedRepository.accessStatus !== "accessible")) return;
    const progress = await deps.store.startRepositoryReconciliation({
      tenantId: payload.tenantId,
      repositoryId: payload.repositoryId,
      installationId: refreshedInstallation.id,
      defaultBranch: refreshedRepository.defaultBranch,
      reconciliationRunId: payload.reconciliationRunId,
      now: observedAt,
    });
    if (!progress || (progress.stage === "completed" && progress.status === "completed")) return;
    await enqueueCurrentHistoricalPosition({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, installationId: payload.installationId }, deps);
    deps.logger.info({ installation_id: String(payload.installationId), repository_id: payload.repositoryId, event_type: "reconciliation", state: "queued" });
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await deps.store.pauseInstallationApi({ tenantId: payload.tenantId, installationId: installation.id, pausedUntil: error.resumeAt, reason: `github_${error.code}` });
      await enqueueRepositoryReconciliation({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, installationGithubId: payload.installationId, reconciliationRunId: payload.reconciliationRunId }, deps, error.resumeAt);
      deps.logger.warn({ installation_id: String(payload.installationId), repository_id: payload.repositoryId, event_type: "reconciliation", state: "paused", error_code: `github_${error.code}` });
      return;
    }
    if (error instanceof GithubAccessError) {
      deps.logger.warn({ installation_id: String(payload.installationId), repository_id: payload.repositoryId, event_type: "reconciliation", state: "paused", error_code: `github_${error.code}` });
      return;
    }
    throw error;
  }
}

export async function processRepositoryReconciliation(payload: SyncJobPayload, deps: ReconciliationDependencies): Promise<void> {
  if (payload.stage) {
    await processHistoricalBackfill(payload, deps);
    return;
  }
  await processCoordinator(payload, deps);
}
