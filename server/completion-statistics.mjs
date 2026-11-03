import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { preloadCompletionDeadlines, preloadOperatorCompletionSources, resolveCompletionSource } from './completion-sources.mjs';

const kinds = [
  { id: 'milestone', name: '计划节点' }, { id: 'plan', name: '填报计划' },
  { id: 'leader', name: '领导安排' }, { id: 'meeting', name: '会议事项' }, { id: 'coord', name: '协调／移交' }
];
const measures = ['completed', 'on_time', 'late', 'undetermined', 'pending', 'rejected', 'withdrawn', 'reopened', 'source_changed',
  'extension_requested', 'extension_approved', 'extension_pending'];
const invalid = message => { throw new HttpError(400, message, 'invalid_statistics'); };
function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function currentWeek() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = new Date(today + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function readRequest(request) {
  const allowed = ['project_id', 'owner_id', 'discipline', 'kind', 'start', 'end'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !allowed.includes(key))) invalid('统计筛选格式不正确');
  for (const name of allowed) if (request[name] !== undefined && (typeof request[name] !== 'string' || request[name].length > 200 || request[name].includes('\u0000'))) invalid('统计筛选格式不正确');
  const range = { ...currentWeek(), ...Object.fromEntries(['start', 'end'].filter(key => request[key] !== undefined).map(key => [key, request[key]])) };
  if (!calendarDay(range.start) || !calendarDay(range.end) || range.start > range.end) invalid('请选择有效的统计起止日期');
  if (request.kind && !kinds.some(kind => kind.id === request.kind)) invalid('事项类别不正确');
  return { ...request, ...range };
}
function accumulator() { return Object.fromEntries(measures.map(name => [name, new Set()])); }
function counts(acc) { return Object.fromEntries(measures.map(name => [name, acc[name].size])); }
function changed(row, source) {
  return row.request_type === 'extension'
    ? row.due !== (source.due || '') || row.title !== source.title || row.what !== source.what
      || (row.source_snapshot?.who_id ?? null) !== (source.source_snapshot?.who_id ?? null)
    : row.source_version !== source.source_version;
}
async function validSource(client, user, row, cache) {
  try { return !changed(row, await resolveCompletionSource(client, user, row.source_key, { forOwnerId: row.owner_id, cache })); }
  catch (error) {
    if (error instanceof HttpError && [400, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

// Read the complete date-filtered relation inside the original runtime/RLS
// identity. The review queue's pagination never defines the statistics scope.
export async function completionStatistics(pool, user, request = {}) {
  const filters = readRequest(request);
  return withIdentity(pool, user.id, async client => {
    const actor = await getProfile(client, user.id);
    if (actor?.status !== 'approved' || actor.role !== 'ops') throw new HttpError(403, '仅运营可查看员工完成统计', 'statistics_forbidden');
    const projects = (await client.query('SELECT id,name FROM public.projects ORDER BY sort_order,id')).rows;
    if (filters.project_id && !projects.some(project => project.id === filters.project_id)) throw new HttpError(403, '无权查看此项目', 'statistics_forbidden');
    const employees = (await client.query("SELECT p.user_id,p.name,p.role,p.discipline,p.biz_line FROM public.profiles p JOIN app_private.auth_users a ON a.user_id=p.user_id WHERE p.status='approved' AND NOT a.disabled AND btrim(p.name)<>'' ORDER BY p.name,p.user_id")).rows;
    const projectPeople = filters.project_id
      ? new Set((await client.query('SELECT user_id FROM app_private.project_people($1)', [filters.project_id])).rows.map(row => row.user_id)) : null;
    const selected = employees.filter(row => (!projectPeople || projectPeople.has(row.user_id))
      && (!filters.owner_id || row.user_id === filters.owner_id)
      && (!filters.discipline || row.discipline === filters.discipline || row.biz_line === filters.discipline));
    const ownerIds = selected.map(row => row.user_id);
    const rows = ownerIds.length ? (await client.query(
      "SELECT id,source_key,source_version,project_id,kind,owner_id,title,what,due,effective_due,source_snapshot,request_type,status,completion_date::text AS completion_date,created_at::text AS created_at FROM public.completion_requests WHERE owner_id=ANY($1::text[]) AND ($2::text='' OR project_id=$2) AND ($3::text='' OR kind=$3) AND ((request_type='completion' AND completion_date BETWEEN $4::date AND $5::date) OR (request_type='extension' AND (created_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $4::date AND $5::date)) ORDER BY created_at DESC,id DESC",
      [ownerIds, filters.project_id || '', filters.kind || '', filters.start, filters.end])).rows : [];
    const cache = new Map();
    await preloadOperatorCompletionSources(client, user, rows, cache);
    await preloadCompletionDeadlines(client, rows, cache);
    const totals = accumulator(), people = new Map(selected.map(employee => [employee.user_id, {
      ...employee, acc: accumulator(), categories: new Map(kinds.map(kind => [kind.id, { kind: kind.id, label: kind.name, acc: accumulator() }]))
    }]));
    const seenCompletions = new Set();
    for (const row of rows) {
      const person = people.get(row.owner_id), category = person.categories.get(row.kind);
      if (!category) continue;
      const key = JSON.stringify([row.source_key, row.owner_id]);
      const add = name => { totals[name].add(key); person.acc[name].add(key); category.acc[name].add(key); };
      if (row.request_type === 'extension') add('extension_requested');
      else {
        if (seenCompletions.has(key)) continue;
        seenCompletions.add(key);
      }
      if (!(await validSource(client, user, row, cache))) { add('source_changed'); continue; }
      if (row.request_type === 'extension') {
        if (row.status === 'approved') add('extension_approved');
        if (row.status === 'pending') add('extension_pending');
        continue;
      }
      if (row.status !== 'approved') {
        if (['pending', 'rejected', 'withdrawn', 'reopened'].includes(row.status)) add(row.status);
        continue;
      }
      add('completed');
      // A pre-extension record may have NULL effective_due. Its saved source
      // deadline is the historical fallback; a later extension cannot rewrite it.
      const deadline = row.effective_due ?? row.source_snapshot?.effective_due ?? row.due ?? '';
      add(!calendarDay(deadline) ? 'undetermined' : row.completion_date > deadline ? 'late' : 'on_time');
    }
    return {
      range: { start: filters.start, end: filters.end },
      filters: { projects, employees, disciplines: [...new Set(employees.flatMap(row => [row.discipline, row.biz_line]).filter(Boolean))].sort(), kinds },
      totals: counts(totals),
      employees: [...people.values()].map(({ acc, categories, ...employee }) => ({ ...employee, counts: counts(acc),
        categories: [...categories.values()].filter(category => !filters.kind || category.kind === filters.kind).map(({ acc: categoryAcc, ...category }) => ({ ...category, counts: counts(categoryAcc) })) })),
      meta: { complete: true, rows_checked: rows.length, employee_count: selected.length, completion_date_basis: 'actual_completion_date',
        extension_date_basis: 'request_created_date_shanghai', extension_count_basis: 'distinct_source_owner', current_valid_approvals_only: true }
    };
  });
}
