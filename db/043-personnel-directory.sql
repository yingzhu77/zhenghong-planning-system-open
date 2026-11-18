BEGIN;

CREATE TABLE IF NOT EXISTS app_private.personnel_directory (
  user_id text PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  division text NOT NULL CHECK (btrim(division) <> ''),
  team text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  sort_order integer NOT NULL CHECK (sort_order >= 0)
);

ALTER TABLE app_private.personnel_directory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.personnel_directory FROM PUBLIC, app_runtime;
GRANT SELECT ON app_private.personnel_directory TO app_runtime;
DROP POLICY IF EXISTS personnel_directory_read ON app_private.personnel_directory;
CREATE POLICY personnel_directory_read ON app_private.personnel_directory FOR SELECT TO app_runtime
  USING (app_private.weekly_collaboration_operator());

CREATE TABLE IF NOT EXISTS app_private.project_personnel_admins (
  user_id text REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  project_id text REFERENCES public.projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);
REVOKE ALL ON app_private.project_personnel_admins FROM PUBLIC, app_runtime;

CREATE OR REPLACE FUNCTION app_private.personnel_admin_projects()
RETURNS TABLE (project_id text, project_name text, report_scope_id text, project_ids text[],
  project_type text, reporting_professions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT j.id, COALESCE(s.name,j.name), s.id, COALESCE(s.project_ids,ARRAY[j.id]),
    j.project_type,j.reporting_professions
  FROM app_private.project_personnel_admins g
  JOIN public.profiles p USING(user_id)
  JOIN app_private.auth_users a USING(user_id)
  JOIN public.projects j ON j.id=g.project_id AND j.active
  LEFT JOIN app_private.report_scopes s ON j.id=ANY(s.project_ids)
  WHERE g.user_id=auth.uid() AND p.status='approved' AND NOT a.disabled
    AND p.role='viewer' AND p.viewer_scope='projects' AND p.viewer_access='materials'
    AND (s.id IS NULL OR (s.anchor_project_id=j.id AND s.reporting_mode='professional'))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(s.project_ids,ARRAY[j.id])) AS phase(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.project_members m JOIN public.projects active ON active.id=m.project_id
        WHERE m.user_id=g.user_id AND m.project_id=phase.id AND active.active)
    )
  ORDER BY j.sort_order,j.id;
$$;

CREATE OR REPLACE FUNCTION app_private.project_personnel()
RETURNS TABLE (user_id text, name text, division text, team text, title text, sort_order integer, projects jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH allowed AS (
    SELECT DISTINCT unnest(project_ids) AS id FROM app_private.personnel_admin_projects()
  )
  SELECT p.user_id,p.name,d.division,d.team,d.title,d.sort_order,
    jsonb_agg(jsonb_build_object('project_id',j.id,'project_name',j.name,'role_in_project',m.role_in_project,
      'discipline',CASE WHEN p.role='pm' AND m.role_in_project='pm' AND j.project_type<>'com' THEN p.discipline END,
      'biz_line',CASE WHEN p.role='pm' AND m.role_in_project='pm' AND j.project_type='com' THEN p.biz_line END,
      'professions',CASE WHEN p.role='pm' AND m.role_in_project='pm' THEN
        ARRAY(SELECT line FROM public.project_reporting_grants WHERE user_id=p.user_id AND project_id=j.id
          UNION SELECT line FROM public.commercial_module_grants WHERE user_id=p.user_id AND project_id=j.id ORDER BY line)
        ELSE ARRAY[]::text[] END) ORDER BY j.sort_order,j.id)
  FROM allowed
  JOIN public.projects j ON j.id=allowed.id
  JOIN public.project_members m ON m.project_id=j.id
  JOIN public.profiles p ON p.user_id=m.user_id AND p.status='approved'
  JOIN app_private.auth_users a ON a.user_id=p.user_id AND NOT a.disabled
  LEFT JOIN app_private.personnel_directory d ON d.user_id=p.user_id
  GROUP BY p.user_id,p.name,d.division,d.team,d.title,d.sort_order
  ORDER BY d.sort_order NULLS LAST,p.name,p.user_id;
$$;

-- This context is set only by the settings handler, after it verifies the
-- requested anchor and scope. It is transaction-local and carries no content.
CREATE OR REPLACE FUNCTION app_private.scoped_weekly_settings(pid text, scope_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(current_setting('app.scoped_weekly_settings',true)='on',false)
    AND EXISTS (SELECT 1 FROM app_private.personnel_admin_projects() p
      WHERE p.project_id=pid AND p.report_scope_id IS NOT DISTINCT FROM scope_id);
$$;

CREATE OR REPLACE FUNCTION app_private.scoped_weekly_settings_conflicts(pid text,module text,scope_id text,target_week date,candidate text)
RETURNS TABLE (has_report boolean,has_month_draft boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.reports r WHERE r.project_id=pid AND r.line=module AND r.author_id=candidate
      AND app_private.weekly_collaboration_existing_report_week(r.period,r.submitted_at)=target_week),
    EXISTS (SELECT 1 FROM app_private.collaboration_monthly_drafts m WHERE m.project_id=pid AND m.line=module
      AND m.report_scope_id IS NOT DISTINCT FROM scope_id AND m.owner_id=candidate
      AND m.plan_month IN (date_trunc('month',target_week)::date,
        (date_trunc('month',target_week)+interval '1 month')::date))
  WHERE app_private.scoped_weekly_settings(pid,scope_id)
    AND (app_private.weekly_collaboration_eligible(candidate,pid,module,scope_id)
      OR EXISTS (SELECT 1 FROM app_private.weekly_collaboration_drafts d
        WHERE (d.project_id,d.line,d.week,d.submitter_id)=(pid,module,target_week,candidate)
          AND d.report_scope_id IS NOT DISTINCT FROM scope_id));
$$;

REVOKE ALL ON FUNCTION app_private.personnel_admin_projects(), app_private.project_personnel(),
  app_private.scoped_weekly_settings(text,text), app_private.scoped_weekly_settings_conflicts(text,text,text,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.personnel_admin_projects(), app_private.project_personnel(),
  app_private.scoped_weekly_settings(text,text), app_private.scoped_weekly_settings_conflicts(text,text,text,date,text) TO app_runtime;

DROP POLICY IF EXISTS scoped_weekly_settings_read ON app_private.weekly_collaboration_drafts;
CREATE POLICY scoped_weekly_settings_read ON app_private.weekly_collaboration_drafts FOR SELECT TO app_runtime
  USING (app_private.scoped_weekly_settings(project_id,report_scope_id));
DROP POLICY IF EXISTS scoped_weekly_settings_create ON app_private.weekly_collaboration_drafts;
CREATE POLICY scoped_weekly_settings_create ON app_private.weekly_collaboration_drafts FOR INSERT TO app_runtime
  WITH CHECK (app_private.scoped_weekly_settings(project_id,report_scope_id) AND configured_by=auth.uid()
    AND app_private.weekly_collaboration_eligible(submitter_id,project_id,line,report_scope_id));
DROP POLICY IF EXISTS scoped_weekly_settings_update ON app_private.weekly_collaboration_drafts;
CREATE POLICY scoped_weekly_settings_update ON app_private.weekly_collaboration_drafts FOR UPDATE TO app_runtime
  USING (app_private.scoped_weekly_settings(project_id,report_scope_id))
  WITH CHECK (app_private.scoped_weekly_settings(project_id,report_scope_id) AND configured_by=auth.uid()
    AND app_private.weekly_collaboration_eligible(submitter_id,project_id,line,report_scope_id));
DROP POLICY IF EXISTS scoped_weekly_settings_operation ON app_private.weekly_collaboration_operations;
CREATE POLICY scoped_weekly_settings_operation ON app_private.weekly_collaboration_operations FOR INSERT TO app_runtime
  WITH CHECK (kind='designate' AND actor_id=auth.uid() AND EXISTS (
    SELECT 1 FROM app_private.weekly_collaboration_drafts d
    WHERE (d.project_id,d.line,d.week)=(weekly_collaboration_operations.project_id,
      weekly_collaboration_operations.line,weekly_collaboration_operations.week)
      AND app_private.scoped_weekly_settings(d.project_id,d.report_scope_id)));

CREATE OR REPLACE FUNCTION app_private.weekly_collaboration_participants(pid text,module text,scope_id text)
RETURNS TABLE(user_id text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.user_id,p.name FROM public.profiles p
 JOIN public.project_members m ON m.user_id=p.user_id AND m.project_id=pid
 WHERE (app_private.weekly_collaboration_operator() OR app_private.scoped_weekly_settings(pid,scope_id)
   OR app_private.weekly_collaboration_eligible(auth.uid(),pid,module,scope_id))
   AND app_private.weekly_collaboration_eligible(p.user_id,pid,module,scope_id)
 ORDER BY p.name,p.user_id;
$$;

COMMIT;
