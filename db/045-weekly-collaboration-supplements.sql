BEGIN;

ALTER TABLE app_private.weekly_collaboration_drafts
 ADD COLUMN IF NOT EXISTS supplement_items jsonb NOT NULL DEFAULT '[]'
 CHECK(jsonb_typeof(supplement_items)='array' AND jsonb_array_length(supplement_items)<=500);
ALTER TABLE public.monthly_plans
 ADD COLUMN IF NOT EXISTS supplement_revision integer NOT NULL DEFAULT 0 CHECK(supplement_revision>=0);

-- This lock follows the weekly and shared-draft locks and matches the
-- order used by month confirmation, withdrawal and administrator imports.
CREATE OR REPLACE FUNCTION app_private.lock_weekly_supplement_month(pid text,module text,scope_id text,target_week date)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE month_key text:=to_char(target_week,'YYYY-MM')||'-01';
BEGIN
 IF app_private.weekly_collaboration_room_access(auth.uid(),pid,module,scope_id,target_week) IS DISTINCT FROM 'member' THEN
  RAISE EXCEPTION '仅本周协同人员可以调整补充事项' USING ERRCODE='42501';
 END IF;
 IF scope_id IS NOT NULL THEN
  PERFORM app_private.lock_monthly_report_scope(scope_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(scope_id,month_key)::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,month_key)::text,0));
END;
$$;
REVOKE ALL ON FUNCTION app_private.lock_weekly_supplement_month(text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.lock_weekly_supplement_month(text,text,text,date) TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.pending_weekly_supplements(plan_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts d
  WHERE d.plan_id=$1 AND d.published_report_id IS NULL AND jsonb_array_length(d.supplement_items)>0);
$$;
REVOKE ALL ON FUNCTION app_private.pending_weekly_supplements(uuid) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.append_weekly_collaboration_monthly_items(
 pid text,module text,scope_id text,target_week date,confirmed_id uuid,expected_revision integer,publish_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE; draft app_private.weekly_collaboration_drafts%ROWTYPE;
 target_month date:=date_trunc('month',target_week)::date; combined jsonb; shared_row app_private.collaboration_monthly_drafts%ROWTYPE;
BEGIN
 PERFORM app_private.lock_weekly_collaboration_write(pid,module,target_week);
 SELECT * INTO draft FROM app_private.weekly_collaboration_drafts d WHERE (d.project_id,d.line,d.week)=(pid,module,target_week);
 IF NOT FOUND OR draft.submitter_id IS DISTINCT FROM auth.uid() OR draft.report_scope_id IS DISTINCT FROM scope_id THEN
  RAISE EXCEPTION '仅本周指定负责人可以提交并同步月计划' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('collaboration-month:'||
  jsonb_build_array(pid,module,scope_id,draft.submitter_id,to_char(target_month,'YYYY-MM'))::text,0));
 PERFORM app_private.lock_weekly_supplement_month(pid,module,scope_id,target_week);
 SELECT * INTO draft FROM app_private.weekly_collaboration_drafts d WHERE (d.project_id,d.line,d.week)=(pid,module,target_week) FOR UPDATE;
 IF target_week>date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date
  OR draft.published_report_id IS NOT NULL OR draft.revision IS DISTINCT FROM expected_revision
  OR draft.plan_id IS DISTINCT FROM confirmed_id OR jsonb_array_length(draft.supplement_items)=0
  OR NOT EXISTS(SELECT 1 FROM app_private.weekly_collaboration_operations o
   WHERE (o.project_id,o.line,o.week,o.operation_id)=(pid,module,target_week,publish_operation)
    AND o.actor_id=auth.uid() AND o.kind='publish' AND o.revision=draft.revision+1) THEN
  RAISE EXCEPTION '补充事项或月计划已变化，请核对后再提交' USING ERRCODE='P4501';
 END IF;
 SELECT * INTO selected FROM public.monthly_plans p WHERE p.id=confirmed_id AND p.confirmed_by=auth.uid()
  AND p.project_id=pid AND p.line=module AND p.plan_month=target_month AND p.report_scope_id IS NOT DISTINCT FROM scope_id
  FOR UPDATE;
 IF NOT FOUND OR NOT app_private.can_assign_monthly_plan(auth.uid(),pid,module,scope_id)
  OR (scope_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.report_scopes s
   WHERE s.id=scope_id AND s.project_ids=selected.scope_project_ids)) THEN
  RAISE EXCEPTION '月计划确认版或归属已变化，请刷新后核对' USING ERRCODE='P4501';
 END IF;
 SELECT * INTO shared_row FROM app_private.collaboration_monthly_drafts m WHERE m.confirmed_id=selected.id
  AND (m.project_id,m.line,m.owner_id,m.plan_month)=(pid,module,draft.submitter_id,target_month)
  AND m.report_scope_id IS NOT DISTINCT FROM scope_id FOR UPDATE;
 IF shared_row.id IS NOT NULL AND shared_row.items IS DISTINCT FROM selected.items THEN
  RAISE EXCEPTION '共享月计划与确认版不一致，请刷新后核对' USING ERRCODE='P4501';
 END IF;
 combined:=selected.items || draft.supplement_items;
 PERFORM set_config('app.weekly_collaboration_append_plan',selected.id::text,true);
 UPDATE public.monthly_plans SET items=combined,supplement_revision=supplement_revision+1 WHERE id=selected.id;
 PERFORM set_config('app.weekly_collaboration_append_plan','',true);
 IF shared_row.id IS NOT NULL THEN
  UPDATE app_private.collaboration_monthly_drafts SET items=combined,revision=revision+1 WHERE id=shared_row.id;
 END IF;
 UPDATE app_private.weekly_collaboration_drafts d SET supplement_items='[]'::jsonb
  WHERE (d.project_id,d.line,d.week)=(pid,module,target_week);
END;
$$;
REVOKE ALL ON FUNCTION app_private.append_weekly_collaboration_monthly_items(text,text,text,date,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.append_weekly_collaboration_monthly_items(text,text,text,date,uuid,integer,uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; owner_profile public.profiles%ROWTYPE; delegated boolean; configured app_private.report_scopes%ROWTYPE; item jsonb; ids text[]:='{}'; total integer;
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user<>'app_runtime' AND EXISTS(SELECT 1 FROM app_private.monthly_plan_withdrawals a WHERE a.plan_id=OLD.id
    AND a.withdrawn_by=auth.uid() AND a.withdrawal_txid=txid_current() AND a.snapshot=to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION '月度计划只允许通过撤回确认操作移入历史记录' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF current_user='app_runtime' OR current_setting('app.weekly_collaboration_append_plan',true) IS DISTINCT FROM OLD.id::text
   OR (to_jsonb(NEW)-ARRAY['items','supplement_revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['items','supplement_revision'])
   OR OLD.confirmed_by IS DISTINCT FROM auth.uid() OR NEW.supplement_revision IS DISTINCT FROM OLD.supplement_revision+1
   OR jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.items)<=jsonb_array_length(OLD.items)
   OR (SELECT jsonb_agg(x.item ORDER BY x.pos) FROM jsonb_array_elements(NEW.items) WITH ORDINALITY x(item,pos)
       WHERE x.pos<=jsonb_array_length(OLD.items)) IS DISTINCT FROM NULLIF(OLD.items,'[]'::jsonb) THEN
   RAISE EXCEPTION '月度计划确认后不可直接修改，只能由负责人提交本周补充事项' USING ERRCODE='42501';
  END IF;
 ELSE
  IF NEW.supplement_revision IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION '月计划初始修订号不正确' USING ERRCODE='23514';
  END IF;
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
 END IF;
 IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.items)>500 THEN
  RAISE EXCEPTION '月度计划须为最多500项的列表' USING ERRCODE='23514'; END IF;
 IF NEW.report_scope_id IS NOT NULL THEN
  SELECT COALESCE(sum(jsonb_array_length(p.items)),0)::int INTO total FROM public.monthly_plans p
   WHERE p.report_scope_id=NEW.report_scope_id AND p.plan_month=NEW.plan_month
    AND (TG_OP='INSERT' OR p.id<>NEW.id);
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
 IF TG_OP='INSERT' THEN
  NEW.confirmed_name:=owner_profile.name;NEW.confirmed_at:=now();
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.monthly_plan_is_referenced(plan_id uuid,pid text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=plan_id::text OR r.biz->'monthly_plan_ids'?plan_id::text
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_id',plan_id::text))))
 OR r.history @> jsonb_build_array(jsonb_build_object('data',jsonb_build_object('biz',jsonb_build_object('monthly_plan_ids',jsonb_build_array(plan_id::text))))))
 OR app_private.withdrawn_report_references_monthly_plan(plan_id)
 OR app_private.pending_weekly_supplements(plan_id)
 OR EXISTS(SELECT 1 FROM public.completion_requests c WHERE left(c.source_key,length('monthly:'||pid||':'||plan_id::text||':'))='monthly:'||pid||':'||plan_id::text||':'
 OR c.source_snapshot->>'monthly_plan_id'=plan_id::text);
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
 IF app_private.pending_weekly_supplements(selected.id) THEN
  RAISE EXCEPTION '本月计划已有待提交的本周补充事项，请先处理周报' USING ERRCODE='23514',DETAIL='monthly_plan_in_use'; END IF;
 IF app_private.withdrawn_report_references_monthly_plan(selected.id)
  OR EXISTS(SELECT 1 FROM public.reports r WHERE r.biz->>'monthly_plan_id'=selected.id::text OR r.biz->'monthly_plan_ids'?selected.id::text
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

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_submission(proposed jsonb,target_week date,unplanned_only boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM app_private.weekly_collaboration_drafts d
  JOIN app_private.weekly_collaboration_operations op USING(project_id,line,week)
  WHERE d.project_id=proposed->>'project_id' AND d.line=proposed->>'line' AND d.week=target_week
   AND jsonb_array_length(d.supplement_items)=0
   AND d.published_report_id IS NULL AND d.submitter_id=auth.uid() AND proposed->>'author_id'=d.submitter_id
   AND (proposed->>'report_scope_id') IS NOT DISTINCT FROM d.report_scope_id
   AND app_private.weekly_collaboration_eligible(auth.uid(),d.project_id,d.line,d.report_scope_id)
   AND (CASE WHEN d.plan_id IS NULL THEN d.unplanned_items IS NOT NULL AND jsonb_array_length(d.unplanned_items)>0
        AND NOT ((proposed->'biz') ?| ARRAY['monthly_plan_id','monthly_plan_ids'])
        WHEN unplanned_only THEN false
        WHEN d.report_scope_id IS NULL THEN proposed->'biz'->>'monthly_plan_id'=d.plan_id::text
        ELSE proposed->'biz'->'monthly_plan_ids'=jsonb_build_array(d.plan_id::text) END)
   AND proposed->'biz'->'weekly_collaboration'=jsonb_build_object('week',to_char(d.week,'YYYY-MM-DD'),'revision',d.revision)
   AND op.operation_id::text=current_setting('app.weekly_collaboration_publish',true)
   AND op.actor_id=auth.uid() AND op.kind='publish' AND op.revision=d.revision+1);
$$;
REVOKE ALL ON FUNCTION app_private.weekly_collaboration_submission(jsonb,date,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.weekly_collaboration_submission(jsonb,date,boolean) TO app_runtime;

-- The month can grow without rewriting a submitted report. If an eligible
-- reporter updates that report, the original fixed list remains acceptable.
CREATE OR REPLACE FUNCTION app_private.preserve_amended_month_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid text:=prior->>'project_id'; module text:=prior->>'line'; scope_id text:=prior->>'report_scope_id';
 target_month date; configured app_private.report_scopes%ROWTYPE; refs jsonb; counts record;
 old_items jsonb:=prior->'biz'->'items'; new_items jsonb:=proposed->'biz'->'items';
BEGIN
 IF prior IS NULL OR prior->>'author_id' IS DISTINCT FROM auth.uid() OR prior->'biz'?'weekly_collaboration'
  OR proposed->'biz'?'weekly_collaboration'
  OR (SELECT jsonb_agg(prior->key ORDER BY key) FROM unnest(ARRAY['project_id','line','period','author_id','report_scope_id','scope_project_ids']) key)
   IS DISTINCT FROM
     (SELECT jsonb_agg(proposed->key ORDER BY key) FROM unnest(ARRAY['project_id','line','period','author_id','report_scope_id','scope_project_ids']) key)
  OR (SELECT jsonb_agg(prior->'biz'->key ORDER BY key) FROM unnest(ARRAY['monthly_plan_id','monthly_plan_ids','monthly_plan_month']) key)
   IS DISTINCT FROM
     (SELECT jsonb_agg(proposed->'biz'->key ORDER BY key) FROM unnest(ARRAY['monthly_plan_id','monthly_plan_ids','monthly_plan_month']) key)
  OR NOT app_private.can_write_report(pid,module,auth.uid())
  OR NOT app_private.monthly_items_unchanged(new_items,old_items,proposed->'rich_text',prior->'rich_text','biz.items',true) THEN
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(old_items) WITH ORDINALITY item(value,pos)
  WHERE value->'project_id' IS DISTINCT FROM ((new_items->(pos::int-1))->'project_id')
   OR value->'monthly_plan_id' IS DISTINCT FROM ((new_items->(pos::int-1))->'monthly_plan_id')) THEN RETURN false; END IF;
 target_month:=app_private.report_month_start(prior->>'period',(prior->>'submitted_at')::timestamptz);
 IF target_month IS NULL THEN RETURN false; END IF;
 IF scope_id IS NULL THEN
  IF COALESCE(prior->'biz'->>'monthly_plan_id','')='' THEN RETURN false; END IF;
  refs:=jsonb_build_array(prior->'biz'->>'monthly_plan_id');
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||
   jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
 ELSE
  refs:=prior->'biz'->'monthly_plan_ids';
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)=0 THEN RETURN false; END IF;
  SELECT * INTO configured FROM app_private.report_scopes WHERE id=scope_id FOR SHARE;
  IF NOT FOUND OR pid IS DISTINCT FROM configured.anchor_project_id
    OR prior->'scope_project_ids' IS DISTINCT FROM to_jsonb(configured.project_ids)
    OR NOT app_private.can_read_report_scope(configured.project_ids)
    OR (module<>'综合' AND (configured.reporting_mode<>'professional' OR NOT EXISTS(
       SELECT 1 FROM public.profiles p WHERE p.user_id=auth.uid() AND p.discipline=module)
       AND NOT app_private.can_use_project_reporting_profession(auth.uid(),pid,module))) THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||
   jsonb_build_array(scope_id,to_char(target_month,'YYYY-MM-DD'))::text,0));
 END IF;
 SELECT count(*) AS found_plans, COALESCE(sum(jsonb_array_length(p.items)),0) AS current_items,
  COALESCE(bool_or(p.supplement_revision>0),false) AS amended INTO counts
 FROM public.monthly_plans p WHERE refs?p.id::text AND p.project_id=pid AND p.plan_month=target_month
  AND p.report_scope_id IS NOT DISTINCT FROM scope_id AND p.scope_project_ids IS NOT DISTINCT FROM configured.project_ids
  AND ((scope_id IS NOT NULL AND module='综合') OR (p.line=module AND p.confirmed_by=auth.uid()));
 RETURN counts.found_plans=jsonb_array_length(refs) AND counts.amended AND counts.current_items>jsonb_array_length(old_items);
END;
$$;
REVOKE ALL ON FUNCTION app_private.preserve_amended_month_report(jsonb,jsonb) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.validate_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF app_private.preserve_amended_month_report(proposed,prior) THEN RETURN true; END IF;
 IF proposed->>'report_scope_id' IS NOT NULL THEN RETURN app_private.validate_scoped_monthly_report(proposed,prior); END IF;
 RETURN app_private.validate_independent_monthly_report(proposed,prior);
END;
$$;

COMMIT;
