import { getProfile, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { validateRichText } from './rich-text.mjs';
import { isDeepStrictEqual } from 'node:util';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = "id,project_id,author_id,author_name,owner_id,owner_name,what,rich_text,COALESCE(due::text,'') AS due,created_at";
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message, code = 'invalid_coordination') => { throw new HttpError(status, message, code); };
function input(request, allowed) {
  if (!object(request) || Object.keys(request).some(key => !allowed.includes(key))) fail(400, '协调申请格式不正确');
}
function text(value, label, length) {
  if (typeof value !== 'string' || !value.trim() || value.length > length || value.includes('\u0000')) fail(400, label + '不可为空或格式不正确');
  return value.trim();
}
function deadline(value) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) fail(400, '协调截止日期不正确');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, '协调截止日期不正确');
  return value;
}
function presented(row) { return { ...row, source_key: 'coord:' + row.project_id + ':' + row.id }; }
async function actor(client, user, projectId, roles) {
  const profile = await getProfile(client, user.id);
  if (profile?.status !== 'approved' || !roles.includes(profile.role)) fail(403, '当前身份无权办理协调申请', 'coordination_forbidden');
  if (projectId && !(await client.query('SELECT id FROM public.projects WHERE id=$1', [projectId])).rows.length) fail(403, '未分配此项目', 'coordination_forbidden');
  return profile;
}

export async function listCoordinationTasks(pool, user, request = {}) {
  input(request, ['project_id']);
  const pid = request.project_id === undefined ? undefined : text(request.project_id, '项目', 200);
  return withIdentity(pool, user.id, async client => {
    await actor(client, user, pid, ['pm', 'ops', 'president', 'pzo']);
    const rows = (await client.query('SELECT ' + columns + ' FROM public.coordination_tasks'
      + (pid ? ' WHERE project_id=$1' : '') + ' ORDER BY created_at DESC,id', pid ? [pid] : [])).rows;
    return rows.map(presented);
  });
}

export async function createCoordinationTask(pool, user, request) {
  input(request, ['id', 'project_id', 'owner_id', 'what', 'due', 'rich_text']);
  if (typeof request.id !== 'string' || !uuid.test(request.id)) fail(400, '协调申请标识不正确');
  const id = request.id.toLowerCase(), pid = text(request.project_id, '项目', 200), ownerId = text(request.owner_id, '承办人', 200);
  const what = text(request.what, '协调事项', 10000), due = deadline(request.due);
  const rich = validateRichText('coordination_tasks', request.rich_text === undefined ? {} : request.rich_text, { what });
  return withIdentity(pool, user.id, async client => {
    const profile = await actor(client, user, pid, ['pm']);
    const people = (await client.query("SELECT user_id,name FROM app_private.project_people($1) WHERE role='pm' AND user_id=ANY($2::text[])", [pid, [user.id, ownerId]])).rows;
    if (!people.some(person => person.user_id === user.id)) fail(403, '仅本项目有效填报人可发起协调', 'coordination_forbidden');
    const owner = people.find(person => person.user_id === ownerId);
    if (!owner) fail(400, '请选择本项目有效填报人作为承办人');
    // The client keeps one UUID while retrying a draft. A primary-key conflict
    // never updates source evidence or discloses another author's existing row.
    const inserted = (await client.query('INSERT INTO public.coordination_tasks(id,project_id,author_id,author_name,owner_id,owner_name,what,due,rich_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING ' + columns,
      [id, pid, user.id, profile.name, ownerId, owner.name, what, due, JSON.stringify(rich)])).rows[0];
    if (inserted) return presented(inserted);
    const existing = (await client.query('SELECT ' + columns + ' FROM public.coordination_tasks WHERE id=$1', [id])).rows[0];
    if (!existing || existing.author_id !== user.id || existing.project_id !== pid || existing.owner_id !== ownerId
      || existing.what !== what || existing.due !== (due || '') || !isDeepStrictEqual(existing.rich_text?.fields || {}, rich.fields || {})) fail(409, '协调申请标识已使用，请刷新核对后重试', 'coordination_conflict');
    return presented(existing);
  });
}
