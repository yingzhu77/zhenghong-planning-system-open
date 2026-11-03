-- Keep every extension as a separate review record. Approving an extension
-- changes the execution deadline only; original source dates remain untouched.
BEGIN;
ALTER TABLE public.completion_requests ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'completion';
ALTER TABLE public.completion_requests ADD COLUMN IF NOT EXISTS requested_due date;
ALTER TABLE public.completion_requests ADD COLUMN IF NOT EXISTS effective_due text;
ALTER TABLE public.completion_requests ALTER COLUMN completion_date DROP NOT NULL;
ALTER TABLE public.completion_requests DROP CONSTRAINT IF EXISTS completion_requests_source_key_owner_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS completion_requests_one_completion
    ON public.completion_requests(source_key,owner_id) WHERE request_type='completion';
CREATE UNIQUE INDEX IF NOT EXISTS completion_requests_one_pending
    ON public.completion_requests(source_key,owner_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS completion_requests_extension_deadline
    ON public.completion_requests(owner_id,source_key,approved_at DESC,id DESC)
    WHERE request_type='extension' AND status='approved';

CREATE OR REPLACE FUNCTION app_private.guard_completion_extension()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior_deadline text;
BEGIN
    IF NEW.request_type NOT IN ('completion','extension') THEN
        RAISE EXCEPTION 'Unknown request type' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND NEW.request_type IS DISTINCT FROM OLD.request_type THEN
        RAISE EXCEPTION 'Request type is immutable' USING ERRCODE='42501';
    END IF;
    IF NEW.request_type='extension' THEN
        IF NEW.completion_date IS NOT NULL OR NEW.requested_due IS NULL THEN
            RAISE EXCEPTION 'Extension requires a deadline, not a completion date' USING ERRCODE='23514';
        END IF;
        IF NEW.status='reopened' THEN
            RAISE EXCEPTION 'An approved extension is historical; submit another extension instead' USING ERRCODE='42501';
        END IF;
    ELSIF NEW.completion_date IS NULL OR NEW.requested_due IS NOT NULL THEN
        RAISE EXCEPTION 'Completion requires an actual date, not an extension date' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.status IN ('rejected','withdrawn','reopened') AND NEW.status='pending') THEN
        -- Cosmetic/progress updates do not remove an approved deadline. A
        -- changed requirement or original date requires a fresh approval.
        SELECT r.requested_due::text INTO prior_deadline
        FROM public.completion_requests r
        WHERE r.source_key=NEW.source_key AND r.owner_id=NEW.owner_id
          AND r.request_type='extension' AND r.status='approved'
          AND r.due=NEW.due AND r.title=NEW.title AND r.what=NEW.what
          AND (r.source_snapshot->>'who_id') IS NOT DISTINCT FROM (NEW.source_snapshot->>'who_id')
        ORDER BY r.approved_at DESC,r.id DESC LIMIT 1;
        NEW.effective_due:=COALESCE(prior_deadline,NEW.due);
        IF NEW.request_type='extension' AND NEW.effective_due ~ '^\d{4}-\d{2}-\d{2}$'
          AND NEW.requested_due::text<=NEW.effective_due THEN
            RAISE EXCEPTION 'An extension must be later than the current execution deadline' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_completion_extension() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_completion_extension ON public.completion_requests;
CREATE TRIGGER guard_completion_extension BEFORE INSERT OR UPDATE ON public.completion_requests
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_completion_extension();

CREATE OR REPLACE FUNCTION app_private.completion_node_has_approved(target_project_id text,target_source_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT app_private.has_approved_role(ARRAY['pm','ops','president','pzo']) AND app_private.can_read_project(target_project_id)
      AND EXISTS(SELECT 1 FROM public.completion_requests r WHERE r.project_id=target_project_id AND r.kind='milestone'
          AND r.source_key=target_source_key AND r.status='approved' AND r.request_type='completion');
$$;
REVOKE ALL ON FUNCTION app_private.completion_node_has_approved(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.completion_node_has_approved(text,text) TO app_runtime;
COMMIT;
