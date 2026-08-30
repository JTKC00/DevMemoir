import { describe, expect, it, vi } from "vitest";
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_RETENTION_MS } from "@devmemoir/db";
import { createCanarySink, createLogger } from "@devmemoir/observability";
import { startWorkerHeartbeat } from "./heartbeat.js";

type Scheduled = { callback: () => void | Promise<void>; delayMs: number; cancelled: boolean };

function fakeTimers() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    setTimeout: (callback: Scheduled["callback"], delayMs: number) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => { (handle as Scheduled).cancelled = true; },
    runNext: async () => {
      const timer = scheduled.shift();
      if (!timer || timer.cancelled) return;
      await timer.callback();
    },
  };
}

function heartbeatStore() {
  return {
    recordWorkerHeartbeat: vi.fn(async (_input: { workerInstanceId: string; startedAt: Date; now: Date }): Promise<void> => undefined),
    markWorkerStopped: vi.fn(async (_input: { workerInstanceId: string; now: Date }): Promise<void> => undefined),
    pruneOldWorkerHeartbeats: vi.fn(async (_input: { before: Date }) => 0),
  };
}

describe("worker heartbeat lifecycle", () => {
  it("records and prunes immediately, then schedules the central 30-second cadence", async () => {
    const store = heartbeatStore();
    const timers = fakeTimers();
    const now = new Date("2026-08-30T00:00:00Z");
    const controller = await startWorkerHeartbeat({
      store,
      logger: createLogger(() => undefined),
      workerInstanceId: "00000000-0000-4000-8000-000000000001",
      now: () => now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    expect(store.recordWorkerHeartbeat).toHaveBeenCalledWith({ workerInstanceId: controller.workerInstanceId, startedAt: now, now });
    expect(store.pruneOldWorkerHeartbeats).toHaveBeenCalledWith({ before: new Date(now.getTime() - WORKER_HEARTBEAT_RETENTION_MS) });
    expect(timers.scheduled).toMatchObject([{ delayMs: WORKER_HEARTBEAT_INTERVAL_MS, cancelled: false }]);
    await controller.stop();
  });

  it("sanitizes a transient failure and retries naturally on the next interval", async () => {
    const store = heartbeatStore();
    store.recordWorkerHeartbeat.mockRejectedValueOnce(new Error("PRIVATE_REPOSITORY_NAME PRIVATE_TOKEN PRIVATE_SECRET /private/path"));
    const timers = fakeTimers();
    const capture = createCanarySink();
    const controller = await startWorkerHeartbeat({
      store,
      logger: createLogger(capture.sink),
      workerInstanceId: "00000000-0000-4000-8000-000000000002",
      now: () => new Date("2026-08-30T00:00:00Z"),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    expect(store.recordWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(capture.text()).toContain("heartbeat_write_failed");
    expect(capture.text()).not.toMatch(/PRIVATE_REPOSITORY_NAME|PRIVATE_TOKEN|PRIVATE_SECRET|private\/path/);
    await timers.runNext();
    expect(store.recordWorkerHeartbeat).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("does not overlap heartbeat passes", async () => {
    const store = heartbeatStore();
    const timers = fakeTimers();
    let release!: () => void;
    store.recordWorkerHeartbeat.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = await startWorkerHeartbeat({
      store,
      logger: createLogger(() => undefined),
      workerInstanceId: "00000000-0000-4000-8000-000000000003",
      now: () => new Date("2026-08-30T00:00:00Z"),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const running = timers.runNext();
    await vi.waitFor(() => expect(store.recordWorkerHeartbeat).toHaveBeenCalledTimes(2));
    expect(timers.scheduled).toHaveLength(0);
    release();
    await running;
    expect(timers.scheduled).toHaveLength(1);
    await controller.stop();
  });

  it("marks a graceful stop once, cancels future work, and keeps stop failures sanitized", async () => {
    const store = heartbeatStore();
    store.markWorkerStopped.mockRejectedValueOnce(new Error("PRIVATE_WEBHOOK_PAYLOAD PRIVATE_COMMIT_MESSAGE"));
    const timers = fakeTimers();
    const capture = createCanarySink();
    const stoppedAt = new Date("2026-08-30T00:01:00Z");
    let current = new Date("2026-08-30T00:00:00Z");
    const controller = await startWorkerHeartbeat({
      store,
      logger: createLogger(capture.sink),
      workerInstanceId: "00000000-0000-4000-8000-000000000004",
      now: () => current,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    current = stoppedAt;

    await Promise.all([controller.stop(), controller.stop()]);
    expect(store.markWorkerStopped).toHaveBeenCalledTimes(1);
    expect(store.markWorkerStopped).toHaveBeenCalledWith({ workerInstanceId: controller.workerInstanceId, now: stoppedAt });
    expect(timers.scheduled[0]?.cancelled).toBe(true);
    expect(capture.text()).toContain("heartbeat_stop_failed");
    expect(capture.text()).not.toMatch(/PRIVATE_WEBHOOK_PAYLOAD|PRIVATE_COMMIT_MESSAGE/);
  });
});
