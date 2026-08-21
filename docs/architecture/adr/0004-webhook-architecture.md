# ADR 0004: Durable receipt followed by asynchronous idempotent processing

**Status:** Proposed  
**Date:** 2026-08-21

## Context

GitHub deliveries may be duplicate, delayed, out of order, or permanently missed after a failed attempt.

## Decision

Verify the raw-body HMAC, persist the delivery GUID and limited payload plus an outbox/job in one transaction, return promptly, and process asynchronously. Deduplicate by delivery GUID and entity/event natural keys. Reconcile API truth on schedules.

## Consequences

The system provides at-least-once processing with deterministic convergence rather than exactly-once claims. PostgreSQL availability is required to acknowledge a webhook safely.

