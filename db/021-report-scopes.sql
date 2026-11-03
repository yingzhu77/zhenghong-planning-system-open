-- Only new unified reports use scope identity. Original project rows, reports,
-- authors, versions, sources and attachment links are not migrated.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.report_scopes (
  id text PRIMARY KEY,
  name text NOT NULL,
  anchor_project_id text NOT NULL,
  project_ids text[] NOT NULL CHECK(cardinality(project_ids)>1 AND anchor_project_id=ANY(project_ids)),
  effective_week date NOT NULL CHECK(extract(isodow FROM effective_week)=1)
);
REVOKE ALL ON app_private.report_scopes FROM PUBLIC,app_runtime;
GRANT SELECT ON app_private.report_scopes TO app_runtime;
INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week)
VALUES('zhenghongxu-residential','正弘序','zhx1',ARRAY['zhx1','zhx2','klq'],'2026-10-19') ON CONFLICT DO NOTHING;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_scope_id text REFERENCES app_private.report_scopes(id);
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS scope_project_ids text[];
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS scope_week date;
CREATE UNIQUE INDEX IF NOT EXISTS reports_scope_week_unique ON public.reports(report_scope_id,scope_week) WHERE report_scope_id IS NOT NULL;
ALTER TABLE public.report_attachments ADD COLUMN IF NOT EXISTS report_scope_id text REFERENCES app_private.report_scopes(id);
ALTER TABLE public.report_attachments ADD COLUMN IF NOT EXISTS scope_project_ids text[];
ALTER TABLE public.report_attachments ADD COLUMN IF NOT EXISTS scope_week date;
CREATE OR REPLACE FUNCTION app_private.report_week_start(label text,reference_at timestamptz)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE ref date:=(reference_at AT TIME ZONE 'Asia/Shanghai')::date; parts text[]; wn text[];
    y integer; candidate date; best date; distance integer:=2147483647;
BEGIN
    IF label IS NULL OR ref IS NULL THEN RETURN NULL; END IF;
    parts:=regexp_match(label,'([0-9]{4})[-./]([0-9]{2})[-./]([0-9]{2})');
    IF parts IS NOT NULL THEN
        BEGIN candidate:=make_date(parts[1]::integer,parts[2]::integer,parts[3]::integer);
        EXCEPTION WHEN datetime_field_overflow THEN RETURN NULL; END;
        candidate:=candidate-(extract(isodow FROM candidate)::integer-1);
        RETURN candidate;
    END IF;
    parts:=regexp_match(label,'[（(] *([0-9]{1,2})[./]([0-9]{1,2}) *[–—~～至-]');
    wn:=regexp_match(label,'第 *([0-9]{1,2}) *周');
    IF parts IS NULL AND (wn IS NULL OR wn[1]::integer NOT BETWEEN 1 AND 53) THEN RETURN NULL; END IF;
    FOR y IN extract(year FROM ref)::integer-2..extract(year FROM ref)::integer+2 LOOP
        BEGIN
            IF parts IS NOT NULL THEN candidate:=make_date(y,parts[1]::integer,parts[2]::integer);
            ELSE candidate:=to_date(y::text||lpad(wn[1],2,'0')||'1','IYYYIWID'); END IF;
        EXCEPTION WHEN datetime_field_overflow THEN CONTINUE; END;
        IF extract(isodow FROM candidate)<>1 OR (wn IS NOT NULL AND extract(week FROM candidate)<>wn[1]::integer)
          OR (parts IS NULL AND extract(isoyear FROM candidate)<>y) THEN CONTINUE; END IF;
        IF abs(candidate-ref)<distance THEN best:=candidate; distance:=abs(candidate-ref); END IF;
    END LOOP;
    RETURN best;
END;
$$;

REVOKE ALL ON FUNCTION app_private.report_week_start(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.report_week_start(text,timestamptz) TO app_runtime;
CREATE OR REPLACE FUNCTION app_private.can_read_report_scope(ids text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT ids IS NOT NULL AND cardinality(ids)>1 AND NOT EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT app_private.can_read_project(p));
$$;
REVOKE ALL ON FUNCTION app_private.can_read_report_scope(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_read_report_scope(text[]) TO app_runtime;
DROP POLICY IF EXISTS reports_read ON public.reports;
CREATE POLICY reports_read ON public.reports FOR SELECT TO app_runtime USING(
  CASE WHEN report_scope_id IS NULL THEN app_private.can_read_project(project_id)
  ELSE app_private.can_read_report_scope(scope_project_ids) END);
DROP POLICY IF EXISTS reports_insert ON public.reports;
CREATE POLICY reports_insert ON public.reports FOR INSERT TO app_runtime WITH CHECK(
  app_private.can_write_report(project_id,line,author_id) AND (report_scope_id IS NULL OR app_private.can_read_report_scope(scope_project_ids)));
DROP POLICY IF EXISTS reports_update ON public.reports;
CREATE POLICY reports_update ON public.reports FOR UPDATE TO app_runtime
 USING(app_private.can_write_report(project_id,line,author_id) AND (report_scope_id IS NULL OR app_private.can_read_report_scope(scope_project_ids)))
 WITH CHECK(app_private.can_write_report(project_id,line,author_id) AND (report_scope_id IS NULL OR app_private.can_read_report_scope(scope_project_ids)));
CREATE OR REPLACE FUNCTION app_private.guard_report_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope app_private.report_scopes%ROWTYPE; week date; old_report boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.report_scope_id IS DISTINCT FROM OLD.report_scope_id OR NEW.scope_project_ids IS DISTINCT FROM OLD.scope_project_ids OR NEW.scope_week IS DISTINCT FROM OLD.scope_week) THEN
    RAISE EXCEPTION 'Report scope identity cannot be rewritten' USING ERRCODE='42501';
  END IF;
  IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
  SELECT s.* INTO scope FROM app_private.report_scopes s WHERE CASE WHEN NEW.report_scope_id IS NULL THEN NEW.project_id=ANY(s.project_ids) ELSE s.id=NEW.report_scope_id END;
  IF NOT FOUND THEN
    IF NEW.report_scope_id IS NOT NULL OR NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL THEN RAISE EXCEPTION 'Unknown report scope' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  week:=app_private.report_week_start(NEW.period,NEW.submitted_at);
  IF week IS NULL OR week<scope.effective_week THEN
    IF week IS NULL AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line AND r.report_scope_id IS NULL) THEN
      RAISE EXCEPTION 'Unified report requires a recognizable reporting week' USING ERRCODE='23514';
    END IF;
    IF NEW.report_scope_id IS NOT NULL THEN RAISE EXCEPTION 'Report scope period not active' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('report-scope:'||scope.id||':'||week::text,0));
  SELECT EXISTS(SELECT 1 FROM public.reports r WHERE r.project_id=ANY(scope.project_ids) AND r.report_scope_id IS NULL AND app_private.report_week_start(r.period,r.submitted_at)=week) INTO old_report;
  IF NEW.report_scope_id IS NULL THEN
    IF NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL OR NOT old_report THEN RAISE EXCEPTION 'Use unified residential report scope' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF old_report OR NEW.project_id<>scope.anchor_project_id OR NEW.line<>'综合' OR NEW.scope_project_ids IS DISTINCT FROM scope.project_ids OR NEW.scope_week IS DISTINCT FROM week OR NOT app_private.can_read_report_scope(scope.project_ids) THEN
    RAISE EXCEPTION 'Report scope mismatch or denied' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_report_scope() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_report_scope ON public.reports;
CREATE TRIGGER guard_report_scope BEFORE INSERT OR UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION app_private.guard_report_scope();
DROP POLICY IF EXISTS report_attachments_read ON public.report_attachments;
CREATE POLICY report_attachments_read ON public.report_attachments FOR SELECT TO app_runtime USING(
  (CASE WHEN report_scope_id IS NULL THEN app_private.can_read_project(project_id) ELSE app_private.can_read_report_scope(scope_project_ids) END)
  AND ((owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm'])) OR EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=report_attachments.id)));
DROP POLICY IF EXISTS report_attachments_insert ON public.report_attachments;
CREATE POLICY report_attachments_insert ON public.report_attachments FOR INSERT TO app_runtime WITH CHECK(
  owner_id=auth.uid() AND app_private.can_write_report(project_id,line,owner_id) AND (report_scope_id IS NULL OR app_private.can_read_report_scope(scope_project_ids)));
CREATE OR REPLACE FUNCTION app_private.guard_attachment_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope app_private.report_scopes%ROWTYPE;
BEGIN
  IF NEW.report_scope_id IS NULL THEN
    IF NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL THEN RAISE EXCEPTION 'Attachment scope mismatch' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO scope FROM app_private.report_scopes WHERE id=NEW.report_scope_id;
  IF NOT FOUND OR NOT NEW.project_id=ANY(scope.project_ids) OR NEW.line<>'综合' OR NEW.scope_project_ids IS DISTINCT FROM scope.project_ids OR NEW.scope_week IS DISTINCT FROM app_private.report_week_start(NEW.period,NEW.created_at) OR NEW.scope_week<scope.effective_week THEN RAISE EXCEPTION 'Attachment scope mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_attachment_scope() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_attachment_scope ON public.report_attachments;
CREATE TRIGGER guard_attachment_scope BEFORE INSERT ON public.report_attachments FOR EACH ROW EXECUTE FUNCTION app_private.guard_attachment_scope();
CREATE OR REPLACE FUNCTION app_private.bind_report_attachments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ids uuid[]; actual_count integer; total_bytes bigint;
BEGIN
    IF NEW.biz IS NULL OR NOT (NEW.biz ? 'attachments') THEN RETURN NEW; END IF;
    IF jsonb_typeof(NEW.biz->'attachments') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.biz->'attachments') > 20 THEN
        RAISE EXCEPTION 'Report attachment list is invalid or exceeds 20 files' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.biz->'attachments') item
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
          OR (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'Report attachment identifier is invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(array_agg(item::uuid),'{}'::uuid[]) INTO ids
      FROM jsonb_array_elements_text(NEW.biz->'attachments') item;
    IF cardinality(ids) <> (SELECT count(DISTINCT item) FROM unnest(ids) item) THEN
        RAISE EXCEPTION 'Repeated report attachment identifier' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM public.report_attachments a WHERE a.id=ANY(ids) FOR SHARE;
    SELECT count(*),COALESCE(sum(size),0) INTO actual_count,total_bytes
      FROM public.report_attachments a WHERE a.id=ANY(ids) AND ((NEW.report_scope_id IS NULL AND a.project_id=NEW.project_id) OR (NEW.report_scope_id IS NOT NULL AND a.project_id=ANY(NEW.scope_project_ids))) AND a.report_scope_id IS NOT DISTINCT FROM NEW.report_scope_id AND a.scope_project_ids IS NOT DISTINCT FROM NEW.scope_project_ids
        AND a.period=NEW.period AND a.line=NEW.line AND a.owner_id=NEW.author_id;
    IF actual_count <> cardinality(ids) THEN
        RAISE EXCEPTION 'Report attachment is missing or belongs to another report scope' USING ERRCODE='42501';
    END IF;
    IF total_bytes > 41943040 THEN
        RAISE EXCEPTION 'Report attachments exceed 40 MiB' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.report_attachment_links(report_id,attachment_id,project_id)
      SELECT NEW.id,item,NEW.project_id FROM unnest(ids) item ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
-- Explicit recovery recognizes a lost non-anchor group permission too.
-- Submitted/history-linked files stay protected; no automatic cleanup runs.
CREATE OR REPLACE FUNCTION app_private.discard_inaccessible_report_drafts()
RETURNS TABLE(attachment_id uuid,storage_key text,freed_size integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate public.report_attachments%ROWTYPE;
BEGIN
    IF NOT app_private.has_approved_role(ARRAY['pm']) THEN
        RAISE EXCEPTION 'Only approved reporters may discard inaccessible drafts' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('report-attachment-drafts:' || auth.uid(),0));
    FOR candidate IN SELECT a.* FROM public.report_attachments a
      WHERE a.owner_id=auth.uid() AND NOT (CASE WHEN a.report_scope_id IS NULL THEN app_private.can_read_project(a.project_id) ELSE app_private.can_read_report_scope(a.scope_project_ids) END)
        AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=a.id)
      ORDER BY a.id FOR UPDATE
    LOOP
        -- A waiting row lock may have allowed a report to commit its reference;
        -- recheck both eligibility predicates after the exclusive lock is held.
        IF NOT (CASE WHEN candidate.report_scope_id IS NULL THEN app_private.can_read_project(candidate.project_id) ELSE app_private.can_read_report_scope(candidate.scope_project_ids) END)
           AND NOT EXISTS(SELECT 1 FROM public.report_attachment_links l WHERE l.attachment_id=candidate.id) THEN
            DELETE FROM public.report_attachments a WHERE a.id=candidate.id;
            attachment_id := candidate.id; storage_key := candidate.storage_key; freed_size := candidate.size;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app_private.discard_inaccessible_report_drafts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.discard_inaccessible_report_drafts() TO app_runtime;

-- Approval snapshots from a unified report carry the same complete-project
-- access requirement as the original report; the original source keys remain.
CREATE OR REPLACE FUNCTION app_private.can_read_completion_report(target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT target_report_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.reports r WHERE r.id=target_report_id AND r.report_scope_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.reports r WHERE r.id=target_report_id AND r.report_scope_id IS NOT NULL AND app_private.can_read_report_scope(r.scope_project_ids));
$$;
REVOKE ALL ON FUNCTION app_private.can_read_completion_report(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_read_completion_report(bigint) TO app_runtime;
CREATE OR REPLACE FUNCTION app_private.can_review_completion(
    target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT app_private.can_read_project(target_project_id) AND app_private.can_read_completion_report(target_report_id) AND CASE
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
DROP POLICY IF EXISTS completion_requests_read ON public.completion_requests;
CREATE POLICY completion_requests_read ON public.completion_requests FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND (
      app_private.has_approved_role(ARRAY['ops','president','pzo'])
      OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)));
DROP POLICY IF EXISTS completion_requests_update ON public.completion_requests;
CREATE POLICY completion_requests_update ON public.completion_requests FOR UPDATE TO app_runtime
    USING (app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND (
      (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)))
    WITH CHECK (app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND (
      (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
      OR app_private.can_review_completion(kind,source_key,project_id,report_id)));

DROP POLICY IF EXISTS completion_requests_insert ON public.completion_requests;
CREATE POLICY completion_requests_insert ON public.completion_requests FOR INSERT TO app_runtime
 WITH CHECK(owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id));
COMMIT;
