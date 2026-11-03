-- Scoped residential professional plans keep one comprehensive weekly report.
-- Existing plans/reports/approvals are not backfilled or rewritten.
BEGIN;
ALTER TABLE public.monthly_plans ADD COLUMN IF NOT EXISTS report_scope_id text REFERENCES app_private.report_scopes(id);
ALTER TABLE public.monthly_plans ADD COLUMN IF NOT EXISTS scope_project_ids text[];
ALTER TABLE public.monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_scope_identity;
ALTER TABLE public.monthly_plans ADD CONSTRAINT monthly_plans_scope_identity CHECK(
  (report_scope_id IS NULL AND scope_project_ids IS NULL) OR
  (report_scope_id IS NOT NULL AND scope_project_ids IS NOT NULL AND cardinality(scope_project_ids)>1 AND project_id=ANY(scope_project_ids)));
CREATE UNIQUE INDEX IF NOT EXISTS monthly_plans_scope_month_line_unique
  ON public.monthly_plans(report_scope_id,line,plan_month) WHERE report_scope_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.can_confirm_scoped_monthly_plan(pid text,module text,scope_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.can_write_report(pid,module,auth.uid()) AND EXISTS(
   SELECT 1 FROM app_private.report_scopes s JOIN public.profiles p ON p.user_id=auth.uid()
   WHERE s.id=scope_id AND s.anchor_project_id=pid AND module=p.discipline
     AND module=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务'])
     AND app_private.can_read_report_scope(s.project_ids));
$$;
REVOKE ALL ON FUNCTION app_private.can_confirm_scoped_monthly_plan(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_confirm_scoped_monthly_plan(text,text,text) TO app_runtime;
-- Runtime may read scope configuration but never receives UPDATE merely to lock it.
CREATE OR REPLACE FUNCTION app_private.lock_monthly_report_scope(scope_id text)
RETURNS SETOF app_private.report_scopes LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected app_private.report_scopes%ROWTYPE;
BEGIN
 SELECT * INTO selected FROM app_private.report_scopes WHERE id=scope_id FOR SHARE;
 IF NOT FOUND OR NOT app_private.has_approved_role(ARRAY['pm']) OR NOT app_private.can_read_report_scope(selected.project_ids) THEN
  RAISE EXCEPTION '统一月计划需要全部成员项目的原授权' USING ERRCODE='42501'; END IF;
 RETURN NEXT selected;
END;
$$;
REVOKE ALL ON FUNCTION app_private.lock_monthly_report_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_monthly_report_scope(text) TO app_runtime;

DROP POLICY IF EXISTS monthly_plans_read ON public.monthly_plans;
CREATE POLICY monthly_plans_read ON public.monthly_plans FOR SELECT TO app_runtime USING(
 CASE WHEN report_scope_id IS NULL THEN app_private.can_read_project(project_id)
      ELSE app_private.can_read_report_scope(scope_project_ids) END);
DROP POLICY IF EXISTS monthly_plans_insert ON public.monthly_plans;
CREATE POLICY monthly_plans_insert ON public.monthly_plans FOR INSERT TO app_runtime WITH CHECK(
 confirmed_by=auth.uid() AND CASE WHEN report_scope_id IS NULL
   THEN scope_project_ids IS NULL AND app_private.can_confirm_monthly_scope(project_id,line)
   ELSE app_private.can_confirm_scoped_monthly_plan(project_id,line,report_scope_id)
     AND EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE s.id=report_scope_id AND s.project_ids=scope_project_ids) END);

CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; configured app_private.report_scopes%ROWTYPE; item jsonb; ids text[]:='{}'; total integer;
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user<>'app_runtime' AND EXISTS(SELECT 1 FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=OLD.id
    AND a.withdrawn_by=auth.uid() AND a.withdrawal_txid=txid_current() AND a.snapshot=to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION '月度计划只允许通过撤回确认操作移入历史记录' USING ERRCODE='42501';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '月度计划确认后不可修改或删除' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
 IF actor.status IS DISTINCT FROM 'approved' OR actor.role<>'pm' THEN RAISE EXCEPTION 'Monthly plan confirmation denied' USING ERRCODE='42501'; END IF;
 IF NEW.report_scope_id IS NULL THEN
  IF NEW.scope_project_ids IS NOT NULL OR NOT app_private.can_confirm_monthly_scope(NEW.project_id,NEW.line) THEN
   RAISE EXCEPTION 'Monthly plan confirmation denied' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO configured FROM app_private.lock_monthly_report_scope(NEW.report_scope_id);
  IF NOT FOUND OR NOT app_private.can_confirm_scoped_monthly_plan(NEW.project_id,NEW.line,NEW.report_scope_id)
    OR NEW.scope_project_ids IS NOT NULL AND NEW.scope_project_ids IS DISTINCT FROM configured.project_ids
    OR NEW.plan_month<date_trunc('month',configured.effective_week)::date THEN
   RAISE EXCEPTION 'Scoped monthly plan confirmation denied' USING ERRCODE='42501'; END IF;
  NEW.scope_project_ids:=configured.project_ids;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(NEW.report_scope_id,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(NEW.project_id,NEW.line,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
 IF NEW.report_scope_id IS NOT NULL AND NOT app_private.can_confirm_scoped_monthly_plan(NEW.project_id,NEW.line,NEW.report_scope_id) THEN
  RAISE EXCEPTION '统一月计划确认权限已变化，请重新读取' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.items)>500 THEN
  RAISE EXCEPTION '月度计划须为最多500项的列表' USING ERRCODE='23514'; END IF;
 IF NEW.report_scope_id IS NOT NULL THEN
  SELECT COALESCE(sum(jsonb_array_length(p.items)),0)::int INTO total FROM public.monthly_plans p
   WHERE p.report_scope_id=NEW.report_scope_id AND p.plan_month=NEW.plan_month;
  IF total+jsonb_array_length(NEW.items)>500 THEN RAISE EXCEPTION '月度计划各专业事项合计最多500项' USING ERRCODE='23514'; END IF;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item->>'source_id' IS NULL
    OR (item->>'source_id')!~'^[A-Za-z0-9_-]{1,200}$' OR (item->>'source_id')=ANY(ids)
    OR jsonb_typeof(item->'mod') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
    OR btrim(item->>'name')='' OR jsonb_typeof(item->'due') IS DISTINCT FROM 'string'
    OR (item-CASE WHEN NEW.report_scope_id IS NULL THEN ARRAY['source_id','mod','name','due'] ELSE ARRAY['source_id','mod','name','due','project_id'] END)<>'{}'::jsonb
    OR item?'project_id' AND (NEW.report_scope_id IS NULL OR jsonb_typeof(item->'project_id') IS DISTINCT FROM 'string'
      OR NOT (item->>'project_id')=ANY(NEW.scope_project_ids)) THEN
   RAISE EXCEPTION '月度计划事项标识、固定列或实际项目不正确' USING ERRCODE='23514'; END IF;
  ids:=array_append(ids,item->>'source_id');
 END LOOP;
 NEW.confirmed_by:=auth.uid();NEW.confirmed_name:=actor.name;NEW.confirmed_at:=now();
 RETURN NEW;
END;
$$;

-- A new comprehensive report imports the current confirmed professional set.
-- Its stable references and order are frozen; older unlinked reports remain old.
CREATE OR REPLACE FUNCTION app_private.validate_scoped_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE configured app_private.report_scopes%ROWTYPE; target_month date; refs jsonb:=COALESCE(proposed->'biz'->'monthly_plan_ids','[]'::jsonb);
 old_refs jsonb:=COALESCE(prior->'biz'->'monthly_plan_ids','[]'::jsonb); ref jsonb; ref_id text; seen text[]:='{}'; known text[];
 selected public.monthly_plans%ROWTYPE; source_item jsonb; actual jsonb; at integer:=0; source_at integer; field text;
BEGIN
 IF NOT app_private.can_write_report(proposed->>'project_id','综合',auth.uid()) THEN RAISE EXCEPTION 'Monthly report denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO configured FROM app_private.report_scopes WHERE id=proposed->>'report_scope_id' FOR SHARE;
 IF NOT FOUND OR proposed->>'project_id' IS DISTINCT FROM configured.anchor_project_id OR proposed->>'line'<>'综合'
   OR proposed->'scope_project_ids' IS DISTINCT FROM to_jsonb(configured.project_ids)
   OR NOT app_private.can_read_report_scope(configured.project_ids) THEN RAISE EXCEPTION 'Scoped monthly report denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>9 THEN RAISE EXCEPTION '月度计划引用须为专业确认版列表' USING ERRCODE='23514'; END IF;
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
 IF NOT app_private.can_write_report(proposed->>'project_id','综合',auth.uid()) OR NOT app_private.can_read_report_scope(configured.project_ids) THEN
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
    WHERE p.report_scope_id=configured.id AND p.plan_month=target_month;
  IF (SELECT COALESCE(array_agg(v ORDER BY v),'{}') FROM unnest(seen) v) IS DISTINCT FROM known THEN
   RAISE EXCEPTION '月度计划专业确认版已变化，请重新读取完整清单后提交' USING ERRCODE='23514'; END IF;
 END IF;
 IF cardinality(seen)=0 THEN RETURN true; END IF;
 IF jsonb_typeof(proposed->'biz'->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '月度计划事项清单不正确' USING ERRCODE='23514'; END IF;
 FOREACH ref_id IN ARRAY seen LOOP
  SELECT * INTO selected FROM public.monthly_plans p WHERE p.id::text=ref_id AND p.project_id=configured.anchor_project_id
    AND p.report_scope_id=configured.id AND p.scope_project_ids=configured.project_ids AND p.plan_month=target_month FOR SHARE;
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

-- The independent branch below deliberately retains the prior contract.
CREATE OR REPLACE FUNCTION app_private.validate_independent_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid text:=proposed->>'project_id'; module text:=proposed->>'line'; target_month date;
 selected public.monthly_plans%ROWTYPE; new_id text:=COALESCE(proposed->'biz'->>'monthly_plan_id','');
 old_id text:=COALESCE(prior->'biz'->>'monthly_plan_id',''); reference_at timestamptz;
BEGIN
 IF NOT app_private.can_write_report(pid,module,auth.uid()) THEN RAISE EXCEPTION 'Monthly report denied' USING ERRCODE='42501'; END IF;
 IF jsonb_array_length(CASE WHEN jsonb_typeof(proposed->'biz'->'monthly_plan_ids')='array' THEN proposed->'biz'->'monthly_plan_ids' ELSE '[]'::jsonb END)>0 THEN
  RAISE EXCEPTION '月度计划多专业引用仅用于统一综合报告' USING ERRCODE='23514'; END IF;
 IF module='综合' AND NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=pid AND p.project_type='com') THEN RETURN true; END IF;
 reference_at:=COALESCE((prior->>'submitted_at')::timestamptz,now());target_month:=app_private.report_month_start(proposed->>'period',reference_at);
 IF old_id<>'' AND new_id IS DISTINCT FROM old_id THEN RAISE EXCEPTION '月度计划引用不可删除或调换，请刷新确认版' USING ERRCODE='23514'; END IF;
 IF target_month IS NULL THEN
  IF prior IS NOT NULL AND old_id='' AND new_id='' AND app_private.monthly_items_unchanged(proposed->'biz'->'items',prior->'biz'->'items',proposed->'rich_text',prior->'rich_text','biz.items',false) THEN RETURN true; END IF;
  IF EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.report_scope_id IS NULL) THEN
   RAISE EXCEPTION '月度计划无法匹配报告周，请使用带日期范围的报告周期' USING ERRCODE='23514'; END IF;
  IF new_id<>'' THEN RAISE EXCEPTION '月度计划引用与报告周期不匹配' USING ERRCODE='23514'; END IF;RETURN true;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.report_scope_id IS NULL FOR SHARE;
 IF NOT FOUND THEN
  IF new_id<>'' THEN RAISE EXCEPTION '月度计划引用与报告周所属月份不匹配' USING ERRCODE='23514'; END IF;RETURN true;
 END IF;
 IF prior IS NOT NULL AND old_id='' AND new_id='' THEN
  IF app_private.monthly_items_unchanged(proposed->'biz'->'items',prior->'biz'->'items',proposed->'rich_text',prior->'rich_text','biz.items',false) THEN RETURN true; END IF;
  RAISE EXCEPTION '月度计划已确认，既有周报只能更新进展和卡点，原计划快照保留' USING ERRCODE='23514';
 END IF;
 IF new_id IS DISTINCT FROM selected.id::text OR proposed->'biz'->>'monthly_plan_month' IS DISTINCT FROM to_char(target_month,'YYYY-MM') THEN
  RAISE EXCEPTION '月度计划已确认，请引用本模块本月确认版后提交' USING ERRCODE='23514'; END IF;
 IF NOT app_private.monthly_items_unchanged(proposed->'biz'->'items',selected.items,proposed->'rich_text',selected.rich_text,'items',true) THEN
  RAISE EXCEPTION '月度计划已确认，模块、事项、完成时间及事项格式不可修改或增删，只能更新进展和卡点' USING ERRCODE='23514'; END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app_private.validate_independent_monthly_report(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.validate_independent_monthly_report(jsonb,jsonb) TO app_runtime;
CREATE OR REPLACE FUNCTION app_private.validate_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF proposed->>'report_scope_id' IS NOT NULL THEN RETURN app_private.validate_scoped_monthly_report(proposed,prior); END IF;
 RETURN app_private.validate_independent_monthly_report(proposed,prior);
END;
$$;

CREATE OR REPLACE FUNCTION app_private.withdraw_monthly_plan(pid text,module text,target_month date,expected_plan_id uuid,scope_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE; configured app_private.report_scopes%ROWTYPE; original jsonb; prefix text;
BEGIN
 IF scope_id IS NULL THEN
  IF NOT app_private.can_confirm_monthly_scope(pid,module) THEN RAISE EXCEPTION '仅可撤回本人获授权专业的月计划' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO configured FROM app_private.report_scopes WHERE id=scope_id FOR SHARE;
  IF NOT FOUND OR NOT app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id) THEN RAISE EXCEPTION '统一月计划撤回需要本人专业及全部成员授权' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(scope_id,to_char(target_month,'YYYY-MM-DD'))::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month
   AND p.report_scope_id IS NOT DISTINCT FROM scope_id AND p.id=expected_plan_id FOR UPDATE;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month) THEN
   SELECT a.snapshot INTO original FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=expected_plan_id
     AND a.project_id=pid AND a.line=module AND a.plan_month=target_month AND a.withdrawn_by=auth.uid()
     AND (a.snapshot->>'report_scope_id') IS NOT DISTINCT FROM scope_id;
   IF FOUND AND (scope_id IS NULL OR app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id)
      AND original->'scope_project_ids'=to_jsonb(configured.project_ids)) THEN RETURN original; END IF;
  END IF;
  RAISE EXCEPTION '月计划确认版已变化，请刷新后重新操作' USING ERRCODE='P0002';
 END IF;
 IF selected.confirmed_by IS DISTINCT FROM auth.uid() OR (CASE WHEN scope_id IS NULL
   THEN NOT app_private.can_confirm_monthly_scope(pid,module)
   ELSE NOT app_private.can_confirm_scoped_monthly_plan(pid,module,scope_id) OR selected.scope_project_ids IS DISTINCT FROM configured.project_ids END) THEN
  RAISE EXCEPTION '仅原确认人可以撤回本人当前获授权的月计划' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=selected.id::text OR r.biz->'monthly_plan_ids'?selected.id::text
   OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',selected.id::text))))
   OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(selected.id::text)))))) THEN
  RAISE EXCEPTION '该月计划已有周报或历史周报引用，不能撤回；原填报记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
 prefix:='monthly:'||pid||':'||selected.id::text||':';
 IF EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length(prefix))=prefix OR c.source_snapshot->>'monthly_plan_id'=selected.id::text) THEN
  RAISE EXCEPTION '该月计划已有完成或延期申报记录，不能撤回；原申报及审核记录已保留' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
 original:=to_jsonb(selected);
 INSERT INTO app_private.monthly_plan_withdrawals(plan_id,project_id,line,plan_month,withdrawn_by,snapshot) VALUES(selected.id,pid,module,target_month,auth.uid(),original);
 DELETE FROM public.monthly_plans WHERE id=selected.id;RETURN original;
END;
$$;
REVOKE ALL ON FUNCTION app_private.withdraw_monthly_plan(text,text,date,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.withdraw_monthly_plan(text,text,date,uuid,text) TO app_runtime;
CREATE OR REPLACE FUNCTION app_private.withdraw_monthly_plan(pid text,module text,target_month date,expected_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RETURN app_private.withdraw_monthly_plan(pid,module,target_month,expected_plan_id,NULL);END;
$$;

-- Monthly applications have no report_id, so they need their own scope gate.
CREATE OR REPLACE FUNCTION app_private.can_read_monthly_completion(target_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN split_part(target_key,':',1)<>'monthly' THEN true ELSE EXISTS(
  SELECT 1 FROM public.monthly_plans p WHERE p.id::text=split_part(target_key,':',3) AND p.project_id=split_part(target_key,':',2)
    AND (p.report_scope_id IS NULL OR app_private.can_read_report_scope(p.scope_project_ids))) END;
$$;
REVOKE ALL ON FUNCTION app_private.can_read_monthly_completion(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_read_monthly_completion(text) TO app_runtime;
CREATE OR REPLACE FUNCTION app_private.can_review_completion(target_kind text,target_key text,target_project_id text,target_report_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.can_read_project(target_project_id) AND app_private.can_read_completion_report(target_report_id)
  AND app_private.can_read_monthly_completion(target_key) AND CASE
   WHEN app_private.is_initiator_coordination(target_kind,target_key,target_project_id,target_report_id)
    THEN app_private.has_approved_role(ARRAY['pm']) AND split_part(target_key,':',2)=target_project_id AND (
     (array_length(string_to_array(target_key,':'),1)=3 AND target_report_id IS NULL
      AND EXISTS(SELECT 1 FROM public.coordination_tasks t WHERE t.id::text=split_part(target_key,':',3) AND t.project_id=target_project_id AND t.author_id=auth.uid())) OR
     (array_length(string_to_array(target_key,':'),1)=5 AND split_part(target_key,':',3)=target_report_id::text AND length(split_part(target_key,':',5))>0
      AND EXISTS(SELECT 1 FROM public.reports r WHERE r.id=target_report_id AND r.project_id=target_project_id AND r.author_id=auth.uid())))
   ELSE app_private.has_approved_role(ARRAY['ops']) END;
$$;
CREATE OR REPLACE FUNCTION app_private.guard_monthly_completion_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE;
BEGIN
 IF array_length(string_to_array(NEW.source_key,':'),1)<>4 OR split_part(NEW.source_key,':',2)<>NEW.project_id THEN RAISE EXCEPTION '月度计划申报来源与项目不匹配' USING ERRCODE='23514'; END IF;
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.id::text=split_part(NEW.source_key,':',3) AND p.project_id=NEW.project_id
   AND p.confirmed_by=NEW.owner_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.items) i WHERE i->>'source_id'=split_part(NEW.source_key,':',4)) FOR SHARE;
 IF NOT FOUND OR NOT app_private.can_read_monthly_completion(NEW.source_key) THEN RAISE EXCEPTION '月度计划确认版、事项或范围已变化，请刷新后重新申报' USING ERRCODE='23514'; END IF;
 IF selected.report_scope_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.status='approved') AND NOT EXISTS(
  SELECT 1 FROM public.profiles p WHERE p.user_id=NEW.owner_id AND p.role='pm' AND p.status='approved' AND p.discipline=selected.line
   AND NOT EXISTS(SELECT 1 FROM unnest(selected.scope_project_ids) pid WHERE NOT EXISTS(
    SELECT 1 FROM public.project_members m WHERE m.user_id=NEW.owner_id AND m.project_id=pid))) THEN
  RAISE EXCEPTION '统一月计划原承办人的专业或成员项目授权已变化' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$;
DROP POLICY IF EXISTS completion_requests_read ON public.completion_requests;
CREATE POLICY completion_requests_read ON public.completion_requests FOR SELECT TO app_runtime USING(
 app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND app_private.can_read_monthly_completion(source_key) AND (
 app_private.has_approved_role(ARRAY['ops','president','pzo']) OR (owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']))
 OR app_private.can_review_completion(kind,source_key,project_id,report_id)));
DROP POLICY IF EXISTS completion_requests_insert ON public.completion_requests;
CREATE POLICY completion_requests_insert ON public.completion_requests FOR INSERT TO app_runtime WITH CHECK(
 owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id)
 AND app_private.can_read_completion_report(report_id) AND app_private.can_read_monthly_completion(source_key));
DROP POLICY IF EXISTS completion_requests_update ON public.completion_requests;
CREATE POLICY completion_requests_update ON public.completion_requests FOR UPDATE TO app_runtime USING(
 app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND app_private.can_read_monthly_completion(source_key)
 AND ((owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm'])) OR app_private.can_review_completion(kind,source_key,project_id,report_id))) WITH CHECK(
 app_private.can_read_project(project_id) AND app_private.can_read_completion_report(report_id) AND app_private.can_read_monthly_completion(source_key)
 AND ((owner_id=auth.uid() AND app_private.has_approved_role(ARRAY['pm'])) OR app_private.can_review_completion(kind,source_key,project_id,report_id)));
COMMIT;
