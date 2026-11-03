import { HttpError } from './errors.mjs';
import { getProfile, reportWeekStart, withIdentity } from './database.mjs';
import { resolveWritableResidentialLine } from './report-lines.mjs';

export async function configuredReportScopes(client) {
  return (await client.query("SELECT id,name,anchor_project_id,project_ids,effective_week::text AS effective_week,COALESCE(to_jsonb(s)->>'reporting_mode','comprehensive') AS reporting_mode FROM app_private.report_scopes s ORDER BY id")).rows;
}
export async function scopeHasAllProjects(client, ids) {
  const rows = (await client.query('SELECT id FROM public.projects WHERE id=ANY($1::text[])', [ids])).rows;
  return ids.length > 0 && ids.every(id => rows.some(row => row.id === id));
}
async function legacyReports(client, scope, week) {
  const rows = (await client.query('SELECT period,submitted_at FROM public.reports WHERE project_id=ANY($1::text[]) AND report_scope_id IS NULL', [scope.project_ids])).rows;
  return rows.some(row => reportWeekStart(row.period, row.submitted_at) === week);
}
export async function listReportScopes(pool, user, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'period') || input.period !== undefined && (typeof input.period !== 'string' || input.period.length > 100)) throw new HttpError(400, '填报范围查询不正确');
  return withIdentity(pool, user.id, async client => {
    const profile = await getProfile(client, user.id);
    if (profile?.status !== 'approved' || !['pm','ops','president','pzo'].includes(profile.role)) throw new HttpError(403, '账号无权读取填报范围');
    const out = [], week = reportWeekStart(input.period || new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10));
    for (const scope of await configuredReportScopes(client)) {
      if (!await scopeHasAllProjects(client, scope.project_ids)) continue;
      const prior = (await client.query('SELECT period,submitted_at FROM public.reports WHERE project_id=ANY($1::text[]) AND report_scope_id IS NULL', [scope.project_ids])).rows;
      const blocked_weeks = [...new Set(prior.map(row => reportWeekStart(row.period,row.submitted_at)).filter(Boolean))];
      const blocked = blocked_weeks.includes(week);
      out.push({ ...scope, period_week: week, blocked_weeks, active_for_period: scope.reporting_mode === 'professional' ? !!week : !!week && week >= scope.effective_week && !blocked, blocked_by_legacy: blocked });
    }
    return out;
  });
}

// This runs inside the same transaction as report, history, attachment binding,
// and meeting feedback. The advisory lock also covers the absent-report case.
export async function resolveReportScope(client, user, row, existing, period, pid) {
  const requested = existing?.report_scope_id || row.report_scope_id;
  if (existing && !existing.report_scope_id && row.report_scope_id) throw new HttpError(409, '原分期报告已存在，请保留原记录并从历史查看；不可自动归入合并项目', 'report_scope_legacy_conflict');
  if (existing && Object.hasOwn(row, 'report_scope_id') && row.report_scope_id !== existing.report_scope_id) throw new HttpError(403, '不可更改原报告填报范围');
  for (const key of ['scope_project_ids','scope_week']) {
    if (Object.hasOwn(row, key) && (!existing || JSON.stringify(row[key]) !== JSON.stringify(existing[key]))) throw new HttpError(400, '填报范围成员和周期由服务端确定');
    delete row[key];
  }
  const scopes = await configuredReportScopes(client);
  const scope = scopes.find(item => requested ? item.id === requested : item.project_ids.includes(pid));
  if (requested && !scope) throw new HttpError(400, '填报范围不存在');
  const week = reportWeekStart(period, existing?.submitted_at || new Date());
  if (scope?.reporting_mode === 'professional') {
    // Existing original records retain their identity. The merged picker can
    // display them as history without silently adopting them on a new upsert.
    if (existing && !existing.report_scope_id) {
      if (requested) throw new HttpError(409, '原分期报告已存在，请保留原记录并从历史查看；不可自动归入合并项目', 'report_scope_legacy_conflict');
      return null;
    }
    if (!requested) throw new HttpError(409, '请使用合并项目的本人专业入口；原记录和本机草稿保留', 'report_scope_required');
    if (!week) throw new HttpError(400, '合并项目需要可识别的填报周', 'report_scope_period_invalid');
    if (pid !== scope.anchor_project_id || !await scopeHasAllProjects(client, scope.project_ids)) throw new HttpError(403, '合并项目需要全部成员项目的原授权', 'report_scope_forbidden');
    if (existing && JSON.stringify(existing.scope_project_ids) !== JSON.stringify(scope.project_ids)) throw new HttpError(409, '原报告范围与当前配置不一致，请联系管理员核对');
    const profile = await getProfile(client, user.id), line = existing?.line ?? row.line;
    if (line === '综合') {
      if (!existing?.report_scope_id || existing.author_id !== user.id) throw new HttpError(403, '合并项目请按本人专业提报；原综合报告保留原作者', 'residential_discipline_forbidden');
    } else if (resolveWritableResidentialLine(profile, line) !== line || line !== profile?.discipline) {
      throw new HttpError(403, '只能填报本人获授权的住宅专业', 'residential_discipline_forbidden');
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['report-scope:' + scope.id + ':' + week + ':' + line + ':' + user.id]);
    row.report_scope_id = scope.id;
    row.scope_project_ids = scope.project_ids;
    row.scope_week = week;
    return scope;
  }
  if (scope && !week && !requested && !existing) {
    const original = (await client.query("SELECT id FROM public.reports WHERE project_id=$1 AND period=$2 AND line='综合' AND author_id=$3 AND report_scope_id IS NULL", [pid,period,user.id])).rows[0];
    if (!original) throw new HttpError(400, '统一填报周期无法识别，请使用带日期范围的报告周', 'report_scope_period_invalid');
  }
  if (!scope || !week || week < scope.effective_week) {
    if (requested) throw new HttpError(400, '此周期尚未启用统一填报');
    return null;
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['report-scope:' + scope.id + ':' + week]);
  const blocked = await legacyReports(client, scope, week);
  if (blocked) {
    if (requested) throw new HttpError(409, '本周已有原地块报告，请保留原入口继续填写，不自动合并旧报告', 'scope_legacy_period');
    return null;
  }
  if (!requested) {
    // An existing original report is always preserved. For an unsubmitted week,
    // partial access cannot create a hidden fragment of the group report.
    if (!existing) throw new HttpError(409, '此周期请使用正弘序统一填报入口；旧本机草稿仍保留', 'report_scope_required');
    return null;
  }
  if (pid !== scope.anchor_project_id || !await scopeHasAllProjects(client, scope.project_ids)) throw new HttpError(403, '统一填报需要全部成员项目的原授权', 'report_scope_forbidden');
  if (existing && JSON.stringify(existing.scope_project_ids) !== JSON.stringify(scope.project_ids)) throw new HttpError(409, '原报告范围与当前配置不一致，请联系管理员核对');
  row.report_scope_id = scope.id;
  row.scope_project_ids = scope.project_ids;
  row.scope_week = week;
  return scope;
}
