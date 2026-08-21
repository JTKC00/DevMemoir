# DevMemoir Architecture Report

**Status:** Proposed  
**Decision date:** 2026-08-21  
**Scope:** v0.1 foundation through a credible multi-user SaaS path  
**Audience:** Product owner and implementers

## Executive decision

Build DevMemoir as a **TypeScript modular monolith in a pnpm monorepo**, with three logical applications:

1. a Next.js web application for sign-in, onboarding, and read views;
2. a Fastify HTTP application for GitHub callbacks, webhooks, and the internal API;
3. a Node.js worker for backfills, normalization, and reconciliation.

Use PostgreSQL as the system of record and, initially, a PostgreSQL-backed durable job queue. Keep the API and worker as separately runnable processes even if v0.1 temporarily co-hosts them. Deploy containers on Railway and use Neon PostgreSQL. Develop against local Docker PostgreSQL.

This is Option B, implemented without microservices. It creates a hard reliability boundary around webhook and background processing while preserving one language, one repository, one schema, and one deployment model.

## 1. Goals, non-goals, and design principles

### Goals

- Reliably answer “What have I been building on GitHub?” from durable historical and live data.
- Support public and private repositories through a real GitHub App.
- Survive duplicate, missing, delayed, and out-of-order delivery.
- Resume interrupted imports without starting over.
- Preserve stable GitHub identity and enough semantic source material for later classification.
- Make tenant isolation a schema and service invariant from day one.
- Stay simple enough for one developer to run.

### Non-goals for v0.1

- Organizations, team analytics, employee monitoring, or productivity scores.
- Source-code indexing, cloning repositories, storing blobs, or storing patches.
- AI classification or generated prose.
- Exactly-once delivery. The system instead provides at-least-once processing plus idempotent writes.
- A distributed event bus, Kubernetes, or separate services per GitHub entity.

### Principles

- **API backfill establishes truth; webhooks reduce latency; reconciliation repairs drift.**
- **A webhook is a notification, not the canonical database record.**
- **GitHub numeric IDs and commit SHAs are identity; names and URLs are mutable attributes.**
- **Acknowledge only after durable receipt, then process asynchronously.**
- **Store derived facts permanently; retain raw sensitive payloads briefly.**
- **All tenant-owned queries include `tenant_id`, even while only one tenant exists.**

## 2. Architecture options

### Option A — Next.js + TypeScript + PostgreSQL

A single Next.js deployment contains UI, API routes, OAuth callbacks, webhook handlers, and job-triggering endpoints.

**Strengths**

- Lowest initial code and deployment complexity.
- One TypeScript toolchain and excellent local iteration.
- Straightforward GitHub OAuth/App callback integration.
- Low personal-scale cost when deployed serverlessly.

**Weaknesses**

- Historical backfills and reconciliation do not fit naturally into request-limited functions.
- Webhook traffic, product traffic, and worker load share failure and scaling boundaries.
- Serverless database connection behavior requires pooling and careful concurrency control.
- Scheduled invocations still require a durable queue and independently executing worker for reliable long jobs.
- A “single app” tends to become an accidental architecture: background work is hidden in route handlers until it fails in production.

**Best fit:** a read-heavy CRUD product with small bounded jobs. DevMemoir's ingestion workload makes it only a qualified fit.

### Option B — Next.js frontend + dedicated Node.js backend + PostgreSQL

Next.js owns browser-facing views. Fastify owns GitHub-facing HTTP and application APIs. A Node worker consumes durable jobs. All packages share TypeScript domain types and repository code.

**Strengths**

- Clear webhook latency and security boundary.
- Long-running, resumable workers are first-class.
- One language across UI, integration, jobs, tests, and migrations.
- Fastify is small and explicit; no NestJS module/DI overhead is needed for v0.1.
- API and workers can be scaled independently later without changing domain boundaries.
- Octokit and the GitHub webhook ecosystem are strongest in Node/TypeScript.
- Strong AI-assisted development ergonomics: shared types, schemas, fixtures, and a smaller conceptual surface.

**Weaknesses**

- More process and deployment configuration than Option A.
- Shared-domain boundaries must be enforced to prevent the monorepo becoming coupled spaghetti.
- Running an always-on worker creates a small fixed/usage cost.

**Best fit:** DevMemoir's mix of interactive UI, low-latency webhooks, and durable asynchronous ingestion.

### Option C — Next.js frontend + FastAPI backend + PostgreSQL

Next.js serves the UI while Python/FastAPI owns GitHub integration, APIs, and workers.

**Strengths**

- Python is excellent for later notebooks, data science, NLP, embeddings, and model evaluation.
- Mature job tooling such as Celery and strong analytics libraries.
- FastAPI provides clear schemas and generated OpenAPI.

**Weaknesses**

- Two languages, package managers, type systems, test stacks, and runtime images from day one.
- GitHub ingestion is primarily API orchestration and persistence, where Python has no decisive advantage.
- Cross-boundary schema drift and duplicated DTOs increase maintenance.
- Celery normally adds Redis/RabbitMQ and more operational surface.
- A future Python analysis service can be added without making Python the transactional core today.

**Best fit:** a product whose initial differentiator is heavy Python-native analysis. That is not v0.1.

### Qualitative comparison by requested dimension

| Dimension | A: unified Next.js | B: Next + Node backend | C: Next + FastAPI |
|---|---|---|---|
| Development complexity | Lowest at first; rises when jobs escape request handlers | Moderate and explicit from day one | Highest: two languages and contracts |
| Maintainability | Good while small; boundaries are conventions inside one runtime | Best balance: shared language with explicit process/domain boundaries | Good backend structure, but duplicated TS/Python models |
| GitHub App integration | Excellent Node/Octokit fit | Excellent; dedicated raw-body/callback server | Good, but less direct reuse of TypeScript webhook types |
| Webhook handling | Easy receipt; serverless/runtime limits shape processing | Strongest: stable HTTP process, rapid durable receipt | Equally capable HTTP boundary |
| Background jobs | Needs separate worker/platform despite “unified” label | First-class Node worker | First-class; Celery often adds Redis/RabbitMQ |
| Historical backfills | Awkward in function/request lifecycle | Natural resumable worker workload | Natural resumable worker workload |
| Scheduled reconciliation | Platform cron triggers bounded handlers | Cron enqueues durable jobs; worker executes | Same, with Python scheduler/queue choices |
| Scalability | Frontend scales easily; ingestion must later be extracted | API and worker scale independently with no domain rewrite | Similar runtime scaling; more cross-stack coordination |
| Multi-user SaaS evolution | Possible, but background/security boundary needs discipline | Strong tenant/service boundary and shared types | Strong backend isolation model; frontend contract overhead |
| Private-repository security | Fewer processes, but UI/API/webhook secrets share a blast radius | Dedicated integration services and endpoint allowlists | Dedicated backend is strong; extra supply chain/runtime surface |
| Testing | Simple unit setup; realistic job tests need extra harness | One-language fixtures plus real DB and process-level E2E | Strong Python tests, but cross-language E2E is heavier |
| Observability | Convenient single app, harder to distinguish web/job resources | Clear API/job signals and correlation IDs | Clear signals across two telemetry SDK stacks |
| Deployment complexity | Lowest until an external worker is added | Moderate: web, API, worker commands/images | Highest: separate JS and Python builds/images |
| Local development | Fewest commands initially | Good with one workspace and Docker Compose | More toolchains, virtual environments, and generated clients |
| AI-assisted development | Excellent shared TS context, but architecture can blur | Best: shared schemas/types and small explicit modules | Good within each language; cross-language edits are less reliable |
| Future AI/data analysis | Node is adequate for API-based AI; Python service can be added | Same, with a clean event/data boundary for later Python | Strongest immediate Python library access |
| Vendor lock-in | Can become tied to serverless/cron/function behavior | Low: containers, standard Postgres, queue adapter | Low: containers and standard Postgres; queue choice may add coupling |
| Operational burden | Lowest apparent burden; split deployment eventually | Low–moderate and proportional | Moderate: two runtimes plus likely queue broker |

### Decision matrix

Scores are 1 (poor) to 5 (excellent). Weighted totals are out of 500.

| Criterion | Weight | A: unified Next.js | B: Next + Node backend | C: Next + FastAPI |
|---|---:|---:|---:|---:|
| v0.1 delivery speed | 14 | 5 | 4 | 3 |
| Background jobs/backfills | 15 | 2 | 5 | 5 |
| Webhook reliability | 12 | 3 | 5 | 5 |
| Maintainability | 12 | 4 | 5 | 3 |
| GitHub App ecosystem | 8 | 5 | 5 | 4 |
| Multi-user evolution | 10 | 3 | 5 | 5 |
| Security/isolation | 10 | 3 | 5 | 5 |
| Testing/observability | 8 | 3 | 5 | 4 |
| Deployment/operations | 6 | 5 | 4 | 3 |
| Future AI/analytics | 5 | 3 | 4 | 5 |
| **Weighted total** | **100** | **360** | **478** | **421** |

### Cost and operating profile

These rough monthly ranges are planning envelopes for application compute, worker/queue, and PostgreSQL, excluding AI tokens, high egress, support contracts, and engineering labor. Actual cost must be measured from the vertical slice.

| Scale | A: unified Next.js | B: Next + Node backend | C: Next + FastAPI |
|---|---|---|---|
| Personal/v0.1 | **$0–40** if jobs fit low tiers; **$20–80** once an external worker is admitted | **$20–70** for 2–3 small metered services and restorable DB | **$35–110** due to two runtime services and commonly a broker |
| Small beta (roughly 100 active users) | **$75–400**; function duration and DB connections dominate | **$100–500**; worker concurrency can scale separately | **$150–700**; similar compute plus broker/duplicate telemetry surface |
| Growing SaaS (roughly 10k active users) | **$1k–10k+** and likely pays an extraction/migration cost | **$1k–12k+**, driven by GitHub calls, workers, storage, and HA DB | **$1.5k–15k+**, similar data cost with additional service floor |

All three can use standard containers and PostgreSQL, so vendor lock-in is moderate to low. Option A becomes more platform-shaped when it depends heavily on proprietary serverless scheduling or function primitives. Option B's main operational burden is an additional runnable process; this is justified by the workload.

### Recommendation and rejected alternatives

Choose **Option B**. The winning property is not “more services”; it is that webhook receipt and background correctness are explicit parts of the system.

- Option A is rejected because the apparent simplicity disappears as soon as backfills need checkpointing, rate-limit-aware sleeps, and execution longer than a request window.
- Option C is rejected because Python does not improve the v0.1 ingestion problem enough to justify two production languages. Add a Python analysis consumer later if experiments show a real advantage.
- NestJS is not selected inside Option B because Fastify plus explicit modules is sufficient. Revisit only if team size and dependency-injection complexity materially grow.

## 3. Recommended technology stack

| Concern | Choice | Rationale |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Shared types and targeted builds without custom tooling |
| Frontend | Next.js + React + TypeScript | Mature auth/UI ecosystem and server-rendered read views |
| Backend | Fastify + TypeScript | Small, fast, raw-body-capable webhook server |
| GitHub SDK | Octokit (`@octokit/app`, REST, webhooks) | Officially aligned GitHub App primitives and typed payloads |
| Validation | Zod | Runtime validation at HTTP, webhook, job, and config boundaries |
| Database | PostgreSQL 17+ | Relational integrity, JSONB escape hatch, full portability |
| SQL/migrations | Drizzle ORM + SQL migrations | Typed SQL with visible constraints and low abstraction leakage |
| Jobs | pg-boss, isolated behind `JobPort` | Durable Postgres-backed jobs without Redis in v0.1 |
| Tests | Vitest, Testcontainers, Playwright | Fast unit tests, real Postgres integration, browser onboarding E2E |
| Observability | OpenTelemetry-compatible structured logs + Sentry | Correlation across delivery/job/API; simple hosted error visibility |
| Deployment | Docker images on Railway | Persistent HTTP and worker processes, cron, low initial cost |
| Database hosting | Neon Launch for production | Pooled standard Postgres, scale-to-zero characteristics, restore window |

Suggested monorepo boundaries:

```text
apps/web             Next.js UI and browser session handling
apps/api             Fastify API, OAuth/App callbacks, webhook receipt
apps/worker          Job handlers and scheduler entrypoint
packages/domain      Entity rules, event vocabulary, attribution logic
packages/db          Schema, migrations, repositories, transactions
packages/github      Octokit adapters, payload mapping, API pagination
packages/jobs        Job contracts, queue adapter, outbox dispatch
packages/observability Logging, tracing, metrics helpers
```

Domain packages must not import framework packages. `apps/*` compose dependencies.

## 4. Infrastructure evaluation

### PostgreSQL options

Pricing is volatile; values below are decision inputs verified on 2026-08-21, not contractual budgets.

| Provider | Strengths | Constraints | v0.1 fit |
|---|---|---|---|
| Neon | Standard Postgres, built-in pooler, autoscaling/scale-to-zero behavior, database branching, 7-day restore window on Launch; Free currently includes 0.5 GB and 6-hour restore history; Launch typical spend is advertised around $15/month | Usage billing needs alerts; cold activation adds latency; restore/metrics features vary by plan | **Recommended** for low-idle owner workload; use paid Launch before treating private data as durable production data |
| Supabase | Full Postgres, polished local CLI, Supavisor connection modes, optional Auth/Storage/Realtime; Pro is currently $25/month with 7 days of daily backups and 200 pooled connections on Micro | Product surface is broader than needed; project/compute pricing; PITR is a significant add-on; using proprietary features increases lock-in | Strong alternative if Supabase Auth/RLS becomes valuable |
| Railway Postgres | Same project/private network and simplest topology | Operational assurances and database lifecycle are coupled to hosting plan; fewer database-specific development features | Convenient prototype choice, but not first choice for private historical data |
| Render Postgres | Managed backups/PITR on paid databases, private network with Render services, independent compute/storage | Fixed always-on footprint is usually more expensive at tiny scale; free DB expires | Good all-in-one beta topology |
| Self-managed Postgres | Maximum control, lowest raw VPS price, no product lock-in | Patching, monitoring, backup validation, encryption, restore drills, and HA are now the owner's problem | **Not appropriate** for v0.1 private data |

Supabase documents direct, session-pooler, and transaction-pooler connection modes; Neon and Supabase remain portable because the application uses ordinary PostgreSQL migrations rather than provider APIs. [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Supabase pricing](https://supabase.com/pricing), [Neon pricing](https://neon.com/pricing).

**Database decision:** local Docker PostgreSQL for development and tests; Neon Launch for deployed private-repository use. Run migrations through a one-shot release command using a direct/pool-compatible connection, never automatically from every app replica. Perform a quarterly `pg_dump` restore test to a separate local database.

### Hosting options

| Platform | Webhooks | Jobs/workers | Scheduled work | Assessment |
|---|---|---|---|---|
| Railway | Persistent containers are suitable; simple custom domains | Persistent services and isolated workers | Native cron services; overlapping runs may be skipped | **Recommended v0.1:** least ceremony for mixed web/worker workload; Hobby currently starts at $5 included usage, then metered resources |
| Render | Persistent web services | First-class background workers | Cron with at-most-one active run; up to 12 hours | Most predictable all-in-one alternative; modest fixed cost and more service configuration |
| Fly.io | Excellent long-running containers and regional placement | Flexible Machines | Scheduler must be composed | Powerful but more networking/VM operations than v0.1 needs |
| Vercel | Excellent Next.js frontend and webhook functions | Poor fit for a continuous worker; longer work needs another service | Cron invokes functions; Hobby cron is currently daily and imprecise | Good future frontend host, not the whole ingestion topology |
| Netlify | Suitable webhook functions | Background functions currently capped at 15 minutes | Scheduled functions currently capped at 30 seconds | Good frontend/function platform; still needs an external durable worker for large backfills |

Primary references: [Railway services](https://docs.railway.com/services), [Railway pricing](https://docs.railway.com/pricing/plans), [Render service types](https://render.com/docs/service-types), [Render background workers](https://render.com/docs/background-workers), [Vercel cron constraints](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Netlify function limits](https://docs.netlify.com/build/functions/configuration/).

### Initial deployment topology

```text
GitHub ──HTTPS──> Railway API service ──transaction──> Neon PostgreSQL
                         │                                │
Browser ──HTTPS──> Railway Next.js service               │ jobs/outbox
                         │                                ▼
                         └────────────────────> Railway worker service
                                                          │
                                                          └──> GitHub API
```

Use one region close to the database. Do not introduce Redis in v0.1. Deploy the API and worker from the same image with different commands. If cost pressure is material before launch, run the worker loop inside the API process for development only; production private-repository ingestion should use a separate worker process.

## 5. GitHub authentication and App design

### Credential roles

- **GitHub OAuth login** proves which human is signing in. A GitHub App can perform the same user authorization flow and issue a GitHub App user access token; a separate OAuth App is unnecessary.
- **GitHub App installation** is the repository-owner grant. It selects all or specific repositories and grants only configured repository permissions.
- **Installation access token** authorizes server-to-server repository reads for one installation. The service signs a short-lived JWT with the App private key and exchanges it for a token. Installation tokens expire after one hour and can be narrowed to repositories and permissions. Do not persist them. [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
- **GitHub App user access token** acts as the user and is useful for login and user-scoped endpoints. With expiration enabled it is short lived; the refresh token is longer lived. Store a refresh token only when a concrete user-scoped feature needs it. [GitHub credential types](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types).

### Recommended v0.1 permissions

All permissions are repository-level and **read-only**:

| Permission | Why needed | Data |
|---|---|---|
| Metadata: read | Implicit baseline; repository identity/metadata and installation repository list | repo ID, name, visibility, owner, topics, archive state |
| Contents: read | Required by commit and release endpoints and Git refs | commits, branches, tags, releases |
| Pull requests: read | PR list/details/files and merge state | PR metadata, title/body, labels, timestamps, changed-file summary |
| Issues: read | Issue list/details, labels, milestones | issue metadata, title/body, lifecycle |

Do **not** request Administration, Checks, Actions, Workflows, Deployments, Discussions, Members, or any write permission in v0.1. Contents read technically permits source retrieval, so enforce a product rule that DevMemoir never calls blob/content/archive endpoints. GitHub confirms commit listing requires Contents read, PR listing requires Pull requests read, issue listing requires Issues read, and releases require Contents read. [GitHub permission map](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [commits](https://docs.github.com/en/rest/commits/commits), [pull requests](https://docs.github.com/en/rest/pulls/pulls), [issues](https://docs.github.com/en/rest/issues/issues), [releases](https://docs.github.com/en/rest/releases/releases).

### Webhook subscriptions

Subscribe only to:

- `installation`, `installation_repositories`;
- `repository`;
- `push`, `create`, `delete`;
- `pull_request`;
- `issues`;
- `release`.

MVP-later candidates:

| Signal | Phase | Reason |
|---|---|---|
| Pull-request reviews/comments | v0.2 | Valuable collaboration context but noisy and content-sensitive |
| Discussions | v0.3+ | Not universally enabled and not core to “built” history |
| Deployments | v0.2/v0.3 experiment | Strong shipped-work signal when teams use GitHub Deployments |
| Actions/workflow runs | Later | High event volume and weak direct authorship; cost/privacy concerns |
| Checks/statuses | Later | Operational noise; usually redundant with workflow data |

### Onboarding flow

1. User selects “Continue with GitHub.”
2. API starts the GitHub App user-authorization flow with signed `state`, PKCE where supported, and a short expiry.
3. Callback resolves the stable GitHub user ID and upserts `users` and `github_identities`; create a secure application session.
4. User selects “Connect repositories” and is redirected to the GitHub App installation page.
5. Setup callback validates `state`, records `installation_id`, and verifies the installation belongs to the signed-in GitHub identity.
6. API lists installation repositories; user confirms authorized selections. GitHub remains the access authority.
7. A backfill job is committed and progress is shown.
8. Webhooks begin immediately; backfill and webhook writes converge idempotently.

For v0.1, enforce an `OWNER_GITHUB_USER_ID` allowlist after login. Everything else—the App installation, tenant row, repository grants, jobs, and tokens—uses the multi-user architecture unchanged.

## 6. Ingestion architecture

### Data-source policy

REST is the default for v0.1 because endpoint-specific cursors, ETags, fixtures, and retry behavior are easier to inspect. Use GraphQL only after measuring an endpoint where it materially cuts request count. Always send the pinned GitHub API version header and record it with sync jobs.

### MVP collection contract

| Data | Historical/reconciliation API | Live signal | Normalization note |
|---|---|---|---|
| Installation repositories | `GET /installation/repositories`, then `GET /repos/{owner}/{repo}` | `installation`, `installation_repositories` | GitHub repository numeric ID is the rename/transfer identity |
| Repository metadata | `GET /repos/{owner}/{repo}`, languages/topics endpoints | `repository` | Preserve created, archived, visibility, owner, default branch, pushed timestamps |
| Commits | `GET /repos/{owner}/{repo}/commits` per selected ref; detail only under measured policy | `push` | Push is a change signal; enqueue authoritative range/head sync rather than trusting it as complete history |
| Branches | `GET /repos/{owner}/{repo}/branches` | `create`, `delete`, `push` | Current refs are reachability context, not permanent commit identity |
| Pull requests/merges | `GET /repos/{owner}/{repo}/pulls?state=all`; PR detail and optional files | `pull_request` | Merge is derived from `merged_at`, merger, and merge commit; do not infer from `closed` alone |
| Issues | `GET /repos/{owner}/{repo}/issues?state=all` | `issues` | Exclude objects containing the PR marker; keep labels/milestone |
| Releases | `GET /repos/{owner}/{repo}/releases` | `release` | Distinguish draft, prerelease, published, edited, deleted |
| Tags | `GET /repos/{owner}/{repo}/tags` and Git ref/tag detail only when useful | `create`, `delete`, `push` | A tag is not automatically a GitHub Release |

The REST list-commits endpoint supports `sha`, `since`, `until`, and pagination and requires Contents read. GitHub issue endpoints return pull requests as issue-shaped objects, which must be filtered. [Commit endpoint contract](https://docs.github.com/en/rest/commits/commits), [issue endpoint contract](https://docs.github.com/en/rest/issues/issues).

### Initial backfill

1. `installation.created` or setup completion creates/updates the installation and repository access rows.
2. Enqueue one `installation_inventory` job, then one `repository_backfill` coordinator per repository.
3. The coordinator creates independent resumable stages:
   - repository metadata/languages/topics;
   - branches and tags;
   - commits from default branch;
   - optional commits reachable only from other selected active branches;
   - pull requests, all states;
   - issues, all states (filter out PR-shaped issue results);
   - releases.
4. Each stage requests `per_page=100`, follows GitHub `Link` headers, upserts one page transactionally, and checkpoints the next URL/page plus the stage high-water timestamp.
5. Normalize domain events in the same transaction or via an outbox job keyed to the source entity.
6. A stage completes only after the final page commits. A repository completes only when every required stage completes or is explicitly marked unavailable.

Default-branch commit history is the v0.1 completeness boundary. Enumerating every historical branch can duplicate commits heavily and still cannot recover deleted branch history. Store commit identity once per repository and optional `commit_refs` for currently reachable branches. Document this honestly in the UI.

### Incremental synchronization

- Repository/PR/issue lists use an overlap window: request objects updated since `cursor_time - 10 minutes`, upsert by external ID, and advance the cursor to the maximum source `updated_at` only after the page set succeeds.
- Commits use branch head SHA plus comparison/listing. Re-read from a 24-hour overlap window during daily reconciliation to tolerate force-pushes and clock anomalies.
- Releases, branches, and tags are small enough to list and diff during daily reconciliation.
- Use ETags/`If-None-Match` where supported. A 304 is a successful check, not an empty result.
- Store rate limit remaining/reset values on each job. Pause until `Retry-After` or reset plus jitter. Installation requests currently have a minimum primary budget of 5,000/hour, but secondary limits still apply. [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### Webhook receipt and processing

1. Read the exact raw bytes with a strict size limit.
2. Verify `X-Hub-Signature-256` using constant-time HMAC comparison before JSON parsing.
3. Validate required headers and supported event type.
4. In one database transaction, insert `webhook_deliveries` keyed by `X-GitHub-Delivery`, store a limited raw payload, and enqueue/record an outbox job.
5. Return `202` quickly. A duplicate delivery returns `200/202` without adding another job.
6. Worker claims the delivery, validates its schema, upserts source entities using GitHub source timestamps, emits/updates canonical events, and marks processing status.
7. Unknown actions are retained and marked ignored, not treated as successful known processing.

GitHub delivery GUIDs are globally unique, payloads can be delayed or arrive out of order, and the secure signature header is HMAC-SHA256. [Webhook headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks).

### Reconciliation schedule

| Scope | v0.1 interval | Purpose |
|---|---|---|
| Webhook delivery processing | continuous | Near-real-time updates |
| Failed GitHub App delivery audit | every 6 hours | Detect/redeliver failures within GitHub's three-day window |
| Recently active repositories | every 6 hours, 24-hour overlap | Repair recent PR/issue/commit/release drift |
| All authorized repositories | daily | Inventory, metadata, branches/tags, cursors, permissions |
| Deep rolling reconciliation | weekly, partition repositories | Re-list full PR/issues/releases and bounded commit windows |
| Backup restore drill | quarterly | Prove application-level recoverability |

GitHub does not automatically redeliver failed webhooks; a response taking over 10 seconds is recorded as failed, and deliveries can be redelivered for three days. [Failed delivery behavior](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).

### Idempotency and ordering

- Delivery dedupe key: `github_delivery_guid` unique.
- Source entities: `(repository_id, github_id)` for PR/issues/releases; `(repository_id, sha)` for commits.
- Canonical event key: `(tenant_id, repository_id, source_system, source_kind, source_external_id, verb)`. Repository scope prevents the same commit SHA in forks from colliding.
- Jobs have a unique logical key such as `backfill:{repository_id}:{stage}:{generation}`.
- Source updates apply only when incoming `github_updated_at >= stored.github_updated_at`; equal timestamps still allow missing fields to be filled.
- Deletions/force pushes set reachability/tombstone status. They do not erase previously observed history unless a user deletion policy requires it.
- Never sequence truth by webhook receive time. Keep `occurred_at`, `source_updated_at`, `first_observed_at`, and `last_observed_at` separately.

### Rename, transfer, deletion, and permissions

- Repository numeric `github_repository_id` is the stable identity across rename and transfer. Update owner/name/URL and append `repository_name_history`.
- A 301 is followed safely and metadata is refreshed; a 404/403 triggers installation inventory before concluding deletion.
- Transfer to an account outside the installation marks access `revoked` and the repository `detached`; retained history remains visible per retention policy.
- `installation_repositories` updates access rows immediately.
- Installation suspend/delete prevents token creation, cancels pending API jobs, records disconnect time, and offers retain-or-delete behavior.
- Repository deletion records `deleted_at`/tombstone from the event or repeated authoritative absence. Do not reuse names as identity.

## 7. Canonical domain and event model

### Source entities versus development events

Source tables represent GitHub's current facts. `development_events` is the stable activity vocabulary used by timelines and later analysis.

```text
GitHub source entity       Canonical events
commit                 -> commit.authored, commit.committed
pull_request           -> pull_request.opened, pull_request.merged, pull_request.closed
issue                  -> issue.opened, issue.closed, issue.reopened
release                -> release.published, release.edited
repository             -> repository.created, repository.archived, repository.renamed
tag                     -> tag.created, tag.deleted
```

Do not double-count a merged PR as both “closed” and “merged” in default analytics. Preserve both lifecycle facts if needed, but mark `merged` as the primary contribution event.

### `development_events` shape

| Field | Meaning |
|---|---|
| `id` | Internal UUIDv7 |
| `tenant_id`, `repository_id` | Isolation and project context |
| `actor_github_account_id` | Stable external actor when GitHub can resolve it |
| `event_type`, `verb` | Controlled vocabulary |
| `source_kind`, `source_external_id` | Trace back to source row |
| `contribution_role` | author, committer, opener, merger, releaser, maintainer |
| `occurred_at`, `source_updated_at` | Historical ordering and stale-update defense |
| `title`, `summary_input` | Non-AI factual text suitable for future classification |
| `additions`, `deletions`, `files_changed` | Optional quantitative context, never a score |
| `language_context`, `labels`, `path_hints` | Structured JSONB features |
| `attribution_confidence` | exact GitHub actor, linked commit author, email match, unknown |
| `visibility_snapshot` | public/private/internal at observation time |
| `classification`, `classification_source`, `classification_version` | Nullable future feature/refactor/etc. labels |

### Future classification inputs

Permanently retain commit subject/body, PR/issue title and body (subject to user controls), labels, milestone, release name/body, timestamps, changed file **paths** and aggregate line counts, languages, and relationship links such as PR merge commit SHA and closing issues. Do not retain diff patches or source blobs.

Rule-based classification can precede AI: conventional commit prefixes, labels, file-path groups (`docs/`, tests, CI), release links, and PR metadata. Classifications are versioned annotations, never destructive rewrites of source facts.

### Attribution policy

The memoir view defaults to events attributable to the GitHub account linked to the connected DevMemoir user. A commit is exact when GitHub returns a linked author/committer account ID. Unlinked commits remain repository context with `unknown` or low-confidence attribution; do not silently equate display names. Email-based linking is opt-in and should store an HMAC of normalized email rather than exposing the address. Repository-level releases may be shown as project milestones even when the actor differs, with a visible context label.

## 8. Initial PostgreSQL schema

Use UUIDv7 internal keys, `bigint` for GitHub numeric IDs, `timestamptz` everywhere, and `citext` only where case-insensitive lookup is intentional.

| Table | Important columns and constraints |
|---|---|
| `tenants` | `id PK`, `slug UNIQUE`, `created_at`, `deletion_requested_at` |
| `users` | `id PK`, `primary_tenant_id FK`, `display_name`, `created_at`, `deleted_at` |
| `tenant_members` | `(tenant_id, user_id) PK`, `role`, `created_at`; future membership model |
| `github_accounts` | `id PK`, `github_account_id bigint UNIQUE`, `account_type`, mutable `login`, `node_id`, `avatar_url`, `profile_updated_at`; represents any GitHub actor, not necessarily a DevMemoir user |
| `github_identities` | `id PK`, `user_id FK`, `github_account_id FK`, `linked_at`, `verified_at`, UNIQUE `(user_id,github_account_id)`; links a DevMemoir user to an external account |
| `github_user_credentials` | `github_identity_id PK/FK`, encrypted refresh/access material only if required, `expires_at`, `key_version` |
| `github_installations` | `id PK`, `tenant_id FK`, `github_installation_id bigint UNIQUE`, `account_github_account_id FK`, `status`, `permissions jsonb`, `repository_selection`, `suspended_at`, `deleted_at` |
| `repositories` | `id PK`, `tenant_id FK`, `github_repository_id bigint`, `node_id`, mutable `owner_login/name/full_name`, visibility flags, default branch, description, topics/languages jsonb, `github_created_at/updated_at/pushed_at`, `archived_at/deleted_at`; UNIQUE `(tenant_id,github_repository_id)`, index `(tenant_id,pushed_at DESC)` |
| `repository_access` | `id PK`, `tenant_id FK`, `repository_id FK`, `installation_id FK`, `access_status`, `selected_at`, `revoked_at`; UNIQUE `(tenant_id,repository_id,installation_id)`, index `(tenant_id,access_status)` |
| `repository_name_history` | `id PK`, `tenant_id FK`, `repository_id FK`, owner/name/full_name, `valid_from`, `valid_to`; index on tenant/repository/time |
| `branches` | `id PK`, `tenant_id FK`, `repository_id FK`, `name`, `head_sha`, `protected`, `last_seen_at`, `deleted_at`, UNIQUE `(tenant_id,repository_id,name)` |
| `tags` | `id PK`, `tenant_id FK`, `repository_id FK`, `name`, `target_sha`, `tagger_*`, `last_seen_at`, `deleted_at`, UNIQUE `(tenant_id,repository_id,name)` |
| `commits` | `id PK`, `tenant_id FK`, `repository_id FK`, `sha`, author/committer GitHub account FKs nullable, message, author/committer timestamps, parent SHAs jsonb, stats, verification fields, `first_seen_at`; UNIQUE `(tenant_id,repository_id,sha)`; indexes on tenant/repository/author date and actor/date |
| `commit_files` | `tenant_id FK`, `(commit_id,path) PK`, status, additions/deletions/changes, previous path; **no patch column** |
| `commit_refs` | `tenant_id FK`, `(commit_id,branch_id) PK`, `last_seen_at`, `reachable` |
| `pull_requests` | `id PK`, `tenant_id FK`, `repository_id FK`, `github_pull_request_id bigint`, `number`, actor account FKs, state/draft, title/body, head/base refs and SHAs, labels jsonb, created/updated/closed/merged timestamps, merge commit SHA, stats; UNIQUE `(tenant_id,repository_id,github_pull_request_id)`, UNIQUE `(tenant_id,repository_id,number)` |
| `issues` | `id PK`, `tenant_id FK`, `repository_id FK`, `github_issue_id bigint`, `number`, actor account FKs, state/reason, title/body, labels/milestone jsonb, created/updated/closed timestamps; same two uniqueness patterns |
| `releases` | `id PK`, `tenant_id FK`, `repository_id FK`, `github_release_id bigint`, author account FK, tag/name/body, draft/prerelease, target, created/published/updated timestamps; UNIQUE `(tenant_id,repository_id,github_release_id)` |
| `development_events` | fields from section 7; UNIQUE `(tenant_id,repository_id,source_system,source_kind,source_external_id,verb)`; indexes `(tenant_id,occurred_at DESC)`, `(tenant_id,repository_id,occurred_at DESC)`, `(tenant_id,actor_github_account_id,occurred_at DESC)` |
| `webhook_deliveries` | `id PK`, `tenant_id FK nullable until installation resolution`, `github_delivery_guid varchar(64) UNIQUE`, event/action, installation/repository external IDs, headers allowlist jsonb, `payload_ciphertext bytea`, `payload_key_version`, received/processed timestamps, status, attempts, error_code, `payload_expires_at`; indexes on status/received and expiry; invalid-signature bodies are not retained |
| `sync_jobs` | `id PK`, `tenant_id`, installation/repository FKs, kind/stage/status, `logical_key UNIQUE`, attempt/max_attempts, scheduled/started/finished/heartbeat timestamps, rate-limit snapshot, error_code/sanitized message |
| `sync_cursors` | `tenant_id FK`, `(repository_id,resource_type) PK`, cursor jsonb, high_water_at, etag, last_success_at, last_full_reconcile_at, schema_version |
| `outbox` | `id PK`, `tenant_id FK`, aggregate type/id, event type, payload jsonb, created/published timestamps; index tenant/unpublished |
| `audit_log` | `id PK`, tenant/user IDs, action, target type/id, metadata allowlist, occurred_at; no private content |

All collected private/source tables carry `tenant_id` directly so future RLS does not depend on fragile multi-hop joins. This intentionally duplicates source facts if two tenants authorize the same repository; the privacy and deletion boundary is worth more than storage deduplication at expected scale. Foreign keys should normally restrict tenant/user deletion until the explicit deletion workflow runs. Source rows use `ON DELETE CASCADE` only inside a repository purge transaction. Add database checks for valid states and nonnegative stats.

### Permanent versus limited-retention data

**Permanent while connected/retained:** stable IDs, repository metadata/history, normalized source records, commit messages, PR/issue/release semantic content according to user setting, aggregate stats, file paths, events, cursors, and minimal audit history.

**Limited retention (default 30 days):** raw webhook payloads and sanitized processing errors. Shorten to 7 days after operational confidence. Failed/dead-letter payloads may be retained up to 90 days with explicit restricted access.

**Never store:** GitHub App installation tokens, App JWTs, repository clones, blobs, file contents, diff patches, Actions logs/artifacts, secret values, or arbitrary request headers.

## 9. Privacy and security review

### Threats and controls

| Threat | Required control |
|---|---|
| App private key theft compromises all installations | Provider secret store initially; never DB/git/log; restrict service access to API/worker; rotate and delete old keys; move to sign-only KMS/HSM before public beta |
| Installation token leakage | Mint just in time, keep in memory, scope down where useful, redact authorization headers, never enqueue or persist token |
| OAuth/user refresh token theft | Avoid storing unless required; envelope-encrypt with AES-256-GCM and versioned KMS-managed key; separate decrypt permission |
| Forged/replayed webhook | Verify raw-body HMAC-SHA256 constant-time; GUID unique constraint; size/content-type limits; reject before parsing |
| Cross-tenant data access | Tenant-scoped repository methods, compound ownership checks, negative integration tests; add PostgreSQL RLS before multi-user beta as defense in depth |
| Private content in logs/traces | Structured allowlist logging; no payload/body/message/path logging; scrub exception context and APM breadcrumbs |
| Overcollection via Contents permission | Endpoint allowlist blocks contents/blobs/archive/compare patches; no cloning; record outbound endpoint metrics |
| Database or backup disclosure | TLS, provider encryption at rest, paid backups, least-privilege DB roles, restricted exports, restore audit |
| Dependency/supply-chain compromise | Lockfile, automated updates, provenance-aware CI, secret scanning, minimal runtime image, dependency audit |
| Future AI provider receives private data unexpectedly | Per-tenant opt-in, preview exact data class, no training by contract/config, DPA and retention review, prompt/output audit with redaction |

The GitHub App private key grants access across installations and must receive the strongest protection. GitHub explicitly recommends minimum permissions, secure credentials, webhook secrets, expiring tokens, and deletion capability. [GitHub App security practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

### Data minimization

**Required:** external IDs, timestamps, repository visibility/access state, commit messages and linkage, PR/issue/release titles and lifecycle, installation/cursor state, normalized events.

**Useful but optional/user-controlled:** PR/issue/release bodies, changed file paths, line-count aggregates, labels, languages, low-confidence commit email linking.

**Prefer not to store:** raw source, patches, comments/reviews in v0.1, workflow logs, artifacts, full webhook payloads beyond debugging retention, user email addresses.

Offer a “metadata-minimal” mode later that stores titles/messages but omits bodies and file paths. In all modes, UI must mark private repositories and prevent public sharing by default.

### Disconnect and deletion

- **Uninstall/disconnect:** immediately stop token creation and jobs; mark access revoked; retain history privately for a configurable grace period (proposed 30 days) or delete immediately at user request.
- **Repository removed from installation:** stop new collection; retain/detach history under the same policy.
- **Account deletion:** create auditable deletion job, revoke sessions/tokens, purge tenant rows and payloads, then request/track provider backup expiry. Return confirmation without claiming backup erasure before provider retention expires.
- Provide export-before-delete in a later phase; deletion must not depend on it.

## 10. Reliability model

### Failure handling

| Failure | Behavior |
|---|---|
| Webhook handler crash before commit | GitHub records failure; six-hour delivery audit requests redelivery; API reconciliation also repairs state |
| Crash after commit before response | Redelivery hits GUID unique constraint and returns success |
| Worker crash | Job lease/heartbeat expires; another worker retries; page transaction prevents half-page checkpoint |
| GitHub 5xx/network error | Exponential backoff with full jitter: 5s base, cap 15m, max 8 transient attempts |
| GitHub primary/secondary rate limit | Honor `Retry-After`/`X-RateLimit-Reset`; pause installation lane; reduce concurrency; never hot-loop |
| Database outage | Webhook returns failure because durability is unavailable; delivery audit/redelivery and reconciliation recover later |
| Duplicate/replay | Delivery GUID and entity/event unique constraints make it a no-op with observation timestamps updated |
| Delayed/out-of-order update | Apply by source timestamps and authoritative re-fetch ambiguous entities |
| Partial backfill | Resume last committed stage/page with overlapping upserts |
| Deployment during delivery | Graceful shutdown stops accepting traffic, finishes current transaction, releases jobs; duplicate-safe redelivery |
| Poison payload | After 5 deterministic failures, mark dead-letter with error code and restricted payload; alert owner |

Retry classifications matter: do not retry authentication/permission 401/403 indefinitely; refresh installation state. Treat 404 as ambiguous until repository inventory confirms access loss. Treat schema/validation failures as deterministic and alert.

### Early-stage proportionality

Use pg-boss leases, retries, and cron rather than Redis plus a separate scheduler. Keep dead-letter state in PostgreSQL and provide an authenticated owner-only retry action. Introduce Redis/SQS only when database job contention, independent scaling, or measured throughput requires it.

### Service objectives for v0.1

- 99% of valid webhook receipts durably acknowledged within 2 seconds under expected load.
- 95% of supported events visible within 2 minutes.
- Daily reconciliation completes for all authorized repositories.
- Zero known cross-tenant reads.
- Backfill progress is monotonic and restartable; no manual database edits required.

## 11. MVP roadmap

### v0.1 — Foundation

- Owner-only GitHub App login and installation.
- Explicit public/private repository authorization.
- Historical import of repository metadata, default-branch commits, PRs, issues, branches/tags, and releases.
- Supported webhooks and near-real-time normalization.
- Durable resumable jobs, cursors, reconciliation, delivery audit, and basic operational status.
- Minimal private activity page: repository, date, actor/role, event type, source link.
- Disconnect and delete controls; raw payload expiry.

**Success test:** for a selected repository, the timeline consistently explains commits, merged PRs, issues, and releases across backfill plus new activity, and reconciliation repairs an intentionally skipped webhook.

### v0.2 — Dashboard & analytics

- Cross-repository calendar/timeline, project attention by time/event counts (never productivity score), filters.
- Rule-based classifications and project milestones.
- Review/deployment experiments, richer attribution controls, exports.
- Data-quality/completeness indicators.

### v0.3 — AI Chronicle

- Explicit opt-in AI summaries for week/month/year and project evolution.
- Evidence-linked statements, prompt/model versioning, redaction controls, evaluation set, regenerate/delete.
- Optional Python analysis service only if experiments justify it.

### v0.4 — Multi-user beta

- Remove owner allowlist, tenant RLS, quotas, plan limits, support tooling, abuse controls.
- Formal privacy/terms/DPA review, incident runbook, stronger KMS-backed key custody.
- Billing and per-user installation lifecycle.

### Later

- Organizations, team-aware permissions, public profiles/sharing, Discussions/Actions integrations, richer deployment signals, external imports.

## 12. Testing strategy

### Unit tests

- Raw-body signature verification including Unicode, wrong secret, missing/malformed headers, timing-safe comparison.
- Payload-to-domain mapping for every supported action.
- Event key construction and stale-update rejection.
- Retry classification/backoff and rate-limit scheduling.
- Attribution confidence and rule-based classification.
- Secret/log redaction.

### Integration tests with real PostgreSQL

- Two concurrent inserts of the same delivery produce one job.
- Replayed delivery is a no-op.
- Newer then older payload cannot regress source state.
- Page upsert and cursor update are atomic.
- Worker lease expiry resumes safely.
- Pagination follows mocked `Link` headers and handles empty/final pages.
- Backfill restart/resume and overlap window.
- Rename preserves repository internal identity and history.
- Installation repository removal/re-add.
- Private-repository 403/404 classification.
- Uninstall cancels jobs and blocks token minting.
- Permission changes update capability state.
- Tenant A cannot query any Tenant B row through every repository method.
- Migrations apply from empty DB and upgrade a previous snapshot; down migrations are not required in production, but rollback procedure is tested.

### End-to-end tests

- GitHub test App/sandbox account: login → install on one repository → backfill → visible event.
- Send a signed fixture twice; one timeline event appears.
- Create/merge a PR and observe near-real-time event.
- Suppress one webhook, run reconciliation, and observe repair.
- Rename repository; links/name change without duplicate project.
- Remove private repository permission; UI shows disconnected and no further API reads occur.
- Uninstall App; jobs stop and disconnect state appears.
- Account deletion removes live rows and invalidates session.

Use recorded, redacted GitHub fixtures for most CI tests. Run live GitHub tests nightly/manual because API behavior and rate limits make them unsuitable for every commit.

## 13. Observability

Every request/job log carries only opaque IDs: `request_id`, delivery GUID, job ID, tenant ID, installation ID, repository internal ID, event type, attempt, duration, result, and rate-limit bucket. Never log repository names, commit messages, bodies, file paths, payloads, or tokens by default.

Minimum metrics:

- webhook receipt count/latency/signature failures/duplicates by event type;
- delivery processing lag and dead-letter count;
- queue depth, oldest job age, attempts, duration by job kind;
- GitHub request count/status/remaining quota per installation;
- backfill stage progress and last reconciliation age;
- database errors and pool saturation;
- raw-payload expiry backlog.

Alerts for oldest supported webhook >10 minutes, dead-letter >0, reconciliation older than 36 hours, repeated auth failures, and payload deletion lag >24 hours.

## 14. ADR summary

The proposed records are in [`docs/architecture/adr`](./adr/):

1. Option B TypeScript modular monolith with separate process boundaries.
2. PostgreSQL as durable system of record; Neon hosted, Docker local.
3. GitHub App user authorization plus per-installation access tokens.
4. Durable-accept/async-process webhook architecture.
5. PostgreSQL-backed jobs initially.
6. Normalized development-event projection over source entities.
7. Railway container hosting with separable API/worker processes.

## 15. Highest risks, unresolved decisions, and readiness

### Five highest architectural risks

1. **Historical completeness and attribution:** Git history, deleted branches, rebases, squash merges, and unlinked commit identities prevent a perfect personal record.
2. **Private-data exposure:** Contents permission is broader than actual needs; a logging, endpoint, tenant, or AI boundary mistake could expose sensitive material.
3. **Webhook gaps mistaken for truth:** GitHub does not automatically retry failed deliveries, so delivery auditing and reconciliation are product-critical, not optional polish.
4. **Rate-limit/backfill growth:** Per-commit detail calls and many repositories can exhaust primary or secondary limits unless page checkpoints, concurrency lanes, and endpoint budgets are measured.
5. **Premature schema semantics:** Double-counting PR merges/commits or confusing project context with personal contribution can make analytics untrustworthy even when ingestion is technically correct.

### Unresolved decisions and required experiments

| Decision | Experiment before commitment |
|---|---|
| Default-branch-only versus all-active-branch commit backfill | Run both on the owner's 5 largest/divergent repositories; measure unique commits, requests, time, and perceived missing history |
| Whether to fetch per-commit file stats in v0.1 | Sample 10k commits; measure requests, rate-limit cost, storage, and classification value |
| pg-boss operational fit | Kill workers mid-page and during deployment; load 100k jobs; verify lease recovery, queue latency, and DB contention |
| PR/issue full body default | Compare usefulness and privacy/storage impact; expose owner control before public beta |
| Railway + Neon region/network behavior | Deploy vertical slice; measure webhook p95, DB connection stability, cold behavior, and monthly projected cost for two weeks |
| GitHub identity matching | Audit a representative owner history and quantify exact linked, committer-only, ambiguous, and unmatched commits |

### Exact first implementation milestone

Create the GitHub App and smallest deployable vertical slice for **one allowlisted owner and one selected repository**: authenticate, install, import repository metadata plus the newest 100 default-branch commits, receive and verify a `push` webhook, durably deduplicate it, normalize commit events, and render one chronological activity page. Restart the worker midway and replay the webhook to prove resume/idempotency.

Detailed milestones and acceptance tests are in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

### Assessment

**GO WITH CONDITIONS.** Begin implementation once the GitHub App permissions are verified against a private test repository, paid restorable PostgreSQL is selected before any irreplaceable private history is relied upon, log redaction is present in the first slice, and the first milestone includes idempotency/restart tests. No unresolved decision blocks the vertical slice.
