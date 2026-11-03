-- Completion and review formatting accompanies the existing plain evidence.
-- Existing requests, histories, source versions and extension deadlines stay intact.
BEGIN;
ALTER TABLE public.completion_requests ADD COLUMN IF NOT EXISTS rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rich_text)='object');

CREATE OR REPLACE FUNCTION app_private.guard_completion_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
    SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
    IF actor.status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'Approved identity required' USING ERRCODE='42501'; END IF;
    IF NEW.rich_text<>'{}'::jsonb AND (
      jsonb_typeof(NEW.rich_text) IS DISTINCT FROM 'object'
      OR NEW.rich_text->'v' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(NEW.rich_text->'fields') IS DISTINCT FROM 'object'
      OR (NEW.rich_text-ARRAY['v','fields'])<>'{}'::jsonb) THEN
        RAISE EXCEPTION 'Invalid completion formatting envelope' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(NEW.rich_text->'fields','{}'::jsonb)) field
      WHERE field NOT IN ('completion_note','review_note')) THEN
        RAISE EXCEPTION 'Only completion and review note formatting is allowed' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' THEN
        IF actor.role<>'pm' OR NEW.owner_id<>auth.uid() OR NEW.status<>'pending' THEN
            RAISE EXCEPTION 'Only owner may request completion' USING ERRCODE='42501';
        END IF;
        NEW.owner_name:=actor.name;
        NEW.revision:=1; NEW.history:='[]'::jsonb; NEW.created_at:=now();
        NEW.review_note:=''; NEW.reviewer_id:=NULL; NEW.reviewer_name:=NULL; NEW.reviewed_at:=NULL; NEW.approved_at:=NULL;
        IF NEW.rich_text ? 'fields' THEN NEW.rich_text:=jsonb_set(NEW.rich_text,'{fields}',(NEW.rich_text->'fields')-'review_note'); END IF;
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
                IF NEW.rich_text ? 'fields' THEN NEW.rich_text:=jsonb_set(NEW.rich_text,'{fields}',(NEW.rich_text->'fields')-'review_note'); END IF;
            END IF;
        ELSIF app_private.can_review_completion(OLD.kind,OLD.source_key,OLD.project_id,OLD.report_id) THEN
            IF NOT ((OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR (OLD.status='approved' AND NEW.status='reopened')) THEN
                RAISE EXCEPTION 'Invalid review transition' USING ERRCODE='42501';
            END IF;
            IF (to_jsonb(NEW)-ARRAY['status','review_note','rich_text']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','review_note','rich_text'])
              OR (COALESCE(NEW.rich_text->'fields','{}'::jsonb)-'review_note') IS DISTINCT FROM (COALESCE(OLD.rich_text->'fields','{}'::jsonb)-'review_note') THEN
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
COMMIT;
