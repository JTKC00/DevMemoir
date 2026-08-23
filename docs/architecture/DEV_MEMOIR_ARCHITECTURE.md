# DevMemoir Architecture Report

**Status:** Reconciled — GO WITH CONDITIONS
**Reconciled against:** [ADVERSARIAL_REVIEW_GROK.md](./ADVERSARIAL_REVIEW_GROK.md)
**Decision date:** 2026-08-21
**Scope:** v0.1 foundation through a credible multi-user SaaS path
**Audience:** Product owner and implementers

## Executive decision

Build DevMemoir as a **TypeScript modular monolith in a pnpm monorepo**, with three logical applications:

1. a Next.js web application for sign-in, onboarding, and read views;
2. a Fastify HTTP application for GitHub callbacks, webhooks, and the internal API;
3. a Node.js worker for backfills, normalization, and reconciliation.

Use PostgreSQL as the system of record and, initially, a PostgreSQL-backed durable job queue. Keep the API and worker as separately runnable processes. Co-hosting the worker in the API is permitted for local development only, never for deployed private-repository ingestion. Deploy containers on Railway and use paid, always-on Neon PostgreSQL. Develop against local Docker PostgreSQL.

This is Option B, implemented without microservices. It creates a hard reliability boundary around webhook and background processing while preserving one language, one repository, one schema, and one deployment model. Only `apps/api` and `apps/worker` may write GitHub-derived tables; `apps/web` is a tenant-scoped reader and browser-session boundary.

## 1. Goals, non-goals, and design principles

### Goals

- Reliably explain observed work in repositories the user explicitly connected, from durable historical and live data.
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
- **DevMemoir records connected repositories, not every contribution a developer has ever made on GitHub.**
- **Completeness is product data:** every view distinguishes observed, reachable-at-sync, known-unknown, and out-of-scope facts.

### v0.1 product and completeness contract

The v0.1 promise is deliberately narrower than the long-term vision:

> DevMemoir records what happened in repositories you connected. It does not claim to contain every contribution your GitHub user has ever made.

Installation tokens cannot see contributions to repositories that were not granted to the App, including most open-source contributions, organization repositories without an organization installation, and private repositories owned by somebody else. v0.1 must not use a user token to scrape around that boundary.

Every timeline and import status exposes one of four completeness states:

1. **Observed:** a source fact DevMemoir successfully stored.
2. **Reachable at sync:** a commit/ref was reachable from the configured default branch or currently enumerated ref at the last successful sync.
3. **Known unknown:** deleted refs, force-push gaps, unlinked actors, temporarily truncated/missed webhooks, or unavailable source facts.
4. **Out of scope:** repositories not connected, Organizations in v0.1, reviews, Actions, submodule history, LFS objects, and source contents.

The Milestone 1 UI uses the exact copy: **“Newest 100 commits currently reachable from the default branch of this connected repository.”** It must not label that slice “your GitHub history.”

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
| Observability | Allowlist-only structured logs; optional OpenTelemetry/Sentry after scrubber tests | Correlate opaque IDs without exporting private payloads, names, messages, bodies, or paths |
| Deployment | Docker images on Railway | Persistent HTTP and worker processes, cron, low initial cost |
| Database hosting | Neon Launch, always-on for deployed private data | Pooled URL for web/API; direct URL for worker/pg-boss; paid restore window |

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

Provider prices and plan limits are volatile and excluded from the architecture decision. Re-verify the linked primary pages during procurement and maintain a measured monthly budget/alert; the durable criteria are connection mode, always-on behavior, backup/restore, portability, and operator burden.

| Provider | Strengths | Constraints | v0.1 fit |
|---|---|---|---|
| Neon | Standard Postgres, built-in pooler, optional autoscaling/branching, paid restore capability | Public cross-provider path from Railway; cold activation if allowed; plan-dependent restore/metrics; direct versus pooled topology must be explicit | **Recommended** with paid, always-on compute and a restore drill before real private-data reliance |
| Supabase | Full Postgres, polished local tooling, explicit direct/session/transaction pooler modes, optional Auth/Storage/Realtime | Broader product surface; plan-dependent compute/PITR; proprietary features increase lock-in | Strong alternative if its auth/RLS/platform surface becomes valuable |
| Railway Postgres | Same project/private network and simplest topology | Database lifecycle/assurances coupled to hosting and fewer database-specific development features | Convenient prototype, not first choice for durable private history without equivalent restore evidence |
| Render Postgres | Managed paid backups/PITR, private network with Render services, independent compute/storage | More fixed always-on footprint and service configuration | Conservative all-in-one beta alternative |
| Self-managed Postgres | Maximum control and no product API lock-in | Owner assumes patching, monitoring, encryption, backup validation, restore, and HA | **Not appropriate** for v0.1 private data |

Supabase documents direct, session-pooler, and transaction-pooler connection modes; Neon and Supabase remain portable because DevMemoir uses ordinary PostgreSQL migrations rather than provider APIs. [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Supabase pricing](https://supabase.com/pricing), [Neon pricing](https://neon.com/pricing).

**Database decision:** local Docker PostgreSQL for development/tests; paid always-on Neon for deployed private-repository use. Web/API use the pooled URL with single-digit per-process pools; worker/pg-boss and one-shot migrations use the direct URL with a small pool. Do not depend on `LISTEN/NOTIFY` through the transaction pooler. Run migrations once per release, never from every replica. Complete an isolated provider-backup restore before Gate A and repeat quarterly.

### Hosting options

| Platform | Webhooks | Jobs/workers | Scheduled work | Assessment |
|---|---|---|---|---|
| Railway | Persistent containers and custom domains | Persistent isolated worker services | Native cron services; overlap semantics must be verified | **Recommended v0.1:** least ceremony for mixed web/worker workload; cost is measured during M7, not assumed |
| Render | Persistent web services | First-class background workers | Cron/overlap limits are plan/runtime dependent | Most predictable all-in-one alternative with more fixed service configuration |
| Fly.io | Long-running containers and regional placement | Flexible Machines | Scheduler must be composed | Powerful but more networking/VM operations than v0.1 needs |
| Vercel | Strong Next.js frontend and webhook functions | Poor fit for the required continuous worker without another service | Cron invokes request-scoped functions | Possible future frontend host, not the whole ingestion topology |
| Netlify | Suitable webhook functions | Background/scheduled execution remains bounded and plan-dependent | Request/job limits require re-verification | Good frontend/function platform; still needs an external durable worker for large backfills |

Primary references: [Railway services](https://docs.railway.com/services), [Railway pricing](https://docs.railway.com/pricing/plans), [Render service types](https://render.com/docs/service-types), [Render background workers](https://render.com/docs/background-workers), [Vercel cron constraints](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Netlify function limits](https://docs.netlify.com/build/functions/configuration/).

### Initial deployment topology

```text
GitHub ──HTTPS──> Railway API ──pooled transaction──> Neon PostgreSQL
                         │                                  ▲
Browser ──HTTPS──> Railway Next.js ──read/API───────────────┤
          host-only      │                                  │ direct, small pool
          session        └──server-side auth handoff        │
                                                            │
                    Railway worker + pg-boss ────────────────┘
                              │
                              └──installation/App JWT──> GitHub API
```

Use one region close to the database and measure the public Railway↔Neon path. Do not introduce Redis in v0.1. Deploy API and worker from the same image with different commands. Running a worker loop inside the API is a local-development convenience only; deployed private ingestion always uses a separate worker. The App private key is available only to API and worker, not to web.

## 5. GitHub authentication and App design

### Credential roles

- **GitHub OAuth login** proves which human is signing in. A GitHub App performs the user authorization flow; a separate OAuth App is unnecessary.
- **GitHub App installation** is the repository-owner grant. It selects all or specific repositories and grants only configured repository permissions.
- **Installation access token** authorizes server-to-server repository reads for one installation. The service signs a short-lived JWT with the App private key and exchanges it for a token. Installation tokens expire after one hour and can be narrowed to repositories and permissions. Do not persist them. [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).
- **GitHub App user access token** acts as the user for login/user-scoped endpoints. v0.1 uses it only long enough to resolve the stable GitHub account and then discards it; `github_user_credentials` remains unpopulated unless a later user-scoped feature is approved. User-to-server token expiration stays enabled. [GitHub credential types](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types).
- **GitHub App JWT** authenticates as the App. It mints installation tokens and powers the six-hour App webhook-delivery audit. Only API/worker may mint it.

### Recommended v0.1 permissions

All permissions are repository-level and **read-only**:

| Permission | Why needed | Data |
|---|---|---|
| Metadata: read | Implicit baseline; repository identity/metadata and installation repository list | repo ID, name, visibility, owner, topics, archive state |
| Contents: read | Required by commit and release endpoints and Git refs | commits, branches, tags, releases |
| Pull requests: read | PR list/details and merge state | PR metadata, title, labels, timestamps; bodies/files are not collected in M1 |
| Issues: read | Issue list/details, labels, milestones | issue metadata, title, lifecycle; bodies are not collected in M1 |

Do **not** request Administration, Checks, Actions, Workflows, Deployments, Discussions, Members, or any write permission in v0.1. Contents read is unavoidably broader than the product. GitHub confirms commit listing requires Contents read, PR listing requires Pull requests read, issue listing requires Issues read, and releases require Contents read. [GitHub permission map](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [commits](https://docs.github.com/en/rest/commits/commits), [pull requests](https://docs.github.com/en/rest/pulls/pulls), [issues](https://docs.github.com/en/rest/issues/issues), [releases](https://docs.github.com/en/rest/releases/releases).

The GitHub adapter is a **permit-list**, not a deny-list. It permits installation inventory; repository metadata/languages/topics; branches/tags; commit list/get as JSON; PRs; issues; and releases. Compare is avoided by default; if used for ancestry/range metadata, `files[].patch` is discarded inside response parsing before logging, tracing, persistence, or job serialization. The adapter rejects `/contents`, `/git/blobs`, `/zipball`, `/tarball`, clones, source/file contents, and diff/patch media types.

### Webhook subscriptions and mandatory handlers

Subscribe only to:

- `installation`, `installation_repositories`;
- `repository`;
- `push`, `create`, `delete`;
- `pull_request`;
- `issues`;
- `release`.

The webhook route also accepts `ping` and `github_app_authorization` with 2xx. A revoked `github_app_authorization` drops any user token material if it ever exists; it does not mutate repository facts. Signed but unsupported event types are acknowledged and metered rather than returned as 4xx. Unknown actions on subscribed events become `ignored`. Add `installation_target` with Organization work, not M1.

MVP-later candidates:

| Signal | Phase | Reason |
|---|---|---|
| Pull-request reviews/comments | v0.2 | Valuable collaboration context but noisy and content-sensitive |
| Discussions | v0.3+ | Not universally enabled and not core to “built” history |
| Deployments | v0.2/v0.3 experiment | Strong shipped-work signal when teams use GitHub Deployments |
| Actions/workflow runs | Later | High event volume and weak direct authorship; cost/privacy concerns |
| Checks/statuses | Later | Operational noise; usually redundant with workflow data |

### Required GitHub App settings

| Setting | v0.1 value |
|---|---|
| Request user authorization during installation | **Off**; login and installation remain separate, preserving `state` |
| OAuth callback URL | Fastify OAuth callback only |
| Setup URL | Fastify installation setup/claim entry only; distinct from OAuth callback |
| Redirect on update | On, with installation inventory polling as fallback |
| User-to-server token expiration | On |
| App visibility | Private until multi-user/Marketplace readiness |

### Chosen session and callback topology

DevMemoir uses a one-time server-side auth handoff rather than a parent-domain cookie:

1. Web asks API to start login. API creates a 10-minute `auth_transaction` containing a hashed one-time `state`, PKCE `S256` verifier, return origin, and consumed flag. The verifier stays server-side.
2. GitHub returns to the Fastify OAuth callback. API atomically consumes `state`, exchanges the code with PKCE, resolves `github_account_id`, applies `OWNER_GITHUB_USER_ID`, and creates/links the DevMemoir user.
3. API rotates the login transaction into a one-time handoff code, stores only its hash, and redirects to the fixed web origin.
4. Next.js exchanges the handoff server-to-server exactly once, receives an opaque application-session token, and sets a host-only `__Host-devmemoir_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`). A new session ID is created after login.
5. Browser state-changing requests require CSRF protection in addition to the session cookie. Redirect targets are allowlisted; no arbitrary return URL is accepted.
6. An authenticated web session asks API for an installation URL. Its signed one-time `state` binds tenant, user, expected GitHub account, expiry, and nonce.
7. Setup callback with valid state calls `GET /app/installations/{installation_id}` and requires `account.type == User` plus `account.id == signed-in github_account_id`. Organization installations are rejected in v0.1.
8. GitHub-originated installation with no state is never bound in the callback. API redirects to an authenticated web claim page; the web session submits `installation_id`, and API performs the same account check before binding.
9. API always paginates `GET /installation/repositories`; it never treats the repository array in `installation.created` as complete.
10. A backfill job is committed and progress is shown. Webhooks may arrive first; backfill and live writes converge idempotently.

For v0.1, enforce `OWNER_GITHUB_USER_ID` before tenant creation. Everything else—the installation, tenant rows, repository grants, jobs, and session model—uses the multi-user architecture unchanged.

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

The concrete M3 cursor, atomic page, rate-pause, and completeness contract is recorded in [M3_BACKFILL_CONTRACT.md](./M3_BACKFILL_CONTRACT.md). That contract narrows the optional stage list below to the selected repository's default-branch-first M3 implementation; all-active-branch traversal remains deferred.

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

- PRs, issues, and releases use a 10-minute overlap on source `updated_at`. The job defines a bounded window, completes every page, commits entity upserts plus the window checkpoint atomically, and only then advances `high_water_at`. The next run begins at `high_water_at - overlap`; it never advances a cursor per page. Equal timestamps are re-read and upserts accept `incoming.github_updated_at >= stored.github_updated_at` so same-second fields can fill without regressing newer state.
- Commit synchronization is **ref-head based**, not time-cursor based. Store every tracked branch `head_sha`. If the new head equals the stored head, no-op. Otherwise walk/list from the new head until the old head or a configured request/commit bound. If the old head is not an ancestor, or the push is forced/diverged, mark commits reachable only from that ref as unreachable and import the new walk. Preserve commit rows as observed history; never delete them because a ref moved.
- A 24-hour committer-date overlap is an additional repair heuristic, not the primary commit cursor. GitHub commit `since` is a Git committer-date filter and cannot prove force-push completeness.
- Releases, branches, and tags are listed/diffed during daily reconciliation; payload caps and multi-tag webhook omissions make API inventory authoritative.
- Use ETags/`If-None-Match` where supported. A 304 is a successful check, not an empty result.
- Store rate-limit remaining/reset values on each job. Honor `Retry-After` and reset headers with jitter. Limit each installation to one or two GitHub requests in flight; secondary limits are expected before the primary 5,000/hour budget during large backfills. [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### Webhook receipt and processing

1. Perform cheap method/content-type/header checks and reject declared/streamed bodies above 2 MB with 413. GitHub can omit payloads above its own 25 MB cap; reconciliation repairs those gaps.
2. Read the bounded exact raw bytes and verify `X-Hub-Signature-256` using constant-time HMAC comparison before JSON parsing. During secret rotation, accept current or previous secret for a short, dated overlap window.
3. Parse only after signature success. Zod envelopes strip/passthrough unknown fields and validate only fields DevMemoir persists. A deleted/ghost actor is nullable and cannot crash a projector.
4. In one database transaction, insert or update `webhook_deliveries` keyed by `X-GitHub-Delivery`, store encrypted limited-retention payload bytes, and create/ensure one logical processing job through the outbox.
5. Return 2xx promptly after durable receipt. Invalid signatures/bodies are not stored. Signed unsupported event types and unknown actions are acknowledged as `ignored` with a metric, not 4xx/5xx.
6. Worker claims the row, moves it through the state machine, re-fetches authoritative source facts where required, applies source-timestamp upserts, projects events, and marks the row `processed` or `ignored` only after the transaction succeeds.
7. For `push`, persist only `ref`, `before`, `after`, `forced`, repository/installation IDs, and receipt metadata needed to enqueue `sync_commits`. Never create commit rows from `payload.commits[]`. A zero `after` SHA/branch delete updates ref reachability and does not invent commit history.

`X-GitHub-Delivery` identifies the GitHub event, not a successful HTTP/worker attempt. Redeliveries keep the same GUID. The row state machine is:

| State | Meaning | Same-GUID receipt behavior |
|---|---|---|
| `received` | Durable receipt exists; job not yet claimed | Ensure the existing logical job is queued |
| `processing` | Worker lease active | Return 2xx; do not create a parallel job; lease recovery resumes if stale |
| `failed` | Transient processing failure | Re-enqueue/resume the same row according to retry policy |
| `dead_letter` | Retry budget exhausted/deterministic failure | Explicit redelivery or owner retry reopens the same row and job; preserve audit fields |
| `processed` | Source/event transaction completed | Return 2xx; no new job |
| `ignored` | Authenticated but unsupported/non-domain event/action | Return 2xx; no new job |

Store `receipt_count`, `last_received_at`, processing attempts, sanitized error code, and job/lease reference. The GUID unique constraint prevents a second event row; entity and event natural keys provide the deeper idempotency when different deliveries describe the same GitHub entity. [Webhook headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks).

### Reconciliation schedule

| Scope | Gate A interval | Purpose |
|---|---|---|
| Webhook delivery processing | continuous | Near-real-time updates |
| Failed GitHub App delivery audit | every 6 hours | App-JWT audit/redelivery within GitHub's three-day window |
| Recently active repositories | every 6 hours, bounded overlap/head walk | Repair recent PR/issue/commit/release drift without full re-list |
| All authorized repositories | daily | Paginated inventory, metadata, branches/tags, cursors, permissions |
| Deep rolling reconciliation | after Gate A / v0.2 | Partitioned full PR/issue/release and bounded commit checks if measured drift justifies it |
| Backup restore drill | quarterly | Prove application-level recoverability |

The delivery audit uses an App JWT (not a user or installation token), pages newest-first, stops when `delivered_at` is older than its durable cursor, and requests redelivery only when no attempt for the GUID succeeded. GitHub does not automatically redeliver failed webhooks; a response taking over 10 seconds is recorded as failed, and deliveries can be redelivered for three days. [Failed delivery behavior](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).

### Idempotency and ordering

- Receipt identity: global unique `github_delivery_guid`; it is an event key, not a success flag.
- Source entities: `(tenant_id, repository_id, github_id)` for PR/issues/releases; `(tenant_id, repository_id, sha)` for commits.
- Canonical event key: `(tenant_id, repository_id, source_system, source_kind, source_external_id, verb)`. Repository scope prevents the same commit SHA in forks from colliding.
- Jobs have a unique logical key such as `delivery:{delivery_id}` or `backfill:{repository_id}:{stage}:{generation}`. Re-enqueue uses the same logical key after failed/stale state recovery.
- Every writer applies the same stale-update rule. Backfill, webhook-triggered fetch, and reconciliation converge even when they race.
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

Source tables represent GitHub's current facts in **connected repositories**. `development_events` is the stable fact projection used by timelines and later analysis; it is not proof that every fact is a personal accomplishment.

```text
GitHub source entity       Canonical events
commit                 -> commit.authored, commit.committed
pull_request           -> pull_request.opened, pull_request.merged, pull_request.closed
issue                  -> issue.opened, issue.closed, issue.reopened
release                -> release.published, release.edited
repository             -> repository.created, repository.archived, repository.renamed
tag                     -> tag.created, tag.deleted
```

Preserve lifecycle facts, then collapse them in the default view/projector rules:

- a merged PR is not also rendered as a separate “closed” accomplishment;
- `commit.authored` and `commit.committed` for the same SHA/person render once, preferring author;
- a merger/committer does not inherit authorship of the PR or squash content;
- collaborator events remain **project context** unless the connected owner is the actor;
- `actor_kind == bot` is hidden by default, while bot facts remain queryable;
- release publication may be explicitly classified as a project milestone even when another actor published it;
- issue closure remains its own lifecycle fact and is not attributed to a PR author by inference.

### `development_events` shape

| Field | Meaning |
|---|---|
| `id` | Internal UUIDv7 |
| `tenant_id`, `repository_id` | Isolation and connected-project context |
| `actor_github_account_id` | Stable external actor when GitHub can resolve it; nullable for `ghost`/unknown |
| `actor_kind` | `user`, `bot`, or `unknown`, derived from GitHub account type |
| `event_type`, `verb` | Controlled factual vocabulary |
| `source_kind`, `source_external_id` | Trace back to source row |
| `contribution_role` | author, committer, opener, merger, releaser, maintainer |
| `context_kind` | `personal`, `project`, or `unknown`; deterministic/queryable, never AI-inferred in v0.1 |
| `occurred_at`, `source_updated_at` | Historical ordering and stale-update defense |
| `title`, `summary_input` | Minimal factual text suitable for future classification |
| `additions`, `deletions`, `files_changed` | Optional future quantitative context, never a score |
| `language_context`, `labels`, `path_hints` | Optional/versioned features; paths are not populated in v0.1 |
| `attribution_confidence` | exact GitHub actor, parsed co-author later, or unknown; no raw-email matching by default |
| `completeness_state` | observed/reachable-at-sync/known-unknown/out-of-scope metadata for view copy |
| `visibility_snapshot` | public/private/internal at observation time |
| `classification`, `classification_source`, `classification_version` | Nullable future feature/refactor/etc. labels |

### Retained inputs and future classification

v0.1 permanently retains commit messages, PR/issue/release titles and factual lifecycle metadata, labels/milestones where useful, timestamps, languages, and relationship IDs such as PR merge commit SHA. PR/issue/release bodies default to **not collected** until an explicit owner control and later experiment approve them. `commit_files`, file paths, line counts, patches, blobs, and source contents are not populated in v0.1.

Rule-based classification can later use conventional commit prefixes, labels, release links, and PR metadata. `Co-authored-by` trailers may be parsed into versioned attribution after an experiment, but raw Git author/committer emails are never stored. Classifications are annotations, never destructive rewrites of source facts.

### Default memoir query and attribution policy

The default memoir query includes events whose actor is the GitHub account linked to the DevMemoir user, plus explicitly marked project milestones; it excludes bots and applies the collapse rules above. A commit is exact when GitHub returns a linked author/committer account ID. Unlinked commits remain visible only as project/unknown context and are never matched by display name. Repository-level facts remain accessible in a separate project-context view.

## 8. Initial PostgreSQL schema

Use UUIDv7 internal keys, `bigint` for GitHub numeric IDs, `timestamptz` everywhere, and `citext` only where case-insensitive lookup is intentional.

| Table | Important columns and constraints |
|---|---|
| `tenants` | `id PK`, `slug UNIQUE`, `created_at`, `deletion_requested_at` |
| `users` | `id PK`, `primary_tenant_id FK`, `display_name`, `created_at`, `deleted_at` |
| `tenant_members` | `(tenant_id, user_id) PK`, `role`, `created_at`; future membership model |
| `github_accounts` | `id PK`, `github_account_id bigint UNIQUE`, `account_type`, `actor_kind`, mutable `login`, `node_id`, `avatar_url`, `profile_updated_at`; represents any GitHub actor, including `Bot` and `ghost`, without raw Git email |
| `github_identities` | `id PK`, `user_id FK UNIQUE`, `github_account_id FK UNIQUE`, `linked_at`, `verified_at`; v0.1 is one DevMemoir user to exactly one verified GitHub user account |
| `github_user_credentials` | optional `github_identity_id PK/FK`, encrypted refresh/access material, `expires_at`, `key_version`; deliberately unpopulated in M1 and added only if a later API flow truly requires a user token |
| `auth_transactions` | `id PK`, hashed single-use state, encrypted PKCE verifier, return path allowlist value, GitHub account/install claims, `expires_at`, `consumed_at`; short retention and never exposed to the browser |
| `application_sessions` | `id PK`, `user_id FK`, hashed session token, `created_at`, `expires_at`, `revoked_at`, last-seen metadata allowlist; browser receives only the opaque host-only cookie |
| `github_installations` | `id PK`, `tenant_id FK`, `github_installation_id bigint UNIQUE`, `account_github_account_id FK`, `status`, `permissions jsonb`, `repository_selection`, `suspended_at`, `deleted_at` |
| `repositories` | `id PK`, `tenant_id FK`, `github_repository_id bigint`, `node_id`, mutable `owner_login/name/full_name`, visibility flags, default branch, description, topics/languages jsonb, `github_created_at/updated_at/pushed_at`, `archived_at/deleted_at`; UNIQUE `(tenant_id,github_repository_id)`, index `(tenant_id,pushed_at DESC)` |
| `repository_access` | `id PK`, `tenant_id FK`, `repository_id FK`, `installation_id FK`, `access_status`, `selected_at`, `revoked_at`; UNIQUE `(tenant_id,repository_id,installation_id)`, index `(tenant_id,access_status)` |
| `repository_name_history` | `id PK`, `tenant_id FK`, `repository_id FK`, owner/name/full_name, `valid_from`, `valid_to`; index on tenant/repository/time |
| `branches` | `id PK`, `tenant_id FK`, `repository_id FK`, `name`, `head_sha`, `protected`, `last_seen_at`, `deleted_at`, UNIQUE `(tenant_id,repository_id,name)` |
| `tags` | `id PK`, `tenant_id FK`, `repository_id FK`, `name`, `target_sha`, nullable tagger GitHub account, `last_seen_at`, `deleted_at`, UNIQUE `(tenant_id,repository_id,name)` |
| `commits` | `id PK`, `tenant_id FK`, `repository_id FK`, `sha`, nullable author/committer GitHub account FKs, message, author/committer timestamps, parent SHAs jsonb, stats, verification fields, `first_seen_at`; no raw author/committer email; UNIQUE `(tenant_id,repository_id,sha)` |
| `commit_files` | deferred schema placeholder: `tenant_id FK`, `(commit_id,path) PK`, status and counts, previous path; **not populated in v0.1 and no patch column** |
| `commit_refs` | `tenant_id FK`, `(commit_id,branch_id) PK`, `last_seen_at`, `reachable` |
| `pull_requests` | `id PK`, tenant/repository and GitHub IDs, actor account FKs, state/draft, title, nullable body, refs/SHAs, labels, lifecycle timestamps, merge SHA, stats; body remains null in v0.1; tenant-scoped external-ID and number uniqueness |
| `issues` | `id PK`, tenant/repository and GitHub IDs, actor account FKs, state/reason, title, nullable body, labels/milestone, lifecycle timestamps; body remains null in v0.1; tenant-scoped external-ID and number uniqueness |
| `releases` | `id PK`, tenant/repository and GitHub IDs, author account FK, tag/name, nullable body, draft/prerelease, target and timestamps; body remains null in v0.1 |
| `development_events` | fields from section 7; UNIQUE `(tenant_id,repository_id,source_system,source_kind,source_external_id,verb)`; indexes by tenant/time, repository/time, and actor/time |
| `webhook_deliveries` | `id PK`, nullable tenant until installation resolution, delivery GUID UNIQUE, event/action, installation/repository external IDs, allowlisted headers, encrypted payload, key version, first/last received timestamps, `receipt_count`, state, processing lease, attempts, error code, processed timestamp, `payload_expires_at`; indexes on state/time and expiry; invalid-signature bodies are never retained |
| `sync_jobs` | `id PK`, tenant/installation/repository FKs, kind/stage/state, `logical_key UNIQUE`, attempt/max attempts, schedule/lease/heartbeat timestamps, rate-limit snapshot, sanitized error code/message |
| `sync_cursors` | tenant/repository/resource key, cursor jsonb, high-water/head SHA, ETag, last success/full reconcile timestamps, schema version |
| `outbox` | `id PK`, `tenant_id FK`, aggregate type/id, event type, minimal payload jsonb, created/published timestamps; index tenant/unpublished |
| `audit_log` | `id PK`, tenant/user IDs, action, target type/id, metadata allowlist, occurred_at; no private content |

All collected private/source tables carry `tenant_id` directly. The first schema enables and forces RLS for the non-owner application roles on every tenant table, with the tenant context set transaction-locally; migrations and the narrowly scoped queue role remain separate. API and worker use tenant-scoped repositories, while the web process has read-only access through the API/session boundary. CI must prove cross-tenant negative cases both through repository code and direct SQL. This intentionally duplicates source facts when two tenants authorize the same repository: the privacy/deletion boundary is worth the storage at expected scale. Foreign keys restrict tenant/user deletion until the explicit purge workflow runs; cascades are limited to that transaction. Add checks for valid states and nonnegative statistics.

### Permanent versus limited-retention data

**Permanent while connected/retained:** stable IDs, repository metadata/history, normalized source records, commit messages, titles and lifecycle metadata, selected labels/milestones, events, cursors, and minimal audit history. Bodies, file paths, file counts, patches, blobs, and source content are outside the v0.1 retained set.

**Limited retention:** valid raw webhook payloads and sanitized processing errors expire after **7 days by default**. A deterministic failure may retain its encrypted dead-letter payload for investigation, but an automatic hard cap between 14 and 30 days must be configured; v0.1 uses 30 days. Successful processing never extends payload expiry.

**Never store:** raw Git author/committer emails, GitHub App installation tokens, App JWTs, repository clones, blobs, file contents, diff patches, Actions logs/artifacts, secret values, or arbitrary request headers.

## 9. Privacy and security review

### Threats and controls

| Threat | Required control |
|---|---|
| App private key theft compromises all installations | Provider secret store; never DB/git/log; API/worker only; documented overlapping-key rotation and old-key revocation; sign-only KMS/HSM before public beta |
| Installation token leakage | Mint just in time, keep in memory, optionally scope down, redact authorization headers, never enqueue/persist; web never receives App credentials |
| OAuth/session theft or fixation | PKCE S256; hashed single-use state and handoff codes; short-lived auth transactions; host-only Secure HttpOnly SameSite=Lax cookie; rotation/revocation; CSRF on mutations |
| Installation claimed by wrong user | Compare installation account ID/type with the signed-in GitHub account; reject mismatch; no-state setup claims require an authenticated session and authoritative re-verification |
| Forged/replayed/oversized webhook | 2 MB application-body cap before buffering, HMAC-SHA256 over raw bytes, constant-time compare, GUID state machine, content-type/field limits, rotation overlap for current/previous webhook secrets |
| Cross-tenant data access | Direct tenant IDs, forced RLS for application roles from the first schema, transaction-local tenant context, scoped repositories, direct-SQL and service negative tests |
| Private content in logs/traces | Structured allowlist logger and tested exception scrubber in M1; no arbitrary objects; Sentry/OTel disabled until scrubber fixtures prove private strings absent |
| Overcollection via Contents permission | Central outbound endpoint permit-list blocks contents/blobs/archives and strips compare patches; no cloning; denial tests and endpoint metrics |
| Database or backup disclosure | TLS, provider encryption, paid backups, separate least-privilege pooled/direct roles, restricted exports, restore audit |
| Future AI provider receives private data | Explicit per-tenant opt-in, exact data-class preview, no training by contract/config, DPA/retention review, redacted evidence-linked audit |

The GitHub App private key grants access across installations and receives the strongest protection. GitHub recommends minimum permissions, secure credentials, webhook secrets, expiring tokens, and deletion capability. [GitHub App security practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

### Data minimization and presentation

**Required in v0.1:** external IDs, timestamps, visibility/access state, commit messages and linkage, PR/issue/release titles and lifecycle, selected labels/milestones, installation/cursor state, and normalized events.

**Deferred and off by default:** PR/issue/release bodies, changed file paths, file/line statistics, comments/reviews, and co-author trailer parsing. Enabling a later data class requires an owner-facing control, retention decision, endpoint-budget measurement, and schema/privacy review.

**Never infer identity from:** raw commit email or display name. Store neither raw Git author/committer email nor low-confidence email links. `ghost` and unresolved actors remain nullable/unknown project context.

Commit messages and other retained private text are rendered with safe length limits, never sent to third-party error/search/analytics systems, and never made publicly indexable. The UI marks private repositories and prevents public sharing by default.

### Disconnect and deletion

- **Uninstall/disconnect:** immediately stop token creation and jobs; mark access revoked; retain history privately for a documented grace period (default proposal 30 days) or delete immediately at user request.
- **Repository removed from installation:** stop new collection and authoritative reads; retain/detach history under the same policy.
- **Account deletion:** revoke sessions, stop jobs, purge live tenant rows and payloads with an auditable job, then track provider backup expiry. Confirmation distinguishes live deletion from backup-retention expiry.
- Export may arrive later; deletion cannot depend on export. Gate A requires expiry and deletion tests before real private-owner data is relied upon.

## 10. Reliability model

### Failure handling

| Failure | Required behavior |
|---|---|
| Webhook crash before durable receipt | Return failure; GitHub delivery audit requests redelivery with an App JWT; reconciliation remains the data backstop |
| Crash after receipt commit, before response | Same GUID increments receipt metadata; if state is `received`, `processing`, `failed`, or `dead_letter`, ensure processing is pending/resumable; no-op only for `processed`/`ignored` |
| Worker killed during processing | Lease/heartbeat expires; the same logical job resumes; source-page transaction and cursor update are atomic |
| Processing transaction committed before job acknowledgement | Retry observes source/event uniqueness and completes the delivery state transition without double projection |
| `push` payload is incomplete, truncated, or forced | Never persist payload commit objects; enqueue an authoritative ref-head sync using `ref`, `before`, `after`, and `forced` |
| GitHub 5xx/network error | Exponential backoff with full jitter: 5s base, 15m cap, maximum 8 transient attempts |
| Primary/secondary rate limit | Honor `Retry-After`/`X-RateLimit-Reset`; pause installation lane, lower concurrency, and never hot-loop |
| Database outage | Webhook returns failure because durability is unavailable; delivery audit/redelivery and reconciliation recover later |
| Same-GUID redelivery after deterministic failure | Reopen/retain the auditable delivery, create or ensure one logical job, and retry after code/config repair; the GUID is identity, not proof of success |
| Delayed/out-of-order update | Compare source timestamps and authoritatively re-fetch ambiguous entities |
| Partial backfill | Resume the last committed stage/page with idempotent ref-head overlap |
| Poison payload | After 5 deterministic attempts mark `dead_letter`, alert with an error code only, expire encrypted payload by the 30-day hard cap; owner retry requeues the same delivery |

Retry classification is explicit: do not retry 401/403 indefinitely; refresh installation/capability state. Treat 404 as ambiguous until paginated repository inventory confirms loss. A valid signed payload with an unknown event/action is `ignored`, not a 4xx or poison retry. Schema validators strip unknown fields and preserve supported nullable/`ghost` actors.

### Early-stage proportionality

Use pg-boss leases, retries, and cron through `JobPort`. The worker uses the direct Neon URL; polling every 1–2 seconds is acceptable, and `LISTEN/NOTIFY` is allowed only on a direct session connection. Keep recovery truth in source rows/cursors so a queue rebuild cannot lose progress. Introduce Redis/SQS only when measured database contention or independent scaling justifies it.

### Service objectives for v0.1

- 99% of valid webhook receipts durably acknowledged within 2 seconds under expected load.
- 95% of supported events visible within 2 minutes.
- Six-hour reconciliation completes for active repositories; daily inventory/reconciliation completes for all authorized repositories.
- Zero known cross-tenant reads; every tenant table is protected by service checks and RLS.
- Backfill progress is monotonic and restartable with no manual database edits.

## 11. MVP roadmap and release gates

### v0.1 — Owner-only foundation

M1–M6 form **Gate A**. Until all six pass, use only synthetic/sandbox private data; do not rely on DevMemoir as the durable record for real private-owner history.

- **M1 vertical slice:** one allowlisted owner and selected repository; PKCE/session/install binding; repository metadata; newest 100 reachable default-branch commits; push signal to authoritative sync; durable delivery state machine; owner-attributed private timeline; allowlist logs.
- **M2 installation inventory:** installation lifecycle, authoritative account verification, and complete paginated `/installation/repositories` inventory regardless of webhook list truncation.
- **M3 restartable backfill:** ref-head traversal, atomic page checkpoints, explicit completeness states, branches/tags plus metadata-only PRs/issues/releases; bodies/files remain off.
- **M4 canonical projection:** factual events, owner/project context, bot/default collapse rules, source links, and stale-update protection.
- **M5 repair loops:** six-hour active-repository reconcile, daily all-repository inventory/reconcile, App-JWT failed-delivery audit, rate-limit lanes, and owner-visible health.
- **M6 privacy/recovery:** 7-day raw payload expiry, <=30-day dead-letter cap, disconnect/delete, webhook/private-key rotation rehearsal, paid always-on Neon backup restore, and tenant-isolation evidence.

The M1 activity page displays the exact scope statement **“Newest 100 commits currently reachable from the default branch of this connected repository.”** It does not claim to show a user's full GitHub history. The default view shows the connected owner plus explicit project milestones, collapses duplicate authored/committed and merged/closed facts, and hides bots by default.

**Gate A success:** kill/restart and same-GUID failed-redelivery tests recover without double projection; a push payload commit list is ignored in favor of GitHub API facts; an intentionally missed delivery is repaired; private fixtures are absent from logs/errors; installation mismatch and cross-tenant reads are denied; expiry, deletion, rotation, and restore drills pass.

### v0.2 — Quality and dashboard (Gate B)

M7 is a thinner soak/copy milestone after Gate A: run the owner flow for two weeks, validate completeness wording and quality indicators, measure Railway–Neon latency/cost, tune concurrency, and deliver cross-repository calendar/filter views. Counts describe project activity, never personal productivity.

### v0.3 — Evidence and controlled experiments

- Evaluate all-active-branch history, per-commit file statistics, co-author attribution, bodies, reviews/deployments, and weekly deep reconcile independently.
- Each new data class requires an endpoint-budget result, privacy/retention decision, explicit owner control when content-sensitive, migration, and updated completeness copy.
- Rule-based classifications remain versioned annotations over source facts.

### v0.4 — Opt-in AI chronicle

- Explicit opt-in summaries with evidence links, exact input preview, prompt/model versioning, redaction, evaluation, regenerate/delete, vendor DPA/retention review, and no-training configuration.
- Add a Python analysis service only if a measured experiment justifies a separate runtime.

### Multi-user beta (Gate C)

Before removing the owner allowlist: revalidate forced RLS and direct-SQL isolation, quotas/abuse controls, per-user installation lifecycle, incident/support runbooks, formal privacy/terms/DPA review, and stronger sign-only key custody. Organizations, teams, public profiles/sharing, Discussions/Actions, and external imports remain later work.

## 12. Testing strategy

### Unit and contract tests

- Raw-body HMAC verification over Unicode bytes, wrong/current/previous secrets, malformed headers, constant-time comparison, content type, and 2 MB rejection before parse.
- Tolerant Zod schemas strip unknown fields, accept nullable/`ghost` actors, map every supported action, and mark unknown event/actions `ignored`.
- Endpoint permit-list allows only named API shapes; contents/blob/archive calls are denied and compare responses cannot retain `patch`.
- Push mapping persists only `ref`, `before`, `after`, `forced`, delivery/install/repository IDs and enqueues authoritative ref-head sync; injected payload commit messages never reach source/event tables.
- Event keys, source-timestamp stale-update defense, attribution/collapse/bot rules, retry classes, and rate-limit scheduling.
- Allowlist logger and exception scrubber prove a canary private repository name, commit message, body, path, payload, token, and secret are absent from logs/metrics/errors.

### Integration tests with real PostgreSQL

- Concurrent first receipts of the same GUID create one logical processing job and increment auditable receipt metadata.
- Redelivery after `received`, worker-killed `processing`, `failed`, and owner-retried `dead_letter` resumes/requeues; only `processed` and `ignored` are terminal no-ops.
- Kill a worker before and after source transaction commit; lease recovery yields one source fact/event and a completed delivery.
- Newer then older source data cannot regress state; ref-head forced push updates reachability without deleting preserved commits.
- Page upsert plus cursor/high-water update is atomic; restart and 24-hour supplemental overlap do not replace ref-head traversal.
- Installation repository inventory follows every `Link` page even when `installation.created` contains a truncated repository list.
- `/setup` and callback reject a non-allowlisted GitHub user, state replay/expiry, PKCE mismatch, open redirect, installation-account mismatch, and unauthenticated no-state claims.
- `ping` and `github_app_authorization` return 2xx with intended side effects; uninstall/revocation gates jobs and token minting, while `new_permissions_accepted` preserves current selection and queues authoritative installation/repository reconciliation.
- Tenant A cannot read/write Tenant B through repository methods **or direct SQL under each application role**; migration owner/queue exceptions are narrowly verified.
- Web database role cannot write GitHub-derived tables; API/worker roles can only perform their scoped operations.
- Raw payload expiry deletes successes at 7 days and dead letters by 30 days without deleting normalized facts.
- Migrations apply from empty DB and upgrade a previous snapshot; production rollback/restore procedure is exercised.

### End-to-end and operational tests

- Sandbox GitHub App: PKCE login → selected installation → verified account binding → paginated inventory → newest 100 reachable default-branch commits → exact completeness copy.
- Deliver a push fixture whose embedded commits disagree with mocked GitHub API results; the timeline reflects only authoritative API facts.
- Fail processing, redeliver the same GUID, then repair/retry; one correct event appears. Repeat with a worker kill and deployment drain.
- Create/merge a PR: preserve lifecycle facts but default timeline shows one merged accomplishment, does not inherit PR authorship to the merger, and hides bot activity.
- Suppress a webhook; six-hour active reconcile repairs it. App-JWT delivery audit discovers a failed receipt without a user/installation token.
- Rename/remove/re-add a private repository; internal identity is stable and reads stop while access is absent.
- Uninstall and account deletion revoke access/sessions, stop jobs, remove live rows, and accurately report backup-retention status.
- Rotate webhook and App secrets with an overlap window; old material is revoked after traffic proves the new material.
- Restore paid always-on Neon backup into an isolated environment and verify tenant counts/cursors without exposing content in output.

Use recorded, redacted GitHub fixtures for most CI. Run live sandbox tests nightly/manual because API behavior and rate limits make them unsuitable for every commit. Gate A requires the failure, privacy, isolation, expiry/deletion, rotation, and restore cases above—not only the happy path.

## 13. Observability

M1 ships a single structured **allowlist** logger. Callers provide named scalar fields only: opaque request/delivery/job/tenant/installation/repository IDs, event type, state/result, attempt, duration, and rate-limit bucket. Arbitrary objects, HTTP bodies/headers, GitHub responses, SQL parameters, repository names, commit messages, bodies, paths, payloads, tokens, and secrets are rejected or dropped. Exception serialization keeps an error class/code and scrubbed stack only.

Sentry, OpenTelemetry exporters, session replay, and third-party search/analytics are disabled until canary-fixture tests prove the shared scrubber removes every private string from errors, breadcrumbs, attributes, and transport envelopes. Enabling one is a reviewed configuration change, not an environment-variable accident.

Minimum metrics:

- webhook receipt/processing count, latency, signature/size failure, state transition, same-GUID receipt count, and dead-letter count by event type;
- queue depth/oldest age/attempts/duration, worker heartbeat, and lease recovery by job kind;
- GitHub endpoint-name/status/quota and installation-lane pause, never URL/query/body content;
- backfill stage, ref-head/checkpoint progress, active/all reconciliation age, and failed-delivery audit age;
- pooled/direct database errors, connection count, pool saturation, and transaction duration;
- 7-day payload-expiry and 30-day dead-letter purge backlog.

Alert for supported processing lag >10 minutes, dead-letter >0, active reconcile >12 hours, all-repository reconcile >36 hours, repeated auth/install mismatch, worker heartbeat loss, pool exhaustion, or payload deletion lag >24 hours. Run the private-canary log test in CI and immediately before enabling any new telemetry sink.

## 14. ADR summary

The seven records in [`docs/architecture/adr`](./adr/) remain accepted after reconciliation; their amendments are binding rather than optional notes:

1. TypeScript modular monolith with separate web/API/worker processes and explicit writer authority/session handoff.
2. PostgreSQL/Neon system of record with pooled web/API, direct worker/migrations, first-schema forced RLS, and v0.1 minimization.
3. GitHub App PKCE login plus verified installation binding; App/installation credentials never become browser sessions.
4. Durable webhook receipt **state machine**; a GUID identifies a delivery, while terminal success is only `processed`/`ignored`; push payload commits are never source facts.
5. pg-boss behind `JobPort`, direct worker connectivity, lease/poll semantics, and queue-independent cursor recovery.
6. One factual development-event projection with owner/project context, bot/collapse rules, nullable actors, and explicit completeness.
7. Railway plus paid always-on Neon, separated production worker, small role-specific pools, and a measured cross-provider network gate.

## 15. Highest risks, experiments, and readiness

### Five highest architectural risks

1. **Completeness mistaken for personal history:** deleted refs, force-push gaps, squash/rebase behavior, and unlinked actors make the observable connected-repository slice incomplete by construction.
2. **Private-data exposure:** the GitHub permission envelope is broader than retained data; endpoint, log/telemetry, session, tenant, backup, or future-AI mistakes can expose private facts.
3. **Delivery identity mistaken for success:** a unique GUID without the explicit resumable state machine can permanently suppress a failed delivery.
4. **Rate-limit/backfill growth:** per-entity calls and many repositories can exhaust limits unless ref-head checkpoints, small installation lanes, and endpoint budgets are measured.
5. **Semantic over-attribution:** double-counted lifecycle events, bots, and collaborator/project activity can produce a technically correct but personally misleading memoir.

### Deferred decisions and required experiments

| Decision | Experiment before commitment |
|---|---|
| Default branch versus all active branch history | After Gate A, run both on the owner's five largest/divergent repositories; measure unique reachable commits, requests, time, and perceived gaps |
| Per-commit files/statistics | After Gate A, sample 10k commits; measure rate-limit/storage/classification value; keep paths/counts off until the review passes |
| pg-boss operational fit | During M1/M7, kill workers before/after transaction commit and load 100k jobs; verify lease recovery, polling latency, and DB contention |
| PR/issue/release bodies | Later privacy experiment with explicit owner control and retention review; bodies remain unrequested/unpopulated through Gate A |
| Weekly deep reconcile | Compare repair yield and API cost after six-hour active/daily all loops have production evidence |
| Railway + Neon network/cost | Deploy the vertical slice in aligned regions for a two-week soak; measure webhook p95, connection stability, and projected monthly cost |
| Identity/co-author attribution | Audit exact GitHub account links, nullable/ghost actors, and trailer value; never store raw Git emails or match display names |

### Exact first implementation milestone

Create the smallest deployable slice for **one allowlisted owner and one selected connected repository**. Configure the GitHub App with install-time OAuth disabled; implement PKCE S256, single-use server-side state/handoff, host-only session, and verified installation-account binding. Deploy web/API with a small pooled Neon URL and a separate always-on worker with the direct URL. Import repository metadata and the newest 100 commits reachable from the current default-branch head, render the exact completeness copy and owner-attributed collapsed timeline, then accept a signed `push` only as a durable sync signal.

M1 is accepted only when same-GUID redelivery from a failed state and worker kills both recover, embedded push commits are ignored for authoritative API facts, installation mismatch/endpoint denial/cross-tenant tests pass, and private canary strings are absent from logs/errors. [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) contains the ordered milestones and release gates.

### Reconciliation assessment

**GO WITH CONDITIONS.** This patch resolves the formal review's three architecture-document blockers: delivery GUID semantics, authoritative push ingestion, and auth/session/installation binding. Implementation may begin against sandbox data once GitHub App settings/permissions and the pooled/direct connection topology are verified. Gate A—not M1 alone—must pass before relying on real private-owner history: paid always-on restorable Neon, M1 privacy telemetry controls, M1–M6 recovery/isolation/expiry/deletion/rotation evidence, and accurate completeness copy are mandatory. No deferred experiment above blocks the vertical slice.
