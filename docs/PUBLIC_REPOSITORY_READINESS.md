# Public Repository Readiness

Audit date: 2026-08-31
Final pre-public evidence update: 2026-09-01
Current publication-candidate baseline before this documentation PR: `9332ef3668c02554fc7f2dc67343d0b8a0a257d2` (`main`, PR #14 merge commit)

This document records publication-readiness evidence only. Repository visibility is still private and must not be changed by a documentation or security-audit commit.

## Current tree

PASS — the reproducible committed-tree check is `pnpm audit:public`.

Historical evidence remains useful for explaining count changes:

- PR #11 GitHub Actions CI scanned 156 committed public-tree files.
- A local PR #11 / #12 filesystem snapshot reported 157 because it included ignored generated `apps/web/tsconfig.tsbuildinfo`; that was not a committed-tree count.
- PR #13 GitHub Actions later scanned 157 committed public-tree files after tracked `.gitleaksignore` was added.

`.env` and `.env.*` are ignored with `.env.example` explicitly allowed. No tracked `.env` or private-key file was identified by the readiness audit.

The latest merged default-branch run before this documentation PR is GitHub Actions Run #52 on `main` `9332ef3668c02554fc7f2dc67343d0b8a0a257d2`; it completed successfully after PR #14 merged.

## Full Git history secret scan

PASS for the previously scanned baseline, with one final pre-public recertification still required on the ultimate publication-candidate `main`.

Gitleaks v8.30.1 full-history publication scanning completed on 2026-08-31. This is not a “never had a finding” result: one `generic-api-key` candidate was reported, human-adjudicated as a synthetic test fixture, and ignored only by its exact historical fingerprint.

Scanner: official checksum-verified Gitleaks v8.30.1 binary. Coverage matched the merge-aware audit:

```text
gitleaks git . --log-opts="--all --reflog --full-history -m" --redact --report-format=json --report-path=<repo-external temp path>
```

Historical scan inventory:

- all refs, reflog, full history, merge-aware (`-m`)
- pre-disposition `main` `dfab175`: Gitleaks and `git rev-list --all` both reported 55 commits
- final rerun after the exact-fingerprint disposition commit: Gitleaks and `git rev-list --all` both reported 56 commits

Original result before disposition:

- Gitleaks exit code `1`
- 1 unreviewed finding
- Rule: `generic-api-key`
- File: `apps/api/src/webhook.test.ts`
- Commit: `07351c1a4029b6f18d6d934edbc6da89888185d5`
- Exact Fingerprint: `07351c1a4029b6f18d6d934edbc6da89888185d5:apps/api/src/webhook.test.ts:generic-api-key:9`

Human adjudication:

- synthetic GitHub webhook HMAC unit-test fixture
- not a production credential
- no rotation or revocation required
- 0 confirmed real secrets

Disposition:

- `.gitleaksignore` contains only that exact fingerprint
- no path-wide ignore, whole-file ignore, rule disable, or broad regex allowlist
- production webhook verification logic was not changed
- raw JSON reports were written outside the repository and deleted after verification; matched secret text is not recorded here

Historical clean rerun result:

- Gitleaks exit code `0`
- 0 unreviewed findings
- 0 confirmed real secrets

Because later readiness and owner-decision commits now exist, this historical PASS does not by itself certify the ultimate publication SHA. After this final readiness-evidence PR is merged and the resulting `main` CI is green, rerun the exact same full-history Gitleaks coverage on that ultimate `main`. Publication requires exit code 0, 0 unreviewed findings, and 0 confirmed real secrets. Do not make another repository commit after that final scan solely to record the scan result, otherwise a new unscanned commit would be introduced.

## Private data scan

PASS — no real imported private repository names, private commit messages, PR/issue bodies, raw webhook exports, database dumps, or private dashboard screenshots were found in the current tree or reachable history during the repository audit. Test data uses synthetic owners/repositories, `.example` domains, and explicit privacy canaries.

## Commit metadata privacy

`personal_email_history: yes`
`noreply_email_detected: yes`
`decision: ACCEPTED BY OWNER`

The history contains a non-noreply personal address in addition to GitHub noreply metadata. The owner explicitly accepts this historical metadata exposure for publication and does not require a destructive history rewrite for this reason. This is a privacy decision, not a credential incident.

Future local commits should continue using a GitHub noreply address. The repository does not hard-code the developer's personal address.

## Authenticated GitHub hosted-surface review

PASS — the historical GitHub publication blocker is cleared based on an authenticated review completed 2026-09-01.

### Pull requests and issues

- 13 historical pull requests (#1 through #13) were inventoried; all were closed and merged.
- Connector-visible PR discussion surfaces contained no comments or review discussion requiring remediation.
- No standalone Issues were found in the repository issue search.
- No secret, private repository content, or other publication-sensitive material was identified in the reviewed PR bodies/discussion surfaces.

### Pull-request-triggered Actions

- PR-triggered workflow runs for PRs #1 through #13 were inventoried; all completed successfully.
- Their currently visible artifact listings were empty.
- Job logs for the historical PR-triggered verification runs were reviewed. GitHub auth values were masked, database URLs were localhost CI values, and logged identifiers/payload fixtures were synthetic test data.
- No production database endpoint, GitHub App private key, production webhook secret, PAT/bearer credential, private personal-email value, raw private repository content, or raw webhook body was identified in those reviewed logs.
- PR #10 payload-retention coverage was checked specifically: SQL logging showed parameterized payload-ciphertext handling, not raw webhook payload contents.

### Push-to-main Actions

The authenticated run inventory for `event=push`, `branch=main` contained 25 historical runs at review time:

- 21 successful
- 4 failed
- 0 cancelled
- 0 timed out

The four failed runs were fully reviewed because failure diagnostics carry the highest accidental-disclosure risk. Their failures were early TypeScript/PostgreSQL integration defects, including module-resolution, locking, UUID/test typing, and timestamp-casting errors. Credentials remained masked; database configuration was localhost-only; no production secret, raw webhook body, private repository payload, or production deployment identifier was identified.

Currently visible artifact listings for all four failed push runs were empty. The latest publication-candidate baseline run, Run #52 on `9332ef3668c02554fc7f2dc67343d0b8a0a257d2`, also completed successfully with an empty artifact listing.

The 21 successful push runs were completely inventoried but were not each re-read byte-for-byte during this final pass. This is an explicit coverage note rather than a claim of exhaustive successful-run log transcription. Risk coverage is supported by the previously reviewed PR-triggered runs using the same workflow, complete failed-run review, current successful default-branch CI, and the absence of a workflow path that intentionally dumps secret-bearing environment data.

### Releases and retained artifacts

- Releases: 0
- Release assets: 0
- No currently visible sensitive artifact required deletion in the audited surfaces.

Historical logs or artifacts that GitHub has already expired or deleted cannot be retroactively inspected. This retention limitation does not create evidence that sensitive content existed; it is recorded as a scope limitation.

## GitHub Actions workflow source

PASS — the workflow uses explicit least-privilege `permissions: contents: read`, local PostgreSQL test credentials, and no intentional environment-dump or shell-tracing step around secret-bearing operations.

## Production identifiers

PASS — provider names and links in architecture documents are generic documentation references. No project-specific deployment hostname, private admin endpoint, credential-bearing production URL, Neon host, Railway app host, callback domain, or cloud credential was found in the current tree or reachable history during the publication audit.

## Documentation

PASS — `README.md` is structured for a public audience. `SECURITY.md`, `CONTRIBUTING.md`, the publication checklist, and this evidence document are present. Detailed milestone contracts remain under `docs/architecture/`.

## License

PASS — owner decision recorded: **Source-visible / All Rights Reserved**.

No open-source license is granted at publication time, and no `LICENSE`, `LICENSE.md`, or `COPYING` file is added for an OSS license. Public visibility does not grant permission to copy, modify, redistribute, or create derivative works. Background tradeoffs for MIT and Apache-2.0 remain in [`PUBLICATION_LICENSE_DECISION.md`](./PUBLICATION_LICENSE_DECISION.md) for future reference.

## Verification summary

Historical repository verification includes successful typecheck, lint, unit/regression tests, build, current-tree readiness checks, PostgreSQL integration/projection/RLS tests, and pg-boss restart integration tests in GitHub Actions.

Latest merged baseline before this documentation PR:

- `main`: `9332ef3668c02554fc7f2dc67343d0b8a0a257d2`
- GitHub Actions: Run #52
- event: `push` to `main`
- conclusion: success

This documentation PR must also pass its own CI before merge. After merge, the resulting `main` must remain green before the final Gitleaks recertification.

## Publication blockers

Only one technical gate remains:

- Rerun the exact mature full-history Gitleaks scan on the ultimate post-merge `main` publication candidate. Required result: exit code 0, 0 unreviewed findings, 0 confirmed real secrets.

Cleared blockers:

- historical personal-email owner decision — ACCEPTED BY OWNER
- publication license decision — Source-visible / All Rights Reserved
- authenticated GitHub PR/issue discussion review — PASS
- PR-triggered Actions logs/currently visible artifacts review — PASS
- push-to-main Actions inventory and failed-run log review — PASS
- Releases / release assets review — PASS
- current default-branch CI — PASS

## Final status

CONDITIONAL — ONE FINAL TECHNICAL GATE REMAINS.

The repository is not yet authorized for a Private → Public visibility change. Once this final readiness-evidence PR is merged, the resulting `main` CI is green, and the exact full-history Gitleaks recertification returns exit code 0 with 0 unreviewed findings and 0 confirmed real secrets, that exact `main` SHA may be designated **READY FOR PUBLICATION**.

Do not create an additional repository commit after the final scan merely to record the READY label. Preserve the scanned SHA as the publication candidate, change visibility manually, and then perform the documented post-public GitHub security follow-up.
