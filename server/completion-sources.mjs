import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { validateRichText } from './rich-text.mjs';
import { businessModulesForProject, canUseBusinessModule, withBusinessModuleGrants } from './commercial-modules.mjs';
import { canUseResidentialLine } from './report-lines.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reviewerRoles = new Set(['ops', 'president', 'pzo']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = () => { throw new HttpError(404, '来源事项不存在或已移除，请刷新后核对', 'source_missing'); };
const forbidden = () => { throw new HttpError(403, '无权为此事项申报或审核完成', 'source_forbidden'); };
const invalid = () => { throw new HttpError(400, '来源事项标识不正确', 'invalid_source_key'); };
const text = (value) => value == null ? '' : String(value);

function identifier(value) {
  return /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function parseSourceKey(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  const parts = value.split(':');
  if (parts.some((part) => !part || part !== part.trim()) || parts[1]?.length > 200) invalid();
  const [kind, projectId, id, group, itemId] = parts;
  if (kind === 'monthly') {
    if (parts.length !== 4 || !uuid.test(id) || group.length > 200) invalid();
    return { kind: 'plan', projectId, id: id.toLowerCase(), itemId: group, monthly: true, key: 'monthly:' + projectId + ':' + id.toLowerCase() + ':' + group };
  }
  if (kind === 'coord' && parts.length === 3) {
    if (!uuid.test(id)) invalid();
    return { kind, projectId, id: id.toLowerCase(), independent: true, key: kind + ':' + projectId + ':' + id.toLowerCase() };
  }
  if (['leader', 'meeting'].includes(kind)) {
    if (parts.length !== 3 || !uuid.test(id)) invalid();
    return { kind, projectId, id: id.toLowerCase(), key: kind + ':' + projectId + ':' + id.toLowerCase() };
  }
  if (kind === 'milestone') {
    if (parts.length !== 3 || !identifier(id)) invalid();
    return { kind, projectId, id, key: value };
  }
  if (!['coord', 'plan'].includes(kind) || parts.length !== 5 || !identifier(id)
      || !(kind === 'coord' ? ['coord', 'handover'] : ['nodes', 'items']).includes(group)
      || itemId.length > 200) invalid();
  return { kind, projectId, id, group, itemId, key: value };
}

// Order-independent JSON gives business-equivalent source objects one version.
// Audit fields and completion decisions are deliberately absent from snapshots.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function result(parsed, snapshot, fields) {
  const business = fields.rich_text ? { ...snapshot, rich_text: fields.rich_text } : snapshot;
  const sourceVersion = createHash('sha256').update(JSON.stringify(canonical({ source_key: parsed.key, ...business }))).digest('hex');
  return { source_key: parsed.key, source_version: sourceVersion, project_id: parsed.projectId,
    kind: parsed.kind, ...fields, source_snapshot: business };
}
function sourceFormat(value, path, what) {
  const delta = value?.v === 1 ? value.fields?.[path] : undefined;
  if (!delta) return {};
  try {
    return { rich_text: validateRichText('leader_notes', { v: 1, fields: { what: delta } }, { what }) };
  } catch (error) {
    // Invalid historic formatting cannot alter source identity or inject HTML.
    // Its plain business content remains available for completion review.
    if (error instanceof HttpError && error.code === 'invalid_rich_text') return {};
    throw error;
  }
}

async function cached(cache, key, read) {
  if (!cache) return read();
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(read));
  return cache.get(key);
}

async function requireReportOwnerScope(client, user, report, ownerId, cache) {
  if (!report.report_scope_id) return;
  const projects = report.scope_project_ids;
  if (!Array.isArray(projects) || !projects.length || !projects.includes(report.project_id)) forbidden();
  const allowed = await cached(cache, 'report-owner-scope:' + user.id + ':' + ownerId + ':' + report.id, async () => {
    const rows = (await client.query('SELECT project_id FROM public.project_members WHERE user_id=$1 AND project_id=ANY($2::text[])', [ownerId, projects])).rows;
    return projects.every(projectId => rows.some(row => row.project_id === projectId));
  });
  if (!allowed) forbidden();
}
async function resolveOwner(client, user, parsed, forOwnerId, cache) {
  if (typeof user?.id !== 'string' || !user.id) forbidden();
  const caller = await cached(cache, 'caller:' + user.id, async () => (await client.query('SELECT user_id,name,role,status,biz_line,discipline FROM public.profiles WHERE user_id=$1 AND user_id=auth.uid()', [user.id])).rows[0]);
  if (caller?.status !== 'approved' || !['pm', ...reviewerRoles].includes(caller.role)) forbidden();
  if (forOwnerId !== undefined && (typeof forOwnerId !== 'string' || !forOwnerId || forOwnerId.length > 200 || forOwnerId.includes('\u0000'))) invalid();
  const ownerId = forOwnerId ?? user.id;
  const originReview = ownerId !== user.id && caller.role === 'pm' && parsed.kind === 'coord' && (parsed.independent || parsed.group === 'coord');
  if (ownerId !== user.id && !reviewerRoles.has(caller.role)) {
    if (!originReview) forbidden();
    const source = parsed.independent
      ? await cached(cache, 'source:' + user.id + ':coordination:' + parsed.projectId + ':' + parsed.id,
        async () => (await client.query("SELECT id::text AS id,project_id,author_id,author_name,owner_id,owner_name,what,rich_text,COALESCE(due::text,'') AS due FROM public.coordination_tasks WHERE project_id=$1 AND id=$2", [parsed.projectId, parsed.id])).rows[0])
      : await cached(cache, 'source:' + user.id + ':report:' + parsed.projectId + ':' + parsed.id,
        async () => (await client.query('SELECT id::text AS id,project_id,period,author_id,author_name,line,coord_items,biz,rich_text,report_scope_id,scope_project_ids FROM public.reports WHERE project_id=$1 AND id=$2', [parsed.projectId, parsed.id])).rows[0]);
    if (source?.author_id !== user.id) forbidden();
  }
  const owner = ownerId === user.id ? caller : await cached(cache, 'owner:' + user.id + ':' + ownerId, async () => {
    if (!originReview) return (await client.query('SELECT user_id,name,role,status,biz_line,discipline FROM public.profiles WHERE user_id=$1', [ownerId])).rows[0];
    // PMs cannot read other profiles. Reuse the existing project-scoped active
    // people helper instead of expanding that table's visibility.
    const people = await cached(cache, 'people:' + user.id + ':' + parsed.projectId,
      async () => (await client.query('SELECT user_id,name,role,biz_line,discipline FROM app_private.project_people($1)', [parsed.projectId])).rows);
    const member = people.find(person => person.user_id === ownerId);
    return member ? { ...member, status: 'approved' } : undefined;
  });
  if (owner?.status !== 'approved' || owner.role !== 'pm') forbidden();
  const project = await cached(cache, 'project:' + user.id + ':' + parsed.projectId, async () => (await client.query('SELECT id,project_type FROM public.projects WHERE id=$1', [parsed.projectId])).rows[0]);
  if (!project) forbidden();
  const member = await cached(cache, 'member:' + user.id + ':' + ownerId + ':' + parsed.projectId, async () => (await client.query('SELECT user_id FROM public.project_members WHERE project_id=$1 AND user_id=$2', [parsed.projectId, ownerId])).rows.length > 0);
  if (!member) forbidden();
  const scopedOwner=await cached(cache,'module-owner:'+user.id+':'+ownerId+':'+project.id,async()=>(await withBusinessModuleGrants(client,[owner],project.id))[0]);
  return { caller, owner:scopedOwner, project };
}

function hitOwner(value, owner, projectId) {
  const input = text(value).trim(), name = text(owner.name);
  const modules = businessModulesForProject(projectId).filter(line => canUseBusinessModule(owner, line, projectId));
  return !!(input && ((name.length >= 2 && input.includes(name)) || modules.some(line => input.includes(line))));
}
// Existing coordination snapshots used this content key before stable item ids.
// Matching all three fields preserves that identity without position matching.
function legacyCoordId(item, group) {
  const target = group === 'coord' ? item.who : item.to;
  const input = [target || '', item.what, item.by || item.due || ''].join('\n');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return 'legacy-' + (hash >>> 0).toString(36);
}
// Shared with read-only personal AI queries so legacy names and content keys
// keep exactly the workbench/completion ownership contract.
export function completionOwnerMatches(value,owner,projectId){return hitOwner(value,owner,projectId);}
export function reportCoordinationSourceKey(report,group,item){
  if(!['coord','handover'].includes(group))invalid();
  return 'coord:'+report.project_id+':'+report.id+':'+group+':'+(item.source_id || item.id || legacyCoordId(item,group));
}
function sourceItem(items, parsed) {
  if (!Array.isArray(items)) missing();
  const matches = items.filter((item) => {
    if (!object(item)) return false;
    const stableId = item.source_id || item.id;
    const id = stableId ? text(stableId) : parsed.kind === 'coord' ? legacyCoordId(item, parsed.group) : '';
    return id === parsed.itemId;
  });
  // Never infer one identity from an array position or choose among duplicates.
  if (matches.length !== 1) missing();
  return matches[0];
}

// Report feedback and completion review share one exact item identity,
// including the original content hash used by records predating stable IDs.
export function reportCoordinationSourceItem(report, group, itemId) {
  return sourceItem(group === 'coord' ? report.coord_items : report.biz?.handover, { kind: 'coord', group, itemId });
}

// A cache belongs to one identity-bound transaction/page only; callers must not
// retain it across writes or requests, where source and membership may change.
async function resolveBaseSource(client, user, sourceKey, { forOwnerId, cache } = {}) {
  const parsed = parseSourceKey(sourceKey);
  const { caller, owner, project } = await resolveOwner(client, user, parsed, forOwnerId, cache);
  const cacheKey = 'source:' + user.id + ':' + parsed.kind + ':' + parsed.projectId + ':' + parsed.id;
  if (parsed.monthly) {
    const plan = await cached(cache, 'source:' + user.id + ':monthly:' + parsed.projectId + ':' + parsed.id,
      async () => (await client.query('SELECT id::text AS id,project_id,line,plan_month::text AS plan_month,items,rich_text,confirmed_by,confirmed_name,report_scope_id,scope_project_ids FROM public.monthly_plans WHERE project_id=$1 AND id=$2', [parsed.projectId, parsed.id])).rows[0]);
    if (!plan) missing();
    if (plan.confirmed_by !== owner.user_id || (project.project_type === 'com' ? !canUseBusinessModule(owner, plan.line,project.id) : plan.line === '综合' || !canUseResidentialLine(owner, plan.line))) forbidden();
    await requireReportOwnerScope(client, user, plan, owner.user_id, cache);
    const item = sourceItem(plan.items, parsed);
    if (!text(item.name).trim()) missing();
    return result(parsed, { id: plan.id, project_id: plan.project_id, line: plan.line, plan_month: plan.plan_month,
      author_id: plan.confirmed_by, author_name: plan.confirmed_name, source_id: item.source_id || item.id, mod: item.mod || '', name: item.name, due: item.due || '',
      ...(plan.report_scope_id ? {report_scope_id: plan.report_scope_id, scope_project_ids: plan.scope_project_ids,
        ...(item.project_id === undefined ? {} : {source_project_id: item.project_id})} : {}) },
    { title: '月度计划', what: item.name, due: item.due || '', source_id: text(item.source_id || item.id), monthly_plan_id: plan.id,
      ...sourceFormat(plan.rich_text, 'items.' + plan.items.indexOf(item) + '.name', item.name),
      ...(plan.report_scope_id ? {report_scope_id: plan.report_scope_id, scope_project_ids: plan.scope_project_ids,
        ...(item.project_id === undefined ? {} : {source_project_id: item.project_id})} : {}) });
  }
  if (parsed.independent) {
    const row = await cached(cache, 'source:' + user.id + ':coordination:' + parsed.projectId + ':' + parsed.id,
      async () => (await client.query("SELECT id::text AS id,project_id,author_id,author_name,owner_id,owner_name,what,rich_text,COALESCE(due::text,'') AS due FROM public.coordination_tasks WHERE project_id=$1 AND id=$2", [parsed.projectId, parsed.id])).rows[0]);
    if (!row) missing();
    if (row.owner_id !== owner.user_id) forbidden();
    const { rich_text, ...snapshot } = row;
    return result(parsed, { ...snapshot, who_id: row.owner_id }, { title: '独立协调事项', what: row.what, due: row.due, source_id: row.id,
      ...sourceFormat(rich_text, 'what', row.what) });
  }
  if (parsed.kind === 'milestone') {
    const row = await cached(cache, cacheKey, async () => (await client.query('SELECT id::text AS id,project_id,name,plan_date::text AS plan_date,forecast_date::text AS forecast_date,done,key_name,level,is_key,standard,owner_dept,owner_name,source,plan_version,note,line FROM public.milestones WHERE project_id=$1 AND id=$2', [parsed.projectId, parsed.id])).rows[0]);
    if (!row) missing();
    if (owner.discipline && row.line !== owner.discipline) forbidden();
    // Existing node visibility is project + discipline; owner_name is not an ACL.
    const { done, ...snapshot } = row;
    return result(parsed, snapshot, { title: '节点计划', what: row.name, due: row.forecast_date || row.plan_date || '',
      source_id: row.id, milestone_done: done });
  }
  if (parsed.kind === 'leader') {
    const row = await cached(cache, cacheKey, async () => (await client.query('SELECT id::text AS id,project_id,period,kind,what,due,author_name,rich_text,owner_id FROM public.leader_notes WHERE project_id=$1 AND id=$2', [parsed.projectId, parsed.id])).rows[0]);
    if (!row || !text(row.what).trim()) missing();
    if (row.owner_id && row.owner_id !== owner.user_id) forbidden();
    const { rich_text, owner_id, ...snapshot } = row;
    return result(parsed, snapshot, { title: row.kind === 'pzo_note' ? '项目总安排事项' : '总裁安排事项',
      what: row.what, due: row.due || '', source_id: row.id, ...sourceFormat(rich_text, 'what', row.what) });
  }
  if (parsed.kind === 'meeting') {
    // This helper is restricted to reviewers of an existing completion request;
    // it cannot expose unsubmitted private meeting matters to reviewers.
    const row = await cached(cache, cacheKey + ':' + owner.user_id, async () => caller.user_id === owner.user_id
      ? (await client.query('SELECT id::text AS id,project_id,owner_id,owner_name,title,what,due::text AS due,rich_text FROM public.reporter_tasks WHERE project_id=$1 AND id=$2 AND owner_id=$3', [parsed.projectId, parsed.id, owner.user_id])).rows[0]
      : (await client.query('SELECT id::text AS id,project_id,owner_id,owner_name,title,what,due,rich_text FROM app_private.completion_meeting_source($1,$2,$3)', [parsed.projectId, parsed.id, owner.user_id])).rows[0]);
    if (!row || !text(row.what).trim()) missing();
    if (row.owner_id !== owner.user_id || row.project_id !== parsed.projectId) forbidden();
    const { rich_text, ...snapshot } = row;
    return result(parsed, snapshot, { title: row.title, what: row.what, due: row.due || '', source_id: row.id,
      ...sourceFormat(rich_text, 'what', row.what) });
  }
  const report = await cached(cache, 'source:' + user.id + ':report:' + parsed.projectId + ':' + parsed.id,
    async () => (await client.query('SELECT id::text AS id,project_id,period,author_id,author_name,line,coord_items,biz,rich_text,report_scope_id,scope_project_ids FROM public.reports WHERE project_id=$1 AND id=$2', [parsed.projectId, parsed.id])).rows[0]);
  if (!report) missing();
  await requireReportOwnerScope(client, user, report, owner.user_id, cache);
  const ownsReport = report.author_id === owner.user_id;
  const writableScope = project.project_type === 'com' ? canUseBusinessModule(owner, report.line,project.id) : canUseResidentialLine(owner, report.line);
  if (parsed.kind === 'plan' && (!ownsReport || !writableScope)) forbidden();
  const items = parsed.kind === 'coord' && parsed.group === 'coord' ? report.coord_items : report.biz?.[parsed.group];
  const item = sourceItem(items, parsed);
  const base = { project_id: parsed.projectId, report_id: report.id, period: report.period,
    author_id: report.author_id, author_name: report.author_name, line: report.line, group: parsed.group, source_id: parsed.itemId };
  if (parsed.kind === 'coord') {
    const target = parsed.group === 'coord' ? item.who : item.to;
    const namedTarget = parsed.group === 'coord' && Object.hasOwn(item, 'who_id');
    const targetId = namedTarget && typeof item.who_id === 'string' ? item.who_id : '';
    if (ownsReport ? !writableScope : namedTarget ? targetId !== owner.user_id : !hitOwner(target, owner,project.id) && !hitOwner(item.what, owner,project.id)) forbidden();
    if (typeof item.what !== 'string' || !item.what.trim()) missing();
    const due = text(item.by || item.due);
    return result(parsed, { ...base, ...(namedTarget ? { who_id: targetId } : {}), target: text(target), what: item.what, due }, {
      title: parsed.group === 'handover' ? '工作面移交' : '协调需求事项', what: item.what, due,
      report_id: report.id, source_id: parsed.itemId,
      ...sourceFormat(report.rich_text, (parsed.group === 'coord' ? 'coord_items' : 'biz.handover') + '.' + items.indexOf(item) + '.what', item.what) });
  }
  if (typeof item.name !== 'string' || !item.name.trim()) missing();
  const snapshot = { ...base, name: item.name, mod: text(item.mod), plan: text(item.plan), forecast: text(item.forecast),
    due: text(item.due), prog: text(item.prog), is_key: !!item.is_key, custom: !!item.custom };
  return result(parsed, snapshot, { title: parsed.group === 'nodes' ? '节点计划' : '当期计划事项', what: item.name,
    due: text(item.due || item.forecast || item.plan), report_id: report.id, source_id: parsed.itemId,
    ...sourceFormat(report.rich_text, 'biz.' + parsed.group + '.' + items.indexOf(item) + '.name', item.name) });
}

function deadlineKey(source, ownerId) {
  return JSON.stringify([source.source_key, ownerId, source.due || '', source.title, source.what, source.source_snapshot?.who_id ?? source.who_id ?? null]);
}

// The statistics endpoint checks a complete set, rather than one list page.
// Populate the exact resolver cache in batches; source validation and version
// calculation still run through resolveCompletionSource for every request.
export async function preloadOperatorCompletionSources(client, user, rows, cache) {
  const caller = (await client.query('SELECT user_id,name,role,status,biz_line,discipline FROM public.profiles WHERE user_id=$1 AND user_id=auth.uid()', [user.id])).rows[0];
  if (caller?.status !== 'approved' || caller.role !== 'ops') forbidden();
  cache.set('caller:' + user.id, caller);
  const parsedRows = rows.map(row => ({ row, parsed: parseSourceKey(row.source_key) }));
  const owners = [...new Set(rows.map(row => row.owner_id))], projects = [...new Set(rows.map(row => row.project_id))];
  if (!rows.length) return;
  const ownerRows = (await client.query('SELECT user_id,name,role,status,biz_line,discipline FROM public.profiles WHERE user_id=ANY($1::text[])', [owners])).rows;
  const projectRows = (await client.query('SELECT id,project_type FROM public.projects WHERE id=ANY($1::text[])', [projects])).rows;
  const members = (await client.query('SELECT user_id,project_id FROM public.project_members WHERE user_id=ANY($1::text[]) AND project_id=ANY($2::text[])', [owners, projects])).rows;
  const membership = new Set(members.map(row => JSON.stringify([row.user_id, row.project_id])));
  const scopedOwners=projects.includes('hf')?await withBusinessModuleGrants(client,ownerRows,'hf'):ownerRows;
  for (const owner of owners) cache.set('owner:' + user.id + ':' + owner, scopedOwners.find(row => row.user_id === owner));
  for (const project of projects) cache.set('project:' + user.id + ':' + project, projectRows.find(row => row.id === project));
  for (const { row, parsed } of parsedRows) cache.set('member:' + user.id + ':' + row.owner_id + ':' + parsed.projectId, membership.has(JSON.stringify([row.owner_id, parsed.projectId])));
  for (const kind of ['milestone', 'leader', 'meeting', 'report', 'coordination', 'monthly']) {
    const relevant = parsedRows.filter(({ parsed }) => kind === 'report' ? ['coord', 'plan'].includes(parsed.kind) && !parsed.independent && !parsed.monthly
      : kind === 'coordination' ? parsed.independent : kind === 'monthly' ? parsed.monthly : parsed.kind === kind);
    if (!relevant.length) continue;
    const ids = [...new Set(relevant.map(({ parsed }) => parsed.id))];
    const sql = {
      milestone: 'SELECT id::text AS id,project_id,name,plan_date::text AS plan_date,forecast_date::text AS forecast_date,done,key_name,level,is_key,standard,owner_dept,owner_name,source,plan_version,note,line FROM public.milestones WHERE id=ANY($1::bigint[])',
      leader: 'SELECT id::text AS id,project_id,period,kind,what,due,author_name,rich_text,owner_id FROM public.leader_notes WHERE id=ANY($1::uuid[])',
      meeting: 'SELECT id::text AS id,project_id,owner_id,owner_name,title,what,due::text AS due,rich_text FROM public.reporter_tasks WHERE id=ANY($1::uuid[])',
      report: 'SELECT id::text AS id,project_id,period,author_id,author_name,line,coord_items,biz,rich_text,report_scope_id,scope_project_ids FROM public.reports WHERE id=ANY($1::bigint[])',
      coordination: "SELECT id::text AS id,project_id,author_id,author_name,owner_id,owner_name,what,rich_text,COALESCE(due::text,'') AS due FROM public.coordination_tasks WHERE id=ANY($1::uuid[])",
      monthly: 'SELECT id::text AS id,project_id,line,plan_month::text AS plan_month,items,rich_text,confirmed_by,confirmed_name,report_scope_id,scope_project_ids FROM public.monthly_plans WHERE id=ANY($1::uuid[])'
    }[kind];
    const found = (await client.query(sql, [ids])).rows;
    const index = new Map(found.map(row => [JSON.stringify([row.project_id, row.id, kind === 'meeting' ? row.owner_id : '']), row]));
    for (const { row, parsed } of relevant) {
      const suffix = kind === 'meeting' ? ':' + row.owner_id : '';
      cache.set('source:' + user.id + ':' + kind + ':' + parsed.projectId + ':' + parsed.id + suffix,
        index.get(JSON.stringify([parsed.projectId, parsed.id, kind === 'meeting' ? row.owner_id : ''])));
    }
  }
}

// Lists preload the relevant approvals once. Preview/request calls use the
// indexed lookup; no deadline becomes part of the original source fingerprint.
export async function preloadCompletionDeadlines(client, rows, cache) {
  const approvals = rows.length ? (await client.query(
    "SELECT id,source_key,owner_id,due,title,what,source_snapshot->>'who_id' AS who_id,requested_due::text AS requested_due FROM public.completion_requests WHERE request_type='extension' AND status='approved' AND source_key=ANY($1::text[]) AND owner_id=ANY($2::text[]) ORDER BY approved_at DESC,id DESC",
    [[...new Set(rows.map(row => row.source_key))], [...new Set(rows.map(row => row.owner_id))]])).rows : [];
  const deadlines = new Map();
  for (const row of approvals) {
    const key = deadlineKey(row, row.owner_id);
    if (!deadlines.has(key)) deadlines.set(key, row);
  }
  cache.set('approved-deadlines', deadlines);
}

export async function resolveCompletionSource(client, user, sourceKey, options = {}) {
  const source = await resolveBaseSource(client, user, sourceKey, options);
  const ownerId = options.forOwnerId ?? user.id;
  let extension;
  if (options.cache?.has('approved-deadlines')) extension = options.cache.get('approved-deadlines').get(deadlineKey(source, ownerId));
  else extension = (await client.query(
    "SELECT id,requested_due::text AS requested_due FROM public.completion_requests WHERE request_type='extension' AND status='approved' AND source_key=$1 AND owner_id=$2 AND due=$3 AND title=$4 AND what=$5 AND (source_snapshot->>'who_id') IS NOT DISTINCT FROM $6::text ORDER BY approved_at DESC,id DESC LIMIT 1",
    [source.source_key, ownerId, source.due || '', source.title, source.what, source.source_snapshot?.who_id ?? null])).rows[0];
  return { ...source, original_due: source.due || '', effective_due: extension?.requested_due || source.due || '', extension_id: extension?.id || null };
}
