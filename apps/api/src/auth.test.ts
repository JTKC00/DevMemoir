import { describe, expect, it } from "vitest";
import type { AppConfig } from "@devmemoir/config";
import { InMemoryM1Store } from "@devmemoir/db";
import type { GithubClient } from "@devmemoir/github";
import { AuthService, AuthFlowError } from "./auth.js";

const config: AppConfig = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://unused",
  DATABASE_API_URL: "postgres://unused",
  DATABASE_WORKER_URL: "postgres://unused",
  DATABASE_QUEUE_URL: "postgres://unused",
  DATABASE_MIGRATIONS_URL: "postgres://unused",
  DATABASE_DIRECT_URL: "postgres://unused",
  DATABASE_POOL_MAX: 2,
  GITHUB_APP_ID: 1,
  GITHUB_APP_CLIENT_ID: "client",
  GITHUB_APP_CLIENT_SECRET: "secret",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_WEBHOOK_SECRET: "current-secret-123456",
  GITHUB_API_VERSION: "2022-11-28",
  OWNER_GITHUB_USER_ID: 7,
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  SESSION_SECRET: "session-secret-that-is-at-least-32-bytes-long",
  AUTH_TRANSACTION_TTL_SECONDS: 60,
  HANDOFF_TTL_SECONDS: 60,
  SESSION_TTL_SECONDS: 3600,
  CSRF_HEADER: "x-devmemoir-csrf",
  PORT: 4000,
  HOST: "127.0.0.1",
};

function githubFor(id = 7): GithubClient {
  return {
    getUser: async () => ({ id, login: id === 7 ? "owner" : "intruder", type: "User" }),
    exchangeOAuthCode: async () => ({ accessToken: "access-token" }),
    getInstallation: async () => ({ id: 22, account: { id: 7, login: "owner", type: "User" } }),
    listInstallationRepositories: async () => ({ repositories: [] }),
    getRepository: async () => ({ id: 10, name: "repo", full_name: "owner/repo", private: true, default_branch: "main", owner: { login: "owner" } }),
    listCommits: async () => ({ commits: [] }),
    listBranches: async () => ({ branches: [] }),
    listTags: async () => ({ tags: [] }),
    listPullRequests: async () => ({ pullRequests: [] }),
    listIssues: async () => ({ issues: [] }),
    listReleases: async () => ({ releases: [] }),
    getCommit: async () => ({ repositoryId: "", sha: "a".repeat(40), message: "", parents: [] }),
    getRefHead: async () => "a".repeat(40),
  };
}

describe("M1 authentication", () => {
  it("persists single-use state and handoff and rejects replay", async () => {
    const store = new InMemoryM1Store();
    const auth = new AuthService(config, store, githubFor());
    const started = await auth.startLogin("/connect");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const completed = await auth.completeLogin({ code: "code", state: state as string });
    await expect(auth.completeLogin({ code: "code", state: state as string })).rejects.toMatchObject({ statusCode: 400 });
    const exchanged = await auth.exchangeHandoff(completed.handoffCode);
    expect(exchanged.user.githubAccountId).toBe(7);
    await expect(auth.exchangeHandoff(completed.handoffCode)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects invalid return paths, expired state, and non-allowlisted users", async () => {
    const store = new InMemoryM1Store();
    const auth = new AuthService(config, store, githubFor());
    await expect(auth.startLogin("//evil.example")).rejects.toBeInstanceOf(AuthFlowError);
    const now = { value: new Date("2026-01-01T00:00:00Z") };
    const expiringAuth = new AuthService(config, store, githubFor(), () => now.value);
    const started = await expiringAuth.startLogin();
    const state = new URL(started.authorizationUrl).searchParams.get("state") as string;
    now.value = new Date("2026-01-01T00:02:00Z");
    await expect(expiringAuth.completeLogin({ code: "code", state })).rejects.toMatchObject({ statusCode: 400 });
    const intruder = new AuthService(config, new InMemoryM1Store(), githubFor(8));
    const login = await intruder.startLogin();
    const intruderState = new URL(login.authorizationUrl).searchParams.get("state") as string;
    await expect(intruder.completeLogin({ code: "code", state: intruderState })).rejects.toMatchObject({ statusCode: 403 });
  });
});
