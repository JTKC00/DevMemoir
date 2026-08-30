import { describe, expect, it } from "vitest";
import { InMemoryM1Store } from "./store.js";

const tenantId = "tenant-rebuild";
const repositoryId = "repository-rebuild";
const installationId = "installation-rebuild";
const installationGithubId = 7701;
const runIds = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
] as const;
const now = new Date("2026-08-29T12:00:00Z");

async function seedRepository(store: InMemoryM1Store): Promise<void> {
  await store.upsertUser({ userId: "user-rebuild", tenantId, githubAccountId: 7, login: "PRIVATE_OWNER", displayName: "owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId: installationGithubId, accountGithubAccountId: 7 });
  await store.saveRepository({
    id: repositoryId,
    tenantId,
    installationId,
    githubRepositoryId: 991,
    ownerLogin: "PRIVATE_REPOSITORY_NAME",
    name: "PRIVATE_REPOSITORY_NAME",
    fullName: "PRIVATE_REPOSITORY_NAME/PRIVATE_REPOSITORY_NAME",
    private: true,
    defaultBranch: "main",
  });
}

async function startGenerations(store: InMemoryM1Store): Promise<void> {
  for (const reconciliationRunId of runIds) {
    await store.startRepositoryReconciliation({ tenantId, repositoryId, installationId, defaultBranch: "main", reconciliationRunId, now });
  }
}

function seedIssuesPage(store: InMemoryM1Store, extra: { pausedUntil?: Date; blocked?: boolean; completed?: boolean; page?: number } = {}): void {
  for (const progress of store.historicalProgress.values()) {
    if (progress.tenantId !== tenantId || progress.repositoryId !== repositoryId) continue;
    if (progress.cursor.reconciliationRunId !== runIds[3]) continue;
    if (extra.completed) {
      progress.status = "completed";
      progress.completedAt = now;
      continue;
    }
    if (progress.stage === "completed") continue;
    if (progress.stage === "issues") {
      progress.status = extra.blocked || extra.pausedUntil ? "paused" : "in_progress";
      progress.cursor = { nextPage: extra.page ?? 3, reconciliationRunId: runIds[3], mode: "structural" };
      progress.nextPage = extra.page ?? 3;
      if (extra.pausedUntil) progress.pausedUntil = extra.pausedUntil;
      else delete progress.pausedUntil;
      continue;
    }
    progress.status = "completed";
    progress.completedAt = now;
  }
}

describe("M5.5 queue rebuild discovery", () => {
  it("discovers the current unfinished generation and skips completed, unselected, and blocked pauses", async () => {
    const store = new InMemoryM1Store();
    await seedRepository(store);
    await startGenerations(store);
    seedIssuesPage(store);
    const [target] = await store.listQueueRebuildReconciliationTargets();
    expect(target).toMatchObject({
      tenantId,
      repositoryId,
      installationGithubId,
      reconciliationRunId: runIds[3],
      generation: 4,
      stage: "issues",
      status: "in_progress",
      nextPage: 3,
      completed: false,
      blocked: false,
    });
    expect(JSON.stringify(target)).not.toMatch(/PRIVATE_REPOSITORY_NAME/);

    seedIssuesPage(store, { completed: true });
    expect((await store.listQueueRebuildReconciliationTargets())[0]?.completed).toBe(true);

    const blocked = new InMemoryM1Store();
    await seedRepository(blocked);
    await startGenerations(blocked);
    seedIssuesPage(blocked, { blocked: true });
    expect((await blocked.listQueueRebuildReconciliationTargets())[0]).toMatchObject({ blocked: true, status: "paused", generation: 4 });
  });

  it("exposes the current delivery audit without creating a generation", async () => {
    const store = new InMemoryM1Store();
    const auditRunId = "00000000-0000-4000-8000-0000000000aa";
    expect(await store.getQueueRebuildDeliveryAudit(42)).toBeUndefined();
    await store.startGithubDeliveryAudit({ githubAppId: 42, auditRunId, now });
    await store.pauseGithubDeliveryAudit({ githubAppId: 42, auditRunId, pausedUntil: new Date("2026-08-29T18:00:00Z"), errorCode: "github_retry_after" });
    expect(await store.getQueueRebuildDeliveryAudit(42)).toMatchObject({ githubAppId: 42, currentRunId: auditRunId, generation: 1, status: "paused", pageNumber: 1 });
  });
});
