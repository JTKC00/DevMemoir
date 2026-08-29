# DevMemoir implementation plan

**Status:** Reconciled — GO WITH CONDITIONS
**Architecture:** [DEV_MEMOIR_ARCHITECTURE.md](./DEV_MEMOIR_ARCHITECTURE.md)
**Formal review input:** [ADVERSARIAL_REVIEW_GROK.md](./ADVERSARIAL_REVIEW_GROK.md)

## Delivery rules

1. Build the selected Option B: TypeScript modular monolith with separately deployable Next.js web, Fastify API, and worker processes.
2. Treat DevMemoir as a view of **connected repositories**, never a complete GitHub archive or automatic proof of personal accomplishment.
3. Only API and worker write GitHub-derived tables. Web owns rendering and the host-only application session, and reads through the API boundary.
4. Use GitHub numeric IDs for identity, tenant IDs on every private/source row, forced PostgreSQL RLS for application roles, and exact account/installation binding.
5. A webhook delivery GUID is event identity, not success. Only `processed` and `ignored` are terminal no-op states.
6. A `push` webhook is a sync signal. Never persist its `commits` array; source facts come from an authoritative GitHub ref-head traversal.
7. Keep v0.1 metadata-minimal: titles/messages and lifecycle metadata are allowed; bodies, files/paths/counts, patches, blobs, raw Git emails, comments, and workflow artifacts are off.
8. Use synthetic/sandbox private data until Gate A (M1–M6) passes. Do not rely on a free/scale-to-zero database for real private history.
9. Every milestone ends with automated evidence and a short decision log. Deferred experiments cannot silently expand the data or endpoint envelope.

## Milestone 1 — Secure vertical slice

### Objective

Prove one allowlisted owner can authenticate, bind one selected GitHub App installation, import the newest 100 currently reachable default-branch commits, receive a push signal, recover from failure, and view a truthful private timeline.

### Dependencies

GitHub sandbox owner/account and App registration, fixed callback/setup URLs, Railway/Neon projects, provider secret stores, and approved initial database roles/migration.

### Scope

- Create the pnpm workspace and shared packages for config, contracts, database, GitHub client, domain, observability, and jobs.
- Deploy Next.js web, Fastify API, and a separate always-on worker. Local development may co-host API/worker, but production may not.
- Configure paid always-on Neon in the target region:
  - pooled URL and small single-digit pools for web/API;
  - direct URL and small single-digit pools for worker, pg-boss, and migrations;
  - no `LISTEN` through the pooler and no production scale-to-zero.
- Create the GitHub App with install-time user authorization disabled, OAuth callback distinct from setup URL, expiring user tokens enabled if exposed later, private visibility, minimum read permissions, and subscribed events including `ping` and `github_app_authorization`.
- Implement login with PKCE S256, hashed single-use state, encrypted server-side verifier, allowlisted return paths, short-lived auth transaction, one-time API-to-web handoff, and `__Host-devmemoir_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, path `/`).
- Verify the installation account ID/type against the signed-in GitHub user before binding. A setup callback without usable state may only be claimed from an authenticated session and must re-fetch/verify the installation.
- Add owner allowlist enforcement before tenant creation.
- Add the first PostgreSQL schema with UUIDv7 keys, v0.1 `UNIQUE(github_account_id)` and `UNIQUE(user_id)` identity constraints, tenant IDs, forced RLS for non-owner application roles, and role separation for web/API/worker/migrations/queue.
- Implement a central GitHub endpoint permit-list. Deny contents, blobs, trees for content acquisition, archives, and cloning; strip compare `files[].patch` before any value crosses the client boundary.
- Import repository metadata and the newest 100 commits reachable from the current default-branch head. Store no raw Git emails or file details.
- Display the exact copy: **“Newest 100 commits currently reachable from the default branch of this connected repository.”**
- Implement default timeline rules: connected owner plus explicit project milestones; authored/committed same SHA/person renders once; merged PR is not duplicated as closed; merger does not inherit authorship; bots hidden by default; nullable/ghost actors remain project/unknown context.
- Implement webhook receipt with a 2 MB pre-parse cap, raw-byte HMAC verification, current/previous secret rotation overlap, tolerant Zod schemas that strip unknown fields, `ping`/`github_app_authorization`, and signed unknown events/actions acknowledged as `ignored`.
- Persist a delivery state machine: `received → processing → processed|ignored|failed|dead_letter`, with first/last receipt time, receipt count, lease/attempt/error metadata, encrypted payload, and expiry.
- On `push`, store only delivery/install/repository IDs plus `ref`, `before`, `after`, and `forced`; enqueue an authoritative ref-head sync and ignore the payload commit list.
- Add pg-boss behind `JobPort`, direct-connection polling/leases, logical job keys, atomic source-page/cursor transactions, and graceful worker drain.
- Ship an allowlist-only structured logger and exception scrubber. Keep Sentry/OTel/session replay/third-party analytics disabled.

### Acceptance criteria

- Login/session state is single-use; a non-allowlisted GitHub user and an installation-account mismatch are both rejected before any tenant/source row is created.
- One selected repository renders exactly the API-derived newest 100 reachable commits and the exact completeness statement.
- A push whose embedded commits disagree with GitHub API results produces only API-derived source facts/events.
- Same-GUID redelivery from `received`, worker-killed `processing`, `failed`, and retried `dead_letter` resumes or ensures one logical job; only `processed`/`ignored` are no-ops.
- Killing the worker before and after transaction commit yields one source fact/event, a correct cursor, and a terminal delivery after recovery.
- Concurrent first receipt of one GUID creates one logical job while retaining receipt metadata.
- Endpoint denial, compare-patch stripping, 2 MB rejection, tolerant unknown fields/actions, `ping`, and `github_app_authorization` are covered.
- Direct SQL and service tests prove Tenant A cannot read/write Tenant B; web cannot write GitHub-derived tables.
- A private canary repository name, commit message, body, path, payload, token, and secret appear in no logs, metrics, serialized errors, or CI artifacts.

### Important tests

Unit-test HMAC/validators/permit-list/logger; integration-test delivery states, transaction/lease recovery, roles/RLS, and cursors; end-to-end-test PKCE → install bind → import → push → timeline with a live sandbox App.

### Risks and exit

The largest M1 risks are auth topology, delivery state semantics, and pooled/direct configuration. Exit only with deployed sandbox evidence and restart/redelivery tests; M1 completion does **not** permit reliance on real private history.

## Milestone 2 — Installation and repository inventory

### Objective

Make installation lifecycle and selected-repository access authoritative and restartable.

### Dependencies

M1 session/install binding, GitHub client permit-list, tenant schema, and durable job framework.

### Scope

- Handle installation created/deleted/suspend/unsuspend and repositories added/removed.
- Always paginate `/installation/repositories`; never treat the repository list embedded in `installation.created` as complete.
- Re-fetch installation account, permissions, selection mode, and repository visibility with an installation token minted just in time.
- Preserve repository identity across rename/transfer; maintain name history and access tombstones.
- Cancel/gate jobs and token minting immediately on loss of access.

### Acceptance criteria

- Truncated webhook fixture plus multi-page inventory yields the full selected set.
- Remove/re-add and rename/transfer preserve internal identity and resume safely.
- A mismatched, org-owned, suspended, or uninstalled installation cannot be claimed by the M1 owner flow.
- No installation token or App JWT is persisted, enqueued, logged, or sent to web.

### Important tests

Truncated-event/multi-page inventory, account mismatch, rename/transfer, remove/re-add, suspend/uninstall, and token-leak canary tests.

### Risks

GitHub lifecycle ordering and ambiguous 403/404 can revoke or bind the wrong access; authoritative account/inventory re-fetch and tombstones are mandatory.

## Milestone 3 — Restartable historical backfill

### Objective

Backfill the supported connected-repository facts with explicit completeness and bounded API cost.

### Dependencies

M2 authoritative repository inventory/access, direct worker queue, source schema, endpoint budgets, and completeness contract.

### Scope

- Traverse commits from authoritative ref heads with page/high-water checkpoints; default branch first.
- Use a 24-hour time overlap only as a supplemental stale-update guard, never as the primary discovery algorithm.
- Import branches/tags and metadata-only PRs, issues, and releases. Bodies, commit files/paths/counts, patches, and raw emails remain unrequested/unpopulated.
- Apply source timestamps and idempotent upserts; checkpoint only after the full page transaction commits.
- Track observed, reachable-at-sync, known-unknown, and out-of-scope states for UI copy.
- Limit installation concurrency to 1–2 GitHub requests and honor primary/secondary limits.
- Reuse `sync_cursors` for the ordered durable state machine; keep `completed` rows and compare an expected structural cursor before applying each page.
- Fetch and commit at most one authoritative page per physical historical job. Source facts, reachability/inventory observations, and the next checkpoint share one tenant-local transaction.
- Treat the owner-selected repository as the only canonical M3 backfill. Unselection/access loss pauses work without deleting normalized facts; re-selection resumes the existing stage.

The implemented page, cursor, pause, retention, and completeness semantics are specified in [M3_BACKFILL_CONTRACT.md](./M3_BACKFILL_CONTRACT.md). PR, issue, release, branch, and tag projection remains M4.

### Acceptance criteria

- Repeated or interrupted backfill is monotonic and produces no duplicate source/event rows.
- Forced/diverged refs update reachability without deleting preserved commits.
- Pagination handles empty/final pages and a restart at every stage boundary.
- The UI never labels the connected/default-branch slice as full GitHub history.

### Important tests

Multi-page/empty pagination, kill at every checkpoint, force-push/divergence, stale update, rate-limit pause, and restart with overlap fixtures.

### Risks

Ref traversal can be expensive and still incomplete; cap concurrency, preserve known-unknown states, and never let a time window masquerade as authoritative discovery.

## Milestone 4 — Canonical development-event projection

### Objective

Project factual source lifecycles into a stable, queryable timeline without over-attribution.

### Dependencies

M3 normalized source facts, stable GitHub-account links, source/event uniqueness, and approved completeness/attribution vocabulary.

### Scope

- Implement the controlled event vocabulary and deterministic source/event unique keys.
- Populate actor kind, contribution role, context kind, confidence, visibility snapshot, and completeness state.
- Keep project context separate from connected-owner activity; nullable/ghost actors remain unknown.
- Apply collapse rules at projection/query boundaries, preserving source lifecycle facts.
- Provide source links and private-repository markings; no public sharing/indexing.

### Acceptance criteria

- Golden fixtures cover merged-versus-closed, authored-versus-committed, merger attribution, bots, collaborators, releases, ghost actors, and stale/out-of-order events.
- Reprojection from normalized source facts is deterministic and versioned.
- No productivity score or inferred accomplishment is introduced.

### Important tests

Golden owner/collaborator/bot/ghost and lifecycle-collapse fixtures, deterministic full reprojection, stale/out-of-order races, and private source-link access.

### Risks

Semantic over-attribution can undermine the product even when ingestion is correct; preserve source facts, version projection rules, and keep project context queryable.

## Milestone 5 — Reconciliation and operational repair

### Objective

Repair missed deliveries and source drift without user-token dependency.

### Dependencies

M3 restartable sync, M4 projection, GitHub App delivery APIs, scheduler/worker health, and opaque operational metrics.

### Scope

- Reconcile active repositories every six hours and all authorized repositories daily.
- Audit failed GitHub deliveries every six hours with an App JWT, request redelivery where appropriate, and correlate results to the existing GUID row.
- Re-inventory installations/repositories daily and repair cursors/source facts idempotently.
- Expose owner-only health, last-success, backlog, and retry controls without private content.
- Add quota lanes, backoff/jitter, worker heartbeat/lease alerts, and queue-rebuild procedure based on source/cursor truth.
- Defer weekly deep reconcile until measured Gate A repair yield justifies its API budget.

### Acceptance criteria

- Suppressed supported webhook is repaired by reconcile.
- Failed-delivery audit works with App JWT only and same-GUID redelivery resumes a failed state.
- Queue tables can be rebuilt without losing source progress.
- Active/all reconciliation age and rate-limit pauses are observable with opaque metrics.

### Important tests

Suppressed webhook repair, App-JWT-only failed-delivery audit, same-GUID recovery, queue wipe/rebuild, rate-limit exhaustion, and stale inventory/access repair.

### M5.4 completion

- [x] Owner-only `/ops` and `GET /api/ops/health` expose deterministic M5.1–M5.3 operational metadata without private content.
- [x] Repository reconciliation, delivery-audit retry, and recoverable-repair resume reuse existing durable entrypoints and preserve pauses, cooldowns, attempts, and terminal states.
- [x] Authorization, health derivation, concurrent idempotency, privacy canaries, and real PostgreSQL aggregation have regression coverage.

### Risks

Audit/reconcile loops can amplify API load or use the wrong credential; installation lanes, explicit schedules, and endpoint/credential contract tests bound the blast radius.

## Milestone 6 — Privacy, lifecycle, and recovery gate

### Objective

Complete Gate A controls before relying on real private-owner history.

### Dependencies

M1–M5 stable source/recovery flows, paid always-on Neon backup/PITR, isolated restore target, provider secret rotation support, and deletion policy.

### Scope

- Expire successful raw webhook payloads at 7 days and dead-letter payloads at a 30-day hard cap; processing never extends expiry.
- Implement disconnect, repository removal, uninstall, account deletion, session revocation, and accurate backup-retention status.
- Rehearse webhook-secret and GitHub App private-key rotation with an overlap window and explicit old-key revocation.
- Verify paid Neon backup/PITR policy and restore into an isolated environment.
- Audit forced RLS, application/migration/queue roles, outbound endpoints, observability sinks, and provider secrets.
- Produce Gate A evidence covering M1–M6 acceptance criteria.

### Acceptance criteria

- Expiry jobs remove encrypted payloads on schedule without deleting normalized facts.
- Delete/disconnect stops reads/jobs/tokens immediately and removes live rows as promised.
- Restore recovers schema, tenants, cursors, and normalized counts; test output leaks no content.
- Rotation maintains service through overlap and proves old material unusable afterward.
- Security/privacy checklist and tenant-isolation matrix have no open Gate A blocker.

### Important tests

Clock-driven 7/30-day expiry, uninstall/disconnect/delete under running jobs, session revocation, old/new secret overlap then revocation, isolated restore, and direct-SQL role matrix.

### Risks

Deletion and restore are destructive/high-trust operations; isolate targets, preserve audit evidence without content, and never promise provider-backup erasure before retention expires.

## Milestone 7 — Soak, quality, and dashboard

### Objective

Validate the Gate A architecture under representative owner use and make completeness visible.

### Dependencies

Gate A evidence, approved owner/sandbox data set, cost/latency dashboards, quality sampling procedure, and stable completeness copy.

### Scope

- Run a two-week sandbox/approved-owner soak; measure Railway–Neon latency/cost, pools, queues, quotas, reconciliation repair yield, and payload purge lag.
- Add cross-repository calendar/timeline filters, project activity counts, completeness indicators, and owner/project/bot controls.
- Tune small pools, worker concurrency, and alerts from evidence; do not expand retained data.

### Acceptance criteria

- Quality sampling matches source facts and collapse/attribution rules.
- Copy remains precise under deleted refs, force pushes, access loss, and unlinked actors.
- Operational objectives hold without cold/sleep loss or pool exhaustion.

### Important tests

Two-week SLO/cost soak, sampled source-to-event comparison, completeness-copy scenarios, private sharing/indexing denial, and pool/queue stress under representative backfill.

### Risks

One-owner samples can hide scale and semantic bias; record confidence/sample limits and do not widen data collection to improve dashboard polish.

## Milestone 8 — Explicit post-Gate-A experiments

### Objective

Evaluate optional scope without weakening the Gate A privacy/correctness contract.

### Dependencies

Gate B quality evidence, a written hypothesis and owner approval for each experiment, endpoint/storage budgets, and a rollback/retention plan.

### Scope

Run independent, reversible experiments for all-active-branch history, weekly deep reconcile, per-commit file stats, bodies, reviews/deployments, co-author trailers, and pg-boss load. Each proposal records benefit, API cost, storage/retention, privacy/UI control, migration/rollback, endpoint changes, and updated completeness semantics. No experiment may store patches, blobs, raw Git emails, or source content.

### Acceptance criteria

Each experiment produces a recorded adopt/reject decision; rejected data is purged on schedule, and adopted scope has an ADR/migration/tests/copy/control before release.

### Important tests

Run the experiment-specific endpoint, tenant, retention/purge, migration/rollback, completeness, and log-canary suites in an isolated tenant before any owner rollout.

### Risks

Optional signals can silently become surveillance or permanent private content; experiments remain opt-in, isolated, reversible, and never change default attribution into productivity scoring.

## Release gates

### Gate A — Private-owner data readiness

Requires M1–M6: all blocker tests pass; paid always-on Neon and isolated restore verified; no private canary leakage; forced RLS/direct-SQL isolation green; endpoint permit-list green; failed same-GUID redelivery and worker kills green; expiry/deletion/rotation green; exact completeness copy shipped.

### Gate B — Owner MVP quality

Requires M7 soak and data-quality review: operational objectives sustained, repair loops observed, attribution/collapse sample approved, cost understood, and no open high-severity privacy/reliability issue.

### Gate C — Multi-user beta

Requires revalidation of RLS and installation ownership, quotas/abuse controls, per-user lifecycle, incident/support runbooks, formal privacy/terms/DPA review, stronger sign-only App-key custody, and a new adversarial review of the implementation—not only these documents.

## Decision log after reconciliation

- Retained: Option B, Next.js + Fastify + worker, PostgreSQL/Drizzle, pg-boss behind `JobPort`, Railway + Neon, read-only GitHub App permission posture, tenant-scoped copies, no blobs/patches.
- Corrected: GUID state machine, authoritative push sync, auth/session/install binding, connected-repository product language, v0.1 identity uniqueness, pooled/direct database topology, first-schema RLS, M1 observability, event attribution/collapse, 7/30-day payload retention, and Gate A scope.
- Deferred: all-active branches, bodies/files, co-author trailers, reviews/deployments, weekly deep reconcile, AI, multi-user/organization features.
