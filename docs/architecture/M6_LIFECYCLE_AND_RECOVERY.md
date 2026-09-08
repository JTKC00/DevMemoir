# M6 lifecycle and recovery evidence

## Implemented boundaries

`POST /connect/disconnect` requires the owner session and CSRF. It atomically
unselects repositories, clears routed raw payloads, cancels durable sync records,
and advances a durable tenant lifecycle version. Existing normalized history is
hidden; an explicit installation reconnect makes it available again.

Every tenant worker job carries the version under which it was accepted.
PostgreSQL tenant transactions take a shared advisory lock; revocation takes its
exclusive counterpart. Revocation waits for existing writes, and later writes
reject stale work even if an outbound GitHub response arrives after reconnect.
The in-memory adapter serializes operations with the same boundary. Unselect and
GitHub installation removal also invalidate old jobs. A request already sent to
GitHub cannot be recalled; its late result cannot be persisted by stale work.

`POST /account/delete` additionally requires `confirm: "delete_account"`. It
persists `deletion_requested`, revokes sessions and removes existing OAuth
transactions. The hourly privacy worker processes up to 100 pending tenants,
deletes normalized history, raw deliveries, business jobs and profile fields,
then records `deleted`. A fresh worker can discover unfinished requests; purge
is transactional and repeatable. The API reports 202/pending, not completed.

Minimal tenant/user/GitHub identity and installation routing tombstones remain
to deny delayed OAuth, installation claims and webhooks. These identifiers are
retained deliberately and are not anonymous. Automatic re-registration of a
deleted owner is disabled. This is a one-owner product, not a multi-user policy.

Runtime SQL roles cannot read inactive normalized rows or insert/update them.
Only the API can request account deletion; only the worker can invoke purge.
The worker's installation-removal function checks the routed tenant scope.

## Retention limitations

The GitHub App is not uninstalled by disconnect or account deletion. GitHub's
source repository is not modified. Queue delivery copies are separate from
business `sync_jobs`: stale jobs are rejected, but pg-boss execution hints may
remain under its configured seven-day retention. Operational identifiers and
logs are not represented as fully erased. Backup/PITR copies are not modified by
live-data purge. Do not describe these operations as immediate universal erasure.

Before Gate A, confirm queue/log retention, provider backup expiration and an
authoritative deletion ledger outside any restored snapshot. Without that
ledger, a restore must remain quarantined: a snapshot predating deletion does
not contain the later request.

## Local verification

- PostgreSQL 18 runtime-role test covers lock ordering, ciphertext clearing,
  stale writes after reconnect, session denial, idempotent deletion and a fresh
  worker finishing a persisted request.
- Worker tests hold a GitHub response open across disconnect, unselect or
  uninstall, then prove that stale work cannot insert the late commit.
- The synthetic owner journey covers CSRF/confirmation rejection, immediate
  session revocation, login denial, worker purge and repeated purge.
- `packages/github/src/rotation.test.ts` creates temporary RSA keys in memory,
  runs the real Octokit client against a fake signature-verifying endpoint,
  accepts both keys during overlap and returns 401 for the revoked signer.
- `apps/api/src/webhook.test.ts` checks exact-byte signatures, old/new overlap,
  removal of the previous secret and rejection of a changed body.

These are local/synthetic checks, not evidence that GitHub revoked a real key.

## Rotation procedure for an isolated provider rehearsal

For a webhook secret, deploy the new value as `GITHUB_WEBHOOK_SECRET` and retain
the previous value as `GITHUB_WEBHOOK_SECRET_PREVIOUS` across API instances.
Switch the GitHub webhook configuration, verify signed delivery receipt, then
remove the previous value and restart all API instances. Record receipt status
for the new signer and rejection of the old signer without recording secrets.
The variable names match `packages/config/src/index.ts`.

For the App private key, create a second key, deploy it to API and worker, and
restart both: Octokit clients and installation-token caches are process-local.
Verify a fresh App JWT and installation request before deleting the previous
key in GitHub. Record the old JWT rejection and the new JWT success. Do not
assume an already-issued installation token is revoked merely by key deletion.
GitHub supports overlapping private keys and requires explicit deletion of old
keys ([official key management](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)).

## Synthetic PostgreSQL 18 restore

After `pnpm build`, with compatible PostgreSQL 18 `pg_dump` and `pg_restore`:

```sh
RESTORE_REHEARSAL_ADMIN_URL=postgres://devmemoir@127.0.0.1:5432/postgres \
PG_BIN_DIRECTORY=/path/to/postgresql-18/bin \
node scripts/restore-rehearsal.mjs
```

The script accepts only a local server, creates two uniquely named databases,
seeds synthetic history, dumps it, deletes the source account, and restores into
the new target. It verifies the restored commit/head, revokes restored sessions,
replays the newer deletion ledger, verifies zero remaining commits/repositories,
and checks forced RLS and deleted-identity denial. It drops only databases it
created and removes the temporary archive. It never starts an API/worker or
contacts GitHub from the restored target.

On 2026-09-07, PostgreSQL/clients 18.4 passed this rehearsal: one commit restored,
zero after ledger replay, restored sessions rejected and forced RLS retained.
This is a logical dump/restore, not Neon PITR or a production RTO measurement.

Provider acceptance still needs the paid/always-on plan, configured restore
window, isolated target, actual PITR operation, deletion-ledger freshness,
runtime-role tests, queue rebuild and content-free recovery timing evidence.
Gate A remains open until those facts are verified.
