import { RAW_WEBHOOK_PURGE_BATCH_SIZE, type M1Store } from "@devmemoir/db";
import { PRIVACY_PAYLOAD_PURGE_CRON, PRIVACY_PAYLOAD_PURGE_KIND, type JobPort } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";

export async function registerPrivacyPayloadPurgeSchedule(jobs: JobPort): Promise<void> {
  await jobs.schedule(PRIVACY_PAYLOAD_PURGE_KIND, PRIVACY_PAYLOAD_PURGE_CRON, { kind: PRIVACY_PAYLOAD_PURGE_KIND }, { tz: "UTC" });
}

export async function processPrivacyPayloadPurge(deps: {
  store: Pick<M1Store, "purgeExpiredWebhookPayloads">;
  logger: Logger;
  now?: () => Date;
}): Promise<void> {
  const result = await deps.store.purgeExpiredWebhookPayloads({
    now: (deps.now ?? (() => new Date()))(),
    limit: RAW_WEBHOOK_PURGE_BATCH_SIZE,
  });
  deps.logger.info({
    event_type: "payload_retention_purge",
    result: "completed",
    routed_count: result.routedPurged,
    unrouted_count: result.unroutedPurged,
  });
}
