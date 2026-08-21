# DevMemoir M1

DevMemoir is a TypeScript/pnpm monorepo proving the first production-shaped vertical slice: one allowlisted owner authenticates, binds one GitHub App installation, selects one repository, imports the newest 100 default-branch commits, receives signed push signals, and views a private factual activity page.

The coverage boundary shown by the product is deliberately exact:

> **Newest 100 commits currently reachable from the default branch of this connected repository.**

M1 stores commit facts and canonical events only. It never stores raw author emails, source files, blobs, patches, paths, PR/issue bodies, comments, or `push.commits[]` as authoritative data.

## Local PostgreSQL

Docker Desktop, OrbStack, Colima, a local PostgreSQL server, or a temporary Neon database may be used. Docker is not assumed by the application.

```bash
docker compose up -d postgres
copy .env.example .env             # PowerShell: Copy-Item .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

The compose database is `postgres://devmemoir:devmemoir@localhost:5432/devmemoir`. Local development may use `DATABASE_URL`/`DATABASE_DIRECT_URL` as the fallback. Production must provide explicit `DATABASE_API_URL`, `DATABASE_WORKER_URL`, `DATABASE_QUEUE_URL`, and `DATABASE_MIGRATIONS_URL` URLs for LOGIN principals mapped to the capability roles created by the migration; the API, worker, pg-boss, and migration process do not silently share an owner URL.

### Production database role provisioning

The migration creates `devmemoir_api`, `devmemoir_worker`, `devmemoir_queue`, `devmemoir_migrations`, and `devmemoir_web` as `NOLOGIN` capability roles. Do not put those names directly in a connection URL. Create provider/environment-specific `LOGIN` principals, set their passwords through the provider secret manager, and grant each principal exactly one capability role:

```sql
-- Run as the database bootstrap/owner administrator. Set passwords out of band.
CREATE ROLE devmemoir_api_login LOGIN;
CREATE ROLE devmemoir_worker_login LOGIN;
CREATE ROLE devmemoir_queue_login LOGIN;
CREATE ROLE devmemoir_migrations_login LOGIN;

GRANT devmemoir_api TO devmemoir_api_login;
GRANT devmemoir_worker TO devmemoir_worker_login;
GRANT devmemoir_queue TO devmemoir_queue_login;
GRANT devmemoir_migrations TO devmemoir_migrations_login;
```

`DATABASE_API_URL` uses the API login, `DATABASE_WORKER_URL` uses the worker login, and `DATABASE_QUEUE_URL` uses the queue login over the direct PostgreSQL connection. `DATABASE_MIGRATIONS_URL` is a release-only migration/DDL principal: it must be the database owner or a provider-managed login with the required schema/table DDL ownership, and must never be reused by API, worker, queue, or Web. The first migration is bootstrapped with the provider database owner/admin; subsequent migrations use the dedicated migration principal. M1 Web calls the API and has no database URL; `devmemoir_web` is retained for direct read-only role/RLS tests.

On Neon, create the LOGIN principals with the branch role management/API, retrieve each connection URI, and apply the PostgreSQL `GRANT` membership above; Neon documents that roles belong to branches and exposes branch role create/list/detail operations ([Neon role API](https://api-docs.neon.tech/reference/createprojectbranchrole)). On Railway or ordinary PostgreSQL, use the provider/admin SQL console or release bootstrap job. Never store a production password in this repository. A production migration process fails closed unless `DATABASE_MIGRATIONS_URL` is explicitly present; only local development/test may fall back to `DATABASE_DIRECT_URL`/`DATABASE_URL`.

Generate local key material without printing it into source control:

```powershell
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes); $env:ENCRYPTION_KEY_BASE64 = [Convert]::ToBase64String($bytes)
$bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes); $env:SESSION_SECRET = [Convert]::ToBase64String($bytes)
```

Run individual processes when needed:

```bash
pnpm --filter @devmemoir/api dev
pnpm --filter @devmemoir/worker dev
pnpm --filter @devmemoir/web dev
```

The host-only session cookie is always `__Host-devmemoir_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; use HTTPS (or a local TLS reverse proxy) for a browser login. API/unit tests use Fastify injection and do not need GitHub credentials.

## GitHub App checklist

Create a GitHub App for the owner account; do not commit its private key or any token.

* Disable **Request user authorization (OAuth) during installation** for v0.1.
* Set the user authorization callback to `${API_ORIGIN}/auth/github/callback`.
* Set the setup URL to `${API_ORIGIN}/github/setup` and enable setup URL redirection.
* Set the webhook URL to `${API_ORIGIN}/webhooks/github` and choose a random webhook secret.
* Request only these permissions: Metadata **read**, Contents **read**, Pull requests **read**, Issues **read**. No write permissions are needed.
* Subscribe to `push`, `ping`, `github_app_authorization`, `installation`, and `installation_repositories`. In M1, non-push receipts are durably acknowledged as `ignored`; unsupported actions are never projected.
* Put the numeric owner account ID in `OWNER_GITHUB_USER_ID`. Installation binding re-fetches the installation and requires account type `User` plus an exact numeric ID match.
* Fill `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, optional `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and current/previous webhook secrets in `.env`.

The API uses an app-authenticated Octokit request for installation verification and an installation-authenticated client for repository, ref, and commit reads. Endpoint calls are permit-listed.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The PostgreSQL RLS suite is enabled when `TEST_DATABASE_URL` is set. It expects the M1 migration to have been applied and verifies capability-role membership through ephemeral LOGIN principals, that tenant A cannot read or write tenant B, that worker A cannot write tenant B, and that the web role cannot mutate GitHub-derived commits:

```bash
$env:TEST_DATABASE_URL = $env:DATABASE_DIRECT_URL
pnpm db:migrate
pnpm --filter @devmemoir/db test
```

CI starts PostgreSQL, applies the migration, and runs this suite. Without a supplied database, those integration cases are intentionally skipped rather than replaced with SQLite.

## Runtime topology

`apps/api` uses `DATABASE_API_URL`, `apps/worker` uses `DATABASE_WORKER_URL`, pg-boss uses `DATABASE_QUEUE_URL`, and migrations use `DATABASE_MIGRATIONS_URL`. `packages/jobs` creates the three pg-boss queues with a stately logical-key policy; business cursors remain in PostgreSQL. Webhook HMAC verification happens on exact raw bytes before JSON parsing, and current plus previous secrets are accepted during rotation overlap.

## Known M1 limits / deferred scope

M1 intentionally supports one allowlisted owner and one selected repository, imports only the newest 100 commits reachable from the current default branch, and treats push webhooks as synchronization signals. It does not implement organizations, general signup, billing, AI summaries/classification, profiles, scores, source cloning, file/diff storage, PR/issue content, comments, Actions, deployments, all-branch backfill, or analytics dashboards. Live GitHub App E2E still requires owner-created credentials and a reachable HTTPS callback.
