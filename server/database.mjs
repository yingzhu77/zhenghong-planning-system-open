import { HttpError } from './errors.mjs';
import { prepareRichText, RICH_TEXT_PATHS, hasRichTextChanges } from './rich-text.mjs';
import { randomUUID } from 'node:crypto';
import { validateReportAttachmentReferences } from './report-attachments.mjs';
import { BUSINESS_MODULES, businessModulesForProject, resolveWritableBusinessLine, withBusinessModuleGrants } from './commercial-modules.mjs';
import { resolveCompletionSource, reportCoordinationSourceItem } from './completion-sources.mjs';
import { resolveReportScope } from './report-scopes.mjs';
import { resolveWritableResidentialLine } from './report-lines.mjs';
import { preserveSchemeMaster, sanitizeSchemeRows } from './scheme-protection.mjs';

const fields = (text) => text.split(/\s+/).filter(Boolean);
export const TABLES = Object.freeze({
  projects: fields('id name sort_order active created_at camera_url biz_meta project_type display_group'),
  profiles: fields('user_id name role project_id status created_at biz_line discipline management_viewer'),
  project_members: fields('user_id project_id role_in_project created_at'),
  org: fields('id name dept title org_level sort_order'),
  plan_versions: fields('id project_id version_name effective_date note created_at'),
  plan_changes: fields('id project_id from_version to_version node_name old_date new_date delta_days reason created_at'),
  milestones: fields('id project_id name plan_date forecast_date done sort_order updated_at key_name level is_key standard owner_dept owner_name source plan_version note line rich_text discipline biz_line'),
  reports: fields('id project_id period author_id author_name status change_text dev_text dev_level dev_impact coord decision next_items commit_items history locked submitted_at updated_at node_name node_plan node_forecast impact node_items speed_items effect_items coord_items self_speed self_effect projection line biz rich_text report_scope_id scope_project_ids scope_week'),
  leader_reviews: fields('id project_id period kind speed effect rating note author_name author_role created_at updated_at rich_text'),
  leader_notes: fields('id project_id period kind what due author_name created_at rich_text owner_id owner_name'),
  project_master: fields('project_id fields note updated_by updated_at'),
  project_phases: fields('id project_id name area gfa units_total units_launched units_sold avg_price value plan_handover sort_order updated_at'),
  project_drawings: fields('id project_id kind name path url uploaded_by sort_order created_at')
});
export const CONFLICTS = Object.freeze({
  reports: 'project_id,period,line,author_id',
  leader_reviews: 'project_id,period,kind',
  project_master: 'project_id'
});
const JSON_COLUMNS = new Set(fields('biz_meta next_items commit_items history node_items speed_items effect_items coord_items biz fields rich_text'));
const protectedColumns = new Set(fields('created_at submitted_at updated_at history locked author_id author_name uploaded_by updated_by author_role'));
const roles = new Set(['pm', 'ops', 'president', 'pzo', 'viewer']);
export const quote = (name) => '"' + name + '"';

export function assertTable(table) {
  if (!Object.hasOwn(TABLES, table)) throw new HttpError(400, '不支持的数据表', 'invalid_table');
  return TABLES[table];
}
export function assertColumn(table, column) {
  if (typeof column !== 'string' || !assertTable(table).includes(column)) throw new HttpError(400, '不支持的字段', 'invalid_column');
  return quote(column);
}
function columnList(table, input = '*') {
  if (input === '*' || input == null) return '*';
  const columns = Array.isArray(input) ? input : String(input).split(',').map((x) => x.trim());
  if (!columns.length || columns.length > TABLES[table].length) throw new HttpError(400, '返回字段不正确');
  return columns.map((column) => assertColumn(table, column)).join(',');
}
function valueFor(column, value) {
  if (value === undefined) throw new HttpError(400, '字段值不可为空定义');
  return JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value;
}

// The only identifiers in generated SQL come from TABLES. All values are parameters.
export function buildQuery(input) {
  const { table, operation = 'select' } = input;
  assertTable(table);
  if (!['select', 'insert', 'update', 'upsert', 'delete'].includes(operation)) throw new HttpError(400, '不支持的操作');
  const params = [];
  const param = (column, value) => { params.push(valueFor(column, value)); return '$' + params.length; };
  const filters = input.filters || [];
  if (!Array.isArray(filters) || filters.length > 20 || filters.some((f) => !f || typeof f !== 'object' || Array.isArray(f) || !Object.hasOwn(f, 'value'))) throw new HttpError(400, '筛选条件不正确');
  const where = () => filters.length ? ' WHERE ' + filters.map(({ column, value }) => {
    const name = assertColumn(table, column);
    return value === null ? name + ' IS NULL' : name + '=' + param(column, value);
  }).join(' AND ') : '';
  const target = 'public.' + quote(table);
  let text;
  if (operation === 'select') {
    text = 'SELECT ' + columnList(table, input.columns) + ' FROM ' + target + where();
    let order = input.order || [];
    if (!Array.isArray(order)) order = [order];
    if (order.length > 5 || order.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new HttpError(400, '排序条件不正确');
    if (order.length) text += ' ORDER BY ' + order.map((x) => assertColumn(table, x.column) + (x.ascending === false ? ' DESC' : ' ASC') + ' NULLS LAST').join(',');
    const limit = input.limit == null ? 5000 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new HttpError(400, '查询数量须为1至5000');
    params.push(limit); text += ' LIMIT $' + params.length;
  } else if (operation === 'delete') {
    if (!filters.length) throw new HttpError(400, '删除必须指定记录');
    text = 'DELETE FROM ' + target + where() + ' RETURNING ' + columnList(table, input.columns);
  } else if (operation === 'update') {
    if (!filters.length) throw new HttpError(400, '修改必须指定记录');
    const row = input.values;
    if (!row || Array.isArray(row) || typeof row !== 'object') throw new HttpError(400, '修改内容不正确');
    const cols = Object.keys(row);
    if (!cols.length) throw new HttpError(400, '没有可保存的字段');
    text = 'UPDATE ' + target + ' SET ' + cols.map((c) => assertColumn(table, c) + '=' + param(c, row[c])).join(',') + where() + ' RETURNING ' + columnList(table, input.columns);
  } else {
    const rows = Array.isArray(input.values) ? input.values : [input.values];
    if (!rows.length || rows.length > 100 || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new HttpError(400, '新增内容不正确');
    const cols = [...new Set(rows.flatMap(Object.keys))];
    if (!cols.length) throw new HttpError(400, '没有可保存的字段');
    text = 'INSERT INTO ' + target + ' (' + cols.map((c) => assertColumn(table, c)).join(',') + ') VALUES ' + rows.map((r) => '(' + cols.map((c) => Object.hasOwn(r, c) ? param(c, r[c]) : 'DEFAULT').join(',') + ')').join(',');
    if (operation === 'upsert') {
      const conflict = CONFLICTS[table];
      // Existing browser drafts still send the original three-column key.
      // The server adds the authenticated owner to the canonical SQL conflict.
      if (!conflict || input.onConflict !== conflict && !(table === 'reports' && input.onConflict === 'project_id,period,line')) throw new HttpError(400, '不支持的冲突键');
      const keys = conflict.split(',');
      const updates = cols.filter((c) => !keys.includes(c) && !['id', 'created_at', 'submitted_at', 'history', 'locked', 'author_id'].includes(c));
      if (!updates.length) throw new HttpError(400, '没有可更新的内容');
      text += ' ON CONFLICT (' + keys.map((c) => quote(c)).join(',') + ') DO UPDATE SET ' + updates.map((c) => {
        if (table === 'project_master' && c === 'fields') {
          // A controlled import may create the master after the API's initial
          // lookup. Preserve its full index atomically at the conflict itself.
          return '"fields"=CASE WHEN project_master.fields->\'scheme_catalog\' IS NOT NULL AND project_master.fields->\'scheme_catalog\'<>\'null\'::jsonb'
            + ' THEN EXCLUDED.fields || jsonb_build_object(\'scheme_catalog\',project_master.fields->\'scheme_catalog\') ELSE EXCLUDED.fields END';
        }
        return quote(c) + '=EXCLUDED.' + quote(c);
      }).join(',');
    }
    text += ' RETURNING ' + columnList(table, input.columns);
  }
  return { text, values: params };
}

export async function withIdentity(pool, userId, callback) {
  if (typeof userId !== 'string' || !userId) throw new HttpError(401, '请先登录');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
    throw error;
  } finally { client.release(); }
}

export async function getProfile(client, userId, {project_id} = {}) {
  const profile=(await client.query('SELECT * FROM public.profiles WHERE user_id=$1', [userId])).rows[0] || null;
  return profile?(await withBusinessModuleGrants(client,[profile],project_id))[0]:null;
}

function ensureLeader(profile, kind, table) {
  const family = table === 'leader_reviews' ? { ceo: 'president', pzo: 'pzo' } : { ceo_brief: 'president', pzo_note: 'pzo' };
  if (!family[kind] || !['ops', family[kind]].includes(profile?.role)) throw new HttpError(403, '没有维护这类评价或交代的权限');
}
function checkExternalUrl(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, '链接格式不正确');
  if (value.startsWith('/api/files/')) return;
  try { if (!['https:', 'http:'].includes(new URL(value).protocol)) throw new Error(); }
  catch { throw new HttpError(400, '链接须使用HTTP或HTTPS'); }
}

function validateReportFollowups(rows) {
  const fail = (message) => { throw new HttpError(400, message, 'invalid_followups'); };
  if (!Array.isArray(rows) || rows.length > 500) fail('同步事项须为列表，且最多保存500条');
  const textLimits = {
    source_key: 500, what: 10000, progress: 10000,
    title: 200, due: 100, source_type: 64, source_id: 200,
    source_period: 100, source_author: 200, source_updated_at: 100,
    source_anchor: 500, source_target: 500,
    previous_completed_period: 100, previous_completed_progress: 10000
  };
  rows.forEach((row, index) => {
    const label = '第' + (index + 1) + '条同步事项';
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(label + '须为有效事项');
    if (!['open', 'in_progress', 'completed'].includes(row.status)) fail(label + '的处理状态不正确');
    for (const [field, limit] of Object.entries(textLimits)) {
      if (!Object.hasOwn(row, field) && !['source_key', 'what', 'progress'].includes(field)) continue;
      const value = row[field];
      if (typeof value !== 'string' || value.length > limit || value.includes('\u0000') || (field === 'source_key' && !value.trim())) fail(label + '的' + (field === 'source_key' ? '来源标识' : '文字内容') + '格式不正确或过长');
    }
    for (const field of ['source_updated', 'source_missing', 'source_reopened']) {
      if (Object.hasOwn(row, field) && typeof row[field] !== 'boolean') fail(label + '的来源状态不正确');
    }
    if (Object.hasOwn(row, 'source_revision') && (!Number.isSafeInteger(row.source_revision) || row.source_revision < 1)) fail(label + '的来源版本不正确');
  });
}

// Resolve legacy labels against their original submission, never a later edit.
// The calendar rules match PlanningWindows; Shanghai Monday is the boundary.
export function reportWeekStart(label, reference = new Date()) {
  const day = 86400000;
  const iso = (date) => date.toISOString().slice(0, 10);
  const parse = (value) => {
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
  };
  const monday = (date) => new Date(date.getTime() - ((date.getUTCDay() || 7) - 1) * day);
  const week = (date) => {
    const thursday = new Date(date.getTime() + (4 - (date.getUTCDay() || 7)) * day);
    return Math.ceil(((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / day + 1) / 7);
  };
  const ref = new Date(reference);
  if (typeof label !== 'string' || !Number.isFinite(ref.getTime())) return '';
  const full = /(\d{4})[-./](\d{2})[-./](\d{2})/.exec(label);
  if (full) { const date = parse(full.slice(1).join('-')); return date ? iso(monday(date)) : ''; }
  const local = new Date(ref.getTime() + 8 * 3600000);
  const short = /[（(]\s*(\d{1,2})[./](\d{1,2})\s*[–—~～至-]/.exec(label);
  const number = /第\s*(\d+)\s*周/.exec(label);
  if (!short && (!number || +number[1] < 1 || +number[1] > 53)) return '';
  const candidates = [];
  for (let year = local.getUTCFullYear() - 2; year <= local.getUTCFullYear() + 2; year++) {
    let date;
    if (short) date = parse(year + '-' + short[1].padStart(2, '0') + '-' + short[2].padStart(2, '0'));
    else date = new Date(monday(new Date(Date.UTC(year, 0, 4))).getTime() + (+number[1] - 1) * 7 * day);
    if (date && date.getUTCDay() === 1 && (!number || week(date) === +number[1])) candidates.push(date);
  }
  candidates.sort((a, b) => Math.abs(a - local) - Math.abs(b - local));
  return candidates.length ? iso(candidates[0]) : '';
}

async function syncReportMeetingProgress(client, user, row, existing) {
  if (!row.biz || !Object.hasOwn(row.biz, 'followups')) return;
  const report = { ...existing, ...row }, now = new Date();
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  if (reportWeekStart(report.period, existing?.submitted_at || existing?.created_at || now) !== reportWeekStart(today, now)) return;
  row.biz = { ...row.biz, followups: row.biz.followups.map((item) => ({ ...item })) };
  const allowedProjects = report.scope_project_ids || [report.project_id], entries = new Map();
  row.biz.followups.forEach((item, index) => {
    if (!item.source_key.startsWith('meeting:')) return;
    const parts = item.source_key.split(':'), pid = parts[1], id = (parts[2] || '').toLowerCase();
    if (parts.length !== 3 || !allowedProjects.includes(pid) || item.source_type !== 'meeting' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || item.project_id && item.project_id !== pid || item.source_id && item.source_id.toLowerCase() !== id || entries.has(item.source_key)) throw new HttpError(400, '会议同步来源不正确或重复', 'invalid_followups');
    entries.set(item.source_key, { item, index, pid, id });
  });
  if (!entries.size) return;
  const tasks = (await client.query('SELECT id,project_id,progress,status,rich_text,revision,updated_at FROM public.reporter_tasks WHERE project_id=ANY($1::text[]) AND owner_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',
    [allowedProjects, user.id, [...entries.values()].map(entry => entry.id)])).rows;
  const taskKey = task => 'meeting:' + task.project_id + ':' + task.id;
  const found = new Set(tasks.map(taskKey)), missing = [...entries.keys()].filter(key => !found.has(key));
  if (missing.length) {
    const prior = (await client.query("SELECT DISTINCT item->>'source_key' AS source_key FROM public.reports r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.biz->'followups')='array' THEN r.biz->'followups' ELSE '[]'::jsonb END) item WHERE r.author_id=$1 AND item->>'source_type'='meeting' AND item->>'source_key'=ANY($2::text[])", [user.id, missing])).rows;
    const proven = new Set(prior.map(item => item.source_key));
    if (missing.some(key => !proven.has(key))) throw new HttpError(403, '会议事项已被改派或不在本人范围内，请更新来源后核对；草稿保留', 'meeting_source_changed');
    missing.forEach(key => { entries.get(key).item.source_missing = true; });
  }
  const approvals = (await client.query("SELECT source_key,source_version FROM public.completion_requests WHERE owner_id=$1 AND source_key=ANY($2::text[]) AND request_type='completion' AND status='approved'", [user.id, [...entries.keys()]])).rows;
  const sourceCache = new Map();
  for (const task of tasks) {
    const key = taskKey(task), entry = entries.get(key);
    if (!entry) throw new HttpError(400, '会议原项目与来源标识不匹配', 'invalid_followups');
    const { item, index } = entry;
    if (task.status === 'completed') continue;
    const completed = approvals.filter(approval => approval.source_key === key);
    if (completed.length) {
      const source = await resolveCompletionSource(client, user, key, { cache: sourceCache });
      if (completed.some(approval => approval.source_version === source.source_version)) continue;
    }
    if (item.source_revision !== task.revision) throw new HttpError(409, '会议事项已在其他入口更新，请更新待同步来源并核对进展；本机草稿保留', 'meeting_progress_conflict');
    const status = item.status === 'open' ? 'open' : 'in_progress';
    const doc = row.rich_text?.fields?.['biz.followups.' + index + '.progress'];
    const fields = { ...(task.rich_text?.fields || {}) }; delete fields.progress;
    if (doc) fields.progress = doc;
    const rich = Object.keys(fields).length ? { v: 1, fields } : {};
    let saved = task;
    if (task.progress !== item.progress || task.status !== status || JSON.stringify(task.rich_text?.fields?.progress) !== JSON.stringify(doc)) saved = (await client.query('UPDATE public.reporter_tasks SET progress=$1,status=$2,rich_text=$3 WHERE id=$4 RETURNING revision,updated_at', [item.progress, status, JSON.stringify(rich), task.id])).rows[0];
    item.source_revision = saved.revision; item.source_updated_at = new Date(saved.updated_at).toISOString();
  }
}

async function validateReportSourceProjects(client, row, existing) {
  const report = { ...existing, ...row }, projects = report.scope_project_ids || [report.project_id];
  if (existing?.report_scope_id) {
    const snapshots = [existing, ...(existing.history || []).map(entry => entry?.data).filter(Boolean)];
    for (const path of ['node_items','coord_items','biz.nodes','biz.items','biz.handover']) {
      const itemSource = item => item?.source_id && 'source:' + (path === 'biz.items' && Array.isArray(existing.biz?.monthly_plan_ids)
        && existing.biz.monthly_plan_ids.length && item.monthly_plan_id ? item.monthly_plan_id + ':' : '') + item.source_id;
      const at = value => path.split('.').reduce((parent,key) => parent?.[key],value);
      const proposed = at(row);
      if (!Array.isArray(proposed)) continue;
      const originals = new Map();
      for (const snapshot of snapshots) for (const item of Array.isArray(at(snapshot)) ? at(snapshot) : []) {
        for (const key of [itemSource(item), item?.milestone_id != null && 'milestone:' + item.milestone_id].filter(Boolean)) {
          if (!originals.has(key)) originals.set(key,new Set());
          originals.get(key).add(item.project_id || snapshot.project_id || existing.project_id);
        }
      }
      for (const item of proposed) for (const key of [itemSource(item), item?.milestone_id != null && 'milestone:' + item.milestone_id].filter(Boolean)) {
        const prior = originals.get(key);
        if (prior && (prior.size !== 1 || !prior.has(item.project_id || existing.project_id))) throw new HttpError(403, '既有事项的实际来源项目不可更改；原来源和审批保持', 'report_source_project_immutable');
      }
    }
  }
  const reportSources = new Map();
  for (const rows of [row.node_items, row.biz?.nodes, row.biz?.items, row.biz?.handover, row.coord_items, row.biz?.followups]) {
    for (const item of Array.isArray(rows) ? rows : []) {
      if (item.project_id != null && !projects.includes(item.project_id)) throw new HttpError(400, '事项来源项目不在本报告范围内', 'invalid_report_source_project');
      if (typeof item.source_key === 'string' && /^(meeting|leader|coord):/.test(item.source_key)) {
        const parts = item.source_key.split(':'), sourceProject = parts[1];
        const fail = () => { throw new HttpError(400, '同步事项原来源项目或原事项不匹配，请核对来源', 'invalid_report_source_project'); };
        if (!projects.includes(sourceProject)) fail();
        if (parts[0] === 'coord' && parts.length !== 3) {
          const [, , sourceReportId, group, itemId] = parts;
          if (parts.length !== 5 || !/^[1-9]\d{0,18}$/.test(sourceReportId) || BigInt(sourceReportId) > 9223372036854775807n
            || !['coord','handover'].includes(group) || !itemId || itemId.length > 200 || item.source_id && item.source_id !== itemId || item.source_type && item.source_type !== 'coord') fail();
          const persistedProjects = new Set();
          for (const snapshot of [existing, ...(existing?.history || []).map(entry => entry?.data)].filter(Boolean)) {
            for (const saved of Array.isArray(snapshot.biz?.followups) ? snapshot.biz.followups : []) {
              if (saved?.source_key === item.source_key) persistedProjects.add(saved.project_id || snapshot.project_id || report.project_id);
            }
          }
          if (persistedProjects.size) {
            if (persistedProjects.size !== 1 || !persistedProjects.has(item.project_id || sourceProject)) fail();
            continue;
          }
          const reportKey = sourceProject + ':' + sourceReportId;
          if (!reportSources.has(reportKey)) reportSources.set(reportKey, (await client.query('SELECT project_id,coord_items,biz,history FROM public.reports WHERE project_id=$1 AND id=$2', [sourceProject,sourceReportId])).rows[0]);
          const source = reportSources.get(reportKey);
          if (!source) fail();
          // The key keeps the original report anchor. The actual item project
          // is checked against that exact stable source, including its history.
          const actualProjects = new Set();
          for (const snapshot of [source, ...(source.history || []).map(entry => entry?.data).filter(Boolean)]) {
            let original;
            try { original = reportCoordinationSourceItem(snapshot,group,itemId); }
            catch (error) { if (error.code === 'source_missing') continue; throw error; }
            actualProjects.add(original.project_id || snapshot.project_id || sourceProject);
          }
          if (actualProjects.size !== 1 || !actualProjects.has(item.project_id || sourceProject)) fail();
        } else if (item.project_id && item.project_id !== sourceProject) fail();
      }
    }
  }
}
async function validateReportMilestoneReferences(client, profile, project, row, existing, line) {
  const fail = (message) => { throw new HttpError(400, message, 'invalid_milestone_reference'); };
  const idKey = (value) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) fail('关联节点标识不正确');
    if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) fail('关联节点标识不正确');
    return String(value);
  };
  const report = { ...existing, ...row }, projects = report.scope_project_ids || [project.id];
  const key = item => {
    const pid = item.project_id || project.id;
    if (!projects.includes(pid)) fail('关联节点不属于当前填报范围');
    return pid + ':' + idKey(item.milestone_id);
  };
  const previous = new Set();
  for (const list of [existing?.node_items, existing?.biz?.nodes]) for (const item of Array.isArray(list) ? list : []) if (item?.milestone_id != null) previous.add(key(item));
  const added = new Map();
  for (const list of [row.node_items, row.biz?.nodes]) for (const item of Array.isArray(list) ? list : []) {
    if (item?.milestone_id == null) continue;
    const k = key(item);
    if (!previous.has(k)) added.set(k, idKey(item.milestone_id));
  }
  if (!added.size) return;
  const baselines = (await client.query('SELECT id,project_id,discipline,biz_line FROM public.milestones WHERE project_id=ANY($1::text[]) AND id=ANY($2::bigint[])', [projects, [...added.values()]])).rows;
  const matching = new Set(baselines.filter(node => project.project_type === 'com'
    ? !!node.biz_line && node.biz_line === line
    : !!node.discipline && node.discipline === profile.discipline).map(node => node.project_id + ':' + String(node.id)));
  if ([...added.keys()].some(k => !matching.has(k))) fail('关联节点不属于当前项目或本人专业，请刷新基准计划后重试');
}

export async function prepareMutation(client, user, request) {
  const { table, operation } = request;
  const profile = await getProfile(client, user.id);
  const admin = profile?.status === 'approved' && ['ops', 'president'].includes(profile.role);
  const ops = profile?.status === 'approved' && profile.role === 'ops';
  if (operation === 'delete') {
    if (['reports', 'projects', 'profiles'].includes(table)) throw new HttpError(403, '此类原始记录不可删除');
    if (['leader_reviews', 'leader_notes'].includes(table)) {
      if (!profile || !['ops', 'president', 'pzo'].includes(profile.role)) throw new HttpError(403, '无权删除');
    } else if (table === 'project_members' ? !ops : !admin) throw new HttpError(403, '无权删除');
    return request;
  }
  const inputRows = Array.isArray(request.values) ? request.values : [request.values];
  if (!inputRows.length || inputRows.length > 100) throw new HttpError(400, '记录数不正确');
  const rows = [];
  for (const source of inputRows) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new HttpError(400, '保存内容不正确');
    for (const field of Object.keys(source)) assertColumn(table, field);
    let row = { ...source };
    let richExisting, reportExisting;
    // Never trust identity, auditing, creation timestamps, or history from the browser.
    for (const field of protectedColumns) delete row[field];
    if (Object.hasOwn(source, 'id')) {
      if (table === 'projects' && operation === 'insert') { /* text project key is assigned by the administrator. */ }
      else if (operation === 'insert' || operation === 'upsert') delete row.id;
      else throw new HttpError(400, '不可修改记录ID');
    }
    if (table === 'profiles') {
      if (operation === 'insert') {
        if (profile || inputRows.length !== 1) throw new HttpError(409, '账号已建档');
        if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100) throw new HttpError(400, '请填写有效姓名');
        rows.push({ user_id: user.id, name: row.name.trim(), role: 'pm', status: 'pending' });
        continue;
      }
      if (!ops || !['update'].includes(operation)) throw new HttpError(403, '成员管理仅限运营管理员');
      if (Object.keys(row).some((c) => !['name', 'role', 'status', 'project_id', 'biz_line', 'discipline', 'management_viewer'].includes(c))) throw new HttpError(400, '不支持的成员字段');
      if (row.management_viewer !== undefined && typeof row.management_viewer !== 'boolean') throw new HttpError(400, '管理查看权限格式不正确');
      if (row.role !== undefined && !roles.has(row.role)) throw new HttpError(400, '角色不正确');
      if (row.status !== undefined && !['pending', 'approved', 'rejected'].includes(row.status)) throw new HttpError(400, '审核状态不正确');
      if (row.biz_line !== undefined && ![null, '', '*', ...BUSINESS_MODULES].includes(row.biz_line)) throw new HttpError(400, '商业模块不正确');
      if ((row.role !== undefined && row.role !== 'ops') || row.status === 'rejected' || row.status === 'pending') {
        // Serialize admin demotions so two concurrent requests cannot remove both final admins.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('zh-last-ops'))");
        const admins = (await client.query("SELECT user_id FROM public.profiles WHERE role='ops' AND status='approved' FOR UPDATE")).rows;
        const uid = request.filters?.find((f) => f.column === 'user_id')?.value;
        if (!uid || (admins.length <= 1 && admins.some((a) => a.user_id === uid))) throw new HttpError(409, '不能取消最后一位已审核运营管理员');
      }
    } else if (table === 'reports') {
      if (!profile || profile.status !== 'approved' || profile.role !== 'pm') throw new HttpError(403, '仅已审核的项目成员可填报');
      if (!['insert', 'upsert', 'update'].includes(operation)) throw new HttpError(403, '不支持的周报操作');
      if (Object.hasOwn(source, 'author_id') && source.author_id !== user.id) throw new HttpError(403, '不可冒用其他填报人');
      let existing;
      if (operation === 'update') {
        if (inputRows.length !== 1 || !request.filters?.length) throw new HttpError(400, '请指定一条周报');
        const selected = buildQuery({ table, filters: request.filters, limit: 2 });
        const found = (await client.query(selected)).rows;
        if (!found.length) throw new HttpError(403, '周报不存在或无权修改');
        if (found.length !== 1) throw new HttpError(400, '每次只能修改一条周报');
        existing = found[0];
        richExisting = existing;
        if (existing.author_id !== user.id) throw new HttpError(403, '只能修改本人提交的周报');
        for (const field of ['project_id', 'period', 'line']) {
          if (Object.hasOwn(row, field) && row[field] !== existing[field]) throw new HttpError(403, '不可修改已提交周报的项目、周期或模块');
        }
      }
      const pid = existing?.project_id || row.project_id;
      if (!pid) throw new HttpError(400, '缺少项目');
      const project = (await client.query('SELECT id,project_type FROM public.projects WHERE id=$1', [pid])).rows[0];
      if (!project) throw new HttpError(403, '未分配此项目');
      const businessProfile=project.project_type==='com'?(await withBusinessModuleGrants(client,[profile],pid))[0]:profile;
      const line = project.project_type === 'com' ? resolveWritableBusinessLine(businessProfile, existing?.line ?? row.line, pid) : resolveWritableResidentialLine(profile, existing?.line ?? row.line);
      if ((row.line && row.line !== line) || (existing && existing.line !== line)) throw new HttpError(403, '只能填报本人模块');
      const period = existing?.period || row.period;
      if (typeof period !== 'string' || !period.trim() || period.length > 100) throw new HttpError(400, '填报周期不正确');
      if (!existing && operation === 'upsert') {
        existing = (await client.query('SELECT * FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3 AND author_id=$4', [pid,period,line,user.id])).rows[0];
        if (existing && existing.author_id !== user.id) throw new HttpError(403, '只能修改本人提交的周报');
        if (existing) richExisting = existing;
      }
      row.line = line;
      const scope = await resolveReportScope(client, user, row, existing, period, pid);
      if (scope) {
        const professional = scope.reporting_mode === 'professional';
        const canonical = (await client.query('SELECT * FROM public.reports WHERE report_scope_id=$1 AND scope_week=$2'
          + (professional ? ' AND line=$3 AND author_id=$4' : '') + ' FOR UPDATE', professional ? [scope.id,row.scope_week,line,user.id] : [scope.id,row.scope_week])).rows[0];
        if (canonical && canonical.period !== period) throw new HttpError(409, '本周统一报告已存在，请刷新后进入原报告', 'report_scope_period_conflict');
        if (canonical && operation === 'insert') throw new HttpError(409, '本周统一报告已提交，请刷新后进入原报告', 'report_scope_exists');
        if (canonical && canonical.author_id !== user.id) throw new HttpError(403, '只能修改本人提交的周报');
        if (canonical && ['upsert','update'].includes(operation)) { existing = canonical; richExisting = canonical; }
      }
      // The scope/week lock precedes row locks, including requests using a
      // different textual label for the same week. Refresh the snapshot after
      // waiting so author checks, attachments and history use the actual row.
      if (['upsert','update'].includes(operation)) {
        const locked = (await client.query('SELECT * FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3 AND author_id=$4 FOR UPDATE', [pid,period,line,user.id])).rows[0];
        if (operation === 'update' && !locked) throw new HttpError(403, '周报不存在或无权修改');
        if (locked && locked.author_id !== user.id) throw new HttpError(403, '只能修改本人提交的周报');
        if (locked && (locked.report_scope_id || null) !== (row.report_scope_id || null)) throw new HttpError(409, '原报告身份已存在，请保留原记录并刷新核对', 'report_scope_legacy_conflict');
        existing = locked;
        if (locked) richExisting = locked;
      }
      reportExisting = existing;
      for (const field of ['next_items', 'commit_items', 'node_items', 'speed_items', 'effect_items', 'coord_items']) {
        if (Object.hasOwn(row, field) && !Array.isArray(row[field])) throw new HttpError(400, '周报明细须为列表');
      }
      if (row.node_items?.some((node) => !node || typeof node !== 'object' || Array.isArray(node))) throw new HttpError(400, '节点内容不正确');
      if (row.biz != null && (typeof row.biz !== 'object' || Array.isArray(row.biz))) throw new HttpError(400, '商业填报内容不正确');
      if (existing?.biz && Object.hasOwn(existing.biz,'attachments') && Object.hasOwn(row,'biz') && !Object.hasOwn(row.biz || {},'attachments')) {
        row.biz = { ...(row.biz || {}), attachments:existing.biz.attachments };
      }
      for (const [parent,key,label] of [[row.biz,'nodes','节点'],[row.biz,'items','计划事项'],[row.biz,'handover','移交事项'],[row,'coord_items','协调事项']]) {
        if (!parent || !Object.hasOwn(parent,key)) continue;
        if (!Array.isArray(parent[key]) || parent[key].length>500) throw new HttpError(400,label+'须为列表且最多500项');
        const seen = new Set();
        const scopedMonthlyItems = key === 'items' && !!(row.report_scope_id || existing?.report_scope_id)
          && Array.isArray(row.biz?.monthly_plan_ids) && row.biz.monthly_plan_ids.length > 0;
        parent[key]=parent[key].map(item=>{
          if (!item || typeof item!=='object' || Array.isArray(item)) throw new HttpError(400,label+'格式不正确');
          const sourceId=item.source_id || randomUUID();
          const identity = scopedMonthlyItems ? JSON.stringify([item.monthly_plan_id,sourceId]) : sourceId;
          if (typeof sourceId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(sourceId) || seen.has(identity)) throw new HttpError(400,label+'标识重复或格式不正确');
          seen.add(identity);return {...item,source_id:sourceId};
        });
      }
      if (row.biz && Object.hasOwn(row.biz, 'followups')) validateReportFollowups(row.biz.followups);
      await validateReportMilestoneReferences(client, profile, project, row, existing, line);
      await validateReportSourceProjects(client, row, existing);
      row.line = line; row.author_name = profile.name;
      await validateReportAttachmentReferences(client,user.id,profile,row,existing);
      if (operation !== 'update') row.author_id = user.id;
      row.updated_at = new Date().toISOString();
      const nodes = row.node_items ?? existing?.node_items ?? [];
      const baseline = (await client.query('SELECT plan_date,forecast_date FROM public.milestones WHERE project_id=ANY($1::text[]) AND NOT done', [row.scope_project_ids || existing?.scope_project_ids || [pid]])).rows;
      const deltas = [...nodes.map((n) => ({ plan_date: n.plan, forecast_date: n.forecast })), ...baseline]
        .filter((n) => n.plan_date && n.forecast_date).map((n) => {
          const date = (x) => x instanceof Date ? x.getTime() : Date.parse(String(x).slice(0, 10) + 'T00:00:00Z');
          return Math.round((date(n.forecast_date) - date(n.plan_date)) / 86400000);
        }).filter(Number.isFinite);
      const delay = deltas.length ? Math.max(...deltas) : 0;
      row.status = delay >= 15 ? '异常' : delay >= 5 ? '关注' : '正常';
      row.self_speed = project.project_type === 'com' ? null : delay >= 5 ? '滞后' : delay <= -5 ? '领跑' : '达标';
      row.self_effect = null;
    } else if (['leader_reviews', 'leader_notes'].includes(table)) {
      if (table === 'leader_notes' && ['owner_id','owner_name'].some((key) => Object.hasOwn(row,key)))
        throw new HttpError(400, '责任人请通过会议要求分派入口维护');
      if (profile?.status !== 'approved') throw new HttpError(403, '账号尚未审核');
      if (operation === 'update' && !row.kind) {
        const id = request.filters?.find((f) => f.column === 'id')?.value;
        if (!id) throw new HttpError(400, '必须指定记录');
        row.kind = (await client.query('SELECT kind FROM public.' + quote(table) + ' WHERE id=$1', [id])).rows[0]?.kind;
      }
      ensureLeader(profile, row.kind, table);
      if (table === 'leader_reviews') {
        if (row.speed != null && !['领跑', '达标', '滞后'].includes(row.speed)) throw new HttpError(400, '速度评价不正确');
        if (row.effect != null && !['优秀', '良好', '待改善'].includes(row.effect)) throw new HttpError(400, '效果评价不正确');
        if (row.rating != null && !['好', '中', '需改进'].includes(row.rating)) throw new HttpError(400, '评价等级不正确');
        row.author_role = { ops: '运营管理员', president: '总裁', pzo: '项目总' }[profile.role];
        row.updated_at = new Date().toISOString();
      }
      row.author_name = profile.name;
    } else if (table === 'milestones') {
      if (!admin) {
        if (profile?.status !== 'approved' || profile.role !== 'pm' || operation !== 'update') throw new HttpError(403, '无权维护节点');
        if (Object.keys(row).some((c) => !['forecast_date', 'note', 'rich_text'].includes(c))) throw new HttpError(403, '项目成员只能修改预计时间与卡点说明');
      }
      if (row.discipline != null && !['开发报建', '设计', '工程', '成本', '招采', '营销', '商管运营', '客服', '财务'].includes(row.discipline)) throw new HttpError(400, '节点所属住宅专业不正确');
      if (row.biz_line != null && !BUSINESS_MODULES.includes(row.biz_line)) throw new HttpError(400, '节点所属商业模块不正确');
      if(row.biz_line==='设计部') {
        const projects=row.project_id!==undefined?[row.project_id]:(await client.query(buildQuery({table,operation:'select',columns:'project_id',filters:request.filters,limit:5000}))).rows.map(node=>node.project_id);
        if(!projects.length||projects.some(pid=>!businessModulesForProject(pid).includes(row.biz_line)))throw new HttpError(400,'设计部仅适用于弘坊项目');
      }
      row.updated_at = new Date().toISOString();
    } else if (table === 'project_members') {
      if (!ops) throw new HttpError(403, '项目分配仅限运营管理员');
      if (row.role_in_project && row.role_in_project !== 'pm') throw new HttpError(400, '项目成员角色不正确');
    } else {
      if (!admin) throw new HttpError(403, '此操作仅限运营管理员或总裁');
      if (table === 'projects' && row.display_group != null && (typeof row.display_group !== 'string' || !row.display_group.trim() || row.display_group.length > 100 || row.display_group !== row.display_group.trim())) throw new HttpError(400, '项目展示分组不正确');
      if (table === 'project_master') { row.updated_by = profile.name; row.updated_at = new Date().toISOString(); }
      if (table === 'project_phases') {
        for (const c of ['units_total', 'units_launched', 'units_sold']) if (row[c] != null && (!Number.isInteger(row[c]) || row[c] < 0)) throw new HttpError(400, '套数必须为非负整数');
        if (row.units_total != null && row.units_launched > row.units_total) throw new HttpError(400, '已推套数不能超过总套数');
        if (row.units_launched != null && row.units_sold > row.units_launched) throw new HttpError(400, '已售套数不能超过已推套数');
        row.updated_at = new Date().toISOString();
      }
      if (table === 'project_drawings') { checkExternalUrl(row.url); row.uploaded_by = profile.name; }
    }
    if (RICH_TEXT_PATHS[table]) {
      if (richExisting === undefined && ['update', 'upsert'].includes(operation)) {
        const filters = operation === 'upsert'
          ? CONFLICTS[table].split(',').map((column) => ({ column, value: row[column] }))
          : request.filters;
        const lookup = buildQuery({ table, filters, limit: 2 });
        const found = (await client.query({ ...lookup, text: lookup.text + ' FOR UPDATE' })).rows;
        if (found.length > 1) {
          if (Object.hasOwn(row, 'rich_text')) throw new HttpError(400, '每次只能保存一条记录的文字格式');
          // A legacy bulk edit cannot preserve individual rows' field maps.
          // Clear only formatting metadata; all business strings remain intact.
          if (hasRichTextChanges(table, row)) row.rich_text = {};
          richExisting = {};
        } else richExisting = found[0] || {};
      }
      row = prepareRichText(table, row, richExisting);
    }
    if (table === 'reports') {
      try {
        await client.query('SELECT app_private.validate_monthly_report($1::jsonb,$2::jsonb)',
          [JSON.stringify({...reportExisting, ...row}), reportExisting ? JSON.stringify(reportExisting) : null]);
      } catch (error) {
        if (error.code === '23514' && error.message.startsWith('月度计划')) throw new HttpError(409, error.message, 'monthly_plan_locked');
        throw error;
      }
      await syncReportMeetingProgress(client, user, row, reportExisting);
    }
    rows.push(row);
  }
  return { ...request, values: Array.isArray(request.values) ? rows : rows[0] };
}

export async function executeDatabase(pool, user, request, options = {}) {
  assertTable(request.table);
  // Validate the external query structure before mutation-specific inspection.
  buildQuery(request);
  return withIdentity(pool, user.id, async (client) => {
    const operation = request.operation || 'select';
    const prepared = operation === 'select' ? request : await prepareMutation(client, user, { ...request, operation });
    const input = await preserveSchemeMaster(client, prepared, buildQuery);
    const schemeTable = ['project_master', 'project_drawings'].includes(input.table);
    const result = await client.query(buildQuery(schemeTable ? { ...input, columns: '*' } : input));
    if (['update', 'delete'].includes(operation) && !result.rows.length) throw new HttpError(403, '记录不存在或无权修改');
    const rows = await sanitizeSchemeRows(client, input.table, result.rows, options);
    if (!schemeTable || request.columns == null || request.columns === '*') return rows;
    const columns = Array.isArray(request.columns) ? request.columns : request.columns.split(',').map(column => column.trim());
    return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
  });
}

export async function replaceLeaderNotes(pool, user, { project_id, period, kind, items }) {
  if (typeof project_id !== 'string' || typeof period !== 'string' || !period || period.length > 100 || !Array.isArray(items) || items.length > 100) throw new HttpError(400, '交代内容不正确');
  return withIdentity(pool, user.id, async (client) => {
    const profile = await getProfile(client, user.id);
    if (profile?.status !== 'approved') throw new HttpError(403, '账号尚未审核');
    ensureLeader(profile, kind, 'leader_notes');
    if (!(await client.query('SELECT id FROM public.projects WHERE id=$1', [project_id])).rows.length) throw new HttpError(403, '无权访问此项目');
    const normalized = items.map((item) => {
      if (!item || typeof item.what !== 'string' || !item.what.trim() || item.what.length > 10000 || item.what.includes('\u0000')) throw new HttpError(400, '交代事项不可为空或过长');
      const due = item.due ?? '';
      const parsed = due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(due + 'T00:00:00Z') : null;
      if (typeof due !== 'string' || (due && (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== due || due.startsWith('0000')))) throw new HttpError(400, '截止日期格式不正确');
      if (item.id != null && (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id))) throw new HttpError(400, '交代事项标识不正确');
      return { ...(item.id != null ? { id: item.id.toLowerCase() } : {}), what: item.what, due, ...(Object.hasOwn(item, 'rich_text') ? { rich_text: item.rich_text } : {}) };
    });
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['leader-notes:' + project_id + ':' + period + ':' + kind]);
    const previous = (await client.query('SELECT * FROM public.leader_notes WHERE project_id=$1 AND period=$2 AND kind=$3 ORDER BY id FOR UPDATE', [project_id, period, kind])).rows;
    const used = new Set();
    const explicit = new Set(normalized.filter((item) => item.id).map((item) => item.id));
    const replacements = normalized.map((item) => {
      // Explicit ids survive text/date edits. Older clients retain an id only
      // when the content matches exactly; array position is never identity.
      const existing = item.id
        ? previous.find((row) => String(row.id) === item.id)
        : previous.find((row) => !used.has(String(row.id)) && !explicit.has(String(row.id)) && row.what === item.what && (row.due || '') === item.due);
      if (item.id && (!existing || used.has(item.id))) throw new HttpError(400, '交代事项已变更或标识重复，请刷新后重试');
      if (existing) used.add(String(existing.id));
      const { id, ...fields } = item;
      const value = prepareRichText('leader_notes', { ...fields,
        ...(!Object.hasOwn(fields, 'rich_text') && existing?.what === item.what ? { rich_text: existing.rich_text || {} } : {}) }, existing);
      return { existing, value };
    });
    const removed = previous.filter((row) => !used.has(String(row.id))).map((row) => row.id);
    if (removed.length) await client.query('DELETE FROM public.leader_notes WHERE id=ANY($1::uuid[])', [removed]);
    const saved = [];
    for (const { existing, value } of replacements) {
      const input = existing
        ? { table: 'leader_notes', operation: 'update', filters: [{ column: 'id', value: existing.id }], values: { ...value, author_name: profile.name } }
        : { table: 'leader_notes', operation: 'insert', values: { ...value, project_id, period, kind, author_name: profile.name } };
      saved.push((await client.query(buildQuery(input))).rows[0]);
    }
    return saved;
  });
}
