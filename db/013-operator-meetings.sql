-- Operators enter source matters; assigned reporters maintain only progress.
-- Existing rows, owner identities and history remain intact.
BEGIN;
ALTER TABLE public.reporter_tasks ADD COLUMN IF NOT EXISTS created_by text REFERENCES public.profiles(user_id);

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
        OR (p.role='pm' AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=p.user_id AND m.project_id=target_project_id)));
$$;
REVOKE ALL ON FUNCTION app_private.project_people(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.project_people(text) TO app_runtime;

DROP POLICY IF EXISTS reporter_tasks_read ON public.reporter_tasks;
CREATE POLICY reporter_tasks_read ON public.reporter_tasks FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))));
DROP POLICY IF EXISTS reporter_tasks_insert ON public.reporter_tasks;
CREATE POLICY reporter_tasks_insert ON public.reporter_tasks FOR INSERT TO app_runtime
    WITH CHECK (app_private.has_approved_role(ARRAY['ops']) AND app_private.can_read_project(project_id)
      AND EXISTS(SELECT 1 FROM app_private.project_people(project_id) p WHERE p.user_id=owner_id AND p.role='pm'));
DROP POLICY IF EXISTS reporter_tasks_update ON public.reporter_tasks;
CREATE POLICY reporter_tasks_update ON public.reporter_tasks FOR UPDATE TO app_runtime
    USING (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))))
    WITH CHECK (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))));

CREATE OR REPLACE FUNCTION app_private.guard_reporter_task()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE operator boolean; assignee record;
BEGIN
    IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
    operator:=app_private.has_approved_role(ARRAY['ops']);
    IF TG_OP='INSERT' THEN
        IF NOT operator THEN RAISE EXCEPTION 'Only operators enter meeting matters' USING ERRCODE='42501'; END IF;
        NEW.created_by:=auth.uid(); NEW.created_at:=now(); NEW.revision:=1; NEW.history:='[]'::jsonb;
        NEW.completed_at:=NULL;
        IF NEW.status NOT IN ('open','in_progress') THEN RAISE EXCEPTION 'Use the completion approval workflow' USING ERRCODE='42501'; END IF;
    ELSE
        IF (to_jsonb(NEW)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text']) THEN
            RAISE EXCEPTION 'Meeting identity and audit fields are immutable' USING ERRCODE='42501';
        END IF;
        IF NOT operator THEN
            IF NOT app_private.has_approved_role(ARRAY['pm']) OR OLD.owner_id<>auth.uid()
              OR (to_jsonb(NEW)-ARRAY['progress','status','rich_text']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['progress','status','rich_text'])
              OR (NEW.rich_text->'fields'->'what') IS DISTINCT FROM (OLD.rich_text->'fields'->'what') THEN
                RAISE EXCEPTION 'Reporter may update only assigned progress' USING ERRCODE='42501';
            END IF;
        END IF;
        IF NEW.status NOT IN ('open','in_progress') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Use the completion approval workflow' USING ERRCODE='42501';
        END IF;
        IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
            NEW.status:='open'; NEW.progress:=''; NEW.completed_at:=NULL;
            IF NEW.rich_text->'fields' ? 'what' THEN
                NEW.rich_text:=jsonb_build_object('v',1,'fields',jsonb_build_object('what',NEW.rich_text->'fields'->'what'));
            ELSE NEW.rich_text:='{}'::jsonb; END IF;
        END IF;
        NEW.revision:=OLD.revision+1;
        NEW.history:=OLD.history || jsonb_build_array(jsonb_build_object('at',now(),'by',auth.uid(),'data',to_jsonb(OLD)-'history'));
    END IF;
    IF operator THEN
        SELECT * INTO assignee FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role='pm';
        IF NOT FOUND THEN RAISE EXCEPTION 'Assignee must be an active project reporter' USING ERRCODE='42501'; END IF;
        NEW.owner_name:=assignee.name;
    END IF;
    NEW.updated_at:=now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_reporter_task() FROM PUBLIC;
COMMIT;
