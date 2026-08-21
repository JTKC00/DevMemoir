# DevMemoir Implementation Plan

**Status:** Proposed  
**Architecture dependency:** [DEV_MEMOIR_ARCHITECTURE.md](./DEV_MEMOIR_ARCHITECTURE.md)

## Delivery rules

- Each milestone must leave `main` deployable and the database migration-forward.
- Correctness and privacy tests are acceptance criteria, not follow-up work.
- Every background stage is idempotent before it is made concurrent.
- Live GitHub tests use a dedicated test App/account/repository; fixtures are redacted.
- Do not add source cloning, patches, AI calls, organization support, or billing during v0.1.

## Milestone 1 — One-repository end-to-end vertical slice

**Objective:** Prove the whole architecture with the smallest meaningful memoir.

**Scope**

- pnpm monorepo with `web`, `api`, `worker`, `domain`, `db`, `github`, and `jobs` boundaries.
- Local PostgreSQL and first migrations for tenant/user/identity/installation/repository/commit/event/delivery/job/cursor.
- Owner allowlist and GitHub App user authorization.
- Installation/setup callback for one selected private or public test repository.
- Import repository metadata and newest 100 default-branch commits.
- Signed `push` webhook receipt, durable GUID dedupe, asynchronous processing.
- Basic chronological activity page with repository, factual event, date, and GitHub link.

**Dependencies:** GitHub test App, callback/webhook URL, local tunnel or deployed API, PostgreSQL.

**Acceptance criteria**

- Owner can sign in and connect exactly one repository.
- Import survives a worker termination after page persistence and finishes without duplicates.
- A new push appears within two minutes.
- Replaying the same delivery creates no second source row, job, or event.
- Private repository name/message never appears in application logs.
- A non-allowlisted GitHub user is denied before tenant creation.

**Important tests:** signature vectors; invalid signature; Unicode raw body; concurrent duplicate delivery; migration from empty DB; page transaction/cursor; worker lease recovery; one live private-repo E2E.

**Risks:** callback identity confusion, framework body parsing changes raw bytes, token leakage, pg-boss lifecycle behavior.

## Milestone 2 — Complete repository inventory and lifecycle

**Objective:** Make repository authorization a durable, changing relationship.

**Scope**

- Installation inventory pagination and `installation`/`installation_repositories` processing.
- Repository selection/access rows and states: active, revoked, suspended, deleted.
- Repository metadata, visibility, archive/delete flags, rename/name history.
- Owner-only connection/status UI.

**Dependencies:** Milestone 1 App and core schema.

**Acceptance criteria**

- Adding/removing a repository at GitHub updates access without changing historical repository identity.
- Rename updates display and link while preserving timeline rows.
- App suspension/uninstall stops new token creation and queued API calls.
- A 403/404 triggers inventory verification rather than immediate data deletion.

**Important tests:** installation pagination; rename; transfer fixture; permission change; suspend/unsuspend/uninstall; private access removal/re-add.

**Risks:** confusing installation owner with signed-in user; GitHub webhook action drift; renamed URL redirects.

## Milestone 3 — Resumable historical backfill

**Objective:** Import the defined v0.1 historical truth for every selected repository.

**Scope**

- Staged coordinator and checkpoints for metadata, branches, tags, default-branch commits, PRs, issues, releases.
- GitHub `Link` pagination, `per_page=100`, API version pinning, request budgets.
- Atomic page upsert/cursor transactions and progress model.
- Source tables and indexes for all MVP entities.
- Backfill progress/failure UI.

**Dependencies:** Milestone 2 repository inventory; job adapter proven.

**Acceptance criteria**

- Backfill can be stopped in every stage and resume from the last committed checkpoint.
- Re-running any complete stage changes no row counts except observation timestamps.
- PR-shaped results from issue endpoints do not create issue duplicates.
- Rate-limit exhaustion pauses and resumes without operator database edits.
- The completeness boundary (“default branch plus current references”) is visible to the owner.

**Important tests:** multi-page/final-empty-page; malformed item isolation; restart each stage; primary/secondary rate limit; deleted branch; same SHA on multiple branches; source update regression.

**Risks:** API request explosion, Git timestamp quirks, large repository duration, misleading progress totals.

## Milestone 4 — Full live event normalization

**Objective:** Keep supported facts current with low latency.

**Scope**

- `repository`, `create`, `delete`, `pull_request`, `issues`, and `release` webhooks.
- Canonical lifecycle verbs and source-to-event projectors.
- Source timestamp stale-update rules and ambiguous-entity re-fetch jobs.
- Dead-letter status and owner-only sanitized inspection/retry.

**Dependencies:** Milestone 3 source tables and event vocabulary.

**Acceptance criteria**

- Every subscribed event/action is handled, explicitly ignored, or dead-lettered; none disappears silently.
- Older delivery cannot reopen/overwrite a newer closed entity.
- PR merge produces one primary merge contribution in default analytics.
- Unknown action produces an alertable ignored/unsupported record.

**Important tests:** action fixture matrix; out-of-order transitions; delayed push; force push; replay; repository archive/unarchive; release draft/publish/edit/delete.

**Risks:** GitHub adds actions/fields; projector semantics double-count activity; source webhook payload lacks full detail.

## Milestone 5 — Reconciliation and webhook gap recovery

**Objective:** Demonstrate that missed live events self-heal.

**Scope**

- Six-hour recent reconciliation, daily inventory, weekly rolling deep checks.
- Cursor overlap windows and ETags.
- GitHub App failed-delivery audit/redelivery within the three-day window.
- Reconciliation run status and data-freshness indicator.

**Dependencies:** Milestones 3–4 idempotent API and webhook paths.

**Acceptance criteria**

- Intentionally omitted PR, issue, release, and commit webhooks are repaired.
- Reconciliation is safe during simultaneous webhook processing.
- One repository failure does not prevent others from completing.
- Owner sees last successful sync and a degraded state after threshold breach.

**Important tests:** missed webhook; concurrent reconcile/webhook; ETag 304; overlap boundary; delivery audit pagination/redelivery; partial GitHub outage.

**Risks:** redelivery API credential/permission assumptions, excess periodic calls, cursor advancement bugs.

## Milestone 6 — Privacy, lifecycle, and operational hardening

**Objective:** Make owner private-repository use defensible and recoverable.

**Scope**

- Secrets inventory/rotation instructions and endpoint allowlist.
- Structured log allowlist and automated redaction tests.
- Raw payload expiry job (30 days) and restricted dead-letter retention.
- Disconnect, immediate delete, grace-retain, and account deletion workflows.
- Database backup configuration and first restore drill.
- Security headers, session protection, CSRF/state/PKCE, rate limits on public endpoints.

**Dependencies:** Complete data inventory from earlier milestones.

**Acceptance criteria**

- Automated scan of logs/telemetry finds no fixture private content or credentials.
- Expired payloads are removed while normalized events remain usable.
- Account deletion purges live tenant data and invalidates all sessions/jobs.
- A documented backup is restored into a clean database and passes integrity counts.
- Source/blob/archive GitHub endpoints cannot be invoked through the adapter.

**Important tests:** IDOR/tenant checks; CSRF/state replay; token encryption/key version; log injection; payload expiry; disconnect races; restore smoke test.

**Risks:** provider backup deletion semantics, accidental cascade gaps, overly broad observability capture.

## Milestone 7 — Data quality and owner MVP release

**Objective:** Prove the product answers the core question across the owner's repositories.

**Scope**

- Cross-repository timeline with repository/type/date filters.
- Attribution roles/confidence and project-context distinction.
- Completeness/freshness indicators and data-quality audit script.
- Operational dashboards/alerts and runbook.
- Two-week deployed soak test and cost/rate-limit measurement.

**Dependencies:** Milestones 1–6.

**Acceptance criteria**

- Owner reviews a representative month and can trace every displayed item to GitHub.
- Sample audit reports precision/recall estimates and unmatched commit categories.
- No queue item exceeds freshness SLO during the soak test without an alert.
- Monthly projected cost and GitHub request budget are recorded.
- All v0.1 E2E tests pass against public and private test repositories.

**Important tests:** timezone boundaries; pagination/filter consistency; deleted/renamed repository display; attribution ambiguity; accessibility smoke; deployment during event burst.

**Risks:** technically correct but semantically unhelpful timeline; timezone double counting; owner history exposes attribution gaps.

## Milestone 8 — v0.2 readiness experiments

**Objective:** Resolve evidence-dependent choices without expanding v0.1 scope.

**Scope**

- Compare default versus active-branch backfill.
- Measure per-commit file-stat value/cost.
- Prototype rule classifications on a fixed evaluation set.
- Measure pg-boss contention at 100k queued jobs.
- Draft RLS policy and validate tenant isolation for future beta.

**Dependencies:** Real v0.1 data and observability.

**Acceptance criteria:** each experiment produces a short decision record with data, recommendation, rollback, and resulting backlog change.

**Important tests:** defined in each experiment; production writes remain disabled for experimental classifiers.

**Risks:** experiments become hidden product features; evaluation set overfits the owner's style.

## Release gates

### Gate A — Private owner use

- Milestones 1–6 complete.
- Paid restorable PostgreSQL configured.
- Restore drill passed.
- No high-severity security finding open.
- Webhook replay and worker restart tests green.

### Gate B — v0.1 declared successful

- Milestone 7 soak complete.
- Daily reconciliation and raw-payload expiry healthy.
- Core question is useful in owner review, with known completeness caveats shown.

### Gate C — Multi-user beta work may start

- RLS/tenant negative tests, KMS-backed key handling, deletion/export policy, abuse controls, privacy/terms review, and incident runbook approved.

