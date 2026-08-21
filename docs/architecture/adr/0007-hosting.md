# ADR 0007: Railway plus paid always-on Neon for v0.1

**Status:** Accepted (reconciled; measurement gate retained)
**Date:** 2026-08-21

## Context

DevMemoir needs ordinary HTTPS, an independently restartable always-on worker, scheduled repair/expiry jobs, private secret isolation, and restorable PostgreSQL. Cross-provider network behavior must be measured rather than assumed.

## Decision

Deploy Next.js web, Fastify API, and worker as separate Railway services from one repository. Co-host API/worker only in local development. Keep worker always-on in production with graceful drain, heartbeat, and independent restart/scale controls.

Use paid always-on Neon PostgreSQL in the closest practical region:

- web/API: pooled URL, separate least-privilege roles and small single-digit pools;
- worker/pg-boss: direct URL, separate least-privilege role and small single-digit pool;
- migrations: direct URL, release-only migration role;
- no production scale-to-zero and no `LISTEN` through the pooler.

GitHub App private key and webhook secrets exist only in API/worker secret stores as needed; web never receives them. Egress flows through the central GitHub endpoint permit-list. Health/metrics contain opaque IDs and allowlisted scalars only.

Before Gate A, align regions, establish paid backup/PITR, restore into an isolated environment, and measure two weeks of webhook p95, DB transaction/connection stability, worker polling/leases, cold behavior, and projected monthly cost.

## Consequences

Railway minimizes early operational work and preserves ordinary container/process semantics. Neon provides portable PostgreSQL but introduces a provider boundary and connection constraints. Small role-specific pools and measured latency make those constraints explicit.

Migrate providers or co-locate only if the soak fails objectives/cost; the application contract does not depend on Railway-specific queues or storage.

## Validation

Gate A requires separate production process health, always-on worker behavior, pool-budget alarms, deployment-time kill/recovery, secret-boundary audit, same-region measurement, and an isolated successful restore without private data in output.
