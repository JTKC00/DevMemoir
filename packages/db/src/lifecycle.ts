import { AsyncLocalStorage } from "node:async_hooks";

export type TenantLifecycle = { tenantId: string; version: number; state: "active" | "disconnected" | "deletion_requested" | "deleted"; changedAt?: Date };
export type TenantWork = { tenantId: string; version: number };
const work = new AsyncLocalStorage<TenantWork>();

export class LifecycleRevokedError extends Error {
  readonly code = "lifecycle_revoked";
  constructor() { super("Tenant work was revoked"); this.name = "LifecycleRevokedError"; }
}

export function currentTenantWork(): TenantWork | undefined { return work.getStore(); }
export function withTenantWork<T>(scope: TenantWork, operation: () => Promise<T>): Promise<T> { return work.run(scope, operation); }
export function assertTenantWork(lifecycle: TenantLifecycle, expected = currentTenantWork()): void {
  if (lifecycle.state !== "active" || expected && (expected.tenantId !== lifecycle.tenantId || expected.version !== lifecycle.version)) throw new LifecycleRevokedError();
}

/** In-memory transaction serialization; nested store calls reuse their lock. */
export class MemoryTransaction {
  private readonly context = new AsyncLocalStorage<boolean>();
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await this.context.run(true, operation); } finally { release(); }
  }
}
