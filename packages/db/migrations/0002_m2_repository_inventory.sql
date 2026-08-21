-- M2 repository inventory upgrade for databases that already applied 0001.
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS last_inventory_at timestamptz;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_authoritative_observed_at timestamptz;
ALTER TABLE repository_access ALTER COLUMN selected_at DROP NOT NULL;
ALTER TABLE repository_access ALTER COLUMN access_status SET DEFAULT 'accessible';
ALTER TABLE repository_access ADD COLUMN IF NOT EXISTS selected boolean NOT NULL DEFAULT false;
ALTER TABLE repository_access ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE repository_access ADD COLUMN IF NOT EXISTS last_authoritative_observed_at timestamptz;

CREATE TABLE IF NOT EXISTS repository_name_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  owner_login varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  full_name varchar(511) NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz
);
CREATE INDEX IF NOT EXISTS repository_name_history_lookup_idx ON repository_name_history (tenant_id, repository_id, valid_from);
CREATE UNIQUE INDEX IF NOT EXISTS github_installations_tenant_id_unique ON github_installations (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS repositories_tenant_id_unique ON repositories (tenant_id, id);
DO $$ BEGIN
  ALTER TABLE repository_access ADD CONSTRAINT repository_access_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE repository_access ADD CONSTRAINT repository_access_tenant_installation_fk FOREIGN KEY (tenant_id, installation_id) REFERENCES github_installations (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE repository_name_history ADD CONSTRAINT repository_name_history_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE repository_name_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_name_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON repository_name_history;
CREATE POLICY tenant_isolation ON repository_name_history
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON repository_name_history TO devmemoir_api, devmemoir_worker;

UPDATE repository_access SET selected=true, access_status='accessible' WHERE access_status='selected';
UPDATE repository_access SET access_status='accessible' WHERE access_status='unselected' OR access_status IS NULL OR access_status='';
DROP INDEX IF EXISTS repository_access_one_selected_per_tenant_idx;
CREATE UNIQUE INDEX repository_access_one_selected_per_tenant_idx ON repository_access (tenant_id) WHERE selected = true;
DO $$ BEGIN
  ALTER TABLE github_installations ADD CONSTRAINT github_installations_status_check CHECK (status IN ('active','suspended','deleted','disconnected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE repository_access ADD CONSTRAINT repository_access_status_check CHECK (access_status IN ('accessible','access_removed','installation_suspended','unavailable','disconnected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
