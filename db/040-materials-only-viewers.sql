BEGIN;

-- Preserve every existing viewer. Materials access is an explicit restriction,
-- independent of all-project versus assigned-project scope.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS viewer_access text NOT NULL DEFAULT 'full'
 CHECK(viewer_access IN ('full','materials'));

CREATE OR REPLACE FUNCTION app_private.management_read_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(current_setting('app.management_read',true)='on',false) AND EXISTS(
  SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.status='approved'
   AND ((p.role='viewer' AND p.viewer_access='full' AND p.viewer_scope='all') OR (p.role='pm' AND p.management_viewer)));
$$;

CREATE OR REPLACE FUNCTION app_private.management_read_project_allowed(pid text,scope_ids text[] DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.management_read_enabled() OR (
  COALESCE(current_setting('app.management_read',true)='on',false)
  AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid()
   AND p.status='approved' AND p.role='viewer' AND p.viewer_access='full' AND p.viewer_scope='projects')
  AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=auth.uid() AND m.project_id=pid)
  AND NOT EXISTS(SELECT 1 FROM unnest(scope_ids) s(id) WHERE NOT EXISTS(
   SELECT 1 FROM public.project_members m WHERE m.user_id=auth.uid() AND m.project_id=s.id)));
$$;

CREATE OR REPLACE FUNCTION app_private.material_read_project_allowed(pid text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(current_setting('app.material_read',true)='on',false) AND EXISTS(
  SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.status='approved'
   AND p.role='viewer' AND p.viewer_access='materials'
   AND (p.viewer_scope='all' OR EXISTS(SELECT 1 FROM public.project_members m
    WHERE m.user_id=p.user_id AND m.project_id=pid)));
$$;
REVOKE ALL ON FUNCTION app_private.material_read_project_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.material_read_project_allowed(text) TO app_runtime;

DO $$
DECLARE target_name text;
BEGIN
 FOREACH target_name IN ARRAY ARRAY['projects','project_master','project_phases','project_drawings','project_library_documents'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS material_read ON public.%I',target_name);
  EXECUTE format('CREATE POLICY material_read ON public.%I FOR SELECT TO app_runtime USING(app_private.material_read_project_allowed(%I))',
   target_name,CASE WHEN target_name='projects' THEN 'id' ELSE 'project_id' END);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.library_password(p_project text)
RETURNS TABLE(password_hash text,revision uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (app_private.can_read_project(p_project) OR app_private.management_read_project_allowed(p_project)
  OR app_private.material_read_project_allowed(p_project)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Project library access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.password_hash,s.revision FROM app_private.project_library_passwords s WHERE s.project_id=p_project;
END;
$$;
DROP POLICY IF EXISTS management_library_read_event ON public.project_library_events;
CREATE POLICY management_library_read_event ON public.project_library_events FOR INSERT TO app_runtime
 WITH CHECK((app_private.management_read_project_allowed(project_id) OR app_private.material_read_project_allowed(project_id))
  AND actor_id=auth.uid() AND action IN ('preview','download')
  AND document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.project_library_documents d
   WHERE d.id=project_library_events.document_id AND d.project_id=project_library_events.project_id AND d.withdrawn_at IS NULL));

-- A materials-only viewer cannot read coordination, so do not offer them as a recipient.
CREATE OR REPLACE FUNCTION app_private.project_people(target_project_id text)
RETURNS TABLE(user_id text,name text,role text,biz_line text,discipline text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.user_id,p.name,p.role,p.biz_line,p.discipline
 FROM public.profiles p JOIN app_private.auth_users a ON a.user_id=p.user_id
 WHERE p.status='approved' AND NOT a.disabled
  AND app_private.has_approved_role(ARRAY['pm','ops','president','pzo'])
  AND app_private.can_read_project(target_project_id)
  AND (p.role IN ('ops','president')
   OR (p.role='pzo' AND (p.project_id=target_project_id
    OR EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=p.user_id AND m.project_id=target_project_id)))
   OR (p.role IN ('pm','viewer') AND (p.role='pm' OR p.viewer_scope='projects' AND p.viewer_access='full')
    AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=p.user_id AND m.project_id=target_project_id)));
$$;
COMMIT;
