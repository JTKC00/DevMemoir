import { createId, GITHUB_REDELIVERY_CLAIM_LEASE_MS, GITHUB_REDELIVERY_MAX_ATTEMPTS, githubDeliveryAttemptSucceeded, isRepairableWebhookEvent, nextRedeliveryEligibleAt } from "@devmemoir/domain";
import type { M1Store } from "@devmemoir/db";
import { GithubAccessError, GithubRateLimitPauseError, GithubTransientError, type GithubAppClient } from "@devmemoir/github";
import { deliveryAuditLogicalKey, deliveryAuditWakeLogicalKey, deliveryRepairWakeLogicalKey, type JobPort, type SyncJobPayload } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";

export type DeliveryAuditDependencies = {
  store: M1Store;
  jobs: JobPort;
  githubApp: GithubAppClient;
  logger: Logger;
  now?: () => Date;
};

function currentTime(deps: DeliveryAuditDependencies): Date {
  return (deps.now ?? (() => new Date()))();
}

async function ensureAuditAvailable(audit: NonNullable<Awaited<ReturnType<M1Store["getGithubDeliveryAudit"]>>>, now: Date): Promise<void> {
  if (audit.status === "paused" && audit.pausedUntil && audit.pausedUntil > now) {
    const code = audit.pauseReason === "github_secondary_rate_limit" ? "secondary_rate_limit" : audit.pauseReason === "github_retry_after" ? "retry_after" : "primary_rate_limit";
    throw new GithubRateLimitPauseError(code, 429, audit.pausedUntil);
  }
}

async function enqueueRepairWake(input: { githubAppId: number; auditRunId: string; deliveryGuid: string; githubDeliveryId: number; resumeAt: Date }, deps: DeliveryAuditDependencies): Promise<void> {
  await deps.jobs.enqueue(
    "github_delivery_audit",
    deliveryRepairWakeLogicalKey(input.githubAppId, input.deliveryGuid, input.resumeAt),
    { kind: "github_delivery_audit", githubAppId: input.githubAppId, auditRunId: input.auditRunId, deliveryGuid: input.deliveryGuid, githubDeliveryId: input.githubDeliveryId },
    { startAfter: input.resumeAt },
  );
}

export async function enqueueGithubDeliveryAudit(
  input: { githubAppId: number; auditRunId?: string },
  deps: DeliveryAuditDependencies,
  startAfter?: Date,
): Promise<string> {
  const audit = await deps.store.startGithubDeliveryAudit({ githubAppId: input.githubAppId, auditRunId: input.auditRunId ?? createId(), now: currentTime(deps) });
  const payload: SyncJobPayload = {
    kind: "github_delivery_audit",
    githubAppId: audit.githubAppId,
    auditRunId: audit.currentRunId,
    page: audit.pageNumber,
    ...(audit.listCursor ? { cursor: audit.listCursor } : {}),
  };
  const logicalKey = startAfter
    ? deliveryAuditWakeLogicalKey(audit.githubAppId, audit.currentRunId, startAfter)
    : deliveryAuditLogicalKey(audit.githubAppId, audit.currentRunId, audit.pageNumber);
  await deps.jobs.enqueue("github_delivery_audit", logicalKey, payload, startAfter ? { startAfter } : undefined);
  return audit.currentRunId;
}

export async function resumeGithubDeliveryRepairs(githubAppId: number, deps: DeliveryAuditDependencies): Promise<number> {
  const now = currentTime(deps);
  const repairs = await deps.store.listRecoverableGithubDeliveryRepairs(githubAppId);
  let enqueued = 0;
  for (const repair of repairs) {
    const resumeAt = repair.nextEligibleAt && repair.nextEligibleAt > now ? repair.nextEligibleAt : now;
    await enqueueRepairWake({
      githubAppId: repair.githubAppId,
      auditRunId: repair.auditRunId ?? createId(),
      deliveryGuid: repair.githubDeliveryGuid,
      githubDeliveryId: repair.githubDeliveryId,
      resumeAt,
    }, deps);
    enqueued += 1;
  }
  return enqueued;
}

async function pauseAndWake(payload: SyncJobPayload, error: GithubRateLimitPauseError, deps: DeliveryAuditDependencies): Promise<void> {
  if (!payload.githubAppId || !payload.auditRunId) return;
  await deps.store.pauseGithubDeliveryAudit({ githubAppId: payload.githubAppId, auditRunId: payload.auditRunId, pausedUntil: error.resumeAt, errorCode: `github_${error.code}` });
  const wakePayload: SyncJobPayload = {
    kind: "github_delivery_audit",
    githubAppId: payload.githubAppId,
    auditRunId: payload.auditRunId,
    ...(payload.page !== undefined ? { page: payload.page } : {}),
    ...(payload.cursor ? { cursor: payload.cursor } : {}),
    ...(payload.deliveryGuid ? { deliveryGuid: payload.deliveryGuid } : {}),
    ...(payload.githubDeliveryId ? { githubDeliveryId: payload.githubDeliveryId } : {}),
  };
  await deps.jobs.enqueue("github_delivery_audit", deliveryAuditWakeLogicalKey(payload.githubAppId, payload.auditRunId, error.resumeAt), wakePayload, { startAfter: error.resumeAt });
  deps.logger.warn({ audit_run_id: payload.auditRunId, state: "paused", error_code: `github_${error.code}`, rate_limit_bucket: error.code, retry_at: error.resumeAt.toISOString() });
}

async function requestRedelivery(guid: string, githubDeliveryId: number, auditRunId: string, deps: DeliveryAuditDependencies): Promise<"requested" | "skipped"> {
  const now = currentTime(deps);
  const claim = await deps.store.claimGithubDeliveryRedelivery({
    guid,
    githubDeliveryId,
    now,
    maxAttempts: GITHUB_REDELIVERY_MAX_ATTEMPTS,
  });
  if (!claim.allowed) {
    deps.logger.info({ delivery_guid: guid, audit_run_id: auditRunId, state: claim.repair.status, result: claim.reason, attempt: claim.repair.attemptCount });
    return "skipped";
  }
  const leaseAt = claim.repair.nextEligibleAt ?? new Date(now.getTime() + GITHUB_REDELIVERY_CLAIM_LEASE_MS);
  await enqueueRepairWake({
    githubAppId: claim.repair.githubAppId,
    auditRunId,
    deliveryGuid: guid,
    githubDeliveryId,
    resumeAt: leaseAt,
  }, deps);
  try {
    await deps.githubApp.redeliverAppWebhookDelivery(githubDeliveryId);
  } catch (error) {
    if (error instanceof GithubAccessError && error.code === "not_found") {
      await deps.store.markGithubDeliveryRepair({ guid, status: "expired", errorCode: `github_${error.code}`, now });
      deps.logger.warn({ delivery_guid: guid, audit_run_id: auditRunId, state: "expired", error_code: `github_${error.code}` });
      return "skipped";
    }
    if (error instanceof GithubRateLimitPauseError) {
      await deps.store.deferGithubDeliveryRedelivery({ guid, resumeAt: error.resumeAt, errorCode: `github_${error.code}`, now });
      await enqueueRepairWake({ githubAppId: claim.repair.githubAppId, auditRunId, deliveryGuid: guid, githubDeliveryId, resumeAt: error.resumeAt }, deps);
      deps.logger.warn({ delivery_guid: guid, audit_run_id: auditRunId, state: "requesting", error_code: `github_${error.code}`, rate_limit_bucket: error.code, retry_at: error.resumeAt.toISOString() });
      throw error;
    }
    if (error instanceof GithubTransientError) {
      const resumeAt = new Date(now.getTime() + GITHUB_REDELIVERY_CLAIM_LEASE_MS);
      await deps.store.deferGithubDeliveryRedelivery({ guid, resumeAt, errorCode: "github_transient", now });
      await enqueueRepairWake({ githubAppId: claim.repair.githubAppId, auditRunId, deliveryGuid: guid, githubDeliveryId, resumeAt }, deps);
      deps.logger.warn({ delivery_guid: guid, audit_run_id: auditRunId, state: "requesting", error_code: "github_transient", retry_at: resumeAt.toISOString() });
      return "skipped";
    }
    throw error;
  }
  const accepted = await deps.store.acceptGithubDeliveryRedelivery({ guid, now });
  const retryAt = accepted?.nextEligibleAt ?? nextRedeliveryEligibleAt(accepted?.attemptCount ?? 1, now);
  await enqueueRepairWake({ githubAppId: claim.repair.githubAppId, auditRunId, deliveryGuid: guid, githubDeliveryId, resumeAt: retryAt }, deps);
  deps.logger.info({ delivery_guid: guid, audit_run_id: auditRunId, state: "requested", result: "redelivered", attempt: accepted?.attemptCount ?? 1, retry_at: retryAt.toISOString() });
  return "requested";
}

async function processRepairWake(payload: SyncJobPayload, deps: DeliveryAuditDependencies): Promise<void> {
  if (!payload.deliveryGuid || !payload.githubDeliveryId || !payload.auditRunId) return;
  const repair = await deps.store.getGithubDeliveryRepair(payload.deliveryGuid);
  if (!repair) return;
  await requestRedelivery(payload.deliveryGuid, payload.githubDeliveryId, payload.auditRunId, deps);
}

async function processAuditPage(payload: SyncJobPayload, deps: DeliveryAuditDependencies): Promise<void> {
  if (!payload.githubAppId || !payload.auditRunId) throw new Error("Delivery audit job is missing opaque scope");
  const now = currentTime(deps);
  let audit = await deps.store.getGithubDeliveryAudit(payload.githubAppId);
  if (!audit || audit.currentRunId !== payload.auditRunId) return;
  if (audit.status === "completed") return;
  await ensureAuditAvailable(audit, now);
  if (audit.status === "paused") {
    const resumed = await deps.store.resumeGithubDeliveryAudit({ githubAppId: payload.githubAppId, auditRunId: payload.auditRunId, now });
    if (!resumed) return;
    audit = resumed;
    await ensureAuditAvailable(audit, now);
  }
  const expectedPage = payload.page ?? 1;
  const expectedCursor = payload.cursor;
  if (audit.pageNumber !== expectedPage || (audit.listCursor ?? undefined) !== expectedCursor) return;
  const page = await deps.githubApp.listAppWebhookDeliveries({ perPage: 100, ...(expectedCursor ? { cursor: expectedCursor } : {}) });
  let reachedStop = page.deliveries.length === 0;
  let newestDeliveredAt: Date | undefined;
  for (const delivery of page.deliveries) {
    if (audit.stopBeforeDeliveredAt && delivery.deliveredAt <= audit.stopBeforeDeliveredAt) {
      reachedStop = true;
      break;
    }
    if (!newestDeliveredAt || delivery.deliveredAt > newestDeliveredAt) newestDeliveredAt = delivery.deliveredAt;
    if (!isRepairableWebhookEvent(delivery.eventName)) continue;
    const repair = await deps.store.observeGithubDeliveryAttempt({
      githubDeliveryGuid: delivery.guid,
      githubDeliveryId: delivery.id,
      githubAppId: payload.githubAppId,
      auditRunId: payload.auditRunId,
      eventName: delivery.eventName,
      ...(delivery.action ? { action: delivery.action } : {}),
      ...(delivery.installationGithubId ? { installationGithubId: delivery.installationGithubId } : {}),
      ...(delivery.repositoryGithubId ? { repositoryGithubId: delivery.repositoryGithubId } : {}),
      statusCode: delivery.statusCode,
      deliveredAt: delivery.deliveredAt,
      now,
    });
    if (repair.status !== "pending" && repair.status !== "requesting" && repair.status !== "requested") continue;
    if (githubDeliveryAttemptSucceeded(delivery.statusCode)) continue;
    await requestRedelivery(delivery.guid, delivery.id, payload.auditRunId, deps);
  }
  if (page.deliveries.length > 0 && !page.nextCursor) reachedStop = true;
  const committed = await deps.store.commitGithubDeliveryAuditPage({
    githubAppId: payload.githubAppId,
    auditRunId: payload.auditRunId,
    expectedPage,
    ...(expectedCursor ? { expectedCursor } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(newestDeliveredAt ? { newestDeliveredAt } : {}),
    reachedStop: reachedStop || !page.nextCursor,
    now,
  });
  if (!committed) return;
  deps.logger.info({
    audit_run_id: payload.auditRunId,
    state: committed.status,
    result: committed.status === "completed" ? "completed" : "paged",
    attempt: committed.pageNumber,
  });
  if (committed.status === "completed") return;
  const continuation: SyncJobPayload = {
    kind: "github_delivery_audit",
    githubAppId: payload.githubAppId,
    auditRunId: payload.auditRunId,
    page: committed.pageNumber,
    ...(committed.listCursor ? { cursor: committed.listCursor } : {}),
  };
  await deps.jobs.enqueue("github_delivery_audit", deliveryAuditLogicalKey(payload.githubAppId, payload.auditRunId, committed.pageNumber), continuation);
}

export async function processGithubDeliveryAudit(payload: SyncJobPayload, deps: DeliveryAuditDependencies): Promise<void> {
  try {
    if (payload.deliveryGuid) {
      await processRepairWake(payload, deps);
      return;
    }
    await processAuditPage(payload, deps);
  } catch (error) {
    if (error instanceof GithubRateLimitPauseError) {
      await pauseAndWake(payload, error, deps);
      return;
    }
    if (error instanceof GithubAccessError && (error.code === "unauthorized" || error.code === "forbidden")) {
      await pauseAndWake(payload, new GithubRateLimitPauseError("retry_after", error.status, new Date(currentTime(deps).getTime() + 15 * 60 * 1000)), deps);
      return;
    }
    if (error instanceof GithubTransientError) {
      const resumeAt = new Date(currentTime(deps).getTime() + GITHUB_REDELIVERY_CLAIM_LEASE_MS);
      await pauseAndWake(payload, new GithubRateLimitPauseError("retry_after", error.status || 500, resumeAt), deps);
      return;
    }
    throw error;
  }
}
