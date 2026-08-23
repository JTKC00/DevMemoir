# Milestone 3 historical backfill contract

**Scope:** selected connected repository only  
**Source of truth:** authoritative GitHub REST pages fetched with the installation credential  
**Queue:** pg-boss through `JobPort`; queue state is not recovery truth

## Stages and durable progress

M3 reuses `sync_cursors`. One durable row exists for each ordered stage:

1. `default_branch_commits`
2. `branches`
3. `tags`
4. `pull_requests`
5. `issues`
6. `releases`
7. `completed`

The default-branch row uses the canonical branch name as `ref_name`; repository-wide stages use the non-null empty-string sentinel. A progress row records `pending | in_progress | paused | completed`, a structural `cursor.nextPage`, the commit traversal anchor where applicable, the observation generation, last success, pause/error metadata, completion time, and the scoped completeness state. `completed` means only that the supported source stage exhausted its authoritative pagination. It never means complete GitHub history.

## Atomic page rule

Every physical historical job handles at most one authoritative source page. After the response is normalized at the GitHub boundary, one tenant-local PostgreSQL transaction:

1. verifies that the installation remains active and the repository remains selected and accessible;
2. locks the stage cursor;
3. compares the stored cursor with the worker's expected cursor;
4. idempotently upserts every supported fact on the page;
5. updates ref reachability or final inventory presence where applicable;
6. advances to the next structural page, or completes the stage and activates the next stage;
7. commits.

A mismatch is a replay/stale worker result: it does not rewrite facts or advance progress. A failure before commit leaves both page facts and the cursor unchanged. A retry after commit observes the advanced cursor and moves forward. Queue acknowledgements may happen later without changing that contract.

## Commit traversal and reachability

Historical commit discovery begins at the authoritative current default-branch ref head and paginates `GET /repos/{owner}/{repo}/commits` with that SHA as the anchor. Commit identity is repository plus SHA. A new anchor resets the structural page to one and marks prior default-branch reachability false without deleting commit facts. The worker rechecks the authoritative head before completing the traversal; only the confirmed anchor is published as the branch head.

This separates:

- a commit historically observed by DevMemoir;
- a commit reachable from the authoritative default branch at the committed sync;
- a preserved commit that is no longer reachable after a force-push, rebase, or divergence.

M3 does not traverse every active branch's history. Branches are a normalized current ref inventory.

## Mutable-source ordering and overlap

Pull requests and issues use GitHub `updated_at` as the conflict winner; equal or newer authoritative snapshots may update a row. GitHub's release REST shape has no `updated_at`, so releases use `published_at` (falling back to `created_at`) and accept only a strictly newer source clock after the first observation. This deliberately prefers non-regression over accepting an ambiguous equal-clock release edit. Ingestion time alone never wins.

A separately checkpointed 24-hour refresh page may re-observe recently mutable metadata. It does not change or replace `cursor.nextPage`. Structural pagination still starts at page one and continues until the final Link page, so older facts remain discoverable.

## Installation request lane and pauses

All installation-authenticated requests share an installation-keyed lane with concurrency one by default (maximum two). Different installations have independent lanes. The client observes `Retry-After`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` and returns only sanitized pause/access classes to the worker.

`InstallationRequestLanes` is process-local traffic control: it bounds per-installation concurrency and stops same-process follow-up calls immediately. PostgreSQL `github_installations.api_paused_until` is the durable recovery truth. Every worker entry point and every installation-client method performs a tenant-scoped durable preflight before an outbound request, so a replacement worker, duplicate delivery, page transition, stage transition, inventory refresh, or webhook sync cannot bypass an unexpired pause.

Primary exhaustion pauses until reset. Secondary limits honor `Retry-After`, otherwise use a bounded backoff of at least one minute. A successful installation response whose sanitized headers report `X-RateLimit-Remaining: 0` is observed at the GitHub boundary and awaited through the worker's store observer before the response is released; the future pause is therefore durable even if the process dies immediately afterward. Raw responses are never persisted or logged.

The worker preserves the cursor, never sleeps, and schedules one timestamped delayed physical wake for the same durable position. Repeated observations of the same pause reuse that wake identity; the canonical business cursor remains singular and the queue is not recovery truth. A worker may clear the pause only at or after `api_paused_until`; before then it returns without a GitHub request. A gated page result never blindly schedules an immediate replacement: stale checkpoints recover from the current durable position, while pause-gated work waits for the durable wake. `401`, non-rate-limit `403`, and ambiguous `404` pause historical work and trigger one authoritative M2 installation inventory check; they do not hot-loop.

## Retained and excluded data

M3 retains normalized commit identity/message/linked actor/timestamps/parents/verification; branch and tag identity/head or target/presence observations; and metadata-only pull request, issue, and release identity, title/name, state flags, linked actor IDs, source URL, and lifecycle timestamps.

M3 does not request, retain, enqueue, log, or project bodies, comments, reviews, labels, source files, file paths, file counts/statistics, patches, diffs, blobs, source trees, archives, clone URLs, raw Git email, release assets, workflow artifacts, or raw GitHub responses. PR, issue, release, branch, and tag event projection remains Milestone 4.

## Completeness language

- **Observed:** the supported source fact was normalized and committed.
- **Reachable at sync:** the commit/ref was reachable from the authoritative ref during the committed synchronization.
- **Known unknown:** deleted refs, rewritten history, visibility limitations, or facts that cannot be reconstructed from current refs.
- **Out of scope:** intentionally excluded data classes and all-active-branch historical traversal.

Required owner-facing copy:

> Historical facts observed from the connected repository through supported GitHub APIs. Deleted or rewritten history that DevMemoir never observed may be unavailable.
