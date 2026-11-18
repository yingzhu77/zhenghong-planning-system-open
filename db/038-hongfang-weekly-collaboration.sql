BEGIN;

-- One opt-in draft per week for the fixed 弘坊 / 设计部 pilot.
CREATE TABLE IF NOT EXISTS app_private.hongfang_weekly_drafts (
  week date PRIMARY KEY CHECK(extract(isodow from week)=1),
  submitter_id text NOT NULL REFERENCES public.profiles(user_id),
  configured_by text NOT NULL REFERENCES public.profiles(user_id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  plan_id uuid,
  cells jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(cells)='object'),
  published_report_id bigint UNIQUE REFERENCES public.reports(id),
  published_revision integer,
  CHECK((published_report_id IS NULL)=(published_revision IS NULL)),
  CHECK(published_report_id IS NULL OR plan_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS app_private.hongfang_weekly_operations (
  week date NOT NULL REFERENCES app_private.hongfang_weekly_drafts(week),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES public.profiles(user_id),
  actor_name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('designate','edit','publish')),
  revision integer NOT NULL CHECK(revision>0),
  cell text,
  payload_hash text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(week,operation_id),
  UNIQUE(week,revision),
  CHECK((kind='edit')=(cell IS NOT NULL))
);

-- The pilot reuses approved report membership and existing 设计部 grants,
-- including the department grant on an account whose primary module differs.
CREATE OR REPLACE FUNCTION app_private.hongfang_weekly_eligible(candidate text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.profiles p
  JOIN app_private.auth_users a USING(user_id)
  JOIN public.project_members m USING(user_id)
  JOIN public.projects j ON j.id=m.project_id
  WHERE p.user_id=candidate AND p.role='pm' AND p.status='approved' AND NOT a.disabled
   AND j.id='hf' AND j.active AND j.project_type='com' AND m.role_in_project='pm'
   AND (p.biz_line IN ('设计部','*') OR EXISTS(
    SELECT 1 FROM public.commercial_module_grants g
    WHERE g.user_id=p.user_id AND g.project_id=j.id AND g.line='设计部')));
$$;

CREATE OR REPLACE FUNCTION app_private.hongfang_weekly_operator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app_private.has_approved_role(ARRAY['ops']) AND EXISTS(
  SELECT 1 FROM app_private.auth_users a WHERE a.user_id=auth.uid() AND NOT a.disabled);
$$;

CREATE OR REPLACE FUNCTION app_private.hongfang_weekly_participants()
RETURNS TABLE(user_id text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.user_id,p.name FROM public.profiles p
 WHERE (app_private.hongfang_weekly_operator() OR app_private.hongfang_weekly_eligible(auth.uid()))
  AND app_private.hongfang_weekly_eligible(p.user_id)
 ORDER BY p.name,p.user_id;
$$;

REVOKE ALL ON FUNCTION app_private.hongfang_weekly_eligible(text),app_private.hongfang_weekly_operator(),app_private.hongfang_weekly_participants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.hongfang_weekly_eligible(text),app_private.hongfang_weekly_operator(),app_private.hongfang_weekly_participants() TO app_runtime;

ALTER TABLE app_private.hongfang_weekly_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hongfang_weekly_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.hongfang_weekly_drafts,app_private.hongfang_weekly_operations FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT,UPDATE ON app_private.hongfang_weekly_drafts TO app_runtime;
GRANT SELECT,INSERT ON app_private.hongfang_weekly_operations TO app_runtime;

DROP POLICY IF EXISTS hongfang_weekly_drafts_read ON app_private.hongfang_weekly_drafts;
CREATE POLICY hongfang_weekly_drafts_read ON app_private.hongfang_weekly_drafts FOR SELECT TO app_runtime
 USING(app_private.hongfang_weekly_operator() OR app_private.hongfang_weekly_eligible(auth.uid()));
DROP POLICY IF EXISTS hongfang_weekly_drafts_designate ON app_private.hongfang_weekly_drafts;
CREATE POLICY hongfang_weekly_drafts_designate ON app_private.hongfang_weekly_drafts FOR INSERT TO app_runtime
 WITH CHECK(app_private.hongfang_weekly_operator() AND configured_by=auth.uid() AND app_private.hongfang_weekly_eligible(submitter_id));
DROP POLICY IF EXISTS hongfang_weekly_drafts_update ON app_private.hongfang_weekly_drafts;
CREATE POLICY hongfang_weekly_drafts_update ON app_private.hongfang_weekly_drafts FOR UPDATE TO app_runtime
 USING(app_private.hongfang_weekly_operator() OR app_private.hongfang_weekly_eligible(auth.uid()));

DROP POLICY IF EXISTS hongfang_weekly_operations_read ON app_private.hongfang_weekly_operations;
CREATE POLICY hongfang_weekly_operations_read ON app_private.hongfang_weekly_operations FOR SELECT TO app_runtime
 USING(app_private.hongfang_weekly_operator() OR app_private.hongfang_weekly_eligible(auth.uid()));
DROP POLICY IF EXISTS hongfang_weekly_operations_append ON app_private.hongfang_weekly_operations;
CREATE POLICY hongfang_weekly_operations_append ON app_private.hongfang_weekly_operations FOR INSERT TO app_runtime
 WITH CHECK(actor_id=auth.uid() AND CASE WHEN kind='designate' THEN app_private.hongfang_weekly_operator()
  ELSE app_private.hongfang_weekly_eligible(auth.uid()) END);

-- Prior reports can contain free-form or zero-padded labels that were accepted
-- before the pilot. Their original timestamp is the last resort for matching.
CREATE OR REPLACE FUNCTION app_private.hongfang_weekly_existing_report_week(label text,submitted timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(app_private.report_week_start(label,submitted),
  app_private.report_week_start(regexp_replace(label,'第 *0+([0-9]{1,2}) *周','第\1周'),submitted),
  date_trunc('week',submitted AT TIME ZONE 'Asia/Shanghai')::date);
$$;
REVOKE ALL ON FUNCTION app_private.hongfang_weekly_existing_report_week(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.hongfang_weekly_existing_report_week(text,timestamptz) TO app_runtime;

-- Serialize normal report writes and pilot designation/publication by the same
-- canonical week. The report is linked to the pilot in the insert transaction.
CREATE OR REPLACE FUNCTION app_private.guard_hongfang_weekly_report()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_week date; draft app_private.hongfang_weekly_drafts%ROWTYPE;
BEGIN
 IF NEW.project_id='hf' AND NEW.line='设计部' THEN
  IF TG_OP='UPDATE' THEN
   target_week:=app_private.hongfang_weekly_existing_report_week(OLD.period,OLD.submitted_at);
  ELSE
   target_week:=app_private.report_week_start(NEW.period,NEW.submitted_at);
   IF target_week IS NULL THEN
    RAISE EXCEPTION '弘坊设计部周报需要有效的报告周' USING ERRCODE='P3801';
   END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hongfang-design-weekly:'||to_char(target_week,'YYYY-MM-DD'),0));
  SELECT * INTO draft FROM app_private.hongfang_weekly_drafts d WHERE d.week=target_week;
  IF FOUND THEN
   IF TG_OP='INSERT' AND draft.published_report_id IS NULL AND draft.plan_id IS NOT NULL
    AND draft.submitter_id=auth.uid() AND NEW.author_id=draft.submitter_id
    AND app_private.hongfang_weekly_eligible(auth.uid())
    AND NEW.report_scope_id IS NULL
    AND NEW.biz->>'monthly_plan_id'=draft.plan_id::text
    AND NEW.biz->'weekly_collaboration'=jsonb_build_object('week',to_char(target_week,'YYYY-MM-DD'),'revision',draft.revision)
    AND EXISTS(SELECT 1 FROM app_private.hongfang_weekly_operations op WHERE op.week=target_week
     AND op.operation_id::text=current_setting('app.hongfang_weekly_publish',true)
     AND op.actor_id=auth.uid() AND op.kind='publish' AND op.revision=draft.revision+1) THEN
     RETURN NEW;
   END IF;
   RAISE EXCEPTION '该周弘坊设计部已启用协同填报，请从专业协同工作区提交' USING ERRCODE='P3801';
  END IF;
 END IF;
 IF NEW.biz ? 'weekly_collaboration' THEN
  RAISE EXCEPTION '协同提交标记只能由协同工作区生成' USING ERRCODE='P3801';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_hongfang_weekly_report() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_hongfang_weekly_report ON public.reports;
CREATE TRIGGER guard_hongfang_weekly_report BEFORE INSERT OR UPDATE ON public.reports
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_hongfang_weekly_report();

COMMIT;
