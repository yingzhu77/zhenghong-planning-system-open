BEGIN;

CREATE TABLE IF NOT EXISTS app_private.collaboration_monthly_drafts (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES public.projects(id),
 line text NOT NULL,
 report_scope_id text REFERENCES app_private.report_scopes(id),
 plan_month date NOT NULL CHECK(extract(day FROM plan_month)=1),
 owner_id text NOT NULL REFERENCES public.profiles(user_id),
 origin_week date NOT NULL,
 items jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=500),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 confirmed_id uuid REFERENCES public.monthly_plans(id),
 UNIQUE NULLS NOT DISTINCT(project_id,line,report_scope_id,plan_month,owner_id),
 FOREIGN KEY(project_id,line,origin_week) REFERENCES app_private.weekly_collaboration_drafts(project_id,line,week)
);
ALTER TABLE app_private.weekly_collaboration_drafts
 ADD COLUMN IF NOT EXISTS shared_monthly_plan_id uuid REFERENCES app_private.collaboration_monthly_drafts(id);
CREATE INDEX IF NOT EXISTS weekly_collaboration_shared_monthly_plan
 ON app_private.weekly_collaboration_drafts(shared_monthly_plan_id) WHERE shared_monthly_plan_id IS NOT NULL;

ALTER TABLE app_private.collaboration_monthly_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.collaboration_monthly_drafts FROM PUBLIC,app_runtime;
GRANT SELECT,INSERT ON app_private.collaboration_monthly_drafts TO app_runtime;
GRANT UPDATE(items,revision,confirmed_id) ON app_private.collaboration_monthly_drafts TO app_runtime;

DROP POLICY IF EXISTS collaboration_monthly_drafts_read ON app_private.collaboration_monthly_drafts;
CREATE POLICY collaboration_monthly_drafts_read ON app_private.collaboration_monthly_drafts FOR SELECT TO app_runtime
 USING(app_private.weekly_collaboration_operator()
  OR app_private.weekly_collaboration_room_access(auth.uid(),project_id,line,report_scope_id,origin_week)='member');
DROP POLICY IF EXISTS collaboration_monthly_drafts_create ON app_private.collaboration_monthly_drafts;
CREATE POLICY collaboration_monthly_drafts_create ON app_private.collaboration_monthly_drafts FOR INSERT TO app_runtime
 WITH CHECK(app_private.weekly_collaboration_room_access(auth.uid(),project_id,line,report_scope_id,origin_week)='member'
  AND EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts w
   WHERE (w.project_id,w.line,w.week)=(collaboration_monthly_drafts.project_id,collaboration_monthly_drafts.line,collaboration_monthly_drafts.origin_week)
    AND w.submitter_id=collaboration_monthly_drafts.owner_id));
DROP POLICY IF EXISTS collaboration_monthly_drafts_update ON app_private.collaboration_monthly_drafts;
CREATE POLICY collaboration_monthly_drafts_update ON app_private.collaboration_monthly_drafts FOR UPDATE TO app_runtime
 USING(app_private.weekly_collaboration_room_access(auth.uid(),project_id,line,report_scope_id,origin_week)='member');

-- A later room can determine that the existing plan is unavailable without
-- reading the original room's members or its draft content.
CREATE OR REPLACE FUNCTION app_private.collaboration_monthly_draft_unavailable(pid text,module text,scope_id text,current_week date,target_month date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts w
  JOIN app_private.collaboration_monthly_drafts m
   ON (m.project_id,m.line,m.owner_id)=(w.project_id,w.line,w.submitter_id)
  WHERE (w.project_id,w.line,w.week)=(pid,module,current_week)
   AND w.report_scope_id IS NOT DISTINCT FROM scope_id AND m.report_scope_id IS NOT DISTINCT FROM scope_id
   AND m.plan_month=target_month
   AND app_private.weekly_collaboration_room_access(auth.uid(),pid,module,scope_id,current_week)='member'
   AND app_private.weekly_collaboration_room_access(auth.uid(),pid,module,scope_id,m.origin_week)<>'member');
$$;
REVOKE ALL ON FUNCTION app_private.collaboration_monthly_draft_unavailable(text,text,text,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.collaboration_monthly_draft_unavailable(text,text,text,date,date) TO app_runtime;

-- Check all linked weeks, including weeks not visible to the current editor.
CREATE OR REPLACE FUNCTION app_private.collaboration_monthly_item_in_use(draft_id uuid,item_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM app_private.collaboration_monthly_drafts m
  WHERE m.id=draft_id AND app_private.weekly_collaboration_room_access(auth.uid(),m.project_id,m.line,m.report_scope_id,m.origin_week)='member')
 OR EXISTS(SELECT 1 FROM app_private.weekly_collaboration_drafts w
  LEFT JOIN public.reports r ON r.id=w.published_report_id
  WHERE w.shared_monthly_plan_id=draft_id
   AND (w.cells ?| ARRAY[item_id||':prog',item_id||':blocker']
    OR r.biz->'items' @> jsonb_build_array(jsonb_build_object('source_id',item_id))));
$$;
REVOKE ALL ON FUNCTION app_private.collaboration_monthly_item_in_use(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.collaboration_monthly_item_in_use(uuid,text) TO app_runtime;

-- A rollback to a shared draft must also clear confirmed references from
-- other unsubmitted weeks, including weeks outside the caller's roster.
-- Take the same monthly lock as edits and publication before checking uses.
CREATE OR REPLACE FUNCTION app_private.withdraw_collaboration_monthly_plan(draft_id uuid,current_week date,expected_revision integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected app_private.collaboration_monthly_drafts%ROWTYPE;
BEGIN
 SELECT * INTO selected FROM app_private.collaboration_monthly_drafts m WHERE m.id=draft_id;
 IF NOT FOUND OR selected.owner_id<>auth.uid() OR NOT EXISTS(
  SELECT 1 FROM app_private.weekly_collaboration_drafts w
  WHERE (w.project_id,w.line,w.week)=(selected.project_id,selected.line,current_week)
   AND w.report_scope_id IS NOT DISTINCT FROM selected.report_scope_id AND w.submitter_id=auth.uid())
  OR app_private.weekly_collaboration_room_access(auth.uid(),selected.project_id,selected.line,selected.report_scope_id,selected.origin_week)<>'member'
  OR app_private.weekly_collaboration_room_access(auth.uid(),selected.project_id,selected.line,selected.report_scope_id,current_week)<>'member' THEN
  RAISE EXCEPTION '仅指定负责人可撤回协同月计划' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('collaboration-month:'||jsonb_build_array(selected.project_id,selected.line,selected.report_scope_id,selected.owner_id,to_char(selected.plan_month,'YYYY-MM'))::text,0));
 SELECT * INTO selected FROM app_private.collaboration_monthly_drafts m WHERE m.id=draft_id FOR UPDATE;
 IF selected.confirmed_id IS NULL OR selected.revision<>expected_revision THEN
  RAISE EXCEPTION '月计划确认版已变化，请刷新后重试' USING ERRCODE='P0002';
 END IF;
 IF app_private.monthly_plan_is_referenced(selected.confirmed_id,selected.project_id) THEN
  RAISE EXCEPTION '该月计划已有周报或完成延期申报引用，不能撤回' USING ERRCODE='23514',DETAIL='monthly_plan_in_use';
 END IF;
 UPDATE app_private.weekly_collaboration_drafts w SET shared_monthly_plan_id=selected.id,plan_id=NULL
  WHERE (w.project_id,w.line,w.submitter_id)=(selected.project_id,selected.line,selected.owner_id)
   AND w.report_scope_id IS NOT DISTINCT FROM selected.report_scope_id
   AND w.plan_id=selected.confirmed_id AND w.published_report_id IS NULL;
 UPDATE app_private.collaboration_monthly_drafts SET confirmed_id=NULL,revision=revision+1 WHERE id=selected.id;
 IF selected.report_scope_id IS NULL THEN
  PERFORM app_private.withdraw_monthly_plan(selected.project_id,selected.line,selected.plan_month,selected.confirmed_id);
 ELSE
  PERFORM app_private.withdraw_monthly_plan(selected.project_id,selected.line,selected.plan_month,selected.confirmed_id,selected.report_scope_id);
 END IF;
 RETURN selected.revision+1;
END;
$$;
REVOKE ALL ON FUNCTION app_private.withdraw_collaboration_monthly_plan(uuid,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.withdraw_collaboration_monthly_plan(uuid,date,integer) TO app_runtime;

COMMIT;
