-- Explicit account-level test access. No profiles or business rows are changed.
-- Replacing the existing three-argument helper preserves its owner and ACL.
BEGIN;
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
            THEN target_line = ANY(ARRAY['土建工程','机电工程','精装工程','景观设计+工程','幕墙设计+工程',
                '建筑结构设计','机电设计','精装设计','成本','招采'])
              AND (p.biz_line = '*' OR target_line = p.biz_line)
            ELSE target_line = '综合'
          END
      );
$$;
COMMIT;
