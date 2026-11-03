-- Coordination report items are confirmed by the originating reporter. Other
-- source families, including handovers, retain operator review. No approvals or
-- business rows are rewritten by this upgrade.
BEGIN;
CREATE OR REPLACE FUNCTION app_private.is_initiator_coordination(
    target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
    -- Classify before checking the binding. A missing/corrupted report link
    -- must never turn a coordination item back into operator review.
    SELECT COALESCE(target_kind='coord'
      AND array_length(string_to_array(target_key,':'),1)=5
      AND split_part(target_key,':',1)='coord'
      AND split_part(target_key,':',4)='coord',false);
$$;

CREATE OR REPLACE FUNCTION app_private.can_review_completion(
    target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT app_private.can_read_project(target_project_id) AND CASE
      WHEN app_private.is_initiator_coordination(target_kind,target_key,target_project_id,target_report_id)
        THEN app_private.has_approved_role(ARRAY['pm'])
          AND split_part(target_key,':',2)=target_project_id
          AND split_part(target_key,':',3)=target_report_id::text
          AND length(split_part(target_key,':',5))>0
          AND EXISTS(SELECT 1 FROM public.reports r WHERE r.id=target_report_id
            AND r.project_id=target_project_id AND r.author_id=auth.uid())
      ELSE app_private.has_approved_role(ARRAY['ops']) END;
$$;
REVOKE ALL ON FUNCTION app_private.is_initiator_coordination(text,text,text,bigint),
    app_private.can_review_completion(text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_initiator_coordination(text,text,text,bigint),
    app_private.can_review_completion(text,text,text,bigint) TO app_runtime;

DROP POLICY IF EXISTS completion_requests_read ON public.completion_requests;
CREATE POLICY completion_requests_read ON public.completion_requests FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
      app_private.has_approved_role(ARRAY['ops','president','pzo'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)));
DROP POLICY IF EXISTS completion_requests_update ON public.completion_requests;
CREATE POLICY completion_requests_update ON public.completion_requests FOR UPDATE TO app_runtime
    USING (app_private.can_read_project(project_id) AND (
      (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)))
    WITH CHECK (app_private.can_read_project(project_id) AND (
      (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)));

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
        IF actor.role='pm' AND OLD.owner_id=auth.uid() AND (
          (OLD.status='pending' AND NEW.status='withdrawn') OR
          (OLD.status IN ('rejected','withdrawn','reopened') AND NEW.status='pending')) THEN
            IF OLD.status='pending' THEN
                IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
                    RAISE EXCEPTION 'Withdrawal may not rewrite the request' USING ERRCODE='42501';
                END IF;
            ELSE
                NEW.review_note:=''; NEW.reviewer_id:=NULL; NEW.reviewer_name:=NULL; NEW.reviewed_at:=NULL; NEW.approved_at:=NULL;
            END IF;
        ELSIF app_private.can_review_completion(OLD.kind,OLD.source_key,OLD.project_id,OLD.report_id) THEN
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

-- The caller's exact authority is checked before a protected source lock. The
-- helper grants no general reporter ability to update another reporter's data.
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
    ELSE
        PERFORM 1 FROM public.reports WHERE id=item.report_id AND project_id=item.project_id FOR SHARE;
    END IF;
    RETURN FOUND;
END;
$$;
COMMIT;
