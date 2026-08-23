-- Milestone 3: restartable, page-atomic historical source backfill.
-- This migration is deliberately replay-safe because the release migrator
-- executes every checked-in SQL file on each run.

ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS api_paused_until timestamptz;
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS api_pause_reason varchar(120);

ALTER TABLE branches ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS last_authoritative_observed_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS observation_generation timestamptz;

ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS status varchar(30) NOT NULL DEFAULT 'pending';
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS paused_until timestamptz;
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS error_code varchar(120);
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS completeness_state varchar(40) NOT NULL DEFAULT 'known_unknown';

-- PostgreSQL UNIQUE constraints treat NULLs as distinct on supported M2
-- versions. Historical stages use the empty string as the explicit no-ref
-- sentinel so every stage has exactly one durable identity.
UPDATE sync_cursors SET ref_name='' WHERE ref_name IS NULL;
ALTER TABLE sync_cursors ALTER COLUMN ref_name SET DEFAULT '';
ALTER TABLE sync_cursors ALTER COLUMN ref_name SET NOT NULL;
ALTER TABLE sync_cursors DROP CONSTRAINT IF EXISTS sync_cursors_tenant_id_repository_id_resource_type_ref_name_key;
DROP INDEX IF EXISTS sync_cursors_resource_unique;
CREATE UNIQUE INDEX IF NOT EXISTS sync_cursors_resource_unique
  ON sync_cursors (tenant_id, repository_id, resource_type, ref_name);

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  name varchar(255) NOT NULL,
  target_sha varchar(64) NOT NULL,
  target_type varchar(30),
  reachable boolean NOT NULL DEFAULT true,
  completeness_state varchar(40) NOT NULL DEFAULT 'reachable_at_sync',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_authoritative_observed_at timestamptz NOT NULL,
  observation_generation timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE (tenant_id, repository_id, name)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_pull_request_id bigint NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state varchar(30) NOT NULL,
  draft boolean NOT NULL DEFAULT false,
  author_github_account_id uuid REFERENCES github_accounts(id),
  author_actor_kind varchar(20) NOT NULL DEFAULT 'unknown',
  merger_github_account_id uuid REFERENCES github_accounts(id),
  base_ref varchar(500),
  base_sha varchar(64),
  head_ref varchar(500),
  head_sha varchar(64),
  source_url text,
  github_created_at timestamptz NOT NULL,
  github_updated_at timestamptz NOT NULL,
  github_closed_at timestamptz,
  github_merged_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  completeness_state varchar(40) NOT NULL DEFAULT 'observed',
  UNIQUE (tenant_id, repository_id, github_pull_request_id),
  UNIQUE (tenant_id, repository_id, number)
);

CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_issue_id bigint NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  state varchar(30) NOT NULL,
  state_reason varchar(40),
  author_github_account_id uuid REFERENCES github_accounts(id),
  author_actor_kind varchar(20) NOT NULL DEFAULT 'unknown',
  source_url text,
  github_created_at timestamptz NOT NULL,
  github_updated_at timestamptz NOT NULL,
  github_closed_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  completeness_state varchar(40) NOT NULL DEFAULT 'observed',
  UNIQUE (tenant_id, repository_id, github_issue_id),
  UNIQUE (tenant_id, repository_id, number)
);

CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_release_id bigint NOT NULL,
  tag_name varchar(255) NOT NULL,
  name text,
  draft boolean NOT NULL DEFAULT false,
  prerelease boolean NOT NULL DEFAULT false,
  author_github_account_id uuid REFERENCES github_accounts(id),
  author_actor_kind varchar(20) NOT NULL DEFAULT 'unknown',
  source_url text,
  github_created_at timestamptz NOT NULL,
  github_updated_at timestamptz NOT NULL,
  github_published_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  completeness_state varchar(40) NOT NULL DEFAULT 'observed',
  UNIQUE (tenant_id, repository_id, github_release_id)
);

CREATE INDEX IF NOT EXISTS pull_requests_repo_updated_idx ON pull_requests (tenant_id, repository_id, github_updated_at);
CREATE INDEX IF NOT EXISTS issues_repo_updated_idx ON issues (tenant_id, repository_id, github_updated_at);
CREATE INDEX IF NOT EXISTS releases_repo_updated_idx ON releases (tenant_id, repository_id, github_updated_at);
CREATE INDEX IF NOT EXISTS tags_repo_reachable_idx ON tags (tenant_id, repository_id, reachable);

-- Repair tenant-qualified ownership on every M3-touched legacy relation.
CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_id_unique ON branches (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS commits_tenant_id_unique ON commits (tenant_id, id);
DO $$ BEGIN
  ALTER TABLE branches ADD CONSTRAINT branches_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE commits ADD CONSTRAINT commits_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE commit_refs ADD CONSTRAINT commit_refs_tenant_commit_fk
    FOREIGN KEY (tenant_id, commit_id) REFERENCES commits (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE commit_refs ADD CONSTRAINT commit_refs_tenant_branch_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sync_cursors ADD CONSTRAINT sync_cursors_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tags ADD CONSTRAINT tags_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE pull_requests ADD CONSTRAINT pull_requests_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE issues ADD CONSTRAINT issues_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE releases ADD CONSTRAINT releases_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sync_cursors ADD CONSTRAINT sync_cursors_status_check
    CHECK (status IN ('pending','in_progress','paused','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sync_cursors ADD CONSTRAINT sync_cursors_stage_check
    CHECK (resource_type IN ('commit_ref','default_branch_commits','branches','tags','pull_requests','issues','releases','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sync_cursors ADD CONSTRAINT sync_cursors_completeness_check
    CHECK (completeness_state IN ('observed','reachable_at_sync','known_unknown','out_of_scope'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
ALTER TABLE pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pull_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues FORCE ROW LEVEL SECURITY;
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tags','pull_requests','issues','releases'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;

GRANT SELECT ON tags, pull_requests, issues, releases TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON tags, pull_requests, issues, releases TO devmemoir_worker;
GRANT SELECT ON sync_cursors TO devmemoir_api;
GRANT DELETE ON sync_cursors TO devmemoir_worker;

-- Source normalization is worker-owned. Earlier milestones granted the API
-- broad shared-table writes; narrow those grants now that M3 reads progress
-- through the API but commits source pages only in the worker.
REVOKE INSERT, UPDATE, DELETE ON branches, commits, development_events, commit_refs, sync_cursors, tags, pull_requests, issues, releases FROM devmemoir_api;
