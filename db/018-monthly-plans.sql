-- Monthly confirmation is independent of weekly reporting. Existing reports
-- and approvals remain historical snapshots; this upgrade backfills nothing.
BEGIN;
CREATE TABLE IF NOT EXISTS public.monthly_plans (
    id uuid PRIMARY KEY,
    project_id text NOT NULL REFERENCES public.projects(id),
    line text NOT NULL CHECK(line=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采'])),
    plan_month date NOT NULL CHECK(extract(day FROM plan_month)=1),
    items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=500),
    rich_text jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(rich_text)='object'),
    confirmed_by text NOT NULL REFERENCES public.profiles(user_id),
    confirmed_name text NOT NULL,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id,line,plan_month)
);
ALTER TABLE public.monthly_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monthly_plans FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT ON public.monthly_plans TO app_runtime;
DROP POLICY IF EXISTS monthly_plans_read ON public.monthly_plans;
CREATE POLICY monthly_plans_read ON public.monthly_plans FOR SELECT TO app_runtime
    USING(app_private.can_read_project(project_id));
DROP POLICY IF EXISTS monthly_plans_insert ON public.monthly_plans;
CREATE POLICY monthly_plans_insert ON public.monthly_plans FOR INSERT TO app_runtime
    WITH CHECK(app_private.can_write_report(project_id,line,auth.uid())
      AND confirmed_by=auth.uid() AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id AND p.project_type='com'));

CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; item jsonb; ids text[]:='{}';
BEGIN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '月度计划确认后不可修改或删除' USING ERRCODE='42501'; END IF;
    SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
    IF actor.status IS DISTINCT FROM 'approved' OR actor.role<>'pm'
      OR NOT app_private.can_write_report(NEW.project_id,NEW.line,auth.uid())
      OR NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=NEW.project_id AND p.project_type='com') THEN
        RAISE EXCEPTION 'Monthly plan confirmation denied' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(NEW.project_id,NEW.line,to_char(NEW.plan_month,'YYYY-MM-DD'))::text,0));
    IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.items)>500 THEN
        RAISE EXCEPTION '月度计划须为最多500项的列表' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item->>'source_id') IS NULL
          OR (item->>'source_id')!~'^[A-Za-z0-9_-]{1,200}$' OR (item->>'source_id')=ANY(ids)
          OR jsonb_typeof(item->'mod') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR btrim(item->>'name')=''
          OR jsonb_typeof(item->'due') IS DISTINCT FROM 'string'
          OR (item-ARRAY['source_id','mod','name','due'])<>'{}'::jsonb THEN
            RAISE EXCEPTION '月度计划事项标识或左三列内容不正确' USING ERRCODE='23514';
        END IF;
        ids:=array_append(ids,item->>'source_id');
    END LOOP;
    NEW.confirmed_by:=auth.uid(); NEW.confirmed_name:=actor.name; NEW.confirmed_at:=now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_monthly_plan() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_monthly_plan ON public.monthly_plans;
CREATE TRIGGER guard_monthly_plan BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_plans
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_monthly_plan();

-- Resolve the actual Monday, then its month. Legacy week labels use the
-- original submission timestamp, never the timestamp of a later resubmission.
CREATE OR REPLACE FUNCTION app_private.report_month_start(label text,reference_at timestamptz)
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
        RETURN make_date(extract(year FROM candidate)::integer,extract(month FROM candidate)::integer,1);
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
    RETURN CASE WHEN best IS NULL THEN NULL ELSE make_date(extract(year FROM best)::integer,extract(month FROM best)::integer,1) END;
END;
$$;

-- Adjacent equal rich runs and unformatted text have the same signature. A
-- historical malformed format is compared exactly, rather than rewritten.
CREATE OR REPLACE FUNCTION app_private.monthly_name_runs(plain_text text,doc jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb; attrs jsonb; runs jsonb:='[]'; content text:=''; count integer; previous jsonb;
BEGIN
    IF doc IS NULL THEN RETURN jsonb_build_array(jsonb_build_object('insert',COALESCE(plain_text,''),'attributes','{}'::jsonb)); END IF;
    IF jsonb_typeof(doc->'ops') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('invalid',doc,'text',plain_text); END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(doc->'ops') LOOP
        IF jsonb_typeof(item->'insert') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('invalid',doc,'text',plain_text); END IF;
        IF item->>'insert'='' THEN CONTINUE; END IF;
        attrs:=COALESCE(item->'attributes','{}'::jsonb); content:=content||(item->>'insert'); count:=jsonb_array_length(runs);
        previous:=CASE WHEN count>0 THEN runs->(count-1) ELSE NULL END;
        IF count>0 AND previous->'attributes'=attrs THEN
            runs:=jsonb_set(runs,ARRAY[(count-1)::text],jsonb_build_object('insert',(previous->>'insert')||(item->>'insert'),'attributes',attrs));
        ELSE runs:=runs||jsonb_build_array(jsonb_build_object('insert',item->>'insert','attributes',attrs)); END IF;
    END LOOP;
    IF content IS DISTINCT FROM COALESCE(plain_text,'') THEN RETURN jsonb_build_object('invalid',doc,'text',plain_text); END IF;
    IF runs='[]'::jsonb THEN RETURN jsonb_build_array(jsonb_build_object('insert','','attributes','{}'::jsonb)); END IF;
    RETURN runs;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.monthly_items_unchanged(
    proposed jsonb,baseline jsonb,proposed_rich jsonb,baseline_rich jsonb,baseline_prefix text,strict_ids boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i integer; left_item jsonb; right_item jsonb; total integer;
BEGIN
    IF jsonb_typeof(proposed) IS DISTINCT FROM 'array' OR jsonb_typeof(baseline) IS DISTINCT FROM 'array'
      OR jsonb_array_length(proposed)<>jsonb_array_length(baseline) THEN RETURN false; END IF;
    total:=jsonb_array_length(baseline); IF total=0 THEN RETURN true; END IF;
    FOR i IN 0..total-1 LOOP
        left_item:=proposed->i; right_item:=baseline->i;
        IF jsonb_typeof(left_item) IS DISTINCT FROM 'object' OR jsonb_typeof(right_item) IS DISTINCT FROM 'object'
          OR COALESCE(left_item->>'mod','') IS DISTINCT FROM COALESCE(right_item->>'mod','')
          OR COALESCE(left_item->>'name','') IS DISTINCT FROM COALESCE(right_item->>'name','')
          OR COALESCE(left_item->>'due','') IS DISTINCT FROM COALESCE(right_item->>'due','')
          OR ((strict_ids OR COALESCE(right_item->>'source_id','')<>'') AND left_item->>'source_id' IS DISTINCT FROM right_item->>'source_id')
          OR app_private.monthly_name_runs(left_item->>'name',proposed_rich->'fields'->('biz.items.'||i||'.name'))
            IS DISTINCT FROM app_private.monthly_name_runs(right_item->>'name',baseline_rich->'fields'->(baseline_prefix||'.'||i||'.name')) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.validate_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid text:=proposed->>'project_id'; module text:=proposed->>'line'; target_month date;
    selected public.monthly_plans%ROWTYPE; new_id text:=COALESCE(proposed->'biz'->>'monthly_plan_id','');
    old_id text:=COALESCE(prior->'biz'->>'monthly_plan_id',''); reference_at timestamptz;
BEGIN
    IF NOT app_private.can_write_report(pid,module,auth.uid()) THEN RAISE EXCEPTION 'Monthly report denied' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=pid AND p.project_type='com') THEN RETURN true; END IF;
    reference_at:=COALESCE((prior->>'submitted_at')::timestamptz,now());
    target_month:=app_private.report_month_start(proposed->>'period',reference_at);
    IF old_id<>'' AND new_id IS DISTINCT FROM old_id THEN RAISE EXCEPTION '月度计划引用不可删除或调换，请刷新确认版' USING ERRCODE='23514'; END IF;
    IF target_month IS NULL THEN
        IF prior IS NOT NULL AND old_id='' AND new_id='' AND app_private.monthly_items_unchanged(
          proposed->'biz'->'items',prior->'biz'->'items',proposed->'rich_text',prior->'rich_text','biz.items',false) THEN RETURN true; END IF;
        IF EXISTS(SELECT 1 FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module) THEN
            RAISE EXCEPTION '月度计划无法匹配报告周，请使用带日期范围的报告周期' USING ERRCODE='23514'; END IF;
        IF new_id<>'' THEN RAISE EXCEPTION '月度计划引用与报告周期不匹配' USING ERRCODE='23514'; END IF;
        RETURN true;
    END IF;
    -- Serialize confirmation with a report that observes no confirmed row.
    -- A row lock alone cannot protect that absent-row case.
    PERFORM pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array(pid,module,to_char(target_month,'YYYY-MM-DD'))::text,0));
    SELECT * INTO selected FROM public.monthly_plans p WHERE p.project_id=pid AND p.line=module AND p.plan_month=target_month FOR SHARE;
    IF NOT FOUND THEN
        IF new_id<>'' THEN RAISE EXCEPTION '月度计划引用与报告周所属月份不匹配' USING ERRCODE='23514'; END IF;
        RETURN true;
    END IF;
    -- Reports submitted before this confirmation keep their original snapshot.
    -- Their left columns cannot change; progress and blockers may still update.
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
REVOKE ALL ON FUNCTION app_private.report_month_start(text,timestamptz),app_private.monthly_name_runs(text,jsonb),
    app_private.monthly_items_unchanged(jsonb,jsonb,jsonb,jsonb,text,boolean),app_private.validate_monthly_report(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.report_month_start(text,timestamptz),app_private.monthly_name_runs(text,jsonb),
    app_private.monthly_items_unchanged(jsonb,jsonb,jsonb,jsonb,text,boolean),app_private.validate_monthly_report(jsonb,jsonb) TO app_runtime;
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
              WHERE r.project_id=NEW.project_id AND r.period=NEW.period AND r.line=NEW.line FOR SHARE;
        END IF;
        PERFORM app_private.validate_monthly_report(to_jsonb(NEW),previous);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_report_monthly_plan() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_report_monthly_plan ON public.reports;
CREATE TRIGGER guard_report_monthly_plan BEFORE INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_report_monthly_plan();

-- Extend 017's exact lock authority only after the monthly table exists.
CREATE OR REPLACE FUNCTION app_private.lock_completion_source(target_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item public.completion_requests%ROWTYPE;
BEGIN
    SELECT * INTO item FROM public.completion_requests WHERE id=target_request_id;
    IF NOT FOUND OR NOT app_private.can_review_completion(item.kind,item.source_key,item.project_id,item.report_id) THEN
        RAISE EXCEPTION 'Completion source lock denied' USING ERRCODE='42501';
    END IF;
    IF item.kind='milestone' THEN
        PERFORM 1 FROM public.milestones WHERE id=item.source_id::bigint AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='leader' THEN
        PERFORM 1 FROM public.leader_notes WHERE id=item.source_id::uuid AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='meeting' THEN
        PERFORM 1 FROM public.reporter_tasks WHERE id=item.source_id::uuid AND project_id=item.project_id AND owner_id=item.owner_id FOR SHARE;
    ELSIF item.kind='coord' AND array_length(string_to_array(item.source_key,':'),1)=3 THEN
        PERFORM 1 FROM public.coordination_tasks WHERE id::text=split_part(item.source_key,':',3) AND project_id=item.project_id FOR SHARE;
    ELSIF item.kind='plan' AND split_part(item.source_key,':',1)='monthly' THEN
        PERFORM 1 FROM public.monthly_plans WHERE id::text=split_part(item.source_key,':',3) AND project_id=item.project_id FOR SHARE;
    ELSE
        PERFORM 1 FROM public.reports WHERE id=item.report_id AND project_id=item.project_id FOR SHARE;
    END IF;
    RETURN FOUND;
END;
$$;
COMMIT;
