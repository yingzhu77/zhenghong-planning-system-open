BEGIN;

-- Outgoing requests stay in the shared weekly draft until the lead submits.
ALTER TABLE app_private.weekly_collaboration_drafts
 ADD COLUMN IF NOT EXISTS outgoing_coordination jsonb NOT NULL DEFAULT '{"revision":0,"rows":[]}'
 CHECK(jsonb_typeof(outgoing_coordination)='object'
   AND jsonb_typeof(outgoing_coordination->'rows')='array'
   AND jsonb_typeof(outgoing_coordination->'revision')='number');

ALTER TABLE app_private.weekly_collaboration_drafts DROP CONSTRAINT IF EXISTS weekly_collaboration_publication_source;
ALTER TABLE app_private.weekly_collaboration_drafts ADD CONSTRAINT weekly_collaboration_publication_source
 CHECK(published_report_id IS NULL OR plan_id IS NOT NULL
   OR (unplanned_items IS NOT NULL AND jsonb_array_length(unplanned_items)>0)
   OR jsonb_array_length(outgoing_coordination->'rows')>0);

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
   AND (CASE WHEN d.plan_id IS NULL THEN
        (COALESCE(jsonb_array_length(d.unplanned_items),0)>0 OR jsonb_array_length(d.outgoing_coordination->'rows')>0)
        AND NOT ((proposed->'biz') ?| ARRAY['monthly_plan_id','monthly_plan_ids'])
        WHEN unplanned_only THEN false
        WHEN d.report_scope_id IS NULL THEN proposed->'biz'->>'monthly_plan_id'=d.plan_id::text
        ELSE proposed->'biz'->'monthly_plan_ids'=jsonb_build_array(d.plan_id::text) END)
   AND (jsonb_array_length(d.outgoing_coordination->'rows')=0 OR
    (SELECT jsonb_agg(v->'source_id' ORDER BY pos)
     FROM jsonb_array_elements(d.outgoing_coordination->'rows') WITH ORDINALITY AS items(v,pos))
    =(SELECT jsonb_agg(v->'source_id' ORDER BY pos)
      FROM jsonb_array_elements(proposed->'coord_items') WITH ORDINALITY AS items(v,pos)))
   AND proposed->'biz'->'weekly_collaboration'=jsonb_build_object('week',to_char(d.week,'YYYY-MM-DD'),'revision',d.revision)
   AND op.operation_id::text=current_setting('app.weekly_collaboration_publish',true)
   AND op.actor_id=auth.uid() AND op.kind='publish' AND op.revision=d.revision+1);
$$;
REVOKE ALL ON FUNCTION app_private.weekly_collaboration_submission(jsonb,date,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.weekly_collaboration_submission(jsonb,date,boolean) TO app_runtime;

COMMIT;
