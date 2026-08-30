-- Milestone 6.1: raw webhook payload retention tombstones and worker-only purge.

ALTER TABLE unrouted_webhook_deliveries
  ALTER COLUMN payload_ciphertext DROP NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_deliveries_payload_expiry_idx
  ON webhook_deliveries (payload_expires_at, id)
  WHERE payload_ciphertext IS NOT NULL;

CREATE INDEX IF NOT EXISTS unrouted_webhook_deliveries_payload_expiry_idx
  ON unrouted_webhook_deliveries (payload_expires_at, id)
  WHERE payload_ciphertext IS NOT NULL;

GRANT SELECT, UPDATE ON unrouted_webhook_deliveries TO devmemoir_worker;
REVOKE UPDATE, DELETE ON unrouted_webhook_deliveries FROM devmemoir_web;
REVOKE UPDATE, DELETE ON unrouted_webhook_deliveries FROM devmemoir_api;

DROP POLICY IF EXISTS worker_expired_payload_select ON webhook_deliveries;
CREATE POLICY worker_expired_payload_select ON webhook_deliveries
  FOR SELECT
  TO devmemoir_worker
  USING (payload_ciphertext IS NOT NULL AND payload_expires_at <= now());

DROP POLICY IF EXISTS worker_expired_payload_update ON webhook_deliveries;
CREATE POLICY worker_expired_payload_update ON webhook_deliveries
  FOR UPDATE
  TO devmemoir_worker
  USING (payload_ciphertext IS NOT NULL AND payload_expires_at <= now())
  WITH CHECK (payload_ciphertext IS NULL);
