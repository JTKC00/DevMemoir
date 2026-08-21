# DevMemoir — Adversarial Architecture Review

**Reviewer:** Grok (adversarial architect / security reviewer)  
**Date:** 2026-08-21  
**Scope reviewed:** `docs/architecture/DEV_MEMOIR_ARCHITECTURE.md`, `docs/architecture/IMPLEMENTATION_PLAN.md`, `docs/architecture/adr/0001`–`0007`  
**Production code:** not modified. Implementation not started.

This review attacks the current proposal. Where a Codex decision is correct, it is defended. Where it is not, the failure mode is concrete.

---

## Executive Verdict

**GO WITH CONDITIONS**

Option B is still the right architecture. Fastify, PostgreSQL, pg-boss, a real GitHub App, durable webhook receipt, and `tenant_id` on every private table are justified. The proposal does **not** need a redesign.

It is **not** a clean GO. Several assumptions about GitHub webhook identity, onboarding, commit ingestion, and the product question “what have I been building?” are wrong or underspecified. If Milestone 1 is coded from the implementation plan as written, it will encode those mistakes and later look like a rewrite.

Do not begin Milestone 1 until the conditions in [Recommended Changes Before Milestone 1](#recommended-changes-before-milestone-1) are written into the architecture/ADR/plan. None of those conditions require a new stack.

---

## Top Findings

1. **The product question and the data plane are not the same thing.** Installation tokens can only see repositories the App is installed on. That is not “everything this developer built on GitHub.”
2. **Default-branch history plus squash/rebase/force-push cannot reconstruct personal work.** The completeness boundary is real; the UI does not yet treat it as a product contract.
3. **`X-GitHub-Delivery` identifies the event, not a successful processing attempt.** Treating GUID existence as “already done” drops failed deliveries that GitHub redelivers with the same GUID.
4. **Milestone 1 can be “passed” by ingesting the `push` payload’s commit array.** That path is not the production path and silently loses commits beyond GitHub’s payload cap.
5. **Login, installation, and session cookies are split across Next.js and Fastify with no binding design.** Combined with GitHub’s “Request user authorization during installation” footgun, this is the most likely M1 onboarding failure.
6. **`github_identities` uniqueness is `(user_id, github_account_id)`.** That allows one GitHub account to attach to multiple DevMemoir users.
7. **`compare` is both recommended for range sync and banned as a patch source.** The GitHub compare endpoint returns `files[].patch` under Contents read.
8. **pg-boss on Neon is fine only on a direct connection.** Neon’s pooler is transaction-mode PgBouncer: `LISTEN/NOTIFY` does not work. The hosting ADR never says this.
9. **Privacy hardening is a Gate A requirement but is scheduled as Milestone 6.** Sentry/OTel will leak private commit messages unless redaction exists in the first slice.
10. **The event model stores both facts and implied contributions in one table.** Without a mandatory `contribution_role` / “personal vs project context” filter in the default timeline, Chronicle output will double-count merges and include collaborators/bots.

---

## Blockers

These are the only items that should halt **coding** of Milestone 1. They are documentation/design decisions, not stack changes.

### B1. Webhook GUID is a receipt key, not a success key — BLOCKER

**Evidence.** Current GitHub docs: `X-GitHub-Delivery` is “a globally unique identifier (GUID) **to identify the event**.” GitHub’s own failed-delivery script consolidates by `guid` because “the GUID is constant across redeliveries of the same delivery.” Redelivery rows share `guid` and differ by numeric `id` / `redelivery: true`. ADR 0004 and §6 say a duplicate delivery returns 2xx **without adding another job**.

**Failure.** Worker poisons a payload and dead-letters it. Six-hour audit or manual “Redeliver” sends the same GUID. Handler sees the unique row and returns 202. Nothing is re-enqueued. Milestone 1 has **no reconciliation**, so the owner’s timeline is missing that push until Milestone 5. The M1 test “replaying the same delivery creates no second job” will lock in the bug if it only covers the success path.

**Correction.** `github_delivery_guid` unique remains. On insert conflict:

- `processed` / `ignored` → 2xx, no new job.
- `received` / `processing` / `failed` / `dead_letter` → 2xx, **resume or re-enqueue** the existing row.

Replay tests must include the failed-then-redelivered path.

**ADR:** amend 0004.

### B2. Milestone 1 must not persist commits from the `push` payload — BLOCKER

**Evidence.** Architecture §6 already says push is a change signal and the worker should enqueue an authoritative range/head sync. Implementation Plan Milestone 1 does not say that. It can be satisfied by mapping `payload.commits[]` into `commits`. GitHub push payloads cap the commits array (docs historically say 20 for timeline-shaped payloads; webhook deliveries can carry more, but they are still not a complete history). `before` / `after` / `forced` / `ref` are the useful fields.

**Failure.** Owner force-pushes 40 commits, or merges a large branch. M1 shows ~20 commits and a green “new push appears within two minutes.” That is false completeness. The later “real” worker that compares `before...after` is a second ingestion path.

**Correction.** M1 worker on `push`: verify signature → store delivery → enqueue `sync_commits(repository_id, ref, before, after, forced)`. Persist commits only from `GET /repos/.../commits` (and optionally compare **stripped of patches**). If `forced` or `after` is a zero SHA (branch delete), do not invent history from the payload array.

**ADR:** amend 0004; amend Implementation Plan Milestone 1.

### B3. Auth and session topology across two HTTP apps is unspecified — BLOCKER

**Evidence.** ADR 0001 puts browser sessions on Next.js and OAuth/App callbacks on Fastify. ADR 0003 does not specify cookie domain, SameSite, CSRF, PKCE storage, or the GitHub App checkbox **Request user authorization (OAuth) during installation**. GitHub documents that when that checkbox is on, GitHub starts the OAuth flow after install and **does not return `state`**. Reinstall/update often does not hit the setup URL at all.

**Failure.** Owner clicks “Continue with GitHub,” then “Install.” Callback lands on `api.` with a session cookie that `web.` cannot read. Or the App setting is left on, `state` is missing, and the setup callback is rejected. Or the owner installs from the GitHub App page with no `state` and no session, and DevMemoir cannot claim the `installation_id` safely.

**Correction.** Before M1 code:

1. Turn **off** “Request user authorization (OAuth) during installation.” Login and install stay separate, as ADR 0003 intends.
2. Require PKCE (`S256`). GitHub has supported it for GitHub Apps since 2025-07-14; do not write “where supported.”
3. Pick one session design: parent-domain cookie, or Fastify callback that issues a one-time code the Next.js origin exchanges. Write it down.
4. Installation start URL always includes signed `state`. Setup callback with valid session + `installation_id` must call `GET /app/installations/{id}` and require `account.type == User` and `account.id == signed-in github_account_id` for v0.1.
5. GitHub-originated install (no `state`): require an already-authenticated session and the same account check; do not bind an installation to whoever hits the URL.

**ADR:** amend 0001 and 0003.

---

## GitHub Integration Findings

### G1. Permissions are sufficient and Contents is unavoidably broad — keep, with a sharper allowlist — HIGH

Metadata, Contents, Pull requests, and Issues **read** are the correct v0.1 set. Commit listing, refs, tags, and releases require Contents read. PR listing requires Pull requests read. Issue listing requires Issues read (and the issues endpoint returns PR-shaped objects, which the plan correctly filters).

Contents read **does** allow blob, archive, contents, and compare-with-patch. That is a GitHub limitation, not a mistaken permission request. Do not drop Contents.

**Correction.** The adapter allowlist must be an explicit permit-list, not a deny-list. Permit: installation repositories, repo metadata, languages, topics, branches, tags, commits list/get (JSON, not `application/vnd.github.diff` / `.patch`), pulls, issues, releases, compare **only if** `files[].patch` is discarded before any log or persist. Deny: `/contents`, `/git/blobs`, `/zipball`, `/tarball`, media-type diffs, file contents, clones.

Do not call compare as a convenience if list-commits from `after` until `before` is enough. Compare is the easiest way to accidentally hold private source in memory.

**ADR:** amend 0003.

### G2. Login vs installation is correctly split; the GitHub App settings can still merge them — HIGH

The credential model in §5 is right: user authorization proves the human; installation is the repo grant; installation tokens are one-hour, not stored.

The undocumented settings that break that model:

| GitHub App setting | Required v0.1 value | If wrong |
|---|---|---|
| Request user authorization during installation | **Off** | `state` dropped; login and install collapse |
| Callback URL vs Setup URL | Distinct; login → callback, install → setup | One handler has to parse both `code` and `installation_id` |
| Redirect on update | On, plus a fallback poll of `GET /user/installations` | Permission changes never return to DevMemoir |
| User-to-server token expiration | On | Long-lived user tokens you do not want to store |

v0.1 should **not** persist user access/refresh tokens unless a user-scoped API is required. Installation tokens are enough for repo reads. If user tokens are not stored, `github_user_credentials` can wait.

### G3. `github_app_authorization` is not optional and cannot be unsubscribed — MEDIUM

GitHub delivers `github_app_authorization` / `revoked` to every App that uses user authorization. You cannot unsubscribe. If the webhook handler rejects unknown events with 4xx, GitHub records failures for an event you will always receive. If you later store refresh tokens and ignore this event, you keep calling with revoked credentials.

**Correction.** Handle `ping` and `github_app_authorization` in M1: 2xx, no domain mutation besides “drop any stored user tokens / optionally invalidate the app session if you choose.” Do not 4xx unknown **event types** that GitHub still sends (`ping`, `installation`, `meta` if subscribed). Unknown **actions** on subscribed events can be `ignored`.

### G4. Installation ownership is not “the signed-in user is the installation account” once orgs exist — MEDIUM

For v0.1 the check `installation.account.id == user.github_account_id` is correct and should reject org installs. Document that. The future org model is **not** “bind installation to installer”: an org installation’s `account` is the org, `requester` is the human, and multiple DevMemoir users may need membership rather than ownership. The current `github_installations.github_installation_id UNIQUE` (global) is correct — one GitHub installation is one row — but it means an org install cannot be copied into two tenants. That is the right privacy call; org support will be membership on one tenant or a new org-tenant, not two installation rows.

### G5. Repository selection, transfer, and 404/403 handling are directionally right — keep

Numeric `github_repository_id` as identity, name history, 403/404 → inventory before delete, suspend → stop minting tokens: keep all of these. Add `installation_target` (account rename) to the later webhook list; it is cheap and avoids a class of “owner_login is stale” bugs. Transfer out of the installation as `detached` is correct.

### G6. Failed-delivery audit credentials are App JWT, not installation tokens — MEDIUM

`GET /app/hook/deliveries` and `POST /app/hook/deliveries/{id}/attempts` require a GitHub App JWT. They do not work with installation tokens. The worker that runs the 6-hour audit must have App-JWT minting, which is the same privilege as the private key. That is acceptable, but it is a second use of the most powerful secret. Do not put this job on a “user token” path. Pagination of deliveries is newest-first; stop when `delivered_at` is older than the cursor. Only redeliver GUIDs with no successful attempt.

---

## Data Integrity & Historical Completeness Findings

### H1. v0.1 cannot answer “what have I been building?” — HIGH

**Evidence.** Collection uses installation access tokens. A GitHub App installation on a user account can only read repositories owned by that account that were selected. It cannot read:

- PRs the owner opened on other people’s repositories (including almost all open source).
- Commits the owner authored in org repos unless the org installs the App (out of v0.1, and the owner may lack install permission).
- Private repos the owner can push to as a collaborator on someone else’s personal account.

The public Events API is not a substitute (90 days, public only, low volume).

**Failure.** A developer whose real work is company orgs plus OSS pull requests connects personal side projects and sees a memoir of weekend repos. They believe the product is complete. Future AI Chronicle will narrate the side projects as the career.

**Correction.** Replace the v0.1 promise with:

> DevMemoir records what happened in **repositories you connected**, not every contribution your GitHub user has ever made.

Keep the longer-term product goal. Do not use user-to-server tokens in v0.1 to scrape other people’s repos; that explodes scope and ToS/privacy. Put “contributions to repositories I don’t own” on a later ADR.

**ADR:** amend 0006 (scope of events); product copy in architecture §1.

### H2. Default-branch backfill is the right v0.1 cut, and it is more lossy than the doc admits — HIGH

What GitHub can actually give you:

| Source | Reconstructable? |
|---|---|
| Commits currently reachable from the default branch | Yes, via list-commits pagination |
| Merged PR metadata (`merged_at`, merger, merge SHA) | Yes, even if the feature branch is deleted |
| Individual commits that lived only on deleted/unmerged branches | **No** |
| History rewritten by rebase/force-push | Old SHAs are gone from the ref; GitHub may still serve `GET .../commits/{sha}` **if you already know the SHA** |
| Squash merge | One new default-branch commit; the PR’s original commits are not on the default branch |
| Fork-imported / `git filter-repo` history | SHAs exist; GitHub author linking is often `null` |
| Multiple emails / unlinked `user.name` | Author account ID missing |

The architecture already chooses default-branch as the completeness boundary and stores commit identity once. Good. What is missing is a **completeness model** the UI can show:

1. **Observed:** facts DevMemoir has upserted.
2. **Reachable-at-sync:** default-branch (and, if enabled, currently listed refs) at last successful stage.
3. **Known-unknown:** deleted refs, force-push gaps, unlinked authors, truncated webhooks repaired only after reconcile.
4. **Out of scope:** other people’s repositories, orgs, reviews, Actions.

Milestone 3 already wants this visible. **Milestone 1 must show it too**, or the 100-commit slice trains the owner to trust a partial graph.

### H3. `since` on commits is not `updated_at` and cannot see force-pushes — HIGH

GitHub `GET /repos/{owner}/{repo}/commits?since=` filters by **git committer date**, not a GitHub mutation time. Commits do not have `updated_at`. A force-push that replaces last week’s commits with new SHAs that have old author dates, or that drops commits whose committer dates are older than the cursor, is invisible to `since = cursor_time - 24h` if the new SHAs are not in that window.

**Correction.** Incremental commit sync is **ref-head based**, not time-cursor based:

- Store `branches.head_sha`.
- On webhook/reconcile: if `head == stored`, no-op (optional `If-None-Match` on HEAD).
- If `head` changed: walk `new_head` until `old_head` or a bound; if `old_head` is not an ancestor (`forced` or compare `status: diverged`), mark previously reachable-only-from-this-ref commits as unreachable and import the new walk. Do not delete commit rows.

The 24-hour overlap is a useful extra safety net. It is not sufficient as the primary cursor.

**ADR:** amend 0004 / architecture §6 incremental sync.

### H4. Attribution will be wrong without author ≠ committer, Co-authored-by, and bots — HIGH for product, MEDIUM for schema

The schema can represent author and committer FKs. The default memoir must not count both `commit.authored` and `commit.committed` for the same SHA when they are the same person. Squash merges typically have PR author as author and merger as committer — counting both as “I built this” for the merger is wrong.

Not in the model today:

- `Co-authored-by:` trailers (common with GitHub UI and agents).
- Bot logins (`dependabot[bot]`, `github-actions[bot]`, `renovate[bot]`).
- Agent-looking authors (Cursor, Copilot, etc.) — do not overfit; a `actor_kind` of `user | bot | unknown` from GitHub’s `type` / `bot` flag is enough for v0.1.
- Collaborator activity on the owner’s repo: **project context**, not personal contribution.

**Correction.** Keep one `development_events` table. Default timeline query is: events whose `actor_github_account_id` is the owner **or** explicitly marked project-milestone (release published), minus bots, minus duplicate verb pairs collapsed in the **query/projector**, not by deleting facts.

### H5. Issue closed by “Fixes #n” is not an issue.closed authorship of the PR author — LOW/MEDIUM

GitHub can close an issue from a PR without an `issues.closed` actor equal to the PR author depending on the event. v0.1 should show issue closed as its own lifecycle fact with whatever actor GitHub sent, and not infer a contribution. Linking `fixes` references can wait.

---

## Webhook / Reconciliation Findings

### W1. Durable receipt + async process is the right pattern — keep

Raw-body HMAC-SHA256, size limit, insert delivery + outbox in one transaction, 202, idempotent upserts by natural keys, never order by receive time: **keep**. This is the strongest part of the proposal. Do not move processing into the request handler. Do not “simplify” back to Next.js route handlers.

GitHub still does not auto-redeliver after it gives up; a >10s response is a failed delivery; the redelivery window is three days. The 6-hour audit is therefore not polish. It is load-bearing. It can wait until Milestone 5 **only if** M1’s GUID state machine does not drop failed receipts (see B1).

### W2. GUID dedupe is necessary and not sufficient — HIGH

See B1. Additional nuance: GitHub issue #32822 / docs PR #33184 clarified the header is unique **per event**, not per HTTP delivery. Two Apps observing the same underlying event can share a GUID. DevMemoir runs one App, so a global unique on `github_delivery_guid` is still correct. Do not make the unique `(app_id, guid)` until you have two Apps. Do **not** claim “globally unique per delivery attempt.”

Entity keys `(tenant_id, repository_id, sha)` / `(..., github_id)` remain the real idempotency for re-fetches and for a second delivery GUID that carries the same PR (GitHub can emit follow-up actions under new events, which is fine).

### W3. Push, create, delete, and 25 MB payload cap — MEDIUM

Payloads over 25 MB are **not delivered at all**. `create`/`delete` do not fire when more than three tags move at once. Reconciliation is the only repair. Weekly deep reconcile is not overkill for tags/releases; for v0.1 owner scale, **daily inventory already covers it**. The 6-hour recent reconcile is justified; the weekly full re-list of PRs/issues can be deferred if daily overlap is correct.

### W4. Overlap windows on `updated_at` are the right tactic; cursor advancement is still skip-prone — MEDIUM

For PRs/issues/releases:

- GitHub list endpoints are not snapshot-isolated.
- `since` / `updated_at` filters plus page-by-page max timestamp can skip items that share a timestamp or that move during pagination.

A 10-minute overlap is a reasonable v0.1 hedge. Safer rule: **never advance `high_water_at` past `min(page_item.updated_at)` of the last full successful window minus overlap**, and only after the **last** page of that window commits. Do not advance per page to `max(updated_at)` if you might not have finished the page set. The architecture says “advance only after the page set succeeds” — keep that sentence in the code, not just the doc.

Equal timestamps: “incoming `github_updated_at >= stored` still fills missing fields” is correct. Strict `>` would skip legitimate same-second updates.

### W5. Reconciliation vs webhook vs backfill races — MEDIUM

Natural keys plus stale-update (`incoming.updated_at >= stored`) make this converge **if** every writer uses the same rule. The remaining race: backfill stage checkpoint vs live webhook inserting a newer PR, then backfill page containing an older view of the same PR. Stale-update handles it. Force-push during default-branch backfill can checkpoint a page of SHAs that are no longer on the branch; those rows should remain (observed history) with `commit_refs.reachable` updated later. Do not delete.

Cancel API jobs immediately on `installation.deleted` / suspend / repo removed. A job that is already mid-page with a still-valid token can finish the page; the next page should re-check access.

### W6. Zod must not fail closed on unknown fields — HIGH

GitHub adds actions and fields without a version bump you control. A strict Zod schema that rejects unknown keys will dead-letter every `pull_request` after GitHub adds a field. Use strip/passthrough at the payload envelope; validate only the fields you persist. Unknown **actions** → `ignored` + metric, not 5xx.

### W7. 6-hour / daily / weekly is acceptable for v0.1 and too chatty for 10k users — LOW for now

Do not change the v0.1 schedule. Record that 6-hour recent reconcile is per **active** repo, not global full re-list. Installation-lane concurrency (one or two GitHub requests in flight per installation) matters more than the cron table. Secondary rate limits, not the 5,000/hour primary, will fire first on backfill.

---

## Database & Queue Findings

### D1. PostgreSQL as system of record is correct — keep

Relational uniqueness, transactional page+cursor, JSONB as escape hatch, portable SQL: keep. Neon vs Supabase vs Railway Postgres: Neon Launch is a reasonable production choice **if** paid restore is on before private history is trusted. Self-managed Postgres is correctly rejected.

### D2. `tenant_id` on every private table plus intentional duplication — keep

Two tenants authorizing the same repository should duplicate rows. At expected scale, storage is cheaper than a shared-repo leak or a cross-tenant delete. Global uniqueness on `github_accounts.github_account_id` is correct (actors are not tenant-owned). Global uniqueness on `github_installations.github_installation_id` is correct.

### D3. `github_identities` unique constraint is wrong — HIGH

**Evidence.** Schema: `UNIQUE (user_id, github_account_id)`.

**Failure.** After multi-user, GitHub account 1234 can link to two DevMemoir users. Onboarding bugs, support tools, or a second “Continue with GitHub” path create two tenants that receive the same installation claim attempt. Account-takeover / aliasing.

**Correction.** `UNIQUE (github_account_id)` on `github_identities`. For v0.1 also `UNIQUE (user_id)` (one GitHub identity per user). Put this in the first migration. Cheap now, ugly later.

**ADR:** amend 0002/0003 schema notes.

### D4. UUIDv7 is fine

Internal UUIDv7 keys, `bigint` GitHub IDs, `timestamptz`, SHA as text/char(40): keep. UUIDv7 timestamp leakage is not a meaningful threat next to stored commit messages. Do not switch to UUIDv4 for theater.

### D5. `commit_files` will dominate storage if populated in v0.1 — MEDIUM

The table is reasonable as a schema placeholder. Populating it per commit is the expensive experiment already listed. **Do not** create a backfill stage that writes `commit_files` in v0.1. Path hints on `development_events` can wait for the same experiment. Unbounded growth tables that **are** v0.1: `development_events`, `commits`, `webhook_deliveries` (mitigated by 30-day expiry), `audit_log`. Payload expiry job is required before private-owner gate, not after public beta.

### D6. `webhook_deliveries.tenant_id` nullable is correct; processing must not skip auth — keep

Ping and malformed-but-signed payloads may lack installation. Signature verification happens **before** insert. Invalid signatures: 4xx, **no row**, no payload stored (architecture already says this). Keep.

### D7. pg-boss is the right v0.1 queue — keep, with connection topology — HIGH

Trying to break it:

| Attack | Result |
|---|---|
| Need Redis for durability | False: jobs in Postgres with SKIP LOCKED is durable |
| Queue contention at owner scale | Not credible for v0.1 |
| DB outage takes webhooks down | True, and correct: acknowledging without durability is silent loss |
| 10k installations | pg-boss will hurt; `JobPort` exists so this is not a rewrite of handlers |
| Neon pooler | **Real:** LISTEN/NOTIFY unsupported; session advisory locks unsupported |
| Scale-to-zero | Worker polling **or** webhooks will either keep compute hot or pay cold-start inside GitHub’s ~10s delivery timeout |

pg-boss polling is the correctness floor; LISTEN is optional latency. A worker on a **direct** Neon connection can poll every 1–2s without LISTEN. That is enough for “visible within two minutes.”

**Correction.**

- API/web: Neon **pooled** URL.
- Worker/pg-boss: Neon **direct** URL, small pool (a handful of connections).
- Production private-data: disable Neon scale-to-zero (or accept always-on compute because the worker polls). Cost envelopes that assume scale-to-zero plus an always-on worker are inconsistent.
- Keep `sync_jobs` / `sync_cursors` as business checkpoints so a pg-boss table wipe is not history loss.

Do **not** introduce Redis/SQS in v0.1.

**ADR:** amend 0002, 0005, 0007.

### D8. Next.js importing `packages/db` creates a second writer — MEDIUM

Shared read-only repositories from Next.js server components are acceptable in a modular monolith. Writes (session creation aside) should go through the API or through the same domain functions with the same tenant scoping. If Next.js starts enqueueing jobs or upserting events, you have two ingestion authorities. **Rule:** only `apps/api` and `apps/worker` write GitHub-derived tables. `apps/web` reads through tenant-scoped queries or the API.

RLS: not a v0.1 blocker. Enable it before a second human exists (support admin counts). Application `WHERE tenant_id = $1` is necessary and not sufficient. Draft policies in Milestone 8 is late if a friend is invited in v0.2. Prefer adding RLS in the first schema **even if** the only tenant is the owner — cheap, and it tests the `tenant_id` column story.

---

## Privacy & Security Findings

### P1. The collection set is larger than “required” and should default tighter — HIGH

Storing commit messages is required for the product. Storing **PR/issue/release bodies** and **file paths** by default is not. Those are the fields that contain customer names, credentials, and private design. Architecture already calls bodies “useful but optional.” v0.1 should **default bodies off** (titles/messages on), not store them until an owner control exists. File paths off until the classification experiment.

Raw webhook payloads: the 3-day redelivery window plus source-entity re-fetch means **7 days** is enough. 30 days multiplies backup exposure. Dead-letter 90 days is long for private bodies; 14–30 days with the same encryption and no support UI that prints payload is enough for v0.1.

### P2. Observability will leak private data unless M1 includes the allowlist — HIGH

**Evidence.** Stack includes Sentry and OpenTelemetry. Milestone 1 acceptance: private name/message never in application logs. Milestone 6: structured log allowlist and automated redaction tests. Those cannot be different milestones if Sentry is initialized in M1.

**Failure.** Fastify error handler attaches `request.body`. Sentry breadcrumbs capture HTTP. A single thrown `ZodError` on a `push` webhook uploads commit messages to a third party. That is a private-repo incident on day one.

**Correction.** M1: allowlist logger, no body/message/path/repo-name fields, Sentry `beforeSend` scrubber, test that a fixture private message does not appear in captured log output. If that slips, do not enable Sentry until Milestone 6.

### P3. Contents permission + compare/list file patches in process memory — HIGH

Even if you never persist patches, Sentry, core dumps, and debug logs will. See G1. Treat in-memory patch as equivalent to stored source for logging purposes.

### P4. Collaborator PII — MEDIUM

Commit author names/emails of other people in the owner’s private repo are someone else’s personal data. v0.1 owner-only use is still processing that data. Do **not** persist raw git emails by default (HMAC only if opt-in matching is ever added). Do not log them. GDPR/export can wait for multi-user, but the schema should not have `author_email` text columns “just in case.”

### P5. Cross-tenant IDOR and installation bind — HIGH (schema now, RLS later)

See D3 and B3. Tenant-scoped repositories from day one, with a negative test that tenant A cannot `SELECT` tenant B’s commits **even in M1 fixtures**. Support tooling in v0.4 is the classic bypass; do not build a god-query.

Session: new session id after login; `state` one-time; PKCE verifier server-side, not in a public cookie without HttpOnly.

### P6. App private key is the blast radius — keep existing controls

Do not store it in the DB or repo. Railway secret → API and worker only. Rotate before beta. This is already stated; it is still the single most important operational control. No change.

---

## Infrastructure Findings

### I1. Railway + Neon is architecturally suitable for v0.1 — keep, distrust the dollar range

Persistent HTTP, persistent worker, cron: Railway fits. Neon is real Postgres with a restore window on Launch. That pairing is **better** than Vercel+serverless+a hidden worker.

Pricing tables will age; ignore them as a decision. Architectural risks that will not age:

- **Cross-vendor network.** Railway ↔ Neon is public internet (unless you later colocate). Webhook p95 is dominated by this plus Neon cold start.
- **Cold compute vs GitHub 10s.** If Neon is asleep, durable receipt can miss the deadline → failed delivery. For private-owner production: **always-on Neon compute**.
- **Connection storms on deploy.** Three processes (web, API, worker) each with a pool, plus pg-boss. Cap pools explicitly (single digits per process at v0.1).
- **pg-boss + pooler.** See D7.
- **Backup deletion.** Neon PITR will retain deleted private payloads for the restore window. Account-deletion copy must not claim backups are gone.

Render is the conservative alternative (always-on Postgres, workers, cron). Switching later is operational, not an application rewrite, if you stay on ordinary Postgres.

### I2. Co-hosting worker inside API is allowed in dev only — keep that sentence

The architecture already forbids production co-hosting for private ingestion. Enforce it. A single Railway service that “also runs the worker loop” will stall webhooks under backfill.

### I3. Fastify vs Next.js for webhooks is justified on raw-body grounds — keep

Next.js App Router request body consumption is a well-known HMAC footgun. Fastify’s explicit raw-body parser is a real reliability reason, not aesthetic preference. That alone justifies a second HTTP process.

---

## MVP Scope Findings

v0.1 as Milestones 1–7 is large **and** mostly justified. Reliability and privacy are the product. Do not cut reconciliation, GUID state, disconnect/delete, or log redaction to ship faster.

### Truly required before owner-only private use (Gate A)

- M1 vertical slice with the corrections in this review
- M2 installation lifecycle
- M3 resumable backfill
- M4 subscribed event projectors
- M5 reconciliation + delivery audit (or Gate A is “best-effort live data”)
- Privacy/redaction, payload expiry, restore drill (currently M6) — **cannot stay after M5 if private data is already in Neon**

### Can wait after Gate A

- Weekly deep reconciliation (daily + 6-hour recent is enough for one owner)
- `commit_files` / per-commit stats
- PR/issue bodies
- Cross-repo dashboard polish (M7 can be thinner: one timeline, completeness flags, soak)
- Rule-based classification
- RLS enabled (draft earlier; enable before a second user)
- GraphQL

### Currently deferred but should move earlier

- Completeness copy and default-timeline filters (M1, not M7)
- Log/Sentry allowlist (M1)
- `github_identities` unique (M1 migration)
- Direct vs pooled connection strings (M1 deploy)
- `ping` + `github_app_authorization` handlers (M1)
- Push → range sync (M1)

**Smallest trustworthy v0.1:** one allowlisted human, selected repos on their user account, default-branch commits + PRs + issues + releases, webhooks as signals, daily reconcile, honest completeness, redacted logs, paid restore, delete/disconnect. That is still Milestones 1–6, with M7 reduced to soak + copy.

---

## Missing Concerns

Only items with a plausible DevMemoir failure:

| Concern | Why it matters | Severity |
|---|---|---|
| **GitHub-initiated install without `state`** | Marketplace/App page install is a real path | covered in B3 |
| **`installation.created` repo list is truncated** (50) | Inventory job must always paginate `GET /installation/repositories`; never trust the webhook array as complete | MEDIUM |
| **Zod fail-closed / webhook schema evolution** | Silent dead-letter storm | HIGH (W6) |
| **Secondary rate limits** | Backfill of a monorepo hits these while primary remaining looks healthy | MEDIUM |
| **Malicious oversized body** | HMAC CPU + 25 MB GitHub cap; enforce a lower app cap (1–2 MB) before HMAC if possible, or HMAC then 413 | MEDIUM |
| **Secrets in commit messages** | You will store tokens people committed; do not echo them in UI snippets without truncation; never search-index them into a third party | MEDIUM |
| **Submodules / LFS** | Parent commits exist; submodule history and LFS blobs are out of scope. Completeness note only | LOW |
| **Large monorepo duration** | 50k default-branch commits = 500 pages; needs heartbeat, budget, and progress that does not look stuck | MEDIUM |
| **Deleted GitHub user / `ghost` sender** | Docs warn `sender` can be `ghost`; do not crash projectors on missing actor | MEDIUM |
| **Webhook secret rotation** | Two-secret overlap window is not in the plan; without it, rotation is an outage | LOW/MEDIUM |
| **GDPR / other authors’ PII** | Real at multi-user; schema should not store raw emails now | MEDIUM |
| **GitHub API version pin** | Already planned; add a calendar reminder, not a new system | LOW |
| **Marketplace listing rules** | Irrelevant until you list; keep the App private | LOW |
| **GitHub Enterprise Server** | Out of scope; do not design for it | n/a |
| **Billing abuse** | No billing in v0.1 | n/a |
| **DoS by unauthenticated HMAC flood** | Rate-limit the webhook route by IP **after** cheap header checks; GitHub `User-Agent` is not authentication | MEDIUM |

---

## Architecture Decisions You Agree With

Do **not** change these for variety:

1. **Option B** (Next.js + Fastify + Node worker) over unified Next.js and over FastAPI.
2. **Modular monolith / pnpm workspaces**, not microservices.
3. **Fastify rather than NestJS.**
4. **PostgreSQL as the system of record**, Drizzle, ordinary SQL migrations.
5. **GitHub App** (not PAT, not a separate OAuth App) with **read-only** Metadata/Contents/PRs/Issues.
6. **Separate user authorization and installation.**
7. **Just-in-time installation tokens, never persisted.**
8. **Webhook is a notification; REST backfill/reconcile is truth.**
9. **Acknowledge only after durable receipt; process asynchronously.**
10. **At-least-once + idempotent upserts**, not exactly-once theater.
11. **`tenant_id` on every private/source table** and duplicate-per-tenant repo data.
12. **GitHub numeric IDs + commit SHA as identity;** names are attributes.
13. **pg-boss behind `JobPort`** for v0.1; no Redis until measured pain.
14. **Railway containers + Neon Launch**, local Docker Postgres.
15. **No clone, no blobs, no patches stored.**
16. **Owner allowlist with the multi-user schema already in place.**
17. **Source tables + `development_events` projection**, not webhook-payload-as-database.
18. **Tombstones over erase** on force-push/delete.

---

## Recommended Changes Before Milestone 1

Actionable. Do these in the architecture/ADR/plan, then code.

1. **Write the completeness contract** into the M1 UI: “Newest 100 commits currently reachable from the default branch of this connected repository.” Not “your GitHub history.”
2. **Fix delivery state machine** (B1): GUID unique; failed/in-flight rows resume on redelivery.
3. **Push handler is a sync enqueue** (B2): `before`/`after`/`ref`/`forced` only.
4. **Specify session/callback topology** (B3). Turn off “Request user authorization during installation.” Require PKCE. Verify `installation.account.id`.
5. **Change `github_identities` to `UNIQUE (github_account_id)`** (and `UNIQUE (user_id)` for v0.1).
6. **Document Neon direct vs pooled** and disable scale-to-zero for deployed private use.
7. **Permit-list GitHub endpoints**; never persist `patch`; do not log compare files.
8. **M1 observability allowlist + Sentry scrubber + test**, or no Sentry.
9. **Accept `ping` with 2xx.** Handle `github_app_authorization` as no-op/token drop.
10. **Zod strip unknown fields;** unknown actions → `ignored`.
11. **Default timeline:** owner-attributed events; do not render both authored+committed for the same SHA as two accomplishments; hide bots.
12. **Do not persist PR/issue bodies or `commit_files` in M1.**
13. **Add tests:** failed delivery then same-GUID redelivery resumes; worker kill mid-page; fixture private string absent from logs; non-allowlisted user denied; installation bind rejected for a different GitHub account.

---

## Recommended ADR Changes

| ADR | Action | Why |
|---|---|---|
| **0001** Application architecture | **Amend** | Record session/callback topology; web is not a writer of GitHub-derived tables; keep three processes. |
| **0002** Database | **Amend** | Identity unique constraints; worker **direct** Neon connection; API pooled; RLS timeline; no raw git emails. |
| **0003** GitHub authentication | **Amend** | PKCE required; App settings (OAuth-during-install **off**); installation account check; endpoint permit-list; `github_app_authorization`. |
| **0004** Webhooks | **Amend** | Delivery GUID = event id; receipt vs success states; push is a signal; ping; unknown actions; Zod strip. |
| **0005** Background jobs | **Amend** | Polling is sufficient; LISTEN only on direct connections; keep `JobPort` + `sync_cursors`. **Do not replace.** |
| **0006** Event model | **Amend** | Scope = connected repositories; personal vs project context; collapse author/committer in default view; bots; completeness states. **Do not add separate activity/contribution tables in v0.1.** |
| **0007** Hosting | **Accepted with existing validation** | Add: always-on Neon for private production; pool sizes; two-week measurement already required. Do not switch to Vercel. |

No ADR needs to be replaced or deferred pending experiment except the already-listed experiments (all-branch backfill, per-commit files, pg-boss 100k load, PR body default). Those experiments stay **out of M1**.

---

## Final Architecture Verdict

1. **Is Option B still the correct architecture?**  
   Yes. Webhook latency, long backfills, and UI do not belong in one Next.js process. Python does not earn a second production language for ingestion.

2. **Is Fastify justified?**  
   Yes. Raw-body HMAC, a stable GitHub-facing HTTP process, and an allowlisted public surface. NestJS would add motion without safety.

3. **Is PostgreSQL + pg-boss justified for v0.1?**  
   Yes. Transactional enqueue with page upserts is a feature, not a compromise. It stops being healthy at large multi-tenant job fan-out; `JobPort` is the hedge. Use a direct DB connection for the worker.

4. **Is Railway + Neon reasonable?**  
   Architecturally yes for v0.1. Treat cost tables as stale. Run Neon always-on for private owner use. Measure the two-week slice before believing webhook p95.

5. **Are the GitHub App permissions correct?**  
   Yes, and Contents is broader than the product. Mitigate with a permit-list, not by dropping the permission (commits would break).

6. **Is the event model trustworthy enough?**  
   As a **fact store**, yes. As a **default memoir of personal contribution**, not yet. Trust comes from filters (actor, role, bot, connected-repo scope) and honest completeness, not from more tables.

7. **Is the privacy model strong enough for private repositories?**  
   The **intent** is strong (no blobs, short raw retention, tenant isolation, no tokens in DB). The **schedule** is not: redaction, body defaults, and Sentry scrubbing must exist before private payloads hit a hosted DB. Tighten default retention from 30 days to 7.

8. **Is Milestone 1 safe to begin?**  
   Not from the implementation plan as written. It is safe to begin **after** B1–B3 and the M1 list above are folded into the plan. Then M1 is the right slice.

9. **Three most likely causes of a future major rewrite**  
   1. Shipping AI Chronicle on “all events in connected repos” as if they were personal accomplishments (semantic rewrite of the query layer and maybe the event vocabulary).  
   2. Encoding webhook payload commits / GUID-as-success in the worker so ingestion has to be replaced.  
   3. Letting Next.js and the worker both write GitHub-derived tables, or letting pg-boss connection topology stay implicit until Neon pooler + LISTEN fails in production (operational rewrite under time pressure).

10. **Single most dangerous incorrect assumption**  
    That GitHub App webhooks plus default-branch REST history are a complete, personal answer to “what have I been building?”  
    They are a complete-enough answer to “what have we observed in repositories this installation can currently read, among refs that still exist, attributed when GitHub linked the actor.” If that distinction is not in the product contract, every later feature — especially Chronicle — will amplify a lie.

---

## Overall architecture (review prompt §1)

**Verdict: keep.**

The API/worker split is earned: GitHub’s delivery timer and multi-hour backfills are incompatible with request-scoped runtimes. The web/API split is earned if session topology is specified (B3); otherwise it is accidental complexity. Do not merge into Option A. Do not extract microservices. Strengthen the rule that only API+worker write ingestion tables.
