# ADR 0006: Source entities plus normalized development events

**Status:** Proposed  
**Date:** 2026-08-21

## Context

Raw GitHub events are transport-specific and insufficient for trustworthy timelines or future classification.

## Decision

Persist canonical GitHub source entities and project them into tenant-scoped `development_events` with controlled type/verb, actor role, source identity, source timestamps, attribution confidence, and optional versioned classification fields.

## Consequences

Timelines remain stable as webhook payloads evolve and classifiers can be rerun. Projector semantics must prevent double counting and be covered by fixtures/evaluation examples.

