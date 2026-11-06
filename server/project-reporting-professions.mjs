import { BUSINESS_MODULES } from './commercial-modules.mjs';
import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { RESIDENTIAL_DISCIPLINES } from './report-lines.mjs';
import { configuredReportScopes } from './report-scopes.mjs';

const reserved = new Set([...BUSINESS_MODULES, ...RESIDENTIAL_DISCIPLINES,
  '综合', '全部专业', '未归专业', '未指定专业', '待分配', '未分配', '良安田', '良安田项目']);
const label = (value, max = 200) => typeof value === 'string' && value.length <= max && !!value.trim() && !value.includes('\0');
const forbidden = () => new HttpError(403, '仅已审核的管理员可维护项目汇报专业', 'reporting_professions_forbidden');

async function operator(client, user) {
  const profile = await getProfile(client, user.id);
  if (profile?.status !== 'approved' || profile.role !== 'ops') throw forbidden();
}
async function reportingScope(client, pid) {
  const scope = (await configuredReportScopes(client)).find(row => row.project_ids.includes(pid));
  if (scope && (scope.anchor_project_id !== pid || scope.reporting_mode !== 'professional')) {
    throw new HttpError(400, '请选用对应的统一专业填报入口', 'reporting_scope_required');
  }
  return scope?.project_ids || [pid];
}

export async function addProjectReportingProfession(pool, user, { project_id, line }) {
  const name = typeof line === 'string' ? line.normalize('NFC').trim() : '';
  if (!label(project_id) || !/^[\p{L}\p{N}][\p{L}\p{N} +（）()·/_-]{0,39}$/u.test(name) || reserved.has(name)) {
    throw new HttpError(400, '请输入 1 至 40 个字符的专业名称，已有系统专业不可重复新增', 'invalid_reporting_profession');
  }
  return withIdentity(pool, user.id, async client => {
    await operator(client, user);
    await reportingScope(client, project_id);
    const project = (await client.query('SELECT reporting_professions FROM public.projects WHERE id=$1 AND active FOR UPDATE', [project_id])).rows[0];
    if (!project) throw new HttpError(404, '项目不存在或已停用', 'reporting_project_missing');
    const lines = project.reporting_professions || [];
    if (lines.some(line => line.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, '该项目已有同名专业', 'reporting_profession_exists');
    }
    const saved = (await client.query(`UPDATE public.projects SET reporting_professions=$2::text[]
      WHERE id=$1 AND app_private.has_approved_role(ARRAY['ops']) RETURNING id, reporting_professions`,
    [project_id, [...lines, name]])).rows[0];
    if (!saved) throw forbidden();
    return saved;
  });
}

export async function listProjectReportingGrants(pool, user) {
  return withIdentity(pool, user.id, async client => {
    const profile = await getProfile(client, user.id);
    if (profile?.status !== 'approved' || !['pm', 'ops'].includes(profile.role)) throw forbidden();
    return (await client.query(`SELECT g.user_id,g.project_id,g.line FROM public.project_reporting_grants g
      WHERE NOT EXISTS(SELECT 1 FROM app_private.report_scopes s WHERE s.anchor_project_id=g.project_id
        AND NOT app_private.can_read_report_scope(s.project_ids))
      ORDER BY g.project_id,g.line,g.user_id`)).rows;
  });
}

export async function grantProjectReportingProfession(pool, user, { project_id, line, user_id }) {
  if (!label(project_id) || !label(line, 40) || !label(user_id)) throw new HttpError(400, '请选择项目、专业和提报人');
  return withIdentity(pool, user.id, async client => {
    await operator(client, user);
    const members = await reportingScope(client, project_id);
    const person = (await client.query("SELECT user_id FROM public.profiles WHERE user_id=$1 AND role='pm' AND status='approved' FOR SHARE", [user_id])).rows[0];
    const assigned = (await client.query('SELECT project_id FROM public.project_members WHERE user_id=$1 AND project_id=ANY($2::text[]) FOR SHARE', [user_id, members])).rows;
    if (!person || assigned.length !== members.length) throw new HttpError(403, '提报人须已审核，并拥有该填报范围的全部项目成员权限', 'reporting_member_required');
    const project = (await client.query('SELECT reporting_professions FROM public.projects WHERE id=$1 AND active', [project_id])).rows[0];
    if (!project?.reporting_professions?.includes(line)) throw new HttpError(400, '该自定义专业不属于当前项目', 'invalid_reporting_profession');
    await client.query(`INSERT INTO public.project_reporting_grants(user_id,project_id,line,granted_by)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [user_id, project_id, line, user.id]);
    return { user_id, project_id, line };
  });
}
