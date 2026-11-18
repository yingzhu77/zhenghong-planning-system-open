BEGIN;

-- An unplanned week owns its own item list. Existing monthly-plan bindings
-- and published reports keep their original references.
ALTER TABLE app_private.weekly_collaboration_drafts ADD COLUMN IF NOT EXISTS unplanned_items jsonb
 CHECK(unplanned_items IS NULL OR (jsonb_typeof(unplanned_items)='array' AND plan_id IS NULL));
ALTER TABLE app_private.weekly_collaboration_drafts ADD COLUMN IF NOT EXISTS member_ids text[];
ALTER TABLE app_private.weekly_collaboration_drafts DROP CONSTRAINT IF EXISTS weekly_collaboration_drafts_check1;
ALTER TABLE app_private.weekly_collaboration_drafts DROP CONSTRAINT IF EXISTS weekly_collaboration_publication_source;
ALTER TABLE app_private.weekly_collaboration_drafts ADD CONSTRAINT weekly_collaboration_publication_source
 CHECK(published_report_id IS NULL OR plan_id IS NOT NULL OR (unplanned_items IS NOT NULL AND jsonb_array_length(unplanned_items)>0));
ALTER TABLE app_private.weekly_collaboration_operations DROP CONSTRAINT IF EXISTS weekly_collaboration_operations_kind_check;
ALTER TABLE app_private.weekly_collaboration_operations ADD CONSTRAINT weekly_collaboration_operations_kind_check
 CHECK(kind IN ('designate','items','edit','publish'));

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_room_access(candidate text,pid text,module text,scope_id text,target_week date)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN NOT app_private.weekly_collaboration_eligible(candidate,pid,module,scope_id) THEN 'denied'
  ELSE COALESCE((SELECT CASE WHEN d.report_scope_id IS DISTINCT FROM scope_id THEN 'excluded'
   WHEN d.member_ids IS NULL OR candidate=d.submitter_id OR candidate=ANY(d.member_ids) THEN 'member'
   ELSE 'excluded' END FROM app_private.weekly_collaboration_drafts d
   WHERE d.project_id=pid AND d.line=module AND d.week=target_week),'unconfigured') END;
$$;
REVOKE ALL ON FUNCTION app_private.weekly_collaboration_room_access(text,text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.weekly_collaboration_room_access(text,text,text,text,date) TO app_runtime;

DROP POLICY IF EXISTS weekly_collaboration_drafts_read ON app_private.weekly_collaboration_drafts;
CREATE POLICY weekly_collaboration_drafts_read ON app_private.weekly_collaboration_drafts FOR SELECT TO app_runtime
 USING(app_private.weekly_collaboration_operator()
  OR app_private.weekly_collaboration_room_access(auth.uid(),project_id,line,report_scope_id,week)='member');
DROP POLICY IF EXISTS weekly_collaboration_drafts_update ON app_private.weekly_collaboration_drafts;
CREATE POLICY weekly_collaboration_drafts_update ON app_private.weekly_collaboration_drafts FOR UPDATE TO app_runtime
 USING(app_private.weekly_collaboration_operator()
  OR app_private.weekly_collaboration_room_access(auth.uid(),project_id,line,report_scope_id,week)='member');

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_submission(proposed jsonb,target_week date,unplanned_only boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM app_private.weekly_collaboration_drafts d
  JOIN app_private.weekly_collaboration_operations op USING(project_id,line,week)
  WHERE d.project_id=proposed->>'project_id' AND d.line=proposed->>'line' AND d.week=target_week
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

CREATE OR REPLACE FUNCTION app_private.guard_weekly_collaboration_report()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_week date; calendar_week date; draft app_private.weekly_collaboration_drafts%ROWTYPE;
BEGIN
 IF NEW.line<>'综合' THEN
  IF TG_OP='UPDATE' THEN
   target_week:=app_private.weekly_collaboration_existing_report_week(OLD.period,OLD.submitted_at);
  ELSE
   calendar_week:=app_private.report_week_start(NEW.period,NEW.submitted_at);
   IF calendar_week IS NULL AND NEW.project_id='hf' AND NEW.line='设计部' THEN
    RAISE EXCEPTION '弘坊设计部周报需要有效的报告周' USING ERRCODE='P3801';
   END IF;
   target_week:=app_private.weekly_collaboration_existing_report_week(NEW.period,NEW.submitted_at);
  END IF;
  PERFORM app_private.lock_weekly_collaboration_write(NEW.project_id,NEW.line,target_week);
  SELECT * INTO draft FROM app_private.weekly_collaboration_drafts d
   WHERE d.project_id=NEW.project_id AND d.line=NEW.line AND d.week=target_week;
  IF FOUND THEN
   -- An original unscoped historical record cannot acquire the merged scope.
   IF TG_OP='UPDATE' AND OLD.report_scope_id IS DISTINCT FROM draft.report_scope_id
    AND OLD.biz->'weekly_collaboration' IS NULL AND NEW.biz->'weekly_collaboration' IS NULL THEN
    RETURN NEW;
   END IF;
   IF TG_OP='INSERT' AND calendar_week=target_week
    AND app_private.weekly_collaboration_submission(to_jsonb(NEW),target_week,false) THEN
    RETURN NEW;
   END IF;
   RAISE EXCEPTION '该项目专业本周已启用协同，请由负责人在本期填报中统一提交' USING ERRCODE='P3801';
  END IF;
 END IF;
 IF NEW.biz ? 'weekly_collaboration' THEN
  RAISE EXCEPTION '协同提交标记只能由本期填报的协同功能生成' USING ERRCODE='P3801';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_weekly_collaboration_report() FROM PUBLIC;
CREATE OR REPLACE FUNCTION app_private.guard_report_monthly_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE previous jsonb;
BEGIN
    IF current_user='app_runtime' THEN
        -- A week that already has its own items remains independent when a
        -- monthly plan is confirmed later. Only the locked publish path qualifies.
        IF TG_OP='INSERT' AND NEW.biz ? 'weekly_collaboration'
          AND app_private.weekly_collaboration_submission(to_jsonb(NEW),
            app_private.report_week_start(NEW.period,NEW.submitted_at),true) THEN RETURN NEW; END IF;
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

COMMIT;
