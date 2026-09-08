-- Durable live-data deletion. Stable routing/identity tombstones deliberately
-- survive so late GitHub deliveries and OAuth callbacks cannot recreate data.
CREATE OR REPLACE FUNCTION devmemoir_request_account_deletion(target_tenant uuid, target_user uuid, requested_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF target_tenant::text IS DISTINCT FROM current_setting('app.tenant_id',true)
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=target_user AND primary_tenant_id=target_tenant) THEN
    RAISE EXCEPTION 'tenant_scope_required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(174031,hashtext(target_tenant::text));
  IF EXISTS (SELECT 1 FROM public.tenant_lifecycles WHERE tenant_id=target_tenant AND state IN ('deletion_requested','deleted')) THEN RETURN; END IF;
  PERFORM public.devmemoir_disconnect_tenant(target_tenant,requested_at);
  UPDATE public.tenant_lifecycles SET state='deletion_requested',version=version+1,changed_at=requested_at WHERE tenant_id=target_tenant;
  UPDATE public.tenants SET deletion_requested_at=requested_at WHERE id=target_tenant;
  UPDATE public.users SET deleted_at=requested_at WHERE primary_tenant_id=target_tenant;
  UPDATE public.application_sessions SET revoked_at=coalesce(revoked_at,requested_at) WHERE user_id IN (SELECT id FROM public.users WHERE primary_tenant_id=target_tenant);
  -- This product admits a single owner; unbound OAuth transactions belong to
  -- that login flow and must not survive a deletion request.
  DELETE FROM public.auth_transactions WHERE user_id IS NULL OR user_id IN (SELECT id FROM public.users WHERE primary_tenant_id=target_tenant);
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_request_account_deletion(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_request_account_deletion(uuid,uuid,timestamptz) TO devmemoir_api;

CREATE OR REPLACE FUNCTION devmemoir_pending_account_deletions(batch_limit integer)
RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT tenant_id FROM public.tenant_lifecycles WHERE state='deletion_requested' ORDER BY changed_at,tenant_id LIMIT greatest(0,least(batch_limit,100));
$$;
REVOKE ALL ON FUNCTION devmemoir_pending_account_deletions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_pending_account_deletions(integer) TO devmemoir_worker;

CREATE OR REPLACE FUNCTION devmemoir_purge_account_deletion(target_tenant uuid, purged_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE table_name text; actor_ids uuid[];
BEGIN
  IF target_tenant::text IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'tenant_scope_required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(174031,hashtext(target_tenant::text));
  IF NOT EXISTS (SELECT 1 FROM public.tenant_lifecycles WHERE tenant_id=target_tenant AND state='deletion_requested') THEN RETURN; END IF;
  SELECT array_agg(DISTINCT id) INTO actor_ids FROM (
    SELECT author_github_account_id id FROM public.commits WHERE tenant_id=target_tenant
    UNION SELECT committer_github_account_id FROM public.commits WHERE tenant_id=target_tenant
    UNION SELECT actor_github_account_id FROM public.development_events WHERE tenant_id=target_tenant
    UNION SELECT author_github_account_id FROM public.pull_requests WHERE tenant_id=target_tenant
    UNION SELECT merger_github_account_id FROM public.pull_requests WHERE tenant_id=target_tenant
    UNION SELECT author_github_account_id FROM public.issues WHERE tenant_id=target_tenant
    UNION SELECT author_github_account_id FROM public.releases WHERE tenant_id=target_tenant
  ) actors WHERE id IS NOT NULL;
  DELETE FROM public.github_delivery_repairs WHERE installation_github_id IN (SELECT github_installation_id FROM public.github_installations WHERE tenant_id=target_tenant);
  FOREACH table_name IN ARRAY ARRAY['outbox','sync_jobs','commit_refs','development_events','sync_cursors','reconciliation_generations','tags','pull_requests','issues','releases','branches','commits','repository_name_history','repository_access','repositories','webhook_deliveries'] LOOP
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id=$1',table_name) USING target_tenant;
  END LOOP;
  DELETE FROM public.application_sessions WHERE user_id IN (SELECT id FROM public.users WHERE primary_tenant_id=target_tenant);
  DELETE FROM public.auth_transactions WHERE user_id IN (SELECT id FROM public.users WHERE primary_tenant_id=target_tenant);
  DELETE FROM public.tenant_members WHERE tenant_id=target_tenant;
  UPDATE public.users SET display_name='' WHERE primary_tenant_id=target_tenant;
  UPDATE public.tenants SET slug='deleted-'||id::text WHERE id=target_tenant;
  UPDATE public.github_installations SET permissions='{}',repository_selection=null,suspended_at=null WHERE tenant_id=target_tenant;
  UPDATE public.github_accounts SET login=null,node_id=null,avatar_url=null,profile_updated_at=null WHERE id IN (SELECT gi.github_account_id FROM public.github_identities gi JOIN public.users u ON u.id=gi.user_id WHERE u.primary_tenant_id=target_tenant);
  DELETE FROM public.github_accounts ga WHERE ga.id=ANY(actor_ids)
    AND NOT EXISTS (SELECT 1 FROM public.github_identities WHERE github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.github_installations WHERE account_github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.commits WHERE author_github_account_id=ga.id OR committer_github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.development_events WHERE actor_github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.pull_requests WHERE author_github_account_id=ga.id OR merger_github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.issues WHERE author_github_account_id=ga.id)
    AND NOT EXISTS (SELECT 1 FROM public.releases WHERE author_github_account_id=ga.id);
  UPDATE public.tenant_lifecycles SET state='deleted',changed_at=purged_at WHERE tenant_id=target_tenant;
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_purge_account_deletion(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION devmemoir_purge_account_deletion(uuid,timestamptz) TO devmemoir_worker;

-- Fence session issuance and bound OAuth writes, including a request that was
-- authenticated just before revocation. Deletion itself only deletes these rows.
CREATE OR REPLACE FUNCTION devmemoir_guard_auth_write()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owner_tenant uuid; owner_deleted timestamptz;
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    SELECT primary_tenant_id INTO owner_tenant FROM public.users WHERE id=NEW.user_id;
    PERFORM pg_advisory_xact_lock_shared(174031,hashtext(owner_tenant::text));
    SELECT deleted_at INTO owner_deleted FROM public.users WHERE id=NEW.user_id;
    -- Allow setting revoked_at while executing the deletion request itself.
    IF owner_deleted IS NOT NULL AND NOT (TG_TABLE_NAME='application_sessions' AND TG_OP='UPDATE') THEN
      RAISE EXCEPTION 'lifecycle_revoked' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION devmemoir_guard_auth_write() FROM PUBLIC;
DROP TRIGGER IF EXISTS auth_write_lifecycle ON application_sessions;
CREATE TRIGGER auth_write_lifecycle BEFORE INSERT ON application_sessions FOR EACH ROW EXECUTE FUNCTION devmemoir_guard_auth_write();
DROP TRIGGER IF EXISTS auth_write_lifecycle ON auth_transactions;
CREATE TRIGGER auth_write_lifecycle BEFORE INSERT OR UPDATE ON auth_transactions FOR EACH ROW EXECUTE FUNCTION devmemoir_guard_auth_write();
