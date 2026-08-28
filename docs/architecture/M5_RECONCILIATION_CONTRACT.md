# Milestone 5.1 — Reconciliation foundation

**Scope:** the one currently selected, accessible repository for the active owner installation  
**Source of truth:** authoritative GitHub REST responses obtained with an installation credential  
**Queue:** pg-boss through `JobPort`; normalized source facts and `sync_cursors` remain recovery truth

## Bounded purpose

M5.1 repairs supported repository changes that were missed by webhook delivery or processing. It does not audit GitHub App deliveries, request redelivery, reconcile every authorized repository, expose health UI, rebuild queues, or add a scheduler/alerting system. Those remain M5.2.

The supported reconciliation envelope is exactly the existing M3/M4 envelope: repository inventory and metadata, the selected repository's current default-branch reachable commits, branches, tags, metadata-only pull requests, issues, and releases. It does not add endpoints or retained data classes. Bodies, comments, reviews, files, paths, statistics, patches, blobs, raw Git identities, assets, workflow data, and source content remain unrequested and unpopulated.

## Durable identity and state

A reconciliation request carries only opaque scope and execution fields: tenant ID, repository ID, installation numeric ID, UUID reconciliation run ID, stage, page, and observation time when applicable. Repository names, ref names, commit anchors, titles, messages, URLs, webhook payloads, tokens, and GitHub response data never enter the queue payload or logical key.

The logical run identity is:

```text
reconcile:{repository_id}:{reconciliation_run_id}
```

The run ID is an opaque caller-generated identifier. Replaying the same run ID resumes or observes the same durable generation. A different run ID may begin only by atomically resetting the selected repository's ordered `sync_cursors` after the authoritative inventory gate succeeds. The cursor JSON records the run ID so delayed jobs from an older generation cannot advance the newer generation.

M5.1 reuses the ordered M3 stages:

1. `default_branch_commits`
2. `branches`
3. `tags`
4. `pull_requests`
5. `issues`
6. `releases`
7. `completed`

Within a generation, stage state remains `pending | in_progress | paused | completed`. Starting a new generation resets page/checkpoint, pause/error, completion, and observation-generation fields without deleting normalized facts. `last_full_reconcile_at` advances only when the `completed` stage is committed. A repeated completed run ID is a no-op.

## Authoritative flow

1. A coordinator job resolves the installation and the currently selected repository from PostgreSQL using opaque IDs.
2. It gates inactive, suspended, deleted, disconnected, unselected, or inaccessible scope before token/client creation.
3. It checks the durable installation rate-limit pause before every outbound request.
4. It refreshes the complete paginated installation inventory and installation snapshot. Webhook payload data is not an input.
5. It re-reads the repository/access rows. If selection or access was lost, the run stops without resetting or advancing source cursors.
6. It atomically begins or resumes the requested reconciliation generation in `sync_cursors`.
7. Each subsequent physical reconciliation job fetches at most one authoritative source page and uses the existing M3 atomic page rule: gate and lock, compare the stored generation/cursor with the expected generation/cursor, idempotently upsert normalized facts, update reachability/inventory observations, advance the cursor/stage, and commit.
8. After each accepted source-page transaction, M4 reprojection reads only normalized PostgreSQL facts and atomically replaces the repository's canonical event slice.
9. The final stage records successful completion and `last_full_reconcile_at`. Queue acknowledgement may occur later without affecting source truth.

## Interruption, replay, and ordering

A failure before a source-page transaction commits changes neither facts nor its cursor. A retry after commit sees the advanced structural checkpoint and continues from it. Duplicate workers may perform the same bounded read, but only the worker whose expected generation/cursor still matches can commit. Source natural keys and source-clock conflict rules prevent duplicate or stale source rows; deterministic M4 logical keys prevent duplicate events.

Commit reconciliation starts from the authoritative current default-branch head. A changed head restarts the structural traversal for that generation, preserves previously observed commits, and updates reachability only when the authoritative walk is safely published. Branch and tag final pages tombstone facts absent from the completed observation generation. Mutable PR, issue, and release facts retain the M3 source-clock rules.

## Gates and rate limits

All installation-authenticated reconciliation calls use the existing installation-keyed request lane. The durable `github_installations.api_paused_until` check runs at worker entry and immediately before every client method. Primary/secondary exhaustion persists an opaque pause reason, leaves source facts and the current cursor unchanged, and schedules one timestamped wake for the same reconciliation generation and position. No worker sleeps through a pause.

`401`, non-rate-limit `403`, and ambiguous `404` pause source work behind authoritative installation inventory. Suspension, uninstall, repository removal, unselection, or tenant/installation mismatch produces no GitHub request and no cursor advance. Re-selection with confirmed access may safely resume the same generation.

## Privacy and credential boundary

Reconciliation uses only GitHub App installation credentials minted just in time. It has no user-token dependency. Installation tokens and App JWTs are not persisted, enqueued, or logged.

Logs contain only allowlisted opaque IDs, stage/state/result counts, projection version, rate-limit bucket, and sanitized error code/class. They never contain repository/source names, titles, messages, bodies, refs, paths, payloads, request/response objects, credentials, or private source content.

## Acceptance evidence for M5.1

Automated tests must prove:

- an intentionally missed supported webhook change is imported from authoritative API state;
- replay of the same reconciliation generation creates no duplicate source or canonical event rows;
- interruption before and after a page commit resumes from the durable cursor;
- a rate-limit pause advances neither source facts nor cursor and performs no request before the durable pause expires;
- inactive, inaccessible, or unselected scope is gated before GitHub access;
- a repaired source fact triggers deterministic M4 reprojection from PostgreSQL facts;
- queue payloads, logical keys, logs, and serialized errors contain no private source canaries.

## Deferred to M5.2

- App-JWT failed-delivery audit and redelivery;
- six-hour scheduling and daily all-authorized-repository reconciliation;
- owner health/backlog dashboard and manual retry controls;
- queue rebuild procedure and tooling;
- worker heartbeat, age metrics, alerts, and broader quota policy;
- any new ingestion scope or GitHub content collection.
