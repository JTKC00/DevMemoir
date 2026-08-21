import PgBoss from "pg-boss";
import type { DeliveryState } from "@devmemoir/domain";

export type JobKind = "webhook_delivery" | "sync_commits" | "repository_backfill";

export type SyncJobPayload = {
  deliveryId?: string;
  deliveryGuid?: string;
  tenantId?: string;
  repositoryId: string;
  installationId: number;
  owner: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
  forced: boolean;
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
  enqueue<T>(kind: JobKind, logicalKey: string, payload: T, options?: { startAfter?: Date }): Promise<string>;
  work<T extends object>(kind: JobKind, handler: (job: QueueJob<T>) => Promise<void>): Promise<void>;
  retry(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

export class InMemoryJobPort implements JobPort {
  readonly jobs = new Map<string, QueueJob>();
  private sequence = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async work<T extends object>(_kind: JobKind, _handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {}

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

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, max: 5 });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async enqueue<T>(kind: JobKind, logicalKey: string, payload: T, options?: { startAfter?: Date }): Promise<string> {
    const id = await this.boss.send(kind, payload as object, {
      singletonKey: logicalKey,
      retryLimit: 8,
      ...(options?.startAfter ? { startAfter: options.startAfter } : {}),
    });
    if (!id) throw new Error(`Could not enqueue ${kind}`);
    this.kindsByJobId.set(id, kind);
    return id;
  }

  async work<T extends object>(kind: JobKind, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    await this.boss.work<T>(kind, async (jobs) => {
      for (const job of jobs) await handler({ id: job.id, kind, logicalKey: "", payload: job.data });
    });
  }

  async retry(jobId: string): Promise<void> {
    const kind = this.kindsByJobId.get(jobId);
    if (!kind) throw new Error(`Unknown pg-boss job ${jobId}`);
    await this.boss.resume(kind, jobId);
  }

  async cancel(jobId: string): Promise<void> {
    const kind = this.kindsByJobId.get(jobId);
    if (!kind) throw new Error(`Unknown pg-boss job ${jobId}`);
    await this.boss.deleteJob(kind, jobId);
    this.kindsByJobId.delete(jobId);
  }
}

export function deliveryLogicalKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

export function commitSyncLogicalKey(repositoryId: string, ref: string, after: string): string {
  return `sync:${repositoryId}:${ref}:${after}`;
}

export function isRetryableDeliveryState(state: DeliveryState): boolean {
  return state === "received" || state === "failed" || state === "dead_letter";
}
