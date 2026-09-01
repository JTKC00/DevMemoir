# Public Repository Checklist

This is an operator checklist for the irreversible private-to-public transition. Do not treat repository visibility as part of a code merge, and do not assume every GitHub control is available on every plan.

## Before public

- [ ] **Final publication-candidate full-history secret scan** is clean with the approved mature scanner. The previous Gitleaks v8.30.1 baseline is PASS, but the exact ultimate post-merge `main` must be recertified before visibility changes.
- [x] No real private GitHub content exists in current files or reachable history based on the repository publication audit.
- [x] The historical personal-email decision is made and recorded: historical exposure is **ACCEPTED BY OWNER**; no history rewrite is required for this reason.
- [x] Existing authenticated GitHub Actions surfaces were reviewed to publication-gate scope: PR-triggered runs/logs, complete push-to-main run inventory, all failed push-run logs, and currently visible audited artifacts. No sensitive artifact required deletion.
- [x] README is updated for a public audience.
- [x] `SECURITY.md` is present and does not publish an unapproved personal email address.
- [x] The license decision is recorded: the repository is intentionally source-visible / All Rights Reserved without an OSS license.
- [x] `.env.example` contains placeholders, empty values, or localhost-only development values; no tracked real `.env` or private-key file was identified.
- [x] The latest merged default-branch CI baseline is green, including the current-tree public-readiness check. This final documentation PR must also pass CI, and post-merge `main` must remain green before the final Gitleaks recertification.
- [x] Existing pull-request bodies/discussion surfaces and issue history were checked for secrets or private repository content; no standalone Issues were found.
- [x] Production deployment identifiers are classified; no credential-bearing URL or private admin endpoint remains in the publication-audited tree/history.
- [x] Releases and release assets were reviewed: 0 Releases and 0 release assets at the final hosted-surface audit.

### Historical hosted-surface coverage note

The authenticated final audit found 25 `push` → `main` Actions runs: 21 successful, 4 failed, 0 cancelled, and 0 timed out. All four failed-run logs were fully reviewed because failure diagnostics have the highest accidental-disclosure risk. The successful push runs were completely inventoried but were not each re-read byte-for-byte during the final pass; prior PR-triggered runs using the same workflow, failed-run review, current successful CI, workflow-source review, and retained-artifact checks provide the publication-gate evidence recorded in `PUBLIC_REPOSITORY_READINESS.md`.

GitHub-hosted logs or artifacts that have already expired or been deleted cannot be retroactively inspected. Do not interpret an empty current artifact listing as proof that an artifact never existed; it proves only that no currently visible sensitive artifact required action in the audited surfaces.

## Final private-state gate sequence

Before changing visibility:

1. Merge the final readiness-evidence PR after its CI passes.
2. Confirm the resulting `main` default-branch CI is green.
3. Fetch/checkout that exact final `main` without adding another readiness commit.
4. Rerun the approved Gitleaks v8.30.1 full-history command with the same merge-aware coverage and redacted repo-external report path.
5. Require Gitleaks exit code `0`, `0 unreviewed findings`, and `0 confirmed real secrets`.
6. Delete the repo-external raw JSON report after verification.
7. Do not commit a post-scan “READY” evidence edit; that would create a new unscanned commit. Treat the scanned SHA itself as the publication candidate.
8. Change repository visibility manually from Private to Public only after all steps above are satisfied.

## Post-public GitHub security settings (manual operator checklist)

The repository is now Public. These settings are controlled in GitHub's UI/API and are not enabled by this source change. Before this hardening PR, no repository rulesets were observed and `main` branch protection was not enabled.

- [ ] Secret scanning is enabled.
- [ ] Push protection is enabled.
- [ ] Dependabot alerts are enabled.
- [ ] Dependabot security updates are enabled.
- [ ] CodeQL/code scanning is enabled and has a successful run after this workflow is merged.
- [ ] Private vulnerability reporting is enabled if available.
- [ ] A ruleset or branch protection rule is configured for `main`.
- [ ] The required CI status check includes `DevMemoir CI / verify`.
- [ ] Force-pushes to `main` are blocked.
- [ ] Deletion of `main` is blocked.

Dependabot version-update configuration currently covers GitHub Actions and Docker Compose only. The repository uses `pnpm@11.19.0`; GitHub Dependabot does not yet officially support pnpm 11 for package version updates, so the root pnpm workspace is intentionally omitted from `.github/dependabot.yml`. Revisit this when GitHub adds pnpm 11 support. Do not treat the current Dependabot configuration as package-update coverage for the pnpm workspace.

Review workflow permissions after enabling any integration. Keep `contents: read` unless a specific current requirement justifies another permission; do not grant broad write or OIDC permissions by default.

## Fork and privacy warning

Once public, the source can be cloned and forked immediately. Making the repository private again does not guarantee that externally cloned or forked copies disappear. Publication is therefore treated as irreversible disclosure, which is why the full history, metadata, Actions, and discussion audit is required.

## GitHub App / production separation

Contributors can create their own GitHub App for local development. The production App, installation credentials, private key, webhook secrets, OAuth secrets, database URLs, and secret-manager configuration remain owner-controlled and must not be committed or shared as part of the public source repository. A public App ID/client ID is not required by this repository unless a product decision says otherwise.

## Immediate operator follow-up

After the final full-history scan clears the last unchecked pre-public item, change visibility manually in GitHub. Then re-check the public repository page, default-branch Actions visibility, GitHub security settings, rulesets/branch protection, forks, and published documentation.
