-- M5.2 repair ownership: distinguish in-flight App-JWT POSTs from GitHub 202
-- acceptance. Replay-safe for databases that already applied 0006.

ALTER TABLE github_delivery_repairs DROP CONSTRAINT IF EXISTS github_delivery_repairs_status_check;
DO $$ BEGIN
  ALTER TABLE github_delivery_repairs ADD CONSTRAINT github_delivery_repairs_status_check
    CHECK (status IN ('healthy','pending','requesting','requested','skipped_terminal','skipped_processing','exhausted','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
