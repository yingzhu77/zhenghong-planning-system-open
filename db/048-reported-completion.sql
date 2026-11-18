BEGIN;

-- Existing request and extension guards run first. The server can mark a new
-- completion from a saved report in the same transaction as the normal insert.
CREATE OR REPLACE FUNCTION app_private.stamp_reported_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE feedback jsonb := NEW.source_snapshot->'completion_feedback';
BEGIN
    IF feedback IS NULL THEN RETURN NEW; END IF;
    IF current_setting('app.reported_completion',true) IS DISTINCT FROM feedback->>'report_id'
        OR NEW.owner_id IS DISTINCT FROM auth.uid() OR NEW.request_type<>'completion'
        OR NEW.status<>'pending' OR NEW.completion_date>(now() AT TIME ZONE 'Asia/Shanghai')::date
        OR NOT EXISTS (
          SELECT 1 FROM public.reports r WHERE r.id::text=feedback->>'report_id'
            AND (r.author_id=NEW.owner_id OR r.biz->'followups' @> jsonb_build_array(jsonb_build_object(
                'owner_id',NEW.owner_id,'source_key',NEW.source_key,'progress',feedback->>'progress')))
        ) THEN
        RAISE EXCEPTION 'Invalid submitted feedback for automatic completion' USING ERRCODE='42501';
    END IF;
    IF feedback ? 'report_revision' AND NOT EXISTS (
      SELECT 1 FROM public.reports WHERE id::text=feedback->>'report_id' AND updated_at::text=feedback->>'report_revision'
    ) THEN
      RAISE EXCEPTION 'Submitted feedback has changed' USING ERRCODE='P4801';
    END IF;
    NEW.status:='approved';
    NEW.reviewer_name:='系统识别';
    NEW.reviewed_at:=now();
    NEW.approved_at:=now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS stamp_reported_completion ON public.completion_requests;
CREATE TRIGGER stamp_reported_completion BEFORE INSERT ON public.completion_requests
    FOR EACH ROW EXECUTE FUNCTION app_private.stamp_reported_completion();
REVOKE ALL ON FUNCTION app_private.stamp_reported_completion() FROM PUBLIC;

CREATE INDEX IF NOT EXISTS completion_feedback_report_active ON public.completion_requests
  ((source_snapshot->'completion_feedback'->>'report_id'))
  WHERE status='approved' AND source_snapshot ? 'completion_feedback';

CREATE OR REPLACE FUNCTION app_private.report_has_automatic_completion(target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.reports r JOIN public.completion_requests c
      ON c.source_snapshot->'completion_feedback'->>'report_id'=r.id::text
    WHERE r.id=target_report_id AND r.author_id=auth.uid() AND c.status='approved' AND c.source_snapshot ? 'completion_feedback'
  );
$$;
REVOKE ALL ON FUNCTION app_private.report_has_automatic_completion(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.report_has_automatic_completion(bigint) TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.guard_reported_completion_withdrawal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF app_private.report_has_automatic_completion(OLD.id) THEN
    RAISE EXCEPTION '报告已有自动销项记录' USING ERRCODE='P4402';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS guard_reported_completion_withdrawal ON public.reports;
CREATE TRIGGER guard_reported_completion_withdrawal BEFORE DELETE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_reported_completion_withdrawal();
REVOKE ALL ON FUNCTION app_private.guard_reported_completion_withdrawal() FROM PUBLIC;

COMMIT;
