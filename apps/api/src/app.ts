import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import type { AppConfig } from "@devmemoir/config";
import { createId, createOpaqueToken, defaultTimelineEvents, encryptSecret, hashOpaqueToken, parseWebhook } from "@devmemoir/domain";
import type { GithubClient } from "@devmemoir/github";
import type { JobPort } from "@devmemoir/jobs";
import { deliveryLogicalKey, installationInventoryLogicalKey } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import { RepositorySelectionError, type M1Store, type SessionRecord } from "@devmemoir/db";
import { AuthFlowError, AuthService, readBearerOrCookie } from "./auth.js";
import { verifyGithubSignature, webhookBodyLimit } from "./webhook.js";

export type ApiDependencies = {
  config: AppConfig;
  store: M1Store;
  github: GithubClient;
  installationGithub?: (installationId: number) => GithubClient;
  jobs: JobPort;
  logger: Logger;
  now?: () => Date;
  appSlug?: string;
};

type RequestWithSession = FastifyRequest & { session?: SessionRecord };

const KNOWN_ACTIONS: Record<string, Set<string>> = {
  installation: new Set(["created", "deleted", "suspend", "unsuspend" ]),
  installation_repositories: new Set(["added", "removed"]),
  repository: new Set(["created", "edited", "archived", "renamed", "transferred"]),
  pull_request: new Set(["opened", "closed", "reopened", "edited", "synchronize"]),
  issues: new Set(["opened", "closed", "reopened", "edited"]),
  release: new Set(["published", "edited", "deleted"]),
  create: new Set(["created"]),
  delete: new Set(["deleted"]),
};

function isKnownAction(eventName: string, action: string | undefined): boolean {
  if (!KNOWN_ACTIONS[eventName]) return true;
  return Boolean(action && KNOWN_ACTIONS[eventName].has(action));
}

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object") return {};
  return request.body as Record<string, unknown>;
}

export async function buildApi(deps: ApiDependencies): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const auth = new AuthService(deps.config, deps.store, deps.github, now);
  const app = Fastify({ bodyLimit: webhookBodyLimit(deps.config), logger: false });
  await app.register(cookie);
  await app.register(cors, { origin: deps.config.WEB_ORIGIN, credentials: true });
  await app.register(rawBody, { field: "rawBody", global: false, runFirst: true, encoding: false });

  const sessionFromRequest = async (request: RequestWithSession): Promise<SessionRecord | undefined> => {
    const token = readBearerOrCookie({ ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), cookies: request.cookies });
    const session = await auth.authenticate(token);
    if (session) request.session = session;
    return session;
  };

  const requireSession = async (request: RequestWithSession, reply: FastifyReply): Promise<SessionRecord | undefined> => {
    const session = await sessionFromRequest(request);
    if (!session) {
      await reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    return session;
  };

  const requireCsrf = async (request: RequestWithSession, reply: FastifyReply): Promise<SessionRecord | undefined> => {
    const session = await requireSession(request, reply);
    if (!session) return undefined;
    if (!await auth.verifyCsrf(session, request.headers[deps.config.CSRF_HEADER.toLowerCase()] as string | undefined)) {
      await reply.code(403).send({ error: "csrf_failed" });
      return undefined;
    }
    return session;
  };

  const enqueueInventoryRefresh = async (tenantId: string, installationGithubId: number, operationId: string): Promise<void> => {
    const logicalKey = installationInventoryLogicalKey(installationGithubId, operationId);
    const payload = { kind: "installation_inventory", tenantId, installationGithubId, installationId: installationGithubId, inventoryOperationId: operationId };
    await deps.store.ensureJob(logicalKey, payload);
    await deps.jobs.enqueue("installation_inventory", logicalKey, payload);
  };

  app.get("/health", async () => ({ ok: true, service: "api", m1: true, m2: true }));

  app.get<{ Querystring: { returnPath?: string } }>("/auth/github/start", async (request, reply) => {
    const started = await auth.startLogin(request.query.returnPath ?? "/");
    return reply.redirect(started.authorizationUrl);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/auth/github/callback", async (request, reply) => {
    try {
      if (!request.query.code || !request.query.state) throw new AuthFlowError("Missing OAuth callback values");
      const completed = await auth.completeLogin({ code: request.query.code, state: request.query.state });
      const handoffUrl = new URL("/auth/handoff", deps.config.WEB_ORIGIN);
      handoffUrl.searchParams.set("code", completed.handoffCode);
      handoffUrl.searchParams.set("returnPath", completed.returnPath);
      return reply.redirect(handoffUrl.toString());
    } catch (error) {
      const status = error instanceof AuthFlowError ? error.statusCode : 502;
      deps.logger.warn({ event_type: "oauth_callback", result: "rejected" }, error);
      return reply.code(status).send({ error: status === 403 ? "account_not_allowed" : status === 503 ? "oauth_unavailable" : "oauth_failed" });
    }
  });

  app.post<{ Body: { code?: string } }>("/auth/handoff/exchange", async (request, reply) => {
    try {
      if (!request.body?.code) throw new AuthFlowError("Missing handoff code");
      return await auth.exchangeHandoff(request.body.code);
    } catch (error) {
      const status = error instanceof AuthFlowError ? error.statusCode : 400;
      return reply.code(status).send({ error: status === 503 ? "handoff_unavailable" : "handoff_failed" });
    }
  });

  app.get("/auth/session", async (request, reply) => {
    const session = await sessionFromRequest(request as RequestWithSession);
    if (!session) return reply.code(401).send({ authenticated: false });
    return { authenticated: true, tenantId: session.tenantId, csrfRequired: true };
  });

  app.post("/connect/start", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    const state = createOpaqueToken(32);
    const stateHash = hashOpaqueToken(state, deps.config.SESSION_SECRET);
    await deps.store.createAuthTransaction({ id: createId(), stateHash, codeVerifierCiphertext: encryptSecret("installation-state", deps.config.ENCRYPTION_KEY_BASE64), userId: session.userId, returnPath: "/connect", expiresAt: new Date(now().getTime() + deps.config.AUTH_TRANSACTION_TTL_SECONDS * 1000) });
    const slug = deps.appSlug ?? "devmemoir";
    const url = new URL(`https://github.com/apps/${slug}/installations/new`);
    url.searchParams.set("state", state);
    return { installationUrl: url.toString() };
  });

  app.get<{ Querystring: { installation_id?: string; setup_action?: string; state?: string } }>("/github/setup", async (request, reply) => {
    const installationId = Number(request.query.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return reply.code(400).send({ error: "invalid_installation" });
    if (request.query.setup_action && request.query.setup_action !== "install") return reply.code(400).send({ error: "unsupported_setup_action" });
    if (!request.query.state) return reply.redirect(new URL(`/connect?installation_id=${installationId}&claim=1`, deps.config.WEB_ORIGIN).toString());
    const transaction = await deps.store.consumeAuthState(hashOpaqueToken(request.query.state, deps.config.SESSION_SECRET), now());
    if (!transaction?.userId) return reply.code(400).send({ error: "invalid_installation_state" });
    const signedInUser = await deps.store.getUserById(transaction.userId);
    if (!signedInUser) return reply.code(400).send({ error: "installation_user_not_found" });
    const installation = await deps.github.getInstallation(installationId);
    if (installation.account.type !== "User" || installation.account.id !== signedInUser?.githubAccountId) return reply.code(403).send({ error: "installation_account_mismatch" });
    if (installation.suspended_at) return reply.code(409).send({ error: "installation_suspended" });
    await deps.store.saveInstallation({ id: createId(), tenantId: signedInUser.tenantId, githubInstallationId: installationId, accountGithubAccountId: installation.account.id });
    await enqueueInventoryRefresh(signedInUser.tenantId, installationId, `initial:${createId()}`);
    return reply.redirect(new URL("/connect?connected=1", deps.config.WEB_ORIGIN).toString());
  });

  app.post<{ Body: { installation_id?: number } }>("/connect/claim", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    const installationId = Number(request.body?.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return reply.code(400).send({ error: "invalid_installation" });
    const installation = await deps.github.getInstallation(installationId);
    const signedInUser = await deps.store.getUserById(session.userId);
    if (installation.account.type !== "User" || installation.account.id !== signedInUser?.githubAccountId) return reply.code(403).send({ error: "installation_account_mismatch" });
    if (installation.suspended_at) return reply.code(409).send({ error: "installation_suspended" });
    await deps.store.saveInstallation({ id: createId(), tenantId: session.tenantId, githubInstallationId: installationId, accountGithubAccountId: installation.account.id });
    await enqueueInventoryRefresh(session.tenantId, installationId, `initial:${createId()}`);
    return { connected: true };
  });

  app.get("/connect/repositories", async (request, reply) => {
    const session = await requireSession(request as RequestWithSession, reply);
    if (!session) return;
    const installation = (await deps.store.listInstallations(session.tenantId))[0];
    if (!installation) return { connected: false, repositories: [] };
    const repositories = await deps.store.listRepositoryInventory(session.tenantId, installation.id);
    return {
      connected: true,
      installationStatus: installation.status ?? "active",
      lastInventoryAt: installation.lastInventoryAt?.toISOString(),
      repositories: repositories.map((repository) => ({
        id: repository.id,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        name: repository.name,
        owner: repository.ownerLogin,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
        selected: repository.selected === true,
        accessStatus: repository.accessStatus ?? "accessible",
        firstSeenAt: repository.firstSeenAt?.toISOString(),
        lastSeenAt: repository.lastSeenAt?.toISOString(),
        lastAuthoritativeObservedAt: repository.lastAuthoritativeObservedAt?.toISOString(),
        archived: repository.archived === true,
        disabled: repository.disabled === true,
      })),
    };
  });

  app.post("/connect/repositories/refresh", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    const installation = (await deps.store.listInstallations(session.tenantId))[0];
    if (!installation || (installation.status && installation.status !== "active")) return reply.code(409).send({ error: "installation_unavailable" });
    const operationId = createId();
    await enqueueInventoryRefresh(session.tenantId, installation.githubInstallationId, operationId);
    return reply.code(202).send({ queued: true });
  });

  app.post<{ Body: { repositoryId?: string; owner?: string; repo?: string } }>("/connect/repository", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    const owner = request.body?.owner;
    const repo = request.body?.repo;
    if (!request.body?.repositoryId && (!owner || !repo)) return reply.code(400).send({ error: "owner_and_repo_required" });
    const repository = request.body?.repositoryId ? await deps.store.getRepositoryById(session.tenantId, request.body.repositoryId) : await deps.store.getRepositoryByFullName(session.tenantId, `${owner}/${repo}`);
    if (!repository) return reply.code(404).send({ error: "repository_not_in_authoritative_inventory" });
    const installation = (await deps.store.listInstallations(session.tenantId)).find((value) => value.id === repository.installationId);
    if (!installation) return reply.code(409).send({ error: "installation_required" });
    if (installation.status && installation.status !== "active") return reply.code(409).send({ error: "installation_unavailable" });
    let connectedRepository: import("@devmemoir/db").RepositoryRecord | undefined;
    try {
      connectedRepository = await deps.store.selectRepository(session.tenantId, repository.id);
    } catch (error) {
      if (error instanceof RepositorySelectionError || (typeof error === "object" && error !== null && "code" in error && error.code === "one_repository_only")) return reply.code(409).send({ error: "m1_supports_one_repository" });
      throw error;
    }
    if (!connectedRepository) return reply.code(409).send({ error: "repository_access_unavailable" });
    const client = deps.installationGithub?.(installation.githubInstallationId) ?? deps.github;
    const head = await client.getRefHead({ owner: connectedRepository.ownerLogin, repo: connectedRepository.name, ref: connectedRepository.defaultBranch });
    const jobPayload = { kind: "repository_backfill", tenantId: connectedRepository.tenantId, repositoryId: connectedRepository.id, installationId: installation.githubInstallationId, owner: connectedRepository.ownerLogin, repo: connectedRepository.name, ref: `refs/heads/${connectedRepository.defaultBranch}`, before: "0".repeat(40), after: head ?? "0".repeat(40), forced: false };
    await deps.store.ensureJob(`backfill:${connectedRepository.id}`, jobPayload);
    await deps.jobs.enqueue("repository_backfill", `backfill:${connectedRepository.id}`, jobPayload);
    return reply.code(201).send({ repository: connectedRepository, completeness: "Newest 100 commits currently reachable from the default branch of this connected repository." });
  });

  app.post<{ Body: { repositoryId?: string } }>("/connect/repository/unselect", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    if (!request.body?.repositoryId) return reply.code(400).send({ error: "repository_required" });
    const repository = await deps.store.unselectRepository(session.tenantId, request.body.repositoryId);
    if (!repository) return reply.code(404).send({ error: "repository_not_found" });
    return { repository: { id: repository.id, selected: repository.selected === true, accessStatus: repository.accessStatus } };
  });

  app.post("/webhooks/github", { config: { rawBody: true } }, async (request, reply) => {
    const raw = typeof request.rawBody === "string" ? Buffer.from(request.rawBody) : (request.rawBody ?? Buffer.from(JSON.stringify(jsonBody(request))));
    if (raw.length > webhookBodyLimit(deps.config)) return reply.code(413).send({ error: "payload_too_large" });
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGithubSignature(raw, signature, deps.config.GITHUB_WEBHOOK_SECRET, deps.config.GITHUB_WEBHOOK_SECRET_PREVIOUS)) return reply.code(401).send({ error: "invalid_signature" });
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(raw.toString("utf8")); } catch { return reply.code(400).send({ error: "invalid_json" }); }
    const eventName = String(request.headers["x-github-event"] ?? "");
    const guid = String(request.headers["x-github-delivery"] ?? "");
    if (!guid || !eventName) return reply.code(400).send({ error: "missing_github_headers" });
    let parsed;
    try { parsed = parseWebhook(eventName, parsedBody); } catch { return reply.code(400).send({ error: "invalid_webhook_payload" }); }
    const knownAction = isKnownAction(eventName, parsed.action);
    const inventorySignal = ["installation", "installation_repositories", "repository"].includes(eventName) && knownAction && Boolean(parsed.installationGithubId);
    // M2 lifecycle events are durable signals for an authoritative inventory
    // refresh. Their embedded repository arrays are never treated as truth.
    const ignored = (!inventorySignal && parsed.kind !== "push") || !knownAction;
    const installation = parsed.installationGithubId ? await deps.store.getInstallation(parsed.installationGithubId) : undefined;
    const payloadCiphertext = encryptSecret(raw.toString("utf8"), deps.config.ENCRYPTION_KEY_BASE64);
    const tenantId = installation?.tenantId;
    if (!tenantId) {
      await deps.store.recordUnroutedWebhook({ guid, eventName, payloadCiphertext, receivedAt: now(), payloadExpiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000) });
      return reply.code(202).send({ accepted: true, state: "ignored" });
    }
    const delivery = await deps.store.insertDelivery({
      tenantId,
      guid,
      eventName,
      ...(parsed.action ? { action: parsed.action } : {}),
      ...(parsed.installationGithubId ? { installationGithubId: parsed.installationGithubId } : {}),
      ...(parsed.repositoryGithubId ? { repositoryGithubId: parsed.repositoryGithubId } : {}),
      ...(parsed.push ? { ref: parsed.push.ref, before: parsed.push.before, after: parsed.push.after, forced: parsed.push.forced } : {}),
      payloadCiphertext,
      payloadExpiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000),
      now: now(),
    });
    const canonicalPush = Boolean(delivery.record.ref && delivery.record.after);
    if (ignored && (delivery.created || !canonicalPush)) {
      await deps.store.updateDelivery(delivery.record.id, { state: "ignored", processedAt: now() }, delivery.record.tenantId);
      return reply.code(202).send({ accepted: true, state: "ignored" });
    }
    if (delivery.action === "noop") return reply.code(202).send({ accepted: true, state: delivery.record.state });
    const logicalKey = deliveryLogicalKey(delivery.record.id);
    const jobPayload = {
      kind: "webhook_delivery",
      tenantId: delivery.record.tenantId,
      deliveryId: delivery.record.id,
      deliveryGuid: delivery.record.guid,
      eventName: delivery.record.eventName,
      ...(delivery.record.action ? { action: delivery.record.action } : {}),
      ...(delivery.record.installationGithubId ? { installationId: delivery.record.installationGithubId } : {}),
      ...(delivery.record.installationGithubId ? { installationGithubId: delivery.record.installationGithubId } : {}),
      ...(delivery.record.repositoryGithubId ? { repositoryGithubId: delivery.record.repositoryGithubId } : {}),
      ...(canonicalPush ? { ref: delivery.record.ref, before: delivery.record.before ?? "0".repeat(40), after: delivery.record.after ?? "0".repeat(40), forced: delivery.record.forced ?? false } : {}),
    };
    await deps.store.ensureJob(logicalKey, jobPayload);
    if (delivery.record.jobId && await deps.jobs.has(delivery.record.jobId, "webhook_delivery")) {
      const state = delivery.record.state === "failed" || delivery.record.state === "dead_letter" ? "received" : delivery.record.state;
      if (state !== delivery.record.state) await deps.store.updateDelivery(delivery.record.id, { state }, delivery.record.tenantId);
      return reply.code(202).send({ accepted: true, state });
    }
    const jobId = await deps.jobs.enqueue("webhook_delivery", logicalKey, jobPayload);
    const nextState = delivery.record.state === "failed" || delivery.record.state === "dead_letter" ? "received" : delivery.record.state;
    await deps.store.updateDelivery(delivery.record.id, { jobId: jobId ?? null, state: nextState }, delivery.record.tenantId);
    return reply.code(202).send({ accepted: true, state: nextState });
  });

  app.get<{ Querystring: { repositoryId?: string } }>("/api/activity", async (request, reply) => {
    const session = await requireSession(request as RequestWithSession, reply);
    if (!session) return;
    const repositories = await deps.store.listRepositories(session.tenantId);
    const events = defaultTimelineEvents(await deps.store.listActivity(session.tenantId, request.query.repositoryId), deps.config.OWNER_GITHUB_USER_ID);
    return { completeness: "Newest 100 commits currently reachable from the default branch of this connected repository.", ...(repositories[0] ? { repository: { id: repositories[0].id, fullName: repositories[0].fullName, private: repositories[0].private } } : {}), events: events.map((event) => { const sourceUrl = (event as typeof event & { htmlUrl?: string }).htmlUrl; return { id: event.id, repositoryId: event.repositoryId, occurredAt: event.occurredAt.toISOString(), verb: event.verb, contributionRole: event.contributionRole, contextKind: event.contextKind, actorKind: event.actorKind, ...(event.summaryInput ? { message: event.summaryInput } : {}), ...(sourceUrl ? { sourceUrl } : {}) }; }) };
  });

  app.setErrorHandler((error, request, reply) => {
    deps.logger.error({ request_id: request.id, result: "error" }, error);
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    return reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({ error: statusCode === 413 ? "payload_too_large" : "internal_error" });
  });
  return app;
}
