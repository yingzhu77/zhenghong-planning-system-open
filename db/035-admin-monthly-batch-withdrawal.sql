-- Undo one audited administrator save atomically. Existing business rows are
-- untouched by migration; restored plans always receive a new confirmation ID.
BEGIN;
CREATE TABLE IF NOT EXISTS app_private.admin_monthly_batch_withdrawals (
 source_actor_id text NOT NULL REFERENCES public.profiles(user_id),
 source_operation_id uuid NOT NULL,
 withdrawn_by text NOT NULL REFERENCES public.profiles(user_id),
 withdrawn_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL,
 PRIMARY KEY(source_actor_id,source_operation_id)
);
REVOKE ALL ON app_private.admin_monthly_batch_withdrawals FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.admin_monthly_batch(source_actor text,source_operation uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('actor_id',a.actor_id,'operation_id',a.operation_id,'created_at',a.created_at,
  'plans',COALESCE(a.result->'plans','[]'::jsonb),'summaries',COALESCE(a.result->'summaries','[]'::jsonb),
  'before_plans',COALESCE(p.before_plans,'[]'::jsonb),'before_summaries',COALESCE(s.before_summaries,'[]'::jsonb))
 FROM (
  SELECT actor_id,operation_id,created_at,result FROM app_private.admin_monthly_bundle_operations
   WHERE actor_id=source_actor AND operation_id=source_operation
  UNION ALL
  SELECT actor_id,operation_id,created_at,result FROM app_private.admin_monthly_plan_operations p
   WHERE actor_id=source_actor AND operation_id=source_operation
    AND NOT EXISTS(SELECT 1 FROM app_private.admin_monthly_bundle_operations b WHERE b.actor_id=p.actor_id AND b.operation_id=p.operation_id)
 ) a
 LEFT JOIN app_private.admin_monthly_plan_operations p USING(actor_id,operation_id)
 LEFT JOIN app_private.admin_monthly_summary_operations s USING(actor_id,operation_id);
$$;
REVOKE ALL ON FUNCTION app_private.admin_monthly_batch(text,uuid) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.admin_monthly_batch_blockers(batch jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entry jsonb;current_plan public.monthly_plans%ROWTYPE;current_summary public.monthly_plan_summaries%ROWTYPE;
 reasons jsonb:='[]';label text;reason text;
BEGIN
 FOR entry IN SELECT value FROM jsonb_array_elements((batch->'plans')||(batch->'summaries')||(batch->'before_plans')||(batch->'before_summaries')) LOOP
  label:=left(entry->>'plan_month',7);IF label IS NULL THEN label:=entry->>'month';END IF;
  label:=label||' · '||(entry->>'line')||' · '||COALESCE(entry->>'owner_name',entry->>'confirmed_name',entry->>'owner_id');
  reason:=NULL;
  IF NOT app_private.can_assign_monthly_plan(COALESCE(entry->>'owner_id',entry->>'confirmed_by'),entry->>'project_id',entry->>'line',entry->>'report_scope_id') THEN reason:='提报人当前授权不完整';
  ELSIF entry->>'report_scope_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.report_scopes s
   WHERE s.id=entry->>'report_scope_id' AND to_jsonb(s.project_ids)=entry->'scope_project_ids') THEN reason:='统一填报范围已变化';END IF;
  IF reason IS NOT NULL THEN reasons:=reasons||jsonb_build_array(label||'：'||reason);END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'plans') LOOP
  SELECT * INTO current_plan FROM public.monthly_plans WHERE id=(entry->>'id')::uuid;
  label:=left(entry->>'plan_month',7)||' · '||(entry->>'line');reason:=NULL;
  IF NOT FOUND THEN reason:='月计划已被后续修改或撤回';
  ELSIF current_plan.project_id IS DISTINCT FROM entry->>'project_id' OR current_plan.confirmed_by IS DISTINCT FROM entry->>'owner_id'
   OR current_plan.line IS DISTINCT FROM entry->>'line' OR current_plan.plan_month IS DISTINCT FROM (entry->>'plan_month')::date
   OR current_plan.report_scope_id IS DISTINCT FROM entry->>'report_scope_id' OR COALESCE(to_jsonb(current_plan.scope_project_ids),'null'::jsonb) IS DISTINCT FROM entry->'scope_project_ids'
   OR current_plan.items IS DISTINCT FROM entry->'items' OR current_plan.rich_text IS DISTINCT FROM entry->'rich_text' THEN reason:='月计划版本或内容已变化';
  ELSIF app_private.monthly_plan_is_referenced(current_plan.id,current_plan.project_id) THEN reason:='已有当前／历史周报或完成／延期申报引用';END IF;
  IF reason IS NOT NULL THEN reasons:=reasons||jsonb_build_array(label||'：'||reason);END IF;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'summaries') LOOP
  SELECT * INTO current_summary FROM public.monthly_plan_summaries WHERE id=(entry->>'id')::uuid;
  label:=(entry->>'month')||' · '||(entry->>'line');reason:=NULL;
  IF NOT FOUND THEN reason:='月度汇总已被后续修改或撤回';
  ELSIF current_summary.project_id IS DISTINCT FROM entry->>'project_id' OR current_summary.owner_id IS DISTINCT FROM entry->>'owner_id'
   OR current_summary.line IS DISTINCT FROM entry->>'line' OR to_char(current_summary.plan_month,'YYYY-MM') IS DISTINCT FROM entry->>'month'
   OR current_summary.report_scope_id IS DISTINCT FROM entry->>'report_scope_id' OR COALESCE(to_jsonb(current_summary.scope_project_ids),'null'::jsonb) IS DISTINCT FROM entry->'scope_project_ids'
   OR current_summary.items IS DISTINCT FROM entry->'items' OR current_summary.version IS DISTINCT FROM (entry->>'version')::int THEN reason:='月度汇总版本或内容已变化';END IF;
  IF reason IS NOT NULL THEN reasons:=reasons||jsonb_build_array(label||'：'||reason);END IF;
 END LOOP;
 RETURN reasons;
END;
$$;
REVOKE ALL ON FUNCTION app_private.admin_monthly_batch_blockers(jsonb) FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.list_admin_monthly_batches(pid text,scope_id text,target_month date,page_number integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entry record;batch jsonb;reasons jsonb;result jsonb:='[]';records jsonb;withdrawal app_private.admin_monthly_batch_withdrawals%ROWTYPE;more boolean:=false;
BEGIN
 IF NOT app_private.has_approved_role(ARRAY['ops']) THEN RAISE EXCEPTION 'Administrator batch history denied' USING ERRCODE='42501';END IF;
 IF pid IS NULL OR target_month IS NULL OR extract(day FROM target_month)<>1 OR page_number IS NULL OR page_number<0 OR page_number>100000 THEN RAISE EXCEPTION '批次查询范围不正确' USING ERRCODE='22023';END IF;
 FOR entry IN
  SELECT a.* FROM (
   SELECT b.actor_id,b.operation_id,b.created_at,b.result FROM app_private.admin_monthly_bundle_operations b
   UNION ALL
   SELECT p.actor_id,p.operation_id,p.created_at,p.result FROM app_private.admin_monthly_plan_operations p
    WHERE NOT EXISTS(SELECT 1 FROM app_private.admin_monthly_bundle_operations b WHERE b.actor_id=p.actor_id AND b.operation_id=p.operation_id)
  ) a WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.result->'plans','[]')||COALESCE(a.result->'summaries','[]')) r
   WHERE r->>'project_id'=pid AND (r->>'report_scope_id') IS NOT DISTINCT FROM scope_id
    AND left(COALESCE(r->>'plan_month',r->>'month'),7)=to_char(target_month,'YYYY-MM'))
  ORDER BY a.created_at DESC,a.actor_id,a.operation_id LIMIT 11 OFFSET page_number*10
 LOOP
  IF jsonb_array_length(result)=10 THEN more:=true;EXIT;END IF;
  batch:=app_private.admin_monthly_batch(entry.actor_id,entry.operation_id);
  SELECT * INTO withdrawal FROM app_private.admin_monthly_batch_withdrawals WHERE source_actor_id=entry.actor_id AND source_operation_id=entry.operation_id;
  reasons:=CASE WHEN FOUND THEN jsonb_build_array('本批次已撤回') ELSE app_private.admin_monthly_batch_blockers(batch) END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',x.kind,'project_id',r->>'project_id','project_name',(SELECT name FROM public.projects WHERE id=r->>'project_id'),'report_scope_id',r->>'report_scope_id',
   'month',left(COALESCE(r->>'plan_month',r->>'month'),7),'line',r->>'line','owner_name',COALESCE(r->>'owner_name',r->>'confirmed_name',r->>'owner_id'),
   'items',jsonb_array_length(r->'items')) ORDER BY r->>'project_id',r->>'line',r->>'owner_id'),'[]') INTO records
   FROM (SELECT 'plan' AS kind,value AS r FROM jsonb_array_elements(batch->'plans') UNION ALL SELECT 'summary',value FROM jsonb_array_elements(batch->'summaries')) x;
  result:=result||jsonb_build_array(jsonb_build_object('actor_id',entry.actor_id,'operation_id',entry.operation_id,'created_at',entry.created_at,
   'actor_name',(SELECT name FROM public.profiles WHERE user_id=entry.actor_id),'records',records,'withdrawn',withdrawal.source_operation_id IS NOT NULL,
   'withdrawn_at',withdrawal.withdrawn_at,'can_withdraw',jsonb_array_length(reasons)=0,'blockers',reasons));
 END LOOP;
 RETURN jsonb_build_object('batches',result,'has_more',more);
END;
$$;
REVOKE ALL ON FUNCTION app_private.list_admin_monthly_batches(text,text,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_admin_monthly_batches(text,text,date,integer) TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.withdraw_admin_monthly_batch(source_actor text,source_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE batch jsonb;entry jsonb;prior jsonb;reasons jsonb;configured app_private.report_scopes%ROWTYPE;
 selected_plan public.monthly_plans%ROWTYPE;restored_plan public.monthly_plans%ROWTYPE;selected_summary public.monthly_plan_summaries%ROWTYPE;
 restored_summary public.monthly_plan_summaries%ROWTYPE;remembered app_private.admin_monthly_batch_withdrawals%ROWTYPE;
 restored_plans jsonb:='[]';restored_summaries jsonb:='[]';result jsonb;owner text;
BEGIN
 PERFORM 1 FROM public.profiles WHERE user_id=auth.uid() AND status='approved' AND role='ops' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Administrator withdrawal denied' USING ERRCODE='42501';END IF;
 IF source_actor IS NULL OR source_operation IS NULL THEN RAISE EXCEPTION '请选择需要撤回的保存批次' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-monthly-operation:'||jsonb_build_array(source_actor,source_operation)::text,0));
 batch:=app_private.admin_monthly_batch(source_actor,source_operation);
 IF batch IS NULL THEN RAISE EXCEPTION '保存批次不存在，请重新读取' USING ERRCODE='P0002',DETAIL='admin_batch_not_found';END IF;
 -- Lock current grants/configuration before the same scope, month and row locks
 -- used by normal confirmation, reporting and administrator bundle saves.
 FOR entry IN SELECT value FROM jsonb_array_elements((batch->'plans')||(batch->'summaries')||(batch->'before_plans')||(batch->'before_summaries'))
  ORDER BY value->>'owner_id',value->>'project_id',value->>'line',COALESCE(value->>'plan_month',value->>'month') LOOP
  owner:=COALESCE(entry->>'owner_id',entry->>'confirmed_by');
  PERFORM 1 FROM public.profiles WHERE user_id=owner FOR SHARE;
  PERFORM 1 FROM public.project_members WHERE user_id=owner ORDER BY project_id FOR SHARE;
  PERFORM 1 FROM public.commercial_module_grants WHERE user_id=owner ORDER BY project_id,line FOR SHARE;
  IF NOT app_private.can_assign_monthly_plan(owner,entry->>'project_id',entry->>'line',entry->>'report_scope_id') THEN RAISE EXCEPTION '提报人当前项目或专业授权不完整，整批未撤回' USING ERRCODE='42501';END IF;
  IF entry->>'report_scope_id' IS NOT NULL THEN
   SELECT * INTO configured FROM app_private.report_scopes WHERE id=entry->>'report_scope_id' FOR SHARE;
   IF NOT FOUND OR to_jsonb(configured.project_ids) IS DISTINCT FROM entry->'scope_project_ids' THEN RAISE EXCEPTION '统一填报范围已变化，整批未撤回' USING ERRCODE='23514',DETAIL='admin_batch_changed';END IF;
  END IF;
 END LOOP;
 SELECT * INTO remembered FROM app_private.admin_monthly_batch_withdrawals WHERE source_actor_id=source_actor AND source_operation_id=source_operation;
 IF FOUND THEN RETURN remembered.result||jsonb_build_object('replayed',true);END IF;
 FOR entry IN SELECT DISTINCT jsonb_build_array(value->>'report_scope_id',left(value->>'plan_month',7)) AS key
  FROM jsonb_array_elements(batch->'plans') WHERE value->>'report_scope_id' IS NOT NULL ORDER BY key LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array(entry->>0,(entry->>1)||'-01')::text,0));
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'plans') ORDER BY value->>'project_id',value->>'line',value->>'plan_month',value->>'owner_id' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(entry->>'project_id',entry->>'line',entry->>'plan_month')::text,0));
  PERFORM 1 FROM public.monthly_plans WHERE id=(entry->>'id')::uuid FOR UPDATE;
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'summaries') ORDER BY value->>'project_id',value->>'line',value->>'month',value->>'owner_id' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-summary:'||jsonb_build_array(entry->>'project_id',entry->>'line',(entry->>'month')||'-01',entry->>'owner_id')::text,0));
  PERFORM 1 FROM public.monthly_plan_summaries WHERE id=(entry->>'id')::uuid FOR UPDATE;
 END LOOP;
 reasons:=app_private.admin_monthly_batch_blockers(batch);
 IF jsonb_array_length(reasons)>0 THEN RAISE EXCEPTION '%；整批未撤回',reasons->>0 USING ERRCODE='23514',DETAIL='admin_batch_changed';END IF;
 -- Delete all current plan versions before restoring any, preserving the
 -- scope-wide item limit even for a replacement at that limit.
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'plans') LOOP
  SELECT * INTO STRICT selected_plan FROM public.monthly_plans WHERE id=(entry->>'id')::uuid;
  INSERT INTO app_private.monthly_plan_withdrawals(plan_id,project_id,line,plan_month,withdrawn_by,snapshot)
   VALUES(selected_plan.id,selected_plan.project_id,selected_plan.line,selected_plan.plan_month,auth.uid(),to_jsonb(selected_plan));
  DELETE FROM public.monthly_plans WHERE id=selected_plan.id;
 END LOOP;
 FOR prior IN SELECT value FROM jsonb_array_elements(batch->'before_plans') LOOP
  INSERT INTO public.monthly_plans(id,project_id,line,plan_month,items,rich_text,confirmed_by,report_scope_id,scope_project_ids)
   VALUES(gen_random_uuid(),prior->>'project_id',prior->>'line',(prior->>'plan_month')::date,prior->'items',prior->'rich_text',prior->>'confirmed_by',prior->>'report_scope_id',
    CASE WHEN prior->>'report_scope_id' IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(prior->'scope_project_ids')) END) RETURNING * INTO restored_plan;
  restored_plans:=restored_plans||jsonb_build_array(to_jsonb(restored_plan)||jsonb_build_object('owner_id',restored_plan.confirmed_by));
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(batch->'summaries') LOOP
  SELECT * INTO STRICT selected_summary FROM public.monthly_plan_summaries WHERE id=(entry->>'id')::uuid;
  DELETE FROM public.monthly_plan_summaries WHERE id=selected_summary.id;
  SELECT value INTO prior FROM jsonb_array_elements(batch->'before_summaries') WHERE value->>'project_id'=entry->>'project_id'
   AND value->>'line'=entry->>'line' AND value->>'owner_id'=entry->>'owner_id' AND left(value->>'plan_month',7)=entry->>'month';
  IF prior IS NOT NULL THEN
   INSERT INTO public.monthly_plan_summaries(id,project_id,report_scope_id,scope_project_ids,line,owner_id,owner_name,plan_month,items,updated_by,version)
    VALUES(gen_random_uuid(),prior->>'project_id',prior->>'report_scope_id',selected_summary.scope_project_ids,prior->>'line',prior->>'owner_id',
     (SELECT name FROM public.profiles WHERE user_id=prior->>'owner_id'),(prior->>'plan_month')::date,prior->'items',auth.uid(),selected_summary.version+1) RETURNING * INTO restored_summary;
   restored_summaries:=restored_summaries||jsonb_build_array((to_jsonb(restored_summary)-'plan_month')||jsonb_build_object('month',to_char(restored_summary.plan_month,'YYYY-MM')));
  END IF;
 END LOOP;
 result:=jsonb_build_object('source_actor_id',source_actor,'source_operation_id',source_operation,'withdrawn',true,'replayed',false,
  'removed_plan_ids',(SELECT COALESCE(jsonb_agg(value->'id'),'[]') FROM jsonb_array_elements(batch->'plans')),
  'removed_summary_ids',(SELECT COALESCE(jsonb_agg(value->'id'),'[]') FROM jsonb_array_elements(batch->'summaries')),
  'plans',restored_plans,'summaries',restored_summaries);
 INSERT INTO app_private.admin_monthly_batch_withdrawals(source_actor_id,source_operation_id,withdrawn_by,result) VALUES(source_actor,source_operation,auth.uid(),result);
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app_private.withdraw_admin_monthly_batch(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.withdraw_admin_monthly_batch(text,uuid) TO app_runtime;

-- Keep the reviewed save implementations intact behind guarded entry points.
-- Neither old browser retries nor direct runtime RPCs can replay a withdrawn
-- operation as a successful save. Internal implementations are not callable.
DO $$ BEGIN
 IF to_regprocedure('app_private.save_admin_monthly_plans_before_withdrawal(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION app_private.save_admin_monthly_plans(uuid,jsonb) RENAME TO save_admin_monthly_plans_before_withdrawal;
 END IF;
 IF to_regprocedure('app_private.save_admin_monthly_plan_bundle_before_withdrawal(uuid,jsonb,jsonb)') IS NULL THEN
  ALTER FUNCTION app_private.save_admin_monthly_plan_bundle(uuid,jsonb,jsonb) RENAME TO save_admin_monthly_plan_bundle_before_withdrawal;
 END IF;
END; $$;
REVOKE ALL ON FUNCTION app_private.save_admin_monthly_plans_before_withdrawal(uuid,jsonb),app_private.save_admin_monthly_plan_bundle_before_withdrawal(uuid,jsonb,jsonb) FROM PUBLIC,app_runtime;
CREATE OR REPLACE FUNCTION app_private.lock_admin_monthly_active_operation(operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app_private.has_approved_role(ARRAY['ops']) THEN RAISE EXCEPTION 'Administrator save denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-monthly-operation:'||jsonb_build_array(auth.uid(),operation)::text,0));
 IF EXISTS(SELECT 1 FROM app_private.admin_monthly_batch_withdrawals WHERE source_actor_id=auth.uid() AND source_operation_id=operation) THEN
  RAISE EXCEPTION '本次保存已被撤回，请重新读取后开始新的导入' USING ERRCODE='23514',DETAIL='monthly_plan_operation_withdrawn';END IF;
END; $$;
REVOKE ALL ON FUNCTION app_private.lock_admin_monthly_active_operation(uuid) FROM PUBLIC,app_runtime;
CREATE OR REPLACE FUNCTION app_private.save_admin_monthly_plans(operation uuid,proposed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM app_private.lock_admin_monthly_active_operation(operation);
 RETURN app_private.save_admin_monthly_plans_before_withdrawal(operation,proposed);
END; $$;
CREATE OR REPLACE FUNCTION app_private.save_admin_monthly_plan_bundle(operation uuid,plans jsonb,summaries jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM app_private.lock_admin_monthly_active_operation(operation);
 RETURN app_private.save_admin_monthly_plan_bundle_before_withdrawal(operation,plans,summaries);
END; $$;
REVOKE ALL ON FUNCTION app_private.save_admin_monthly_plans(uuid,jsonb),app_private.save_admin_monthly_plan_bundle(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.save_admin_monthly_plans(uuid,jsonb),app_private.save_admin_monthly_plan_bundle(uuid,jsonb,jsonb) TO app_runtime;
COMMIT;
