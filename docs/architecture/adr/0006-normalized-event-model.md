# ADR 0006: Source entities plus one normalized factual development-event projection

**Status:** Accepted (reconciled)
**Date:** 2026-08-21

## Context

Transport payloads are incomplete and unstable for trustworthy timelines. DevMemoir must distinguish observed connected-project facts from personal accomplishment and avoid duplicate lifecycle presentation.

## Decision

Retain normalized GitHub source entities, then deterministically project one `development_events` table keyed by tenant/repository/source/verb. Do not create separate per-event tables.

Each event records stable source identity, nullable GitHub actor, `actor_kind` (`user|bot|unknown`), contribution role, `context_kind` (`personal|project|unknown`), timestamps, visibility, attribution confidence, and completeness state (`observed|reachable_at_sync|known_unknown|out_of_scope`). Unknown/ghost actors remain nullable; never match display names or store/match raw Git emails.

Default memoir rules are query/projector policy over preserved facts:

- include the connected owner plus explicitly marked project milestones;
- collapse authored/committed for the same SHA/person, preferring author;
- render a merged PR without a second closed accomplishment;
- never transfer PR/squash authorship to the merger/committer;
- keep collaborator facts as project context unless the owner is actor;
- hide bot events by default while retaining queryability.

v0.1 retains commit messages, titles, lifecycle/linkage, selected labels/milestones, and timestamps. PR/issue/release bodies, commit files/paths/counts, patches, blobs, source content, comments/reviews, and co-author parsing remain off. Later classification is a versioned annotation, not a destructive rewrite or productivity score.

The UI states exactly: **“Newest 100 commits currently reachable from the default branch of this connected repository.”** It never labels the slice complete GitHub history.

## Consequences

Projection enables stable queries and reprocessing while preserving source evidence. Some project facts are intentionally not personal memoir entries. Completeness and collapse policy must remain visible/tested as new event types arrive.

## Validation

Golden fixtures cover owner/collaborator/bot/ghost actors, authored/committed, merged/closed, release milestones, squash attribution, stale updates, force-push reachability, and deterministic reprojection. Schema tests prove bodies/files/raw emails remain absent in v0.1.
