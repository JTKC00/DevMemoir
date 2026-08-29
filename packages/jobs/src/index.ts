import PgBoss from "pg-boss";
import type { DeliveryState, MaintenanceTask } from "@devmemoir/domain";

export type JobKind = "webhook_delivery" | "sync_commits" | "repository_backfill" | "installation_inventory" | "repository_reconciliation" | "github_delivery_audit" | "github_delivery_audit_recovery" | "maintenance_active" | "maintenance_authorized" | "maintenance_audit";
export const JOB_KINDS: JobKind[] = ["webhook_delivery", "sync_commits", "repository_backfill", "installation_inventory", "repository_reconciliation", "github_delivery_audit", "github_delivery_audit_recovery", "maintenance_active", "maintenance_authorized", "maintenance_audit"];
export const MAINTENANCE_JOB_KINDS = ["maintenance_active", "maintenance_authorized", "maintenance_audit"] as const;
export type MaintenanceJobKind = (typeof MAINTENANCE_JOB_KINDS)[number];

export const MAINTENANCE_SCHEDULES: ReadonlyArray<{ kind: MaintenanceJobKind; cron: string; task: MaintenanceTask }> = [
  { kind: "maintenance_active", cron: "0 */6 * * *", task: "active_reconciliation" },
  { kind: "maintenance_authorized", cron: "0 0 * * *", task: "authorized_reconciliation" },
  { kind: "maintenance_audit", cron: "30 */6 * * *", task: "delivery_audit" },
];

export type SyncJobPayload = {
  kind?: JobKind;
  deliveryId?: string;
  deliveryGuid?: string;
  tenantId?: string;
  repositoryId?: string;
  repositoryGithubId?: number;
  installationId?: number;
  installationGithubId?: number;
  owner?: string;
  repo?: string;
  ref?: string;
  before?: string;
  after?: string;
  forced?: boolean;
  nextPage?: number;
  inventoryOperationId?: string;
  eventName?: string;
  action?: string;
  /** M3 stage/page hints are opaque execution hints. PostgreSQL progress is authoritative. */
  stage?: "default_branch_commits" | "branches" | "tags" | "pull_requests" | "issues" | "releases" | "completed";
  page?: number;
  anchorHeadSha?: string;
  observationStartedAt?: string;
  /** Opaque M5 reconciliation generation; never derived from repository content. */
  reconciliationRunId?: string;
  /** Opaque M5.2 App-JWT delivery-audit generation. */
  githubAppId?: number;
  auditRunId?: string;
  cursor?: string;
  githubDeliveryId?: number;
  maintenanceTask?: MaintenanceTask;
};

export type QueueJob<T = unknown> = {
  id: string;
  kind: JobKind;
  logicalKey: string;
  payload: T;
};

export type JobSchedule = { name: string; cron: string };

export interface JobPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  schedule(name: JobKind, cron: string, payload: object, options?: { tz?: string }): Promise<void>;
  getSchedules(): Promise<JobSchedule[]>;
  /**
   * Returns a real pg-boss job UUID when this process accepted the enqueue.
   * `undefined` means another process already owns the durable singleton key;
   * callers must use their business logical-key record for recovery and must
   * never persist the logical key as a job ID.
   */
  enqueue<T>(kind: JobKind, logicalKey: string, payload: T, options?: { startAfter?: Date }): Promise<string | undefined>;
  work<T extends object>(kind: JobKind, handler: (job: QueueJob<T>) => Promise<void>): Promise<void>;
  has(jobId: string, kind: JobKind): Promise<boolean>;
  retry(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

export class InMemoryJobPort implements JobPort {
  readonly jobs = new Map<string, QueueJob>();
  readonly schedules = new Map<string, JobSchedule>();
  readonly schedulePayloads = new Map<string, object>();
  private sequence = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async schedule(name: JobKind, cron: string, payload: object, _options?: { tz?: string }): Promise<void> {
    this.schedules.set(name, { name, cron });
    this.schedulePayloads.set(name, payload);
  }
  async getSchedules(): Promise<JobSchedule[]> {
    return [...this.schedules.values()].map((schedule) => ({ ...schedule }));
  }
  async work<T extends object>(_kind: JobKind, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}
  async has(jobId: string, kind: JobKind): Promise<boolean> { return this.jobs.get(jobId)?.kind === kind; }

  async enqueue<T>(kind: JobKind, logicalKey: string, payload: T, _options?: { startAfter?: Date }): Promise<string> {
    const existing = [...this.jobs.values()].find((job) => job.kind === kind && job.logicalKey === logicalKey);
    if (existing) return existing.id;
    const id = `job-${++this.sequence}`;
    this.jobs.set(id, { id, kind, logicalKey, payload });
    return id;
  }

  async retry(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) throw new Error("Job not found");
  }

  async cancel(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}

export class PgBossJobPort implements JobPort {
  private readonly boss: PgBoss;
  private readonly kindsByJobId = new Map<string, JobKind>();
  private readonly jobIdsByLogicalKey = new Map<string, string>();

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, max: 5 });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const kind of JOB_KINDS) await this.boss.createQueue(kind, { name: kind, policy: "stately", retryLimit: 4, retryDelay: 5, retryBackoff: true, retentionDays: 7 });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  async schedule(name: JobKind, cron: string, payload: object, options?: { tz?: string }): Promise<void> {
    await this.boss.schedule(name, cron, payload, { tz: options?.tz ?? "UTC", singletonKey: name });
  }

  async getSchedules(): Promise<JobSchedule[]> {
    const rows = await this.boss.getSchedules();
    return rows.map((row) => ({ name: row.name, cron: row.cron }));
  }

  async enqueue<T>(kind: JobKind, logicalKey: string, payload: T, options?: { startAfter?: Date }): Promise<string | undefined> {
    const logicalMapKey = `${kind}:${logicalKey}`;
    const knownId = this.jobIdsByLogicalKey.get(logicalMapKey);
    if (knownId && await this.has(knownId, kind)) return knownId;
    if (knownId) this.jobIdsByLogicalKey.delete(logicalMapKey);
    const id = await this.boss.send(kind, payload as object, {
      singletonKey: logicalKey,
      retryLimit: 4,
      retryDelay: 5,
      retryBackoff: true,
      ...(options?.startAfter ? { startAfter: options.startAfter } : {}),
    });
    if (!id) {
      // A stately queue returns null when another process already owns the
      // same logical key. The durable sync_jobs row and the key itself are
      // enough for redelivery reconciliation. Never turn the logical key
      // into a value that looks like a pg-boss job UUID.
      return undefined;
    }
    this.kindsByJobId.set(id, kind);
    this.jobIdsByLogicalKey.set(logicalMapKey, id);
    return id;
  }

  async work<T extends object>(kind: JobKind, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    await this.boss.work<T>(kind, { includeMetadata: true }, async (jobs) => {
      for (const job of jobs) await handler({ id: job.id, kind, logicalKey: job.singletonKey ?? "", payload: job.data });
    });
  }

  async has(jobId: string, kind: JobKind): Promise<boolean> {
    const job = await this.boss.getJobById(kind, jobId, { includeArchive: false });
    return Boolean(job && (job.state === "created" || job.state === "retry" || job.state === "active"));
  }

  async retry(jobId: string): Promise<void> {
    const kind = await this.resolveKind(jobId);
    if (!kind) throw new Error(`Unknown pg-boss job ${jobId}`);
    await this.boss.retry(kind, jobId);
  }

  async cancel(jobId: string): Promise<void> {
    const kind = await this.resolveKind(jobId);
    if (!kind) throw new Error(`Unknown pg-boss job ${jobId}`);
    await this.boss.deleteJob(kind, jobId);
    this.kindsByJobId.delete(jobId);
  }

  private async resolveKind(jobId: string): Promise<JobKind | undefined> {
    const remembered = this.kindsByJobId.get(jobId);
    if (remembered) return remembered;
    for (const kind of JOB_KINDS) {
      const job = await this.boss.getJobById(kind, jobId, { includeArchive: true });
      if (job) {
        this.kindsByJobId.set(jobId, kind);
        return kind;
      }
    }
    return undefined;
  }
}

export function deliveryLogicalKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

export function commitSyncLogicalKey(repositoryId: string, ref: string, after: string, nextPage?: number): string {
  // M3 only traverses the selected repository's default branch. Ref names can
  // contain private project vocabulary, so they never belong in queue keys.
  void ref;
  return `sync:${repositoryId}:${after}${nextPage ? `:page:${nextPage}` : ""}`;
}

export function historicalBackfillLogicalKey(
  repositoryId: string,
  stage: NonNullable<SyncJobPayload["stage"]> | "coordinator",
  page?: number,
  anchorHeadSha?: string,
): string {
  const position = page === undefined ? "wake" : `page:${page}`;
  return `backfill:${repositoryId}:${stage}:${position}${anchorHeadSha ? `:${anchorHeadSha}` : ""}`;
}

export function installationInventoryLogicalKey(installationGithubId: number, operationId: string): string {
  return `inventory:${installationGithubId}:${operationId}`;
}

export function repositoryReconciliationLogicalKey(repositoryId: string, reconciliationRunId: string, stage = "coordinator", page?: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reconciliationRunId)) throw new Error("Invalid opaque reconciliation run id");
  return `reconcile:${repositoryId}:${reconciliationRunId}:${stage}${page === undefined ? "" : `:page:${page}`}`;
}

export function isRetryableDeliveryState(state: DeliveryState): boolean {
  return state === "received" || state === "failed" || state === "dead_letter";
}

const OPAQUE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_DELIVERY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deliveryAuditLogicalKey(githubAppId: number, auditRunId: string, page?: number): string {
  if (!Number.isInteger(githubAppId) || githubAppId <= 0) throw new Error("Invalid opaque GitHub App id");
  if (!OPAQUE_UUID.test(auditRunId)) throw new Error("Invalid opaque delivery audit run id");
  return `delivery-audit:${githubAppId}:${auditRunId}:page:${page ?? 1}`;
}

export function deliveryAuditWakeLogicalKey(githubAppId: number, auditRunId: string, resumeAt: Date): string {
  if (!Number.isInteger(githubAppId) || githubAppId <= 0) throw new Error("Invalid opaque GitHub App id");
  if (!OPAQUE_UUID.test(auditRunId)) throw new Error("Invalid opaque delivery audit run id");
  return `delivery-audit:${githubAppId}:${auditRunId}:wake:${resumeAt.getTime()}`;
}

export function deliveryAuditRecoveryLogicalKey(githubAppId: number, auditRunId: string): string {
  if (!Number.isInteger(githubAppId) || githubAppId <= 0) throw new Error("Invalid opaque GitHub App id");
  if (!OPAQUE_UUID.test(auditRunId)) throw new Error("Invalid opaque delivery audit run id");
  return `delivery-audit-recovery:${githubAppId}:${auditRunId}`;
}

export function deliveryRepairWakeLogicalKey(githubAppId: number, deliveryGuid: string, resumeAt: Date): string {
  if (!Number.isInteger(githubAppId) || githubAppId <= 0) throw new Error("Invalid opaque GitHub App id");
  if (!OPAQUE_DELIVERY_GUID.test(deliveryGuid)) throw new Error("Invalid opaque GitHub delivery GUID");
  return `delivery-audit:${githubAppId}:repair:${deliveryGuid}:wake:${resumeAt.getTime()}`;
}

export function maintenanceTickLogicalKey(kind: MaintenanceJobKind, bucket: string): string {
  if (!/^\d{8}T\d{2}$|^\d{4}-\d{2}-\d{2}$/.test(bucket)) throw new Error("Invalid opaque maintenance bucket");
  return `maintenance:${kind}:${bucket}`;
}
