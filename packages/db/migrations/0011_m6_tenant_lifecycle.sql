-- Tenant-level fence for the supported one-owner/one-installation product.
CREATE TABLE IF NOT EXISTS tenant_lifecycles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  state varchar(30) NOT NULL DEFAULT 'active' CHECK (state IN ('active','disconnected','deletion_requested','deleted')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_lifecycles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_lifecycles;
CREATE POLICY tenant_isolation ON tenant_lifecycles
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON tenant_lifecycles TO devmemoir_api;
GRANT SELECT ON tenant_lifecycles TO devmemoir_worker;

-- Revocation uses the exclusive counterpart of every tenant transaction's
-- shared advisory lock. Existing transactions finish before it is acknowledged;
-- later worker transactions must match the durable lifecycle version.
CREATE OR REPLACE FUNCTION devmemoir_disconnect_tenant(target_tenant uuid, revoked_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF target_tenant::text IS DISTINCT FROM current_setting('app.tenant_id', true) THEN
    RAISE EXCEPTION 'tenant_scope_required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(174031, hashtext(target_tenant::text));
  IF EXISTS (SELECT 1 FROM public.tenant_lifecycles WHERE tenant_id=target_tenant AND state <> 'active') THEN RETURN; END IF;
  UPDATE public.github_installations SET status='disconnected', deleted_at=revoked_at, suspended_at=null, updated_at=revoked_at WHERE tenant_id=target_tenant;
  UPDATE public.repository_access SET selected=false, access_status='disconnected', revoked_at=devmemoir_disconnect_tenant.revoked_at WHERE tenant_id=target_tenant;
  UPDATE public.webhook_deliveries SET state='ignored', processed_at=revoked_at, payload_ciphertext=null, payload_key_version=null, lease_expires_at=null WHERE tenant_id=target_tenant;
  UPDATE public.sync_jobs SET state='cancelled', finished_at=revoked_at WHERE tenant_id=target_tenant;
  INSERT INTO public.tenant_lifecycles (tenant_id, version, state, changed_at)
  VALUES (target_tenant, 1, 'disconnected', revoked_at)
  ON CONFLICT (tenant_id) DO UPDATE SET version=tenant_lifecycles.version+1, state='disconnected', changed_at=excluded.changed_at
  WHERE tenant_lifecycles.state='active';
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_disconnect_tenant(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_disconnect_tenant(uuid,timestamptz) TO devmemoir_api;

-- Worker authority is restricted to a routed installation lifecycle signal.
CREATE OR REPLACE FUNCTION devmemoir_remove_installation(target_tenant uuid, installation_github_id bigint, removed_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF target_tenant::text IS DISTINCT FROM current_setting('app.tenant_id',true)
    OR NOT EXISTS (SELECT 1 FROM public.github_installations WHERE tenant_id=target_tenant AND github_installation_id=installation_github_id) THEN
    RAISE EXCEPTION 'tenant_scope_required' USING ERRCODE='42501';
  END IF;
  PERFORM public.devmemoir_disconnect_tenant(target_tenant,removed_at);
  UPDATE public.github_installations SET status='deleted' WHERE tenant_id=target_tenant AND github_installation_id=installation_github_id;
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_remove_installation(uuid,bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_remove_installation(uuid,bigint,timestamptz) TO devmemoir_worker,devmemoir_api;

-- SQL clients cannot bypass revocation by omitting the application's work
-- context. Normalized rows become unreadable to runtime roles when inactive.
GRANT SELECT ON tenant_lifecycles TO devmemoir_web;
CREATE OR REPLACE FUNCTION devmemoir_tenant_active(target_tenant uuid)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.tenant_lifecycles WHERE tenant_id=target_tenant AND state <> 'active');
$$;
REVOKE ALL ON FUNCTION devmemoir_tenant_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_tenant_active(uuid) TO devmemoir_api, devmemoir_worker, devmemoir_web;

CREATE OR REPLACE FUNCTION devmemoir_guard_tenant_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(174031, hashtext(NEW.tenant_id::text));
  IF NOT public.devmemoir_tenant_active(NEW.tenant_id) THEN
    RAISE EXCEPTION 'lifecycle_revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_guard_tenant_write() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['repositories','repository_access','repository_name_history','branches','commits','development_events','commit_refs','sync_cursors','tags','pull_requests','issues','releases','reconciliation_generations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_write_lifecycle ON %I', table_name);
    EXECUTE format('CREATE TRIGGER tenant_write_lifecycle BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION devmemoir_guard_tenant_write()', table_name);
    EXECUTE format('DROP POLICY IF EXISTS active_tenant_read ON %I', table_name);
    EXECUTE format('CREATE POLICY active_tenant_read ON %I AS RESTRICTIVE FOR SELECT TO devmemoir_api, devmemoir_worker, devmemoir_web USING (devmemoir_tenant_active(tenant_id))', table_name);
  END LOOP;
END $$;
