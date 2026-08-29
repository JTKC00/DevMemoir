# Milestone 5.3 — Periodic maintenance scheduler

**Scope:** orchestration only. Invoke existing M5.1 reconciliation and M5.2 delivery-audit engines on a cadence.  
**Queue:** pg-boss through `JobPort`  
**Recovery truth:** unchanged — `sync_cursors` / reconciliation generations (M5.1) and `github_delivery_audits` / `github_delivery_repairs` (M5.2)  
**Window truth:** `maintenance_windows` claims `(task, bucket)` once

## Bounded purpose

After worker start, DevMemoir automatically enters its existing repair paths. This milestone does not replace M5.1/M5.2 state machines, does not call GitHub from the scheduler tick, and does not add health UI, alerting, or a generic workflow engine.

```text
periodic scheduler
   ├─ ~6h active-repository reconciliation  → enqueueRepositoryReconciliation (M5.1)
   ├─ daily authorized-repository reconciliation → enqueueRepositoryReconciliation (M5.1)
   └─ ~6h GitHub failed-delivery audit → enqueueGithubDeliveryAudit (M5.2)
```

## Two authorities

**Schedule registration** is pg-boss `pgboss.schedule` with `PRIMARY KEY (name)` and `ON CONFLICT (name) DO UPDATE`. Multiple workers and deploys cannot create three copies of the same recurring schedule. Timekeeper evaluates cron in UTC. Missed historical ticks are not replayed.

**Maintenance-window execution** is a separate durable claim. A pg-boss queue singleton is not enough after a job completes or is archived: a later boot or cron fire in the same UTC bucket would otherwise enqueue again. `maintenance_windows` is the execution-window authority.

```text
PRIMARY KEY (task, bucket)
INSERT ... ON CONFLICT DO NOTHING
```

Whichever process inserts the row accepts that window. The accepted pg-boss job id may retry that same invocation. Any other producer is a no-op.

The table is App-global operational metadata (no `tenant_id`, no RLS), like `github_delivery_audits`: cadence is not tenant-owned.

## Recurring schedules (UTC)

Because the schedule primary key is the queue name, each cadence has its own queue:

| Job kind / queue | Cron (UTC) | Task |
| --- | --- | --- |
| `maintenance_active` | `0 */6 * * *` | active-repository reconciliation |
| `maintenance_authorized` | `0 0 * * *` | daily authorized-repository reconciliation |
| `maintenance_audit` | `30 */6 * * *` | GitHub failed-delivery audit |

The audit cron is offset by 30 minutes so it does not coincide with the 6-hour reconciliation hour. The offset is execution staggering only. It does **not** change bucket identity.

## Canonical buckets

| Task | Bucket | Identity |
| --- | --- | --- |
| `active_reconciliation` | 6-hour UTC | `YYYYMMDDTHH` with hour in `{00,06,12,18}` |
| `authorized_reconciliation` | UTC calendar day | `YYYY-MM-DD` |
| `delivery_audit` | **same 6-hour UTC windows** as active | `00:00–05:59`, `06:00–11:59`, `12:00–17:59`, `18:00–23:59` |

A 12:05 boot catch-up and a 12:30 native audit cron both claim `delivery_audit` / `YYYYMMDDT12`. Exactly one performs `enqueueGithubDeliveryAudit`.

The 18:00 bucket is independent of 12:00. Daily `2026-08-30` is independent of `2026-08-29`.

## Repository eligibility

M5.1's `enqueueRepositoryReconciliation` still requires an **active installation**, **selected** repository, and **accessible** access. The scheduler does not change that gate.

**Authorized / eligible (daily):** those same repositories — selected, accessible, active installation. Revoked, unselected, disconnected, suspended, or deleted installations/repositories are not enqueued.

**Active (6 hours):** authorized/eligible **and** recently relevant: `coalesce(github_pushed_at, last_authoritative_observed_at, last_seen_at)` is within **7 days**, **or** all three timestamps are null (never observed — still include so a new selection is covered).

v0.1 still has at most one selected repository per tenant. Daily is broader than the 6-hour pass whenever a selected repository has gone stale on GitHub activity.

Discovery walks `installation_routes` (non-RLS routing) then tenant-scoped `listRepositories`. Queue payloads contain tenant UUID, repository UUID, and numeric installation id only.

## Tick shape

A maintenance job is thin:

1. Derive the current canonical bucket from UTC `now`.
2. Claim `(task, bucket)` with this job id. Losers return immediately.
3. Discover eligible opaque targets (or the App id for audit).
4. Enqueue existing orchestration entry points one repository at a time (no `Promise.all` of GitHub calls).
5. Mark the window completed. Do not mutate source facts.

Boot catch-up and native cron both enter this same handler. They share the same bucket identity.

## M5.1 generation preservation

Each accepted tick computes a deterministic UUIDv5 run id from `{task, repositoryId, utc-bucket}`:

- 6-hour bucket: `YYYYMMDDTHH` with hour in `{00,06,12,18}`
- daily bucket: `YYYY-MM-DD`

Replaying the same run id is M5.1 resume / completed no-op. A different run id still follows M5.1: it may start a new generation only after the inventory gate, and a stale generation cannot mutate a newer one.

If a current generation is `in_progress` or `paused`, the tick enqueues **that** run id instead of the bucket id, so a cadence does not reset a rate-limit pause or in-flight walk.

## M5.2 generation preservation

After the window is accepted, the tick calls `enqueueGithubDeliveryAudit`. `startGithubDeliveryAudit` already resumes `in_progress` / `paused` generations and does not start a new run until the current one is `completed`. If the audit is paused, the tick passes `startAfter: pausedUntil` so it does not bypass the pause.

A second tick in the same audit bucket is a window no-op: it does not call `enqueueGithubDeliveryAudit` and cannot start a second completed generation.

## Singleton registration and restart

`JobPort.schedule(kind, cron, payload)` maps to `boss.schedule(kind, cron, payload, { tz: "UTC" })`. Repeated `registerMaintenanceSchedules` upserts the same three rows.

Worker boot:

```text
jobs.start()            // create queues including maintenance kinds
registerMaintenanceSchedules()
jobs.work(...)          // including maintenance handlers
enqueue one current-bucket tick per task
resume M5.2 in_progress/paused audit and requesting repairs
```

Queues exist before `schedule()` (foreign key). Handlers are attached before or immediately after registration; a fired tick waits in the queue. Boot enqueues the current UTC bucket (`singletonKey` = `maintenance:{kind}:{bucket}`). That is catch-up after downtime, not N missed intervals.

Redeploy or worker replacement in the same bucket: the new tick reaches the handler, the claim conflicts, and the tick no-ops even if the previous job already completed.

## Missed ticks

pg-boss does not enqueue every missed cron fire. After 18 hours offline, the next due window (or the single boot catch-up) runs once. Historical buckets are not claimed or replayed. Maintenance engines reconcile **current** authoritative GitHub/Postgres state.

## Failure handling

Claim happens before work. If the accepted job throws:

- the window row remains (not deleted);
- `last_error_code` is a sanitized code;
- pg-boss may retry **that same job id**;
- a different producer cannot insert a second window for the same `(task, bucket)`.

Successful retry of the accepted job marks `completed_at`. Scheduler-tick failures do not mark M5.1/M5.2 checkpoints successful. Per-repository enqueue failures skip that target and continue. GitHub rate limits remain owned by M5.1/M5.2.

## Privacy and logs

Logical keys, schedule metadata, window rows, and payloads may contain: job kind, task name, UTC bucket, tenant/repository UUIDs, GitHub App id, opaque run ids, job ids, timestamps, counts, sanitized error codes. They must not contain repository names, titles, messages, payloads, or credentials.

Allowlisted log fields added for this milestone: `maintenance_task`, `eligible_count`, `enqueued_count`, `skipped_count`.
