-- Milestone 5.2: App-JWT failed-delivery audit generations and GUID repair state.
-- These tables store opaque operational metadata only: GUIDs, numeric GitHub
-- ids, cursors, timestamps, counters, and sanitized codes. They do not store
-- webhook payloads, repository names, titles, messages, or GitHub responses.
-- App-global, like installation_routes / unrouted_webhook_deliveries.

CREATE TABLE IF NOT EXISTS github_delivery_audits (
  id uuid PRIMARY KEY,
  github_app_id bigint NOT NULL,
  current_run_id uuid NOT NULL,
  generation bigint NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  list_cursor text,
  page_number integer NOT NULL DEFAULT 1,
  stop_before_delivered_at timestamptz,
  newest_delivered_at_seen timestamptz,
  high_water_delivered_at timestamptz,
  paused_until timestamptz,
  pause_reason varchar(120),
  last_error_code varchar(120),
  last_success_at timestamptz,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS github_delivery_audits_app_unique
  ON github_delivery_audits (github_app_id);
CREATE UNIQUE INDEX IF NOT EXISTS github_delivery_audits_run_unique
  ON github_delivery_audits (github_app_id, current_run_id);

CREATE TABLE IF NOT EXISTS github_delivery_repairs (
  id uuid PRIMARY KEY,
  github_delivery_guid varchar(128) NOT NULL,
  github_delivery_id bigint NOT NULL,
  github_app_id bigint NOT NULL,
  audit_run_id uuid,
  event_name varchar(80) NOT NULL,
  action varchar(80),
  installation_github_id bigint,
  repository_github_id bigint,
  status varchar(30) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_redelivery_requested_at timestamptz,
  next_eligible_at timestamptz,
  last_github_status_code integer,
  last_github_delivered_at timestamptz,
  sanitized_error_code varchar(120),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS github_delivery_repairs_guid_unique
  ON github_delivery_repairs (github_delivery_guid);
CREATE INDEX IF NOT EXISTS github_delivery_repairs_status_idx
  ON github_delivery_repairs (status, next_eligible_at);

DO $$ BEGIN
  ALTER TABLE github_delivery_audits ADD CONSTRAINT github_delivery_audits_generation_positive
    CHECK (generation > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE github_delivery_audits ADD CONSTRAINT github_delivery_audits_page_positive
    CHECK (page_number > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE github_delivery_audits ADD CONSTRAINT github_delivery_audits_status_check
    CHECK (status IN ('pending','in_progress','paused','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE github_delivery_repairs ADD CONSTRAINT github_delivery_repairs_attempt_nonnegative
    CHECK (attempt_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE github_delivery_repairs ADD CONSTRAINT github_delivery_repairs_status_check
    CHECK (status IN ('healthy','pending','requesting','requested','skipped_terminal','skipped_processing','exhausted','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON github_delivery_audits, github_delivery_repairs TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE ON github_delivery_audits, github_delivery_repairs TO devmemoir_worker;
REVOKE INSERT, UPDATE, DELETE ON github_delivery_audits FROM devmemoir_api;
REVOKE INSERT, UPDATE, DELETE ON github_delivery_repairs FROM devmemoir_api;
REVOKE INSERT, UPDATE, DELETE ON github_delivery_audits FROM devmemoir_web;
REVOKE INSERT, UPDATE, DELETE ON github_delivery_repairs FROM devmemoir_web;
