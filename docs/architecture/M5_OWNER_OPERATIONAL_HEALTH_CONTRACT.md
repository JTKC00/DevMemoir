# M5.4 Owner Operational Health Contract

## Purpose and boundary

M5.4 lets the configured owner answer whether DevMemoir is healthy, identify degraded or stuck durable work, and invoke narrowly bounded recovery without database or worker-log access. It adds no health snapshot table, scheduler heartbeat, generic queue browser, arbitrary job execution, force/reset action, alerting system, or new ingestion scope.

The owner UI is `/ops`. Its server-side source is `GET /api/ops/health`; private source facts are never inputs to the response.

## Authorization

Every health and recovery route authenticates the existing session and resolves its user through the store. The user's `githubAccountId` must equal `OWNER_GITHUB_USER_ID`. Missing authentication returns `401`; an authenticated non-owner returns `403`. Recovery routes additionally require the existing CSRF token. UI route hiding is not an authorization boundary.

## Stable health response

The response contains `overall`, `generatedAt`, `maintenance`, `deliveryAudit`, `deliveryRepairs`, and `repositories`. Repository entries expose only opaque repository IDs, numeric installation GitHub IDs, generation/stage, normalized state, timestamps, and sanitized error codes. Delivery repair data is counts only. Names, descriptions, payloads, titles, messages, source blobs, credentials, and stack traces are excluded.

Repair `byStatus` always includes exact counts for `pending`, `requesting`, `requested`, `skipped_processing`, `healthy`, `expired`, `exhausted`, and `skipped_terminal`. Recoverable is the sum of the first four; terminal is the sum of the latter four.

## Health derivation and freshness

Health is derived at request time from `maintenance_windows`, current `reconciliation_generations` plus their `sync_cursors`, `github_delivery_audits`, `github_delivery_repairs`, and selected/access-authorized repository state. No parallel checkpoint or background writer exists.

- Active repository reconciliation is stale after more than 12 hours without current/successful activity.
- Delivery audit is stale after more than 12 hours without current/successful activity.
- Daily authorized reconciliation maintenance is stale after more than 36 hours.
- Active reconciliation and delivery-audit maintenance windows use 12 hours.

A repository is `never_run` without a current generation, `paused` while its durable future pause applies, `failed` when an incomplete generation has a sanitized error, `stale` beyond the threshold, `healthy` after recent completion, and otherwise `in_progress`. Delivery audit follows the equivalent existing audit fields. Maintenance uses the newest window per task: completed windows are `completed`, recent accepted incomplete windows without error are `running`, and errored/overdue/missing windows are `failed_or_incomplete`.

Overall state is deterministic. It is `attention_required` for stale/missing maintenance, exhausted repairs, failed/stale reconciliation, or failed/stale delivery audit. Otherwise it is `degraded` for a recoverable repair backlog, an authoritative pause, or a running maintenance window. Otherwise it is `healthy`.

## Safe manual actions

`POST /api/ops/repositories/:repositoryId/reconcile` verifies the repository exists, the installation is active, and selection/access remain valid. Current work returns `already_in_progress`; a future durable pause returns `paused` with `retryAfter`. Otherwise it calls the existing `enqueueRepositoryReconciliation` path. The manual run ID is opaque and deterministic for the next generation, so concurrent requests share one logical job.

`POST /api/ops/delivery-audit/retry` returns `already_in_progress` for current work and preserves future pauses. Otherwise it emits one purpose-built, deterministic recovery command. The worker consumes that command and calls `enqueueGithubDeliveryAudit` with its worker-role store; the API role retains read-only access to M5.2 audit tables. Concurrent absent/completed-audit requests share one command and one effective M5.2 generation.

`POST /api/ops/delivery-repairs/resume` calls `resumeGithubDeliveryRepairs` and returns `recoverableFound`, `enqueued`, and `skipped`. Existing cooldown, `nextEligibleAt`, audit pause, attempt count, claim lease, and terminal-state checks remain authoritative.

New work returns `202`; idempotently handled, paused, ineligible, already-running, and nothing-to-resume results return `200`. Unknown repository IDs return `404`.

## Pause, idempotency, privacy, and non-goals

No endpoint clears `paused_until`, resets a generation/cursor/attempt count, reopens `expired`, `exhausted`, `healthy`, or `skipped_terminal`, deletes maintenance state, directly calls GitHub, redelivers an arbitrary GUID, edits source facts, or runs arbitrary pg-boss jobs. Browser button disabling is convenience only; correctness comes from opaque logical keys and existing M5.1/M5.2 durable transitions.

Operational logs use only allowlisted operation/result, opaque repository or audit identifiers, counts, and sanitized error codes. Privacy canary coverage verifies repository names and event metadata do not enter owner health responses or recovery logs.
