import { randomUUID } from 'node:crypto';
import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { validateRichText } from './rich-text.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = 'id,project_id,owner_id,owner_name,created_by,meeting_kind,proposer_id,proposer_role,proposer_name,title,what,due::text AS due,status,progress,rich_text,revision,created_at,updated_at,completed_at';
const editable = new Set(['id', 'project_id', 'owner_id', 'meeting_kind', 'proposer_id', 'title', 'what', 'due', 'status', 'progress', 'expected_revision', 'rich_text']);
function text(value, label, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000') || (required && !value.trim())) throw new HttpError(400, label + '不可为空或格式不正确');
  return value;
}
function projectId(value) { return text(value, '项目', 200, true); }
function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, '会议事项标识不正确');
  return value;
}
function dueDate(value) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, '截止日期格式不正确');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) throw new HttpError(400, '截止日期不是有效日期');
  return value;
}
function richText(input, row, existing) {
  if (input === undefined) {
    const fields = Object.fromEntries(Object.entries(existing?.rich_text?.fields || {}).filter(([key]) => ['what', 'progress'].includes(key) && existing[key] === row[key]));
    return Object.keys(fields).length ? { v: 1, fields } : {};
  }
  if (!object(input)) throw new HttpError(400, '文字格式内容不正确', 'invalid_rich_text');
  if (!Object.keys(input).length) return {};
  if (input.v !== 1 || !object(input.fields) || Object.keys(input).some((key) => !['v', 'fields'].includes(key)) || Object.keys(input.fields).some((key) => !['what', 'progress'].includes(key))) throw new HttpError(400, '会议事项仅支持内容和进展的文字格式', 'invalid_rich_text');
  const fields = {};
  for (const [key, delta] of Object.entries(input.fields)) {
    fields[key] = validateRichText('leader_notes', { v: 1, fields: { what: delta } }, { what: row[key] }).fields.what;
  }
  return { v: 1, fields };
}
async function actor(client, user, pid, roles = ['pm', 'ops']) {
  const profile = await getProfile(client, user.id);
  if (profile?.status !== 'approved' || !roles.includes(profile.role)) throw new HttpError(403, '当前身份无权办理此操作');
  if (pid && !(await client.query('SELECT id FROM public.projects WHERE id=$1', [pid])).rows.length) throw new HttpError(403, '未分配此项目');
  return profile;
}

// Return only the public identity fields needed by assignment and coordination.
// The scoped database helper filters approved, enabled accounts, including
// globally authorized leaders; archived profiles cannot become new recipients.
export async function listProjectPeople(pool, user, request = {}) {
  if (!object(request) || Object.keys(request).some((key) => key !== 'project_id')) throw new HttpError(400, '项目人员查询不正确');
  const pid = projectId(request.project_id);
  return withIdentity(pool, user.id, async (client) => {
    await actor(client, user, pid, ['pm', 'ops', 'president', 'pzo']);
    return (await client.query('SELECT * FROM app_private.project_people($1) ORDER BY name,user_id', [pid])).rows;
  });
}

// List reads omit accumulated revision snapshots. An explicit task id returns
// its history for detail inspection without inflating every workbench request.
export async function listReporterTasks(pool, user, request = {}) {
  if (!object(request) || Object.keys(request).some((key) => !['project_id', 'id', 'meeting_kind'].includes(key))) throw new HttpError(400, '会议事项查询不正确');
  if (request.meeting_kind !== undefined && !['requirement', 'special', 'legacy'].includes(request.meeting_kind)) throw new HttpError(400, '会议事项类别不正确');
  const pid = request.project_id === undefined ? undefined : projectId(request.project_id);
  const id = request.id === undefined ? undefined : identifier(request.id);
  return withIdentity(pool, user.id, async (client) => {
    const profile = await actor(client, user, pid, ['pm', 'ops', 'president', 'pzo']);
    const values = profile.role === 'pm' ? [user.id] : [];
    const filters = profile.role === 'pm' ? ['owner_id=$1'] : [];
    for (const [name, value] of [['project_id', pid], ['id', id], ['meeting_kind', request.meeting_kind]]) if (value !== undefined) { values.push(value); filters.push(name + '=$' + values.length); }
    return (await client.query('SELECT ' + columns + (id ? ',history' : '') + ' FROM public.reporter_tasks' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY created_at DESC,id', values)).rows;
  });
}

export async function saveReporterTask(pool, user, request) {
  if (!object(request) || Object.keys(request).some((key) => !editable.has(key))) throw new HttpError(400, '会议事项保存内容不正确');
  const id = request.id === undefined ? undefined : identifier(request.id);
  const pid = projectId(request.project_id);
  if (id && (!Number.isSafeInteger(request.expected_revision) || request.expected_revision < 1)) throw new HttpError(400, '请刷新会议事项后再保存', 'revision_required');
  if (!id && request.expected_revision !== undefined) throw new HttpError(400, '新增事项不可指定历史版本');
  return withIdentity(pool, user.id, async (client) => {
    const profile = await actor(client, user, pid, ['pm', 'ops', 'president', 'pzo']);
    const existing = id ? (await client.query('SELECT ' + columns + ',history FROM public.reporter_tasks WHERE id=$1 FOR UPDATE', [id])).rows[0] : undefined;
    if (id && (!existing || existing.project_id !== pid)) throw new HttpError(403, '会议事项不存在或无权修改');
    if (existing && existing.revision !== request.expected_revision) throw new HttpError(409, '会议事项已更新，请刷新后重新编辑', 'revision_conflict');
    const meetingKind = request.meeting_kind ?? existing?.meeting_kind ?? 'special';
    if (!['requirement', 'special', 'legacy'].includes(meetingKind) || !existing && meetingKind === 'legacy') throw new HttpError(400, '请选择会议要求或专项会议决议');
    const leader = ['president', 'pzo'].includes(profile.role);
    if (!existing && profile.role !== 'ops' && !(leader && meetingKind === 'requirement')) throw new HttpError(403, '专项会议决议由运营录入，领导可提出本人会议要求');
    if (existing && leader && (existing.meeting_kind !== 'requirement' || existing.proposer_id !== user.id || meetingKind !== 'requirement')) throw new HttpError(403, '仅可维护本人提出的会议要求');
    let proposerId = request.proposer_id === undefined ? existing?.proposer_id ?? (leader ? user.id : null) : request.proposer_id;
    if (proposerId === '') proposerId = null;
    if (proposerId !== null) text(proposerId, '提出人', 200, true);
    if (leader && proposerId !== user.id) throw new HttpError(403, '领导仅可记录本人提出的要求');
    if (meetingKind === 'requirement' && !proposerId) throw new HttpError(400, '请选择提出要求的总裁或项目总');
    const row = { meeting_kind: meetingKind, proposer_id: proposerId,
      title: text(request.title ?? existing?.title, '会议主题', 200, true), what: text(request.what ?? existing?.what, '事项内容', 10000, true),
      due: dueDate(request.due === undefined ? existing?.due : request.due), status: request.status ?? existing?.status ?? 'open',
      progress: text(request.progress ?? existing?.progress ?? '', '进展', 10000), owner_id: text(request.owner_id ?? existing?.owner_id, '承办人', 200, true) };
    if (!['open', 'in_progress'].includes(row.status) && !(existing?.status === 'completed' && row.status === 'completed')) throw new HttpError(400, '请通过事项申报完成，不可直接标记完成');
    if (profile.role === 'pm' && (existing.owner_id !== user.id || ['title', 'what', 'due', 'owner_id', 'meeting_kind', 'proposer_id'].some((key) => row[key] !== existing[key]))) throw new HttpError(403, '填报人仅可更新本人会议事项的进展');
    const owner = profile.role !== 'pm'
      ? (await client.query("SELECT * FROM app_private.project_people($1) WHERE user_id=$2 AND role='pm'", [pid, row.owner_id])).rows[0]
      : profile;
    if (!owner) throw new HttpError(400, '请选择该项目中有效的填报人作为承办人');
    if (row.proposer_id && (!existing || row.proposer_id !== existing.proposer_id || row.meeting_kind !== existing.meeting_kind || leader)) {
      const proposer = (await client.query("SELECT * FROM app_private.project_people($1) WHERE user_id=$2 AND role IN ('president','pzo')", [pid, row.proposer_id])).rows[0];
      if (!proposer) throw new HttpError(400, '请选择该项目有权限的总裁或项目总作为提出人');
    }
    const formatted = richText(request.rich_text, row, existing);
    if (profile.role === 'pm') {
      const original = existing.rich_text?.fields?.what;
      if (formatted.fields?.what && JSON.stringify(formatted.fields.what) !== JSON.stringify(original)) throw new HttpError(403, '会议事项内容格式由运营维护');
      if (original) { formatted.v = 1; formatted.fields = { ...formatted.fields, what: original }; }
    }
    const format = JSON.stringify(formatted);
    if (!id) return (await client.query('INSERT INTO public.reporter_tasks (id,project_id,owner_id,owner_name,title,what,due,status,progress,rich_text,meeting_kind,proposer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ' + columns,
      [randomUUID(), pid, row.owner_id, owner.name, row.title, row.what, row.due, row.status, row.progress, format, row.meeting_kind, row.proposer_id])).rows[0];
    const saved = (await client.query('UPDATE public.reporter_tasks SET title=$1,what=$2,due=$3,status=$4,progress=$5,rich_text=$6,owner_id=$7,owner_name=$8,meeting_kind=$9,proposer_id=$10 WHERE id=$11 RETURNING ' + columns,
      [row.title, row.what, row.due, row.status, row.progress, format, row.owner_id, profile.role !== 'pm' ? owner.name : existing.owner_name, row.meeting_kind, row.proposer_id, id])).rows[0];
    if (!saved) throw new HttpError(403, '会议事项不存在或已失去访问权限');
    return saved;
  });
}

// Assignment changes only the existing leader record's owner metadata. It does
// not copy that matter into reporter_tasks or replace its completion source key.
export async function assignLeaderRequirement(pool, user, request = {}) {
  if (!object(request) || Object.keys(request).some((key) => !['id', 'project_id', 'owner_id', 'expected_owner_id'].includes(key))) throw new HttpError(400, '历史会议要求分派内容不正确');
  const id = identifier(request.id), pid = projectId(request.project_id), ownerId = text(request.owner_id, '责任人', 200, true);
  if (!Object.hasOwn(request, 'expected_owner_id') || request.expected_owner_id !== null && typeof request.expected_owner_id !== 'string') throw new HttpError(400, '请刷新历史责任人后再分派', 'revision_required');
  return withIdentity(pool, user.id, async (client) => {
    await actor(client, user, pid, ['ops']);
    const note = (await client.query('SELECT * FROM public.leader_notes WHERE id=$1 AND project_id=$2 FOR UPDATE', [id, pid])).rows[0];
    if (!note) throw new HttpError(404, '历史会议要求不存在或无权分派');
    if ((note.owner_id ?? null) !== request.expected_owner_id) throw new HttpError(409, '责任人已变更，请刷新核对后再分派', 'revision_conflict');
    const owner = (await client.query("SELECT * FROM app_private.project_people($1) WHERE user_id=$2 AND role='pm'", [pid, ownerId])).rows[0];
    if (!owner) throw new HttpError(400, '请选择该项目中有效的填报人作为责任人');
    return (await client.query('UPDATE public.leader_notes SET owner_id=$1,owner_name=$2 WHERE id=$3 RETURNING *', [ownerId, owner.name, id])).rows[0];
  });
}
