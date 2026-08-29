# Milestone 5.3 — Periodic maintenance scheduler

**Scope:** orchestration only. Invoke existing M5.1 reconciliation and M5.2 delivery-audit engines on a cadence.  
**Queue:** pg-boss through `JobPort`  
**Recovery truth:** unchanged — `sync_cursors` / reconciliation generations (M5.1) and `github_delivery_audits` / `github_delivery_repairs` (M5.2)

## Bounded purpose

After worker start, DevMemoir automatically enters its existing repair paths. This milestone does not replace M5.1/M5.2 state machines, does not call GitHub from the scheduler tick, and does not add health UI, alerting, or a generic workflow engine.

```text
periodic scheduler
   ├─ ~6h active-repository reconciliation  → enqueueRepositoryReconciliation (M5.1)
   ├─ daily authorized-repository reconciliation → enqueueRepositoryReconciliation (M5.1)
   └─ ~6h GitHub failed-delivery audit → enqueueGithubDeliveryAudit (M5.2)
```

## Why pg-boss schedules (no new table)

pg-boss 10 stores recurring schedules in `pgboss.schedule` with `PRIMARY KEY (name)` and `ON CONFLICT (name) DO UPDATE`. Registration is therefore a durable upsert: multiple workers and deploys cannot create three copies of the same schedule. Timekeeper evaluates cron in UTC and sends at most one job per queue per minute (`singletonKey` = queue name, `singletonSeconds` = 60). Missed historical ticks are not replayed (`prevDiff < 60` seconds).

A DevMemoir scheduler table would duplicate that authority. None is added.

Because the primary key is the queue name, each cadence has its own queue:

| Job kind / queue | Cron (UTC) | Task |
| --- | --- | --- |
| `maintenance_active` | `0 */6 * * *` | active-repository reconciliation |
| `maintenance_authorized` | `0 0 * * *` | daily authorized-repository reconciliation |
| `maintenance_audit` | `30 */6 * * *` | GitHub failed-delivery audit |

The audit cron is offset by 30 minutes so it does not coincide with the 6-hour reconciliation hour.

## Repository eligibility

M5.1's `enqueueRepositoryReconciliation` still requires an **active installation**, **selected** repository, and **accessible** access. The scheduler does not change that gate.

**Authorized / eligible (daily):** those same repositories — selected, accessible, active installation. Revoked, unselected, disconnected, suspended, or deleted installations/repositories are not enqueued.

**Active (6 hours):** authorized/eligible **and** recently relevant: `coalesce(github_pushed_at, last_authoritative_observed_at, last_seen_at)` is within **7 days**, **or** all three timestamps are null (never observed — still include so a new selection is covered).

v0.1 still has at most one selected repository per tenant. Daily is broader than the 6-hour pass whenever a selected repository has gone stale on GitHub activity.

Discovery walks `installation_routes` (non-RLS routing) then tenant-scoped `listRepositories`. Queue payloads contain tenant UUID, repository UUID, and numeric installation id only.

## Tick shape

A maintenance job is thin:

1. Resolve eligible opaque targets from PostgreSQL (or the App id for audit).
2. Enqueue existing orchestration entry points one repository at a time (no `Promise.all` of GitHub calls).
3. Log allowlisted counts. Do not mutate source facts.

## M5.1 generation preservation

Each tick computes a deterministic UUIDv5 run id from `{task, repositoryId, utc-bucket}`:

- 6-hour bucket: `YYYYMMDDTHH` with hour in `{00,06,12,18}`
- daily bucket: `YYYY-MM-DD`

Replaying the same run id is M5.1 resume / completed no-op. A different run id still follows M5.1: it may start a new generation only after the inventory gate, and a stale generation cannot mutate a newer one.

If a current generation is `in_progress` or `paused`, the tick enqueues **that** run id instead of the bucket id, so a cadence does not reset a rate-limit pause or in-flight walk.

## M5.2 generation preservation

The tick calls `enqueueGithubDeliveryAudit`. `startGithubDeliveryAudit` already resumes `in_progress` / `paused` generations and does not start a new run until the current one is `completed`. If the audit is paused, the tick passes `startAfter: pausedUntil` so it does not bypass the pause.

## Singleton registration and restart

`JobPort.schedule(kind, cron, payload)` maps to `boss.schedule(kind, cron, payload, { tz: "UTC" })`. Repeated `registerMaintenanceSchedules` upserts the same three rows.

Worker boot:

```text
jobs.start()            // create queues including maintenance kinds
registerMaintenanceSchedules()
jobs.work(...)          // including maintenance handlers
enqueue one current tick per task (bucket singleton)
resume M5.2 in_progress/paused audit and requesting repairs
```

Queues exist before `schedule()` (foreign key). Handlers are attached before or immediately after registration; a fired tick waits in the queue. Boot also enqueues **one** current-bucket tick per task using `singletonKey = job kind` on the stately maintenance queues. That is catch-up after downtime, not N missed intervals. A deploy in the same bucket collides on the singleton and does not fan out twice.

## Missed ticks

pg-boss does not enqueue every missed cron fire. After 18 hours offline, the next due window (or the single boot catch-up) runs once. Maintenance engines reconcile **current** authoritative GitHub/Postgres state, so historical tick replay is unnecessary and forbidden.

## Failure handling

Scheduler-tick failures log a sanitized `error_code` and let pg-boss retry the maintenance job. They do not mark M5.1/M5.2 checkpoints successful. Per-repository enqueue failures skip that target and continue. GitHub rate limits remain owned by M5.1/M5.2.

## Privacy and logs

Logical keys, schedule metadata, and payloads may contain: job kind, task name, UTC bucket, tenant/repository UUIDs, GitHub App id, opaque run ids, counts. They must not contain repository names, titles, messages, payloads, or credentials.

Allowlisted log fields added for this milestone: `maintenance_task`, `eligible_count`, `enqueued_count`, `skipped_count`.
