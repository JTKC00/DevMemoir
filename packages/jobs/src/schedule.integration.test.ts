import { describe, expect, it } from "vitest";
import { MAINTENANCE_JOB_KINDS, MAINTENANCE_SCHEDULES, PgBossJobPort } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M5.3 PostgreSQL / pg-boss scheduler tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

function expectedSchedules() {
  return MAINTENANCE_SCHEDULES.map((schedule) => ({ name: schedule.kind, cron: schedule.cron }));
}

function maintenanceSchedules(rows: Array<{ name: string; cron: string }>) {
  const names = new Set<string>(MAINTENANCE_JOB_KINDS);
  return rows.filter((row) => names.has(row.name)).sort((left, right) => left.name.localeCompare(right.name));
}

async function register(port: PgBossJobPort): Promise<void> {
  for (const schedule of MAINTENANCE_SCHEDULES) {
    await port.schedule(schedule.kind, schedule.cron, { kind: schedule.kind, maintenanceTask: schedule.task }, { tz: "UTC" });
  }
}

describeIntegration("pg-boss maintenance schedules", () => {
  it("registers three singleton UTC schedules under concurrent workers and survives restart", async () => {
    const workerA = new PgBossJobPort(databaseUrl as string);
    const workerB = new PgBossJobPort(databaseUrl as string);
    const workerC = new PgBossJobPort(databaseUrl as string);
    try {
      await workerA.start();
      await workerB.start();
      await Promise.all([register(workerA), register(workerB), register(workerA)]);
      expect(maintenanceSchedules(await workerA.getSchedules())).toEqual(expectedSchedules().sort((left, right) => left.name.localeCompare(right.name)));
      expect(maintenanceSchedules(await workerB.getSchedules())).toHaveLength(3);

      await workerA.stop();
      await workerB.stop();
      await workerC.start();
      await register(workerC);
      expect(maintenanceSchedules(await workerC.getSchedules())).toEqual(expectedSchedules().sort((left, right) => left.name.localeCompare(right.name)));

      const first = await Promise.all(MAINTENANCE_JOB_KINDS.map((kind) => workerC.enqueue(kind, kind, { kind })));
      const replay = await Promise.all(MAINTENANCE_JOB_KINDS.map((kind) => workerC.enqueue(kind, kind, { kind })));
      const accepted = [...first, ...replay].filter((id): id is string => Boolean(id));
      expect(new Set(accepted).size).toBeLessThanOrEqual(3);
      expect(replay).toEqual(first);
    } finally {
      await workerC.stop().catch(() => undefined);
      await workerB.stop().catch(() => undefined);
      await workerA.stop().catch(() => undefined);
    }
  }, 60_000);
});
