# ADR 0004: Durable webhook receipt state machine and authoritative synchronization

**Status:** Accepted (reconciled)
**Date:** 2026-08-21

## Context

GitHub deliveries can be duplicated, delayed, out of order, truncated, or missed after a failed response. A unique delivery GUID identifies an attempt stream; it does not prove that processing succeeded. Push payload commit arrays are explicitly incomplete in several cases and cannot be source truth.

## Decision

The API applies a 2 MB body cap before buffering, verifies HMAC-SHA256 over raw bytes with the current/previous rotation secrets, then validates a tolerant event envelope that strips unknown fields. Invalid signatures are rejected without retaining the body. Valid unsupported events/actions are acknowledged as `ignored`.

In one transaction, upsert `webhook_deliveries` by GitHub GUID, retain an encrypted 7-day payload (30-day dead-letter hard cap), update first/last receipt and receipt count, and ensure one logical processing job/outbox record.

Delivery states are:

- `received`: durably accepted and pending;
- `processing`: leased by a worker;
- `failed`: retryable or awaiting code/config repair;
- `dead_letter`: deterministic attempts exhausted, still owner-retryable as the same delivery;
- `processed` / `ignored`: terminal outcomes and the only same-GUID no-ops.

A same-GUID receipt in `received`, `processing`, `failed`, or `dead_letter` ensures processing is pending/resumable; it never returns success merely because the row exists. Worker/source/event writes and the terminal transition are transactionally ordered and idempotent.

A `push` receipt stores only envelope IDs plus `ref`, `before`, `after`, and `forced`. It never persists payload commit objects/messages. The worker fetches authoritative facts from the current ref head, records reachability, preserves previously seen commits across forced/diverged updates, and treats a 24-hour overlap as supplemental only.

Run six-hour active/daily all reconciliation. Audit failed GitHub deliveries with an App JWT and request redelivery where appropriate.

## Consequences

Receipt latency stays small while failure remains visible and recoverable. Duplicate constraints exist at delivery, logical-job, source, and event levels. Encrypted payload retention aids short diagnosis but is not the recovery source of truth; GitHub API facts and cursors are.

## Validation

Test concurrent receipt, every nonterminal same-GUID redelivery, failed/dead-letter repair, worker kills before/after commit, push payload/API disagreement, forced push reachability, unknown fields/actions, `ping`, size/signature rejection, expiry, and intentionally missed-delivery repair.
