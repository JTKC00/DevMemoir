# DevMemoir M2

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

#### Neon-specific least-privilege provisioning

For **runtime least-privilege roles on Neon**, do **not** create `devmemoir_api_login`, `devmemoir_worker_login`, or `devmemoir_queue_login` through the Neon Console, CLI, or API. Neon grants roles created by those control-plane paths membership in `neon_superuser`, and `neon_superuser` has `BYPASSRLS`. That would defeat DevMemoir's tenant-isolation model even if the role also inherits a restricted `devmemoir_*` capability role.

Create runtime LOGIN principals with SQL instead, using `psql` or the Neon SQL Editor while connected as the bootstrap/owner administrator. SQL-created Neon roles do not automatically inherit `neon_superuser` membership. Supply passwords securely at provisioning time; never commit them to this repository.

```sql
-- Neon runtime principals: create with SQL, not Console/CLI/API role creation.
CREATE ROLE devmemoir_api_login LOGIN PASSWORD '<set-securely>';
CREATE ROLE devmemoir_worker_login LOGIN PASSWORD '<set-securely>';
CREATE ROLE devmemoir_queue_login LOGIN PASSWORD '<set-securely>';

GRANT devmemoir_api TO devmemoir_api_login;
GRANT devmemoir_worker TO devmemoir_worker_login;
GRANT devmemoir_queue TO devmemoir_queue_login;
```

After provisioning on Neon, verify that all runtime principals are ordinary LOGIN roles, do not have `BYPASSRLS`, and are not members of `neon_superuser`:

```sql
SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolbypassrls,
  pg_has_role(rolname, 'neon_superuser', 'MEMBER') AS neon_superuser_member
FROM pg_roles
WHERE rolname IN (
  'devmemoir_api_login',
  'devmemoir_worker_login',
  'devmemoir_queue_login'
);
```

The expected runtime result is `rolcanlogin = true`, `rolsuper = false`, `rolbypassrls = false`, and `neon_superuser_member = false` for every row. Treat any different result as a deployment blocker.

The migration/bootstrap principal is intentionally separate: it may require elevated DDL ownership or provider-admin privileges, but those credentials are release-only and must never be reused by API, worker, queue, or Web. On Railway or ordinary PostgreSQL, create equivalent LOGIN principals through the provider/admin SQL console or release bootstrap job and grant only the matching capability role.

Never store a production password in this repository. A production migration process fails closed unless `DATABASE_MIGRATIONS_URL` is explicitly present; only local development/test may fall back to `DATABASE_DIRECT_URL`/`DATABASE_URL`.

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

## Repository inventory (M2)

After an installation is bound, DevMemoir queues an authoritative `GET /installation/repositories` refresh and follows every GitHub pagination link. The webhook events `installation`, `installation_repositories`, and relevant `repository` events are durable signals that enqueue another refresh; their embedded repository arrays are never treated as the permanent inventory.

The inventory uses the GitHub numeric repository ID as identity. Names, owner logins, visibility, default branch, archived/disabled flags, and timestamps are mutable metadata, and prior names are retained in name history. A repository can be **accessible** to the GitHub App while remaining **unselected** in DevMemoir. **Selected** means DevMemoir is actively tracking it; M2 preserves the existing M1 limit of one selected repository and does not start historical imports for every accessible repository.

Only a completed pagination run may mark a previously visible repository `access_removed`. A page failure leaves the previous authoritative inventory intact. Installation suspension marks access unavailable and stops repository work; unsuspend keeps repositories unavailable and unselected until reconciliation, after which the user selects one again. Accepting newly requested GitHub App permissions instead preserves current access and selection while it queues an authoritative refresh; that refresh still clears selection if the repository is no longer accessible. Uninstall/deletion marks access disconnected while retaining repository identity and existing memoir facts. Reinstallation upserts the same installation/repository identities rather than creating duplicates.

## GitHub App checklist

Create a GitHub App for the owner account; do not commit its private key or any token.

* Disable **Request user authorization (OAuth) during installation** for v0.1.
* Set the user authorization callback to `${API_ORIGIN}/auth/github/callback`.
* Set the setup URL to `${API_ORIGIN}/github/setup` and enable setup URL redirection.
* Set the webhook URL to `${API_ORIGIN}/webhooks/github` and choose a random webhook secret.
* Request only these permissions: Metadata **read**, Contents **read**, Pull requests **read**, Issues **read**. No write permissions are needed.
* Subscribe to `push`, `ping`, `github_app_authorization`, `installation`, `installation_repositories`, and the relevant `repository` events. M2 installation/repository events are durable signals for an authoritative inventory refresh; unsupported actions are never projected.
* Put the numeric owner account ID in `OWNER_GITHUB_USER_ID`. Installation binding re-fetches the installation and requires account type `User` plus an exact numeric ID match.
* Fill `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, optional `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and current/previous webhook secrets in `.env`.

The API uses an app-authenticated Octokit request for installation verification and an installation-authenticated client for repository, ref, and commit reads. Endpoint calls are permit-listed.

### Manual M1 GitHub App E2E checklist

Run this checklist in a temporary HTTPS environment when owner-created GitHub App credentials and a public callback are available. Record the result and timestamp for each item; do not paste private keys, tokens, webhook secrets, or raw private payloads into tickets or logs.

1. Create the GitHub App under the allowlisted owner account.
2. Set the user authorization callback to `${API_ORIGIN}/auth/github/callback`.
3. Set the setup URL to `${API_ORIGIN}/github/setup` and enable setup URL redirection.
4. Set the webhook URL to `${API_ORIGIN}/webhooks/github` and configure a random webhook secret.
5. Set only Metadata read, Contents read, Pull requests read, and Issues read permissions.
6. Subscribe to `push`, `ping`, `github_app_authorization`, `installation`, and `installation_repositories`.
7. Set `OWNER_GITHUB_USER_ID` to the owner’s numeric GitHub account ID and verify it is not a login name.
8. Load the App ID, client ID, private key, and current webhook secret into the environment; keep the private key out of source control.
9. Verify the webhook secret used by GitHub matches the runtime secret and that any previous secret is only a rotation overlap value.
10. Provision the database first, then set the explicit `DATABASE_API_URL`, `DATABASE_WORKER_URL`, `DATABASE_QUEUE_URL`, and release-only `DATABASE_MIGRATIONS_URL` login-principal URLs. On Neon, create runtime API/worker/queue LOGIN principals through SQL and verify `rolbypassrls = false` plus no `neon_superuser` membership before starting the services. Web uses the API and has no database URL.
11. Confirm the temporary HTTPS host routes both callback and webhook paths to the API and that the API, worker, queue, and migration processes are running with their separate roles.
12. Open the Web login flow and complete GitHub authorization; verify the host-only session cookie and CSRF-protected browser handoff.
13. Start GitHub App installation and verify the installation is rebound to the exact allowlisted owner account.
14. Confirm the initial inventory shows every accessible repository across all pages, with private/public and observed timestamps.
15. Select exactly one private repository and verify it becomes actively tracked while other accessible repositories remain unselected.
16. Verify the initial import reports the exact newest 100 commits reachable from the current default branch.
17. Add/remove a repository in the GitHub App, deliver `installation_repositories`, and verify the UI converges after an authoritative refresh rather than trusting the webhook array.
18. Rename or transfer a repository and verify the numeric repository identity is retained; revoke access and verify the historical row remains as removed.
19. Suspend, unsuspend, and uninstall the App; verify active repository work stops immediately, unsuspend waits for inventory reconciliation, and memoir history remains.
20. Push a test commit, confirm GitHub delivers the signed webhook, and verify worker processing fetches the authoritative ref/head before writing facts.
21. Redeliver the same GUID and replay a failed/dead-letter receipt; verify one canonical delivery/job, no duplicate business effect, and terminal `processed`/`ignored` receipts remain no-ops.
22. Open the private activity page and inspect application/worker logs and database canaries for absence of raw payloads, private source content, tokens, secrets, and cross-tenant data.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The PostgreSQL RLS suite is enabled when `TEST_DATABASE_URL` is set. It expects all migrations (`0001_initial.sql` and `0002_m2_repository_inventory.sql`) to have been applied and verifies capability-role membership through ephemeral LOGIN principals, that tenant A cannot read or write tenant B inventory, that worker A cannot write tenant B, and that the web role cannot mutate GitHub-derived commits:

```bash
$env:TEST_DATABASE_URL = $env:DATABASE_DIRECT_URL
pnpm db:migrate
pnpm --filter @devmemoir/db test
```

CI starts PostgreSQL, applies the migration, and runs this suite. Without a supplied database, those integration cases are intentionally skipped rather than replaced with SQLite.

## Runtime topology

`apps/api` uses `DATABASE_API_URL`, `apps/worker` uses `DATABASE_WORKER_URL`, pg-boss uses `DATABASE_QUEUE_URL`, and migrations use `DATABASE_MIGRATIONS_URL`. `packages/jobs` creates the three pg-boss queues with a stately logical-key policy; business cursors remain in PostgreSQL. Webhook HMAC verification happens on exact raw bytes before JSON parsing, and current plus previous secrets are accepted during rotation overlap.

## Known M2 limits / deferred scope

M2 intentionally supports one allowlisted owner and one selected repository, imports only the newest 100 commits reachable from the current default branch, and treats push webhooks as synchronization signals. It does not implement historical backfill for all accessible/selected repositories, organizations, general signup, billing, AI summaries/classification, profiles, scores, source cloning, file/diff storage, PR/issue content, comments, Actions, deployments, all-branch backfill, or analytics dashboards. Live GitHub App E2E still requires owner-created credentials and a reachable HTTPS callback.
