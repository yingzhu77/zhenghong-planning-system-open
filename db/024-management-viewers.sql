-- Management viewing is an explicitly scoped read capability. Existing
-- can_read_project and every original write helper/policy remain unchanged.
BEGIN;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS management_viewer boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app_private.management_read_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(current_setting('app.management_read',true)='on',false) AND EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.status='approved'
      AND (p.role='viewer' OR (p.role='pm' AND p.management_viewer)));
$$;
REVOKE ALL ON FUNCTION app_private.management_read_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.management_read_enabled() TO app_runtime;

-- Only SELECT receives the capability. RLS still requires the internal,
-- transaction-local management scope, even for a capable user's ordinary APIs.
DO $$
DECLARE target_name text;
BEGIN
  FOREACH target_name IN ARRAY ARRAY['projects','profiles','project_members','org',
    'plan_versions','plan_changes','milestones','reports','leader_reviews','leader_notes',
    'reporter_tasks','coordination_tasks','completion_requests','monthly_plans',
    'project_master','project_phases','project_drawings','project_library_documents']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS management_read ON public.%I',target_name);
    EXECUTE format('CREATE POLICY management_read ON public.%I FOR SELECT TO app_runtime USING(app_private.management_read_enabled())',target_name);
  END LOOP;
END $$;

-- A caller may not nominate a viewing capability during self-registration.
-- Operators retain the original member-administration authority.
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO app_runtime WITH CHECK(
  auth.uid() IS NOT NULL AND role IN ('pm','ops','president','pzo','viewer') AND status IN ('pending','approved')
  AND (app_private.has_approved_role(ARRAY['ops'])
    OR (user_id=auth.uid() AND role='pm' AND status='pending' AND project_id IS NULL
      AND biz_line IS NULL AND discipline IS NULL AND management_viewer=false)));
DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO app_runtime
  USING(app_private.has_approved_role(ARRAY['ops']))
  WITH CHECK(app_private.has_approved_role(ARRAY['ops']) AND user_id<>''
    AND role IN ('pm','ops','president','pzo','viewer') AND status IN ('pending','approved','rejected'));

-- Reading library secrets remains server-only. Document upload/withdrawal and
-- project-password changes keep their original project/write authorization.
CREATE OR REPLACE FUNCTION app_private.library_password(p_project text)
RETURNS TABLE(password_hash text,revision uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (app_private.can_read_project(p_project) OR app_private.management_read_enabled()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Project library access denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT s.password_hash,s.revision FROM app_private.project_library_passwords s WHERE s.project_id=p_project;
END;
$$;
REVOKE ALL ON FUNCTION app_private.library_password(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.library_password(text) TO app_runtime;
DROP POLICY IF EXISTS management_library_read_event ON public.project_library_events;
CREATE POLICY management_library_read_event ON public.project_library_events FOR INSERT TO app_runtime
  WITH CHECK(app_private.management_read_enabled() AND actor_id=auth.uid() AND action IN ('preview','download')
    AND document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.project_library_documents d
      WHERE d.id=project_library_events.document_id AND d.project_id=project_library_events.project_id AND d.withdrawn_at IS NULL));
COMMIT;
