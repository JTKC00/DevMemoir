import PgBoss from "pg-boss";
import type { DeliveryState } from "@devmemoir/domain";

export type JobKind = "webhook_delivery" | "sync_commits" | "repository_backfill" | "installation_inventory";
export const JOB_KINDS: JobKind[] = ["webhook_delivery", "sync_commits", "repository_backfill", "installation_inventory"];

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
};

export type QueueJob<T = unknown> = {
  id: string;
  kind: JobKind;
  logicalKey: string;
  payload: T;
};

export interface JobPort {
  start(): Promise<void>;
  stop(): Promise<void>;
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
  private sequence = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_kind: JobKind, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}
  async has(jobId: string, kind: JobKind): Promise<boolean> { return this.jobs.get(jobId)?.kind === kind; }

  async enqueue<T>(kind: JobKind, logicalKey: string, payload: T): Promise<string> {
    const existing = [...this.jobs.values()].find((job) => job.logicalKey === logicalKey);
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

export function isRetryableDeliveryState(state: DeliveryState): boolean {
  return state === "received" || state === "failed" || state === "dead_letter";
}
