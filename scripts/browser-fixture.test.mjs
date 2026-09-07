import assert from "node:assert/strict";
import { after, test } from "node:test";
import { app, store, runPrivacyWorker } from "./browser-fixture.mjs";

after(async () => { await app.close(); });
const localPath = (url) => { const parsed = new URL(url, "http://localhost:4100"); return parsed.pathname + parsed.search; };

test("synthetic owner journey covers login, import, filters, logout, disconnect and account deletion", async () => {
  const start = await app.inject("/auth/github/start?returnPath=/");
  const authorize = await app.inject(localPath(start.headers.location));
  const callback = await app.inject(localPath(authorize.headers.location));
  const handoff = new URL(callback.headers.location);
  assert.equal(handoff.pathname, "/auth/handoff");
  const code = handoff.searchParams.get("code");
  const exchange = await app.inject({ method: "POST", url: "/auth/handoff/exchange", payload: { code } });
  assert.equal(exchange.statusCode, 200);
  const { sessionToken, csrfToken } = exchange.json();
  const headers = { authorization: `Bearer ${sessionToken}`, "x-devmemoir-csrf": csrfToken };
  assert.equal((await app.inject({ url: "/api/activity", headers })).json().repository, undefined);
  assert.equal((await app.inject({ method: "POST", url: "/auth/handoff/exchange", payload: { code } })).statusCode, 400);

  const connect = await app.inject({ method: "POST", url: "/connect/start", headers });
  assert.equal(connect.statusCode, 200);
  const install = await app.inject(localPath(connect.json().installationUrl));
  const setup = await app.inject(localPath(install.headers.location));
  assert.equal(setup.statusCode, 302);
  const inventory = (await app.inject({ url: "/connect/repositories", headers })).json();
  assert.equal(inventory.repositories.length, 1);
  const repositoryId = inventory.repositories[0].id;
  assert.equal(inventory.repositories[0].selected, false);
  assert.equal((await app.inject({ method: "POST", url: "/connect/repository", headers, payload: { repositoryId } })).statusCode, 201);
  assert.equal((await app.inject({ url: "/api/activity", headers })).json().historical.status, "pending");

  assert.equal((await app.inject({ method: "POST", url: "/__fixture/import" })).statusCode, 302);
  const activity = (await app.inject({ url: "/api/activity", headers })).json();
  assert.equal(activity.historical.status, "completed");
  assert.deepEqual(activity.events.map((event) => event.sourceKind), ["commit", "pull_request"]);
  assert.equal(activity.events[0].message, "Add daily activity groups");
  assert.equal(activity.events[1].title, "Improve activity navigation");
  assert.equal((await app.inject({ url: "/api/activity?context=project", headers })).json().events.length, 0);
  assert.ok((await app.inject({ url: "/api/activity?context=personal", headers })).json().events.length >= 2);
  await app.inject({ method: "POST", url: "/__fixture/outage" });
  assert.equal((await app.inject({ url: "/api/activity", headers })).statusCode, 503);
  await app.inject({ method: "POST", url: "/__fixture/outage" });

  assert.equal((await app.inject({ method: "POST", url: "/connect/repository/unselect", headers, payload: { repositoryId } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/activity", headers })).json().repository, undefined);
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers })).statusCode, 204);
  assert.equal((await app.inject({ url: "/auth/session", headers })).statusCode, 401);
  const startAgain = await app.inject("/auth/github/start?returnPath=/");
  const authorizeAgain = await app.inject(localPath(startAgain.headers.location));
  const callbackAgain = await app.inject(localPath(authorizeAgain.headers.location));
  const exchangeAgain = await app.inject({ method: "POST", url: "/auth/handoff/exchange", payload: { code: new URL(callbackAgain.headers.location).searchParams.get("code") } });
  const next = exchangeAgain.json();
  const nextHeaders = { authorization: `Bearer ${next.sessionToken}`, "x-devmemoir-csrf": next.csrfToken };
  assert.equal((await app.inject({ method: "POST", url: "/connect/disconnect", headers: { authorization: nextHeaders.authorization } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/connect/disconnect", headers: nextHeaders })).statusCode, 204);
  assert.equal((await app.inject({ url: "/api/activity", headers: nextHeaders })).json().events.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/account/delete", headers: nextHeaders })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/account/delete", headers: { authorization: nextHeaders.authorization }, payload: { confirm: "delete_account" } })).statusCode, 403);
  const deletion = await app.inject({ method: "POST", url: "/account/delete", headers: nextHeaders, payload: { confirm: "delete_account" } });
  assert.equal(deletion.statusCode, 202);
  assert.equal(deletion.json().liveData, "pending_purge");
  assert.equal((await app.inject({ url: "/auth/session", headers: nextHeaders })).statusCode, 401);
  assert.equal((await app.inject("/auth/github/start")).statusCode, 403);
  assert.equal((await store.listPendingAccountDeletions(100)).length, 1);
  await runPrivacyWorker();
  await runPrivacyWorker();
  assert.equal((await store.listPendingAccountDeletions(100)).length, 0);
  assert.equal(store.commits.size, 0);
  assert.equal(store.events.length, 0);
  assert.equal(store.repositories.size, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal((await app.inject("/auth/github/start")).statusCode, 403);

});
