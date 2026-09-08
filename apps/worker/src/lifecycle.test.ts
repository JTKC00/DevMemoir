import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@devmemoir/config";
import { createId } from "@devmemoir/domain";
import { InMemoryM1Store } from "@devmemoir/db";
import { InMemoryJobPort, type SyncJobPayload } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import type { GithubClient } from "@devmemoir/github";
import { processQueueJob } from "./jobs.js";

const config = loadConfig({ DATABASE_URL: "postgres://unused", GITHUB_APP_ID: "1", GITHUB_APP_CLIENT_ID: "fixture", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "test-webhook-secret", OWNER_GITHUB_USER_ID: "7", ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"), SESSION_SECRET: "test-session-secret-at-least-32-characters" });

describe("tenant lifecycle fencing", () => {
  it.each(["disconnect", "unselect", "uninstall", "delete"])("drops a late commit response after %s and reconnection", async (operation) => {
    const store = new InMemoryM1Store();
    const jobs = new InMemoryJobPort();
    const tenantId = createId();
    const user = { userId: createId(), tenantId, githubAccountId: 7, login: "owner", displayName: "Owner" };
    await store.upsertUser(user);
    const installation = { id: createId(), tenantId, githubInstallationId: 22, accountGithubAccountId: 7 };
    const repository = { id: createId(), tenantId, installationId: installation.id, githubRepositoryId: 10, ownerLogin: "owner", name: "repo", fullName: "owner/repo", private: true, defaultBranch: "main", selected: true };
    await store.saveInstallation(installation);
    await store.saveRepository(repository);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const github = {
      getRefHead: vi.fn(async () => "a".repeat(40)),
      listCommits: vi.fn(async () => { entered(); await pending; return { commits: [{ repositoryId: repository.id, sha: "a".repeat(40), message: "late private result", parents: [], author: { githubAccountId: 7, actorKind: "user" as const }, authoredAt: new Date() }] }; }),
    } as unknown as GithubClient;
    const deps = { store, jobs, config, githubForInstallation: () => github, logger: createLogger(() => {}) };
    const payload: SyncJobPayload = { kind: "sync_commits", tenantId, repositoryId: repository.id, installationId: 22 };
    await store.ensureJob("sync-fixture", payload as Record<string, unknown>);
    const id = await jobs.enqueue("sync_commits", "sync-fixture", payload);
    const job = jobs.jobs.get(id)!;
    const processing = processQueueJob(job, deps);
    await started;
    if (operation === "disconnect" || operation === "uninstall") {
      if (operation === "uninstall") await store.updateInstallationLifecycle(22, "deleted", new Date());
      else await store.disconnectTenant(tenantId, new Date());
      await store.saveInstallation(installation);
      await store.reconcileInstallationInventory({ tenantId, githubInstallationId: 22, repositories: [repository], observedAt: new Date() });
    } else if (operation === "delete") await store.requestAccountDeletion(tenantId, user.userId, new Date());
    else await store.unselectRepository(tenantId, repository.id);
    if (operation !== "delete") await store.selectRepository(tenantId, repository.id);
    release();
    await processing;
    expect(store.commits.size).toBe(0);
    expect(store.events).toEqual([]);
    await processQueueJob(job, deps);
    expect(github.listCommits).toHaveBeenCalledTimes(1);
    if (operation === "delete") {
      await store.purgeAccountDeletion(tenantId, new Date());
      expect((await store.getTenantLifecycle(tenantId)).state).toBe("deleted");
      await expect(store.saveInstallation(installation)).rejects.toMatchObject({ code: "lifecycle_revoked" });
      return;
    }
    const next: SyncJobPayload = { kind: "sync_commits", tenantId, repositoryId: repository.id, installationId: 22 };
    await store.ensureJob("sync-fixture", next as Record<string, unknown>);
    const nextId = await jobs.enqueue("sync_commits", "sync-fixture", next);
    expect(nextId).not.toBe(id);
    await processQueueJob(jobs.jobs.get(nextId)!, deps);
    expect(store.commits.size).toBe(1);
  });

  it("disconnect is idempotent, hides facts, and cannot retain another webhook payload", async () => {
    const store = new InMemoryM1Store();
    const tenantId = createId();
    const now = new Date();
    const delivery = await store.insertDelivery({ tenantId, guid: createId(), eventName: "push", payloadCiphertext: "synthetic-ciphertext", payloadExpiresAt: now, now });
    expect(await store.disconnectTenant(tenantId, now)).toMatchObject({ state: "disconnected", version: 1 });
    expect(await store.disconnectTenant(tenantId, new Date(now.getTime() + 1000))).toMatchObject({ state: "disconnected", version: 1, changedAt: now });
    expect(await store.getDelivery(delivery.record.id, tenantId)).toMatchObject({ state: "ignored" });
    expect((await store.getDelivery(delivery.record.id, tenantId))?.payloadCiphertext).toBeUndefined();
    await expect(store.insertDelivery({ tenantId, guid: createId(), eventName: "push", payloadCiphertext: "later-ciphertext", payloadExpiresAt: now, now })).rejects.toMatchObject({ code: "lifecycle_revoked" });
    expect(await store.listActivity(tenantId)).toEqual([]);
  });
});
