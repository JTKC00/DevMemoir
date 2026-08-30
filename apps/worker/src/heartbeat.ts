import { randomUUID } from "node:crypto";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_RETENTION_MS,
  type M1Store,
} from "@devmemoir/db";
import type { Logger } from "@devmemoir/observability";

type TimerCallback = () => void | Promise<void>;

export type WorkerHeartbeatController = {
  workerInstanceId: string;
  stop(): Promise<void>;
};

export type WorkerHeartbeatDependencies = {
  store: Pick<M1Store, "recordWorkerHeartbeat" | "markWorkerStopped" | "pruneOldWorkerHeartbeats">;
  logger: Logger;
  workerInstanceId?: string;
  now?: () => Date;
  setTimeout?: (callback: TimerCallback, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

/**
 * Starts the heartbeat inside the existing worker process. The first write is
 * attempted before this function resolves; later writes never overlap because
 * the next timeout is installed only after the current maintenance pass ends.
 */
export async function startWorkerHeartbeat(input: WorkerHeartbeatDependencies): Promise<WorkerHeartbeatController> {
  const workerInstanceId = input.workerInstanceId ?? randomUUID();
  const now = input.now ?? (() => new Date());
  const schedule = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = input.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startedAt = now();
  let timer: unknown;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | undefined;

  const maintain = async (): Promise<void> => {
    const observedAt = now();
    try {
      await input.store.recordWorkerHeartbeat({ workerInstanceId, startedAt, now: observedAt });
    } catch (error) {
      input.logger.warn({ event_type: "worker_heartbeat", state: "failed", error_code: "heartbeat_write_failed" }, error);
    }
    try {
      await input.store.pruneOldWorkerHeartbeats({
        before: new Date(observedAt.getTime() - WORKER_HEARTBEAT_RETENTION_MS),
      });
    } catch (error) {
      input.logger.warn({ event_type: "worker_heartbeat", state: "failed", error_code: "heartbeat_prune_failed" }, error);
    }
    if (!stopped) {
      timer = schedule(() => {
        inFlight = maintain();
        return inFlight;
      }, WORKER_HEARTBEAT_INTERVAL_MS);
    }
  };

  inFlight = maintain();
  await inFlight;

  return {
    workerInstanceId,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        if (timer !== undefined) cancel(timer);
        await inFlight;
        try {
          await input.store.markWorkerStopped({ workerInstanceId, now: now() });
        } catch (error) {
          input.logger.warn({ event_type: "worker_heartbeat", state: "failed", error_code: "heartbeat_stop_failed" }, error);
        }
      })();
      return stopPromise;
    },
  };
}
