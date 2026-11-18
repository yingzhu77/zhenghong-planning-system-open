BEGIN;

-- Persist emphasis in the existing JSON envelopes. Confirmed monthly plans
-- keep their fixed strings and earlier formatting when adding weekly items.
CREATE OR REPLACE FUNCTION app_private.append_weekly_collaboration_monthly_items(
 pid text,module text,scope_id text,target_week date,confirmed_id uuid,expected_revision integer,publish_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected public.monthly_plans%ROWTYPE; draft app_private.weekly_collaboration_drafts%ROWTYPE;
 target_month date:=date_trunc('month',target_week)::date; combined jsonb; appended_formats jsonb; shared_row app_private.collaboration_monthly_drafts%ROWTYPE;
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
 SELECT selected.items||jsonb_agg(item-'rich_text' ORDER BY pos) INTO combined
  FROM jsonb_array_elements(draft.supplement_items) WITH ORDINALITY AS rows(item,pos);
 SELECT jsonb_object_agg('items.'||(jsonb_array_length(selected.items)+pos-1)||'.'||key,value) INTO appended_formats
  FROM jsonb_array_elements(draft.supplement_items) WITH ORDINALITY AS rows(item,pos)
  CROSS JOIN LATERAL jsonb_each(COALESCE(item->'rich_text'->'fields','{}'::jsonb));
 PERFORM set_config('app.weekly_collaboration_append_plan',selected.id::text,true);
 UPDATE public.monthly_plans SET items=combined,supplement_revision=supplement_revision+1,
  rich_text=CASE WHEN appended_formats IS NULL THEN selected.rich_text ELSE jsonb_build_object(
    'v',1,'fields',COALESCE(selected.rich_text->'fields','{}'::jsonb)||appended_formats) END
  WHERE id=selected.id;
 PERFORM set_config('app.weekly_collaboration_append_plan','',true);
 IF shared_row.id IS NOT NULL THEN
  UPDATE app_private.collaboration_monthly_drafts SET items=combined,revision=revision+1 WHERE id=shared_row.id;
 END IF;
 UPDATE app_private.weekly_collaboration_drafts d SET supplement_items='[]'::jsonb
  WHERE (d.project_id,d.line,d.week)=(pid,module,target_week);
END;
$$;

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
   OR (to_jsonb(NEW)-ARRAY['items','supplement_revision','rich_text']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['items','supplement_revision','rich_text'])
   OR (NEW.rich_text IS DISTINCT FROM OLD.rich_text AND (
      NOT COALESCE(NEW.rich_text->'fields' @> COALESCE(OLD.rich_text->'fields','{}'::jsonb),false)
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.rich_text->'fields') AS k(key)
        WHERE NOT COALESCE(OLD.rich_text->'fields' ? key,false)
          AND (key!~'^items\.[0-9]{1,3}\.(mod|name)$' OR
            split_part(key,'.',2)::int NOT BETWEEN jsonb_array_length(OLD.items) AND jsonb_array_length(NEW.items)-1))))
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
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['source_id','mod','name','due','progress','rich_text']<>'{}'::jsonb
    OR item?'rich_text' AND jsonb_typeof(item->'rich_text') IS DISTINCT FROM 'object'
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

CREATE OR REPLACE FUNCTION app_private.guard_reporter_task()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE operator boolean; leader boolean; assignee record; proposer record; validate_proposer boolean;
BEGIN
    IF current_user<>'app_runtime' THEN RETURN NEW; END IF;
    operator:=app_private.has_approved_role(ARRAY['ops']);
    leader:=app_private.has_approved_role(ARRAY['president','pzo']);
    IF TG_OP='INSERT' THEN
        IF NEW.meeting_kind NOT IN ('requirement','special') THEN RAISE EXCEPTION 'Choose a new meeting category' USING ERRCODE='42501'; END IF;
        IF NOT operator AND NOT (leader AND NEW.meeting_kind='requirement' AND NEW.proposer_id=auth.uid()) THEN
            RAISE EXCEPTION 'Only operators enter decisions; leaders enter their own requirements' USING ERRCODE='42501';
        END IF;
        NEW.created_by:=auth.uid(); NEW.created_at:=now(); NEW.revision:=1; NEW.history:='[]'::jsonb; NEW.completed_at:=NULL;
        IF NEW.status NOT IN ('open','in_progress') THEN RAISE EXCEPTION 'Use the completion approval workflow' USING ERRCODE='42501'; END IF;
        validate_proposer:=true;
    ELSE
        IF (to_jsonb(NEW)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text','meeting_kind','proposer_id','proposer_role','proposer_name'])
           IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['owner_id','owner_name','title','what','due','status','progress','rich_text','meeting_kind','proposer_id','proposer_role','proposer_name']) THEN
            RAISE EXCEPTION 'Meeting identity and audit fields are immutable' USING ERRCODE='42501';
        END IF;
        IF NOT operator THEN
            IF app_private.has_approved_role(ARRAY['pm']) THEN
                IF OLD.owner_id<>auth.uid()
                  OR (to_jsonb(NEW)-ARRAY['progress','status','rich_text']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['progress','status','rich_text'])
                  OR (NEW.rich_text->'fields'->'what') IS DISTINCT FROM (OLD.rich_text->'fields'->'what')
                  OR (NEW.rich_text->'fields'->'title') IS DISTINCT FROM (OLD.rich_text->'fields'->'title') THEN
                    RAISE EXCEPTION 'Reporter may update only assigned progress' USING ERRCODE='42501';
                END IF;
            ELSIF NOT leader OR OLD.meeting_kind<>'requirement' OR OLD.proposer_id<>auth.uid()
              OR ROW(NEW.meeting_kind,NEW.proposer_id,NEW.proposer_role,NEW.proposer_name) IS DISTINCT FROM ROW(OLD.meeting_kind,OLD.proposer_id,OLD.proposer_role,OLD.proposer_name) THEN
                RAISE EXCEPTION 'Leader may maintain only their own requirements' USING ERRCODE='42501';
            END IF;
        END IF;
        IF NEW.status NOT IN ('open','in_progress') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Use the completion approval workflow' USING ERRCODE='42501';
        END IF;
        IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
            NEW.status:='open'; NEW.progress:=''; NEW.completed_at:=NULL;
            IF NEW.rich_text->'fields' ?| ARRAY['what','title'] THEN
                NEW.rich_text:=jsonb_build_object('v',1,'fields',(NEW.rich_text->'fields')-'progress');
            ELSE NEW.rich_text:='{}'::jsonb; END IF;
        END IF;
        validate_proposer:=NEW.proposer_id IS DISTINCT FROM OLD.proposer_id OR NEW.meeting_kind IS DISTINCT FROM OLD.meeting_kind;
        IF NOT validate_proposer AND ROW(NEW.proposer_role,NEW.proposer_name) IS DISTINCT FROM ROW(OLD.proposer_role,OLD.proposer_name) THEN
            RAISE EXCEPTION 'Proposer identity is derived from the project people directory' USING ERRCODE='42501';
        END IF;
        NEW.revision:=OLD.revision+1;
        NEW.history:=OLD.history || jsonb_build_array(jsonb_build_object('at',now(),'by',auth.uid(),'data',to_jsonb(OLD)-'history'));
    END IF;
    IF NEW.meeting_kind='requirement' AND NEW.proposer_id IS NULL THEN
        RAISE EXCEPTION 'Meeting requirements need a named leader' USING ERRCODE='42501';
    END IF;
    IF validate_proposer THEN
        IF NEW.proposer_id IS NULL THEN NEW.proposer_name:=NULL; NEW.proposer_role:=NULL;
        ELSE
            SELECT * INTO proposer FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.proposer_id AND p.role IN ('president','pzo');
            IF NOT FOUND THEN RAISE EXCEPTION 'Proposer must be an active project leader' USING ERRCODE='42501'; END IF;
            NEW.proposer_role:=proposer.role; NEW.proposer_name:=proposer.name;
        END IF;
    END IF;
    IF operator OR leader THEN
        SELECT * INTO assignee FROM app_private.project_people(NEW.project_id) p WHERE p.user_id=NEW.owner_id AND p.role='pm';
        IF NOT FOUND THEN RAISE EXCEPTION 'Assignee must be an active project reporter' USING ERRCODE='42501'; END IF;
        NEW.owner_name:=assignee.name;
    END IF;
    NEW.updated_at:=now();
    RETURN NEW;
END;
$$;

COMMIT;
