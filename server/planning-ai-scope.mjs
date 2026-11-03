import { getProfile, withIdentity, reportWeekStart } from './database.mjs';
import { resolveWritableBusinessLine } from './commercial-modules.mjs';
import { resolveReportScope } from './report-scopes.mjs';
import { HttpError } from './errors.mjs';

// Shared by drafting and memory. All project membership is resolved from the
// current authenticated identity rather than accepted from a browser snapshot.
export async function authorizePlanningAIScope(client, user, input) {
  const profile = await getProfile(client, user.id, {project_id:input.project_id});
  if (profile?.status !== 'approved' || profile.role !== 'pm') throw new HttpError(403, '仅本人获授权的填报模块可使用AI整理', 'ai_scope_forbidden');
  const project = (await client.query('SELECT id,name,project_type FROM public.projects WHERE id=$1', [input.project_id])).rows[0];
  if (!project) throw new HttpError(403, '未分配此项目或无权访问', 'ai_scope_forbidden');
  if (project.project_type === 'com') resolveWritableBusinessLine(profile, input.line, input.project_id);
  const allowed = (await client.query('SELECT app_private.can_write_report($1,$2,$3) AS allowed', [input.project_id, input.line, user.id])).rows[0]?.allowed;
  if (!allowed) throw new HttpError(403, '只能整理本人获授权的项目和填报模块', 'ai_scope_forbidden');
  const existing = (await client.query('SELECT * FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3 AND author_id=$4', [input.project_id, input.period, input.line, user.id])).rows[0];
  const row = { project_id: input.project_id, line: input.line, ...(input.report_scope_id ? { report_scope_id: input.report_scope_id } : {}) };
  await resolveReportScope(client, user, row, existing, input.period, input.project_id);
  return {
    name: project.name, line: input.line, period: input.period,
    scope_project_ids: row.scope_project_ids || existing?.scope_project_ids || [],
    report_scope_id: row.report_scope_id || existing?.report_scope_id || '',
    selected_week: reportWeekStart(input.period, existing?.submitted_at || new Date())
  };
}

export function authorizePlanningAI(pool, user, input) {
  return withIdentity(pool, user.id, client => authorizePlanningAIScope(client, user, input));
}
