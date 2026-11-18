import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { withIdentity } from '../server/database.mjs';
import { createCoordinationTask, listCoordinationTasks } from '../server/coordination-tasks.mjs';
import { resolveCompletionSource } from '../server/completion-sources.mjs';
import { previewCompletion, requestCompletion, listCompletions, reviewCompletion } from '../server/completions.mjs';
import { completionStatistics } from '../server/completion-statistics.mjs';

const migration = await readFile(new URL('../db/022-coordination-rich-text.sql', import.meta.url), 'utf8');
const richModel = await readFile(new URL('../web/rich-text.js', import.meta.url), 'utf8');
const origin = { id: 'rich-coord-origin' }, owner = { id: 'rich-coord-owner' }, outsider = { id: 'rich-coord-outsider' }, ops = { id: 'rich-coord-ops' };
const what = '核对材料与交付结果';
const delta = { ops: [{ insert: '核对材料', attributes: { bold: true } }, { insert: '与交付结果', attributes: { color: '#d81e06' } }] };
const format = { v: 1, fields: { what: delta } };
const plain = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function fixture(t, before = false) {
  // Disposable in-memory PostgreSQL only. No live environment, SMTP or files.
  const db = await initializedDatabase(before ? { through: 21 } : undefined); t.after(() => db.close());
  if (!before) await db.exec(migration);
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('rich-coord-project','匿名协调项目','res'),('rich-coord-private','其他项目','res')");
  for (const [user, name, role] of [[origin, '匿名发起人', 'pm'], [owner, '匿名承办人', 'pm'], [outsider, '其他项目填报人', 'pm'], [ops, '匿名运营', 'ops']]) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', [user.id, user.id + '@example.invalid', 'isolated-unused-auth-value']);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,$2,$3,'approved','工程')", [user.id, name, role]);
    if (role === 'pm') await admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)', [user.id, user.id === outsider.id ? 'rich-coord-private' : 'rich-coord-project']);
  }
  const body = extra => ({ id: randomUUID(), project_id: 'rich-coord-project', owner_id: owner.id, what, due: '2026-10-25', rich_text: format, ...extra });
  return { db, admin, pool, body };
}

test('independent coordination persists restricted formatting and retries without changing immutable content or permissions', async t => {
  const f = await fixture(t), body = f.body();
  const saved = await createCoordinationTask(f.pool, origin, body);
  assert.equal(saved.what, what); assert.deepEqual(saved.rich_text, format);
  assert.equal(saved.author_name, '匿名发起人'); assert.equal(saved.owner_name, '匿名承办人');
  assert.deepEqual(await createCoordinationTask(f.pool, origin, plain(body)), saved);
  assert.deepEqual((await listCoordinationTasks(f.pool, owner))[0].rich_text, format);
  assert.equal((await listCoordinationTasks(f.pool, outsider)).length, 0);
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.reports')).rows[0].n, 0);
  for (const rich_text of [{}, { v: 1, fields: { what: { ops: [{ insert: what, attributes: { bold: true } }] } } }]) {
    await assert.rejects(createCoordinationTask(f.pool, origin, { ...body, rich_text }), error => error.status === 409 && error.code === 'coordination_conflict');
  }
  await assert.rejects(withIdentity(f.pool, origin.id, client => client.query("UPDATE public.coordination_tasks SET rich_text='{}'::jsonb WHERE id=$1", [saved.id])), error => error.code === '42501');
  await assert.rejects(createCoordinationTask(f.pool, outsider, f.body()), error => error.status === 403);
  await assert.rejects(createCoordinationTask(f.pool, ops, f.body()), error => error.status === 403);
});

test('coordination rejects HTML-like attributes, unsupported paths and mismatched text instead of saving partial formatting', async t => {
  const f = await fixture(t);
  const invalid = [null, [], { v: 2, fields: { what: delta } },
    { v: 1, fields: { owner_name: delta } },
    { v: 1, fields: { what: { ops: [{ insert: what, attributes: { link: 'https://example.invalid/' } }] } } },
    { v: 1, fields: { what: { ops: [{ insert: what, attributes: { color: 'red' } }] } } },
    { v: 1, fields: { what: { ops: [{ insert: '<img src=x>' }] } } },
    { v: 1, fields: { what: { ops: [{ insert: { image: 'x' } }] } } }];
  for (const rich_text of invalid) await assert.rejects(createCoordinationTask(f.pool, origin, f.body({ rich_text })), error => error.status === 400 && error.code === 'invalid_rich_text');
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.coordination_tasks')).rows[0].n, 0);
  const literal = '<script>仅作为文字保存</script>';
  const saved = await createCoordinationTask(f.pool, origin, f.body({ what: literal, rich_text: { v: 1, fields: { what: { ops: [{ insert: literal, attributes: { bold: true } }] } } } }));
  const sandbox = {}; sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(richModel, sandbox);
  const html = sandbox.ZHRichText.field(saved, 'what');
  assert.match(html, /<strong>&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test('migration keeps old coordination fingerprints, original rows, trigger identity and read/insert-only grants', async t => {
  const f = await fixture(t, true), id = randomUUID();
  await withIdentity(f.pool, origin.id, client => client.query("INSERT INTO public.coordination_tasks(id,project_id,author_id,author_name,owner_id,owner_name,what,due) VALUES($1,'rich-coord-project',$2,'伪造姓名',$3,'伪造姓名',$4,'2026-10-25')", [id, origin.id, owner.id, what]));
  const old = (await f.admin.query("SELECT id::text AS id,project_id,author_id,author_name,owner_id,owner_name,what,COALESCE(due::text,'') AS due FROM public.coordination_tasks WHERE id=$1", [id])).rows[0];
  const sourceKey = 'coord:rich-coord-project:' + id;
  const expected = createHash('sha256').update(JSON.stringify(canonical({ source_key: sourceKey, ...old, who_id: owner.id }))).digest('hex');
  const meta = (await f.admin.query("SELECT oid,proowner,proacl::text AS acl FROM pg_proc WHERE oid='app_private.guard_coordination_task()'::regprocedure")).rows;
  await f.db.exec(migration); await f.db.exec(migration);
  const after = (await f.admin.query('SELECT to_jsonb(t)-\'rich_text\' AS data,rich_text FROM public.coordination_tasks t WHERE id=$1', [id])).rows[0];
  assert.deepEqual(after.rich_text, {}); assert.equal(after.data.what, what); assert.equal(after.data.author_name, '匿名发起人');
  assert.deepEqual((await f.admin.query("SELECT oid,proowner,proacl::text AS acl FROM pg_proc WHERE oid='app_private.guard_coordination_task()'::regprocedure")).rows, meta);
  const source = await withIdentity(f.pool, owner.id, client => resolveCompletionSource(client, owner, sourceKey));
  assert.equal(source.source_version, expected); assert.equal(source.rich_text, undefined); assert.equal(source.source_snapshot.rich_text, undefined);
  const grants = (await f.admin.query("SELECT has_table_privilege('app_runtime','public.coordination_tasks','SELECT') AS read,has_table_privilege('app_runtime','public.coordination_tasks','INSERT') AS create,has_table_privilege('app_runtime','public.coordination_tasks','UPDATE') AS edit,has_table_privilege('app_runtime','public.coordination_tasks','DELETE') AS remove")).rows[0];
  assert.deepEqual(grants, { read: true, create: true, edit: false, remove: false });
});

test('coordination completion preview, initiator review, statistics and immutable history retain original source formatting', async t => {
  const f = await fixture(t), saved = await createCoordinationTask(f.pool, origin, f.body());
  const preview = await previewCompletion(f.pool, owner, { source_key: saved.source_key });
  assert.deepEqual(preview.rich_text, format);
  const pending = await requestCompletion(f.pool, owner, { source_key: saved.source_key, source_version: preview.source_version, completion_date: '2026-10-25', completion_note: '已核对并附验收结果' });
  assert.deepEqual(pending.source_snapshot.rich_text, format);
  await assert.rejects(reviewCompletion(f.pool, ops, { id: pending.id, expected_revision: pending.revision, decision: 'approve', note: '' }), error => error.status === 403);
  const approved = await reviewCompletion(f.pool, origin, { id: pending.id, expected_revision: pending.revision, decision: 'approve', note: '' });
  assert.equal(approved.source_version, preview.source_version);
  const reread = (await listCompletions(f.pool, origin, { id: pending.id }))[0];
  assert.deepEqual(reread.source_snapshot.rich_text, format); assert.deepEqual(reread.history[0].data.source_snapshot.rich_text, format);
  const stats = await completionStatistics(f.pool, ops, { kind: 'coord', start: '2026-01-01', end: '2026-12-31' });
  assert.equal(stats.totals.completed, 1); assert.equal(stats.totals.source_changed, 0);
  const sandbox = {}; sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(richModel, sandbox);
  assert.match(sandbox.ZHRichText.field(reread.source_snapshot, 'what'), /<strong>核对材料<\/strong>.*rt-red/);
});
