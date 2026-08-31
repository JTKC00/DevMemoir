# Milestone 6.1 — Raw webhook payload retention and purge

## Purpose and boundary

M6.1 enforces the raw webhook retention contract. Encrypted webhook bodies are temporary. Normalized source facts, canonical events, delivery identity, and reconciliation state are not.

This slice does not implement disconnect, account deletion, secret rotation, PITR restore, or Gate A sign-off.

## First-receipt authority

Retention deadlines are computed from first receipt, never from last receipt, retry, processing attempt, redelivery, or state change.

```text
payload_expires_at is a function of first_received_at / received_at and current policy
PostgreSQL timestamps are authoritative
queue job timestamps are not
```

Constants live in `@devmemoir/db`:

```text
RAW_WEBHOOK_STANDARD_RETENTION_MS = 7 days
RAW_WEBHOOK_DEAD_LETTER_RETENTION_MS = 30 days
RAW_WEBHOOK_PURGE_BATCH_SIZE = 500
```

Helpers `standardPayloadExpiry` and `deadLetterPayloadHardCap` are the only policy calculators.

A new routed webhook stores `payload_expires_at = first_received_at + 7 days`. A new unrouted webhook stores `payload_expires_at = received_at + 7 days`. One receipt timestamp is captured and reused.

## What does not extend retention

Same-GUID redelivery updates `last_received_at` and `receipt_count` only. It does not move `payload_expires_at` and does not restore `payload_ciphertext` after purge.

`received`, `processing`, `failed`, `processed`, and `ignored` never extend the deadline. `claimDeliveryForProcessing` is itself an ordinary-state transition, so it sets `payload_expires_at = first_received_at + 7 days`. Processing leases are unrelated to privacy retention.

## Dead-letter hard cap

Transition into `dead_letter` sets:

```text
payload_expires_at = first_received_at + 30 days
```

That cap is not `dead_letter_at + 30 days`. Repeated dead-letter/retry/dead-letter cycles cannot move past the first-receipt + 30-day instant.

If ciphertext is already NULL, dead-letter does not restore it.

## Dead-letter recovery

A later transition out of `dead_letter` into an ordinary state returns the seven-day policy:

```text
payload_expires_at = first_received_at + 7 days
```

Recovery on day 20 therefore has an already-past deadline. The next purge removes remaining ciphertext immediately. Recovery never grants a fresh seven days.

`dead_letter` → `processing` through `claimDeliveryForProcessing` is the normal recovery path and immediately restores standard retention.

State mutation is centralized in `updateDelivery` and `claimDeliveryForProcessing`: callers do not compute expiry.

## Routed and unrouted tombstones

When `payload_ciphertext IS NOT NULL AND payload_expires_at <= now`, purge sets:

```text
payload_ciphertext = NULL
payload_key_version = NULL   -- routed only
```

The row remains. Delivery GUID, event/action, installation/repository ids, ref metadata, receipt timestamps, counts, state, lease/job fields, sanitized error, and `payload_expires_at` stay.

Unrouted `payload_ciphertext` is nullable. After expiry the GUID tombstone remains so `ON CONFLICT (github_delivery_guid) DO NOTHING` cannot rehydrate a later same-GUID body or restart the clock.

Once ciphertext is NULL for a GUID, it stays NULL forever.

## Normalized facts survive

Purge does not delete or rewrite repositories, access, commits, branches, tags, pull requests, issues, releases, development events, cursors, reconciliation generations, delivery audits/repairs, or maintenance windows.

## Bounded hourly worker purge

Job kind `privacy_payload_purge` is not an M5 maintenance task. Cron is `17 * * * *` UTC.

`registerOperationalSchedules` registers M5.3 maintenance plus this privacy schedule. Worker boot and M5.5 queue rebuild both call that path. Missed hours are not replayed; the next hourly run is enough.

Each execution purges at most 500 routed rows and 500 unrouted rows, ordered by `(payload_expires_at, id)`, using `FOR UPDATE SKIP LOCKED`. Remaining due rows wait for the next hour. Already-null payloads are no-ops. Concurrent workers cannot restore ciphertext or double-apply a locked row.

The handler uses worker DB authority, makes no GitHub call, decrypts nothing, and logs only:

```text
event_type = payload_retention_purge
result = completed
routed_count
unrouted_count
```

## Privacy-monotonic races

If a payload is due while a processing lease is held, ciphertext may be cleared; lifecycle/lease remain. Privacy deadline wins.

If dead-letter and purge race, either dead-letter keeps the body until the 30-day cap, or purge NULLs the body and dead-letter records state without restoration. Restoring ciphertext after NULL is invalid.

## Authority

Purge is worker-only. `devmemoir_web` cannot mutate webhook payload retention. There is no API or UI to read, download, or restore raw payloads.

Queue state is not retention authority.

## Explicit non-goals

Account/tenant/repository deletion, disconnect UI, session revocation, secret/key rotation, backup/PITR, raw payload viewer, archive export, Sentry/OTel, and new GitHub ingestion.
