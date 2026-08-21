# ADR 0005: PostgreSQL-backed jobs for v0.1

**Status:** Proposed pending kill/load experiment  
**Date:** 2026-08-21

## Context

Backfills and reconciliation require durable leases, retries, scheduling, and checkpoints, but v0.1 should not operate Redis or a cloud queue unnecessarily.

## Decision

Use pg-boss behind an application-owned `JobPort`. Keep business checkpoints in `sync_jobs`/`sync_cursors`, not only in queue internals.

## Consequences

One datastore simplifies operations and transactions. Queue traffic shares database resources. The adapter boundary permits later migration to SQS/Redis without rewriting job handlers.

## Validation

Kill workers mid-stage, deploy during work, enqueue 100k test jobs, and measure lease recovery, latency, and database contention.

