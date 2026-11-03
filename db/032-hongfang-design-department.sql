-- 弘坊 adds an independent 设计部 scope. Existing modules, owners, reports,
-- snapshots, memberships and account grants are not rewritten or backfilled.
BEGIN;

-- An additional project/module never replaces a reporter's primary module.
CREATE TABLE IF NOT EXISTS public.commercial_module_grants (
 user_id text NOT NULL REFERENCES public.profiles(user_id),
 project_id text NOT NULL REFERENCES public.projects(id) CHECK(project_id='hf'),
 line text NOT NULL CHECK(line='设计部'),
 granted_by text NOT NULL REFERENCES public.profiles(user_id),
 granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,project_id,line));
ALTER TABLE public.commercial_module_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_module_grants FROM PUBLIC,app_runtime;
GRANT SELECT ON public.commercial_module_grants TO app_runtime;

CREATE OR REPLACE FUNCTION app_private.commercial_module_grant_active(owner_id text,pid text,module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT pid='hf' AND module='设计部' AND app_private.can_read_project(pid) AND EXISTS(
 SELECT 1 FROM public.commercial_module_grants g JOIN public.profiles p ON p.user_id=g.user_id
 JOIN public.projects j ON j.id=g.project_id JOIN public.project_members m ON m.user_id=g.user_id AND m.project_id=g.project_id
 WHERE g.user_id=owner_id AND g.project_id=pid AND g.line=module AND p.status='approved' AND p.role='pm' AND j.project_type='com');
$$;
REVOKE ALL ON FUNCTION app_private.commercial_module_grant_active(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.commercial_module_grant_active(text,text,text) TO app_runtime;
DROP POLICY IF EXISTS commercial_module_grants_read ON public.commercial_module_grants;
CREATE POLICY commercial_module_grants_read ON public.commercial_module_grants FOR SELECT TO app_runtime
 USING(app_private.commercial_module_grant_active(user_id,project_id,line));

CREATE OR REPLACE FUNCTION app_private.save_commercial_module_grant(owner_id text,pid text,module text,enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_profile public.profiles%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.profiles WHERE user_id=auth.uid() AND role='ops' AND status='approved' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module grant administration denied' USING ERRCODE='42501'; END IF;
 IF pid IS DISTINCT FROM 'hf' OR module IS DISTINCT FROM '设计部' OR enabled IS NULL THEN RAISE EXCEPTION '附加授权仅适用于弘坊设计部' USING ERRCODE='22023'; END IF;
 SELECT * INTO owner_profile FROM public.profiles WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR owner_profile.role<>'pm' OR owner_profile.status<>'approved' THEN RAISE EXCEPTION '目标账号须为已审核的提报人' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.project_members WHERE user_id=owner_id AND project_id=pid FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=pid AND project_type='com') THEN RAISE EXCEPTION '目标账号必须已有弘坊项目成员授权' USING ERRCODE='42501'; END IF;
 IF enabled AND owner_profile.biz_line IN ('*','设计部') THEN RAISE EXCEPTION '该账号原模块已包含设计部，无需附加授权' USING ERRCODE='22023'; END IF;
 IF enabled THEN
  INSERT INTO public.commercial_module_grants(user_id,project_id,line,granted_by) VALUES(owner_id,pid,module,auth.uid()) ON CONFLICT(user_id,project_id,line) DO NOTHING;
 ELSE DELETE FROM public.commercial_module_grants WHERE user_id=owner_id AND project_id=pid AND line=module;
 END IF;
 RETURN jsonb_build_object('user_id',owner_id,'project_id',pid,'line',module,'enabled',enabled);
END;
$$;
REVOKE ALL ON FUNCTION app_private.save_commercial_module_grant(text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.save_commercial_module_grant(text,text,text,boolean) TO app_runtime;

ALTER TABLE public.monthly_plans DROP CONSTRAINT IF EXISTS monthly_plans_line_check;
ALTER TABLE public.monthly_plans ADD CONSTRAINT monthly_plans_line_check CHECK(
 line=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程',
 '开发','建筑结构设计','机电设计','精装设计','成本','招采','开发报建','设计','工程','营销','商管运营','客服','财务'])
 OR (line='设计部' AND project_id='hf'));

ALTER TABLE public.milestones DROP CONSTRAINT IF EXISTS milestones_biz_line_valid;
ALTER TABLE public.milestones ADD CONSTRAINT milestones_biz_line_valid CHECK(
 biz_line IS NULL OR biz_line=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程',
 '幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采'])
 OR (biz_line='设计部' AND project_id='hf'));

-- CREATE OR REPLACE preserves the existing function owner and grants.
CREATE OR REPLACE FUNCTION app_private.can_write_report(
 target_project_id text,target_line text,target_author_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT target_author_id=auth.uid() AND app_private.can_read_project(target_project_id) AND EXISTS(
 SELECT 1 FROM public.profiles p JOIN public.projects pr ON pr.id=target_project_id
 WHERE p.user_id=auth.uid() AND p.role='pm' AND p.status='approved'
 AND CASE WHEN pr.project_type='com'
 THEN (target_line=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程',
 '幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采'])
 OR (target_line='设计部' AND target_project_id='hf'))
 AND (p.biz_line='*' OR target_line=p.biz_line OR app_private.commercial_module_grant_active(p.user_id,target_project_id,target_line))
 ELSE target_line='综合' OR (target_line=p.discipline AND target_line=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务'])) END);
$$;

CREATE OR REPLACE FUNCTION app_private.can_assign_monthly_plan(owner_id text,pid text,module text,scope_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (owner_id=auth.uid() OR app_private.has_approved_role(ARRAY['ops'])) AND EXISTS(
 SELECT 1 FROM public.profiles p JOIN public.projects j ON j.id=pid
 WHERE p.user_id=owner_id AND p.status='approved' AND p.role='pm'
 AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.user_id=owner_id AND m.project_id=pid)
 AND CASE WHEN j.project_type='com' THEN scope_id IS NULL
 AND (module=ANY(ARRAY['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采']) OR (module='设计部' AND pid='hf'))
 AND (p.biz_line='*' OR p.biz_line=module OR app_private.commercial_module_grant_active(p.user_id,pid,module))
 ELSE module=p.discipline AND module=ANY(ARRAY['开发报建','设计','工程','成本','招采','营销','商管运营','客服','财务']) AND CASE WHEN scope_id IS NULL
 THEN NOT EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE pid=ANY(s.project_ids))
 ELSE EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE s.id=scope_id AND s.anchor_project_id=pid
 AND NOT EXISTS(SELECT 1 FROM unnest(s.project_ids) member WHERE NOT EXISTS(
 SELECT 1 FROM public.project_members m WHERE m.user_id=owner_id AND m.project_id=member))) END END);
$$;
COMMIT;
