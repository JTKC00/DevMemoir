# ADR 0002: PostgreSQL system of record, Neon hosted

**Status:** Proposed with production condition  
**Date:** 2026-08-21

## Context

The product needs relational integrity, idempotent upserts, resumable cursors, JSON payload flexibility, and a portable tenant model.

## Decision

Use PostgreSQL 17+ and ordinary SQL migrations. Use local Docker PostgreSQL for development and Neon Launch for deployed private data. Keep provider-specific Auth/Data APIs out of the core.

## Consequences

The schema remains portable and supports the initial queue. Production use requires cost alerts, a paid restore window, and restore drills.

## Validation

Measure connection/cold behavior across the selected Railway/Neon region and complete a restore before the private-owner release gate.

