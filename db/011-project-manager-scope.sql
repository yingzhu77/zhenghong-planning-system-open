-- Project managers read and give project-manager instructions only within
-- their assigned primary project or explicit project membership.
BEGIN;

CREATE OR REPLACE FUNCTION app_private.can_read_project(target_project_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT auth.uid() IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = target_project_id)
      AND (
        app_private.has_approved_role(ARRAY['ops', 'president'])
        OR (
          app_private.has_approved_role(ARRAY['pzo'])
          AND (
            EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.user_id = auth.uid() AND p.project_id = target_project_id)
            OR EXISTS (SELECT 1 FROM public.project_members pm
                       WHERE pm.user_id = auth.uid() AND pm.project_id = target_project_id)
          )
        )
        OR (
          app_private.has_approved_role(ARRAY['pm'])
          AND EXISTS (SELECT 1 FROM public.project_members pm
                      WHERE pm.user_id = auth.uid() AND pm.project_id = target_project_id)
        )
      );
$$;

CREATE OR REPLACE FUNCTION app_private.can_write_leader(target_project_id text, target_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = target_project_id)
      AND CASE
        WHEN target_kind IN ('ceo', 'ceo_brief')
          THEN app_private.has_approved_role(ARRAY['ops', 'president'])
        WHEN target_kind IN ('pzo', 'pzo_note')
          THEN app_private.has_approved_role(ARRAY['ops'])
            OR (app_private.has_approved_role(ARRAY['pzo'])
                AND app_private.can_read_project(target_project_id))
        ELSE false
      END;
$$;

COMMIT;
