-- Milestone 5.6: app-global worker liveness metadata.
-- Rows contain only opaque worker UUIDs and lifecycle timestamps.

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_instance_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_heartbeat_idx
  ON worker_heartbeats (last_heartbeat_at DESC);

GRANT SELECT ON worker_heartbeats TO devmemoir_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO devmemoir_worker;
REVOKE INSERT, UPDATE, DELETE ON worker_heartbeats FROM devmemoir_api;
REVOKE ALL ON worker_heartbeats FROM devmemoir_web;
