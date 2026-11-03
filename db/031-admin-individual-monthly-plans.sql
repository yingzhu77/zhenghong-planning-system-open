-- Individual monthly plans and audited administrator assistance.
-- Existing owners, snapshots, reports, applications and grants are retained.
BEGIN;
ALTER TABLE public.monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_project_id_line_plan_month_key;
DROP INDEX IF EXISTS public.monthly_plans_scope_month_line_unique;
CREATE UNIQUE INDEX IF NOT EXISTS monthly_plans_person_month_unique ON public.monthly_plans(project_id,line,plan_month,confirmed_by);
CREATE UNIQUE INDEX IF NOT EXISTS monthly_plans_scope_person_month_unique ON public.monthly_plans(report_scope_id,line,plan_month,confirmed_by) WHERE report_scope_id IS NOT NULL;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_project_period_line_key;
CREATE UNIQUE INDEX IF NOT EXISTS reports_person_period_line_unique ON public.reports(project_id,period,line,author_id);
DROP INDEX IF EXISTS public.reports_scope_week_line_unique;
CREATE UNIQUE INDEX IF NOT EXISTS reports_scope_week_person_line_unique ON public.reports(report_scope_id,scope_week,line,author_id) WHERE report_scope_id IS NOT NULL;
-- Existing comprehensive reports remain one shared report per scope/week.
CREATE UNIQUE INDEX IF NOT EXISTS reports_scope_week_comprehensive_unique ON public.reports(report_scope_id,scope_week) WHERE report_scope_id IS NOT NULL AND line='综合';

CREATE TABLE IF NOT EXISTS app_private.admin_monthly_plan_operations (
 actor_id text NOT NULL REFERENCES public.profiles(user_id), operation_id uuid NOT NULL,
 request jsonb NOT NULL, before_plans jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation_id));
REVOKE ALL ON app_private.admin_monthly_plan_operations FROM PUBLIC,app_runtime;

-- Check the target's existing membership, never impersonate the target actor.
CREATE OR REPLACE FUNCTION app_private.can_assign_monthly_plan(owner_id text,pid text,module text,scope_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (owner_id=auth.uid() OR app_private.has_approved_role(ARRAY['ops'])) AND EXISTS(
 SELECT 1 FROM public.profiles p JOIN public.projects j ON j.id=pid
 WHERE p.user_id=owner_id AND p.status='approved' AND p.role='pm'
 AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=owner_id AND m.project_id=pid)
 AND CASE WHEN j.project_type='com' THEN scope_id IS NULL AND module=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采']) AND (p.biz_line='*' OR p.biz_line=module)
 ELSE module=p.discipline AND module=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务']) AND CASE WHEN scope_id IS NULL
 THEN NOT EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE pid=ANY(s.project_ids))
 ELSE EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE s.id=scope_id AND s.anchor_project_id=pid
 AND NOT EXISTS(SELECT 1 FROM unnest(s.project_ids) member WHERE NOT EXISTS(
 SELECT 1 FROM public.project_members m WHERE m.user_id=owner_id AND m.project_id=member))) END END);
$$;
REVOKE ALL ON FUNCTION app_private.can_assign_monthly_plan(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_assign_monthly_plan(text,text,text,text) TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.monthly_plan_is_referenced(plan_id uuid,pid text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=plan_id::text OR r.biz->'monthly_plan_ids'?plan_id::text
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',plan_id::text))))
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(plan_id::text))))))
 OR EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length('monthly:'||pid||':'||plan_id::text||':'))='monthly:'||pid||':'||plan_id::text||':'
 OR c.source_snapshot->>'monthly_plan_id'=plan_id::text);
$$;
REVOKE ALL ON FUNCTION app_private.monthly_plan_is_referenced(uuid,text) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.admin_monthly_plan_states(target_month date,target_type text)
RETURNS TABLE(plan_id uuid,in_use boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app_private.has_approved_role(ARRAY['ops']) THEN RAISE EXCEPTION 'Administrator assistance denied' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT p.id,app_private.monthly_plan_is_referenced(p.id,p.project_id) FROM public.monthly_plans p
  JOIN public.projects j ON j.id=p.project_id WHERE p.plan_month=target_month AND (target_type IS NULL OR j.project_type=target_type);
END;
$$;
REVOKE ALL ON FUNCTION app_private.admin_monthly_plan_states(date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.admin_monthly_plan_states(date,text) TO app_runtime;


CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; owner_profile public.profiles%ROWTYPE; delegated boolean; configured app_private.report_scopes%ROWTYPE; item jsonb; ids text[]:='{}'; total integer;
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user<>'app_runtime' AND EXISTS(SELECT 1 FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=OLD.id
    AND a.withdrawn_by=auth.uid() AND a.withdrawal_txid=txid_current() AND a.snapshot=to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION '月度计划只允许通过撤回确认操作移入历史记录' USING ERRCODE='42501';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '月度计划确认后不可修改或删除' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
 delegated:=current_user<>'app_runtime' AND actor.status='approved' AND actor.role='ops';
 IF NOT delegated THEN
  IF actor.status IS DISTINCT FROM 'approved' OR actor.role<>'pm' THEN RAISE EXCEPTION 'Monthly plan confirmation denied' USING ERRCODE='42501'; END IF;
  NEW.confirmed_by:=auth.uid();
 END IF;
 SELECT * INTO owner_profile FROM public.profiles WHERE user_id=NEW.confirmed_by;
 IF NOT app_private.can_assign_monthly_plan(NEW.confirmed_by,NEW.project_id,NEW.line,NEW.report_scope_id) THEN
  RAISE EXCEPTION 'Monthly plan owner authorization denied' USING ERRCODE='42501'; END IF;
 IF NEW.report_scope_id IS NULL THEN
  IF NEW.scope_project_ids IS NOT NULL THEN RAISE EXCEPTION 'Monthly plan scope denied' USING ERRCODE='42501'; END IF;
 ELSE
  IF delegated THEN
   SELECT * INTO configured FROM app_private.report_scopes WHERE id=NEW.report_scope_id FOR SHARE;
  ELSE
   SELECT * INTO configured FROM app_private.lock_monthly_report_scope(NEW.report_scope_id);
  END IF;
  IF NOT FOUND OR NEW.scope_project_ids IS NOT NULL AND NEW.scope_project_ids IS DISTINCT FROM configured.project_ids
    OR NEW.plan_month<date_trunc('month',configured.effective_week)::date THEN
   RAISE EXCEPTION 'Scoped monthly plan confirmation denied' USING ERRCODE='42501'; END IF;
  NEW.scope_project_ids:=configured.project_ids;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(NEW.report_scope_id,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(NEW.project_id,NEW.line,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
 IF NOT app_private.can_assign_monthly_plan(NEW.confirmed_by,NEW.project_id,NEW.line,NEW.report_scope_id) THEN
  RAISE EXCEPTION 'Monthly plan owner authorization changed' USING ERRCODE='42501'; END IF;
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
    OR btrim(item->>'name')='' OR length(item->>'name')>10000 OR length(item->>'mod')>200 OR jsonb_typeof(item->'due') IS DISTINCT FROM 'string'
    OR (item-CASE WHEN NEW.report_scope_id IS NULL THEN ARRAY['source_id','mod','name','due'] ELSE ARRAY['source_id','mod','name','due','project_id'] END)<>'{}'::jsonb
    OR item?'project_id' AND (NEW.report_scope_id IS NULL OR jsonb_typeof(item->'project_id') IS DISTINCT FROM 'string'
      OR NOT (item->>'project_id')=ANY(NEW.scope_project_ids)) THEN
   RAISE EXCEPTION '月度计划事项标识、固定列或实际项目不正确' USING ERRCODE='23514'; END IF;
  IF item->>'due'<>'' AND ((item->>'due')!~'^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR to_char((item->>'due')::date,'YYYY-MM-DD') IS DISTINCT FROM item->>'due') THEN
   RAISE EXCEPTION '月度计划事项完成日期不正确' USING ERRCODE='23514'; END IF;
  ids:=array_append(ids,item->>'source_id');
 END LOOP;
 NEW.confirmed_name:=owner_profile.name;NEW.confirmed_at:=now();
 RETURN NEW;
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
  IF NOT EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.confirmed_by=auth.uid()) THEN
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
  IF EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.report_scope_id IS NULL AND p.confirmed_by=auth.uid()) THEN
   RAISE EXCEPTION '月度计划无法匹配报告周，请使用带日期范围的报告周期' USING ERRCODE='23514'; END IF;
  IF new_id<>'' THEN RAISE EXCEPTION '月度计划引用与报告周期不匹配' USING ERRCODE='23514'; END IF;RETURN true;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.report_scope_id IS NULL AND p.confirmed_by=auth.uid() FOR SHARE;
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
    WHERE p.report_scope_id=configured.id AND p.plan_month=target_month AND (NOT professional OR (p.line=proposed->>'line' AND p.confirmed_by=auth.uid()));
  IF (SELECT COALESCE(array_agg(v ORDER BY v),'{}') FROM unnest(seen) v) IS DISTINCT FROM known THEN
   RAISE EXCEPTION '月度计划专业确认版已变化，请重新读取完整清单后提交' USING ERRCODE='23514'; END IF;
 END IF;
 IF cardinality(seen)=0 THEN RETURN true; END IF;
 IF jsonb_typeof(proposed->'biz'->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '月度计划事项清单不正确' USING ERRCODE='23514'; END IF;
 FOREACH ref_id IN ARRAY seen LOOP
  SELECT * INTO selected FROM public.monthly_plans p WHERE p.id::text=ref_id AND p.project_id=configured.anchor_project_id
    AND p.report_scope_id=configured.id AND p.scope_project_ids=configured.project_ids AND p.plan_month=target_month
    AND (NOT professional OR (p.line=proposed->>'line' AND p.confirmed_by=auth.uid())) FOR SHARE;
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

CREATE OR REPLACE FUNCTION app_private.guard_report_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE previous jsonb;
BEGIN
    IF current_user='app_runtime' THEN
        IF TG_OP='UPDATE' THEN previous:=to_jsonb(OLD);
        ELSE
            -- INSERT ... ON CONFLICT runs BEFORE INSERT before choosing its
            -- UPDATE branch. Preserve the actual old snapshot in that case.
            SELECT to_jsonb(r) INTO previous FROM public.reports r
              WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line AND r.author_id=NEW.author_id FOR SHARE;
        END IF;
        PERFORM app_private.validate_monthly_report(to_jsonb(NEW),previous);
    END IF;
    RETURN NEW;
END;
$$;

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
  SELECT * INTO previous FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line AND r.author_id=NEW.author_id;
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
  PERFORM pg_advisory_xact_lock(hashtextextended('report-scope:'||scope.id||':'||week::text||':'||NEW.line||':'||NEW.author_id,0));
  RETURN NEW;
 END IF;
 -- Other configured scopes retain their original comprehensive contract.
 IF week IS NULL OR week<scope.effective_week THEN
  IF week IS NULL AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.reports r WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line AND r.author_id=NEW.author_id AND r.report_scope_id IS NULL) THEN
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


-- Only this bounded command may assist another reporter. Every confirmation
-- keeps the target owner while this operation records the real administrator.
CREATE OR REPLACE FUNCTION app_private.save_admin_monthly_plans(operation uuid,proposed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE remembered app_private.admin_monthly_plan_operations%ROWTYPE; entry jsonb; selected public.monthly_plans%ROWTYPE;
 inserted public.monthly_plans%ROWTYPE; configured app_private.report_scopes%ROWTYPE; snapshots jsonb:='[]'; results jsonb:='[]';
 expected uuid; target_month date; owner text; pid text; module text; scope_id text; seen text[]:='{}'; identity text;
BEGIN
 PERFORM 1 FROM public.profiles WHERE user_id=auth.uid() AND status='approved' AND role='ops' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Administrator assistance denied' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR jsonb_typeof(proposed) IS DISTINCT FROM 'array' OR jsonb_array_length(proposed)<1 OR jsonb_array_length(proposed)>100 THEN
  RAISE EXCEPTION '批量月计划须为1至100份' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-monthly-operation:'||jsonb_build_array(auth.uid(),operation)::text,0));
 SELECT * INTO remembered FROM app_private.admin_monthly_plan_operations a WHERE a.actor_id=auth.uid() AND a.operation_id=operation;
 IF FOUND THEN
  IF remembered.request IS DISTINCT FROM proposed THEN RAISE EXCEPTION '同一次保存标识不能提交不同内容，请刷新后重试' USING ERRCODE='23514',DETAIL='monthly_plan_operation_conflict'; END IF;
  RETURN remembered.result||jsonb_build_object('replayed',true);
 END IF;
 -- Lock all configuration/members first, then every scope/month before plan
 -- rows. Canonical ordering makes overlapping batches use one lock order.
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) ORDER BY value->>'owner_id',value->>'project_id',value->>'line',value->>'month' LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry-ARRAY['project_id','line','month','owner_id','items','rich_text','expected_plan_id','report_scope_id']<>'{}'::jsonb
    OR NOT entry?'expected_plan_id' OR jsonb_typeof(entry->'month') IS DISTINCT FROM 'string'
    OR entry->>'month'!~'^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'
    OR jsonb_typeof(entry->'expected_plan_id') NOT IN ('null','string')
    OR jsonb_typeof(entry->'owner_id') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'project_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(entry->'line') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(COALESCE(entry->'rich_text','{}')) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '批量月计划格式不正确' USING ERRCODE='22023'; END IF;
  owner:=entry->>'owner_id';pid:=entry->>'project_id';module:=entry->>'line';scope_id:=entry->>'report_scope_id';
  identity:=jsonb_build_array(pid,module,entry->>'month',owner)::text;
  IF identity=ANY(seen) THEN RAISE EXCEPTION '同一提报人同月专业计划不能重复提交' USING ERRCODE='22023'; END IF;seen:=array_append(seen,identity);
  PERFORM 1 FROM public.profiles p WHERE p.user_id=owner FOR SHARE;
  PERFORM 1 FROM public.project_members m WHERE m.user_id=owner ORDER BY m.project_id FOR SHARE;
  IF scope_id IS NOT NULL THEN PERFORM 1 FROM app_private.report_scopes s WHERE s.id=scope_id FOR SHARE; END IF;
  IF NOT app_private.can_assign_monthly_plan(owner,pid,module,scope_id) THEN RAISE EXCEPTION '目标提报人没有此项目或专业的现有授权' USING ERRCODE='42501'; END IF;
 END LOOP;
 FOR entry IN SELECT DISTINCT jsonb_build_array(value->>'report_scope_id',value->>'month') AS key FROM jsonb_array_elements(proposed) WHERE value->>'report_scope_id' IS NOT NULL ORDER BY key LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(entry->>0,(entry->>1)||'-01')::text,0));
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) ORDER BY value->>'project_id',value->>'line',value->>'month',value->>'owner_id' LOOP
  owner:=entry->>'owner_id';pid:=entry->>'project_id';module:=entry->>'line';scope_id:=entry->>'report_scope_id';target_month:=((entry->>'month')||'-01')::date;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 END LOOP;
 -- Remove all replaced unused snapshots before inserting the batch. This also
 -- makes a replacement at the scope's aggregate item limit order-independent.
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) LOOP
  owner:=entry->>'owner_id';pid:=entry->>'project_id';module:=entry->>'line';scope_id:=entry->>'report_scope_id';target_month:=((entry->>'month')||'-01')::date;
  expected:=(entry->>'expected_plan_id')::uuid;
  SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.confirmed_by=owner FOR UPDATE;
  IF (FOUND AND (selected.id IS DISTINCT FROM expected OR selected.report_scope_id IS DISTINCT FROM scope_id)) OR (NOT FOUND AND expected IS NOT NULL) THEN
   RAISE EXCEPTION '月计划已变化，请刷新确认后再保存' USING ERRCODE='P0002'; END IF;
  IF selected.id IS NOT NULL THEN
   IF app_private.monthly_plan_is_referenced(selected.id,pid) THEN RAISE EXCEPTION '该月计划已有周报或完成延期申报引用，不允许修改' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
   snapshots:=snapshots||jsonb_build_array(to_jsonb(selected));
   INSERT INTO app_private.monthly_plan_withdrawals(plan_id,project_id,line,plan_month,withdrawn_by,snapshot)
    VALUES(selected.id,pid,module,target_month,auth.uid(),to_jsonb(selected));
   DELETE FROM public.monthly_plans WHERE id=selected.id;
  END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) LOOP
  owner:=entry->>'owner_id';pid:=entry->>'project_id';module:=entry->>'line';scope_id:=entry->>'report_scope_id';target_month:=((entry->>'month')||'-01')::date;
  IF NOT app_private.can_assign_monthly_plan(owner,pid,module,scope_id) THEN RAISE EXCEPTION '目标提报人授权已变化，请刷新后重试' USING ERRCODE='42501'; END IF;
  INSERT INTO public.monthly_plans(id,project_id,line,plan_month,items,rich_text,confirmed_by,report_scope_id)
   VALUES(gen_random_uuid(),pid,module,target_month,entry->'items',COALESCE(entry->'rich_text','{}'),owner,scope_id) RETURNING * INTO inserted;
  results:=results||jsonb_build_array(to_jsonb(inserted)||jsonb_build_object('owner_id',inserted.confirmed_by));
 END LOOP;
 results:=jsonb_build_object('operation_id',operation,'plans',results,'replayed',false);
 INSERT INTO app_private.admin_monthly_plan_operations(actor_id,operation_id,request,before_plans,result) VALUES(auth.uid(),operation,proposed,snapshots,results);
 RETURN results;
END;
$$;
REVOKE ALL ON FUNCTION app_private.save_admin_monthly_plans(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.save_admin_monthly_plans(uuid,jsonb) TO app_runtime;
COMMIT;
