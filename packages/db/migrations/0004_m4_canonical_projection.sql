-- Milestone 4: one deterministic, versioned canonical projection.
-- This migration is replay-safe and upgrades existing M1/M3 event rows to a
-- stable logical identity before the worker starts replacing projection data.

ALTER TABLE commits ADD COLUMN IF NOT EXISTS html_url text;

-- Preserve the URL that M1/M3 stored on the legacy commit event when the
-- source commit row did not yet have a URL column.
UPDATE commits c
SET html_url = e.source_url
FROM development_events e
WHERE c.html_url IS NULL
  AND e.tenant_id = c.tenant_id
  AND e.repository_id = c.repository_id
  AND e.source_kind = 'commit'
  AND e.source_external_id = c.sha
  AND e.source_url IS NOT NULL;

ALTER TABLE development_events ADD COLUMN IF NOT EXISTS attribution_confidence varchar(40) NOT NULL DEFAULT 'unknown';
ALTER TABLE development_events ADD COLUMN IF NOT EXISTS projection_version integer NOT NULL DEFAULT 0;
ALTER TABLE development_events ADD COLUMN IF NOT EXISTS logical_event_key varchar(1024);

UPDATE development_events
SET attribution_confidence = CASE WHEN actor_github_account_id IS NULL THEN 'unknown' ELSE 'exact_github_actor' END
WHERE attribution_confidence IS NULL OR attribution_confidence = '';

UPDATE development_events
SET logical_event_key = concat_ws(':', tenant_id::text, repository_id::text, source_kind, source_external_id, event_type, verb, contribution_role)
WHERE logical_event_key IS NULL;

ALTER TABLE development_events ALTER COLUMN logical_event_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS development_events_logical_key_unique ON development_events (logical_event_key);
CREATE INDEX IF NOT EXISTS development_events_tenant_repository_date_idx ON development_events (tenant_id, repository_id, occurred_at);
CREATE INDEX IF NOT EXISTS development_events_context_actor_idx ON development_events (tenant_id, repository_id, context_kind, actor_kind);

DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_actor_kind_check
    CHECK (actor_kind IN ('user','bot','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_context_kind_check
    CHECK (context_kind IN ('personal','project','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_attribution_confidence_check
    CHECK (attribution_confidence IN ('exact_github_actor','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_projection_version_check
    CHECK (projection_version >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_completeness_check
    CHECK (completeness_state IN ('observed','reachable_at_sync','known_unknown','out_of_scope'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_visibility_check
    CHECK (visibility IN ('public','private','internal','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_vocabulary_check
    CHECK (
      (event_type, verb) IN (
        ('commit','authored'), ('commit','committed'),
        ('pull_request','opened'), ('pull_request','merged'), ('pull_request','closed'),
        ('issue','opened'), ('issue','closed'), ('issue','reopened'),
        ('release','published'), ('release','edited'),
        ('repository','created'), ('repository','archived'), ('repository','renamed'),
        ('tag','created'), ('tag','deleted')
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE development_events ADD CONSTRAINT development_events_role_check
    CHECK (contribution_role IN ('author','committer','opener','merger','releaser','maintainer','unknown_action'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE development_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON development_events;
CREATE POLICY tenant_isolation ON development_events
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- The API and Web are read-only for GitHub-derived canonical facts. The
-- worker is the sole runtime projection owner and needs DELETE for atomic
-- repository replacement inside one tenant-scoped transaction.
REVOKE INSERT, UPDATE, DELETE ON development_events FROM devmemoir_api;
REVOKE INSERT, UPDATE, DELETE ON development_events FROM devmemoir_web;
GRANT SELECT ON development_events TO devmemoir_api, devmemoir_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON development_events TO devmemoir_worker;
