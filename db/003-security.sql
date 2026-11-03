-- Runtime identity is set by the trusted HTTP server, never by request data.
-- Every business request must BEGIN; set_config('app.current_user_id', uid, true);
-- run its statements on that same connection; COMMIT/ROLLBACK before release.
BEGIN;

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, auth, app_private TO app_runtime;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_runtime;

-- These small helpers are owned by the migration administrator. Their fixed
-- search_path and qualified relations prevent name substitution; definer access
-- avoids recursively evaluating profiles' own policies.
CREATE OR REPLACE FUNCTION app_private.has_approved_role(required_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid() AND p.status = 'approved'
          AND p.role = ANY(required_roles)
    );
$$;

CREATE OR REPLACE FUNCTION app_private.can_read_project(target_project_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT auth.uid() IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = target_project_id)
      AND (
        app_private.has_approved_role(ARRAY['ops', 'president', 'pzo'])
        OR (
          app_private.has_approved_role(ARRAY['pm'])
          AND EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.user_id = auth.uid() AND pm.project_id = target_project_id
          )
        )
      );
$$;

CREATE OR REPLACE FUNCTION app_private.can_manage_project(target_project_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT app_private.has_approved_role(ARRAY['ops', 'president'])
      AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = target_project_id);
$$;

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
            THEN NULLIF(btrim(p.biz_line), '') IS NOT NULL AND target_line = p.biz_line
            ELSE target_line = '综合'
          END
      );
$$;

CREATE OR REPLACE FUNCTION app_private.can_write_leader(
    target_project_id text, target_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = target_project_id)
      AND CASE
        WHEN target_kind IN ('ceo', 'ceo_brief')
          THEN app_private.has_approved_role(ARRAY['ops', 'president'])
        WHEN target_kind IN ('pzo', 'pzo_note')
          THEN app_private.has_approved_role(ARRAY['ops', 'pzo'])
        ELSE false
      END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.has_approved_role(text[]),
    app_private.can_read_project(text), app_private.can_manage_project(text),
    app_private.can_write_report(text, text, text),
    app_private.can_write_leader(text, text) TO app_runtime;

-- Remove inherited platform policies: permissive policies combine with OR.
DO $$
DECLARE item record; target_name text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles
               WHERE rolname = 'app_runtime' AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'app_runtime must not be superuser or BYPASSRLS';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE r.rolname = 'app_runtime' AND n.nspname = 'public') THEN
        RAISE EXCEPTION 'app_runtime must not own business tables';
    END IF;
    FOR item IN SELECT schemaname, tablename, policyname FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = ANY(ARRAY['projects','profiles','project_members','org',
                    'plan_versions','plan_changes','milestones','reports','leader_reviews',
                    'leader_notes','project_master','project_phases','project_drawings'])
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I',
                       item.policyname, item.schemaname, item.tablename);
    END LOOP;
    FOREACH target_name IN ARRAY ARRAY['projects','profiles','project_members','org',
        'plan_versions','plan_changes','milestones','reports','leader_reviews',
        'leader_notes','project_master','project_phases','project_drawings']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_name);
    END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

CREATE POLICY projects_read ON public.projects FOR SELECT TO app_runtime
    USING (app_private.can_read_project(id));
CREATE POLICY projects_insert ON public.projects FOR INSERT TO app_runtime
    WITH CHECK (app_private.has_approved_role(ARRAY['ops','president']));
CREATE POLICY projects_update ON public.projects FOR UPDATE TO app_runtime
    USING (app_private.has_approved_role(ARRAY['ops','president']))
    WITH CHECK (app_private.has_approved_role(ARRAY['ops','president']));

CREATE POLICY profiles_read ON public.profiles FOR SELECT TO app_runtime
    USING (user_id = auth.uid()
        OR app_private.has_approved_role(ARRAY['ops','president','pzo']));
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO app_runtime
    WITH CHECK (
      auth.uid() IS NOT NULL
      AND role IN ('pm','ops','president','pzo') AND status IN ('pending','approved')
      AND (
        app_private.has_approved_role(ARRAY['ops'])
        OR (user_id = auth.uid() AND role = 'pm' AND status = 'pending'
            AND project_id IS NULL AND biz_line IS NULL AND discipline IS NULL)
      )
    );
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO app_runtime
    USING (app_private.has_approved_role(ARRAY['ops']))
    WITH CHECK (app_private.has_approved_role(ARRAY['ops'])
        AND user_id <> '' AND role IN ('pm','ops','president','pzo')
        AND status IN ('pending','approved','rejected'));

CREATE POLICY project_members_read ON public.project_members FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY project_members_write ON public.project_members FOR ALL TO app_runtime
    USING (app_private.has_approved_role(ARRAY['ops']))
    WITH CHECK (app_private.has_approved_role(ARRAY['ops'])
        AND role_in_project = 'pm'
        AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = project_members.user_id));

CREATE POLICY org_read ON public.org FOR SELECT TO app_runtime
    USING (app_private.has_approved_role(ARRAY['pm','ops','president','pzo']));
CREATE POLICY org_write ON public.org FOR ALL TO app_runtime
    USING (app_private.has_approved_role(ARRAY['ops','president']))
    WITH CHECK (app_private.has_approved_role(ARRAY['ops','president']));

CREATE POLICY plan_versions_read ON public.plan_versions FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY plan_versions_write ON public.plan_versions FOR ALL TO app_runtime
    USING (app_private.can_manage_project(project_id))
    WITH CHECK (app_private.can_manage_project(project_id));
CREATE POLICY plan_changes_read ON public.plan_changes FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY plan_changes_write ON public.plan_changes FOR ALL TO app_runtime
    USING (app_private.can_manage_project(project_id))
    WITH CHECK (app_private.can_manage_project(project_id));

CREATE POLICY milestones_read ON public.milestones FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY milestones_insert ON public.milestones FOR INSERT TO app_runtime
    WITH CHECK (app_private.can_manage_project(project_id));
CREATE POLICY milestones_update ON public.milestones FOR UPDATE TO app_runtime
    USING (app_private.can_manage_project(project_id)
        OR (app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id)))
    WITH CHECK (app_private.can_manage_project(project_id)
        OR (app_private.has_approved_role(ARRAY['pm']) AND app_private.can_read_project(project_id)));
CREATE POLICY milestones_delete ON public.milestones FOR DELETE TO app_runtime
    USING (app_private.can_manage_project(project_id));

CREATE POLICY reports_read ON public.reports FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY reports_insert ON public.reports FOR INSERT TO app_runtime
    WITH CHECK (app_private.can_write_report(project_id, line, author_id));
CREATE POLICY reports_update ON public.reports FOR UPDATE TO app_runtime
    USING (app_private.can_write_report(project_id, line, author_id))
    WITH CHECK (app_private.can_write_report(project_id, line, author_id));
-- Intentionally no reports DELETE policy, including for leaders/ops.

CREATE POLICY leader_reviews_read ON public.leader_reviews FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY leader_reviews_write ON public.leader_reviews FOR ALL TO app_runtime
    USING (kind IN ('ceo','pzo') AND app_private.can_write_leader(project_id, kind))
    WITH CHECK (kind IN ('ceo','pzo') AND app_private.can_write_leader(project_id, kind));
CREATE POLICY leader_notes_read ON public.leader_notes FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY leader_notes_write ON public.leader_notes FOR ALL TO app_runtime
    USING (kind IN ('ceo_brief','pzo_note') AND app_private.can_write_leader(project_id, kind))
    WITH CHECK (kind IN ('ceo_brief','pzo_note') AND app_private.can_write_leader(project_id, kind));

CREATE POLICY project_master_read ON public.project_master FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY project_master_write ON public.project_master FOR ALL TO app_runtime
    USING (app_private.can_manage_project(project_id))
    WITH CHECK (app_private.can_manage_project(project_id));
CREATE POLICY project_phases_read ON public.project_phases FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY project_phases_write ON public.project_phases FOR ALL TO app_runtime
    USING (app_private.can_manage_project(project_id))
    WITH CHECK (app_private.can_manage_project(project_id));
CREATE POLICY project_drawings_read ON public.project_drawings FOR SELECT TO app_runtime
    USING (app_private.can_read_project(project_id));
CREATE POLICY project_drawings_write ON public.project_drawings FOR ALL TO app_runtime
    USING (app_private.can_manage_project(project_id))
    WITH CHECK (app_private.can_manage_project(project_id));

-- Row policies cannot restrict individual columns. Keep the PM node-edit
-- boundary in the database as well as in the server's writable-field list.
CREATE OR REPLACE FUNCTION app_private.guard_milestone_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_user <> 'app_runtime' THEN RETURN NEW; END IF;
    IF NOT app_private.has_approved_role(ARRAY['ops','president']) THEN
        IF NOT app_private.has_approved_role(ARRAY['pm'])
           OR NOT app_private.can_read_project(OLD.project_id)
           OR (to_jsonb(NEW) - ARRAY['forecast_date','note','rich_text','updated_at'])
              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['forecast_date','note','rich_text','updated_at']) THEN
            RAISE EXCEPTION 'PM may update only forecast_date and note' USING ERRCODE = '42501';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_milestone_update ON public.milestones;
CREATE TRIGGER guard_milestone_update BEFORE UPDATE ON public.milestones
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_milestone_update();

CREATE OR REPLACE FUNCTION app_private.guard_report_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_user <> 'app_runtime' THEN RETURN NEW; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.period IS DISTINCT FROM OLD.period OR NEW.line IS DISTINCT FROM OLD.line
       OR NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.history IS DISTINCT FROM OLD.history OR NEW.locked IS DISTINCT FROM OLD.locked THEN
        RAISE EXCEPTION 'Submitted report identity and history cannot be rewritten' USING ERRCODE = '42501';
    END IF;
    NEW.history := COALESCE(OLD.history, '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object(
            'at', now(), 'by', auth.uid(), 'data', to_jsonb(OLD) - 'history'));
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_report_update ON public.reports;
CREATE TRIGGER guard_report_update BEFORE UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION app_private.guard_report_update();

REVOKE ALL ON FUNCTION app_private.guard_milestone_update(),
    app_private.guard_report_update() FROM PUBLIC;

COMMIT;
