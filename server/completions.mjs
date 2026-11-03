import { randomUUID } from 'node:crypto';
import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { resolveCompletionSource, preloadCompletionDeadlines } from './completion-sources.mjs';
import { validateRichText } from './rich-text.mjs';

const statuses = ['pending', 'approved', 'rejected', 'withdrawn', 'reopened'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = 'id,source_key,source_version,project_id,kind,source_id,report_id,title,what,due,source_snapshot,owner_id,owner_name,request_type,requested_due::text AS requested_due,effective_due,completion_date::text AS completion_date,completion_note,status,review_note,rich_text,reviewer_id,reviewer_name,reviewed_at,approved_at,revision,created_at::text AS created_at,updated_at,app_private.can_review_completion(kind,source_key,project_id,report_id) AS can_review';
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
function input(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(400, '完成申报请求格式不正确', 'invalid_completion');
}
function text(value, label, length, required = false) {
  if (typeof value !== 'string' || value.length > length || value.includes('\u0000') || (required && !value.trim())) fail(400, label + '格式不正确或过长', 'invalid_completion');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, '完成申报标识不正确', 'invalid_completion');
  return value.toLowerCase();
}
function sourceKey(value) {
  const key = text(value, '来源标识', 500, true), parts = key.split(':');
  if (['leader', 'meeting', 'coord'].includes(parts[0]) && parts.length === 3 && uuid.test(parts[2])) parts[2] = parts[2].toLowerCase();
  if (parts[0] === 'monthly' && parts.length === 4 && uuid.test(parts[2])) parts[2] = parts[2].toLowerCase();
  return parts.join(':');
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, '请刷新申报版本后再操作', 'revision_required');
  return value;
}
function date(value, label = '实际完成日期') {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) fail(400, '请填写有效的' + label, 'invalid_completion');
  return value;
}
function version(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) fail(400, '来源版本不正确，请重新预览', 'invalid_source_version');
  return value.toLowerCase();
}
async function actor(client, user, roles) {
  const profile = await getProfile(client, user.id);
  if (profile?.status !== 'approved' || !roles.includes(profile.role)) fail(403, '没有执行此完成申报操作的权限', 'completion_forbidden');
  return profile;
}
async function lockSource(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['completion:' + key]);
}
function snapshot(source) {
  const value = { ...source.source_snapshot, source_key: source.source_key, source_version: source.source_version, project_id: source.project_id,
    kind: source.kind, title: source.title, what: source.what, due: source.due || '', original_due: source.original_due || '', effective_due: source.effective_due || '', extension_id: source.extension_id || null };
  if (source.report_id != null) value.report_id = source.report_id;
  if (source.rich_text) value.rich_text = source.rich_text;
  return value;
}
async function legacyNode(client, source) {
  if (source.kind !== 'milestone' || !source.milestone_done) return false;
  return !(await client.query('SELECT app_private.completion_node_has_approved($1,$2) AS approved', [source.project_id, source.source_key])).rows[0].approved;
}
function sourceChanged(row, source) {
  return row.request_type === 'extension'
    ? row.due !== (source.due || '') || row.title !== source.title || row.what !== source.what
      || (row.source_snapshot?.who_id ?? null) !== (source.source_snapshot?.who_id ?? null)
    : source.source_version !== row.source_version;
}
function reviewAuthority(row) {
  const parts = String(row.source_key || '').split(':');
  return row.kind === 'coord' && (parts.length === 3 || parts.length === 5 && parts[3] === 'coord') ? 'initiator' : 'ops';
}
function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function completionCategory(row, deadline) {
  return row.request_type === 'extension' ? 'extension' : !calendarDay(deadline) || !calendarDay(row.completion_date)
    ? 'unknown' : row.completion_date > deadline ? 'late' : 'on_time';
}
function requestDeadline(row) { return row.effective_due ?? row.source_snapshot?.effective_due ?? row.due ?? ''; }
function presented(row, source) {
  const changed = sourceChanged(row, source), effectiveDue = source.effective_due || '';
  const deadline = requestDeadline(row), category = completionCategory(row, deadline);
  return { ...row, review_authority: reviewAuthority(row), original_due: source.original_due || '', effective_due: effectiveDue, deadline_at_request: deadline, completion_category: category,
    source_changed: changed, source_missing: false, effective_status: changed ? 'source_changed' : row.status };
}
async function checkedSource(client, user, row, cache) {
  try {
    const source = await resolveCompletionSource(client, user, row.source_key, { forOwnerId: row.owner_id, cache });
    return presented(row, source);
  } catch (error) {
    if (!(error instanceof HttpError) || ![400, 403, 404].includes(error.status)) throw error;
    const missing = error.status !== 403;
    return { ...row, review_authority: reviewAuthority(row), deadline_at_request: requestDeadline(row), completion_category: completionCategory(row, requestDeadline(row)), source_changed: !missing, source_missing: missing, source_access_lost: error.status === 403,
      effective_status: missing ? 'source_missing' : 'source_changed' };
  }
}
function cursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, '列表游标不正确', 'invalid_cursor');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || Object.keys(parsed).sort().join(',') !== 'created_at,id' || !uuid.test(parsed.id) || typeof parsed.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at))) throw new Error();
    return parsed;
  } catch { fail(400, '列表游标不正确', 'invalid_cursor'); }
}

export async function listCompletions(pool, user, request = {}) {
  input(request, ['project_id', 'status', 'id', 'limit', 'cursor', 'source_keys', 'request_type', 'review_scope']);
  const recordId = request.id === undefined ? undefined : id(request.id);
  const pid = request.project_id === undefined ? undefined : text(request.project_id, '项目', 200, true);
  if (request.status !== undefined && request.status !== 'all' && !statuses.includes(request.status)) fail(400, '申报处理状态不正确', 'invalid_completion');
  if (request.request_type !== undefined && !['completion', 'extension'].includes(request.request_type)) fail(400, '申报类别不正确', 'invalid_completion');
  if (request.review_scope !== undefined && request.review_scope !== 'initiated') fail(400, '审核范围不正确', 'invalid_completion');
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, '每页申报数量须为1至500', 'invalid_completion');
  if (request.source_keys !== undefined && (!Array.isArray(request.source_keys) || request.source_keys.length > 500)) fail(400, '来源筛选最多500项', 'invalid_completion');
  const keys = request.source_keys?.map(sourceKey);
  const after = cursor(request.cursor);
  return withIdentity(pool, user.id, async (client) => {
    const profile = await actor(client, user, ['pm', 'ops', 'president', 'pzo']);
    if (request.review_scope === 'initiated' && profile.role !== 'pm') fail(403, '仅发起人可读取本人协调审核栏', 'completion_forbidden');
    if (pid && !(await client.query('SELECT id FROM public.projects WHERE id=$1', [pid])).rows.length) fail(403, '无权查看此项目', 'completion_forbidden');
    const values = [], filters = [];
    const add = (sql, value) => { values.push(value); filters.push(sql.replace('?', '$' + values.length)); };
    if (request.review_scope === 'initiated') filters.push('app_private.is_initiator_coordination(kind,source_key,project_id,report_id) AND app_private.can_review_completion(kind,source_key,project_id,report_id)');
    else if (profile.role === 'pm' && recordId === undefined) add('owner_id=?', user.id);
    if (pid !== undefined) add('project_id=?', pid);
    if (recordId !== undefined) add('id=?', recordId);
    if (request.request_type !== undefined) add('request_type=?', request.request_type);
    const status = request.status === 'all' ? undefined : request.status ?? (profile.role === 'ops' && !recordId && keys === undefined ? 'pending' : undefined);
    if (status !== undefined) add('status=?', status);
    if (keys !== undefined) add('source_key=ANY(?::text[])', keys);
    if (after) {
      values.push(after.created_at, after.id);
      filters.push('(created_at,id)<($' + (values.length - 1) + '::timestamptz,$' + values.length + '::uuid)');
    }
    values.push(recordId ? 1 : limit + 1);
    const found = (await client.query('SELECT ' + fields + (recordId ? ',history' : '') + ' FROM public.completion_requests'
      + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY created_at DESC,id DESC LIMIT $' + values.length, values)).rows;
    const more = !recordId && found.length > limit, page = more ? found.slice(0, limit) : found;
    const cache = new Map(), rows = [];
    await preloadCompletionDeadlines(client, page, cache);
    for (const row of page) rows.push(await checkedSource(client, user, row, cache));
    const last = page.at(-1);
    // Retain PostgreSQL microseconds: converting to a JS Date here would round
    // the boundary to milliseconds and could skip same-millisecond requests.
    const next = more ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url') : null;
    Object.defineProperty(rows, 'meta', { value: { has_more: more, next_cursor: next } });
    return rows;
  });
}

export async function previewCompletion(pool, user, request) {
  input(request, ['source_key']);
  const key = sourceKey(request.source_key);
  return withIdentity(pool, user.id, async (client) => {
    await actor(client, user, ['pm']);
    const source = await resolveCompletionSource(client, user, key);
    const permission = (await client.query('SELECT app_private.can_review_completion($1,$2,$3,$4) AS can_review', [source.kind, source.source_key, source.project_id, source.report_id || null])).rows[0];
    return { ...snapshot(source), review_authority: reviewAuthority(source), can_review: !!permission.can_review, legacy_completed: await legacyNode(client, source) };
  });
}

export async function requestCompletion(pool, user, request) {
  input(request, ['source_key', 'source_version', 'expected_revision', 'completion_date', 'completion_note', 'request_type', 'requested_due', 'rich_text']);
  const key = sourceKey(request.source_key), expectedVersion = version(request.source_version);
  const type = request.request_type ?? 'completion';
  if (!['completion', 'extension'].includes(type)) fail(400, '申报类别不正确', 'invalid_completion');
  const completed = type === 'completion' ? date(request.completion_date) : null;
  const requestedDue = type === 'extension' ? date(request.requested_due, '申请延期日期') : null;
  if (type === 'extension' && request.completion_date != null || type === 'completion' && request.requested_due != null) fail(400, '申报日期与类别不符', 'invalid_completion');
  const note = text(request.completion_note, type === 'extension' ? '延期理由' : '完成说明', 10000, true);
  const rich = validateRichText('completion_requests', request.rich_text ?? {}, { completion_note: note });
  if (request.expected_revision !== undefined) revision(request.expected_revision);
  return withIdentity(pool, user.id, async (client) => {
    const profile = await actor(client, user, ['pm']);
    await lockSource(client, key);
    const source = await resolveCompletionSource(client, user, key);
    if (source.source_version !== expectedVersion) fail(409, '来源已变更，请重新预览后申报', 'source_changed');
    if (await legacyNode(client, source)) fail(409, '该节点已有原完成标记，请先由运营核实既有完成状态', 'legacy_completed');
    const records = (await client.query('SELECT * FROM public.completion_requests WHERE source_key=$1 AND owner_id=$2 FOR UPDATE', [key, user.id])).rows;
    if (records.some(row => row.status === 'pending')) fail(409, '该事项已有待审核申报，请先等待审核或撤回', 'invalid_transition');
    const prior = records.find(row => row.request_type === 'completion');
    const reviewer = reviewAuthority(source) === 'initiator' ? '发起人' : '运营';
    if (type === 'extension') {
      if (prior?.status === 'approved') fail(409, '该事项已完成，请先由' + reviewer + '重新开启', 'invalid_transition');
      if (request.expected_revision !== undefined) fail(400, '延期每次新建申请，请重新预览', 'invalid_completion');
      if (/^\d{4}-\d{2}-\d{2}$/.test(source.effective_due) && requestedDue <= source.effective_due) fail(400, '申请日期须晚于当前执行截止时间', 'invalid_completion');
    } else if (prior) {
      if (!['rejected', 'withdrawn', 'reopened'].includes(prior.status)) fail(409, prior.status === 'approved' ? '该事项已通过，请由' + reviewer + '按需重新开启' : '该事项已在审核中', 'invalid_transition');
      if (request.expected_revision === undefined) fail(400, '请刷新申报版本后再操作', 'revision_required');
      if (prior.revision !== request.expected_revision) fail(409, '申报已更新，请刷新后重试', 'revision_conflict');
    } else if (request.expected_revision !== undefined) fail(409, '申报记录已变更，请刷新后重试', 'revision_conflict');
    const values = [source.source_version, source.source_id || key.split(':').at(-1), source.report_id || null,
      source.title, source.what, source.due || '', JSON.stringify(snapshot(source)), completed, note, JSON.stringify(rich)];
    let saved;
    if (type === 'completion' && prior) {
      values.push(prior.id);
      saved = (await client.query("UPDATE public.completion_requests SET source_version=$1,source_id=$2,report_id=$3,title=$4,what=$5,due=$6,source_snapshot=$7,completion_date=$8,completion_note=$9,rich_text=$10,status='pending' WHERE id=$11 RETURNING " + fields, values)).rows[0];
    } else {
      values.push(randomUUID(), key, source.project_id, source.kind, user.id, profile.name, type, requestedDue);
      saved = (await client.query('INSERT INTO public.completion_requests(source_version,source_id,report_id,title,what,due,source_snapshot,completion_date,completion_note,rich_text,id,source_key,project_id,kind,owner_id,owner_name,request_type,requested_due) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING ' + fields, values)).rows[0];
    }
    if (!saved) fail(403, '申报记录不存在或已失去访问权限', 'completion_forbidden');
    return presented(saved, source);
  });
}

export async function reviewCompletion(pool, user, request) {
  input(request, ['id', 'expected_revision', 'decision', 'note', 'rich_text']);
  const recordId = id(request.id), expected = revision(request.expected_revision), decision = request.decision;
  if (!['approve', 'reject', 'reopen'].includes(decision)) fail(400, '审核操作不正确', 'invalid_completion');
  const note = text(request.note ?? '', '审核意见', 10000, decision !== 'approve');
  const rich = validateRichText('completion_requests', request.rich_text ?? {}, { review_note: note });
  const reviewFields = JSON.stringify(rich.fields || {});
  return withIdentity(pool, user.id, async (client) => {
    await actor(client, user, ['ops', 'pm']);
    // Read the key before acquiring the shared source lock; re-read and lock
    // the request afterward so every writer uses the same lock order.
    const keyRow = (await client.query('SELECT source_key,app_private.can_review_completion(kind,source_key,project_id,report_id) AS allowed FROM public.completion_requests WHERE id=$1', [recordId])).rows[0];
    if (!keyRow?.allowed) fail(403, '申报不存在或无权审核', 'completion_forbidden');
    await lockSource(client, keyRow.source_key);
    const row = (await client.query('SELECT * FROM public.completion_requests WHERE id=$1 FOR UPDATE', [recordId])).rows[0];
    if (!row) fail(403, '申报不存在或当前审核权限已变更', 'completion_forbidden');
    if (row.revision !== expected) fail(409, '申报已更新，请刷新后重试', 'revision_conflict');
    if (!(await client.query('SELECT app_private.can_review_completion($1,$2,$3,$4) AS allowed', [row.kind, row.source_key, row.project_id, row.report_id])).rows[0].allowed) fail(403, '此协调事项由发起人确认，其他事项由运营审核', 'completion_forbidden');
    if (row.request_type === 'extension' && decision === 'reopen') fail(409, '已批准延期保留为历史，如需延后请另行申请', 'invalid_transition');
    if ((decision === 'reopen' && row.status !== 'approved') || (decision !== 'reopen' && row.status !== 'pending')) fail(409, '当前申报状态不支持此审核操作', 'invalid_transition');
    if (decision === 'approve') {
      await client.query('SELECT app_private.lock_completion_source($1)', [row.id]);
      let source;
      try { source = await resolveCompletionSource(client, user, row.source_key, { forOwnerId: row.owner_id }); }
      catch (error) {
        if (!(error instanceof HttpError) || ![400, 403, 404].includes(error.status)) throw error;
        fail(409, '来源不存在或当前承办范围已改变，请核实后退回', 'source_changed');
      }
      if (sourceChanged(row, source)) fail(409, '来源已变更，请核实后退回补充', 'source_changed');
    }
    const next = { approve: 'approved', reject: 'rejected', reopen: 'reopened' }[decision];
    if (row.request_type === 'completion' && row.kind === 'milestone' && decision !== 'reject') {
      const updated = (await client.query('UPDATE public.milestones SET done=$1 WHERE id=$2 AND project_id=$3 RETURNING id', [decision === 'approve', row.source_id, row.project_id])).rows;
      if (!updated.length) fail(409, '原节点已移除，请先核实事项来源', 'source_changed');
    }
    let saved;
    if (decision === 'reopen' && row.kind === 'milestone') {
      const all = (await client.query("UPDATE public.completion_requests SET status='reopened',review_note=$1,rich_text=CASE WHEN rich_text='{}'::jsonb AND $2::jsonb='{}'::jsonb THEN rich_text ELSE jsonb_build_object('v',1,'fields',(COALESCE(rich_text->'fields','{}'::jsonb)-'review_note')||$2::jsonb) END WHERE source_key=$3 AND project_id=$4 AND status='approved' AND request_type='completion' RETURNING " + fields, [note, reviewFields, row.source_key, row.project_id])).rows;
      saved = all.find((entry) => entry.id === row.id);
      if (saved) saved.reopened_count = all.length;
    } else saved = (await client.query("UPDATE public.completion_requests SET status=$1,review_note=$2,rich_text=CASE WHEN rich_text='{}'::jsonb AND $3::jsonb='{}'::jsonb THEN rich_text ELSE jsonb_build_object('v',1,'fields',(COALESCE(rich_text->'fields','{}'::jsonb)-'review_note')||$3::jsonb) END WHERE id=$4 RETURNING " + fields, [next, note, reviewFields, row.id])).rows[0];
    if (!saved) fail(409, '申报已变更，请刷新后重试', 'revision_conflict');
    return checkedSource(client, user, saved, new Map());
  });
}

export async function withdrawCompletion(pool, user, request) {
  input(request, ['id', 'expected_revision']);
  const recordId = id(request.id), expected = revision(request.expected_revision);
  return withIdentity(pool, user.id, async (client) => {
    await actor(client, user, ['pm']);
    const keyRow = (await client.query('SELECT source_key FROM public.completion_requests WHERE id=$1 AND owner_id=$2', [recordId, user.id])).rows[0];
    if (!keyRow) fail(403, '只能撤回本人申报', 'completion_forbidden');
    await lockSource(client, keyRow.source_key);
    const row = (await client.query('SELECT * FROM public.completion_requests WHERE id=$1 AND owner_id=$2 FOR UPDATE', [recordId, user.id])).rows[0];
    if (!row || row.revision !== expected) fail(409, '申报已更新，请刷新后重试', 'revision_conflict');
    if (row.status !== 'pending') fail(409, '只有待审核申报可以撤回', 'invalid_transition');
    const saved = (await client.query("UPDATE public.completion_requests SET status='withdrawn' WHERE id=$1 RETURNING " + fields, [row.id])).rows[0];
    if (!saved) fail(403, '申报不存在或已失去访问权限', 'completion_forbidden');
    return checkedSource(client, user, saved, new Map());
  });
}
