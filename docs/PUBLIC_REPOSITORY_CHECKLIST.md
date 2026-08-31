# Public Repository Checklist

This is an operator checklist for the irreversible private-to-public transition. Do not treat repository visibility as part of a code merge, and do not assume every GitHub control is available on every plan.

## Before public

- [ ] Full-history secret scan is clean with an approved mature scanner.
- [ ] No real private GitHub content exists in current files or any reachable history.
- [ ] The historical personal-email decision is made and recorded.
- [ ] Existing Actions logs and artifacts have been reviewed; stale sensitive artifacts are deleted if necessary.
- [ ] README is updated for a public audience.
- [ ] `SECURITY.md` is present and does not publish an unapproved personal email address.
- [ ] The license decision is made/recorded, or the repository is intentionally source-visible/all-rights-reserved without an OSS license.
- [ ] `.env.example` contains placeholders, empty values, or localhost-only development values.
- [ ] The default-branch CI is green, including the current-tree public-readiness check.
- [ ] Existing pull-request bodies/comments and issue history have been checked for secrets or private repository content.
- [ ] Production deployment identifiers are classified; no credential-bearing URL or private admin endpoint remains.

## GitHub security settings after public

Enable if available:

- [ ] Secret scanning.
- [ ] Push protection.
- [ ] Dependabot alerts.
- [ ] Dependabot security updates.
- [ ] CodeQL or default code scanning setup.
- [ ] Private vulnerability reporting.
- [ ] Branch protection or rulesets for `main`.
- [ ] Required CI checks before merge.

Review workflow permissions after enabling any integration. Keep `contents: read` unless a specific current requirement justifies another permission; do not grant broad write or OIDC permissions by default.

## Fork and privacy warning

Once public, the source can be cloned and forked immediately. Making the repository private again does not guarantee that externally cloned or forked copies disappear. Publication is therefore treated as irreversible disclosure, which is why the full history, metadata, Actions, and discussion audit is required.

## GitHub App / production separation

Contributors can create their own GitHub App for local development. The production App, installation credentials, private key, webhook secrets, OAuth secrets, database URLs, and secret-manager configuration remain owner-controlled and must not be committed or shared as part of the public source repository. A public App ID/client ID is not required by this repository unless a product decision says otherwise.

## Immediate operator follow-up

After the owner clears every pre-public item, change visibility manually in GitHub, then re-check the public repository page, default-branch Actions visibility, security settings, forks, and published documentation. This repository-publication slice does not perform that visibility change.
