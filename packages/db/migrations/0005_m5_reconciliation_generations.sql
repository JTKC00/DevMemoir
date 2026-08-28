-- Milestone 5.1: durable reconciliation generation identity.
-- Cursor rows are reset when a new run starts, so they cannot be the source of
-- truth for "have we already seen this run ID?". A delayed coordinator from an
-- older generation must no-op instead of treating missing cursors as "never
-- started". Ordering is a per-repository monotonic generation number assigned
-- at first start, never a lexical comparison of opaque run IDs.

CREATE TABLE IF NOT EXISTS reconciliation_generations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  reconciliation_run_id uuid NOT NULL,
  generation bigint NOT NULL,
  current boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  superseded_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_generations_run_unique
  ON reconciliation_generations (tenant_id, repository_id, reconciliation_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_generations_generation_unique
  ON reconciliation_generations (tenant_id, repository_id, generation);
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_generations_current_unique
  ON reconciliation_generations (tenant_id, repository_id)
  WHERE current = true;
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_generations_tenant_id_unique
  ON reconciliation_generations (tenant_id, id);

DO $$ BEGIN
  ALTER TABLE reconciliation_generations ADD CONSTRAINT reconciliation_generations_tenant_repository_fk
    FOREIGN KEY (tenant_id, repository_id) REFERENCES repositories (tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE reconciliation_generations ADD CONSTRAINT reconciliation_generations_generation_positive
    CHECK (generation > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE reconciliation_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_generations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reconciliation_generations;
CREATE POLICY tenant_isolation ON reconciliation_generations
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT ON reconciliation_generations TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE ON reconciliation_generations TO devmemoir_worker;
REVOKE INSERT, UPDATE, DELETE ON reconciliation_generations FROM devmemoir_api;
REVOKE INSERT, UPDATE, DELETE ON reconciliation_generations FROM devmemoir_web;

-- Adopt any in-flight M5.1 cursor generation that predated this table so a
-- replay of the currently stored run ID still resumes instead of resetting.
INSERT INTO reconciliation_generations (id, tenant_id, repository_id, reconciliation_run_id, generation, current, started_at)
SELECT gen_random_uuid(), tenant_id, repository_id, run_id, 1, true, coalesce(started_at, now())
FROM (
  SELECT DISTINCT ON (tenant_id, repository_id)
         tenant_id,
         repository_id,
         (cursor->>'reconciliationRunId')::uuid AS run_id,
         started_at
  FROM sync_cursors
  WHERE cursor ? 'reconciliationRunId'
    AND cursor->>'reconciliationRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND resource_type IN ('default_branch_commits','branches','tags','pull_requests','issues','releases','completed')
  ORDER BY tenant_id, repository_id, started_at NULLS LAST
) adopted
WHERE NOT EXISTS (
  SELECT 1
  FROM reconciliation_generations existing
  WHERE existing.tenant_id = adopted.tenant_id
    AND existing.repository_id = adopted.repository_id
)
ON CONFLICT (tenant_id, repository_id, reconciliation_run_id) DO NOTHING;
