# Milestone 5.2 — GitHub failed-delivery audit and App-JWT redelivery

**Scope:** GitHub App webhook delivery history for this DevMemoir App  
**Source of truth for delivery identity:** GitHub delivery GUID (`X-GitHub-Delivery`)  
**Source of truth for source facts:** existing webhook receipt, normalized ingestion, and M4 projection  
**Authentication:** GitHub App JWT only  
**Queue:** pg-boss through `JobPort`; `github_delivery_audits` and `github_delivery_repairs` are recovery truth

## Bounded purpose

If GitHub itself records that an App webhook delivery failed, DevMemoir discovers that failed delivery with App JWT authentication and requests redelivery of the same GUID. The later webhook is handled by the existing receipt pipeline. M5.2 does not ingest GitHub audit payloads as source facts, does not use a user OAuth token, and does not use an installation token for App delivery APIs.

M5.1 repository reconciliation remains the independent repair path for source drift and missed supported changes.

## Out of scope

Daily all-authorized-repository reconciliation, owner health UI, manual retry UI, queue rebuild tooling, worker heartbeat/alerting, generic scheduler rewrite, M6 privacy/lifecycle work, new GitHub ingestion scope, and any user-token repair path.

## Authentication and endpoints

App delivery APIs require a GitHub App JWT. They do not work with user access tokens or installation access tokens.

Permit-listed endpoints:

- `GET /app/hook/deliveries` — list deliveries, newest first, cursor pagination
- `POST /app/hook/deliveries/{delivery_id}/attempts` — request redelivery by GitHub numeric delivery id

Do not call `GET /app/hook/deliveries/{delivery_id}`. That response includes request and response payloads.

Credentials:

- mint the App JWT just in time through the existing `@octokit/app` client;
- never persist, enqueue, or log the App JWT, private key, user token, or installation token;
- sanitize GitHub errors to class/code/status only.

App JWT traffic uses a process-local request lane independent of installation-token lanes. Durable pause state lives on `github_delivery_audits`, not `github_installations.api_paused_until`.

## Authoritative GitHub list semantics

List pages are newest-first. One physical audit job fetches at most one page (`per_page=100`) and follows GitHub `Link` cursors.

For each GUID, only the newest attempt observed during the walk is decisive:

- status code `200–399` means a GitHub attempt succeeded: do not request redelivery;
- any other status code, including `0`/timeouts, is a failed newest attempt and may enter repair;
- older attempts for a GUID already considered with a newer `delivered_at` are ignored.

The walk stops when `delivered_at` is older than or equal to the durable high-water timestamp from the previous completed run, or when GitHub has no further page. The first run's stop bound is the GitHub three-day redelivery window.

Unsupported events never enter repair logic. Repairable events are exactly the existing webhook contract:

`push`, `ping`, `github_app_authorization`, `installation`, `installation_repositories`, `repository`, `create`, `delete`, `pull_request`, `issues`, `release`.

## Same-GUID correlation

GitHub delivery GUID is the durable external identity. DevMemoir never invents a replacement GUID and never creates a second `webhook_deliveries` row for a redelivery of the same GUID.

GitHub's numeric `id` identifies one attempt and is the parameter required by the redelivery API. Repair state stores that numeric id so redelivery can be requested without fetching payload-bearing delivery details.

Local `webhook_deliveries` remains authoritative for processing progress. Same-GUID receipt already increments `receipt_count` / `last_received_at` and resumes one logical job; only `processed` and `ignored` are terminal no-ops.

## Local matching cases

Before requesting redelivery, re-read local state (locking the local delivery when a tenant can be resolved via `installation_routes`).

| Case | Local row | Action |
| --- | --- | --- |
| A | `received`, `failed`, or `dead_letter` | Request redelivery when retry policy allows. Later same-GUID receipt resumes that row. |
| B | `processed` or `ignored` | Do not reopen or redeliver. |
| C | `processing` | Do not create parallel processing or redeliver. |
| D | none | Missed webhook. Request GitHub redelivery. Do not insert `webhook_deliveries`, source facts, or canonical events from audit data. |

If local state becomes `processing` / `processed` / `ignored` between the list read and the redelivery decision, the re-check wins.

## Intended flow

```text
GitHub failed delivery detected
  → durable repair row for the GUID
  → re-check local delivery state
  → App-JWT redelivery of GitHub's numeric attempt id
  → GitHub POSTs the webhook again with the same GUID
  → existing webhook receipt / ingestion
  → M4 projection from PostgreSQL normalized facts
```

## Durable audit generation

`github_delivery_audits` is a singleton per GitHub App id. It is App-global operational state, like `installation_routes`: it stores opaque ids, cursors, timestamps, and sanitized pause/result fields only.

| Field | Role |
| --- | --- |
| `github_app_id` | singleton identity |
| `current_run_id` | opaque UUID generation |
| `generation` | monotonic assignment order, never a lexical run-id comparison |
| `status` | `pending \| in_progress \| paused \| completed` |
| `list_cursor` | opaque GitHub next-page cursor for the current run |
| `page_number` | structural page of the current run |
| `stop_before_delivered_at` | previous high water; walk stops here |
| `newest_delivered_at_seen` | newest `delivered_at` fully considered |
| `high_water_delivered_at` | committed high water after a successful run |
| `paused_until` / `pause_reason` | durable rate-limit or auth pause |
| `last_success_at` / `completed_at` | last fully completed run |

A new run id may begin only when the current generation is missing or `completed`. Replaying the current run id resumes the stored cursor. A delayed page job whose run id is not current is a no-op: it must not list, redeliver, or advance cursors.

A rate-limit or transient failure must not mark the checkpoint completed and must not advance `list_cursor` / high water.

Page commit is the atomic unit: after the page's repair decisions (and any redelivery claims) are durable, the worker compares the expected cursor with the stored cursor and then advances or completes. A mismatch is a stale worker and does not mutate the newer generation.

## Durable repair and retry policy

`github_delivery_repairs` is keyed by GitHub delivery GUID. It stores retry/redelivery metadata, not source content.

Statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Failed GitHub attempt observed; no worker currently owns the POST |
| `requesting` | DevMemoir owns an in-flight redelivery POST that GitHub has not accepted |
| `requested` | GitHub returned `202` for a redelivery POST |
| `healthy` | Newest GitHub attempt succeeded. **Terminal.** |
| `skipped_terminal` | Local delivery is `processed` or `ignored`. **Terminal.** Stale wakes must not reclaim. |
| `skipped_processing` | Local delivery was `processing` at claim time. **Recoverable:** a later wake re-checks local state. If it is still processing, deny again; if it became terminal, become `skipped_terminal`; if it is retryable, a new `requesting` claim is allowed. |
| `exhausted` / `expired` | Retry budget exhausted, GitHub 404/410, or the three-day window elapsed. **Terminal.** `expired` cannot be reclaimed even if the original `delivered_at` is still inside three days. |

`attempt_count` is the number of GitHub redelivery POSTs **accepted with 202**. Claiming ownership (`requesting`) does not increment it.

Ownership vs acceptance:

```text
pending
  → requesting   (durable claim + 60s lease + repair wake, then POST)
  → requested    (only after GitHub 202)
```

`requesting` is restartable. `next_eligible_at` is the claim lease (or a later rate-limit/transient resume). After the lease expires, a replacement worker may reclaim the same GUID and POST again. Concurrent workers that see a live lease receive `cooldown` and must not POST.

After `202`:

- `last_redelivery_requested_at` is set;
- `next_eligible_at` becomes now plus `min(6h, 15m * 2^(attempt_count-1))`;
- a GUID wake is scheduled at that cooldown.

Crash, rate-limit, or transient failure **before** `202` leaves the row `requesting` with a future `next_eligible_at` and a reconstructable GUID wake. Worker boot scans recoverable rows (`pending | requesting | requested | skipped_processing`) from PostgreSQL and enqueues those wakes. It does not requeue terminal rows (`healthy`, `expired`, `exhausted`, `skipped_terminal`). pg-boss is not recovery truth.

Stale or duplicate GUID wakes may run. Durable status and `next_eligible_at` must make them harmless: they must not POST, must not increment `attempt_count`, and must not move a terminal row back to `requesting`. Queue jobs are advisory. Durable repair state always wins.

Policy:

- maximum 8 **accepted** redelivery POSTs per GUID;
- GitHub deliveries older than three days are `expired`;
- terminal local `processed` / `ignored` and `processing` still win on every claim, including recovered retries;
- identical page/run replay is idempotent: one repair row per GUID, no extra POST while a lease or accepted cooldown is live.

## Queue and scheduling

Job kind: `github_delivery_audit`.

Allowed payload/logical-key fields: GitHub App id, audit run id, page number, opaque cursor, delivery GUID, GitHub numeric delivery id, timestamps, sanitized state/result. Repository names, titles, messages, webhook bodies, GitHub response objects, and credentials are forbidden.

Logical keys:

```text
delivery-audit:{githubAppId}:{auditRunId}:page:{pageNumber}
delivery-audit:{githubAppId}:{auditRunId}:wake:{resumeAtMs}
delivery-audit:{githubAppId}:repair:{deliveryGuid}:wake:{resumeAtMs}
```

`JobPort` has enqueue-with-`startAfter` but no general scheduler. M5.2 therefore keeps the audit **callable and durable** and does not add a pg-boss cron/scheduler layer. A later scheduler may invoke `enqueueGithubDeliveryAudit` every six hours. The worker resumes an `in_progress` or `paused` generation on boot and requeues recoverable GUID repairs from `github_delivery_repairs`, so a queue retry is not the only recovery path.

Audit jobs are not written to tenant-scoped `sync_jobs`. Recovery truth is `github_delivery_audits` / `github_delivery_repairs`.

## Rate limits and API failures

| Failure | Behaviour |
| --- | --- |
| Primary / secondary / Retry-After on list | Persist opaque pause on the current audit generation, leave cursor unchanged, enqueue one delayed wake for that generation and page. No worker sleep. |
| Primary / secondary / Retry-After on redelivery POST | Keep the GUID `requesting`, set `next_eligible_at` to `resumeAt`, enqueue a GUID wake, and pause the audit generation. Do not increment `attempt_count`. |
| Transient 5xx / network on list | Pause the audit generation with bounded backoff; cursor unchanged. |
| Transient 5xx / network on redelivery POST | Keep the GUID `requesting`, bounded backoff, enqueue a GUID wake. Do not increment `attempt_count`. The page may still commit because the GUID record independently guarantees retry. |
| 401 / 403 | Pause the audit generation until `now + 15m`. Defer the GUID to the same `resumeAt` while remaining `requesting` (recoverable). Enqueue a GUID wake at `resumeAt`. A pre-existing 60s wake may fire earlier; claim must see cooldown and must not POST. Do not increment `attempt_count`. Do not retry hot. |
| 404 / 410 on redelivery | Mark that GUID `expired` (terminal). Continue the page. Later stale wakes no-op. |
| Successful page | Advance cursor only after durable repair decisions for considered deliveries are committed. A GUID left `requesting` still has its own wake/lease. |

## Tenant isolation and privacy

`github_delivery_audits` and `github_delivery_repairs` are App-global operational tables. They contain only opaque identifiers, event/action names from GitHub's delivery list, timestamps, counters, and sanitized codes. They do not store webhook bodies, repository names, titles, messages, or GitHub request/response objects.

This matches `installation_routes` and `unrouted_webhook_deliveries`: App-wide routing/repair metadata is not tenant-private source data. FORCE RLS remains required on tenant-owned tables, including `webhook_deliveries`. Local delivery reads and mutations for a matched GUID run inside the tenant transaction resolved from `installation_routes`. A worker in tenant A cannot update tenant B's `webhook_deliveries`.

Grants: worker `SELECT, INSERT, UPDATE`; API `SELECT`; web none.

Logs may include only allowlisted operational metadata: opaque delivery GUID, opaque audit run id, state, result, attempt, sanitized error code, retry timestamp, rate-limit class, GitHub App id, page number. They never include payloads, names, titles, messages, refs, tokens, App JWTs, private keys, or GitHub response bodies.

## Existing pipeline remains authoritative

M5.2 must not call source upsert or M4 projection APIs using audit list data. Duplicate protection for source facts and canonical events remains the existing natural keys after the redelivered webhook is processed normally.

## Acceptance evidence

Automated tests must prove:

- failed supported delivery with a retryable local row requests redelivery of the same GUID, and later same-GUID receipt resumes that row without duplicate source or M4 events;
- failed supported delivery with no local row requests redelivery and does not synthesize source facts;
- `processed` and `ignored` local rows are not reopened or redelivered;
- a processing/processed race between list and claim prevents duplicate redelivery;
- identical audit page/run replay is idempotent;
- interruption after durable repair commit and replacement-worker resume creates no duplicate local delivery, source, or event rows;
- crash after `requesting` claim and before GitHub `202` recovers the same GUID and eventually POSTs;
- rate-limit or transient 5xx/network during redelivery POST does not count as an accepted attempt and leaves a durable GUID retry;
- the audit/redelivery path does not call user-token methods;
- private canaries are absent from queue payloads, logical keys, logs, serialized errors, and audit checkpoint records;
- PostgreSQL evidence covers same-GUID reuse, terminal protection, retry metadata, checkpoint/restart, and concurrent claim safety.
