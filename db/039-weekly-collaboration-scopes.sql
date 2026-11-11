BEGIN;

CREATE TABLE IF NOT EXISTS app_private.weekly_collaboration_drafts (
 project_id text NOT NULL REFERENCES public.projects(id),
 line text NOT NULL CHECK(line<>'综合' AND length(btrim(line)) BETWEEN 1 AND 100),
 week date NOT NULL CHECK(extract(isodow from week)=1),
 report_scope_id text REFERENCES app_private.report_scopes(id),
 submitter_id text NOT NULL REFERENCES public.profiles(user_id),
 configured_by text NOT NULL REFERENCES public.profiles(user_id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 plan_id uuid,
 cells jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(cells)='object'),
 published_report_id bigint UNIQUE REFERENCES public.reports(id),
 published_revision integer,
 PRIMARY KEY(project_id,line,week),
 CHECK((published_report_id IS NULL)=(published_revision IS NULL)),
 CHECK(published_report_id IS NULL OR plan_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS app_private.weekly_collaboration_operations (
 project_id text NOT NULL,
 line text NOT NULL,
 week date NOT NULL,
 operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES public.profiles(user_id),
 actor_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('designate','edit','publish')),
 revision integer NOT NULL CHECK(revision>0),
 cell text,
 payload_hash text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,line,week,operation_id),
 UNIQUE(project_id,line,week,revision),
 FOREIGN KEY(project_id,line,week) REFERENCES app_private.weekly_collaboration_drafts(project_id,line,week),
 CHECK((kind='edit')=(cell IS NOT NULL))
);

-- Copy the pilot's exact revisions, operation receipts and report references.
-- The original tables stay available to the migration owner for audit.
INSERT INTO app_private.weekly_collaboration_drafts
 (project_id,line,week,submitter_id,configured_by,revision,plan_id,cells,published_report_id,published_revision)
SELECT 'hf','设计部',week,submitter_id,configured_by,revision,plan_id,cells,published_report_id,published_revision
FROM app_private.hongfang_weekly_drafts ON CONFLICT(project_id,line,week) DO NOTHING;
INSERT INTO app_private.weekly_collaboration_operations
 (project_id,line,week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash,recorded_at)
SELECT 'hf','设计部',week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash,recorded_at
FROM app_private.hongfang_weekly_operations ON CONFLICT(project_id,line,week,operation_id) DO NOTHING;
REVOKE ALL ON app_private.hongfang_weekly_drafts,app_private.hongfang_weekly_operations FROM PUBLIC,app_runtime;

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_operator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.hongfang_weekly_operator();
$$;

-- This candidate check must work for peers as well as the current actor.
-- The caller-specific report and plan validators still apply when publishing.
CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_eligible(candidate text,pid text,module text,scope_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.profiles p
  JOIN app_private.auth_users a USING(user_id)
  JOIN public.project_members m USING(user_id)
  JOIN public.projects j ON j.id=m.project_id
  WHERE p.user_id=candidate AND p.role='pm' AND p.status='approved' AND NOT a.disabled
   AND j.id=pid AND j.active AND m.role_in_project='pm' AND module<>'综合'
   AND (
    EXISTS(SELECT 1 FROM public.project_reporting_grants g WHERE g.user_id=p.user_id AND g.project_id=j.id
      AND g.line=module AND g.line=ANY(j.reporting_professions))
    OR CASE WHEN j.project_type='com' THEN
     (module=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程',
        '开发','建筑结构设计','机电设计','精装设计','成本','招采']) OR (j.id='hf' AND module='设计部'))
     AND (p.biz_line IN ('*',module) OR EXISTS(SELECT 1 FROM public.commercial_module_grants g
       WHERE g.user_id=p.user_id AND g.project_id=j.id AND g.line=module))
    ELSE module=p.discipline AND module=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务']) END
   ) AND CASE WHEN j.project_type='com' THEN scope_id IS NULL
    WHEN scope_id IS NULL THEN NOT EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE j.id=ANY(s.project_ids))
    ELSE EXISTS(SELECT 1 FROM app_private.report_scopes s
      WHERE s.id=scope_id AND s.anchor_project_id=j.id AND s.reporting_mode='professional'
       AND NOT EXISTS(SELECT 1 FROM unnest(s.project_ids) member_id
        WHERE NOT EXISTS(SELECT 1 FROM public.project_members member
         WHERE member.user_id=p.user_id AND member.project_id=member_id AND member.role_in_project='pm'))) END);
$$;

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_participants(pid text,module text,scope_id text)
RETURNS TABLE(user_id text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.user_id,p.name FROM public.profiles p
 JOIN public.project_members m ON m.user_id=p.user_id AND m.project_id=pid
 WHERE (app_private.weekly_collaboration_operator() OR app_private.weekly_collaboration_eligible(auth.uid(),pid,module,scope_id))
  AND app_private.weekly_collaboration_eligible(p.user_id,pid,module,scope_id)
 ORDER BY p.name,p.user_id;
$$;

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_existing_report_week(label text,submitted timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(app_private.report_week_start(
   regexp_replace(label,'第[[:space:]]*0*([0-9]{1,2})[[:space:]]*周','第\1周'),submitted),
   date_trunc('week',submitted AT TIME ZONE 'Asia/Shanghai')::date);
$$;

CREATE OR REPLACE FUNCTION app_private.lock_weekly_collaboration_write(pid text,module text,target_week date)
RETURNS void LANGUAGE sql VOLATILE STRICT SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('weekly-collaboration:'||jsonb_build_array(pid,module,to_char(target_week,'YYYY-MM-DD'))::text,0));
$$;

REVOKE ALL ON FUNCTION app_private.weekly_collaboration_operator(),app_private.weekly_collaboration_eligible(text,text,text,text),
 app_private.weekly_collaboration_participants(text,text,text),app_private.weekly_collaboration_existing_report_week(text,timestamptz),
 app_private.lock_weekly_collaboration_write(text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.weekly_collaboration_operator(),app_private.weekly_collaboration_eligible(text,text,text,text),
 app_private.weekly_collaboration_participants(text,text,text),app_private.weekly_collaboration_existing_report_week(text,timestamptz),
 app_private.lock_weekly_collaboration_write(text,text,date) TO app_runtime;

ALTER TABLE app_private.weekly_collaboration_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.weekly_collaboration_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.weekly_collaboration_drafts,app_private.weekly_collaboration_operations FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT,UPDATE ON app_private.weekly_collaboration_drafts TO app_runtime;
GRANT SELECT,INSERT ON app_private.weekly_collaboration_operations TO app_runtime;

DROP POLICY IF EXISTS weekly_collaboration_drafts_read ON app_private.weekly_collaboration_drafts;
CREATE POLICY weekly_collaboration_drafts_read ON app_private.weekly_collaboration_drafts FOR SELECT TO app_runtime
 USING(app_private.weekly_collaboration_operator() OR app_private.weekly_collaboration_eligible(auth.uid(),project_id,line,report_scope_id));
DROP POLICY IF EXISTS weekly_collaboration_drafts_designate ON app_private.weekly_collaboration_drafts;
CREATE POLICY weekly_collaboration_drafts_designate ON app_private.weekly_collaboration_drafts FOR INSERT TO app_runtime
 WITH CHECK(app_private.weekly_collaboration_operator() AND configured_by=auth.uid()
   AND app_private.weekly_collaboration_eligible(submitter_id,project_id,line,report_scope_id));
DROP POLICY IF EXISTS weekly_collaboration_drafts_update ON app_private.weekly_collaboration_drafts;
CREATE POLICY weekly_collaboration_drafts_update ON app_private.weekly_collaboration_drafts FOR UPDATE TO app_runtime
 USING(app_private.weekly_collaboration_operator() OR app_private.weekly_collaboration_eligible(auth.uid(),project_id,line,report_scope_id));

-- Draft RLS provides the identical scope read gate for operation receipts.
DROP POLICY IF EXISTS weekly_collaboration_operations_read ON app_private.weekly_collaboration_operations;
CREATE POLICY weekly_collaboration_operations_read ON app_private.weekly_collaboration_operations FOR SELECT TO app_runtime
 USING(EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts d
   WHERE (d.project_id,d.line,d.week)=(weekly_collaboration_operations.project_id,weekly_collaboration_operations.line,weekly_collaboration_operations.week)));
DROP POLICY IF EXISTS weekly_collaboration_operations_append ON app_private.weekly_collaboration_operations;
CREATE POLICY weekly_collaboration_operations_append ON app_private.weekly_collaboration_operations FOR INSERT TO app_runtime
 WITH CHECK(actor_id=auth.uid() AND EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts d
  WHERE (d.project_id,d.line,d.week)=(weekly_collaboration_operations.project_id,weekly_collaboration_operations.line,weekly_collaboration_operations.week)
    AND CASE WHEN kind='designate' THEN app_private.weekly_collaboration_operator()
     ELSE app_private.weekly_collaboration_eligible(auth.uid(),d.project_id,d.line,d.report_scope_id) END));

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
   IF TG_OP='INSERT' AND calendar_week=target_week AND draft.published_report_id IS NULL AND draft.plan_id IS NOT NULL
    AND draft.submitter_id=auth.uid() AND NEW.author_id=draft.submitter_id
    AND NEW.report_scope_id IS NOT DISTINCT FROM draft.report_scope_id
    AND app_private.weekly_collaboration_eligible(auth.uid(),draft.project_id,draft.line,draft.report_scope_id)
    AND (CASE WHEN draft.report_scope_id IS NULL THEN NEW.biz->>'monthly_plan_id'=draft.plan_id::text
      ELSE NEW.biz->'monthly_plan_ids'=jsonb_build_array(draft.plan_id::text) END)
    AND NEW.biz->'weekly_collaboration'=jsonb_build_object('week',to_char(target_week,'YYYY-MM-DD'),'revision',draft.revision)
    AND EXISTS(SELECT 1 FROM app_private.weekly_collaboration_operations op
     WHERE (op.project_id,op.line,op.week)=(draft.project_id,draft.line,draft.week)
      AND op.operation_id::text=current_setting('app.weekly_collaboration_publish',true)
      AND op.actor_id=auth.uid() AND op.kind='publish' AND op.revision=draft.revision+1) THEN
    RETURN NEW;
   END IF;
   RAISE EXCEPTION '该项目专业本周已启用协同填报，请从协同工作区提交' USING ERRCODE='P3801';
  END IF;
 END IF;
 IF NEW.biz ? 'weekly_collaboration' THEN
  RAISE EXCEPTION '协同提交标记只能由协同工作区生成' USING ERRCODE='P3801';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_weekly_collaboration_report() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_hongfang_weekly_report ON public.reports;
DROP TRIGGER IF EXISTS guard_weekly_collaboration_report ON public.reports;
DROP TRIGGER IF EXISTS guard_collaboration_weekly_report ON public.reports;
CREATE TRIGGER guard_collaboration_weekly_report BEFORE INSERT OR UPDATE ON public.reports
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_weekly_collaboration_report();

COMMIT;
