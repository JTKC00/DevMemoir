CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug varchar(120) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  deletion_requested_at timestamptz
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  primary_tenant_id uuid NOT NULL REFERENCES tenants(id),
  display_name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role varchar(40) NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS github_accounts (
  id uuid PRIMARY KEY,
  github_account_id bigint NOT NULL UNIQUE,
  account_type varchar(40) NOT NULL DEFAULT 'User',
  actor_kind varchar(20) NOT NULL DEFAULT 'unknown',
  login varchar(255), node_id varchar(255), avatar_url text,
  profile_updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS github_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  github_account_id uuid NOT NULL UNIQUE REFERENCES github_accounts(id),
  linked_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_transactions (
  id uuid PRIMARY KEY,
  state_hash varchar(128) NOT NULL UNIQUE,
  code_verifier_ciphertext text NOT NULL,
  handoff_hash varchar(128) UNIQUE,
  return_path varchar(500) NOT NULL,
  github_account_id bigint,
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  handoff_consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS application_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash varchar(128) NOT NULL UNIQUE,
  csrf_token_hash varchar(128) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz
);
CREATE TABLE IF NOT EXISTS github_installations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  github_installation_id bigint NOT NULL UNIQUE,
  account_github_account_id uuid NOT NULL REFERENCES github_accounts(id),
  status varchar(30) NOT NULL DEFAULT 'active',
  permissions jsonb NOT NULL DEFAULT '{}',
  repository_selection varchar(30),
  suspended_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- Webhook routing contains only the installation-to-tenant lookup needed
-- before a request can establish a tenant-local RLS context.
CREATE TABLE IF NOT EXISTS installation_routes (
  github_installation_id bigint PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  github_repository_id bigint NOT NULL,
  node_id varchar(255), owner_login varchar(255) NOT NULL, name varchar(255) NOT NULL,
  full_name varchar(511) NOT NULL, private boolean NOT NULL DEFAULT false,
  visibility varchar(30), default_branch varchar(255) NOT NULL, description text,
  topics jsonb NOT NULL DEFAULT '[]', languages jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz, github_created_at timestamptz, github_updated_at timestamptz,
  github_pushed_at timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL, UNIQUE (tenant_id, github_repository_id)
);
CREATE TABLE IF NOT EXISTS repository_access (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  installation_id uuid NOT NULL REFERENCES github_installations(id), access_status varchar(30) NOT NULL DEFAULT 'selected',
  selected_at timestamptz NOT NULL, revoked_at timestamptz,
  UNIQUE (tenant_id, repository_id, installation_id)
);
CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  name varchar(255) NOT NULL, head_sha varchar(64), protected boolean NOT NULL DEFAULT false,
  reachable boolean NOT NULL DEFAULT true, last_seen_at timestamptz, deleted_at timestamptz,
  UNIQUE (tenant_id, repository_id, name)
);
CREATE TABLE IF NOT EXISTS commits (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  sha varchar(64) NOT NULL, author_github_account_id uuid REFERENCES github_accounts(id), committer_github_account_id uuid REFERENCES github_accounts(id),
  message text NOT NULL, authored_at timestamptz, committed_at timestamptz, parent_shas jsonb NOT NULL DEFAULT '[]',
  verified boolean, additions integer, deletions integer, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
  UNIQUE (tenant_id, repository_id, sha)
);
CREATE TABLE IF NOT EXISTS development_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  source_system varchar(40) NOT NULL DEFAULT 'github', source_kind varchar(40) NOT NULL, source_external_id varchar(255) NOT NULL,
  event_type varchar(60) NOT NULL, verb varchar(60) NOT NULL, actor_github_account_id uuid REFERENCES github_accounts(id),
  actor_kind varchar(20) NOT NULL DEFAULT 'unknown', contribution_role varchar(40) NOT NULL, context_kind varchar(20) NOT NULL DEFAULT 'unknown',
  occurred_at timestamptz NOT NULL, source_updated_at timestamptz, title text, summary_input text, source_url text,
  completeness_state varchar(40) NOT NULL DEFAULT 'observed', visibility varchar(20) NOT NULL DEFAULT 'unknown',
  UNIQUE (tenant_id, repository_id, source_system, source_kind, source_external_id, verb)
);
ALTER TABLE development_events ADD COLUMN IF NOT EXISTS source_url text;

CREATE TABLE IF NOT EXISTS commit_refs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  commit_id uuid NOT NULL REFERENCES commits(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  last_seen_at timestamptz NOT NULL,
  reachable boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, commit_id, branch_id)
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants(id), github_delivery_guid varchar(128) NOT NULL UNIQUE,
  event_name varchar(80) NOT NULL, action varchar(80), installation_github_id bigint, repository_github_id bigint,
  ref varchar(500), before_sha varchar(64), after_sha varchar(64), forced boolean, headers jsonb NOT NULL DEFAULT '{}',
  payload_ciphertext text, payload_key_version varchar(40), first_received_at timestamptz NOT NULL, last_received_at timestamptz NOT NULL,
  receipt_count integer NOT NULL DEFAULT 1, state varchar(30) NOT NULL DEFAULT 'received', processing_attempts integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz, job_id varchar(255), sanitized_error_code varchar(120), processed_at timestamptz,
  payload_expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS unrouted_webhook_deliveries (
  id uuid PRIMARY KEY,
  github_delivery_guid varchar(128) NOT NULL UNIQUE,
  event_name varchar(80) NOT NULL,
  payload_ciphertext text NOT NULL,
  received_at timestamptz NOT NULL,
  payload_expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid REFERENCES repositories(id),
  delivery_id uuid REFERENCES webhook_deliveries(id), kind varchar(50) NOT NULL, stage varchar(50), state varchar(30) NOT NULL DEFAULT 'queued',
  logical_key varchar(255) NOT NULL UNIQUE, payload jsonb NOT NULL DEFAULT '{}', attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8, scheduled_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz,
  heartbeat_at timestamptz, error_code varchar(120)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  resource_type varchar(50) NOT NULL, ref_name varchar(500), head_sha varchar(64), cursor jsonb NOT NULL DEFAULT '{}',
  high_water_at timestamptz, last_success_at timestamptz, last_full_reconcile_at timestamptz, schema_version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, repository_id, resource_type, ref_name)
);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants(id), aggregate_type varchar(60) NOT NULL, aggregate_id uuid,
  event_type varchar(80) NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL, published_at timestamptz
);

CREATE INDEX IF NOT EXISTS commits_tenant_repo_date_idx ON commits (tenant_id, repository_id, committed_at);
CREATE INDEX IF NOT EXISTS development_events_tenant_date_idx ON development_events (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS commit_refs_branch_reachable_idx ON commit_refs (tenant_id, branch_id, reachable);
CREATE UNIQUE INDEX IF NOT EXISTS repository_access_one_selected_per_tenant_idx ON repository_access (tenant_id) WHERE access_status = 'selected';
CREATE INDEX IF NOT EXISTS webhook_deliveries_state_idx ON webhook_deliveries (state, last_received_at);
CREATE INDEX IF NOT EXISTS sync_jobs_tenant_state_idx ON sync_jobs (tenant_id, state);

-- Application roles are capability roles only. They intentionally remain
-- NOLOGIN; deployments provision separate LOGIN principals and grant one of
-- these capabilities to each principal.
DO $$ BEGIN
  CREATE ROLE devmemoir_web NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE devmemoir_api NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
CREATE ROLE devmemoir_worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE devmemoir_migrations NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
CREATE ROLE devmemoir_queue NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$
DECLARE
  capability text;
  can_login boolean;
  is_super boolean;
  bypass_rls boolean;
BEGIN
  FOREACH capability IN ARRAY ARRAY['devmemoir_web','devmemoir_api','devmemoir_worker','devmemoir_migrations','devmemoir_queue'] LOOP
    SELECT rolcanlogin, rolsuper, rolbypassrls INTO can_login, is_super, bypass_rls FROM pg_roles WHERE rolname = capability;
    IF NOT FOUND OR can_login OR is_super OR bypass_rls THEN
      RAISE EXCEPTION 'Capability role % must remain NOLOGIN, non-superuser, and without BYPASSRLS', capability;
    END IF;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION devmemoir_queue;
GRANT USAGE, CREATE ON SCHEMA pgboss TO devmemoir_queue;
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE repository_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_access FORCE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE commits FORCE ROW LEVEL SECURITY;
ALTER TABLE development_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_events FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE commit_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commit_refs FORCE ROW LEVEL SECURITY;

-- The application sets app.tenant_id transaction-locally. Owners/migrations bypass through a separate role.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['github_installations','repositories','repository_access','branches','commits','development_events','commit_refs','webhook_deliveries','sync_jobs','sync_cursors','outbox'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO devmemoir_web, devmemoir_api, devmemoir_worker;
GRANT SELECT ON repositories, repository_access, branches, commits, development_events, commit_refs TO devmemoir_web;
GRANT SELECT, INSERT, UPDATE ON repositories, repository_access, branches, commits, development_events, commit_refs, webhook_deliveries, sync_jobs, sync_cursors, outbox TO devmemoir_api, devmemoir_worker;
GRANT SELECT, INSERT, UPDATE ON tenants, users, tenant_members, github_accounts, github_identities, auth_transactions, application_sessions, github_installations, installation_routes TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE ON github_accounts, github_installations, installation_routes TO devmemoir_worker;
GRANT INSERT, SELECT ON unrouted_webhook_deliveries TO devmemoir_api;
