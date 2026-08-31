# Public Repository Readiness

Audit date: 2026-08-31
Audited commit SHA: `97c50d5dd7b9a7131268518c416ad1045dec19f1` (`main`)
Source-scan target SHA: `e2f11d6fa0b45eed513fe34dc1869a8bc514a60c`
Source tree relation: `main` and the source-scan target have the same tree SHA (`31e3125a9e7256e9de66b782db764940272e7b04`).

The local checkout could not update `.git/index` to switch branches because of the managed workspace permission boundary. The source tree was verified identical to the merged `main` tree before this working-tree audit. Repository visibility was not changed and no merge was performed.

## Current tree

PASS — 157 public-tree files (tracked files plus non-ignored working-tree files) were checked along with configuration examples, workflow source, and privacy patterns. `.env` and `.env.*` are ignored with `.env.example` explicitly allowed; no `.env` or private-key file is tracked. The reproducible check is `pnpm audit:public`.

## Full Git history secret scan

BLOCKED — scanner/version: no approved mature scanner was available. `gitleaks`, TruffleHog, detect-secrets, git-secrets, and equivalent local executables were unavailable. No scanner was installed and no network download was attempted.

Supplemental sanitized audit: `git rev-list --all --objects` covered 51 commits and 948 reachable objects, with textual pattern checks over every commit tree. A local `git fsck --full --no-reflogs --unreachable` check also found one 20-byte unreachable blob; it contained none of the audited secret/privacy patterns. The supplemental checks found:

- private-key markers: none;
- GitHub token-shaped values: none; matches were test canary prefixes or regular-expression examples;
- database URLs: localhost, `unused`, placeholders, or documentation/test examples only;
- bearer/authorization values: no token-shaped value;
- cloud credential patterns: none.

No real secret was found by the available checks. The release/publication operator must still run and retain the output of an approved mature full-history scanner before changing visibility.

The completed Codex Security standard source scan for the committed baseline reported zero reportable findings. Its canonical artifacts and generated report are retained by the security workbench; this result covers the original committed snapshot, while the publication documents and current-tree checker were audited separately in the working tree.

## Private data scan

PASS — no real imported private repository names, private commit messages, PR/issue bodies, raw webhook exports, database dumps, or private dashboard screenshots were found in the current tree or reachable history. Test data uses synthetic owners/repositories, `.example` domains, and explicit privacy canaries.

## Commit metadata privacy

`personal_email_history: yes`
`noreply_email_detected: yes`
`decision: pending`

The history contains one non-noreply personal address in addition to a GitHub noreply address. This is a privacy decision, not automatically a security incident. The owner must choose between accepting historical exposure or rewriting history before publication. No history rewrite was performed. Future local commits should use a GitHub noreply address, configured locally with `git config user.email "<github-noreply-address>"`; the repository does not hard-code a developer's address.

## GitHub Actions

`workflow_source: PASS` — the workflow has explicit `permissions: contents: read`, uses only local PostgreSQL test credentials, does not echo secret values, and contains no shell tracing or environment-dump command around secret-bearing operations.

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

- `pnpm audit:public`: PASS, including deterministic self-tests and current-tree scan.
- `pnpm typecheck`: PASS, including workspace build and all package typechecks.
- `pnpm lint`: PASS.
- `pnpm test`: PASS; unit/regression suites passed. PostgreSQL, RLS, and pg-boss integration suites were conditionally skipped because Docker/Podman and local PostgreSQL were unavailable.
- `pnpm build`: PASS as exercised by `pnpm typecheck` and `pnpm test`.
- `git diff --check`: PASS; only expected line-ending normalization warnings were emitted.

## Publication blockers

- Run an approved mature full-history secret scanner and retain a clean result.
- Complete the owner decision for historical personal-email exposure.
- Complete the owner decision for source-visible/all-rights-reserved versus an open-source license.
- Review historical GitHub Actions logs/artifacts and PR/issue discussion through an authenticated operator account; delete stale sensitive artifacts if any are found.

## Final status

CONDITIONAL

It is not safe to change the repository to Public yet. The available source/history checks found no known secret or private-data leak, but the mature full-history scan, historical GitHub review, and owner privacy/license decisions remain outstanding.
