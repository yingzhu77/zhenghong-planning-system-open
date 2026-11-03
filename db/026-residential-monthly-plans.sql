-- Independent residential discipline plans reuse monthly confirmation and
-- weekly feedback. Existing comprehensive/scope reports and business rows stay.
BEGIN;
ALTER TABLE public.monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_line_check;
ALTER TABLE public.monthly_plans ADD CONSTRAINT monthly_plans_line_check CHECK(line=ANY(ARRAY[
 '土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程',
 '开发','建筑结构设计','机电设计','精装设计','成本','招采','开发报建','设计','工程','营销','商管运营','客服','财务']));
CREATE OR REPLACE FUNCTION app_private.can_write_report(
    target_project_id text, target_line text, target_author_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT target_author_id = auth.uid()
      AND app_private.can_read_project(target_project_id)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        JOIN public.projects pr ON pr.id = target_project_id
        WHERE p.user_id = auth.uid() AND p.role = 'pm' AND p.status = 'approved'
          AND CASE WHEN pr.project_type = 'com'
            THEN target_line = ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程',
                '幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采'])
              AND (p.biz_line = '*' OR target_line = p.biz_line)
            ELSE target_line = '综合' OR (target_line=p.discipline AND target_line=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务']))
          END
      );
$$;

CREATE OR REPLACE FUNCTION app_private.can_confirm_monthly_scope(pid text,module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.can_write_report(pid,module,auth.uid()) AND EXISTS(
   SELECT 1 FROM public.projects p WHERE p.id=pid AND (p.project_type='com' OR
    (module<>'综合' AND NOT EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE pid=ANY(s.project_ids)))));
$$;
REVOKE ALL ON FUNCTION app_private.can_confirm_monthly_scope(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_confirm_monthly_scope(text,text) TO app_runtime;
DROP POLICY IF EXISTS monthly_plans_insert ON public.monthly_plans;
CREATE POLICY monthly_plans_insert ON public.monthly_plans FOR INSERT TO app_runtime
 WITH CHECK(confirmed_by=auth.uid() AND app_private.can_confirm_monthly_scope(project_id,line));

CREATE OR REPLACE FUNCTION app_private.guard_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor public.profiles%ROWTYPE; item jsonb; ids text[]:='{}';
BEGIN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '月度计划确认后不可修改或删除' USING ERRCODE='42501'; END IF;
    SELECT * INTO actor FROM public.profiles WHERE user_id=auth.uid();
    IF actor.status IS DISTINCT FROM 'approved' OR actor.role<>'pm'
      OR NOT app_private.can_write_report(NEW.project_id,NEW.line,auth.uid())
      OR NOT app_private.can_confirm_monthly_scope(NEW.project_id,NEW.line) THEN
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

CREATE OR REPLACE FUNCTION app_private.validate_monthly_report(proposed jsonb,prior jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid text:=proposed->>'project_id'; module text:=proposed->>'line'; target_month date;
    selected public.monthly_plans%ROWTYPE; new_id text:=COALESCE(proposed->'biz'->>'monthly_plan_id','');
    old_id text:=COALESCE(prior->'biz'->>'monthly_plan_id',''); reference_at timestamptz;
BEGIN
    IF NOT app_private.can_write_report(pid,module,auth.uid()) THEN RAISE EXCEPTION 'Monthly report denied' USING ERRCODE='42501'; END IF;
    IF module='综合' AND NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=pid AND p.project_type='com') THEN RETURN true; END IF;
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
COMMIT;
