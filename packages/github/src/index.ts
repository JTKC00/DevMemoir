import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { CommitFact, GithubActor } from "@devmemoir/domain";
import { actorKindFromGithub } from "@devmemoir/domain";
import { randomInt } from "node:crypto";
import { z } from "zod";

export const API_VERSION = "2022-11-28";
const DEFAULT_PER_PAGE = 100;
const SECONDARY_LIMIT_FALLBACK_MS = 60_000;
const MAX_RATE_LIMIT_JITTER_MS = 5_000;

export function githubRefParameter(ref: string): string {
  const normalized = ref.replace(/^refs\//, "");
  if (normalized.startsWith("heads/") || normalized.startsWith("tags/")) return normalized;
  return `heads/${normalized}`;
}

const ALLOWED_ENDPOINTS = new Set([
  "GET /installation/repositories",
  "GET /app/installations/{installation_id}",
  "GET /app/hook/deliveries",
  "POST /app/hook/deliveries/{delivery_id}/attempts",
  "GET /repos/{owner}/{repo}",
  "GET /repos/{owner}/{repo}/languages",
  "GET /repos/{owner}/{repo}/topics",
  "GET /repos/{owner}/{repo}/branches",
  "GET /repos/{owner}/{repo}/commits",
  "GET /repos/{owner}/{repo}/commits/{ref}",
  "GET /repos/{owner}/{repo}/git/ref/{ref}",
  "GET /repos/{owner}/{repo}/tags",
  "GET /repos/{owner}/{repo}/pulls",
  "GET /repos/{owner}/{repo}/issues",
  "GET /repos/{owner}/{repo}/releases",
  "GET /user",
  "POST /login/oauth/access_token",
]);

/** Process-local lane key for App JWT requests. Not an installation id. */
export const APP_JWT_RATE_LIMIT_LANE = 0;

export class GithubEndpointDeniedError extends Error {
  constructor(endpoint: string) {
    super(`GitHub endpoint denied by permit-list: ${endpoint}`);
    this.name = "GithubEndpointDeniedError";
  }
}

export function assertGithubEndpointAllowed(endpoint: string): void {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new GithubEndpointDeniedError(endpoint);
}

export function stripCompareFiles<T extends { files?: Array<Record<string, unknown>> }>(response: T): Omit<T, "files"> & { files?: Array<Record<string, unknown>> } {
  if (!response.files) return response;
  return { ...response, files: response.files.map(() => ({})) };
}

const actorSchema = z.object({ id: z.number().int().positive(), login: z.string().nullable().optional(), type: z.string().nullable().optional() }).strip();
const nullableActorSchema = actorSchema.nullable().optional();
const userSchema = z.object({ id: z.number().int().positive(), login: z.string(), type: z.string().optional() }).strip();
const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive(), login: z.string().optional(), type: z.string() }).strip(),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string()).optional(),
  suspended_at: z.string().nullable().optional(),
}).strip();
const repositorySchema = z.object({
  id: z.number().int().positive(), node_id: z.string().optional(), name: z.string(), full_name: z.string(),
  owner: z.object({ login: z.string().optional() }).strip().optional(), private: z.boolean(), visibility: z.string().optional(),
  default_branch: z.string(), archived: z.boolean().optional(), disabled: z.boolean().optional(), html_url: z.string().optional(),
  description: z.string().nullable().optional(), pushed_at: z.string().nullable().optional(), created_at: z.string().nullable().optional(), updated_at: z.string().nullable().optional(),
}).strip();
const commitSchema = z.object({
  sha: z.string(), author: nullableActorSchema, committer: nullableActorSchema,
  commit: z.object({
    message: z.string().default(""),
    author: z.object({ date: z.string().nullable().optional() }).strip().nullable().optional(),
    committer: z.object({ date: z.string().nullable().optional() }).strip().nullable().optional(),
    verification: z.object({ verified: z.boolean() }).strip().optional(),
  }).strip(),
  parents: z.array(z.object({ sha: z.string() }).strip()).default([]), html_url: z.string().optional(),
}).strip();
const branchSchema = z.object({ name: z.string(), commit: z.object({ sha: z.string() }).strip(), protected: z.boolean().optional() }).strip();
const tagSchema = z.object({ name: z.string(), commit: z.object({ sha: z.string() }).strip() }).strip();
const pullRequestSchema = z.object({
  id: z.number().int().positive(), number: z.number().int().positive(), title: z.string(), state: z.string(), draft: z.boolean().optional(),
  user: nullableActorSchema, merged_by: nullableActorSchema,
  base: z.object({ ref: z.string(), sha: z.string() }).strip(), head: z.object({ ref: z.string(), sha: z.string() }).strip(),
  html_url: z.string().optional(), created_at: z.string(), updated_at: z.string(), closed_at: z.string().nullable().optional(), merged_at: z.string().nullable().optional(),
}).strip();
const issueSchema = z.object({
  id: z.number().int().positive(), number: z.number().int().positive(), title: z.string(), state: z.string(), state_reason: z.string().nullable().optional(),
  user: nullableActorSchema, html_url: z.string().optional(), created_at: z.string(), updated_at: z.string(), closed_at: z.string().nullable().optional(),
}).strip();
const releaseSchema = z.object({
  id: z.number().int().positive(), tag_name: z.string(), name: z.string().nullable().optional(), draft: z.boolean(), prerelease: z.boolean(),
  author: nullableActorSchema, html_url: z.string().optional(), created_at: z.string(), published_at: z.string().nullable().optional(),
}).strip();
const unknownRecordSchema = z.record(z.unknown());
const appWebhookDeliverySchema = z.object({
  id: z.number().int().positive(),
  guid: z.string().min(1),
  delivered_at: z.string(),
  redelivery: z.boolean(),
  status_code: z.number().int(),
  event: z.string(),
  action: z.string().nullable().optional(),
  installation_id: z.number().int().nullable().optional(),
  repository_id: z.number().int().nullable().optional(),
}).strip();

export type GithubResponseHeaders = Record<string, string | number | undefined>;
export type GithubRequestResponse<T = unknown> = { data: T; status?: number; headers?: GithubResponseHeaders };
type Requester = { request: (route: string, parameters?: Record<string, unknown>) => Promise<GithubRequestResponse> };

export type GithubUser = { id: number; login: string; type?: string | undefined };
export type GithubInstallation = z.infer<typeof installationSchema>;
export type GithubRepository = z.infer<typeof repositorySchema>;
export type GithubCommit = CommitFact & { htmlUrl?: string };
export type GithubBranch = { name: string; headSha: string; protected?: boolean };
export type GithubTag = { name: string; targetSha: string };
export type GithubPullRequest = {
  id: number; number: number; title: string; state: string; draft?: boolean; author?: GithubActor; mergedBy?: GithubActor;
  baseRef: string; baseSha: string; headRef: string; headSha: string; htmlUrl?: string;
  createdAt: Date; updatedAt: Date; closedAt?: Date; mergedAt?: Date;
};
export type GithubIssue = {
  id: number; number: number; title: string; state: string; stateReason?: string; author?: GithubActor; htmlUrl?: string;
  createdAt: Date; updatedAt: Date; closedAt?: Date;
};
export type GithubRelease = {
  id: number; tagName: string; name?: string; draft: boolean; prerelease: boolean; author?: GithubActor; htmlUrl?: string;
  createdAt: Date; publishedAt?: Date;
};

export type InstallationRepositoryPage = { repositories: GithubRepository[]; nextPage?: number };
export type GithubCommitPage = { commits: GithubCommit[]; nextPage?: number };
export type GithubBranchPage = { branches: GithubBranch[]; nextPage?: number };
export type GithubTagPage = { tags: GithubTag[]; nextPage?: number };
export type GithubPullRequestPage = { pullRequests: GithubPullRequest[]; nextPage?: number };
export type GithubIssuePage = { issues: GithubIssue[]; nextPage?: number };
export type GithubReleasePage = { releases: GithubRelease[]; nextPage?: number };

export type GithubPageInput = { owner: string; repo: string; page?: number; perPage?: number };
export type ListCommitsInput = GithubPageInput & { sha?: string; since?: string };
export type ListPullRequestsInput = GithubPageInput & { sort?: "created" | "updated" | "popularity" | "long-running"; direction?: "asc" | "desc" };
export type ListIssuesInput = GithubPageInput & { since?: string; sort?: "created" | "updated" | "comments"; direction?: "asc" | "desc" };

export type AppWebhookDelivery = {
  id: number;
  guid: string;
  deliveredAt: Date;
  redelivery: boolean;
  statusCode: number;
  eventName: string;
  action?: string;
  installationGithubId?: number;
  repositoryGithubId?: number;
};

export type AppWebhookDeliveryPage = { deliveries: AppWebhookDelivery[]; nextCursor?: string };
export type ListAppWebhookDeliveriesInput = { perPage?: number; cursor?: string };

export interface GithubAppClient {
  listAppWebhookDeliveries(input?: ListAppWebhookDeliveriesInput): Promise<AppWebhookDeliveryPage>;
  redeliverAppWebhookDelivery(deliveryId: number): Promise<void>;
}

export function nextPageFromLink(link: unknown): number | undefined {
  const value = typeof link === "string" ? link : "";
  for (const part of value.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const page = /[?&]page=(\d+)/.exec(part)?.[1];
    if (page) return Number(page);
  }
  return undefined;
}

export function nextCursorFromLink(link: unknown): string | undefined {
  const value = typeof link === "string" ? link : "";
  for (const part of value.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const encoded = /[?&]cursor=([^&>]+)/.exec(part)?.[1];
    if (!encoded) continue;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return undefined;
}

export interface GithubClient {
  getUser(accessToken: string): Promise<GithubUser>;
  exchangeOAuthCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }): Promise<{ accessToken: string }>;
  getInstallation(installationId: number): Promise<GithubInstallation>;
  listInstallationRepositories(page: number, perPage?: number): Promise<InstallationRepositoryPage>;
  getRepository(owner: string, repo: string): Promise<GithubRepository>;
  listCommits(input: ListCommitsInput): Promise<GithubCommitPage>;
  getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit>;
  getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null>;
  listBranches(input: GithubPageInput): Promise<GithubBranchPage>;
  listTags(input: GithubPageInput): Promise<GithubTagPage>;
  listPullRequests(input: ListPullRequestsInput): Promise<GithubPullRequestPage>;
  listIssues(input: ListIssuesInput): Promise<GithubIssuePage>;
  listReleases(input: GithubPageInput): Promise<GithubReleasePage>;
}

function toActor(raw: z.infer<typeof actorSchema> | null | undefined): GithubActor | undefined {
  if (!raw?.id) return undefined;
  const actorInput = { id: raw.id, ...(raw.login !== undefined ? { login: raw.login } : {}), ...(raw.type !== undefined ? { type: raw.type } : {}) };
  return { githubAccountId: raw.id, ...(raw.login ? { login: raw.login } : {}), ...(raw.type ? { accountType: raw.type } : {}), actorKind: actorKindFromGithub(actorInput) };
}

function validDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function requiredDate(value: string): Date {
  const date = validDate(value);
  if (!date) throw new Error("GitHub metadata contained an invalid timestamp");
  return date;
}

function toCommit(input: unknown): GithubCommit {
  const raw = commitSchema.parse(input);
  const author = toActor(raw.author);
  const committer = toActor(raw.committer);
  const authorDate = validDate(raw.commit.author?.date);
  const committerDate = validDate(raw.commit.committer?.date);
  return {
    repositoryId: "", sha: raw.sha, ...(author ? { author } : {}), ...(committer ? { committer } : {}), message: raw.commit.message,
    ...(authorDate ? { authoredAt: authorDate } : {}), ...(committerDate ? { committedAt: committerDate } : {}),
    parents: raw.parents.map((parent) => parent.sha),
    ...(raw.commit.verification?.verified !== undefined ? { verified: raw.commit.verification.verified } : {}),
    ...(raw.html_url ? { htmlUrl: raw.html_url } : {}),
  };
}

function toPullRequest(input: unknown): GithubPullRequest {
  const raw = pullRequestSchema.parse(input);
  const author = toActor(raw.user);
  const mergedBy = toActor(raw.merged_by);
  const closedAt = validDate(raw.closed_at);
  const mergedAt = validDate(raw.merged_at);
  return {
    id: raw.id, number: raw.number, title: raw.title, state: raw.state, ...(raw.draft !== undefined ? { draft: raw.draft } : {}),
    ...(author ? { author } : {}), ...(mergedBy ? { mergedBy } : {}),
    baseRef: raw.base.ref, baseSha: raw.base.sha, headRef: raw.head.ref, headSha: raw.head.sha,
    ...(raw.html_url ? { htmlUrl: raw.html_url } : {}), createdAt: requiredDate(raw.created_at), updatedAt: requiredDate(raw.updated_at),
    ...(closedAt ? { closedAt } : {}), ...(mergedAt ? { mergedAt } : {}),
  };
}

function toIssue(input: unknown): GithubIssue {
  const raw = issueSchema.parse(input);
  const author = toActor(raw.user);
  const closedAt = validDate(raw.closed_at);
  return {
    id: raw.id, number: raw.number, title: raw.title, state: raw.state, ...(raw.state_reason ? { stateReason: raw.state_reason } : {}),
    ...(author ? { author } : {}), ...(raw.html_url ? { htmlUrl: raw.html_url } : {}),
    createdAt: requiredDate(raw.created_at), updatedAt: requiredDate(raw.updated_at), ...(closedAt ? { closedAt } : {}),
  };
}

function toAppWebhookDelivery(input: unknown): AppWebhookDelivery {
  const raw = appWebhookDeliverySchema.parse(input);
  const deliveredAt = requiredDate(raw.delivered_at);
  return {
    id: raw.id,
    guid: raw.guid,
    deliveredAt,
    redelivery: raw.redelivery,
    statusCode: raw.status_code,
    eventName: raw.event,
    ...(raw.action ? { action: raw.action } : {}),
    ...(raw.installation_id ? { installationGithubId: raw.installation_id } : {}),
    ...(raw.repository_id ? { repositoryGithubId: raw.repository_id } : {}),
  };
}

function toRelease(input: unknown): GithubRelease {
  const raw = releaseSchema.parse(input);
  const author = toActor(raw.author);
  const publishedAt = validDate(raw.published_at);
  return {
    id: raw.id, tagName: raw.tag_name, ...(raw.name ? { name: raw.name } : {}), draft: raw.draft, prerelease: raw.prerelease,
    ...(author ? { author } : {}), ...(raw.html_url ? { htmlUrl: raw.html_url } : {}), createdAt: requiredDate(raw.created_at),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function pageParameters(page = 1, perPage = DEFAULT_PER_PAGE): { page: number; per_page: number } {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > DEFAULT_PER_PAGE) {
    throw new RangeError("GitHub pagination must use page >= 1 and perPage from 1 through 100");
  }
  return { page, per_page: perPage };
}

function nextPageResult<T extends Record<string, unknown>>(items: T, response: GithubRequestResponse): T & { nextPage?: number } {
  const nextPage = nextPageFromLink(headerValue(response.headers, "link"));
  return { ...items, ...(nextPage ? { nextPage } : {}) };
}

function headerValue(headers: GithubResponseHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  return entry === undefined ? undefined : String(entry);
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = "status" in error ? error.status : undefined;
  if (typeof direct === "number") return direct;
  const response = "response" in error && typeof error.response === "object" && error.response !== null ? error.response : undefined;
  return response && "status" in response && typeof response.status === "number" ? response.status : undefined;
}

function errorHeaders(error: unknown): GithubResponseHeaders | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = "response" in error && typeof error.response === "object" && error.response !== null ? error.response : undefined;
  const candidate = response && "headers" in response ? response.headers : "headers" in error ? error.headers : undefined;
  return typeof candidate === "object" && candidate !== null ? candidate as GithubResponseHeaders : undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const response = "response" in error && typeof error.response === "object" && error.response !== null ? error.response : undefined;
  const data = response && "data" in response && typeof response.data === "object" && response.data !== null ? response.data : undefined;
  if (data && "message" in data && typeof data.message === "string") return data.message;
  return "message" in error && typeof error.message === "string" ? error.message : "";
}

function retryAfterResumeAt(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(now, date);
}

function resetResumeAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export type GithubRateLimitCode = "primary_rate_limit" | "secondary_rate_limit" | "retry_after";
export type GithubAccessCode = "unauthorized" | "forbidden" | "not_found";
/** Returns a jitter duration from zero through maxMs, inclusive. */
export type GithubRateLimitJitterSource = (maxMs: number) => number;

const randomRateLimitJitter: GithubRateLimitJitterSource = (maxMs) => randomInt(maxMs + 1);

function boundedRateLimitJitter(source: GithubRateLimitJitterSource): number {
  const value = source(MAX_RATE_LIMIT_JITTER_MS);
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_RATE_LIMIT_JITTER_MS, Math.max(0, Math.floor(value)));
}

export class GithubRateLimitPauseError extends Error {
  constructor(readonly code: GithubRateLimitCode, readonly status: number, readonly resumeAt: Date) {
    super("GitHub installation request paused");
    this.name = "GithubRateLimitPauseError";
  }
  toJSON(): { class: string; code: GithubRateLimitCode; status: number; resumeAt: string } {
    return { class: this.name, code: this.code, status: this.status, resumeAt: this.resumeAt.toISOString() };
  }
}

export class GithubAccessError extends Error {
  constructor(readonly code: GithubAccessCode, readonly status: number) {
    super("GitHub installation access unavailable");
    this.name = "GithubAccessError";
  }
  toJSON(): { class: string; code: GithubAccessCode; status: number } {
    return { class: this.name, code: this.code, status: this.status };
  }
}

export class GithubTransientError extends Error {
  constructor(readonly status: number) {
    super("GitHub request failed");
    this.name = "GithubTransientError";
  }
  toJSON(): { class: string; status: number } {
    return { class: this.name, status: this.status };
  }
}

function pauseFromMetadata(
  input: { status?: number | undefined; headers?: GithubResponseHeaders | undefined; message?: string | undefined },
  now: number,
  jitterSource: GithubRateLimitJitterSource,
): GithubRateLimitPauseError | undefined {
  const retryAt = retryAfterResumeAt(headerValue(input.headers, "retry-after"), now);
  const remaining = Number(headerValue(input.headers, "x-ratelimit-remaining"));
  const resetAt = resetResumeAt(headerValue(input.headers, "x-ratelimit-reset"));
  const secondary = (input.status === 403 || input.status === 429) && /secondary rate limit|abuse detection/i.test(input.message ?? "");
  const primary = remaining === 0;
  if (!retryAt && !primary && !secondary) return undefined;
  const code: GithubRateLimitCode = secondary ? "secondary_rate_limit" : primary ? "primary_rate_limit" : "retry_after";
  const fallbackAt = now + SECONDARY_LIMIT_FALLBACK_MS;
  const authoritativeResumeAt = Math.max(now, retryAt ?? 0, primary ? (resetAt ?? fallbackAt) : 0, secondary && !retryAt ? fallbackAt : 0);
  const resumeAt = authoritativeResumeAt + boundedRateLimitJitter(jitterSource);
  return new GithubRateLimitPauseError(code, input.status ?? 429, new Date(resumeAt));
}

function classifyRequestError(error: unknown, now: number, jitterSource: GithubRateLimitJitterSource): Error {
  if (error instanceof GithubRateLimitPauseError || error instanceof GithubAccessError || error instanceof GithubTransientError) return error;
  const status = errorStatus(error);
  const pause = pauseFromMetadata({ status, headers: errorHeaders(error), message: errorMessage(error) }, now, jitterSource);
  if (pause) return pause;
  if (status === 401) return new GithubAccessError("unauthorized", status);
  if (status === 403) return new GithubAccessError("forbidden", status);
  if (status === 404 || status === 410) return new GithubAccessError("not_found", status);
  // Never let an upstream response message cross the client boundary: GitHub
  // errors can echo repository names, paths, or content supplied by fixtures.
  return new GithubTransientError(status ?? 0);
}

type LaneTask = { installationId: number; request: () => Promise<GithubRequestResponse>; resolve: (response: GithubRequestResponse) => void; reject: (error: unknown) => void; persistRateLimit: boolean };
type LaneState = {
  active: number;
  pausedUntil: number | undefined;
  pauseCode: GithubRateLimitCode | undefined;
  pauseStatus: number | undefined;
  queue: LaneTask[];
};

export type GithubRateLimitState = {
  code: GithubRateLimitCode;
  status: number;
  resumeAt: Date;
};

export type GithubRateLimitObserver = (installationId: number, state: GithubRateLimitState) => Promise<void> | void;

/** Non-sleeping installation-keyed scheduler. Callers persist pause state and retry later. */
export class InstallationRequestLanes {
  private readonly lanes = new Map<number, LaneState>();

  constructor(
    private readonly concurrency: 1 | 2 = 1,
    private readonly now: () => number = Date.now,
    private readonly onRateLimitState?: GithubRateLimitObserver,
    private readonly jitterSource: GithubRateLimitJitterSource = randomRateLimitJitter,
  ) {
    if (concurrency !== 1 && concurrency !== 2) throw new RangeError("GitHub installation request concurrency must be 1 or 2");
  }

  run(installationId: number, request: () => Promise<GithubRequestResponse>, options: { persistRateLimit?: boolean } = {}): Promise<GithubRequestResponse> {
    const lane = this.lanes.get(installationId) ?? { active: 0, pausedUntil: undefined, pauseCode: undefined, pauseStatus: undefined, queue: [] };
    this.lanes.set(installationId, lane);
    return new Promise((resolve, reject) => {
      lane.queue.push({ installationId, request, resolve, reject, persistRateLimit: options.persistRateLimit !== false });
      this.pump(lane);
    });
  }

  private pump(lane: LaneState): void {
    while (lane.active < this.concurrency && lane.queue.length > 0) {
      const task = lane.queue.shift();
      if (!task) return;
      const now = this.now();
      if (lane.pausedUntil !== undefined && lane.pausedUntil > now) {
        task.reject(new GithubRateLimitPauseError(lane.pauseCode ?? "primary_rate_limit", lane.pauseStatus ?? 429, new Date(lane.pausedUntil)));
        continue;
      }
      if (lane.pausedUntil !== undefined) {
        lane.pausedUntil = undefined;
        lane.pauseCode = undefined;
        lane.pauseStatus = undefined;
      }
      lane.active += 1;
      void Promise.resolve().then(task.request).then(async (response) => {
        const successPause = pauseFromMetadata({ status: response.status, headers: response.headers }, this.now(), this.jitterSource);
        if (successPause) {
          lane.pausedUntil = successPause.resumeAt.getTime();
          lane.pauseCode = successPause.code;
          lane.pauseStatus = successPause.status;
          // Persist only sanitized metadata and wait for the observer before
          // exposing the successful response to the worker. This closes the
          // response-to-durable-state crash window without storing raw data.
          if (task.persistRateLimit) await this.onRateLimitState?.(task.installationId, { code: successPause.code, status: successPause.status, resumeAt: successPause.resumeAt });
        }
        task.resolve(response);
      }).catch((rawError: unknown) => {
        const error = classifyRequestError(rawError, this.now(), this.jitterSource);
        if (error instanceof GithubRateLimitPauseError) {
          lane.pausedUntil = error.resumeAt.getTime();
          lane.pauseCode = error.code;
          lane.pauseStatus = error.status;
        }
        task.reject(error);
      }).finally(() => {
        lane.active -= 1;
        this.pump(lane);
      });
    }
  }
}

export class OctokitGithubClient implements GithubClient, GithubAppClient {
  private readonly app: App;
  private readonly apiVersion: string;
  private readonly installationClients = new Map<number, Promise<Requester>>();
  private readonly installationRequestLanes: InstallationRequestLanes;

  constructor(input: { appId: number; privateKey: string; apiVersion?: string; webhookSecret?: string; installationRequestConcurrency?: 1 | 2; onRateLimitState?: GithubRateLimitObserver; rateLimitJitterSource?: GithubRateLimitJitterSource }) {
    this.apiVersion = input.apiVersion ?? API_VERSION;
    this.installationRequestLanes = new InstallationRequestLanes(input.installationRequestConcurrency ?? 1, Date.now, input.onRateLimitState, input.rateLimitJitterSource);
    this.app = new App({ appId: input.appId, privateKey: input.privateKey, ...(input.webhookSecret ? { webhooks: { secret: input.webhookSecret } } : {}) });
  }

  private installationClient(installationId: number): Promise<Requester> {
    const existing = this.installationClients.get(installationId);
    if (existing) return existing;
    const pending = this.app.getInstallationOctokit(installationId).then((client) => ({
      request: (route: string, parameters?: Record<string, unknown>) => client.request(route, { ...parameters, headers: { ...(parameters?.headers as Record<string, string> | undefined), "X-GitHub-Api-Version": this.apiVersion } }),
    }));
    this.installationClients.set(installationId, pending);
    void pending.catch(() => this.installationClients.delete(installationId));
    return pending;
  }

  async getUser(accessToken: string): Promise<GithubUser> {
    const client = new Octokit({ auth: accessToken });
    assertGithubEndpointAllowed("GET /user");
    const response = await client.request("GET /user", { headers: { "X-GitHub-Api-Version": this.apiVersion } });
    return userSchema.parse(response.data);
  }

  async exchangeOAuthCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }): Promise<{ accessToken: string }> {
    assertGithubEndpointAllowed("POST /login/oauth/access_token");
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
    });
    if (!response.ok) throw new Error(`GitHub OAuth exchange failed: ${response.status}`);
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("GitHub OAuth exchange failed");
    return { accessToken: body.access_token };
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    assertGithubEndpointAllowed("GET /app/installations/{installation_id}");
    const response = await this.installationRequestLanes.run(installationId, () => this.app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
      headers: { "X-GitHub-Api-Version": this.apiVersion },
    }), { persistRateLimit: false });
    return installationSchema.parse(response.data);
  }

  async listAppWebhookDeliveries(input: ListAppWebhookDeliveriesInput = {}): Promise<AppWebhookDeliveryPage> {
    assertGithubEndpointAllowed("GET /app/hook/deliveries");
    const perPage = input.perPage ?? DEFAULT_PER_PAGE;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > DEFAULT_PER_PAGE) {
      throw new RangeError("GitHub pagination must use page >= 1 and perPage from 1 through 100");
    }
    const response = await this.requestApp("GET /app/hook/deliveries", {
      per_page: perPage,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    const deliveries = z.array(appWebhookDeliverySchema).parse(response.data).map((delivery) => toAppWebhookDelivery(delivery));
    const nextCursor = nextCursorFromLink(headerValue(response.headers, "link"));
    return { deliveries, ...(nextCursor ? { nextCursor } : {}) };
  }

  async redeliverAppWebhookDelivery(deliveryId: number): Promise<void> {
    if (!Number.isInteger(deliveryId) || deliveryId <= 0) throw new RangeError("GitHub delivery id must be a positive integer");
    assertGithubEndpointAllowed("POST /app/hook/deliveries/{delivery_id}/attempts");
    await this.requestApp("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: deliveryId });
  }

  protected async requestApp(route: string, parameters?: Record<string, unknown>): Promise<GithubRequestResponse> {
    assertGithubEndpointAllowed(route);
    return this.installationRequestLanes.run(APP_JWT_RATE_LIMIT_LANE, () => this.app.octokit.request(route, {
      ...parameters,
      headers: { ...(parameters?.headers as Record<string, string> | undefined), "X-GitHub-Api-Version": this.apiVersion },
    }), { persistRateLimit: false });
  }

  async listInstallationRepositories(page: number, perPage = DEFAULT_PER_PAGE): Promise<InstallationRepositoryPage> { void page; void perPage; throw new Error("Installation repository listing requires an installation client"); }
  async getRepository(owner: string, repo: string): Promise<GithubRepository> { void owner; void repo; throw new Error("Repository reads require an installation client"); }
  async listCommits(input: ListCommitsInput): Promise<GithubCommitPage> { void input; throw new Error("Commit reads require an installation client"); }
  async getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit> { void input; throw new Error("Commit reads require an installation client"); }
  async getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null> { void input; throw new Error("Reference reads require an installation client"); }
  async listBranches(input: GithubPageInput): Promise<GithubBranchPage> { void input; throw new Error("Branch reads require an installation client"); }
  async listTags(input: GithubPageInput): Promise<GithubTagPage> { void input; throw new Error("Tag reads require an installation client"); }
  async listPullRequests(input: ListPullRequestsInput): Promise<GithubPullRequestPage> { void input; throw new Error("Pull request reads require an installation client"); }
  async listIssues(input: ListIssuesInput): Promise<GithubIssuePage> { void input; throw new Error("Issue reads require an installation client"); }
  async listReleases(input: GithubPageInput): Promise<GithubReleasePage> { void input; throw new Error("Release reads require an installation client"); }

  protected async requestInstallation(installationId: number, route: string, params?: Record<string, unknown>): Promise<GithubRequestResponse> {
    assertGithubEndpointAllowed(route);
    return this.installationRequestLanes.run(installationId, async () => {
      const client = await this.installationClient(installationId);
      return client.request(route, params);
    }, { persistRateLimit: true });
  }
}

export class InstallationGithubClient implements GithubClient {
  constructor(private readonly base: OctokitGithubClient, private readonly installationId: number) {}

  getUser(accessToken: string) { return this.base.getUser(accessToken); }
  exchangeOAuthCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }) { return this.base.exchangeOAuthCode(input); }
  getInstallation(installationId: number) { return this.base.getInstallation(installationId); }

  async listInstallationRepositories(page: number, perPage = DEFAULT_PER_PAGE): Promise<InstallationRepositoryPage> {
    const response = await this.request("GET /installation/repositories", pageParameters(page, perPage));
    const data = z.object({ repositories: z.array(repositorySchema).default([]) }).strip().parse(response.data);
    return nextPageResult({ repositories: data.repositories }, response);
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepository> {
    const response = await this.request("GET /repos/{owner}/{repo}", { owner, repo });
    return repositorySchema.parse(response.data);
  }

  async listCommits(input: ListCommitsInput): Promise<GithubCommitPage> {
    const response = await this.request("GET /repos/{owner}/{repo}/commits", {
      owner: input.owner, repo: input.repo, ...(input.sha ? { sha: input.sha } : {}), ...(input.since ? { since: input.since } : {}), ...pageParameters(input.page, input.perPage),
    });
    const commits = z.array(commitSchema).parse(response.data).map((commit) => toCommit(commit));
    return nextPageResult({ commits }, response);
  }

  async getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit> {
    const response = await this.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner: input.owner, repo: input.repo, ref: input.ref });
    return toCommit(response.data);
  }

  async getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null> {
    const response = await this.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner: input.owner, repo: input.repo, ref: githubRefParameter(input.ref) });
    return z.object({ object: z.object({ sha: z.string() }).strip() }).strip().parse(response.data).object.sha;
  }

  async listBranches(input: GithubPageInput): Promise<GithubBranchPage> {
    const response = await this.request("GET /repos/{owner}/{repo}/branches", { owner: input.owner, repo: input.repo, ...pageParameters(input.page, input.perPage) });
    const branches = z.array(branchSchema).parse(response.data).map((branch) => ({ name: branch.name, headSha: branch.commit.sha, ...(branch.protected !== undefined ? { protected: branch.protected } : {}) }));
    return nextPageResult({ branches }, response);
  }

  async listTags(input: GithubPageInput): Promise<GithubTagPage> {
    const response = await this.request("GET /repos/{owner}/{repo}/tags", { owner: input.owner, repo: input.repo, ...pageParameters(input.page, input.perPage) });
    const tags = z.array(tagSchema).parse(response.data).map((tag) => ({ name: tag.name, targetSha: tag.commit.sha }));
    return nextPageResult({ tags }, response);
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<GithubPullRequestPage> {
    const response = await this.request("GET /repos/{owner}/{repo}/pulls", {
      owner: input.owner, repo: input.repo, state: "all", ...(input.sort ? { sort: input.sort } : {}), ...(input.direction ? { direction: input.direction } : {}), ...pageParameters(input.page, input.perPage),
    });
    const pullRequests = z.array(pullRequestSchema).parse(response.data).map((pullRequest) => toPullRequest(pullRequest));
    return nextPageResult({ pullRequests }, response);
  }

  async listIssues(input: ListIssuesInput): Promise<GithubIssuePage> {
    const response = await this.request("GET /repos/{owner}/{repo}/issues", {
      owner: input.owner, repo: input.repo, state: "all", ...(input.since ? { since: input.since } : {}), ...(input.sort ? { sort: input.sort } : {}),
      ...(input.direction ? { direction: input.direction } : {}), ...pageParameters(input.page, input.perPage),
    });
    const records = z.array(unknownRecordSchema).parse(response.data).filter((issue) => !("pull_request" in issue));
    return nextPageResult({ issues: records.map((issue) => toIssue(issue)) }, response);
  }

  async listReleases(input: GithubPageInput): Promise<GithubReleasePage> {
    const response = await this.request("GET /repos/{owner}/{repo}/releases", { owner: input.owner, repo: input.repo, ...pageParameters(input.page, input.perPage) });
    const releases = z.array(releaseSchema).parse(response.data).map((release) => toRelease(release));
    return nextPageResult({ releases }, response);
  }

  private request(route: string, parameters?: Record<string, unknown>): Promise<GithubRequestResponse> {
    return this.base["requestInstallation"](this.installationId, route, parameters);
  }
}

export function createInstallationGithubClient(base: OctokitGithubClient, installationId: number): InstallationGithubClient {
  return new InstallationGithubClient(base, installationId);
}
