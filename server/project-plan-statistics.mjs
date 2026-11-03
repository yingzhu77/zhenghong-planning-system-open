import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { preloadCompletionDeadlines, resolveCompletionSource } from './completion-sources.mjs';

const DAY = 86400000;
const invalid = message => { throw new HttpError(400, message, 'invalid_project_statistics'); };
const forbidden = () => { throw new HttpError(403, '无权查看此项目计划统计', 'project_statistics_forbidden'); };
const iso = date => date.toISOString().slice(0, 10);
function calendarDay(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && iso(date) === value;
}
function addDays(value, days) { return iso(new Date(new Date(value + 'T00:00:00Z').getTime() + days * DAY)); }
function monday(value) { return addDays(value, 1 - (new Date(value + 'T00:00:00Z').getUTCDay() || 7)); }
function todayShanghai() { return iso(new Date(Date.now() + 8 * 3600000)); }
function readRequest(request, today) {
  const names = ['kind', 'month', 'display_group', 'project_id', 'discipline', 'key_only', 'level', 'completion', 'risk', 'date_mode', 'start', 'end'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !names.includes(key))) invalid('项目统计筛选格式不正确');
  for (const [key, value] of Object.entries(request)) {
    if (key === 'key_only') { if (typeof value !== 'boolean') invalid('关键节点筛选格式不正确'); }
    else if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid('项目统计筛选格式不正确');
  }
  const filters = { kind: 'all', display_group: '', project_id: '', discipline: '', key_only: false,
    level: '', completion: 'all', risk: 'all', date_mode: 'all', start: '', end: '', ...request };
  if (!['all', 'res', 'com'].includes(filters.kind)) invalid('项目类型筛选不正确');
  // Older clients may still send the confirmed-plan month. It is accepted only
  // for request compatibility and cannot constrain a baseline denominator.
  if (filters.month !== undefined && !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(filters.month)) invalid('请选择有效的确认月份');
  delete filters.month;
  if (!['all', 'completed', 'incomplete'].includes(filters.completion)) invalid('完成状态不正确');
  if (!['all', 'severe', 'attention', 'slight', 'normal', 'insufficient', 'overdue'].includes(filters.risk)) invalid('风险筛选不正确');
  if (!['all', 'week', 'month', 'next30', 'custom'].includes(filters.date_mode)) invalid('计划日期筛选不正确');
  if (filters.date_mode === 'week') { filters.start = monday(today); filters.end = addDays(filters.start, 6); }
  else if (filters.date_mode === 'month') {
    filters.start = today.slice(0, 7) + '-01';
    const date = new Date(filters.start + 'T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1); filters.end = addDays(iso(date), -1);
  } else if (filters.date_mode === 'next30') { filters.start = today; filters.end = addDays(today, 29); }
  else if (filters.date_mode === 'custom' && (!calendarDay(filters.start) || !calendarDay(filters.end) || filters.start > filters.end)) invalid('请选择有效的计划起止日期');
  else if (filters.date_mode === 'all') { filters.start = ''; filters.end = ''; }
  return filters;
}
const groupOf = project => project.display_group || project.name;
const date = value => calendarDay(value) ? value : '';
function baseRow(project, values) {
  return { project_id: project.id, project_name: project.name, project_type: project.project_type, display_group: groupOf(project),
    completed: false, completion_date: '', completion_basis: 'none', on_time: null, deviation: null,
    extension_approved: false, ...values };
}
function decorate(row, today) {
  row.insufficient = !row.plan_due || !row.forecast_due;
  row.overdue = !row.completed && !!row.effective_due && row.effective_due < today;
  row.due_next30 = !row.completed && !!row.effective_due && row.effective_due >= today && row.effective_due <= addDays(today, 29);
  if (row.completed) row.risk = 'completed';
  else if (row.insufficient) row.risk = 'insufficient';
  else {
    row.deviation = Math.round((new Date(row.forecast_due) - new Date(row.plan_due)) / DAY);
    row.risk = row.deviation >= 15 ? 'severe' : row.deviation >= 5 ? 'attention' : row.deviation > 0 ? 'slight' : 'normal';
  }
  return row;
}
function matches(row, filters) {
  const riskMatches = filters.risk === 'all' || (['insufficient', 'overdue'].includes(filters.risk)
    ? row[filters.risk] : row.risk === filters.risk);
  return (!filters.project_id || row.project_id === filters.project_id)
    && (!filters.display_group || row.display_group === filters.display_group)
    && (!filters.discipline || row.discipline === filters.discipline)
    && (!filters.key_only || row.is_key) && (!filters.level || row.level === filters.level)
    && (filters.completion === 'all' || row.completed === (filters.completion === 'completed'))
    && riskMatches
    && (!filters.start || !!row.plan_due && row.plan_due >= filters.start && row.plan_due <= filters.end);
}
function summarize(rows) {
  const count = predicate => rows.filter(predicate).length, completed = count(row => row.completed);
  const covered = count(row => row.completed && row.on_time !== null);
  return { total: rows.length, completed, incomplete: rows.length - completed, completion_rate: rows.length ? completed / rows.length * 100 : null,
    forecast_delayed: count(row => row.deviation > 0), overdue: count(row => row.overdue), due_next30: count(row => row.due_next30),
    insufficient: count(row => row.insufficient), on_time: count(row => row.on_time === true),
    late: count(row => row.on_time === false), timeliness_covered: covered, timeliness_unknown: completed - covered,
    project_count: new Set(rows.map(row => row.project_id)).size, group_count: new Set(rows.map(row => row.display_group)).size };
}
async function preloadSources(client, user, actor, requests, projects, nodes, cache) {
  cache.set('caller:' + user.id, actor);
  for (const project of projects) cache.set('project:' + user.id + ':' + project.id, project);
  const ownerIds = [...new Set(requests.map(row => row.owner_id))];
  if (!ownerIds.length) return;
  const owners = (await client.query('SELECT user_id,name,role,status,biz_line,discipline FROM public.profiles WHERE user_id=ANY($1::text[])', [ownerIds])).rows;
  const members = (await client.query('SELECT user_id,project_id FROM public.project_members WHERE user_id=ANY($1::text[]) AND project_id=ANY($2::text[])', [ownerIds, projects.map(row => row.id)])).rows;
  const membership = new Set(members.map(row => JSON.stringify([row.user_id, row.project_id])));
  for (const owner of ownerIds) {
    cache.set('owner:' + user.id + ':' + owner, owners.find(row => row.user_id === owner));
    for (const project of projects) cache.set('member:' + user.id + ':' + owner + ':' + project.id, membership.has(JSON.stringify([owner, project.id])));
  }
  for (const node of nodes) {
    // This is the established milestone source contract. Projection-only fields
    // such as discipline and biz_line must never invalidate an existing approval.
    const snapshot = Object.fromEntries(['id', 'project_id', 'name', 'plan_date', 'forecast_date', 'done', 'key_name', 'level', 'is_key',
      'standard', 'owner_dept', 'owner_name', 'source', 'plan_version', 'note', 'line'].map(field => [field, node[field]]));
    cache.set('source:' + user.id + ':milestone:' + node.project_id + ':' + node.id, snapshot);
  }
  await preloadCompletionDeadlines(client, requests, cache);
}

// Current-state read only. Every source and approval is read under the caller's
// existing runtime/RLS identity, and every presentation consumes these rows.
export async function projectPlanStatistics(pool, user, request = {}) {
  const today = todayShanghai(), filters = readRequest(request, today);
  return withIdentity(pool, user.id, async client => {
    const actor = await getProfile(client, user.id);
    if (actor?.status !== 'approved' || !['ops', 'president', 'pzo'].includes(actor.role)) forbidden();
    // Existing readers treat an absent legacy type as residential. Normalize
    // the read projection so the denominator and filter options agree as well.
    const allProjects = (await client.query('SELECT id,name,display_group,project_type FROM public.projects ORDER BY sort_order,id')).rows
      .map(project => ({ ...project, project_type: project.project_type || 'res' }));
    if (filters.project_id && !allProjects.some(row => row.id === filters.project_id)) forbidden();
    const projects = allProjects.filter(row => filters.kind === 'all' || row.project_type === filters.kind), projectMap = new Map(projects.map(row => [row.id, row]));
    const ids = projects.map(row => row.id);
    const nodes = ids.length ? (await client.query('SELECT id::text AS id,project_id,name,plan_date::text AS plan_date,forecast_date::text AS forecast_date,done,key_name,level,is_key,standard,owner_dept,owner_name,source,plan_version,note,line,discipline,biz_line FROM public.milestones WHERE project_id=ANY($1::text[]) ORDER BY project_id,sort_order,id', [ids])).rows : [];
    const rows = [], sourceRows = new Map();
    for (const node of nodes) {
      const key = 'milestone:' + node.project_id + ':' + node.id, project = projectMap.get(node.project_id), commercial = project.project_type === 'com';
      const row = baseRow(project, { id: key, source_key: key, source_id: node.id, title: node.name,
        discipline: (commercial ? node.biz_line : node.discipline) || '未归属', module: commercial ? node.biz_line || '未归属' : '', level: node.level || '', is_key: !!node.is_key,
        plan_due: date(node.plan_date), forecast_due: date(node.forecast_date), effective_due: date(node.forecast_date) || date(node.plan_date), legacy_done: !!node.done });
      rows.push(row); sourceRows.set(key, row);
    }
    const allKeys = [...sourceRows.keys()];
    const approvals = allKeys.length ? (await client.query("SELECT id,source_key,source_version,project_id,kind,owner_id,title,what,due,effective_due,source_snapshot,request_type,requested_due::text AS requested_due,completion_date::text AS completion_date,approved_at::text AS approved_at FROM public.completion_requests WHERE status='approved' AND source_key=ANY($1::text[]) ORDER BY approved_at DESC,id DESC", [allKeys])).rows : [];
    const cache = new Map();
    await preloadSources(client, user, actor, approvals, projects, nodes, cache);
    const reviewedNodes = new Set(approvals.filter(entry => entry.request_type === 'completion' && entry.kind === 'milestone').map(entry => entry.source_key));
    for (const approval of approvals) {
      const row = sourceRows.get(approval.source_key);
      let source;
      try { source = await resolveCompletionSource(client, user, approval.source_key, { forOwnerId: approval.owner_id, cache }); }
      catch (error) { if (error instanceof HttpError && [400, 403, 404].includes(error.status)) continue; throw error; }
      const valid = approval.request_type === 'extension'
        ? approval.due === (source.due || '') && approval.title === source.title && approval.what === source.what
          && (approval.source_snapshot?.who_id ?? null) === (source.source_snapshot?.who_id ?? null)
        : approval.source_version === source.source_version;
      if (!valid) continue;
      if (approval.request_type === 'extension') {
        if (!row.extension_approved) { row.extension_approved = true; row.effective_due = date(approval.requested_due) || row.effective_due; }
      } else if (!row.completed) {
        row.completed = true; row.completion_basis = 'approval'; row.completion_date = date(approval.completion_date);
        const frozenDue = date(approval.effective_due ?? approval.source_snapshot?.effective_due ?? approval.due);
        row.on_time = frozenDue && row.completion_date ? row.completion_date <= frozenDue : null;
      }
    }
    for (const row of rows) {
      if (row.legacy_done && !reviewedNodes.has(row.source_key)) { row.completed = true; row.completion_basis = 'legacy'; }
      delete row.legacy_done; decorate(row, today);
    }
    const options = { projects: projects.map(project => ({ ...project, display_group: groupOf(project) })),
      groups: [...new Set(projects.map(groupOf))], disciplines: [...new Set(rows.map(row => row.discipline))].sort(),
      levels: [...new Set(rows.map(row => row.level).filter(Boolean))].sort() };
    const filtered = rows.filter(row => matches(row, filters));
    return { today, source: filters.kind + '_baseline', filters, options, rows: filtered,
      totals: summarize(filtered), projects: projects.filter(project => filtered.some(row => row.project_id === project.id)).map(project => ({
        id: project.id, name: project.name, project_type: project.project_type, display_group: groupOf(project), ...summarize(filtered.filter(row => row.project_id === project.id)) })) };
  });
}
