# ADR 0007: Railway container hosting for v0.1

**Status:** Proposed pending two-week measurement  
**Date:** 2026-08-21

## Context

DevMemoir needs ordinary HTTPS endpoints, an always-capable worker, scheduled jobs, and simple individual operations.

## Decision

Deploy Next.js, Fastify, and the worker as container services on Railway in the same region as Neon. Build API and worker from the same image with different commands. Do not depend on proprietary function APIs.

## Consequences

Long jobs and separate scaling are straightforward, and migration remains container-based. Metered cost and external database networking require alerts and measurement.

## Validation

Run the first vertical slice for two weeks and record p95 webhook receipt, connection errors, worker restart behavior, and projected monthly cost.

