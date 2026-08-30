# M5.5 Queue Rebuild & Durable Recovery

## Purpose and boundary

M5.5 closes the Milestone 5 requirement that **queue tables can be rebuilt without losing source progress**.

pg-boss operational queue state is **not** authoritative. If it is lost, emptied, or replaced, DevMemoir reconstructs pending work from durable PostgreSQL source/recovery truth and re-enqueues existing worker flows.

```text
durable application state
        ↓
derive required unfinished work
        ↓
enqueue idempotent pg-boss jobs
```

Never:

```text
queue rows
→ reconstruct application truth
```

This milestone is an explicit operational recovery procedure. It is **not** a general queue administration system, not automatic on worker boot, and not a new recovery checkpoint.

## Authoritative recovery truth

| Class | Durable truth |
| --- | --- |
| M5.1 reconciliation | `reconciliation_generations`, `sync_cursors`, selected/accessible repository access, active installation, installation API pause |
| M5.2 delivery audit | `github_delivery_audits` |
| M5.2 delivery repairs | `github_delivery_repairs` |
| M5.3 maintenance execution | `maintenance_windows` |
| M5.3 schedule registration | restored via existing `registerMaintenanceSchedules` (pg-boss upsert) |

Deleting queue jobs must not cause source-fact loss, cursor/generation reset, reconciliation restart from page 1 unless the durable cursor requires it, repair-attempt reset, expired/exhausted reopening, bypassed pause, duplicate canonical facts/events, or duplicate completed maintenance execution.

## Supported rebuild targets

Rebuild inspects durable state only. It does not call GitHub to derive the plan.

### 1. M5.1 repository reconciliation

`listQueueRebuildReconciliationTargets()` returns current generations on repositories that are selected, accessible, and on an active installation.

| Durable state | Rebuild action |
| --- | --- |
| `stage = completed` and `status = completed` | skip |
| `pending` / `in_progress` | enqueue existing `enqueueRepositoryReconciliation` for the current `reconciliationRunId` |
| `paused` with `paused_until > now` | enqueue a timestamped wake (`startAfter`) for the same run |
| `paused` with no wake time (access intervention) | record `blocked`; do not resume |
| installation API pause in the future | delay the same current run; do not start a new generation |

Rebuild never mutates `reconciliation_generations` and never creates a generation. The coordinator resumes the durable cursor/stage.

### 2. M5.2 delivery audit

`getQueueRebuildDeliveryAudit(githubAppId)`:

| Durable state | Rebuild action |
| --- | --- |
| no row | nothing |
| `completed` | nothing |
| `in_progress` / `paused` / `pending` | `enqueueGithubDeliveryAudit` with the existing `currentRunId` |
| `pausedUntil > now` | delayed wake only |

Page number and list cursor are preserved. A new audit generation is not started.

### 3. M5.2 recoverable repairs

`listRecoverableGithubDeliveryRepairs` + `resumeGithubDeliveryRepairs`.

Only `pending`, `requesting`, `requested`, and `skipped_processing` produce recovery work. Terminal statuses (`healthy`, `expired`, `exhausted`, `skipped_terminal`) are never reopened. Attempt counts, `nextEligibleAt`, audit pause, and claim/cooldown semantics stay on the repair row.

### 4. M5.3 schedules

`registerOperationalSchedules` upserts the M5.3 maintenance schedules (`maintenance_active`, `maintenance_authorized`, `maintenance_audit`) and the M6.1 privacy schedule (`privacy_payload_purge` at `17 * * * *` UTC) exactly once under existing pg-boss schedule semantics.

Rebuild does **not** enqueue current-bucket catch-up ticks. That remains worker boot behavior. Privacy purge likewise waits for the next hourly schedule rather than replaying missed hours.

### 5. Incomplete maintenance windows

`maintenance_windows` remains authoritative for `(task, bucket)` execution idempotency.

Completed windows (`completed_at IS NOT NULL`) are terminal forever. Rebuild never deletes a window, never changes bucket identity, and never marks a window completed.

An incomplete window whose accepted queue job no longer exists cannot use ordinary `claimMaintenanceWindow()`: that API rejects any job id other than the original accepted id. Queue rebuild uses an exceptional recovery-only CAS:

```text
incomplete window
accepted_job_id = lost-job-a

queue rebuild creates replacement job-b

atomic recovery CAS:
if completed_at is null
and accepted_job_id is still lost-job-a
→ accepted_job_id = job-b
→ updated_at = now

only one rebuilder wins
```

`recoverIncompleteMaintenanceWindow(...)` implements that transition. `last_error_code` is preserved. The replacement job payload includes the original `maintenanceBucket` so the normal M5.3 handler completes the same window.

If replacement enqueue succeeds but the ownership CAS fails before commit, a fresh rebuild resolves the existing active pg-boss singleton job ID and retries the same ownership CAS. Both a newly enqueued replacement and an existing active singleton therefore converge on the same CAS path. Process-local `JobPort` maps are never recovery truth.

`PgBossJobPort.findActiveJobByLogicalKey(...)` is deliberately narrow: with pg-boss 10.4 it queries the adapter-owned pg-boss `job` table by queue name and `singleton_key`, returning only `created`, `retry`, or `active` jobs. Completed, failed, cancelled, and archived jobs are not recovery owners. This is an internal pg-boss 10.4 schema compatibility assumption isolated to the jobs adapter because that version has no public singleton-key lookup API.

This is **not** normal scheduler behavior and must not run on every worker boot. Ordinary multi-worker startup must not steal a legitimately running maintenance owner.

## Command

```text
pnpm ops:queue-rebuild
pnpm ops:queue-rebuild --dry-run
```

The worker package script is `tsx src/queue-rebuild-cli.ts`. The CLI:

1. loads config (`DATABASE_WORKER_URL` for store, `DATABASE_QUEUE_URL` for pg-boss);
2. starts pg-boss and creates required queues (skipped on dry-run);
3. inspects durable truth;
4. registers maintenance and privacy-payload-purge schedules;
5. enqueues unfinished work sequentially;
6. prints sanitized aggregate counts;
7. exits non-zero on `partial` or `failed`.

Dry-run inspects and prints the intended counts with no queue mutation, no source mutation, and no GitHub request.

Example stdout:

```text
reconciliation_resume: 2
delivery_audit_resume: 1
delivery_repairs_resume: 4
maintenance_window_recoveries: 1
schedules_register: 4
blocked: 1
```

No repository names or private source content.

## Idempotency

Correctness comes from durable identities, not process-local flags:

- M5.1 `reconciliationRunId`
- M5.2 `currentRunId` / repair GUID
- maintenance `(task, bucket)`
- pg-boss logical singleton keys
- maintenance-window recovery CAS

A second rebuild of the same unfinished work reuses those identities and cannot create a second effective generation, audit, or maintenance owner.

## Failure semantics

If rebuild fails halfway:

- application durable state remains untouched except for successful incomplete-window CAS rows;
- already enqueued logical work remains safe/idempotent;
- rerunning rebuild continues safely;
- successful partial enqueue work is not deleted;
- the command exits non-zero with sanitized partial counts.

Do not roll back by deleting queued jobs.

## Privacy

Rebuild may log only:

```text
tenant UUID
repository UUID
installation numeric ID
task
bucket
generation
audit run ID
counts
timestamps
sanitized error codes
```

Never repository names, commit messages, PR/issue/release titles, webhook payloads, event bodies, tokens, App private keys, or OAuth credentials.

Observability event: `event_type = queue_rebuild` with `result` in `completed | partial | failed | dry_run` and optional allowlisted counts.

## Operational procedure

Queue rebuild is a takeover of unfinished queue ownership. Preferred workflow:

```text
1. Stop/drain worker processes
   (SIGTERM/SIGINT on the worker; wait until it exits).
2. Confirm database health and recent backups.
3. Dry-run:
   pnpm ops:queue-rebuild --dry-run
   Confirm the sanitized counts match expected unfinished work.
4. Reset pg-boss operational state using the approved helper, not ad-hoc
   application-table SQL.
   Test/admin only:
   resetPgBossOperationalSchema(executeSql, schema)
   which runs:
   DROP SCHEMA IF EXISTS <pgboss-schema> CASCADE
   Application tables are not dropped. Recreate by starting JobPort
   (the rebuild CLI calls jobs.start() unless --dry-run).
5. Run:
   pnpm ops:queue-rebuild
   Non-zero exit means partial/failed; rerun is safe.
6. Start the worker:
   pnpm --filter @devmemoir/worker start
   (or the deployed process manager equivalent).
7. Check /ops and worker logs for opaque progress.
8. Confirm reconciliation/audit/repair resume from durable cursors.
```

`DROP SCHEMA pgboss CASCADE` is last-resort operational SQL after backups. It is test/admin tooling, not a normal worker path.

## Explicit non-goals

Do not implement: generic queue browser, arbitrary retry/delete UI, arbitrary job execution, force reconciliation, force GitHub redelivery, force-reopen exhausted repairs, resetting attempts, clearing rate limits, source-fact rebuild from queue data, M6 deletion/privacy lifecycle, worker heartbeat, alert delivery, PagerDuty/Slack/email, metrics platforms, Grafana/Prometheus, quota-policy redesign, or new GitHub ingestion endpoints.
