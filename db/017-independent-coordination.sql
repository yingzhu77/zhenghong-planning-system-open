-- Immutable, standalone coordination sources. Creating one never creates or
-- submits a report; completion and extension evidence stays in its review log.
BEGIN;
CREATE TABLE IF NOT EXISTS public.coordination_tasks (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES public.projects(id),
    author_id text NOT NULL REFERENCES public.profiles(user_id),
    author_name text NOT NULL,
    owner_id text NOT NULL REFERENCES public.profiles(user_id),
    owner_name text NOT NULL,
    what text NOT NULL CHECK (length(btrim(what)) BETWEEN 1 AND 10000),
    due date,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coordination_tasks_author_project ON public.coordination_tasks(author_id,project_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS coordination_tasks_owner_project ON public.coordination_tasks(owner_id,project_id,created_at DESC,id);
ALTER TABLE public.coordination_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coordination_tasks FROM PUBLIC;
GRANT SELECT,INSERT ON public.coordination_tasks TO app_runtime;
DROP POLICY IF EXISTS coordination_tasks_read ON public.coordination_tasks;
CREATE POLICY coordination_tasks_read ON public.coordination_tasks FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
      app_private.has_approved_role(ARRAY['ops','president','pzo']) OR
      (app_private.has_approved_role(ARRAY['pm']) AND (author_id=auth.uid() OR owner_id=auth.uid()))));
DROP POLICY IF EXISTS coordination_tasks_insert ON public.coordination_tasks;
CREATE POLICY coordination_tasks_insert ON public.coordination_tasks FOR INSERT TO app_runtime
    WITH CHECK (author_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id));

CREATE OR REPLACE FUNCTION app_private.guard_coordination_task()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE author_record record; owner_record record;
BEGIN
    IF NOT app_private.has_approved_role(ARRAY['pm']) OR NEW.author_id<>auth.uid() THEN
        RAISE EXCEPTION 'Only the originating reporter may create coordination' USING ERRCODE='42501';
    END IF;
    SELECT * INTO author_record FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=auth.uid() AND p.role='pm';
    SELECT * INTO owner_record FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role='pm';
    IF author_record.user_id IS NULL OR owner_record.user_id IS NULL THEN
        RAISE EXCEPTION 'Origin and owner must be active project reporters' USING ERRCODE='42501';
    END IF;
    NEW.author_name:=author_record.name; NEW.owner_name:=owner_record.name; NEW.created_at:=now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_coordination_task() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_coordination_task ON public.coordination_tasks;
CREATE TRIGGER guard_coordination_task BEFORE INSERT ON public.coordination_tasks
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_coordination_task();

CREATE OR REPLACE FUNCTION app_private.is_initiator_coordination(
    target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
    SELECT COALESCE(target_kind='coord' AND split_part(target_key,':',1)='coord' AND (
      array_length(string_to_array(target_key,':'),1)=3 OR
      (array_length(string_to_array(target_key,':'),1)=5 AND split_part(target_key,':',4)='coord')),false);
$$;
CREATE OR REPLACE FUNCTION app_private.can_review_completion(
    target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT app_private.can_read_project(target_project_id) AND CASE
      WHEN app_private.is_initiator_coordination(target_kind,target_key,target_project_id,target_report_id)
        THEN app_private.has_approved_role(ARRAY['pm']) AND split_part(target_key,':',2)=target_project_id AND (
          (array_length(string_to_array(target_key,':'),1)=3 AND target_report_id IS NULL
            AND EXISTS(SELECT 1 FROM public.coordination_tasks t WHERE t.id::text=split_part(target_key,':',3)
              AND t.project_id=target_project_id AND t.author_id=auth.uid())) OR
          (array_length(string_to_array(target_key,':'),1)=5 AND split_part(target_key,':',3)=target_report_id::text
            AND length(split_part(target_key,':',5))>0
            AND EXISTS(SELECT 1 FROM public.reports r WHERE r.id=target_report_id
              AND r.project_id=target_project_id AND r.author_id=auth.uid())))
      ELSE app_private.has_approved_role(ARRAY['ops']) END;
$$;
CREATE OR REPLACE FUNCTION app_private.lock_completion_source(target_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item public.completion_requests%ROWTYPE;
BEGIN
    SELECT * INTO item FROM public.completion_requests WHERE id=target_request_id;
    IF NOT FOUND OR NOT app_private.can_review_completion(item.kind,item.source_key,item.project_id,item.report_id) THEN
        RAISE EXCEPTION 'Completion source lock denied' USING ERRCODE='42501';
    END IF;
    IF item.kind='milestone' THEN
        PERFORM 1 FROM public.milestones WHERE id=item.source_id::bigint AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='leader' THEN
        PERFORM 1 FROM public.leader_notes WHERE id=item.source_id::uuid AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='meeting' THEN
        PERFORM 1 FROM public.reporter_tasks WHERE id=item.source_id::uuid AND project_id=item.project_id AND owner_id=item.owner_id FOR SHARE;
    ELSIF item.kind='coord' AND array_length(string_to_array(item.source_key,':'),1)=3 THEN
        PERFORM 1 FROM public.coordination_tasks WHERE id::text=split_part(item.source_key,':',3) AND project_id=item.project_id FOR SHARE;
    ELSE
        PERFORM 1 FROM public.reports WHERE id=item.report_id AND project_id=item.project_id FOR SHARE;
    END IF;
    RETURN FOUND;
END;
$$;
COMMIT;
