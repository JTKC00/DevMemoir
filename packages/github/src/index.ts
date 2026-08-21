import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { CommitFact, GithubActor } from "@devmemoir/domain";
import { actorKindFromGithub } from "@devmemoir/domain";
import { z } from "zod";

export const API_VERSION = "2022-11-28";

/**
 * GitHub's GET /git/ref/:ref route takes `heads/<branch>` (or
 * `tags/<tag>`), not the display-only branch name and not the fully
 * qualified `refs/heads/<branch>` value returned in API responses.
 */
export function githubRefParameter(ref: string): string {
  const normalized = ref.replace(/^refs\//, "");
  if (normalized.startsWith("heads/") || normalized.startsWith("tags/")) return normalized;
  return `heads/${normalized}`;
}

const ALLOWED_ENDPOINTS = new Set([
  "GET /installation/repositories",
  "GET /app/installations/{installation_id}",
  "GET /repos/{owner}/{repo}",
  "GET /repos/{owner}/{repo}/languages",
  "GET /repos/{owner}/{repo}/topics",
  "GET /repos/{owner}/{repo}/branches",
  "GET /repos/{owner}/{repo}/commits",
  "GET /repos/{owner}/{repo}/commits/{ref}",
  "GET /repos/{owner}/{repo}/git/ref/{ref}",
  "GET /user",
  "POST /login/oauth/access_token",
]);

export class GithubEndpointDeniedError extends Error {
  constructor(endpoint: string) {
    super(`GitHub endpoint denied by M1 permit-list: ${endpoint}`);
    this.name = "GithubEndpointDeniedError";
  }
}

export function assertGithubEndpointAllowed(endpoint: string): void {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new GithubEndpointDeniedError(endpoint);
}

export function stripCompareFiles<T extends { files?: Array<Record<string, unknown>> }>(response: T): Omit<T, "files"> & { files?: Array<Record<string, unknown>> } {
  if (!response.files) return response;
  return {
    ...response,
    files: response.files.map(() => ({})),
  };
}

const userSchema = z.object({ id: z.number().int().positive(), login: z.string(), type: z.string().optional() }).strip();
const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive(), login: z.string().optional(), type: z.string() }).strip(),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string()).optional(),
}).strip();
const repositorySchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().optional(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string().optional() }).strip().optional(),
  private: z.boolean(),
  visibility: z.string().optional(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
  description: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
}).strip();

type Requester = {
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown; headers?: Record<string, string | number | undefined> }>;
};

export type GithubUser = { id: number; login: string; type?: string | undefined };
export type GithubInstallation = z.infer<typeof installationSchema>;
export type GithubRepository = z.infer<typeof repositorySchema>;
export type GithubCommit = CommitFact & { htmlUrl?: string };

export type InstallationRepositoryPage = {
  repositories: GithubRepository[];
  nextPage?: number;
};

export interface GithubClient {
  getUser(accessToken: string): Promise<GithubUser>;
  exchangeOAuthCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }): Promise<{ accessToken: string }>;
  getInstallation(installationId: number): Promise<GithubInstallation>;
  listInstallationRepositories(page: number, perPage?: number): Promise<InstallationRepositoryPage>;
  getRepository(owner: string, repo: string): Promise<GithubRepository>;
  listCommits(input: { owner: string; repo: string; sha?: string; page?: number; perPage?: number }): Promise<{ commits: GithubCommit[]; nextPage?: number }>;
  getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit>;
  getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null>;
}

function toActor(raw: { id?: number | null; login?: string | null; type?: string | null } | null | undefined): GithubActor | undefined {
  if (!raw?.id) return undefined;
  return { githubAccountId: raw.id, ...(raw.login ? { login: raw.login } : {}), ...(raw.type ? { accountType: raw.type } : {}), actorKind: actorKindFromGithub(raw) };
}

function toCommit(raw: Record<string, any>): GithubCommit {
  const author = toActor(raw.author);
  const committer = toActor(raw.committer);
  const commit = raw.commit ?? {};
  const authorDate = commit.author?.date ? new Date(commit.author.date) : undefined;
  const committerDate = commit.committer?.date ? new Date(commit.committer.date) : undefined;
  return {
    repositoryId: "",
    sha: String(raw.sha),
    ...(author ? { author } : {}),
    ...(committer ? { committer } : {}),
    message: String(commit.message ?? ""),
    ...(authorDate && !Number.isNaN(authorDate.getTime()) ? { authoredAt: authorDate } : {}),
    ...(committerDate && !Number.isNaN(committerDate.getTime()) ? { committedAt: committerDate } : {}),
    parents: Array.isArray(raw.parents) ? raw.parents.map((parent: { sha?: string }) => String(parent.sha ?? "")) : [],
    ...(raw.commit?.verification?.verified !== undefined ? { verified: Boolean(raw.commit.verification.verified) } : {}),
    ...(typeof raw.stats?.additions === "number" ? { additions: raw.stats.additions } : {}),
    ...(typeof raw.stats?.deletions === "number" ? { deletions: raw.stats.deletions } : {}),
    ...(typeof raw.html_url === "string" ? { htmlUrl: raw.html_url } : {}),
  };
}

export class OctokitGithubClient implements GithubClient {
  private readonly app: App;
  private readonly apiVersion: string;
  private readonly installationClients = new Map<number, Requester>();

  constructor(input: { appId: number; privateKey: string; apiVersion?: string; webhookSecret?: string }) {
    this.apiVersion = input.apiVersion ?? API_VERSION;
    this.app = new App({ appId: input.appId, privateKey: input.privateKey, ...(input.webhookSecret ? { webhooks: { secret: input.webhookSecret } } : {}) });
  }

  private async installationClient(installationId: number): Promise<Requester> {
    const existing = this.installationClients.get(installationId);
    if (existing) return existing;
    const client = await this.app.getInstallationOctokit(installationId);
    const requester: Requester = { request: (route, parameters) => client.request(route, { ...parameters, headers: { ...(parameters?.headers as Record<string, string> | undefined), "X-GitHub-Api-Version": this.apiVersion } }) };
    this.installationClients.set(installationId, requester);
    return requester;
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
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
    });
    if (!response.ok) throw new Error(`GitHub OAuth exchange failed: ${response.status}`);
    const body = (await response.json()) as { access_token?: string; error?: string };
    if (!body.access_token) throw new Error(`GitHub OAuth exchange failed: ${body.error ?? "missing token"}`);
    return { accessToken: body.access_token };
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    assertGithubEndpointAllowed("GET /app/installations/{installation_id}");
    const response = await this.app.octokit.request("GET /app/installations/{installation_id}", { installation_id: installationId, headers: { "X-GitHub-Api-Version": this.apiVersion } });
    return installationSchema.parse(response.data);
  }

  async listInstallationRepositories(page: number, perPage = 100): Promise<InstallationRepositoryPage> {
    // Installation repository inventory is called with an installation client in production.
    // The explicit method below is overridden by createInstallationGithubClient.
    throw new Error(`Installation repository listing requires createInstallationGithubClient (page ${page}, perPage ${perPage})`);
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepository> {
    throw new Error(`Use createInstallationGithubClient for repository reads: ${owner}/${repo}`);
  }

  async listCommits(input: { owner: string; repo: string; sha?: string; page?: number; perPage?: number }): Promise<{ commits: GithubCommit[]; nextPage?: number }> {
    throw new Error(`Use createInstallationGithubClient for commit reads: ${input.owner}/${input.repo}`);
  }

  async getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit> {
    throw new Error(`Use createInstallationGithubClient for commit reads: ${input.owner}/${input.repo}@${input.ref}`);
  }

  async getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null> {
    throw new Error(`Use createInstallationGithubClient for ref reads: ${input.owner}/${input.repo}:${input.ref}`);
  }

  protected async requestInstallation(installationId: number, route: string, params?: Record<string, unknown>) {
    const client = await this.installationClient(installationId);
    return client.request(route, params);
  }
}

export class InstallationGithubClient implements GithubClient {
  constructor(private readonly base: OctokitGithubClient, private readonly installationId: number) {}

  getUser(accessToken: string) { return this.base.getUser(accessToken); }
  exchangeOAuthCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }) { return this.base.exchangeOAuthCode(input); }
  getInstallation(installationId: number) { return this.base.getInstallation(installationId); }

  async listInstallationRepositories(page: number, perPage = 100): Promise<InstallationRepositoryPage> {
    assertGithubEndpointAllowed("GET /installation/repositories");
    const response = await this.base["requestInstallation"](this.installationId, "GET /installation/repositories", { page, per_page: perPage });
    const data = z.object({ repositories: z.array(repositorySchema).default([]) }).strip().parse(response.data);
    const link = String(response.headers?.link ?? "");
    const nextPage = /[?&]page=(\d+)>; rel="next"/.exec(link)?.[1];
    return { repositories: data.repositories, ...(nextPage ? { nextPage: Number(nextPage) } : {}) };
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepository> {
    assertGithubEndpointAllowed("GET /repos/{owner}/{repo}");
    const response = await this.base["requestInstallation"](this.installationId, "GET /repos/{owner}/{repo}", { owner, repo });
    return repositorySchema.parse(response.data);
  }

  async listCommits(input: { owner: string; repo: string; sha?: string; page?: number; perPage?: number }): Promise<{ commits: GithubCommit[]; nextPage?: number }> {
    assertGithubEndpointAllowed("GET /repos/{owner}/{repo}/commits");
    const response = await this.base["requestInstallation"](this.installationId, "GET /repos/{owner}/{repo}/commits", { owner: input.owner, repo: input.repo, ...(input.sha ? { sha: input.sha } : {}), page: input.page ?? 1, per_page: input.perPage ?? 100 });
    const commits = z.array(z.record(z.unknown())).parse(response.data).map((commit) => toCommit(commit));
    const link = String(response.headers?.link ?? "");
    const nextPage = /[?&]page=(\d+)>; rel="next"/.exec(link)?.[1];
    return { commits, ...(nextPage ? { nextPage: Number(nextPage) } : {}) };
  }

  async getCommit(input: { owner: string; repo: string; ref: string }): Promise<GithubCommit> {
    assertGithubEndpointAllowed("GET /repos/{owner}/{repo}/commits/{ref}");
    const response = await this.base["requestInstallation"](this.installationId, "GET /repos/{owner}/{repo}/commits/{ref}", { owner: input.owner, repo: input.repo, ref: input.ref });
    return toCommit(z.record(z.unknown()).parse(response.data));
  }

  async getRefHead(input: { owner: string; repo: string; ref: string }): Promise<string | null> {
    assertGithubEndpointAllowed("GET /repos/{owner}/{repo}/git/ref/{ref}");
    try {
      const response = await this.base["requestInstallation"](this.installationId, "GET /repos/{owner}/{repo}/git/ref/{ref}", { owner: input.owner, repo: input.repo, ref: githubRefParameter(input.ref) });
      const data = z.object({ object: z.object({ sha: z.string() }).strip() }).strip().parse(response.data);
      return data.object.sha;
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return null;
      throw error;
    }
  }
}

export function createInstallationGithubClient(base: OctokitGithubClient, installationId: number): InstallationGithubClient {
  return new InstallationGithubClient(base, installationId);
}
