# ADR 0001: TypeScript modular monolith with separate process boundaries

**Status:** Accepted (reconciled)
**Date:** 2026-08-21

## Context

DevMemoir combines interactive UI, security-sensitive GitHub callbacks, low-latency webhook receipt, and long-running resumable imports. The first version needs strong boundaries without distributed-system overhead.

## Decision

Build one TypeScript monorepo with shared domain/contracts and three separately deployable processes:

- **web:** Next.js UI and host-only application session; reads GitHub-derived data through the API and has no write privilege on those tables;
- **api:** Fastify authentication/setup callbacks, webhook verification/durable receipt, owner-facing commands, and tenant-scoped source writes;
- **worker:** pg-boss consumers, authoritative GitHub synchronization, projection, reconciliation, expiry, and deletion.

API and worker are the only writers of GitHub-derived tables. Each process has its own entry point, least-privilege database role, health check, config schema, pool budget, and scaling policy. Shared packages may contain pure contracts/domain logic but may not let web import database writers or GitHub App credentials.

Authentication uses a server-side API transaction and one-time handoff to a web-owned host-only session; App/installation credentials never become the browser session. Local development may co-host API/worker for convenience. Production keeps the worker separate and always-on.

Do not introduce Python or independent microservices until a measured analysis/runtime requirement justifies them.

## Consequences

- One language and repository keep transactions, schemas, and refactors coherent.
- Process/role boundaries isolate secrets and long work while avoiding networked internal services.
- The shared database remains a coupling point; package ownership and database permissions enforce the boundary.
- A future service extraction must preserve idempotency keys, tenant context, writer authority, and event contracts.

## Validation

CI rejects web imports of writer/GitHub-App packages, proves the web DB role cannot mutate source tables, and exercises API/worker deployment and graceful worker restart independently.
