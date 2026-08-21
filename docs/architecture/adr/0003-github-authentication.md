# ADR 0003: GitHub App user authorization and installation tokens

**Status:** Proposed  
**Date:** 2026-08-21

## Context

Login identity and repository authorization are different grants. Private repository access must be least-privilege and revocable.

## Decision

Use the GitHub App user authorization flow for sign-in and GitHub App installations for repository access. Read repositories using just-in-time, one-hour installation access tokens. Request Metadata, Contents, Pull requests, and Issues read permissions only. Do not use PATs.

## Consequences

Repository grants are explicit and independently revocable. Contents read is broader than actual collection needs, so the GitHub adapter must prohibit blob/content/archive endpoints and the system must never store installation tokens.

