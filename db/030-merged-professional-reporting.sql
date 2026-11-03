-- Merge residential reporting entrances while keeping original project records,
-- authors, reports, plans, attachments and personal memory unchanged.
BEGIN;
ALTER TABLE app_private.report_scopes ADD COLUMN IF NOT EXISTS reporting_mode text NOT NULL DEFAULT 'comprehensive';
ALTER TABLE app_private.report_scopes DROP CONSTRAINT IF EXISTS report_scopes_reporting_mode_check;
ALTER TABLE app_private.report_scopes ADD CONSTRAINT report_scopes_reporting_mode_check
 CHECK(reporting_mode=ANY(ARRAY['comprehensive','professional']));
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM app_private.report_scopes WHERE id='zhenghongxu-residential'
   AND (anchor_project_id<>'zhx1' OR project_ids<>ARRAY['zhx1','zhx2','klq'])) THEN
  RAISE EXCEPTION 'Existing residential scope configuration requires review'; END IF;
END;
$$;
UPDATE app_private.report_scopes SET reporting_mode='professional' WHERE id='zhenghongxu-residential' AND reporting_mode<>'professional';
INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week,reporting_mode)
VALUES('xinyang-residential','信阳','xy7',ARRAY['xy7','xy8'],'2026-10-12','professional') ON CONFLICT DO NOTHING;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.report_scopes WHERE id='xinyang-residential'
   AND anchor_project_id='xy7' AND project_ids=ARRAY['xy7','xy8'] AND reporting_mode='professional') THEN
  RAISE EXCEPTION 'Existing Xinyang scope configuration requires review'; END IF;
END;
$$;
DROP INDEX IF EXISTS public.reports_scope_week_unique;
CREATE UNIQUE INDEX IF NOT EXISTS reports_scope_week_line_unique
 ON public.reports(report_scope_id,scope_week,line) WHERE report_scope_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.guard_report_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope app_private.report_scopes%ROWTYPE; week date; old_report boolean; previous public.reports%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.report_scope_id IS DISTINCT FROM OLD.report_scope_id OR NEW.scope_project_ids IS DISTINCT FROM OLD.scope_project_ids OR NEW.scope_week IS DISTINCT FROM OLD.scope_week) THEN
  RAISE EXCEPTION 'Report scope identity cannot be rewritten' USING ERRCODE='42501'; END IF;
 IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
 SELECT s.* INTO scope FROM app_private.report_scopes s WHERE CASE WHEN NEW.report_scope_id IS NULL THEN NEW.project_id=ANY(s.project_ids) ELSE s.id=NEW.report_scope_id END;
 IF NOT FOUND THEN
  IF NEW.report_scope_id IS NOT NULL OR NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL THEN RAISE EXCEPTION 'Unknown report scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 week:=app_private.report_week_start(NEW.period,NEW.submitted_at);
 IF scope.reporting_mode='professional' THEN
  SELECT * INTO previous FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line;
  IF NEW.report_scope_id IS NULL THEN
   IF NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL OR (TG_OP='INSERT' AND NOT FOUND) THEN
    RAISE EXCEPTION 'Use merged residential professional reporting' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  IF week IS NULL OR NEW.project_id<>scope.anchor_project_id OR NEW.scope_project_ids IS DISTINCT FROM scope.project_ids
    OR NEW.scope_week IS DISTINCT FROM week OR NOT app_private.can_read_report_scope(scope.project_ids) THEN
   RAISE EXCEPTION 'Professional report scope mismatch or denied' USING ERRCODE='42501'; END IF;
  IF NEW.line='综合' THEN
   IF previous.id IS NULL OR previous.report_scope_id IS DISTINCT FROM NEW.report_scope_id OR previous.author_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'New merged reports require the caller professional discipline' USING ERRCODE='42501'; END IF;
  ELSIF NOT app_private.can_write_report(NEW.project_id,NEW.line,NEW.author_id) OR NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.discipline=NEW.line) THEN
   RAISE EXCEPTION 'Professional report discipline denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('report-scope:'||scope.id||':'||week::text||':'||NEW.line,0));
  RETURN NEW;
 END IF;
 -- Other configured scopes retain their original comprehensive contract.
 IF week IS NULL OR week<scope.effective_week THEN
  IF week IS NULL AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line AND r.report_scope_id IS NULL) THEN
   RAISE EXCEPTION 'Unified report requires a recognizable reporting week' USING ERRCODE='23514'; END IF;
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
  RAISE EXCEPTION 'Report scope mismatch or denied' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.guard_attachment_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE scope app_private.report_scopes%ROWTYPE; week date;
BEGIN
 IF NEW.report_scope_id IS NULL THEN
  IF NEW.scope_project_ids IS NOT NULL OR NEW.scope_week IS NOT NULL THEN RAISE EXCEPTION 'Attachment scope mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO scope FROM app_private.report_scopes WHERE id=NEW.report_scope_id;
 week:=app_private.report_week_start(NEW.period,NEW.created_at);
 IF NOT FOUND OR NOT NEW.project_id=ANY(scope.project_ids) OR NEW.scope_project_ids IS DISTINCT FROM scope.project_ids OR NEW.scope_week IS DISTINCT FROM week THEN
  RAISE EXCEPTION 'Attachment scope mismatch' USING ERRCODE='23514'; END IF;
 IF scope.reporting_mode='professional' THEN
  IF week IS NULL OR NEW.project_id<>scope.anchor_project_id OR NOT app_private.can_read_report_scope(scope.project_ids) OR NOT app_private.can_write_report(NEW.project_id,NEW.line,NEW.owner_id) THEN
   RAISE EXCEPTION 'Professional attachment scope denied' USING ERRCODE='42501'; END IF;
  IF NEW.line='综合' THEN
   IF NOT EXISTS(SELECT 1 FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line
     AND r.report_scope_id=NEW.report_scope_id AND r.author_id=auth.uid()) THEN
    RAISE EXCEPTION 'New merged attachments require the caller professional discipline' USING ERRCODE='42501'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.discipline=NEW.line) THEN
   RAISE EXCEPTION 'Professional attachment discipline denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.line<>'综合' OR NEW.scope_week<scope.effective_week THEN
  RAISE EXCEPTION 'Attachment scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

-- Monthly validation below retains the 029 comprehensive branch and fixed
-- identities, but a new professional report references only its own plan.
CREATE OR REPLACE FUNCTION app_private.validate_scoped_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE configured app_private.report_scopes%ROWTYPE; target_month date; refs jsonb:=COALESCE(proposed->'biz'->'monthly_plan_ids','[]'::jsonb);
 old_refs jsonb:=COALESCE(prior->'biz'->'monthly_plan_ids','[]'::jsonb); ref jsonb; ref_id text; seen text[]:='{}'; known text[];
 selected public.monthly_plans%ROWTYPE; source_item jsonb; actual jsonb; at integer:=0; source_at integer; field text; professional boolean:=COALESCE(proposed->>'line','综合')<>'综合';
BEGIN
 IF NOT app_private.can_write_report(proposed->>'project_id',COALESCE(proposed->>'line','综合'),auth.uid()) THEN RAISE EXCEPTION 'Monthly report denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO configured FROM app_private.report_scopes WHERE id=proposed->>'report_scope_id' FOR SHARE;
 IF NOT FOUND OR proposed->>'project_id' IS DISTINCT FROM configured.anchor_project_id OR (professional AND (configured.reporting_mode<>'professional' OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.discipline=proposed->>'line')))
   OR proposed->'scope_project_ids' IS DISTINCT FROM to_jsonb(configured.project_ids)
   OR NOT app_private.can_read_report_scope(configured.project_ids) THEN RAISE EXCEPTION 'Scoped monthly report denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>(CASE WHEN professional THEN 1 ELSE 9 END) THEN RAISE EXCEPTION '月度计划引用须为专业确认版列表' USING ERRCODE='23514'; END IF;
 IF COALESCE(proposed->'biz'->>'monthly_plan_id','')<>'' AND (prior IS NULL OR proposed->'biz'->>'monthly_plan_id' IS DISTINCT FROM prior->'biz'->>'monthly_plan_id') THEN
  RAISE EXCEPTION '月度计划统一报告须使用多专业引用，不能绑定单专业确认版' USING ERRCODE='23514'; END IF;
 -- An old comprehensive record must not silently adopt a newly confirmed plan.
 IF prior IS NOT NULL AND (jsonb_typeof(old_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(old_refs)=0) THEN
  IF jsonb_array_length(refs)>0 THEN RAISE EXCEPTION '月度计划既有综合报告保留原快照，请勿自动汇入专业确认版' USING ERRCODE='23514'; END IF;
  RETURN true;
 END IF;
 IF prior IS NOT NULL AND refs IS DISTINCT FROM old_refs THEN RAISE EXCEPTION '月度计划已保存引用不可移除、调换或补入' USING ERRCODE='23514'; END IF;
 target_month:=app_private.report_month_start(proposed->>'period',COALESCE((prior->>'submitted_at')::timestamptz,now()));
 IF target_month IS NULL THEN RAISE EXCEPTION '月度计划无法匹配报告月份，请使用有效报告周' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(configured.id,to_char(target_month,'YYYY-MM-DD'))::text,0));
 IF NOT app_private.can_write_report(proposed->>'project_id',COALESCE(proposed->>'line','综合'),auth.uid()) OR NOT app_private.can_read_report_scope(configured.project_ids) THEN
  RAISE EXCEPTION 'Scoped monthly report authorization changed' USING ERRCODE='42501'; END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(ref) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION '月度计划引用标识不正确' USING ERRCODE='23514'; END IF;
  ref_id:=ref#>>'{}';
  IF ref_id!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR ref_id=ANY(seen) THEN
   RAISE EXCEPTION '月度计划引用重复或标识不正确' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,ref_id);
 END LOOP;
 IF prior IS NULL THEN
  SELECT COALESCE(array_agg(p.id::text ORDER BY p.id),'{}') INTO known FROM public.monthly_plans p
    WHERE p.report_scope_id=configured.id AND p.plan_month=target_month AND (NOT professional OR p.line=proposed->>'line');
  IF (SELECT COALESCE(array_agg(v ORDER BY v),'{}') FROM unnest(seen) v) IS DISTINCT FROM known THEN
   RAISE EXCEPTION '月度计划专业确认版已变化，请重新读取完整清单后提交' USING ERRCODE='23514'; END IF;
 END IF;
 IF cardinality(seen)=0 THEN RETURN true; END IF;
 IF jsonb_typeof(proposed->'biz'->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '月度计划事项清单不正确' USING ERRCODE='23514'; END IF;
 FOREACH ref_id IN ARRAY seen LOOP
  SELECT * INTO selected FROM public.monthly_plans p WHERE p.id::text=ref_id AND p.project_id=configured.anchor_project_id
    AND p.report_scope_id=configured.id AND p.scope_project_ids=configured.project_ids AND p.plan_month=target_month
    AND (NOT professional OR p.line=proposed->>'line') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION '月度计划确认版或范围已变化，请刷新' USING ERRCODE='23514'; END IF;
  source_at:=0;
  FOR source_item IN SELECT value FROM jsonb_array_elements(selected.items) LOOP
   actual:=proposed->'biz'->'items'->at;
   IF jsonb_typeof(actual) IS DISTINCT FROM 'object' OR actual->>'monthly_plan_id' IS DISTINCT FROM ref_id
     OR actual->>'source_id' IS DISTINCT FROM source_item->>'source_id'
     OR COALESCE(actual->>'mod','') IS DISTINCT FROM COALESCE(source_item->>'mod','')
     OR actual->>'name' IS DISTINCT FROM source_item->>'name' OR COALESCE(actual->>'due','') IS DISTINCT FROM COALESCE(source_item->>'due','')
     OR actual->'project_id' IS DISTINCT FROM source_item->'project_id' THEN
    RAISE EXCEPTION '月度计划已确认，专业、事项、日期及实际项目固定列不可修改或增删' USING ERRCODE='23514'; END IF;
   FOREACH field IN ARRAY ARRAY['mod','name'] LOOP
    IF app_private.monthly_name_runs(actual->>field,proposed->'rich_text'->'fields'->('biz.items.'||at||'.'||field))
      IS DISTINCT FROM app_private.monthly_name_runs(source_item->>field,selected.rich_text->'fields'->('items.'||source_at||'.'||field)) THEN
     RAISE EXCEPTION '月度计划固定列格式不可修改' USING ERRCODE='23514'; END IF;
   END LOOP;
   at:=at+1;source_at:=source_at+1;
  END LOOP;
 END LOOP;
 IF at<>jsonb_array_length(proposed->'biz'->'items') THEN RAISE EXCEPTION '月度计划固定事项不可增删' USING ERRCODE='23514'; END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app_private.validate_scoped_monthly_report(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.validate_scoped_monthly_report(jsonb,jsonb) TO app_runtime;

COMMIT;
