# Milestone 4 — Canonical development-event projection

Milestone 4 has one projection owner: the domain function `projectCanonicalFacts`. It reads normalized source facts already stored for the tenant and repository, then deterministically replaces the repository slice of `development_events`. It never calls GitHub and it never treats webhook payloads as canonical facts.

## Source boundary

The projector may read only these normalized facts:

- `commits` and their normalized GitHub-account links;
- `pull_requests`, `issues`, and `releases`;
- `repositories` and `repository_name_history`;
- `tags` for observed deletion facts;
- repository visibility and timestamps.

Commit refs, branch heads, reachability, cursors, and queue state control synchronization but do not create a second event model. A ghost commit remains in `commits`; it produces an unknown-attribution event only when a usable author or committer timestamp exists. A missing timestamp produces no fabricated event.

## Canonical event vocabulary

| Source fact | Canonical events | Attribution role |
| --- | --- | --- |
| Commit author timestamp | `commit.authored` | `author` |
| Commit committer timestamp | `commit.committed` | `committer` |
| Pull request creation | `pull_request.opened` | `opener` |
| Pull request merge | `pull_request.merged` | `merger` |
| Pull request close without merge | `pull_request.closed` | `unknown_action` |
| Issue creation / close | `issue.opened` / `issue.closed` | `opener` / `unknown_action` |
| Published release | `release.published` | `releaser` |
| Repository created / archived / renamed | `repository.created` / `archived` / `renamed` | `unknown_action` |
| Observed tag deletion | `tag.deleted` | `unknown_action` |

Repository rename facts use the historical boundary timestamp as their stable source identity. A tag's first observation is not treated as a creation event; deletion is emitted only when normalized source state supplies `deleted_at`. Branch lifecycle events are intentionally out of scope for M4.

The approved vocabulary also reserves `issue.reopened`, `release.edited`, and `tag.created`, but M4 does not emit them: the current normalized M3 facts do not preserve sufficient closed-to-open, reliable release-edit, or unambiguous tag lifecycle evidence. No branch lifecycle vocabulary is invented.

Author and committer are always separate factual events, even when the GitHub account is the same. PR opener, merger, and closer are separate roles. A merged PR keeps both `opened` and `merged`; a closed unmerged PR keeps `opened` and `closed`, with the closer unknown unless a future source contract provides an actor.

Each row carries `context_kind` (`personal`, `project`, or `unknown`), `actor_kind` (`user`, `bot`, or `unknown`), `visibility`, `completeness_state`, `attribution_confidence`, and `projection_version`. Bots are retained in the canonical table and are excluded only by default query/UI behavior. Unknown actors and out-of-reach source facts remain queryable.

## Identity and update semantics

The deterministic logical identity is:

```text
tenant_id:repository_id:source_kind:source_external_id:event_type:verb:contribution_role
```

It contains no title, login, message, or URL. `development_events.logical_event_key` is unique and is the conflict target for incremental writes. Source rows are updated only when their source timestamp is newer (or when the normalized source has no prior snapshot); reprojection then derives the complete event set from the latest source rows.

## Default and explicit views

The default API view filters bots and lets the domain timeline projector collapse presentation-only duplicates without deleting facts:

- owner-authored commits are preferred over owner-committed commits;
- a PR is eligible for the owner's default memoir only when the owner has a factual PR contribution role such as opener or merger. Collaborator-only PR lifecycle remains project context and is excluded from the default owner memoir;
- a PR is represented by its merged lifecycle when present, otherwise its owner opening/closing fact;
- a collaborator merger may be displayed while retaining the owner's opener role, but only when the owner already has a factual contribution role on that PR;
- published releases remain explicit project milestones, including collaborator-published releases.

Explicit `personal`, `project`, and `unknown` context queries return canonical facts rather than silently transferring actor identity. Source links are rendered when present; private rows remain tenant-scoped and are marked with their visibility.

## Atomicity and triggers

The worker reprojects after authoritative commit sync, after an accepted historical page, and after repository source synchronization. Authoritative repository inventory changes to projection-relevant normalized metadata trigger local canonical reprojection for the selected tracked repository. Projection continues to read PostgreSQL normalized facts only; inventory reconciliation does not call GitHub again for projection. Archive timestamps use the first authoritative observation time when GitHub does not supply a historical archived-at value. Visibility on projected rows is the current normalized observation, not historical event-time visibility.

Inventory reconciliation and canonical projection remain separate transactions. If reprojection fails after inventory commit, normalized source facts stay committed, the previous projection remains visible, and the inventory job retries the local reprojection. The PostgreSQL implementation runs source reads, projection replacement, and inserts in one tenant-scoped transaction. Any projection failure rolls back both the delete and all inserts, leaving the previous projection visible. The in-memory store mirrors this rollback contract for unit tests.

`0004_m4_canonical_projection.sql` adds the projection metadata, logical-key index, event vocabulary checks, query indexes, commit URLs, and read-only API/Web grants. The worker is the only runtime role with projection mutation privileges.
