# Public Repository Readiness

Audit date: 2026-08-31
Audited commit SHA: `7d6efc5ceb3000c4bbb417b2494bb209c13df678` (`main`, PR #11 merge commit)
Source-scan target SHA: `e2f11d6fa0b45eed513fe34dc1869a8bc514a60c`
Source tree relation: the source-scan target has tree SHA `31e3125a9e7256e9de66b782db764940272e7b04`, matching the pre-merge `main` parent `97c50d5dd7b9a7131268518c416ad1045dec19f1`; the merged `main` tree is now `1dbc3dca6f5b1acdfac04dc5a9a11efda1a3431b`. The source scan is retained as historical supplemental evidence and is not treated as a complete scan of the merged PR #11 tree.

This follow-up correction was created from the post-merge PR #11 `main` baseline. Repository visibility was not changed and no merge was performed by this correction.

Gitleaks publication-gate follow-up: 2026-08-31, from `main` `dfab175ddf86fd2dbdfeb5d57286d930dfb35595` (PR #12 merge). The Full Git history section below records the later Gitleaks v8.30.1 scan and supersedes the earlier BLOCKED scanner status. Repository visibility was not changed by this follow-up.

## Current tree

PASS — the evidence contains three distinct tree snapshots:

- Historical PR #11 GitHub Actions CI: `156 public-tree files scanned` from the committed tree. `git ls-files` and `git ls-tree -r` reported 156 files for merged `main` at that time.
- Historical local snapshot around PR #11 / #12: the local checker reported 157 files because its filesystem walk included the ignored generated path `apps/web/tsconfig.tsbuildinfo` (confirmed by `git check-ignore` and `git clean -ndX`). This was not a committed-tree count.
- Current PR #13 GitHub Actions Run #48: `157 public-tree files scanned` from the committed/public tree after PR #13 added the tracked file `.gitleaksignore`. This committed 157 is separate evidence from the earlier local 157, which had a different cause.

`.env` and `.env.*` are ignored with `.env.example` explicitly allowed; no `.env` or private-key file is tracked. The reproducible current-tree check remains `pnpm audit:public`.

## Full Git history secret scan

PASS — Gitleaks v8.30.1 full-history publication scan completed 2026-08-31. This is not a “never had a finding” result: one `generic-api-key` candidate was reported, human-adjudicated as a synthetic test fixture, and then ignored by exact fingerprint. The gate is clean after that disposition.

Scanner: official Gitleaks v8.30.1 `darwin_arm64` release binary (checksum-verified from GitHub Releases). Command coverage matched the prior merge-aware audit and was not reduced:

```text
gitleaks git . --log-opts="--all --reflog --full-history -m" --redact --report-format=json --report-path=<repo-external temp path>
```

Scan inventory:

- all refs, reflog, full history, merge-aware (`-m`)
- 17 merge commits throughout
- pre-disposition scan on `main` `dfab175`: Gitleaks reported `55 commits scanned`; `git rev-list --all` was 55
- the earlier audit counted 22 refs; this clone also has local Codex checkpoint refs and the working branch, so `git for-each-ref` is higher
- final rerun after the exact-fingerprint ignore commit: Gitleaks reported `56 commits scanned`; `git rev-list --all` was 56

Original result before disposition:

- Gitleaks exit code `1`
- 1 unreviewed finding
- Rule: `generic-api-key`
- File: `apps/api/src/webhook.test.ts`
- Commit: `07351c1a4029b6f18d6d934edbc6da89888185d5` (`feat: implement DevMemoir milestone 1`)
- Exact Fingerprint: `07351c1a4029b6f18d6d934edbc6da89888185d5:apps/api/src/webhook.test.ts:generic-api-key:9`

Human adjudication of that finding:

- GitHub webhook HMAC synthetic test fixture used only by unit tests
- Not a production credential
- No rotation or revocation required
- 0 confirmed real secrets

Disposition:

- `.gitleaksignore` contains only that exact fingerprint
- No path-wide ignore, no whole-file ignore, no `generic-api-key` rule disable, and no extra regex allowlist
- Production webhook verification logic was not changed
- Raw JSON reports were written outside the repository and deleted after verification; matched secret text is not recorded here

Final result after fingerprint disposition and rerun of the same coverage:

- Gitleaks exit code `0`
- 0 unreviewed findings
- 0 confirmed real secrets

Historical original-audit note (before a mature scanner was available on this machine): `gitleaks` and equivalent local executables were initially unavailable, so the first publication document recorded BLOCKED. Supplemental sanitized checks (`git rev-list --all --objects` over 51 commits / 948 reachable objects at that time, plus `git fsck --full --no-reflogs --unreachable`) found no private-key markers, no GitHub token-shaped values except test canaries / regex examples, only localhost/`unused`/placeholder database URLs, no token-shaped bearer values, and no cloud credential patterns. Those checks remain historical supplemental evidence. The Codex Security standard source scan for the earlier committed snapshot also reported zero reportable findings; its artifacts stay in the security workbench and do not replace this Gitleaks result.

## Private data scan

PASS — no real imported private repository names, private commit messages, PR/issue bodies, raw webhook exports, database dumps, or private dashboard screenshots were found in the current tree or reachable history. Test data uses synthetic owners/repositories, `.example` domains, and explicit privacy canaries.

## Commit metadata privacy

`personal_email_history: yes`
`noreply_email_detected: yes`
`decision: pending`

The history contains one non-noreply personal address in addition to a GitHub noreply address. This is a privacy decision, not automatically a security incident. The owner must choose between accepting historical exposure or rewriting history before publication. No history rewrite was performed. Future local commits should use a GitHub noreply address, configured locally with `git config user.email "<github-noreply-address>"`; the repository does not hard-code a developer's address.

## GitHub Actions

`workflow_source: PASS` — the workflow has explicit `permissions: contents: read`, uses only local PostgreSQL test credentials, does not echo secret values, and contains no shell tracing or environment-dump command around secret-bearing operations.

`current_ci: PASS` — the PR #11 GitHub Actions run used its PostgreSQL service container and completed the repository verification successfully, including `pnpm audit:public` (156 public-tree files scanned), PostgreSQL integration tests, projection/RLS tests, pg-boss restart integration tests, typecheck, lint, unit/regression tests, and build. This current CI result is stronger readiness evidence than the historical local integration skip recorded below.

`historical_logs: BLOCKED`
`historical_artifacts: BLOCKED`

The local GitHub CLI is installed but unauthenticated, so historical run logs, artifacts, and PR/issue discussion history could not be inspected through the GitHub API. The operator must review those items privately and delete any sensitive historical artifact before publication; do not copy secrets into this document.

## Production identifiers

PASS — provider names and links in architecture documents are generic documentation references. No project-specific deployment hostname, private admin endpoint, credential-bearing production URL, Neon host, Railway app host, callback domain, or cloud credential was found in the current tree or reachable history.

## Documentation

PASS — `README.md` now uses public-audience structure and accurate M5/M6.1/Gate A wording. `SECURITY.md`, `CONTRIBUTING.md`, the publication checklist, and this evidence document are present. Detailed milestone contracts remain under `docs/architecture/`.

## License

PENDING OWNER DECISION — no `LICENSE` file was added. Options are recorded in [`PUBLICATION_LICENSE_DECISION.md`](./PUBLICATION_LICENSE_DECISION.md), including source-visible/all-rights-reserved, MIT, and Apache-2.0 tradeoffs.

## Verification

Historical local verification record:

- `pnpm audit:public`: PASS, including deterministic self-tests and a 157-file local filesystem snapshot; see the Current tree note above for why this is distinct from the 156-file CI snapshot.
- `pnpm typecheck`: PASS, including workspace build and all package typechecks.
- `pnpm lint`: PASS.
- `pnpm test`: PASS; unit/regression suites passed. PostgreSQL, RLS, and pg-boss integration suites were conditionally skipped because Docker/Podman and local PostgreSQL were unavailable.
- `pnpm build`: PASS as exercised by `pnpm typecheck` and `pnpm test`.
- `git diff --check`: PASS; only expected line-ending normalization warnings were emitted.

Formal merged-PR CI verification:

- PR #11 GitHub Actions used a PostgreSQL service container and passed the PostgreSQL integration tests, projection/RLS tests, and pg-boss restart integration tests.
- The same CI passed typecheck, lint, unit/regression tests, build, and `pnpm audit:public` with `156 public-tree files scanned`.
- The successful CI result is the stronger readiness evidence for these checks; the local integration skip is historical context, not the final verification state.

## Publication blockers

- Complete the owner decision for historical personal-email exposure.
- Complete the owner decision for source-visible/all-rights-reserved versus an open-source license.
- Review historical GitHub Actions logs/artifacts and PR/issue discussion through an authenticated operator account; delete stale sensitive artifacts if any are found.

## Final status

CONDITIONAL

It is not safe to change the repository to Public yet. The mature full-history Gitleaks scan is PASS after one human-adjudicated synthetic test-fixture false positive. Historical GitHub review and owner privacy/license decisions remain outstanding. Repository visibility must not be changed until those remaining blockers are cleared.
