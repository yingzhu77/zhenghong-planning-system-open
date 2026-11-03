import { randomUUID } from 'node:crypto';
import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { BUSINESS_MODULES, resolveWritableBusinessLine } from './commercial-modules.mjs';
import { validateRichText } from './rich-text.mjs';
import { RESIDENTIAL_DISCIPLINES, resolveWritableResidentialLine } from './report-lines.mjs';
import { scopeHasAllProjects } from './report-scopes.mjs';

export const MONTHLY_PLAN_COLUMNS = 'id,project_id,line,plan_month::text AS plan_month,items,rich_text,confirmed_by,confirmed_by AS owner_id,confirmed_name,confirmed_at,report_scope_id,scope_project_ids';
const columns = MONTHLY_PLAN_COLUMNS;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PLAN_LINES = [...new Set([...BUSINESS_MODULES, ...RESIDENTIAL_DISCIPLINES])];
function input(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, '月计划请求格式不正确', 'invalid_monthly_plan');
}
function text(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000') || required && !value.trim()) throw new HttpError(400, label + '格式不正确或过长', 'invalid_monthly_plan');
  return value;
}
export function monthlyPlanMonth(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new HttpError(400, '请选择有效的计划月份', 'invalid_monthly_plan');
  return value + '-01';
}
const month = monthlyPlanMonth;
function due(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, '事项完成时间不正确', 'invalid_monthly_plan');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HttpError(400, '事项完成时间不正确', 'invalid_monthly_plan');
  return value;
}
async function scope(client, user, pid, line, write, reportScopeId) {
  const profile = await getProfile(client, user.id, {project_id:pid});
  if (profile?.status !== 'approved' || !['pm', 'ops', 'president', 'pzo'].includes(profile.role) || write && profile.role !== 'pm') throw new HttpError(403, '无权执行此月计划操作', 'monthly_plan_forbidden');
  let project;
  if (pid !== undefined) {
    project = (await client.query('SELECT id,project_type FROM public.projects WHERE id=$1', [pid])).rows[0];
    if (!project) throw new HttpError(403, '未分配此项目', 'monthly_plan_forbidden');
  }
  let configured;
  if (reportScopeId !== undefined) {
    text(reportScopeId, '统一填报范围', 200, true);
    try {
      configured = (await client.query(write
        ? 'SELECT id,anchor_project_id,project_ids,effective_week::text AS effective_week FROM app_private.lock_monthly_report_scope($1)'
        : 'SELECT id,anchor_project_id,project_ids,effective_week::text AS effective_week FROM app_private.report_scopes WHERE id=$1', [reportScopeId])).rows[0];
    } catch (error) {
      if (error.code === '42501') throw new HttpError(403, '统一月计划需要全部成员项目的原授权', 'monthly_plan_forbidden');
      throw error;
    }
    if (!configured || pid !== undefined && pid !== configured.anchor_project_id || !await scopeHasAllProjects(client, configured.project_ids))
      throw new HttpError(403, '统一月计划需要全部成员项目的原授权', 'monthly_plan_forbidden');
  }
  if (write) {
    if (project.project_type === 'com') resolveWritableBusinessLine(profile, line, pid);
    else resolveWritableResidentialLine(profile, line);
    const allowed = configured
      ? (await client.query('SELECT app_private.can_confirm_scoped_monthly_plan($1,$2,$3) AS allowed', [pid, line, configured.id])).rows[0]?.allowed
      : (await client.query('SELECT app_private.can_confirm_monthly_scope($1,$2) AS allowed', [pid, line])).rows[0]?.allowed;
    if (!allowed)
      throw new HttpError(403, '仅可确认本人专业的独立项目月计划，统一填报范围沿用原流程', 'monthly_plan_forbidden');
  }
  return {profile, configured};
}
export function monthlyPlanFormat(value, items) {
  if (value === undefined) return {};
  if (!object(value)) throw new HttpError(400, '月计划事项格式不正确', 'invalid_rich_text');
  if (!Object.keys(value).length) return {};
  if (value.v !== 1 || !object(value.fields) || Object.keys(value).some(key => !['v', 'fields'].includes(key))
      || Object.keys(value.fields).some(key => !/^items\.(?:0|[1-9]\d*)\.(?:mod|name)$/.test(key))) throw new HttpError(400, '月计划仅支持模块和事项名称的加粗与标红', 'invalid_rich_text');
  const validated = validateRichText('reports', {v: 1, fields: Object.fromEntries(Object.entries(value.fields).map(([key, doc]) => ['biz.' + key, doc]))}, {biz: {items}});
  return {v: 1, fields: Object.fromEntries(Object.entries(validated.fields).map(([key, doc]) => [key.slice(4), doc]))};
}
const format = monthlyPlanFormat;

export function normalizeMonthlyPlanItems(values, reportScopeId) {
  if (!Array.isArray(values) || values.length > 500) throw new HttpError(400, '月计划须为最多500项的列表', 'invalid_monthly_plan');
  const seen = new Set();
  return values.map(item => {
    input(item, reportScopeId == null ? ['source_id', 'mod', 'name', 'due'] : ['source_id', 'mod', 'name', 'due', 'project_id']);
    const sourceId = item.source_id ?? randomUUID();
    if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(sourceId) || seen.has(sourceId)) throw new HttpError(400, '月计划事项标识重复或不正确', 'invalid_monthly_plan');
    seen.add(sourceId);
    return {source_id: sourceId, mod: text(item.mod ?? '', '模块', 200), name: text(item.name, '事项内容', 10000, true), due: due(item.due ?? ''),
      ...(item.project_id === undefined ? {} : {project_id: text(item.project_id, '实际项目', 200, true)})};
  });
}

export async function listMonthlyPlans(pool, user, request = {}) {
  input(request, ['project_id', 'line', 'month', 'report_scope_id', 'owner_id']);
  const pid = request.project_id === undefined ? undefined : text(request.project_id, '项目', 200, true);
  if (request.line !== undefined && !PLAN_LINES.includes(request.line)) throw new HttpError(400, '专业或模块不正确', 'invalid_monthly_plan');
  const target = request.month === undefined ? undefined : month(request.month);
  return withIdentity(pool, user.id, async client => {
    await scope(client, user, pid, request.line, false, request.report_scope_id);
    const values = [], filters = [];
    if (request.owner_id !== undefined) text(request.owner_id, '提报人', 200, true);
    for (const [key, value] of [['project_id', pid], ['line', request.line], ['plan_month', target], ['confirmed_by', request.owner_id]]) if (value !== undefined) {
      values.push(value); filters.push(key + '=$' + values.length);
    }
    if (request.report_scope_id !== undefined) { values.push(request.report_scope_id); filters.push('report_scope_id=$' + values.length); }
    return (await client.query('SELECT ' + columns + ' FROM public.monthly_plans' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY plan_month DESC,project_id,line,id', values)).rows;
  });
}

export async function getMonthlyPlan(pool, user, request) {
  input(request, ['project_id', 'line', 'month', 'report_scope_id', 'owner_id']);
  text(request.project_id, '项目', 200, true); month(request.month);
  if (!PLAN_LINES.includes(request.line)) throw new HttpError(400, '专业或模块不正确', 'invalid_monthly_plan');
  return {plan: (await listMonthlyPlans(pool, user, {...request, owner_id: request.owner_id ?? user.id}))[0] || null};
}

export async function confirmMonthlyPlan(pool, user, request) {
  input(request, ['project_id', 'line', 'month', 'items', 'rich_text', 'report_scope_id']);
  const pid = text(request.project_id, '项目', 200, true), target = month(request.month);
  if (!PLAN_LINES.includes(request.line)) throw new HttpError(400, '专业或模块不正确', 'invalid_monthly_plan');
  const items = normalizeMonthlyPlanItems(request.items, request.report_scope_id);
  const rich = format(request.rich_text, items);
  return withIdentity(pool, user.id, async client => {
    const {configured} = await scope(client, user, pid, request.line, true, request.report_scope_id);
    if (configured) {
      if (items.some(item => item.project_id !== undefined && !configured.project_ids.includes(item.project_id))) throw new HttpError(400, '事项实际项目不在本统一范围内', 'invalid_monthly_plan');
      if (target.slice(0, 7) < configured.effective_week.slice(0, 7)) throw new HttpError(400, '此月份尚未启用统一月计划', 'invalid_monthly_plan');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('monthly-scope-plan:'||jsonb_build_array($1::text,$2::text)::text,0))", [configured.id, target]);
      const count = (await client.query('SELECT COALESCE(sum(jsonb_array_length(items)),0)::int AS total FROM public.monthly_plans WHERE report_scope_id=$1 AND plan_month=$2', [configured.id, target])).rows[0].total;
      if (count + items.length > 500) throw new HttpError(400, '本范围各专业月计划合计最多500项，与统一周报上限一致', 'invalid_monthly_plan');
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('monthly-plan:'||jsonb_build_array($1::text,$2::text,$3::text)::text,0))", [pid, request.line, target]);
    if ((await client.query('SELECT id FROM public.monthly_plans WHERE project_id=$1 AND line=$2 AND plan_month=$3 AND confirmed_by=$4', [pid, request.line, target, user.id])).rows.length) throw new HttpError(409, '本人本模块该月计划已经确认，请刷新查看确认版', 'monthly_plan_confirmed');
    return (await client.query('INSERT INTO public.monthly_plans(id,project_id,line,plan_month,items,rich_text,report_scope_id,scope_project_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ' + columns,
      [randomUUID(), pid, request.line, target, JSON.stringify(items), JSON.stringify(rich), configured?.id ?? null, configured?.project_ids ?? null])).rows[0];
  });
}

export async function withdrawMonthlyPlan(pool, user, request) {
  input(request, ['project_id', 'line', 'month', 'expected_plan_id', 'report_scope_id']);
  const pid = text(request.project_id, '项目', 200, true), target = month(request.month);
  if (!PLAN_LINES.includes(request.line) || typeof request.expected_plan_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.expected_plan_id))
    throw new HttpError(400, '请选择有效的月计划确认版', 'invalid_monthly_plan');
  return withIdentity(pool, user.id, async client => {
    await scope(client, user, pid, request.line, true, request.report_scope_id);
    try {
      const result = request.report_scope_id === undefined
        ? await client.query('SELECT app_private.withdraw_monthly_plan($1,$2,$3,$4) AS plan', [pid, request.line, target, request.expected_plan_id])
        : await client.query('SELECT app_private.withdraw_monthly_plan($1,$2,$3,$4,$5) AS plan', [pid, request.line, target, request.expected_plan_id, request.report_scope_id]);
      return { withdrawn: true, plan: result.rows[0].plan };
    } catch (error) {
      if (error.code === 'P0002') throw new HttpError(409, error.message, 'monthly_plan_changed');
      if (error.code === '23514' && error.detail === 'monthly_plan_in_use') throw new HttpError(409, error.message, 'monthly_plan_in_use');
      if (error.code === '42501') throw new HttpError(403, '仅原确认人可以撤回本人获授权专业的月计划', 'monthly_plan_forbidden');
      throw error;
    }
  });
}
