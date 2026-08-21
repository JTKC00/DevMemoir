# DevMemoir architecture reconciliation

**Status:** Complete at document level — GO WITH CONDITIONS
**Formal input:** [ADVERSARIAL_REVIEW_GROK.md](./ADVERSARIAL_REVIEW_GROK.md)
**Reconciled specification:** [DEV_MEMOIR_ARCHITECTURE.md](./DEV_MEMOIR_ARCHITECTURE.md)
**Execution plan:** [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

This record explains how the formal adversarial review changed the architecture. “Resolved” means the documents now contain a binding decision and acceptance evidence; it does not claim that the implementation already passes the gate.

## Blocker disposition

| Review blocker | Disposition | Binding result |
|---|---|---|
| B1 — delivery GUID treated as success | **Resolved in specification** | GUID is delivery identity. `received`, `processing`, `failed`, and `dead_letter` redeliveries ensure resumable work; only `processed`/`ignored` are terminal no-ops. M1 tests include failed redelivery and worker kills before/after commit. |
| B2 — M1 trusting push commits | **Resolved in specification** | Push stores only identifiers plus `ref/before/after/forced`; embedded commits/messages are never persisted. The worker traverses authoritative GitHub ref heads and tests payload/API disagreement. |
| B3 — auth/session topology unspecified | **Resolved in specification** | Install-time OAuth is disabled; Fastify owns PKCE S256 and single-use server state; a one-time handoff creates a host-only Next.js session; installation account ID/type must match the signed-in GitHub user; no-state setup claims require authentication and re-verification. |

## Required-change disposition

| Review area | Reconciled decision | Primary location |
|---|---|---|
| Product truth/completeness | Product is scoped to connected repositories; UI uses the exact newest-100 reachable default-branch copy and explicit observed/reachable/known-unknown/out-of-scope states. | Architecture §§1, 6–7, 11; Plan M1/M3 |
| Identity/attribution | v0.1 one-to-one GitHub identity uniqueness; no raw Git emails/name matching; nullable ghost actors; author ≠ committer; owner/project/bot and lifecycle collapse rules. | Architecture §§7–8; ADR 0002/0006 |
| GitHub settings and lifecycle | Minimum read permissions, endpoint permit-list, `ping` and unavoidable `github_app_authorization`, paginated installation inventory, mismatch rejection, App-JWT failed-delivery audit. | Architecture §§5–6; Plan M1/M2/M5; ADR 0003 |
| Incremental correctness | Ref-head traversal is primary; 24-hour overlap supplemental; cursor advances with full page transaction; forced/diverged refs preserve prior facts. | Architecture §6; Plan M3; ADR 0004/0005 |
| Webhook validation | 2 MB pre-parse cap, raw-body HMAC, current/previous secret overlap, tolerant Zod stripping, unknown signed actions ignored. | Architecture §§6, 9–10; Plan M1/M6; ADR 0004 |
| Queue semantics | pg-boss remains behind `JobPort`; direct worker connection, 1–2 second polling, direct-only optional LISTEN, queue-independent cursor recovery. | Architecture §§4, 10; Plan M1/M5; ADR 0005 |
| Database topology/isolation | Paid always-on Neon; pooled web/API and direct worker/migrations; small role pools; API/worker writer authority; forced first-schema RLS plus direct-SQL negatives. | Architecture §§3–4, 8–9; Plan M1/M6; ADR 0001/0002/0007 |
| Data minimization | M1 retains messages/titles/lifecycle only; bodies, files/paths/counts, patches, blobs, raw emails, comments/reviews are off. | Architecture §§7–9; Plan rules/M1/M3; ADR 0002/0006 |
| Privacy/telemetry | M1 allowlist logger and exception scrubber; third-party telemetry disabled until canary tests pass; private text not indexed/shared. | Architecture §§9, 12–13; Plan M1/M6 |
| Retention/lifecycle | Raw payload 7 days; dead letter hard cap 30 days; disconnect/delete, rotation, accurate backup expiry, and isolated restore are Gate A. | Architecture §§8–12; Plan M6 |
| Reconciliation cadence | Active repositories every six hours, all daily, App-JWT delivery audit; weekly deep reconcile deferred until measured. | Architecture §§6, 10–11; Plan M5/M8 |
| Release gating | M1 is a secure vertical slice, not private-data readiness. Gate A remains M1–M6; M7 is soak/quality; multi-user work requires Gate C review. | Architecture §11/§15; Plan release gates |

## Decisions retained

- Option B TypeScript modular monolith with separate web/API/worker processes.
- Next.js, Fastify, PostgreSQL/Drizzle, and pg-boss behind an abstraction.
- Railway plus Neon, subject to always-on/restore/network evidence.
- GitHub App least privilege, tenant-scoped source copies, durable asynchronous webhook processing, and one normalized factual event projection.
- No repository clones, blobs, source contents, or diff patches.

## Deliberately deferred

All-active-branch history, weekly deep reconcile, per-commit files/statistics, PR/issue/release bodies, comments/reviews/deployments, co-author trailers, AI analysis, organization support, and multi-user beta remain experiments or later milestones. None may enter Gate A implicitly; each requires its own benefit/API-cost/privacy/retention/migration decision.

## Readiness statement

The architecture documents are reconciled and implementation may start with sandbox data. Real private-owner reliance remains conditional on Gate A evidence, including paid always-on restore, tenant isolation, failed same-GUID recovery, authoritative push ingestion, telemetry canary tests, expiry/deletion, and secret rotation.
