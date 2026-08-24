import {
  HISTORICAL_STAGES,
  type HistoricalCursor,
  type HistoricalPageCommitResult,
  type HistoricalProgress,
  type HistoricalSourceStage,
  type InstallationRecord,
  type M1Store,
  type RepositoryRecord,
} from "@devmemoir/db";
import {
  GithubAccessError,
  GithubRateLimitPauseError,
  type GithubClient,
} from "@devmemoir/github";
import {
  historicalBackfillLogicalKey,
  installationInventoryLogicalKey,
  type JobPort,
  type SyncJobPayload,
} from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { ensureInstallationApiAvailable, guardInstallationGithub } from "./durable-github.js";

export const HISTORICAL_PAGE_SIZE = 100;
export const RECENT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type HistoricalDependencies = {
  store: M1Store;
  jobs: JobPort;
  githubForInstallation: (installationId: number) => GithubClient;
  logger: Logger;
  ownerGithubAccountId: number;
  now?: () => Date;
};

type ActivePosition = HistoricalProgress & { stage: HistoricalSourceStage };
type HistoricalScope = { tenantId: string; installationId: number; installation: InstallationRecord; repository: RepositoryRecord };

function isSourceStage(stage: HistoricalProgress["stage"]): stage is HistoricalSourceStage {
  return stage !== "completed";
}

function refFor(stage: HistoricalSourceStage, repository: RepositoryRecord): string | undefined {
  return stage === "default_branch_commits" ? repository.defaultBranch : undefined;
}

function mutableStage(stage: HistoricalSourceStage): boolean {
  return stage === "pull_requests" || stage === "issues" || stage === "releases";
}

function cursorMode(progress: HistoricalProgress): "overlap" | "structural" {
  const mode = progress.cursor.mode;
  if (mode === "overlap" || mode === "structural") return mode;
  return mutableStage(progress.stage as HistoricalSourceStage) ? "overlap" : "structural";
}

function activePosition(progress: HistoricalProgress[]): ActivePosition | undefined {
  for (const stage of HISTORICAL_STAGES) {
    if (stage === "completed") continue;
    const row = progress.find((candidate) => candidate.stage === stage);
    if (row && row.status !== "pending" && row.status !== "completed") return row as ActivePosition;
  }
  return undefined;
}

function jobPayload(
  input: { tenantId: string; repositoryId: string; installationId: number },
  progress: ActivePosition,
): SyncJobPayload {
  return {
    kind: "repository_backfill",
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    installationId: input.installationId,
    stage: progress.stage,
    page: progress.cursor.nextPage,
    ...(progress.anchorHeadSha ? { anchorHeadSha: progress.anchorHeadSha } : {}),
    ...(progress.observationStartedAt ? { observationStartedAt: progress.observationStartedAt.toISOString() } : {}),
  };
}

async function enqueuePosition(
  input: { tenantId: string; repositoryId: string; installationId: number },
  progress: ActivePosition,
  deps: HistoricalDependencies,
  startAfter?: Date,
  wakeIdentity?: string,
): Promise<void> {
  const payload = jobPayload(input, progress);
  const canonicalPositionKey = historicalBackfillLogicalKey(
    input.repositoryId,
    progress.stage,
    progress.cursor.nextPage,
    progress.stage === "default_branch_commits" ? progress.anchorHeadSha : undefined,
  );
  const positionKey = mutableStage(progress.stage) ? `${canonicalPositionKey}:mode:${cursorMode(progress)}` : canonicalPositionKey;
  // A delayed wake is execution infrastructure, not a second canonical cursor.
  // Its suffix avoids colliding with the currently-active stately pg-boss job.
  const logicalKey = wakeIdentity ? `${positionKey}:wake:${wakeIdentity}` : positionKey;
  await deps.store.ensureJob(logicalKey, payload as Record<string, unknown>);
  await deps.jobs.enqueue("repository_backfill", logicalKey, payload, startAfter ? { startAfter } : undefined);
}

async function enqueueCurrent(
  input: { tenantId: string; repositoryId: string; installationId: number },
  deps: HistoricalDependencies,
  startAfter?: Date,
  wakeIdentity?: string,
): Promise<void> {
  const progress = activePosition(await deps.store.listHistoricalProgress(input.tenantId, input.repositoryId));
  if (!progress) return;
  await enqueuePosition(input, progress, deps, startAfter ?? (progress.status === "paused" ? progress.pausedUntil : undefined), wakeIdentity);
}

async function enqueueHistoricalWake(
  payload: SyncJobPayload,
  scope: HistoricalScope,
  deps: HistoricalDependencies,
  resumeAt: Date,
): Promise<void> {
  const input = { tenantId: scope.tenantId, repositoryId: scope.repository.id, installationId: scope.installationId };
  const progress = activePosition(await deps.store.listHistoricalProgress(scope.tenantId, scope.repository.id));
  if (progress) {
    await enqueuePosition(input, progress, deps, resumeAt, String(resumeAt.getTime()));
    return;
  }

  // A paused coordinator may not have created cursors yet. Keep the durable
  // cursor absent and schedule one timestamped wake for the same coordinator.
  const logicalKey = `${historicalBackfillLogicalKey(scope.repository.id, "coordinator")}:wake:${resumeAt.getTime()}`;
  const wakePayload: SyncJobPayload = {
    ...payload,
    kind: "repository_backfill",
    tenantId: scope.tenantId,
    repositoryId: scope.repository.id,
    installationId: scope.installationId,
  };
  await deps.store.ensureJob(logicalKey, wakePayload as Record<string, unknown>);
  await deps.jobs.enqueue("repository_backfill", logicalKey, wakePayload, { startAfter: resumeAt });
}

async function gate(
  payload: SyncJobPayload,
  deps: HistoricalDependencies,
): Promise<HistoricalScope | undefined> {
  if (!payload.tenantId || !payload.repositoryId || !payload.installationId) throw new Error("Historical job is missing opaque scope");
  const installation = await deps.store.getInstallation(payload.installationId);
  if (!installation || installation.tenantId !== payload.tenantId || (installation.status && installation.status !== "active")) return undefined;
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository || repository.installationId !== installation.id || repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) return undefined;
  return { tenantId: payload.tenantId, installationId: payload.installationId, installation, repository };
}

function sanitizedAccessCode(error: GithubAccessError): string {
  return `github_${error.code}`;
}

async function pauseForAccess(
  input: { tenantId: string; installationId: number; repository: RepositoryRecord; progress: ActivePosition },
  error: GithubAccessError,
  deps: HistoricalDependencies,
): Promise<void> {
  const errorCode = sanitizedAccessCode(error);
  await deps.store.pauseHistoricalStage({
    tenantId: input.tenantId,
    repositoryId: input.repository.id,
    stage: input.progress.stage,
    ...(refFor(input.progress.stage, input.repository) ? { refName: input.repository.defaultBranch } : {}),
    errorCode,
  });
  const operationId = `backfill-access:${input.repository.id}:${input.progress.stage}:${input.progress.cursor.nextPage}`;
  const logicalKey = installationInventoryLogicalKey(input.installationId, operationId);
  const payload: SyncJobPayload = {
    kind: "installation_inventory",
    tenantId: input.tenantId,
    installationGithubId: input.installationId,
    installationId: input.installationId,
    repositoryId: input.repository.id,
    inventoryOperationId: operationId,
  };
  await deps.store.ensureJob(logicalKey, payload as Record<string, unknown>);
  await deps.jobs.enqueue("installation_inventory", logicalKey, payload);
  deps.logger.warn({ installation_id: String(input.installationId), repository_id: input.repository.id, event_type: input.progress.stage, state: "paused", error_code: errorCode });
}

async function pauseForRateLimit(
  input: { tenantId: string; installationId: number; repository: RepositoryRecord; progress: ActivePosition },
  error: GithubRateLimitPauseError,
  deps: HistoricalDependencies,
): Promise<void> {
  const errorCode = `github_${error.code}`;
  await deps.store.pauseInstallationApi({ tenantId: input.tenantId, installationId: input.repository.installationId, pausedUntil: error.resumeAt, reason: errorCode });
  const paused = await deps.store.pauseHistoricalStage({
    tenantId: input.tenantId,
    repositoryId: input.repository.id,
    stage: input.progress.stage,
    ...(refFor(input.progress.stage, input.repository) ? { refName: input.repository.defaultBranch } : {}),
    pausedUntil: error.resumeAt,
    errorCode,
  });
  await enqueuePosition(
    { tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.installationId },
    (paused ?? input.progress) as ActivePosition,
    deps,
    error.resumeAt,
    String(error.resumeAt.getTime()),
  );
  deps.logger.warn({ installation_id: String(input.installationId), repository_id: input.repository.id, event_type: input.progress.stage, state: "paused", error_code: errorCode });
}

async function commitDefaultBranchPage(
  input: { tenantId: string; installationId: number; repository: RepositoryRecord; progress: ActivePosition; github: GithubClient; observedAt: Date },
  deps: HistoricalDependencies,
): Promise<HistoricalPageCommitResult> {
  const ref = `refs/heads/${input.repository.defaultBranch}`;
  const currentHead = await input.github.getRefHead({ owner: input.repository.ownerLogin, repo: input.repository.name, ref });
  if (!currentHead) throw new GithubAccessError("not_found", 404);
  let progress = input.progress;
  if (!progress.anchorHeadSha || progress.anchorHeadSha !== currentHead) {
    const reset = await deps.store.resetCommitTraversal({
      tenantId: input.tenantId,
      repositoryId: input.repository.id,
      installationId: input.repository.installationId,
      refName: input.repository.defaultBranch,
      anchorHeadSha: currentHead,
      now: input.observedAt,
    });
    if (!reset) return { applied: false, reason: "gated", progress: input.progress };
    progress = reset as ActivePosition;
  }
  const page = progress.cursor.nextPage;
  const response = await input.github.listCommits({ owner: input.repository.ownerLogin, repo: input.repository.name, sha: currentHead, page, perPage: HISTORICAL_PAGE_SIZE });
  const finalPage = response.nextPage === undefined;
  if (finalPage) {
    const publishHead = await input.github.getRefHead({ owner: input.repository.ownerLogin, repo: input.repository.name, ref });
    if (publishHead !== currentHead) {
      if (publishHead) await deps.store.resetCommitTraversal({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, refName: input.repository.defaultBranch, anchorHeadSha: publishHead, now: input.observedAt });
      return { applied: false, reason: "checkpoint_mismatch", progress };
    }
  }
  return deps.store.commitHistoricalPage({
    tenantId: input.tenantId,
    repositoryId: input.repository.id,
    installationId: input.repository.installationId,
    stage: "default_branch_commits",
    refName: input.repository.defaultBranch,
    anchorHeadSha: currentHead,
    expectedCursor: progress.cursor,
    nextCursor: { nextPage: response.nextPage ?? page, mode: "structural" },
    observedAt: input.observedAt,
    finalPage,
    facts: response.commits.map((commit) => {
      const normalized = { ...commit, repositoryId: input.repository.id };
      return { commit: normalized, ...(commit.htmlUrl ? { htmlUrl: commit.htmlUrl } : {}) };
    }),
  });
}

async function commitInventoryPage(
  input: { tenantId: string; repository: RepositoryRecord; progress: ActivePosition; github: GithubClient; observedAt: Date },
  deps: HistoricalDependencies,
): Promise<HistoricalPageCommitResult> {
  const common = { owner: input.repository.ownerLogin, repo: input.repository.name, page: input.progress.cursor.nextPage, perPage: HISTORICAL_PAGE_SIZE };
  const expectedCursor = input.progress.cursor;
  if (input.progress.stage === "branches") {
    const response = await input.github.listBranches(common);
    return deps.store.commitHistoricalPage({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, stage: "branches", expectedCursor, nextCursor: { nextPage: response.nextPage ?? common.page, mode: "structural" }, observedAt: input.observedAt, finalPage: response.nextPage === undefined, facts: response.branches.map((fact) => ({ name: fact.name, headSha: fact.headSha, protected: fact.protected ?? false })) });
  }
  const response = await input.github.listTags(common);
  return deps.store.commitHistoricalPage({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, stage: "tags", expectedCursor, nextCursor: { nextPage: response.nextPage ?? common.page, mode: "structural" }, observedAt: input.observedAt, finalPage: response.nextPage === undefined, facts: response.tags.map((fact) => ({ name: fact.name, targetSha: fact.targetSha })) });
}

async function commitMutablePage(
  input: { tenantId: string; repository: RepositoryRecord; progress: ActivePosition; github: GithubClient; observedAt: Date },
  deps: HistoricalDependencies,
): Promise<HistoricalPageCommitResult> {
  const mode = cursorMode(input.progress);
  const overlap = mode === "overlap";
  const page = overlap ? 1 : input.progress.cursor.nextPage;
  const common = { owner: input.repository.ownerLogin, repo: input.repository.name, page, perPage: HISTORICAL_PAGE_SIZE };
  const windowStart = new Date(input.observedAt.getTime() - RECENT_REFRESH_WINDOW_MS).toISOString();
  const nextCursor = (nextPage?: number): HistoricalCursor => overlap
    ? { nextPage: 1, mode: "structural" }
    : { nextPage: nextPage ?? page, mode: "structural" };
  const finalPage = (nextPage?: number): boolean => !overlap && nextPage === undefined;
  if (input.progress.stage === "pull_requests") {
    const response = await input.github.listPullRequests({ ...common, ...(overlap ? { sort: "updated" as const, direction: "desc" as const } : {}) });
    return deps.store.commitHistoricalPage({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, stage: "pull_requests", expectedCursor: input.progress.cursor, nextCursor: nextCursor(response.nextPage), observedAt: input.observedAt, highWaterAt: input.observedAt, finalPage: finalPage(response.nextPage), facts: response.pullRequests.map((fact) => ({ githubId: fact.id, number: fact.number, title: fact.title, state: fact.state, draft: fact.draft ?? false, ...(fact.author ? { author: fact.author } : {}), ...(fact.mergedBy ? { merger: fact.mergedBy } : {}), baseRef: fact.baseRef, baseSha: fact.baseSha, headRef: fact.headRef, headSha: fact.headSha, ...(fact.htmlUrl ? { sourceUrl: fact.htmlUrl } : {}), createdAt: fact.createdAt, updatedAt: fact.updatedAt, ...(fact.closedAt ? { closedAt: fact.closedAt } : {}), ...(fact.mergedAt ? { mergedAt: fact.mergedAt } : {}) })) });
  }
  if (input.progress.stage === "issues") {
    const response = await input.github.listIssues({ ...common, ...(overlap ? { since: windowStart, sort: "updated" as const, direction: "desc" as const } : {}) });
    return deps.store.commitHistoricalPage({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, stage: "issues", expectedCursor: input.progress.cursor, nextCursor: nextCursor(response.nextPage), observedAt: input.observedAt, highWaterAt: input.observedAt, finalPage: finalPage(response.nextPage), facts: response.issues.map((fact) => ({ githubId: fact.id, number: fact.number, title: fact.title, state: fact.state, ...(fact.stateReason ? { stateReason: fact.stateReason } : {}), ...(fact.author ? { author: fact.author } : {}), ...(fact.htmlUrl ? { sourceUrl: fact.htmlUrl } : {}), createdAt: fact.createdAt, updatedAt: fact.updatedAt, ...(fact.closedAt ? { closedAt: fact.closedAt } : {}) })) });
  }
  const response = await input.github.listReleases(common);
  return deps.store.commitHistoricalPage({ tenantId: input.tenantId, repositoryId: input.repository.id, installationId: input.repository.installationId, stage: "releases", expectedCursor: input.progress.cursor, nextCursor: nextCursor(response.nextPage), observedAt: input.observedAt, highWaterAt: input.observedAt, finalPage: finalPage(response.nextPage), facts: response.releases.map((fact) => ({ githubId: fact.id, tagName: fact.tagName, ...(fact.name ? { name: fact.name } : {}), draft: fact.draft, prerelease: fact.prerelease, ...(fact.author ? { author: fact.author } : {}), ...(fact.htmlUrl ? { sourceUrl: fact.htmlUrl } : {}), createdAt: fact.createdAt, updatedAt: fact.publishedAt ?? fact.createdAt, ...(fact.publishedAt ? { publishedAt: fact.publishedAt } : {}) })) });
}

/** Processes exactly one durable source page and schedules only the next durable position. */
export async function processHistoricalBackfill(payload: SyncJobPayload, deps: HistoricalDependencies): Promise<void> {
  const scoped = await gate(payload, deps);
  if (!scoped) return;
  const observedAt = (deps.now ?? (() => new Date()))();

  // Check the installation pause before reading/creating a cursor and before
  // obtaining a client. A replacement worker therefore emits only one
  // timestamped wake and makes zero outbound calls during the pause window.
  try {
    await ensureInstallationApiAvailable({ tenantId: scoped.tenantId, installationGithubId: scoped.installationId, store: deps.store, now: observedAt });
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await enqueueHistoricalWake(payload, scoped, deps, error.resumeAt);
      return;
    }
    throw error;
  }

  let rows = await deps.store.listHistoricalProgress(scoped.tenantId, scoped.repository.id);
  if (rows.length === 0) {
    await deps.store.startHistoricalBackfill({ tenantId: scoped.tenantId, repositoryId: scoped.repository.id, installationId: scoped.repository.installationId, defaultBranch: scoped.repository.defaultBranch, now: observedAt });
    rows = await deps.store.listHistoricalProgress(scoped.tenantId, scoped.repository.id);
  }
  let progress = activePosition(rows);
  if (!progress) return;
  if (progress.status === "paused") {
    if (progress.pausedUntil && progress.pausedUntil > observedAt) {
      await enqueueHistoricalWake(payload, scoped, deps, progress.pausedUntil);
      return;
    }
    if (!progress.pausedUntil) return;
    await deps.store.resumeInstallationApi({ tenantId: scoped.tenantId, installationId: scoped.repository.installationId, now: observedAt });
    progress = (await deps.store.resumeHistoricalStage({ tenantId: scoped.tenantId, repositoryId: scoped.repository.id, stage: progress.stage, ...(refFor(progress.stage, scoped.repository) ? { refName: scoped.repository.defaultBranch } : {}), now: observedAt })) as ActivePosition | undefined;
    if (!progress || progress.status === "paused") return;
  }
  const github = guardInstallationGithub({ tenantId: scoped.tenantId, installationGithubId: scoped.installationId, store: deps.store, github: deps.githubForInstallation(scoped.installationId), now: deps.now ?? (() => new Date()) });
  let commitResult: HistoricalPageCommitResult;
  try {
    if (progress.stage === "default_branch_commits") commitResult = await commitDefaultBranchPage({ tenantId: scoped.tenantId, installationId: scoped.installationId, repository: scoped.repository, progress, github, observedAt }, deps);
    else if (progress.stage === "branches" || progress.stage === "tags") commitResult = await commitInventoryPage({ tenantId: scoped.tenantId, repository: scoped.repository, progress, github, observedAt }, deps);
    else commitResult = await commitMutablePage({ tenantId: scoped.tenantId, repository: scoped.repository, progress, github, observedAt }, deps);
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await pauseForRateLimit({ tenantId: scoped.tenantId, installationId: scoped.installationId, repository: scoped.repository, progress }, error, deps);
      return;
    }
    if (error instanceof GithubAccessError) {
      await pauseForAccess({ tenantId: scoped.tenantId, installationId: scoped.installationId, repository: scoped.repository, progress }, error, deps);
      return;
    }
    throw error;
  }

  if (!commitResult.applied) {
    if (commitResult.reason === "checkpoint_mismatch") {
      // A stale physical delivery has already done its outbound work. Read
      // the current cursor and recover from it; no facts are rewritten here.
      await enqueueCurrent({ tenantId: scoped.tenantId, repositoryId: scoped.repository.id, installationId: scoped.installationId }, deps);
      return;
    }

    const currentInstallation = await deps.store.getInstallation(scoped.installationId);
    if (currentInstallation?.tenantId === scoped.tenantId && currentInstallation.apiPausedUntil && currentInstallation.apiPausedUntil > observedAt) {
      await enqueueHistoricalWake(payload, { ...scoped, installation: currentInstallation }, deps, currentInstallation.apiPausedUntil);
      return;
    }
    if (commitResult.progress.status === "paused" && commitResult.progress.pausedUntil && commitResult.progress.pausedUntil > observedAt) {
      await enqueueHistoricalWake(payload, scoped, deps, commitResult.progress.pausedUntil);
    }
    return;
  }

  await deps.store.reprojectRepository({ tenantId: scoped.tenantId, repositoryId: scoped.repository.id, ownerGithubAccountId: deps.ownerGithubAccountId });

  await enqueueCurrent({ tenantId: scoped.tenantId, repositoryId: scoped.repository.id, installationId: scoped.installationId }, deps);
  const counts = await deps.store.getHistoricalSourceCounts(scoped.tenantId, scoped.repository.id);
  deps.logger.info({ repository_id: scoped.repository.id, installation_id: String(scoped.installationId), event_type: progress.stage, state: "checkpointed", result: `${counts.commits}/${counts.branches}/${counts.tags}/${counts.pullRequests}/${counts.issues}/${counts.releases}` });
}

/** Resume access-paused work only after the authoritative inventory retained selection and access. */
export async function resumeHistoricalAfterInventory(payload: SyncJobPayload, deps: HistoricalDependencies): Promise<void> {
  if (!payload.tenantId || !payload.repositoryId || !payload.installationGithubId) return;
  const repository = await deps.store.getRepositoryById(payload.tenantId, payload.repositoryId);
  if (!repository || repository.selected !== true || (repository.accessStatus && repository.accessStatus !== "accessible")) return;
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.store.listHistoricalProgress(payload.tenantId, repository.id);
  for (const row of rows) {
    if (!isSourceStage(row.stage) || row.status !== "paused" || !row.errorCode?.startsWith("github_")) continue;
    await deps.store.resumeHistoricalStage({ tenantId: payload.tenantId, repositoryId: repository.id, stage: row.stage, ...(refFor(row.stage, repository) ? { refName: repository.defaultBranch } : {}), now });
  }
  await enqueueCurrent({ tenantId: payload.tenantId, repositoryId: repository.id, installationId: payload.installationGithubId }, deps);
}
