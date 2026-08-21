import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import type { AppConfig } from "@devmemoir/config";
import { createId, createOpaqueToken, defaultTimelineEvents, encryptSecret, hashOpaqueToken, minimalPushSignal, parseWebhook } from "@devmemoir/domain";
import type { GithubClient } from "@devmemoir/github";
import type { JobPort } from "@devmemoir/jobs";
import { deliveryLogicalKey } from "@devmemoir/jobs";
import type { Logger } from "@devmemoir/observability";
import type { DeliveryRecord, M1Store, SessionRecord } from "@devmemoir/db";
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

  app.get("/health", async () => ({ ok: true, service: "api", m1: true }));

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
      return reply.code(status).send({ error: error instanceof Error ? error.message : "oauth_failed" });
    }
  });

  app.post<{ Body: { code?: string } }>("/auth/handoff/exchange", async (request, reply) => {
    try {
      if (!request.body?.code) throw new AuthFlowError("Missing handoff code");
      return await auth.exchangeHandoff(request.body.code);
    } catch (error) {
      const status = error instanceof AuthFlowError ? error.statusCode : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "handoff_failed" });
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
    const session = await sessionFromRequest(request as RequestWithSession);
    if (!session) return reply.code(401).send({ error: "authenticated_claim_required" });
    if (!request.query.state) return reply.code(400).send({ error: "installation_state_required" });
    const transaction = await deps.store.consumeAuthState(hashOpaqueToken(request.query.state, deps.config.SESSION_SECRET), now());
    if (!transaction || transaction.userId !== session.userId) return reply.code(400).send({ error: "invalid_installation_state" });
    const installation = await deps.github.getInstallation(installationId);
    const signedInUser = await deps.store.getUserById(session.userId);
    if (installation.account.type !== "User" || installation.account.id !== signedInUser?.githubAccountId) return reply.code(403).send({ error: "installation_account_mismatch" });
    await deps.store.saveInstallation({ id: createId(), tenantId: session.tenantId, githubInstallationId: installationId, accountGithubAccountId: installation.account.id });
    return reply.redirect(new URL("/connect?connected=1", deps.config.WEB_ORIGIN).toString());
  });

  app.post<{ Body: { owner?: string; repo?: string } }>("/connect/repository", async (request, reply) => {
    const session = await requireCsrf(request as RequestWithSession, reply);
    if (!session) return;
    const owner = request.body?.owner;
    const repo = request.body?.repo;
    if (!owner || !repo) return reply.code(400).send({ error: "owner_and_repo_required" });
    const connectedRepositories = await deps.store.listRepositories(session.tenantId);
    if (connectedRepositories.length > 0 && connectedRepositories[0]?.fullName !== `${owner}/${repo}`) return reply.code(409).send({ error: "m1_supports_one_repository" });
    const installation = (await deps.store.listInstallations(session.tenantId))[0];
    if (!installation) return reply.code(409).send({ error: "installation_required" });
    const client = deps.installationGithub?.(installation.githubInstallationId) ?? deps.github;
    const githubRepository = await client.getRepository(owner, repo);
    const repository: import("@devmemoir/db").RepositoryRecord = { id: createId(), tenantId: session.tenantId, installationId: installation.id, githubRepositoryId: githubRepository.id, ownerLogin: githubRepository.owner?.login ?? owner, name: githubRepository.name, fullName: githubRepository.full_name, private: githubRepository.private, ...(githubRepository.visibility ? { visibility: githubRepository.visibility } : {}), defaultBranch: githubRepository.default_branch, ...(githubRepository.description ? { description: githubRepository.description } : {}) };
    await deps.store.saveRepository(repository);
    const head = await client.getRefHead({ owner: repository.ownerLogin, repo: repository.name, ref: repository.defaultBranch });
    const jobPayload = { tenantId: repository.tenantId, repositoryId: repository.id, installationId: installation.githubInstallationId, owner: repository.ownerLogin, repo: repository.name, ref: `refs/heads/${repository.defaultBranch}`, before: "0".repeat(40), after: head ?? "0".repeat(40), forced: false };
    await deps.jobs.enqueue("repository_backfill", `backfill:${repository.id}`, jobPayload);
    return reply.code(201).send({ repository, completeness: "Newest 100 commits currently reachable from the default branch of this connected repository." });
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
    const ignored = parsed.kind === "ignored" || !knownAction;
    const installation = parsed.installationGithubId ? await deps.store.getInstallation(parsed.installationGithubId) : undefined;
    const fallbackUser = installation ? undefined : await deps.store.getUserByGithubAccountId(deps.config.OWNER_GITHUB_USER_ID);
    const tenantId = installation?.tenantId ?? fallbackUser?.tenantId;
    if (!tenantId) return reply.code(202).send({ accepted: true, state: "ignored" });
    const payloadCiphertext = encryptSecret(raw.toString("utf8"), deps.config.ENCRYPTION_KEY_BASE64);
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
    if (ignored) {
      await deps.store.updateDelivery(delivery.record.id, { state: "ignored", processedAt: now() }, delivery.record.tenantId);
      return reply.code(202).send({ accepted: true, state: "ignored" });
    }
    if (delivery.action === "noop" || (delivery.action === "ensure_job" && delivery.record.jobId)) return reply.code(202).send({ accepted: true, state: delivery.record.state });
    const logicalKey = deliveryLogicalKey(delivery.record.id);
    const jobId = await deps.jobs.enqueue("webhook_delivery", logicalKey, { tenantId, deliveryId: delivery.record.id, deliveryGuid: guid, eventName, installationGithubId: parsed.installationGithubId, repositoryGithubId: parsed.repositoryGithubId, ...(parsed.push ? minimalPushSignal(guid, parsed) : {}) });
    await deps.store.updateDelivery(delivery.record.id, { jobId, state: delivery.record.state === "failed" || delivery.record.state === "dead_letter" ? "received" : delivery.record.state }, delivery.record.tenantId);
    return reply.code(202).send({ accepted: true, state: delivery.record.state });
  });

  app.get<{ Querystring: { repositoryId?: string } }>("/api/activity", async (request, reply) => {
    const session = await requireSession(request as RequestWithSession, reply);
    if (!session) return;
    const events = defaultTimelineEvents(await deps.store.listActivity(session.tenantId, request.query.repositoryId), deps.config.OWNER_GITHUB_USER_ID);
    return { completeness: "Newest 100 commits currently reachable from the default branch of this connected repository.", events: events.map((event) => { const sourceUrl = (event as typeof event & { htmlUrl?: string }).htmlUrl; return { id: event.id, repositoryId: event.repositoryId, occurredAt: event.occurredAt.toISOString(), verb: event.verb, contributionRole: event.contributionRole, contextKind: event.contextKind, actorKind: event.actorKind, ...(event.summaryInput ? { message: event.summaryInput } : {}), ...(sourceUrl ? { sourceUrl } : {}) }; }) };
  });

  app.setErrorHandler((error, request, reply) => {
    deps.logger.error({ request_id: request.id, result: "error" }, error);
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    return reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({ error: statusCode === 413 ? "payload_too_large" : "internal_error" });
  });
  return app;
}
