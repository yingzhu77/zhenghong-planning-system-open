-- Additive, per-source/per-owner completion review. Existing done/completed
-- values are not converted into fabricated approvals.
BEGIN;
CREATE TABLE IF NOT EXISTS public.completion_requests (
    id uuid PRIMARY KEY,
    source_key text NOT NULL CHECK (length(btrim(source_key)) BETWEEN 1 AND 500),
    source_version text NOT NULL CHECK (source_version ~ '^[0-9a-f]{64}$'),
    project_id text NOT NULL REFERENCES public.projects(id),
    kind text NOT NULL CHECK (kind IN ('milestone','leader','coord','meeting','plan')),
    source_id text NOT NULL,
    report_id bigint REFERENCES public.reports(id),
    title text NOT NULL,
    what text NOT NULL,
    due text NOT NULL DEFAULT '',
    source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
    owner_id text NOT NULL REFERENCES public.profiles(user_id),
    owner_name text NOT NULL,
    completion_date date NOT NULL,
    completion_note text NOT NULL CHECK (length(btrim(completion_note)) BETWEEN 1 AND 10000),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn','reopened')),
    review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 10000),
    reviewer_id text REFERENCES public.profiles(user_id),
    reviewer_name text,
    reviewed_at timestamptz,
    approved_at timestamptz,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(source_key,owner_id)
);
CREATE INDEX IF NOT EXISTS completion_requests_owner_page ON public.completion_requests(owner_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS completion_requests_queue_page ON public.completion_requests(status,created_at DESC,id DESC);
ALTER TABLE public.completion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.completion_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.completion_requests TO app_runtime;
DROP POLICY IF EXISTS completion_requests_read ON public.completion_requests;
CREATE POLICY completion_requests_read ON public.completion_requests FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
        app_private.has_approved_role(ARRAY['ops','president','pzo'])
        OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))));
DROP POLICY IF EXISTS completion_requests_insert ON public.completion_requests;
CREATE POLICY completion_requests_insert ON public.completion_requests FOR INSERT TO app_runtime
    WITH CHECK (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id));
DROP POLICY IF EXISTS completion_requests_update ON public.completion_requests;
CREATE POLICY completion_requests_update ON public.completion_requests FOR UPDATE TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
        app_private.has_approved_role(ARRAY['ops']) OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))))
    WITH CHECK (app_private.can_read_project(project_id) AND (
        app_private.has_approved_role(ARRAY['ops']) OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))));

CREATE OR REPLACE FUNCTION app_private.guard_completion_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
    SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
    IF actor.status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'Approved identity required' USING ERRCODE='42501'; END IF;
    IF TG_OP='INSERT' THEN
        IF actor.role<>'pm' OR NEW.owner_id<>auth.uid() OR NEW.status<>'pending' THEN
            RAISE EXCEPTION 'Only owner may request completion' USING ERRCODE='42501';
        END IF;
        NEW.owner_name:=actor.name;
        NEW.revision:=1; NEW.history:='[]'::jsonb; NEW.created_at:=now();
        NEW.review_note:=''; NEW.reviewer_id:=NULL; NEW.reviewer_name:=NULL; NEW.reviewed_at:=NULL; NEW.approved_at:=NULL;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_key IS DISTINCT FROM OLD.source_key
          OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.owner_name IS DISTINCT FROM OLD.owner_name
          OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
          OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.history IS DISTINCT FROM OLD.history
          OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.reviewer_name IS DISTINCT FROM OLD.reviewer_name
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
            RAISE EXCEPTION 'Completion identity and audit fields are immutable' USING ERRCODE='42501';
        END IF;
        IF actor.role='pm' AND OLD.owner_id=auth.uid() THEN
            IF OLD.status='pending' AND NEW.status='withdrawn' THEN
                IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
                    RAISE EXCEPTION 'Withdrawal may not rewrite the request' USING ERRCODE='42501';
                END IF;
            ELSIF OLD.status IN ('rejected','withdrawn','reopened') AND NEW.status='pending' THEN
                NEW.review_note:=''; NEW.reviewer_id:=NULL; NEW.reviewer_name:=NULL; NEW.reviewed_at:=NULL; NEW.approved_at:=NULL;
            ELSE RAISE EXCEPTION 'Invalid applicant transition' USING ERRCODE='42501';
            END IF;
        ELSIF actor.role='ops' THEN
            IF NOT ((OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR (OLD.status='approved' AND NEW.status='reopened')) THEN
                RAISE EXCEPTION 'Invalid review transition' USING ERRCODE='42501';
            END IF;
            IF (to_jsonb(NEW)-ARRAY['status','review_note']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','review_note']) THEN
                RAISE EXCEPTION 'Reviewer may not rewrite applicant evidence' USING ERRCODE='42501';
            END IF;
            IF NEW.status IN ('rejected','reopened') AND btrim(NEW.review_note)='' THEN
                RAISE EXCEPTION 'Rejection and reopening require a reason' USING ERRCODE='23514';
            END IF;
            NEW.reviewer_id:=auth.uid(); NEW.reviewer_name:=actor.name; NEW.reviewed_at:=now();
            IF NEW.status='approved' THEN NEW.approved_at:=now(); ELSE NEW.approved_at:=NULL; END IF;
        ELSE RAISE EXCEPTION 'Completion review denied' USING ERRCODE='42501';
        END IF;
        NEW.revision:=OLD.revision+1;
        NEW.history:=OLD.history || jsonb_build_array(jsonb_build_object('at',now(),'by',auth.uid(),'data',to_jsonb(OLD)-'history'));
    END IF;
    NEW.updated_at:=now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_completion_request() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_completion_request ON public.completion_requests;
CREATE TRIGGER guard_completion_request BEFORE INSERT OR UPDATE ON public.completion_requests
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_completion_request();

-- The existing meeting table is owner-only. Leaders may inspect only a meeting
-- that has an existing completion request within their current project scope.
CREATE OR REPLACE FUNCTION app_private.completion_meeting_source(target_project_id text,target_task_id uuid,target_owner_id text)
RETURNS TABLE(id uuid,project_id text,owner_id text,owner_name text,title text,what text,due text,status text,progress text,rich_text jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT t.id,t.project_id,t.owner_id,t.owner_name,t.title,t.what,t.due::text,t.status,t.progress,t.rich_text
    FROM public.reporter_tasks t
    WHERE t.id=target_task_id AND t.project_id=target_project_id AND t.owner_id=target_owner_id
      AND app_private.has_approved_role(ARRAY['ops','president','pzo'])
      AND app_private.can_read_project(target_project_id)
      AND EXISTS(SELECT 1 FROM public.profiles p JOIN public.project_members m ON m.user_id=p.user_id
          WHERE p.user_id=target_owner_id AND p.role='pm' AND p.status='approved' AND m.project_id=target_project_id)
      AND EXISTS(SELECT 1 FROM public.completion_requests r WHERE r.owner_id=target_owner_id AND r.project_id=target_project_id
          AND r.source_key='meeting:'||target_project_id||':'||target_task_id::text);
$$;

CREATE OR REPLACE FUNCTION app_private.completion_node_has_approved(target_project_id text,target_source_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT app_private.has_approved_role(ARRAY['pm','ops','president','pzo']) AND app_private.can_read_project(target_project_id)
      AND EXISTS(SELECT 1 FROM public.completion_requests r WHERE r.project_id=target_project_id AND r.kind='milestone'
          AND r.source_key=target_source_key AND r.status='approved');
$$;

-- Approval freezes the original source until COMMIT. This narrow helper is
-- needed because reports' normal UPDATE policy correctly excludes ops.
CREATE OR REPLACE FUNCTION app_private.lock_completion_source(target_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item public.completion_requests%ROWTYPE;
BEGIN
    SELECT * INTO item FROM public.completion_requests WHERE id=target_request_id;
    IF NOT FOUND OR NOT app_private.has_approved_role(ARRAY['ops']) OR NOT app_private.can_read_project(item.project_id) THEN
        RAISE EXCEPTION 'Completion source lock denied' USING ERRCODE='42501';
    END IF;
    IF item.kind='milestone' THEN
        PERFORM 1 FROM public.milestones WHERE id=item.source_id::bigint AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='leader' THEN
        PERFORM 1 FROM public.leader_notes WHERE id=item.source_id::uuid AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='meeting' THEN
        PERFORM 1 FROM public.reporter_tasks WHERE id=item.source_id::uuid AND project_id=item.project_id AND owner_id=item.owner_id FOR SHARE;
    ELSE
        PERFORM 1 FROM public.reports WHERE id=item.report_id AND project_id=item.project_id FOR SHARE;
    END IF;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app_private.completion_meeting_source(text,uuid,text),
    app_private.completion_node_has_approved(text,text),app_private.lock_completion_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.completion_meeting_source(text,uuid,text),
    app_private.completion_node_has_approved(text,text),app_private.lock_completion_source(uuid) TO app_runtime;
COMMIT;
