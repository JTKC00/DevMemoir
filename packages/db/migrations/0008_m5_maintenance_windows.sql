-- Milestone 5.3: durable maintenance-window claims.
-- App-global operational metadata only (task, UTC bucket, job ids, timestamps,
-- sanitized codes). No tenant_id: cadence is App-wide, like github_delivery_audits.
-- No repository names, payloads, titles, messages, or credentials.

CREATE TABLE IF NOT EXISTS maintenance_windows (
  task varchar(40) NOT NULL,
  bucket varchar(16) NOT NULL,
  job_kind varchar(40) NOT NULL,
  accepted_job_id varchar(64) NOT NULL,
  accepted_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error_code varchar(120),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task, bucket)
);

DO $$ BEGIN
  ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_task_check
    CHECK (task IN ('active_reconciliation','authorized_reconciliation','delivery_audit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_bucket_check
    CHECK (bucket ~ '^[0-9]{8}T[0-9]{2}$' OR bucket ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON maintenance_windows TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE ON maintenance_windows TO devmemoir_worker;
REVOKE INSERT, UPDATE, DELETE ON maintenance_windows FROM devmemoir_api;
REVOKE INSERT, UPDATE, DELETE ON maintenance_windows FROM devmemoir_web;
