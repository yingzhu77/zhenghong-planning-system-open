-- Separate new meeting requirements from special meeting decisions. Existing
-- matters and their completion keys remain unchanged and explicitly legacy.
BEGIN;
ALTER TABLE public.reporter_tasks ADD COLUMN IF NOT EXISTS meeting_kind text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.reporter_tasks ALTER COLUMN meeting_kind SET DEFAULT 'special';
ALTER TABLE public.reporter_tasks ADD COLUMN IF NOT EXISTS proposer_id text REFERENCES public.profiles(user_id);
ALTER TABLE public.reporter_tasks ADD COLUMN IF NOT EXISTS proposer_role text;
ALTER TABLE public.reporter_tasks ADD COLUMN IF NOT EXISTS proposer_name text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.reporter_tasks'::regclass AND conname='reporter_tasks_meeting_kind') THEN
        ALTER TABLE public.reporter_tasks ADD CONSTRAINT reporter_tasks_meeting_kind CHECK (meeting_kind IN ('legacy','requirement','special'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.reporter_tasks'::regclass AND conname='reporter_tasks_proposer') THEN
        ALTER TABLE public.reporter_tasks ADD CONSTRAINT reporter_tasks_proposer CHECK (
            (proposer_id IS NULL AND proposer_role IS NULL AND proposer_name IS NULL AND meeting_kind<>'requirement')
            OR (proposer_id IS NOT NULL AND proposer_role IS NOT NULL AND proposer_name IS NOT NULL
                AND proposer_role IN ('president','pzo') AND length(btrim(proposer_name))>0));
    END IF;
END $$;

DROP POLICY IF EXISTS reporter_tasks_read ON public.reporter_tasks;
CREATE POLICY reporter_tasks_read ON public.reporter_tasks FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops','president','pzo'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))));
DROP POLICY IF EXISTS reporter_tasks_insert ON public.reporter_tasks;
CREATE POLICY reporter_tasks_insert ON public.reporter_tasks FOR INSERT TO app_runtime
    WITH CHECK (app_private.can_read_project(project_id)
      AND (app_private.has_approved_role(ARRAY['ops']) OR (meeting_kind='requirement' AND proposer_id=auth.uid()
        AND app_private.has_approved_role(ARRAY['president','pzo'])))
      AND EXISTS(SELECT 1 FROM app_private.project_people(project_id) p WHERE p.user_id=owner_id AND p.role='pm'));
DROP POLICY IF EXISTS reporter_tasks_update ON public.reporter_tasks;
CREATE POLICY reporter_tasks_update ON public.reporter_tasks FOR UPDATE TO app_runtime
    USING (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR (meeting_kind='requirement' AND proposer_id=auth.uid() AND app_private.has_approved_role(ARRAY['president','pzo']))))
    WITH CHECK (app_private.can_read_project(project_id) AND (app_private.has_approved_role(ARRAY['ops'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR (meeting_kind='requirement' AND proposer_id=auth.uid() AND app_private.has_approved_role(ARRAY['president','pzo']))));

CREATE OR REPLACE FUNCTION app_private.guard_reporter_task()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE operator boolean; leader boolean; assignee record; proposer record; validate_proposer boolean;
BEGIN
    IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
    operator:=app_private.has_approved_role(ARRAY['ops']);
    leader:=app_private.has_approved_role(ARRAY['president','pzo']);
    IF TG_OP='INSERT' THEN
        IF NEW.meeting_kind NOT IN ('requirement','special') THEN RAISE EXCEPTION 'Choose a new meeting category' USING ERRCODE='42501'; END IF;
        IF NOT operator AND NOT (leader AND NEW.meeting_kind='requirement' AND NEW.proposer_id=auth.uid()) THEN
            RAISE EXCEPTION 'Only operators enter decisions; leaders enter their own requirements' USING ERRCODE='42501';
        END IF;
        NEW.created_by:=auth.uid(); NEW.created_at:=now(); NEW.revision:=1; NEW.history:='[]'::jsonb; NEW.completed_at:=NULL;
        IF NEW.status NOT IN ('open','in_progress') THEN RAISE EXCEPTION 'Use the completion approval workflow' USING ERRCODE='42501'; END IF;
        validate_proposer:=true;
    ELSE
        IF (to_jsonb(NEW)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text','meeting_kind','proposer_id','proposer_role','proposer_name'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text','meeting_kind','proposer_id','proposer_role','proposer_name']) THEN
            RAISE EXCEPTION 'Meeting identity and audit fields are immutable' USING ERRCODE='42501';
        END IF;
        IF NOT operator THEN
            IF app_private.has_approved_role(ARRAY['pm']) THEN
                IF OLD.owner_id<>auth.uid()
                  OR (to_jsonb(NEW)-ARRAY['progress','status','rich_text']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['progress','status','rich_text'])
                  OR (NEW.rich_text->'fields'->'what') IS DISTINCT FROM (OLD.rich_text->'fields'->'what') THEN
                    RAISE EXCEPTION 'Reporter may update only assigned progress' USING ERRCODE='42501';
                END IF;
            ELSIF NOT leader OR OLD.meeting_kind<>'requirement' OR OLD.proposer_id<>auth.uid()
              OR ROW(NEW.meeting_kind,NEW.proposer_id,NEW.proposer_role,NEW.proposer_name) IS DISTINCT FROM ROW(OLD.meeting_kind,OLD.proposer_id,OLD.proposer_role,OLD.proposer_name) THEN
                RAISE EXCEPTION 'Leader may maintain only their own requirements' USING ERRCODE='42501';
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
        validate_proposer:=NEW.proposer_id IS DISTINCT FROM OLD.proposer_id OR NEW.meeting_kind IS DISTINCT FROM OLD.meeting_kind;
        IF NOT validate_proposer AND ROW(NEW.proposer_role,NEW.proposer_name) IS DISTINCT FROM ROW(OLD.proposer_role,OLD.proposer_name) THEN
            RAISE EXCEPTION 'Proposer identity is derived from the project people directory' USING ERRCODE='42501';
        END IF;
        NEW.revision:=OLD.revision+1;
        NEW.history:=OLD.history || jsonb_build_array(jsonb_build_object('at',now(),'by',auth.uid(),'data',to_jsonb(OLD)-'history'));
    END IF;
    IF NEW.meeting_kind='requirement' AND NEW.proposer_id IS NULL THEN
        RAISE EXCEPTION 'Meeting requirements need a named leader' USING ERRCODE='42501';
    END IF;
    IF validate_proposer THEN
        IF NEW.proposer_id IS NULL THEN NEW.proposer_name:=NULL; NEW.proposer_role:=NULL;
        ELSE
            SELECT * INTO proposer FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.proposer_id AND p.role IN ('president','pzo');
            IF NOT FOUND THEN RAISE EXCEPTION 'Proposer must be an active project leader' USING ERRCODE='42501'; END IF;
            NEW.proposer_role:=proposer.role; NEW.proposer_name:=proposer.name;
        END IF;
    END IF;
    IF operator OR leader THEN
        SELECT * INTO assignee FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role='pm';
        IF NOT FOUND THEN RAISE EXCEPTION 'Assignee must be an active project reporter' USING ERRCODE='42501'; END IF;
        NEW.owner_name:=assignee.name;
    END IF;
    NEW.updated_at:=now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_reporter_task() FROM PUBLIC;

-- Legacy leadership requirements keep their original leader:<project>:<id>
-- source. Nullable assignment is deliberate: no owner is inferred from text.
ALTER TABLE public.leader_notes ADD COLUMN IF NOT EXISTS owner_id text REFERENCES public.profiles(user_id);
ALTER TABLE public.leader_notes ADD COLUMN IF NOT EXISTS owner_name text;
ALTER TABLE public.leader_notes ADD COLUMN IF NOT EXISTS assignment_history jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS leader_notes_assigned_owner ON public.leader_notes(owner_id,project_id) WHERE owner_id IS NOT NULL;
CREATE OR REPLACE FUNCTION app_private.guard_leader_assignment()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE assignee record;
BEGIN
    IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.assignment_history<>'[]'::jsonb THEN RAISE EXCEPTION 'Assignment audit is server maintained' USING ERRCODE='42501'; END IF;
    ELSE
        IF NEW.assignment_history IS DISTINCT FROM OLD.assignment_history THEN RAISE EXCEPTION 'Assignment audit is immutable' USING ERRCODE='42501'; END IF;
        IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
            IF NEW.owner_name IS DISTINCT FROM OLD.owner_name THEN RAISE EXCEPTION 'Assignee name is server maintained' USING ERRCODE='42501'; END IF;
            RETURN NEW;
        END IF;
    END IF;
    IF NEW.owner_id IS NOT NULL THEN
        IF NOT app_private.has_approved_role(ARRAY['ops']) THEN RAISE EXCEPTION 'Only operators assign historical leadership requirements' USING ERRCODE='42501'; END IF;
        SELECT * INTO assignee FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role='pm';
        IF NOT FOUND THEN RAISE EXCEPTION 'Assignee must be an active project reporter' USING ERRCODE='42501'; END IF;
        NEW.owner_name:=assignee.name;
    ELSE
        IF TG_OP='UPDATE' AND NOT app_private.has_approved_role(ARRAY['ops']) THEN RAISE EXCEPTION 'Only operators can change assignment' USING ERRCODE='42501'; END IF;
        NEW.owner_name:=NULL;
    END IF;
    IF TG_OP='UPDATE' THEN
        NEW.assignment_history:=OLD.assignment_history || jsonb_build_array(jsonb_build_object('at',now(),'by',auth.uid(),'from',OLD.owner_id,'to',NEW.owner_id));
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_leader_assignment() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_leader_assignment ON public.leader_notes;
CREATE TRIGGER guard_leader_assignment BEFORE INSERT OR UPDATE ON public.leader_notes FOR EACH ROW EXECUTE FUNCTION app_private.guard_leader_assignment();
COMMIT;
