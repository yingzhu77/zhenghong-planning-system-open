-- Independent imported month results. Never a weekly report or approval.
BEGIN;
CREATE TABLE IF NOT EXISTS public.monthly_plan_summaries (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES public.projects(id),
 report_scope_id text REFERENCES app_private.report_scopes(id),
 scope_project_ids text[],
 line text NOT NULL,
 owner_id text NOT NULL REFERENCES public.profiles(user_id),
 owner_name text NOT NULL,
 plan_month date NOT NULL CHECK(extract(day FROM plan_month)=1),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=500 AND length(items::text)<=1000000),
 updated_by text NOT NULL REFERENCES public.profiles(user_id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 UNIQUE(project_id,line,plan_month,owner_id),
 CHECK((report_scope_id IS NULL)=(scope_project_ids IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS monthly_plan_summaries_scope_unique
 ON public.monthly_plan_summaries(report_scope_id,line,plan_month,owner_id) WHERE report_scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS monthly_plan_summaries_month ON public.monthly_plan_summaries(plan_month,project_id);
ALTER TABLE public.monthly_plan_summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monthly_plan_summaries FROM PUBLIC,app_runtime;
GRANT SELECT ON public.monthly_plan_summaries TO app_runtime;
DROP POLICY IF EXISTS monthly_plan_summaries_read ON public.monthly_plan_summaries;
CREATE POLICY monthly_plan_summaries_read ON public.monthly_plan_summaries FOR SELECT TO app_runtime USING(
 CASE WHEN report_scope_id IS NULL THEN app_private.can_read_project(project_id)
 ELSE app_private.can_read_report_scope(scope_project_ids) END OR app_private.management_read_enabled());

CREATE TABLE IF NOT EXISTS app_private.admin_monthly_summary_operations (
 actor_id text NOT NULL REFERENCES public.profiles(user_id),operation_id uuid NOT NULL,
 request jsonb NOT NULL,before_summaries jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,operation_id));
CREATE TABLE IF NOT EXISTS app_private.admin_monthly_bundle_operations (
 actor_id text NOT NULL REFERENCES public.profiles(user_id),operation_id uuid NOT NULL,
 request jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,operation_id));
REVOKE ALL ON app_private.admin_monthly_summary_operations,app_private.admin_monthly_bundle_operations FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.save_admin_monthly_summaries(operation uuid,proposed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE remembered app_private.admin_monthly_summary_operations%ROWTYPE;
 selected public.monthly_plan_summaries%ROWTYPE;inserted public.monthly_plan_summaries%ROWTYPE;
 configured app_private.report_scopes%ROWTYPE;entry jsonb;item jsonb;expected uuid;
 pid text;module text;owner text;scope_id text;target_month date;owner_label text;
 identity text;seen text[]:='{}';ids text[];snapshots jsonb:='[]';results jsonb:='[]';next_version integer;
BEGIN
 PERFORM 1 FROM public.profiles WHERE user_id=auth.uid() AND role='ops' AND status='approved' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Administrator summary import denied' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR jsonb_typeof(proposed) IS DISTINCT FROM 'array' OR jsonb_array_length(proposed)<1 OR jsonb_array_length(proposed)>100 THEN
  RAISE EXCEPTION '月度汇总须为1至100份' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-monthly-summary-operation:'||jsonb_build_array(auth.uid(),operation)::text,0));
 -- Current authorizations are checked even for an idempotent replay.
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) ORDER BY value->>'owner_id',value->>'project_id',value->>'line',value->>'month' LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
   OR entry-ARRAY['project_id','report_scope_id','line','owner_id','month','items','expected_summary_id']<>'{}'::jsonb
   OR NOT entry?'expected_summary_id' OR jsonb_typeof(entry->'expected_summary_id') NOT IN ('null','string')
   OR jsonb_typeof(entry->'month') IS DISTINCT FROM 'string' OR entry->>'month'!~'^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'
   OR jsonb_typeof(entry->'project_id') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'line') IS DISTINCT FROM 'string'
   OR entry?'report_scope_id' AND jsonb_typeof(entry->'report_scope_id') NOT IN ('null','string')
   OR jsonb_typeof(entry->'owner_id') IS DISTINCT FROM 'string'
   OR jsonb_typeof(entry->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(entry->'items')>500 OR length((entry->'items')::text)>1000000 THEN
   RAISE EXCEPTION '月度汇总内容不正确' USING ERRCODE='22023'; END IF;
  pid:=entry->>'project_id';module:=entry->>'line';owner:=entry->>'owner_id';scope_id:=entry->>'report_scope_id';target_month:=((entry->>'month')||'-01')::date;
  identity:=jsonb_build_array(pid,module,target_month,owner)::text;
  IF identity=ANY(seen) THEN RAISE EXCEPTION '同一提报人同月专业汇总不能重复提交' USING ERRCODE='22023'; END IF;seen:=array_append(seen,identity);
  PERFORM 1 FROM public.profiles WHERE user_id=owner FOR SHARE;
  PERFORM 1 FROM public.project_members WHERE user_id=owner ORDER BY project_id FOR SHARE;
  PERFORM 1 FROM public.projects WHERE id=pid FOR SHARE;
  IF NOT app_private.can_assign_monthly_plan(owner,pid,module,scope_id) THEN RAISE EXCEPTION '目标提报人没有此项目或专业授权' USING ERRCODE='42501'; END IF;
  IF scope_id IS NOT NULL THEN
   SELECT * INTO configured FROM app_private.report_scopes WHERE id=scope_id FOR SHARE;
   IF NOT FOUND OR configured.anchor_project_id<>pid OR target_month<date_trunc('month',configured.effective_week)::date THEN
    RAISE EXCEPTION '月度汇总统一范围尚未生效或不正确' USING ERRCODE='42501'; END IF;
  END IF;
  ids:='{}';
  FOR item IN SELECT value FROM jsonb_array_elements(entry->'items') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['source_id','mod','name','due','progress']<>'{}'::jsonb
    OR jsonb_typeof(item->'source_id') IS DISTINCT FROM 'string' OR item->>'source_id'!~'^[A-Za-z0-9_-]{1,200}$' OR (item->>'source_id')=ANY(ids)
    OR jsonb_typeof(item->'mod') IS DISTINCT FROM 'string' OR length(item->>'mod')>200
    OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR btrim(item->>'name')='' OR length(item->>'name')>10000
    OR jsonb_typeof(item->'progress') IS DISTINCT FROM 'string' OR length(item->>'progress')>10000
    OR jsonb_typeof(item->'due') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION '月度汇总事项不正确' USING ERRCODE='22023'; END IF;
   IF item->>'due'<>'' AND ((item->>'due')!~'^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char((item->>'due')::date,'YYYY-MM-DD') IS DISTINCT FROM item->>'due') THEN
    RAISE EXCEPTION '月度汇总原计划日期不正确' USING ERRCODE='22023'; END IF;
   ids:=array_append(ids,item->>'source_id');
  END LOOP;
 END LOOP;
 SELECT * INTO remembered FROM app_private.admin_monthly_summary_operations WHERE actor_id=auth.uid() AND operation_id=operation;
 IF FOUND THEN
  IF remembered.request IS DISTINCT FROM proposed THEN RAISE EXCEPTION '同一次保存标识不能提交不同内容' USING ERRCODE='23514',DETAIL='monthly_summary_operation_conflict'; END IF;
  RETURN remembered.result||jsonb_build_object('replayed',true);
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(proposed) ORDER BY value->>'project_id',value->>'line',value->>'month',value->>'owner_id' LOOP
  pid:=entry->>'project_id';module:=entry->>'line';owner:=entry->>'owner_id';scope_id:=entry->>'report_scope_id';target_month:=((entry->>'month')||'-01')::date;expected:=(entry->>'expected_summary_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-summary:'||jsonb_build_array(pid,module,target_month,owner)::text,0));
  SELECT * INTO selected FROM public.monthly_plan_summaries WHERE project_id=pid AND line=module AND plan_month=target_month AND owner_id=owner FOR UPDATE;
  IF (FOUND AND (selected.id IS DISTINCT FROM expected OR selected.report_scope_id IS DISTINCT FROM scope_id)) OR (NOT FOUND AND expected IS NOT NULL) THEN
   RAISE EXCEPTION '月度汇总已被其他管理员更新，请重新读取后保存' USING ERRCODE='P0002',DETAIL='monthly_summary_changed'; END IF;
  next_version:=COALESCE(selected.version,0)+1;
  IF selected.id IS NOT NULL THEN snapshots:=snapshots||jsonb_build_array(to_jsonb(selected));DELETE FROM public.monthly_plan_summaries WHERE id=selected.id; END IF;
  IF NOT app_private.can_assign_monthly_plan(owner,pid,module,scope_id) THEN RAISE EXCEPTION '目标专业授权已变化' USING ERRCODE='42501'; END IF;
  IF scope_id IS NOT NULL THEN SELECT * INTO configured FROM app_private.report_scopes WHERE id=scope_id; END IF;
  SELECT name INTO owner_label FROM public.profiles WHERE user_id=owner;
  INSERT INTO public.monthly_plan_summaries(id,project_id,report_scope_id,scope_project_ids,line,owner_id,owner_name,plan_month,items,updated_by,version)
   VALUES(gen_random_uuid(),pid,scope_id,CASE WHEN scope_id IS NULL THEN NULL ELSE configured.project_ids END,module,owner,owner_label,target_month,entry->'items',auth.uid(),next_version) RETURNING * INTO inserted;
  results:=results||jsonb_build_array((to_jsonb(inserted)-'plan_month')||jsonb_build_object('month',to_char(inserted.plan_month,'YYYY-MM')));
 END LOOP;
 results:=jsonb_build_object('operation_id',operation,'summaries',results,'replayed',false);
 INSERT INTO app_private.admin_monthly_summary_operations(actor_id,operation_id,request,before_summaries,result) VALUES(auth.uid(),operation,proposed,snapshots,results);
 RETURN results;
END;
$$;
-- Only the bundle command exposes this helper. A direct summary call cannot
-- race the complete-batch operation identity or commit one half separately.
REVOKE ALL ON FUNCTION app_private.save_admin_monthly_summaries(uuid,jsonb) FROM PUBLIC,app_runtime;

-- One operation covers both halves; partial success and changed-body replay
-- must not silently create a plan or overwrite a month result.
CREATE OR REPLACE FUNCTION app_private.save_admin_monthly_plan_bundle(operation uuid,plans jsonb,summaries jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE remembered app_private.admin_monthly_bundle_operations%ROWTYPE;request jsonb;entry jsonb;
 plan_result jsonb;summary_result jsonb;result jsonb;
BEGIN
 PERFORM 1 FROM public.profiles WHERE user_id=auth.uid() AND role='ops' AND status='approved' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Administrator monthly import denied' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR jsonb_typeof(plans) IS DISTINCT FROM 'array' OR jsonb_typeof(summaries) IS DISTINCT FROM 'array'
  OR jsonb_array_length(plans)>100 OR jsonb_array_length(summaries)>100 OR jsonb_array_length(plans)+jsonb_array_length(summaries)=0 THEN
  RAISE EXCEPTION '请选择需要保存的月计划或月度汇总' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-monthly-operation:'||jsonb_build_array(auth.uid(),operation)::text,0));
 request:=jsonb_build_object('plans',plans,'summaries',summaries);
 FOR entry IN SELECT value FROM jsonb_array_elements(plans||summaries) LOOP
  IF NOT app_private.can_assign_monthly_plan(entry->>'owner_id',entry->>'project_id',entry->>'line',entry->>'report_scope_id')
   OR EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE s.id=entry->>'report_scope_id' AND ((entry->>'month')||'-01')::date<date_trunc('month',s.effective_week)::date) THEN
   RAISE EXCEPTION '目标提报人当前授权或月份范围不正确' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT * INTO remembered FROM app_private.admin_monthly_bundle_operations WHERE actor_id=auth.uid() AND operation_id=operation;
 IF FOUND THEN
  IF remembered.request IS DISTINCT FROM request THEN RAISE EXCEPTION '同一次保存标识不能提交不同内容' USING ERRCODE='23514',DETAIL='monthly_summary_operation_conflict'; END IF;
  RETURN remembered.result||jsonb_build_object('replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM app_private.admin_monthly_plan_operations WHERE actor_id=auth.uid() AND operation_id=operation)
  OR EXISTS(SELECT 1 FROM app_private.admin_monthly_summary_operations WHERE actor_id=auth.uid() AND operation_id=operation) THEN
  RAISE EXCEPTION '保存标识已被另一份请求使用，请重新确认' USING ERRCODE='23514',DETAIL='monthly_summary_operation_conflict'; END IF;
 plan_result:=CASE WHEN jsonb_array_length(plans)>0 THEN app_private.save_admin_monthly_plans(operation,plans) ELSE jsonb_build_object('plans','[]'::jsonb) END;
 summary_result:=CASE WHEN jsonb_array_length(summaries)>0 THEN app_private.save_admin_monthly_summaries(operation,summaries) ELSE jsonb_build_object('summaries','[]'::jsonb) END;
 result:=jsonb_build_object('operation_id',operation,'plans',plan_result->'plans','summaries',summary_result->'summaries','replayed',false);
 INSERT INTO app_private.admin_monthly_bundle_operations(actor_id,operation_id,request,result) VALUES(auth.uid(),operation,request,result);
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app_private.save_admin_monthly_plan_bundle(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.save_admin_monthly_plan_bundle(uuid,jsonb,jsonb) TO app_runtime;
COMMIT;
