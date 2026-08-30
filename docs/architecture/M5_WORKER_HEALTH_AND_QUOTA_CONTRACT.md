# Milestone 5.6 — Worker Health, Lease Alerts & GitHub Quota Policy Closure

## Purpose and boundary

M5.6 is the final Milestone 5 closure slice. It lets the owner answer four operational questions without reading database rows or worker logs:

```text
Is a worker alive?
Is important work stuck?
Are GitHub requests paused or quota-constrained?
Is maintenance/reconciliation keeping up with its intended cadence?
```

It reuses M5.1–M5.5 durable state. It is not a generic monitoring platform.

Health remains derived at request time. The only new table is `worker_heartbeats`. There is no health snapshot, alert history, metrics timeseries, quota history, or incident event table.

## Heartbeat lifecycle

The existing worker process owns heartbeat. There is no second background process.

On boot the worker generates a cryptographically random `worker_instance_id`, writes a heartbeat immediately, then starts normal work. The cadence is `WORKER_HEARTBEAT_INTERVAL_MS` (30 seconds). One heartbeat pass must finish before the next timeout is scheduled.

Graceful shutdown sets `stopped_at` best-effort. A crash leaves the last heartbeat stale. A transient write failure logs a sanitized operational error and retries on the next interval; it does not crash an otherwise functioning worker.

Heartbeat rows contain only opaque worker UUIDs and lifecycle timestamps. They never contain hostname, username, filesystem path, repository names, tokens, secrets, or GitHub content.

Cleanup is opportunistic during heartbeat maintenance: rows whose `stopped_at` or `last_heartbeat_at` is older than `WORKER_HEARTBEAT_RETENTION_MS` (7 days) are deleted.

## Worker state

`getWorkerOperationalHealth` supports more than one worker process. There is no singleton heartbeat row.

| State | Rule |
| --- | --- |
| `healthy` | at least one non-stopped heartbeat is newer than `WORKER_HEARTBEAT_STALE_MS` (90 seconds) |
| `stale` | live workers exist, but none are fresh |
| `stopped` | no live worker; the most recent workers stopped cleanly |
| `never_seen` | no heartbeat row exists |

Returned aggregates are `liveWorkers`, `staleWorkers`, and `lastHeartbeatAt`. Owner UI does not expose worker UUIDs.

A live healthy worker keeps overall worker state healthy even if another instance is stale. A cleanly stopped worker is never `attention_required` by itself.

## Stuck work vs valid pause

Health reports durable work that has lost forward progress. It does not mutate, recover, or take over that work. Queue tables remain non-authoritative under M5.5.

The stuck threshold is `OPERATIONAL_STUCK_WORK_MS` (30 minutes).

| Signal | Stuck | Not stuck |
| --- | --- | --- |
| webhook processing | `state = processing` and `lease_expires_at <= now` | valid future lease, or terminal delivery |
| repository reconciliation | current generation `in_progress` with no durable activity for 30 minutes | future `pausedUntil`, or recent activity |
| delivery audit | `in_progress` with no durable progress for 30 minutes | future `pausedUntil` |
| maintenance window | `completed_at` is null and `updated_at` is older than 30 minutes | recent incomplete window |

A valid future GitHub pause is `degraded`, not stuck.

Delivery repairs reuse M5.4 statuses. Recoverable backlog with a future `nextEligibleAt` is `degraded`. Exhausted repairs, or a large/aged recoverable backlog with no valid pause, are `attention_required`.

## Quota lanes, backoff, and jitter

`InstallationRequestLanes` remains the concurrency authority. Installation traffic is bounded at 1 or 2 in-flight requests. App-JWT delivery audit uses `APP_JWT_RATE_LIMIT_LANE` and must not share installation identity.

GitHub rate-limit handling still honors `Retry-After`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. The server-provided resume time is a hard lower bound. Bounded jitter of 0–5 seconds is added after that bound so paused jobs do not wake in lockstep.

```text
resumeAt = authoritativeResumeAt + jitter
```

Jitter is injected (`GithubRateLimitJitterSource`). Production uses `crypto.randomInt`. Tests inject deterministic values. Business logic never calls `Math.random()` directly.

There is no sleep loop inside GitHub client lanes.

```text
GitHub rate limit
→ durable resumeAt on installation/audit/repair state
→ worker yields
→ later queue/maintenance wake

pg-boss transient execution failure
→ queue retry/backoff
```

Those are separate concerns. M5.6 does not add a parallel retry state machine.

Persisted pause metadata remains: installation/app lane identifier, error code, status, resumeAt, updatedAt. Raw headers and GitHub bodies are not stored.

## `/ops` health derivation

`GET /api/ops/health` remains owner-only (`401` unauthenticated, `403` authenticated non-owner). The API reads worker/lease/quota aggregates; it never accepts heartbeat writes from the browser.

The response adds an `operations` object with opaque worker, reconciliation-age, GitHub quota, lease, and repair counts. No repository names, GUID lists, job IDs, or queue payloads.

Overall state stays `healthy` / `degraded` / `attention_required`.

`attention_required` when any of:

- worker state is `stale`
- expired processing lease exists
- stuck reconciliation, audit, or maintenance window exists
- exhausted repair exists
- large/aged recoverable repair backlog with no valid pause
- M5.4 maintenance/reconciliation/audit freshness is already stale or failed

`degraded` when none of the above apply and any of:

- valid future GitHub rate-limit pause
- recoverable repair backlog
- worker `stopped` or `never_seen`
- normal in-progress work or authoritative pause

otherwise `healthy`.

M5.3 cadence remains: active reconciliation every 6 hours, authorized reconciliation daily. M5.4 stale thresholds remain authoritative (12h active/audit, 36h authorized). Ages are seconds since the most recent successful maintenance completion for that task.

## Alerts

For M5.6, alerts mean:

```text
owner-visible attention_required health signal
+
sanitized structured warning logs
```

There is no email, Slack, SMS, PagerDuty, or third-party webhook.

Structured events are aggregates only: `worker_heartbeat_stale`, `processing_lease_expired`, `reconciliation_stuck`, `delivery_audit_stuck`, `maintenance_window_stuck`, `github_quota_paused`, `delivery_repair_attention`. Repeated identical counts are throttled in-process for 5 minutes because logs are not recovery truth.

## Privacy

Health, heartbeat rows, `/ops`, and warning logs may expose only UUID/count/state/timestamps/durations, sanitized error codes, and numeric status. Canaries (`PRIVATE_REPOSITORY_NAME`, `PRIVATE_COMMIT_MESSAGE`, `PRIVATE_PR_TITLE`, `PRIVATE_WEBHOOK_PAYLOAD`, `PRIVATE_TOKEN`, `PRIVATE_SECRET`) must not appear.

## Explicit non-goals

Prometheus, Grafana, Datadog, Sentry, OpenTelemetry, Slack/email/SMS/PagerDuty, queue browser, arbitrary queue retry/deletion, generic admin console, AI health analysis, auto-scaling, distributed tracing, and all M6 deletion/backup/rotation work.
