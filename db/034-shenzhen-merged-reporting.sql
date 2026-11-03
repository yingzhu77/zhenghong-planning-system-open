-- One professional reporting entrance; original projects, permissions,
-- reports, monthly plans, files and local draft identities remain unchanged.
BEGIN;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM app_private.report_scopes
   WHERE id<>'shenzhen-shangmugu-residential' AND project_ids && ARRAY['szzz','szgy']) THEN
  RAISE EXCEPTION 'Existing Shenzhen reporting scope requires review';
 END IF;
 IF EXISTS(SELECT 1 FROM public.projects WHERE id=ANY(ARRAY['szzz','szgy']) AND project_type<>'res') THEN
  RAISE EXCEPTION 'Shenzhen project type requires review';
 END IF;
END;
$$;
INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week,reporting_mode)
VALUES('shenzhen-shangmugu-residential','深圳上木古','szzz',ARRAY['szzz','szgy'],'2026-10-26','professional')
ON CONFLICT DO NOTHING;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.report_scopes
   WHERE id='shenzhen-shangmugu-residential' AND name='深圳上木古'
   AND anchor_project_id='szzz' AND project_ids=ARRAY['szzz','szgy']
   AND effective_week='2026-10-26' AND reporting_mode='professional') THEN
  RAISE EXCEPTION 'Existing Shenzhen reporting scope configuration requires review';
 END IF;
END;
$$;
COMMIT;
