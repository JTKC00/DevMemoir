import { describe, expect, it } from "vitest";
import type { GithubDeliveryRepairStatusCounts, MaintenanceWindow, RepositoryOperationalRecord, WorkerOperationalHealth } from "@devmemoir/db";
import { OPERATIONAL_STUCK_WORK_MS } from "@devmemoir/db";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { deriveDeliveryAuditHealth, deriveOwnerOperationalHealth, deriveRepositoryHealth, emitOperationalWarnings, operationalWarnings, resetOperationalWarningThrottle } from "./ops-health.js";

const now = new Date("2026-08-29T12:00:00Z");
const runId = "00000000-0000-4000-8000-000000000001";
const zeroCounts = (): GithubDeliveryRepairStatusCounts => ({ pending: 0, requesting: 0, requested: 0, skipped_processing: 0, healthy: 0, expired: 0, exhausted: 0, skipped_terminal: 0 });
const windows = (): MaintenanceWindow[] => ["active_reconciliation", "authorized_reconciliation", "delivery_audit"].map((task, index) => ({ task: task as MaintenanceWindow["task"], bucket: index === 1 ? "2026-08-29" : "20260829T12", jobKind: `maintenance_${index}`, acceptedJobId: `job-${index}`, acceptedAt: new Date(now.getTime() - 60_000), updatedAt: now, completedAt: now }));
const repository = (status: "in_progress" | "paused" | "completed", at = now): RepositoryOperationalRecord => ({ repositoryId: "repo-opaque", installationGithubId: 22, generation: { tenantId: "tenant", repositoryId: "repo-opaque", reconciliationRunId: runId, generation: 1, current: true, startedAt: at }, progress: [{ tenantId: "tenant", repositoryId: "repo-opaque", stage: status === "completed" ? "completed" : "branches", refName: "", status, cursor: { nextPage: 1, reconciliationRunId: runId }, nextPage: 1, startedAt: at, lastSuccessAt: at, ...(status === "completed" ? { completedAt: at } : {}), ...(status === "paused" ? { pausedUntil: new Date(now.getTime() + 60_000), errorCode: "github_primary_rate_limit" } : {}), completenessState: "known_unknown" }] });

describe("M5.4 deterministic health derivation", () => {
  it("reports healthy, degraded, and attention_required deterministically", () => {
    const audit = { id: "audit", githubAppId: 1, currentRunId: runId, generation: 1, status: "completed" as const, pageNumber: 1, startedAt: now, updatedAt: now, completedAt: now, lastSuccessAt: now };
    expect(deriveOwnerOperationalHealth({ now, maintenance: windows(), audit, repairCounts: zeroCounts(), repositories: [repository("completed")] }).overall).toBe("healthy");
    expect(deriveOwnerOperationalHealth({ now, maintenance: windows(), audit: { ...audit, status: "paused", pausedUntil: new Date(now.getTime() + 60_000), lastErrorCode: "github_primary_rate_limit" }, repairCounts: zeroCounts(), repositories: [] }).overall).toBe("degraded");
    expect(deriveOwnerOperationalHealth({ now, maintenance: windows(), audit, repairCounts: { ...zeroCounts(), exhausted: 1 }, repositories: [] }).overall).toBe("attention_required");
    expect(deriveOwnerOperationalHealth({ now, maintenance: windows().map((row, index) => index ? row : { ...row, completedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000), updatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000) }), audit, repairCounts: zeroCounts(), repositories: [] }).overall).toBe("attention_required");
  });

  it("aggregates every existing repair status into recoverable and terminal totals", () => {
    const counts = { pending: 1, requesting: 2, requested: 3, skipped_processing: 4, healthy: 5, expired: 6, exhausted: 7, skipped_terminal: 8 };
    const health = deriveOwnerOperationalHealth({ now, maintenance: windows(), repairCounts: counts, repositories: [] });
    expect(health.deliveryRepairs).toEqual({ recoverable: 10, terminal: 26, byStatus: counts });
  });

  it("covers repository never-run, active, paused, completed, stale, and failed states", () => {
    expect(deriveRepositoryHealth({ repositoryId: "r", installationGithubId: 1, progress: [] }, now).state).toBe("never_run");
    expect(deriveRepositoryHealth(repository("in_progress"), now).state).toBe("in_progress");
    expect(deriveRepositoryHealth(repository("paused"), now).state).toBe("paused");
    expect(deriveRepositoryHealth(repository("completed"), now).state).toBe("healthy");
    expect(deriveRepositoryHealth(repository("completed", new Date(now.getTime() - 13 * 60 * 60 * 1000)), now).state).toBe("stale");
    const failed = repository("in_progress"); failed.progress[0]!.errorCode = "tick_failed";
    expect(deriveRepositoryHealth(failed, now).state).toBe("failed");
  });

  it("covers delivery audit never-run, active, paused, recent-completed, and stale", () => {
    expect(deriveDeliveryAuditHealth(undefined, now).state).toBe("never_run");
    const base = { id: "a", githubAppId: 1, currentRunId: runId, generation: 1, status: "in_progress" as const, pageNumber: 2, startedAt: now, updatedAt: now };
    expect(deriveDeliveryAuditHealth(base, now).state).toBe("in_progress");
    expect(deriveDeliveryAuditHealth({ ...base, status: "paused", pausedUntil: new Date(now.getTime() + 1) }, now).state).toBe("paused");
    expect(deriveDeliveryAuditHealth({ ...base, status: "completed", completedAt: now, lastSuccessAt: now }, now).state).toBe("healthy");
    expect(deriveDeliveryAuditHealth({ ...base, status: "completed", completedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000), lastSuccessAt: new Date(now.getTime() - 13 * 60 * 60 * 1000), updatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000) }, now).state).toBe("stale");
  });

  it("treats overdue completed maintenance as failed_or_incomplete and keeps recent completed/running rows", () => {
    const audit = { id: "audit", githubAppId: 1, currentRunId: runId, generation: 1, status: "completed" as const, pageNumber: 1, startedAt: now, updatedAt: now, completedAt: now, lastSuccessAt: now };
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
    const stamp = (row: MaintenanceWindow, at: Date): MaintenanceWindow => ({ ...row, acceptedAt: at, updatedAt: at, completedAt: at });
    const stateOf = (health: ReturnType<typeof deriveOwnerOperationalHealth>, task: MaintenanceWindow["task"]) => health.maintenance.find((row) => row.task === task)?.state;

    const staleActive = deriveOwnerOperationalHealth({ now, maintenance: windows().map((row) => row.task === "active_reconciliation" ? stamp(row, hoursAgo(13)) : row), audit, repairCounts: zeroCounts(), repositories: [] });
    expect(stateOf(staleActive, "active_reconciliation")).toBe("failed_or_incomplete");
    expect(staleActive.overall).toBe("attention_required");

    const staleAudit = deriveOwnerOperationalHealth({ now, maintenance: windows().map((row) => row.task === "delivery_audit" ? stamp(row, hoursAgo(13)) : row), audit, repairCounts: zeroCounts(), repositories: [] });
    expect(stateOf(staleAudit, "delivery_audit")).toBe("failed_or_incomplete");
    expect(staleAudit.overall).toBe("attention_required");

    const staleAuthorized = deriveOwnerOperationalHealth({ now, maintenance: windows().map((row) => row.task === "authorized_reconciliation" ? stamp(row, hoursAgo(37)) : row), audit, repairCounts: zeroCounts(), repositories: [] });
    expect(stateOf(staleAuthorized, "authorized_reconciliation")).toBe("failed_or_incomplete");
    expect(staleAuthorized.overall).toBe("attention_required");

    const recent = deriveOwnerOperationalHealth({ now, maintenance: windows(), audit, repairCounts: zeroCounts(), repositories: [] });
    expect(recent.maintenance.map((row) => row.state)).toEqual(["completed", "completed", "completed"]);
    expect(recent.overall).toBe("healthy");

    const runningWindows = windows().map((row) => {
      if (row.task !== "active_reconciliation") return row;
      const { completedAt: _completedAt, ...rest } = row;
      return { ...rest, acceptedAt: now, updatedAt: now };
    });
    const running = deriveOwnerOperationalHealth({ now, maintenance: runningWindows, audit, repairCounts: zeroCounts(), repositories: [] });
    expect(stateOf(running, "active_reconciliation")).toBe("running");
    expect(running.overall).toBe("degraded");
  });
});

describe("M5.6 worker, lease, and quota health", () => {
  const audit = { id: "audit", githubAppId: 1, currentRunId: runId, generation: 1, status: "completed" as const, pageNumber: 1, startedAt: now, updatedAt: now, completedAt: now, lastSuccessAt: now };
  const liveWorker = (): WorkerOperationalHealth => ({ state: "healthy", liveWorkers: 1, staleWorkers: 0, lastHeartbeatAt: now });
  const base = (overrides: Partial<Parameters<typeof deriveOwnerOperationalHealth>[0]> = {}) => deriveOwnerOperationalHealth({
    now,
    maintenance: windows(),
    audit,
    repairCounts: zeroCounts(),
    repositories: [repository("completed")],
    worker: liveWorker(),
    ...overrides,
  });

  it("derives worker heartbeat states without treating a live sibling as a crash", () => {
    expect(base().overall).toBe("healthy");
    expect(base().operations.worker).toMatchObject({ state: "healthy", liveWorkers: 1, staleWorkers: 0, lastHeartbeatAt: now.toISOString() });

    const stale = base({ worker: { state: "stale", liveWorkers: 0, staleWorkers: 1, lastHeartbeatAt: new Date(now.getTime() - 91_000) } });
    expect(stale.operations.worker.state).toBe("stale");
    expect(stale.overall).toBe("attention_required");

    const mixed = base({ worker: { state: "healthy", liveWorkers: 1, staleWorkers: 1, lastHeartbeatAt: now } });
    expect(mixed.overall).toBe("healthy");
    expect(mixed.operations.worker).toMatchObject({ liveWorkers: 1, staleWorkers: 1 });
    expect(operationalWarnings(mixed)).toEqual([{ eventType: "worker_heartbeat_stale", count: 1 }]);

    expect(base({ worker: { state: "stopped", liveWorkers: 0, staleWorkers: 0, lastHeartbeatAt: now } }).overall).toBe("degraded");
    expect(base({ worker: { state: "never_seen", liveWorkers: 0, staleWorkers: 0 } }).overall).toBe("degraded");
  });

  it("does not treat a valid future pause as stuck work", () => {
    const paused = base({
      repositories: [repository("paused")],
      leaseAlerts: { expiredProcessing: 0, stuckReconciliations: 0, stuckAudits: 0, stuckMaintenanceWindows: 0 },
      quota: { pausedInstallations: 1, earliestResumeAt: new Date(now.getTime() + 60_000), appAuditPaused: false },
    });
    expect(paused.overall).toBe("degraded");
    expect(paused.operations.leases.stuckReconciliations).toBe(0);
    expect(paused.operations.githubQuota.pausedInstallations).toBe(1);
  });

  it("raises attention for expired leases, stuck durable work, and exhausted repairs", () => {
    const stuck = base({
      leaseAlerts: { expiredProcessing: 1, stuckReconciliations: 2, stuckAudits: 1, stuckMaintenanceWindows: 1, oldestRepositoryReconciliationActivityAt: new Date(now.getTime() - OPERATIONAL_STUCK_WORK_MS - 1) },
    });
    expect(stuck.overall).toBe("attention_required");
    expect(stuck.operations.leases).toMatchObject({ expiredProcessing: 1, stuckReconciliations: 2, stuckAudits: 1, stuckMaintenanceWindows: 1 });
    expect(stuck.operations.reconciliation.stuckCount).toBe(2);

    const exhausted = base({ repairHealth: { recoverableBacklog: 0, pausedRecoverable: 0, exhausted: 3 } });
    expect(exhausted.overall).toBe("attention_required");
    expect(exhausted.operations.repairs.exhausted).toBe(3);

    const agedReady = base({
      repairCounts: { ...zeroCounts(), pending: 2 },
      repairHealth: { recoverableBacklog: 2, pausedRecoverable: 0, exhausted: 0, oldestReadyRecoverableAt: new Date(now.getTime() - OPERATIONAL_STUCK_WORK_MS - 1_000) },
    });
    expect(agedReady.overall).toBe("attention_required");
  });

  it("exposes opaque reconciliation ages and throttles repeated structured warnings", () => {
    const health = base({
      worker: { state: "stale", liveWorkers: 0, staleWorkers: 1, lastHeartbeatAt: new Date(now.getTime() - 91_000) },
      maintenanceSummary: [
        { task: "active_reconciliation", lastCompletedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
        { task: "authorized_reconciliation", lastCompletedAt: new Date(now.getTime() - 18 * 60 * 60 * 1000) },
        { task: "delivery_audit" },
      ],
    });
    expect(health.operations.reconciliation).toMatchObject({ activeAgeSeconds: 7200, authorizedAgeSeconds: 64800, stuckCount: 0 });
    expect(JSON.stringify(health)).not.toMatch(/PRIVATE_REPOSITORY_NAME|PRIVATE_COMMIT_MESSAGE|PRIVATE_PR_TITLE|PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_TOKEN|PRIVATE_SECRET/);

    resetOperationalWarningThrottle();
    const capture = createCanarySink();
    emitOperationalWarnings({ health, logger: createLogger(capture.sink), now });
    emitOperationalWarnings({ health, logger: createLogger(capture.sink), now: new Date(now.getTime() + 1_000) });
    expect(capture.lines.filter((line) => line.includes("worker_heartbeat_stale"))).toHaveLength(1);
    emitOperationalWarnings({ health, logger: createLogger(capture.sink), now: new Date(now.getTime() + 5 * 60 * 1000) });
    expect(capture.lines.filter((line) => line.includes("worker_heartbeat_stale"))).toHaveLength(2);
    expect(capture.text()).toContain("\"count\":1");
    expect(capture.text()).not.toMatch(/PRIVATE_/);
  });
});
