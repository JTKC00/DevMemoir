# ADR 0002: PostgreSQL system of record, Neon hosted

**Status:** Accepted (reconciled; production conditions mandatory)
**Date:** 2026-08-21

## Context

DevMemoir needs relational integrity, idempotent source/event keys, resumable cursors, webhook/job leases, explicit tenant deletion, and a portable data model. Connection behavior differs between short request traffic and session-dependent queue work.

## Decision

Use PostgreSQL with Drizzle migrations: Docker PostgreSQL locally and paid, restorable, **always-on** Neon for production private data.

- Web/API use the pooled Neon URL with separate small single-digit role pools.
- Worker, pg-boss, and migrations use the direct URL with separate small single-digit pools.
- Never rely on `LISTEN/NOTIFY` through a transaction pooler; polling every 1–2 seconds is acceptable. Any later `LISTEN` uses a direct session connection.
- Disable scale-to-zero before relying on real private-owner history. Run migrations through a release step with the direct migration role.
- Put `tenant_id` directly on every private/source row. Enable and force RLS for non-owner application roles in the first schema, set tenant context transaction-locally, and keep migration/queue exceptions narrow.
- v0.1 identity mapping enforces `UNIQUE(github_account_id)` and `UNIQUE(user_id)`.
- Store no raw Git author/committer email. Bodies and commit-file rows remain null/unpopulated in v0.1; patches/blobs/source content have no storage path.
- Raw valid webhook payloads expire after 7 days; dead-letter payloads have a 30-day hard cap.

## Consequences

PostgreSQL atomically couples receipt/outbox/source/cursor transitions and avoids an early Redis/SQS dependency. Tenant-scoped copies cost storage but give an explicit privacy/deletion boundary. RLS adds migration/test discipline and is defense in depth, not a substitute for service scoping.

Cross-vendor Railway–Neon latency, connection stability, restore behavior, and cost remain measured gates. A provider change is possible because schema and job ports are portable.

## Validation

CI runs empty/upgrade migrations, direct-SQL and service cross-tenant negatives for every application role, queue lease recovery, pool-budget checks, 7/30-day expiry, and an isolated paid-backup restore before Gate A.
