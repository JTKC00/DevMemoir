# PostgreSQL local development

DevMemoir's supported local-development and GitHub Actions baseline is **PostgreSQL 18** (`postgres:18-alpine`).

Do not start a PostgreSQL 18 container against an existing PostgreSQL 16 data directory. PostgreSQL major versions cannot read each other's on-disk clusters.

## Volume layout

The official PostgreSQL 18 Docker image changed storage paths ([docker-library/postgres#1259](https://github.com/docker-library/postgres/pull/1259), [image `PGDATA` notes](https://github.com/docker-library/docs/blob/master/postgres/content.md)):

| | PostgreSQL 16 image | PostgreSQL 18 image |
|---|---|---|
| Default `PGDATA` | `/var/lib/postgresql/data` | `/var/lib/postgresql/18/docker` |
| Declared `VOLUME` | `/var/lib/postgresql/data` | `/var/lib/postgresql` |
| DevMemoir host path | `./docker-data/postgres` | `./docker-data/postgres-18` |

Compose mounts `./docker-data/postgres-18` at `/var/lib/postgresql`. The server then writes `18/docker` inside that directory. The old `./docker-data/postgres` path is left untouched so a PostgreSQL 16 cluster is never interpreted as PostgreSQL 18 storage.

`docker-data/` remains gitignored. Do not commit local database files.

## Fresh PostgreSQL 18 database

This is the supported local path. Local Compose data is disposable development state.

```powershell
Copy-Item .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

Health: `docker compose ps` should show the postgres service healthy on port `5432`. Database/user/name remain `devmemoir` / `devmemoir` / `devmemoir`.

## Existing PostgreSQL 16 data

If `./docker-data/postgres` already exists, it is a PostgreSQL 16 cluster. **Do not** point the PostgreSQL 18 image at that directory and **do not** copy those files into `./docker-data/postgres-18`.

Supported reset (local data is disposable):

1. Stop the Compose service: `docker compose down`
2. Optional backup of the old cluster (copy, do not delete):

   ```powershell
   Copy-Item -Recurse .\docker-data\postgres .\docker-data\postgres-16-backup
   ```

3. Leave `./docker-data/postgres` in place. Do not delete it as part of this upgrade.
4. Start PostgreSQL 18, which initializes `./docker-data/postgres-18`:

   ```powershell
   docker compose up -d postgres
   pnpm db:migrate
   ```

5. Confirm health (`docker compose ps`) and that the app/tests can connect.

Optional data keep: while the PostgreSQL 16 container is still running, take a logical dump (`pg_dump`) and restore it into the new PostgreSQL 18 database with `pg_restore` / `psql`. File-copy and `pg_upgrade` against the old bind mount are not a supported local-development procedure.

## Rollback to PostgreSQL 16

Rollback uses the preserved PostgreSQL 16 directory. PostgreSQL 16 cannot read files written by PostgreSQL 18.

1. Stop containers: `docker compose down`
2. Restore the previous Compose definition from git (`postgres:16-alpine` mounting `./docker-data/postgres` at `/var/lib/postgresql/data`), or check out the last commit before this baseline change.
3. Start postgres and confirm health.
4. Leave `./docker-data/postgres-18` in place unless you intentionally discard the PostgreSQL 18 cluster.

Do not mount `./docker-data/postgres-18` into a PostgreSQL 16 image.
