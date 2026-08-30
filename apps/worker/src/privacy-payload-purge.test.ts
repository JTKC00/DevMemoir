import { describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { InMemoryM1Store, RAW_WEBHOOK_STANDARD_RETENTION_MS, standardPayloadExpiry } from "@devmemoir/db";
import { InMemoryJobPort, PRIVACY_PAYLOAD_PURGE_CRON, PRIVACY_PAYLOAD_PURGE_KIND } from "@devmemoir/jobs";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { processQueueJob } from "./jobs.js";
import { registerOperationalSchedules } from "./maintenance.js";
import { processPrivacyPayloadPurge, registerPrivacyPayloadPurgeSchedule } from "./privacy-payload-purge.js";

const config = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused", DATABASE_API_URL: "postgres://unused", DATABASE_WORKER_URL: "postgres://unused", DATABASE_QUEUE_URL: "postgres://unused", DATABASE_MIGRATIONS_URL: "postgres://unused", DATABASE_DIRECT_URL: "postgres://unused", DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
} satisfies AppConfig;

const t0 = new Date("2026-09-01T10:00:00Z");
const PRIVATE = "PRIVATE_REPOSITORY_NAME PRIVATE_COMMIT_MESSAGE PRIVATE_WEBHOOK_PAYLOAD PRIVATE_TOKEN PRIVATE_SECRET";

describe("M6.1 privacy payload purge worker", () => {
  it("registers the staggered hourly schedule independently of maintenance tasks", async () => {
    const jobs = new InMemoryJobPort();
    await registerOperationalSchedules(jobs);
    await registerPrivacyPayloadPurgeSchedule(jobs);
    expect(await jobs.getSchedules()).toEqual(expect.arrayContaining([
      { name: "maintenance_active", cron: "0 */6 * * *" },
      { name: PRIVACY_PAYLOAD_PURGE_KIND, cron: PRIVACY_PAYLOAD_PURGE_CRON },
    ]));
  });

  it("purges expired ciphertext with opaque counts and no GitHub or private content", async () => {
    const store = new InMemoryM1Store();
    const capture = createCanarySink();
    const delivery = await store.insertDelivery({
      tenantId: "tenant-a",
      guid: "00000000-0000-4000-8000-000000000201",
      eventName: "push",
      payloadCiphertext: PRIVATE,
      payloadExpiresAt: standardPayloadExpiry(t0),
      now: t0,
    });
    await processPrivacyPayloadPurge({ store, logger: createLogger(capture.sink), now: () => new Date(t0.getTime() + RAW_WEBHOOK_STANDARD_RETENTION_MS) });
    expect((await store.getDelivery(delivery.record.id, "tenant-a"))?.payloadCiphertext).toBeUndefined();
    expect(capture.text()).toContain("payload_retention_purge");
    expect(capture.text()).toContain("\"routed_count\":1");
    expect(capture.text()).not.toMatch(/PRIVATE_|github|octokit/i);
  });

  it("routes the privacy_payload_purge job kind without using delivery payloads", async () => {
    const store = new InMemoryM1Store();
    const capture = createCanarySink();
    await processQueueJob(
      { id: "job-1", kind: "privacy_payload_purge", logicalKey: "privacy_payload_purge", payload: { kind: "privacy_payload_purge", repository: PRIVATE } },
      { store, jobs: new InMemoryJobPort(), githubForInstallation: () => { throw new Error("GitHub must not be called"); }, logger: createLogger(capture.sink), config, now: () => t0 },
    );
    expect(capture.text()).toContain("\"routed_count\":0");
    expect(capture.text()).not.toContain(PRIVATE);
  });
});
