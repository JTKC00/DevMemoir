# Repository improvement progress

## Objective and outcome

The local implementation now covers tenant lifecycle fencing, session revocation,
account deletion, timeline usability, core journey tests and CI deduplication.
Synthetic key-rotation and PostgreSQL 18 restore rehearsals are implemented.
Gate A remains open: real provider rotation, paid/always-on backup/PITR,
external deletion-ledger and queue/log-retention evidence are still required.

## Changes

- Added CSRF-protected current-session logout and all-session revocation.
- Replaced cookie mutation in a rendered handoff page with a secure Route Handler.
- Distinguished homepage API errors, pending import and no filter matches; added
  UTC day groups, activity/context/bot filters and expandable details.
- Added explicit GitHub disconnect and account-deletion confirmation UI. Deletion
  returns pending, clears cookies after API acceptance and prevents re-login.
- Added migrations 0011/0012, durable lifecycle versions, shared/exclusive write
  fences, stale-work rejection, raw-payload clearing and worker-only live-data
  purge. Disconnect, unselect, uninstall and deletion invalidate old work.
- Added synthetic API/worker journey, runtime-role lifecycle tests, key-rotation
  tests and a quarantined dump/restore rehearsal with newer deletion-ledger replay.
- CI builds once, tests each package once and runs the cross-component journey.
  Worker test files run sequentially because they share pg-boss queue DDL; tests
  of concurrent producers and worker restart remain enabled within each file.

## Evidence (2026-09-07)

- `pnpm install --frozen-lockfile` completed without changing the lockfile.
- Production build, workspace typecheck and lint all passed. Build used the
  requested Next.js 15.5.25 (the earlier local
  installation was 15.5.23; that dependency mismatch is now resolved).
- PostgreSQL 18.4 DB suite: 77 tests passed, including forced RLS, API/worker
  privileges, revoke/reconnect fencing, deletion and restart discovery.
- Final workspace run: 340 tests passed across 55 files, including all 133 worker
  tests and PostgreSQL integrations; no tests skipped. The separate synthetic
  journey passed as well (341 automated tests total).
- API: 40 tests passed. Web: 28 tests passed. GitHub client: 30 tests passed,
  including real Octokit JWT signing with ephemeral keys against a fake verifier.
- Synthetic owner journey passed: auth/handoff replay prevention, installation,
  import, filters, outage/retry, stop, logout/re-login, disconnect, deletion
  confirmation/CSRF, session invalidation, denied re-login and repeatable purge.
- Logical restore on isolated PostgreSQL/clients 18.4 passed: one commit restored,
  zero after newer deletion-ledger replay; restored sessions rejected, deleted
  identity rejected and forced RLS preserved. No provider PITR was performed.
- Desktop browser journey passed earlier. Independent Chromium mobile verification
  confirmed 390×844, document width 390, readable timeline cards and working
  activity-type filters. See `docs/BROWSER_TESTING.md` for browser evidence.
- Public-tree self-tests and current-tree content scan passed (182 files). Before
  staging, a temporary index reflected the removed handoff page. After staging
  the PR changes, the ordinary `pnpm audit:public` command also passed without
  any index override. The scanner itself was not weakened.
- Initial parallel worker tests exposed pg-boss createQueue deadlocks. Running
  the shared-database test files sequentially passed. A test launched while
  dependencies were being replaced was invalidated and rerun after installation.

## Operational limits

Minimal identity/installation tombstones remain intentionally. Queue execution
hints, operational records and backups have separate retention semantics; do not
claim immediate universal erasure. Deleting an account does not uninstall the
GitHub App or modify GitHub repositories. A provider restore must stay quarantined
until deletion records newer than the snapshot are applied and restored sessions
are revoked. The local restore script demonstrates this ordering with synthetic
data; it is not a production recovery tool or a production RTO measurement.

See [M6 lifecycle and recovery](M6_LIFECYCLE_AND_RECOVERY.md) for the implemented
boundary, local commands, rotation sequence and outstanding provider evidence.
