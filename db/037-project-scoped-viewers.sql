BEGIN;

-- Existing viewers keep their all-project scope. A restricted viewer uses
-- explicit project memberships and receives SELECT access only in read context.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS viewer_scope text NOT NULL DEFAULT 'all'
 CHECK(viewer_scope IN ('all','projects'));

CREATE OR REPLACE FUNCTION app_private.management_read_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(current_setting('app.management_read',true)='on',false) AND EXISTS(
  SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.status='approved'
   AND ((p.role='viewer' AND p.viewer_scope='all') OR (p.role='pm' AND p.management_viewer)));
$$;

CREATE OR REPLACE FUNCTION app_private.management_read_project_allowed(pid text,scope_ids text[] DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.management_read_enabled() OR (
  COALESCE(current_setting('app.management_read',true)='on',false)
  AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid()
   AND p.status='approved' AND p.role='viewer' AND p.viewer_scope='projects')
  AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=auth.uid() AND m.project_id=pid)
  AND NOT EXISTS(SELECT 1 FROM unnest(scope_ids) s(id) WHERE NOT EXISTS(
   SELECT 1 FROM public.project_members m WHERE m.user_id=auth.uid() AND m.project_id=s.id)));
$$;
REVOKE ALL ON FUNCTION app_private.management_read_project_allowed(text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.management_read_project_allowed(text,text[]) TO app_runtime;

DO $$
DECLARE target_name text; expression text;
BEGIN
 FOREACH target_name IN ARRAY ARRAY['projects','project_members','plan_versions','plan_changes',
  'milestones','reports','leader_notes','reporter_tasks','coordination_tasks','completion_requests',
  'monthly_plans','monthly_plan_summaries','project_master','project_phases','project_drawings','project_library_documents'] LOOP
  expression:=CASE WHEN target_name='projects' THEN 'app_private.management_read_project_allowed(id)'
   WHEN target_name IN ('reports','monthly_plans','monthly_plan_summaries')
    THEN 'app_private.management_read_project_allowed(project_id,scope_project_ids)'
   ELSE 'app_private.management_read_project_allowed(project_id)' END;
  EXECUTE format('DROP POLICY IF EXISTS management_read ON public.%I',target_name);
  EXECUTE format('CREATE POLICY management_read ON public.%I FOR SELECT TO app_runtime USING(%s)',target_name,expression);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.library_password(p_project text)
RETURNS TABLE(password_hash text,revision uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (app_private.can_read_project(p_project) OR app_private.management_read_project_allowed(p_project)) IS NOT TRUE THEN
  RAISE EXCEPTION 'Project library access denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.password_hash,s.revision FROM app_private.project_library_passwords s WHERE s.project_id=p_project;
END;
$$;
DROP POLICY IF EXISTS management_library_read_event ON public.project_library_events;
CREATE POLICY management_library_read_event ON public.project_library_events FOR INSERT TO app_runtime
 WITH CHECK(app_private.management_read_project_allowed(project_id) AND actor_id=auth.uid() AND action IN ('preview','download')
  AND document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.project_library_documents d
   WHERE d.id=project_library_events.document_id AND d.project_id=project_library_events.project_id AND d.withdrawn_at IS NULL));

-- Project assignment of a restricted viewer is an operator action. Membership
-- never gives that viewer the pm role or any of the original write policies.
DROP POLICY IF EXISTS project_members_write ON public.project_members;
CREATE POLICY project_members_write ON public.project_members FOR ALL TO app_runtime
 USING(app_private.has_approved_role(ARRAY['ops']))
 WITH CHECK(app_private.has_approved_role(ARRAY['ops']) AND (
  role_in_project='pm' AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=project_members.user_id)
  OR role_in_project='viewer' AND EXISTS(SELECT 1 FROM public.profiles p
   WHERE p.user_id=project_members.user_id AND p.role='viewer' AND p.viewer_scope='projects')));

-- Restricted project viewers may be selected as coordination recipients.
-- Meeting-task assignment and every completion/write permission stay unchanged.
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
   OR (p.role IN ('pm','viewer') AND (p.role='pm' OR p.viewer_scope='projects')
    AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=p.user_id AND m.project_id=target_project_id)));
$$;

CREATE OR REPLACE FUNCTION app_private.guard_coordination_task()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE author_record record; owner_record record;
BEGIN
 IF NOT app_private.has_approved_role(ARRAY['pm']) OR NEW.author_id<>auth.uid() THEN
  RAISE EXCEPTION 'Only the originating reporter may create coordination' USING ERRCODE='42501'; END IF;
 SELECT * INTO author_record FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=auth.uid() AND p.role='pm';
 SELECT * INTO owner_record FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role IN ('pm','viewer');
 IF author_record.user_id IS NULL OR owner_record.user_id IS NULL THEN
  RAISE EXCEPTION 'Origin and owner must be active project participants' USING ERRCODE='42501'; END IF;
 NEW.author_name:=author_record.name; NEW.owner_name:=owner_record.name; NEW.created_at:=now();
 RETURN NEW;
END;
$$;
COMMIT;
