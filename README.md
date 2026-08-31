# DevMemoir

DevMemoir is an owner-controlled TypeScript/pnpm application that turns selected GitHub repository facts into a private development activity timeline. It is intentionally designed to keep source content and runtime credentials outside the product's normal data boundary.

## What DevMemoir does

The current product supports one allowlisted owner, one bound GitHub App installation, and one actively selected repository. The API receives signed GitHub webhooks as change signals; a durable worker reconciles authoritative GitHub facts into PostgreSQL and serves an owner-facing activity view.

The displayed completeness boundary is deliberately exact:

> **Newest 100 commits currently reachable from the default branch of this connected repository.**

Historical imports and reconciliation preserve observed facts and explicit known-unknown gaps. They do not claim to reconstruct GitHub history that DevMemoir never observed.

## Current status

Active development. Milestone 5 is complete and M6.1 is complete. Milestone 6 / Gate A is not complete.

Core ingestion, reconciliation, recovery, operational health, and encrypted raw-webhook retention are implemented. Gate A privacy, lifecycle, backup/restore, and recovery work is still in progress. DevMemoir is not presented as production-ready, fully secure, or privacy-compliance complete.

## Architecture

The monorepo contains a Next.js web app, a Fastify API, a separately runnable worker, PostgreSQL/Drizzle persistence, a PostgreSQL-backed job queue, a GitHub client, and shared domain/configuration packages. Queue messages carry opaque identifiers and bounded work hints rather than repository names or source content.

Detailed contracts and architectural decisions live under [`docs/architecture/`](./docs/architecture/), including the [M6.1 payload-retention contract](./docs/architecture/M6_PAYLOAD_RETENTION_CONTRACT.md).

## Privacy model

DevMemoir intentionally does not ingest or store source files, blobs, patches/diffs, raw author emails, pull-request or issue bodies, comments/reviews, release assets, or workflow artifacts as product data. Metadata-only facts may include stable IDs, titles, states, timestamps, actor IDs, and source links needed for the supported view.

The only temporary content-sensitive exception is encrypted raw webhook payload retention for short-lived delivery recovery and diagnosis. Ordinary payloads have a maximum retention of 7 days; dead-letter payloads have a hard cap of 30 days. The worker-only purge removes ciphertext without deleting normalized facts, and there is no API or UI to read or restore raw payloads. See [M6_PAYLOAD_RETENTION_CONTRACT.md](./docs/architecture/M6_PAYLOAD_RETENTION_CONTRACT.md).

## Security model

The design uses GitHub App least privilege, signed webhook verification, separate database runtime roles, row-level security, an owner allowlist, opaque queue payloads, durable rate-limit/reconciliation state, worker-only privacy purge, and secret-manager runtime configuration. These controls reduce exposure and support recovery; they do not eliminate every possible vulnerability or deployment mistake.

## Local development

Use a local PostgreSQL instance or the included Docker Compose service. Production credentials and GitHub App material must remain outside the repository.

```powershell
Copy-Item .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

The example environment contains only localhost values, empty values, or obvious placeholders. Never commit `.env` or real key material.

## GitHub App permissions

The local-development App should request only Metadata read, Contents read, Pull requests read, and Issues read. No write permission is needed for the supported slice. Contributors can create their own GitHub App for local development; the production App, its identifiers, private key, webhook secrets, OAuth secrets, and installation credentials remain owner-controlled runtime configuration.

## Data retained / not retained

Retained data is limited to normalized repository and activity metadata, stable external IDs, lifecycle state, timestamps, reconciliation checkpoints, operational state, and the short-lived encrypted raw webhook exception described above. Source code, blobs, patches/diffs, raw author emails, PR/issue bodies, comments/reviews, and workflow artifacts are not retained as product data.

## Operations and recovery

PostgreSQL is the system of record for normalized facts, cursors, delivery state, reconciliation generations, and operational health. The queue is rebuildable from durable state. Release operators must separately verify role provisioning, backup/PITR capability, isolated restore, secret rotation, and lifecycle evidence before Gate A. Those operator gates are not completed by this repository-publication slice.

## Project status / roadmap

Milestones 1–5 and M6.1 are represented in the current implementation. Gate A remains open. Account deletion, disconnect lifecycle, session revocation, secret rotation, isolated restore evidence, and later multi-user or AI features are outside this slice and are not implied by the current status.

## Contributing

This is currently an owner-led project; issues and pull requests may not be accepted. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the small contribution contract.

## Security

Please read [`SECURITY.md`](./SECURITY.md). Do not report vulnerabilities or include private repository data and secrets in public issues.

## License

No open-source license has been selected yet. Public visibility and copyright permission are separate decisions; see [`docs/PUBLICATION_LICENSE_DECISION.md`](./docs/PUBLICATION_LICENSE_DECISION.md).
