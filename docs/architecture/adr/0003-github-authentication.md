# ADR 0003: GitHub App authentication, verified installation binding, and ephemeral tokens

**Status:** Accepted (reconciled)
**Date:** 2026-08-21

## Context

Login identity, browser session, App authority, installation access, and setup callbacks are distinct security grants. A user reaching a setup URL does not prove ownership of its installation.

## Decision

Use a private GitHub App and keep the grants separate:

1. Configure **Request user authorization (OAuth) during installation** off. Keep OAuth callback and setup URL distinct; use exact registered redirects.
2. Start login at Fastify with PKCE S256, high-entropy state stored only as a hash, a server-side encrypted verifier, an allowlisted return path, and short expiry.
3. Callback consumes the state once, verifies PKCE, fetches the GitHub user, enforces the owner allowlist, and creates a one-time handoff code. No GitHub user credential is persisted in M1.
4. Next.js exchanges the handoff server-to-server and sets opaque `__Host-devmemoir_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, path `/`; store only a hashed revocable session token and require CSRF protection for mutations.
5. Before binding, use authoritative GitHub API data to prove the installation account is type `User` and its numeric ID equals the signed-in GitHub account. Reject mismatch before tenant/source creation.
6. A setup callback with missing/unusable state is a claim flow only for an authenticated session and repeats the authoritative verification. It never auto-binds from an installation ID alone.
7. Always paginate `/installation/repositories`; embedded installation-event repository lists may be truncated.
8. Mint installation tokens just in time in API/worker memory. Never store, enqueue, log, or expose installation tokens or App JWTs. Failed-delivery audit uses an App JWT, not a user/installation token.

Use minimum read permissions and a central endpoint permit-list. Subscribe to required lifecycle/data events plus `ping` and `github_app_authorization`; unknown signed events/actions are acknowledged and recorded as ignored.

## Consequences

The extra transaction/handoff records remove browser access to GitHub credentials and make account/install binding auditable. The owner-only v0.1 model intentionally forbids organization installations; organization/multi-user ownership requires a later ADR.

## Validation

Tests cover state/hand-off replay and expiry, PKCE mismatch, open redirects, CSRF, cookie attributes, authenticated no-state claim, installation account/type mismatch, paginated inventory, uninstall/revocation, and proof that no token reaches persistence/logs/web.
