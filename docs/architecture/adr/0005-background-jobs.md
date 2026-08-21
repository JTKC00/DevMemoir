# ADR 0005: PostgreSQL-backed jobs behind JobPort for v0.1

**Status:** Accepted (reconciled; kill/load experiment retained)
**Date:** 2026-08-21

## Context

Backfills, webhook processing, reconciliation, expiry, and deletion need leases, retries, schedules, logical uniqueness, and restartable checkpoints. v0.1 should not operate Redis or a cloud queue without evidence.

## Decision

Use pg-boss behind an internal `JobPort` (`enqueue`, `schedule`, `claim/handle`, `retry`, `cancel`, health). Worker/pg-boss uses the direct Neon URL and a small separate pool. Polling every 1–2 seconds is the baseline; `LISTEN/NOTIFY` is optional only on a direct session connection and never through the pooled web/API URL.

Queue payloads contain opaque IDs and bounded sync hints only—never tokens, webhook bodies, repository content, commit messages, file paths, or user data. `logical_key` prevents duplicate work for a delivery or repository/stage. Leases/heartbeats and graceful drain make worker death retryable.

Recovery truth lives in normalized source rows, atomic page cursors/high-water marks, and delivery states. A queue wipe/rebuild scans those records and reconstructs pending work. A cursor advances only in the same transaction as its full source page.

Use installation lanes of 1–2 concurrent GitHub requests, explicit retry classes, full-jitter backoff, and rate-limit pauses. Keep dead-letter state in the delivery/job audit and provide an authenticated owner retry.

## Consequences

This removes a second stateful service and enables database transactions around job/source state. It consumes direct PostgreSQL connections and can contend with product traffic, so pools, polling, queue depth, oldest age, and transaction duration are monitored separately.

Adopt Redis/SQS only after `JobPort` conformance plus measured contention, latency, throughput, or independent scaling justifies migration.

## Validation

Kill workers before/after source commit and during deploy; rebuild an erased queue from cursors/deliveries; load 100k jobs; verify logical uniqueness, lease recovery, rate-limit pause, small connection budgets, and no half-page checkpoint.
