-- Additive meeting follow-up storage. Existing reports keep their own period
-- snapshots; this table represents the reporter's current meeting matters.
BEGIN;
CREATE TABLE IF NOT EXISTS public.reporter_tasks (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES public.projects(id),
    owner_id text NOT NULL REFERENCES public.profiles(user_id),
    owner_name text NOT NULL,
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
    what text NOT NULL CHECK (length(btrim(what)) BETWEEN 1 AND 10000),
    due date,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed')),
    progress text NOT NULL DEFAULT '' CHECK (length(progress) <= 10000),
    rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text) = 'object'),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS reporter_tasks_owner_project ON public.reporter_tasks(owner_id,project_id);
ALTER TABLE public.reporter_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reporter_tasks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.reporter_tasks TO app_runtime;
DROP POLICY IF EXISTS reporter_tasks_read ON public.reporter_tasks;
CREATE POLICY reporter_tasks_read ON public.reporter_tasks FOR SELECT TO app_runtime
    USING (owner_id = auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id));
DROP POLICY IF EXISTS reporter_tasks_insert ON public.reporter_tasks;
CREATE POLICY reporter_tasks_insert ON public.reporter_tasks FOR INSERT TO app_runtime
    WITH CHECK (owner_id = auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id));
DROP POLICY IF EXISTS reporter_tasks_update ON public.reporter_tasks;
CREATE POLICY reporter_tasks_update ON public.reporter_tasks FOR UPDATE TO app_runtime
    USING (owner_id = auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id))
    WITH CHECK (owner_id = auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id));

CREATE OR REPLACE FUNCTION app_private.guard_reporter_task()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.revision := 1;
        NEW.history := '[]'::jsonb;
        NEW.created_at := now();
    ELSE
        IF (to_jsonb(NEW) - ARRAY['title','what','due','status','progress','rich_text'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['title','what','due','status','progress','rich_text']) THEN
            RAISE EXCEPTION 'Meeting matter identity and audit fields cannot be rewritten' USING ERRCODE = '42501';
        END IF;
        NEW.revision := OLD.revision + 1;
        NEW.history := OLD.history || jsonb_build_array(jsonb_build_object(
            'at', now(), 'by', auth.uid(), 'data', to_jsonb(OLD) - 'history'));
    END IF;
    NEW.updated_at := now();
    IF NEW.status = 'completed' THEN
        IF TG_OP = 'INSERT' THEN NEW.completed_at := now();
        ELSE NEW.completed_at := COALESCE(OLD.completed_at, now()); END IF;
    ELSE NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_reporter_task() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_reporter_task ON public.reporter_tasks;
CREATE TRIGGER guard_reporter_task BEFORE INSERT OR UPDATE ON public.reporter_tasks
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_reporter_task();
COMMIT;
