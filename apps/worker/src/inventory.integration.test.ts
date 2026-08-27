import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { createPool, PostgresM1Store } from "@devmemoir/db";
import { defaultTimelineEvents } from "@devmemoir/domain";
import type { GithubClient, GithubRepository } from "@devmemoir/github";
import { InMemoryJobPort, installationInventoryLogicalKey, PgBossJobPort, type QueueJob, type SyncJobPayload } from "@devmemoir/jobs";
import { createLogger } from "@devmemoir/observability";
import { processInstallationInventory, processQueueJob, type QueueDependencies } from "./jobs.js";
import { processDelivery } from "./processor.js";
import { emptyHistoricalGithubMethods } from "./test-github.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error("TEST_DATABASE_URL is required for M2 pg-boss inventory restart integration tests");
const describeIntegration = databaseUrl ? describe : describe.skip;

const config: AppConfig = {
  NODE_ENV: "test", LOG_LEVEL: "error", API_ORIGIN: "http://localhost:4000", WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: databaseUrl ?? "postgres://unused", DATABASE_API_URL: databaseUrl ?? "postgres://unused", DATABASE_WORKER_URL: databaseUrl ?? "postgres://unused", DATABASE_QUEUE_URL: databaseUrl ?? "postgres://unused", DATABASE_MIGRATIONS_URL: databaseUrl ?? "postgres://unused", DATABASE_DIRECT_URL: databaseUrl ?? "postgres://unused", DATABASE_POOL_MAX: 4,
  GITHUB_APP_ID: 1, GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "private", GITHUB_WEBHOOK_SECRET: "current-secret-123456", GITHUB_API_VERSION: "2022-11-28", OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"), SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long", AUTH_TRANSACTION_TTL_SECONDS: 600, HANDOFF_TTL_SECONDS: 120, SESSION_TTL_SECONDS: 3600, CSRF_HEADER: "x-devmemoir-csrf", PORT: 4000, HOST: "127.0.0.1",
};

type Scope = {
  tenantId: string;
  accountGithubId: number;
  githubInstallationId: number;
  installationId: string;
  pool: ReturnType<typeof createPool>;
  admin: ReturnType<typeof createPool>;
  store: PostgresM1Store;
  github: GithubClient;
  githubRepository: GithubRepository;
};

async function createScope(): Promise<Scope> {
  const tenantId = randomUUID();
  const accountGithubId = 800_000_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const githubInstallationId = 80_000 + Number.parseInt(tenantId.replaceAll("-", "").slice(8, 12), 16);
  const installationId = randomUUID();
  const admin = createPool(databaseUrl as string, 2);
  const pool = createPool(databaseUrl as string, 4);
  const store = new PostgresM1Store(pool);
  await store.upsertUser({ userId: randomUUID(), tenantId, githubAccountId: accountGithubId, login: "owner-" + tenantId.slice(0, 8), displayName: "test owner" });
  await store.saveInstallation({ id: installationId, tenantId, githubInstallationId, accountGithubAccountId: accountGithubId });
  const githubRepository: GithubRepository = { id: 9001, name: "restart-repo", full_name: "owner/restart-repo", private: true, visibility: "private", default_branch: "main", owner: { login: "owner" }, created_at: "2026-01-01T00:00:00.000Z" };
  const github: GithubClient = {
    ...emptyHistoricalGithubMethods,
    getUser: async () => ({ id: accountGithubId, login: "owner", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "unused" }),
    getInstallation: async () => ({ id: githubInstallationId, account: { id: accountGithubId, login: "owner", type: "User" }, permissions: { Metadata: "read" }, repository_selection: "selected" }),
    listInstallationRepositories: async () => ({ repositories: [githubRepository] }),
    getRepository: async () => githubRepository,
    listCommits: async () => ({ commits: [] }),
    getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
    getRefHead: async () => "a".repeat(40),
  };
  return { tenantId, accountGithubId, githubInstallationId, installationId, pool, admin, store, github, githubRepository };
}

async function cleanup(scope: Scope): Promise<void> {
  await scope.admin.query("delete from sync_jobs where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from webhook_deliveries where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from development_events where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from commits where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_name_history where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repository_access where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from repositories where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_installations where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from installation_routes where tenant_id=$1", [scope.tenantId]);
  const users = await scope.admin.query<{ id: string; account_id: string }>("select u.id,gi.id as account_id from users u join github_identities i on i.user_id=u.id join github_accounts gi on gi.id=i.github_account_id where u.primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_identities where user_id = any($1::uuid[])", [users.rows.map((row) => row.id)]);
  await scope.admin.query("delete from tenant_members where tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from users where primary_tenant_id=$1", [scope.tenantId]);
  await scope.admin.query("delete from github_accounts where id = any($1::uuid[])", [users.rows.map((row) => row.account_id)]);
  await scope.admin.query("delete from tenants where id=$1", [scope.tenantId]);
  await scope.admin.end();
  await scope.pool.end();
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for restarted inventory worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeIntegration("M2 installation inventory worker restart", () => {
  const scopes: Scope[] = [];

  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  it("retries after an adapter-level worker interruption without duplicating inventory", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const producer = new PgBossJobPort(databaseUrl as string);
    const firstWorker = new PgBossJobPort(databaseUrl as string);
    const secondWorker = new PgBossJobPort(databaseUrl as string);
    const operationId = "restart-" + randomUUID();
    const logicalKey = installationInventoryLogicalKey(scope.githubInstallationId, operationId);
    const payload: SyncJobPayload = { kind: "installation_inventory", tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId, installationId: scope.githubInstallationId, inventoryOperationId: operationId };
    const dependencies = (jobs: PgBossJobPort): QueueDependencies => ({ config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger() });
    let firstAttemptInterrupted = false;
    let finalAttemptCompleted = false;
    try {
      await producer.start();
      await scope.store.ensureJob(logicalKey, payload as Record<string, unknown>);
      const jobId = await producer.enqueue("installation_inventory", logicalKey, payload);
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
      await producer.stop();

      await firstWorker.start();
      await firstWorker.work("installation_inventory", async (job: QueueJob<SyncJobPayload>) => {
        await processQueueJob(job, dependencies(firstWorker));
        firstAttemptInterrupted = true;
        throw new Error("simulated worker restart after inventory commit");
      });
      await waitFor(() => firstAttemptInterrupted);
      await firstWorker.stop();

      await secondWorker.start();
      await secondWorker.work("installation_inventory", async (job: QueueJob<SyncJobPayload>) => {
        await processQueueJob(job, dependencies(secondWorker));
        finalAttemptCompleted = true;
      });
      await waitFor(() => finalAttemptCompleted);

      const counts = await scope.admin.query<{ repositories: string; access_rows: string; jobs: string }>("select (select count(*) from repositories where tenant_id=$1 and github_repository_id=9001)::text as repositories,(select count(*) from repository_access where tenant_id=$1 and installation_id=(select id from github_installations where tenant_id=$1 and github_installation_id=$2))::text as access_rows,(select count(*) from sync_jobs where tenant_id=$1 and logical_key=$3)::text as jobs", [scope.tenantId, scope.githubInstallationId, logicalKey]);
      expect(counts.rows[0]).toEqual({ repositories: "1", access_rows: "1", jobs: "1" });
      await expect(scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).resolves.toMatchObject({ accessStatus: "accessible", selected: false });
    } finally {
      await secondWorker.stop().catch(() => undefined);
      await firstWorker.stop().catch(() => undefined);
      await producer.stop().catch(() => undefined);
    }
  }, 90_000);

  it("preserves PostgreSQL selection through a permission-update refresh", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const jobs = new InMemoryJobPort();
    const dependencies: QueueDependencies = { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger() };
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, dependencies);
    const repository = await scope.store.getRepositoryByGithubId(scope.tenantId, 9001);
    await expect(scope.store.selectRepository(scope.tenantId, repository?.id ?? "")).resolves.toMatchObject({ selected: true });
    const delivery = await scope.store.insertDelivery({ tenantId: scope.tenantId, guid: `permissions-${randomUUID()}`, eventName: "installation", action: "new_permissions_accepted", installationGithubId: scope.githubInstallationId, payloadExpiresAt: new Date(Date.now() + 60_000), now: new Date() });
    const payload: SyncJobPayload = { tenantId: scope.tenantId, deliveryId: delivery.record.id, eventName: "installation", action: "new_permissions_accepted", installationGithubId: scope.githubInstallationId };

    await processDelivery({ deliveryId: delivery.record.id, payload }, dependencies);

    await expect(scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).resolves.toMatchObject({ accessStatus: "accessible", selected: true });
    expect([...jobs.jobs.values()]).toHaveLength(1);
    await processInstallationInventory([...jobs.jobs.values()][0]?.payload as SyncJobPayload, dependencies);

    await expect(scope.store.getInstallation(scope.githubInstallationId)).resolves.toMatchObject({ status: "active", permissions: { Metadata: "read" }, repositorySelection: "selected" });
    await expect(scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).resolves.toMatchObject({ accessStatus: "accessible", selected: true });
  });
});

describeIntegration("authoritative inventory reprojects selected repository metadata", () => {
  const scopes: Scope[] = [];

  afterEach(async () => {
    const scope = scopes.pop();
    if (scope) await cleanup(scope);
  });

  async function seedSelected(scope: Scope, at = new Date("2026-08-24T10:00:00Z")): Promise<string> {
    const jobs = new InMemoryJobPort();
    const dependencies: QueueDependencies = { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => at };
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, dependencies);
    const repository = await scope.store.getRepositoryByGithubId(scope.tenantId, 9001);
    await scope.store.selectRepository(scope.tenantId, repository?.id ?? "");
    await scope.store.saveCommit(scope.tenantId, repository?.id ?? "", {
      repositoryId: repository?.id ?? "",
      sha: "d".repeat(40),
      author: { githubAccountId: 7, actorKind: "user" },
      committer: { githubAccountId: 7, actorKind: "user" },
      message: "owner commit",
      authoredAt: new Date("2026-01-02T00:00:00Z"),
      committedAt: new Date("2026-01-02T00:00:00Z"),
      parents: [],
    }, "https://github.example/private/commit");
    await scope.store.reprojectRepository({ tenantId: scope.tenantId, repositoryId: repository?.id ?? "", ownerGithubAccountId: 7 });
    return repository?.id ?? "";
  }

  it("records rename history and a deterministic repository.renamed event", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const repositoryId = await seedSelected(scope);
    const renamedAt = new Date("2026-08-24T12:00:00Z");
    scope.githubRepository.name = "new-name";
    scope.githubRepository.full_name = "owner/new-name";
    const jobs = new InMemoryJobPort();
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => renamedAt });
    const row = await scope.store.getRepositoryByGithubId(scope.tenantId, 9001);
    expect(row).toMatchObject({ id: repositoryId, githubRepositoryId: 9001, name: "new-name", fullName: "owner/new-name" });
    const history = await scope.admin.query<{ name: string; full_name: string }>("select name,full_name from repository_name_history where tenant_id=$1 and repository_id=$2", [scope.tenantId, repositoryId]);
    expect(history.rows).toEqual([{ name: "restart-repo", full_name: "owner/restart-repo" }]);
    const events = await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true });
    const renamed = events.filter((event) => event.verb === "renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({ sourceKind: "repository", actorKind: "unknown", occurredAt: renamedAt, logicalEventKey: `${scope.tenantId}:${repositoryId}:repository:9001:rename:${renamedAt.toISOString()}:repository:renamed:unknown_action` });
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => new Date(renamedAt.getTime() + 1000) });
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).filter((event) => event.verb === "renamed")).toHaveLength(1);
    expect(defaultTimelineEvents(await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true }), 7).filter((event) => event.sourceKind === "repository")).toHaveLength(0);
  });

  it("reprojects visibility from public to private and back without duplicating source facts", async () => {
    const scope = await createScope();
    scopes.push(scope);
    scope.githubRepository.private = false;
    scope.githubRepository.visibility = "public";
    const repositoryId = await seedSelected(scope);
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).every((event) => event.visibility === "public")).toBe(true);
    scope.githubRepository.private = true;
    scope.githubRepository.visibility = "private";
    const jobs = new InMemoryJobPort();
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => new Date("2026-08-24T13:00:00Z") });
    const privateEvents = await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).toMatchObject({ id: repositoryId, private: true, visibility: "private" });
    expect(privateEvents.every((event) => event.visibility === "private")).toBe(true);
    expect(privateEvents.some((event) => event.sourceUrl === "https://github.example/private/commit")).toBe(true);
    expect((await scope.admin.query<{ count: string }>("select count(*) from commits where tenant_id=$1 and repository_id=$2", [scope.tenantId, repositoryId])).rows[0]?.count).toBe("1");
    scope.githubRepository.private = false;
    scope.githubRepository.visibility = "public";
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => new Date("2026-08-24T13:01:00Z") });
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).every((event) => event.visibility === "public")).toBe(true);
  });

  it("emits repository.archived from observation time and does not duplicate on replay", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const repositoryId = await seedSelected(scope);
    scope.githubRepository.archived = true;
    const archivedAt = new Date("2026-08-24T14:00:00Z");
    const jobs = new InMemoryJobPort();
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => archivedAt });
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).toMatchObject({ archived: true, archivedAt });
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).filter((event) => event.verb === "archived")).toMatchObject([{ sourceKind: "repository", actorKind: "unknown", occurredAt: archivedAt }]);
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => new Date(archivedAt.getTime() + 1000) });
    expect((await scope.store.getRepositoryByGithubId(scope.tenantId, 9001))?.archivedAt).toEqual(archivedAt);
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).filter((event) => event.verb === "archived")).toHaveLength(1);
  });

  it("does not corrupt inventory facts when projection fails after reconciliation", async () => {
    const scope = await createScope();
    scopes.push(scope);
    const repositoryId = await seedSelected(scope);
    const before = await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true });
    const original = scope.store.reprojectRepository.bind(scope.store);
    let shouldFail = true;
    scope.store.reprojectRepository = async (input) => {
      if (shouldFail) throw new Error("projection_injected_failure");
      return original(input);
    };
    scope.githubRepository.name = "new-name";
    scope.githubRepository.full_name = "owner/new-name";
    const renamedAt = new Date("2026-08-24T15:00:00Z");
    const jobs = new InMemoryJobPort();
    await expect(processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => renamedAt })).rejects.toThrow("projection_injected_failure");
    expect(await scope.store.getRepositoryByGithubId(scope.tenantId, 9001)).toMatchObject({ id: repositoryId, name: "new-name", fullName: "owner/new-name" });
    expect(await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).toEqual(before);
    shouldFail = false;
    await processInstallationInventory({ tenantId: scope.tenantId, installationGithubId: scope.githubInstallationId }, { config, store: scope.store, jobs, githubForInstallation: () => scope.github, logger: createLogger(), now: () => new Date(renamedAt.getTime() + 1000) });
    expect((await scope.store.listActivity(scope.tenantId, repositoryId, { context: "default", includeBots: true })).filter((event) => event.verb === "renamed")).toHaveLength(1);
  });
});
