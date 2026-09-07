/** Local-only browser fixture: real API/worker paths, synthetic GitHub and in-memory storage. */
import { pathToFileURL } from "node:url";
import { buildApi } from "../apps/api/dist/app.js";
import { processQueueJob } from "../apps/worker/dist/jobs.js";
import { loadConfig } from "../packages/config/dist/index.js";
import { InMemoryM1Store } from "../packages/db/dist/index.js";
import { InMemoryJobPort } from "../packages/jobs/dist/index.js";
import { createLogger } from "../packages/observability/dist/index.js";

if (process.env.NODE_ENV === "production") throw new Error("Browser fixture cannot run in production");
const apiOrigin = "http://localhost:4100";
const webOrigin = "http://localhost:3100";
const config = loadConfig({
  NODE_ENV: "test", DATABASE_URL: "postgres://unused", API_ORIGIN: apiOrigin, WEB_ORIGIN: webOrigin,
  GITHUB_APP_ID: "1", GITHUB_APP_CLIENT_ID: "fixture-client", GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
  GITHUB_APP_PRIVATE_KEY: "fixture-unused", GITHUB_WEBHOOK_SECRET: "fixture-webhook-secret", OWNER_GITHUB_USER_ID: "7",
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"), SESSION_SECRET: "fixture-session-secret-at-least-32-characters",
});
export const store = new InMemoryM1Store();
const jobs = new InMemoryJobPort();
const logger = createLogger(() => {});
const repository = { id: 10, name: "browser-demo", full_name: "fixture-owner/browser-demo", private: true, default_branch: "main", owner: { login: "fixture-owner" } };
const owner = { id: 7, login: "fixture-owner", type: "User" };
const sha = "a".repeat(40);
const github = {
  getUser: async () => owner,
  exchangeOAuthCode: async () => ({ accessToken: "fixture-only" }),
  getInstallation: async () => ({ id: 22, account: owner }),
  listInstallationRepositories: async () => ({ repositories: [repository] }),
  getRepository: async () => repository,
  getRefHead: async () => sha,
  listCommits: async () => ({ commits: [await github.getCommit()] }),
  getCommit: async () => ({ repositoryId: "", sha, message: "Add daily activity groups", parents: [], author: { githubAccountId: 7, actorKind: "human" }, committer: { githubAccountId: 7, actorKind: "human" }, committedAt: new Date("2026-09-07T03:00:00Z"), authoredAt: new Date("2026-09-07T03:00:00Z") }),
  listBranches: async () => ({ branches: [{ name: "main", headSha: sha }] }),
  listTags: async () => ({ tags: [] }),
  listPullRequests: async () => ({ pullRequests: [{ id: 100, number: 1, title: "Improve activity navigation", state: "closed", author: { githubAccountId: 7, actorKind: "human" }, mergedBy: { githubAccountId: 7, actorKind: "human" }, baseRef: "main", baseSha: sha, headRef: "feature", headSha: sha, createdAt: new Date("2026-09-06T01:00:00Z"), updatedAt: new Date("2026-09-06T03:00:00Z"), closedAt: new Date("2026-09-06T03:00:00Z"), mergedAt: new Date("2026-09-06T03:00:00Z") }] }),
  listIssues: async () => ({ issues: [] }),
  listReleases: async () => ({ releases: [] }),
};
const deps = { config, store, jobs, github, githubForInstallation: () => github, installationGithub: () => github, logger };
export const app = await buildApi(deps);
export const runPrivacyWorker = () => processQueueJob({ id: "fixture-privacy", kind: "privacy_payload_purge", logicalKey: "fixture-privacy", payload: {} }, deps);
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));
let unavailable = false;
let importEnabled = false;
let draining;
async function drain() {
  if (draining) return draining;
  draining = (async () => {
    for (let iteration = 0; iteration < 100; iteration++) {
      const job = [...jobs.jobs.values()].find((item) => importEnabled || item.kind === "installation_inventory");
      if (!job) return;
      jobs.jobs.delete(job.id);
      await processQueueJob(job, deps);
    }
    throw new Error("Fixture queue did not settle");
  })();
  try { await draining; } finally { draining = undefined; }
}
app.addHook("onRequest", async (request, reply) => {
  if (unavailable && request.url.startsWith("/api/activity")) return reply.code(503).send({ error: "fixture_unavailable" });
});
app.addHook("onSend", async (request, reply, payload) => {
  // Replace only GitHub's external UI in this isolated fixture. API auth, state,
  // handoff and installation ownership checks still run unchanged.
  if (request.url.startsWith("/auth/github/start")) {
    const location = reply.getHeader("location");
    if (typeof location === "string") {
      const original = new URL(location);
      reply.header("location", `${apiOrigin}/__fixture/github-authorize?${original.searchParams}`);
    }
  }
  if (request.url === "/connect/start" && typeof payload === "string" && reply.statusCode === 200) {
    const result = JSON.parse(payload);
    const original = new URL(result.installationUrl);
    return JSON.stringify({ installationUrl: `${apiOrigin}/__fixture/github-install?${original.searchParams}` });
  }
  return payload;
});
app.addHook("onResponse", async () => { await drain(); });
app.get("/__fixture", async (_request, reply) => reply.type("text/html").send(`<!doctype html><html lang="en"><title>DevMemoir synthetic browser controls</title><h1>Synthetic browser controls</h1><p>In-memory data only. GitHub calls are synthetic.</p><p>Import enabled: ${importEnabled}. Activity outage: ${unavailable}. Queued jobs: ${jobs.jobs.size}.</p><a href="${webOrigin}">Open DevMemoir</a><form method="post" action="/__fixture/import"><button>Finish synthetic import</button></form><form method="post" action="/__fixture/expire"><button>Expire synthetic sessions</button></form><form method="post" action="/__fixture/outage"><button>Toggle activity outage</button></form></html>`));
app.get("/__fixture/github-authorize", async (request, reply) => {
  const query = new URL(request.url, apiOrigin).searchParams;
  const callback = new URL("/auth/github/callback", apiOrigin);
  callback.searchParams.set("code", "synthetic-code");
  callback.searchParams.set("state", query.get("state") ?? "");
  return reply.redirect(callback.toString());
});
app.get("/__fixture/github-install", async (request, reply) => {
  const state = new URL(request.url, apiOrigin).searchParams.get("state") ?? "";
  return reply.redirect(`${apiOrigin}/github/setup?${new URLSearchParams({ state, installation_id: "22", setup_action: "install" })}`);
});
app.post("/__fixture/import", async (_request, reply) => { importEnabled = true; await drain(); return reply.redirect("/__fixture"); });
app.post("/__fixture/expire", async (_request, reply) => { for (const session of store.sessions.values()) session.expiresAt = new Date(0); return reply.redirect("/__fixture"); });
app.post("/__fixture/outage", async (_request, reply) => { unavailable = !unavailable; return reply.redirect("/__fixture"); });
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await app.listen({ host: "127.0.0.1", port: 4100 });
  console.log("Synthetic API ready at http://localhost:4100/__fixture; use WEB_ORIGIN=http://localhost:3100 API_ORIGIN=http://localhost:4100 for the web app.");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await app.close(); process.exit(0); });
}
