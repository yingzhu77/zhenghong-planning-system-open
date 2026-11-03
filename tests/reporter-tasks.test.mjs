import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/app.mjs';
import { replaceLeaderNotes, withIdentity } from '../server/database.mjs';
import { listReporterTasks, saveReporterTask } from '../server/reporter-tasks.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const user = { id: 'demo-pm-res' };
const operator = { id: 'demo-ops' };
const format = (fields) => ({ v: 1, fields });
const delta = (insert) => ({ ops: [{ insert, attributes: { bold: true, color: '#d81e06' } }] });
const matter = (extra = {}) => ({ project_id: 'demo-res', owner_id: user.id, title: '会中跟踪事项', what: '确认验收资料\n周五反馈', due: '2026-10-30', status: 'open', progress: '', ...extra });
const status = (expected) => (error) => error.status === expected;
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const accounts = await seedDemo(testPool(db, null));
  return { db, accounts, pool: testPool(db), admin: testPool(db, null) };
}

test('meeting follow-up migration is repeatable and leaves reports, users and project allocations unchanged', async (t) => {
  const { db, pool } = await fixture(t);
  const saved = await saveReporterTask(pool, operator, matter());
  await db.exec('RESET ROLE');
  const snapshot = async () => (await db.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m)) FROM public.project_members m),'tasks',(SELECT jsonb_agg(to_jsonb(t)) FROM public.reporter_tasks t)) AS data")).rows[0].data;
  const before = await snapshot();
  const sql = await readFile(new URL('../db/006-reporter-tasks.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  await db.exec(await readFile(new URL('../db/013-operator-meetings.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.tasks[0].id, saved.id);
  assert.equal(before.tasks.length, 1);
});

test('assigned meeting matters save revisions, preserve rich text and source history without inflating list reads', async (t) => {
  const { pool } = await fixture(t);
  const initial = matter(); initial.rich_text = format({ what: delta(initial.what) });
  const saved = await saveReporterTask(pool, operator, initial);
  assert.equal(saved.owner_id, user.id);
  assert.equal(saved.owner_name, '演示住宅经理');
  assert.equal(saved.revision, 1);
  assert.equal(saved.completed_at, null);
  assert.equal(saved.due, '2026-10-30');
  assert.equal(Object.hasOwn(saved, 'history'), false);
  const changed = await saveReporterTask(pool, user, matter({ id: saved.id, expected_revision: 1, status: 'in_progress', progress: '已整理资料' }));
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.rich_text, saved.rich_text);
  await assert.rejects(saveReporterTask(pool, user, matter({ id: saved.id, expected_revision: 1, progress: '覆盖并发保存' })), (error) => error.status === 409 && error.code === 'revision_conflict');
  await assert.rejects(saveReporterTask(pool, user, matter({ id: saved.id, expected_revision: 2, status: 'completed' })), status(400));
  const done = await saveReporterTask(pool, operator, matter({ id: saved.id, expected_revision: 2, status: 'in_progress', progress: '会议确认资料已整理', what: '已确认验收资料' }));
  assert.equal(done.revision, 3);
  assert.equal(done.completed_at, null);
  assert.deepEqual(done.rich_text, {});
  const listed = await listReporterTasks(pool, user, { project_id: 'demo-res' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'in_progress');
  assert.equal(Object.hasOwn(listed[0], 'history'), false);
  const detailed = (await listReporterTasks(pool, user, { id: saved.id }))[0];
  assert.equal(detailed.history.length, 2);
  assert.equal(detailed.history[0].data.what, initial.what);
  assert.deepEqual(detailed.history[0].data.rich_text, initial.rich_text);
  assert.equal(detailed.history[1].data.progress, '已整理资料');
  assert.equal(detailed.history.some((entry) => entry.data.progress === '覆盖并发保存'), false);
  const concurrent = await Promise.allSettled(['并发修改一', '并发修改二'].map((progress) => saveReporterTask(pool, user, matter({ id: saved.id, expected_revision: 3, status: 'in_progress', what: '已确认验收资料', progress }))));
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find((result) => result.status === 'rejected').reason.code, 'revision_conflict');
  assert.equal((await listReporterTasks(pool, user, { id: saved.id }))[0].history.length, 3);
});

test('meeting matter boundary rejects forged actors, impossible dates, mismatched formatting and missing revisions', async (t) => {
  const { pool } = await fixture(t);
  for (const payload of [null, [], matter({ owner_id: 'demo-pm-com' }), matter({ title: ' ' }), matter({ what: '\u0000' }),
    matter({ due: '2026-02-30' }), matter({ due: '2025-02-29' }), matter({ due: '0000-01-01' }), matter({ status: '任意状态' }),
    matter({ rich_text: format({ what: delta('不同正文') }) }), matter({ rich_text: format({ title: delta('会中跟踪事项') }) }),
    matter({ rich_text: format({ what: { ops: [{ insert: '确认验收资料\n周五反馈', attributes: { link: 'https://invalid.example' } }] } }) })]) {
    await assert.rejects(saveReporterTask(pool, operator, payload), status(400));
  }
  const saved = await saveReporterTask(pool, operator, matter({ due: '2028-02-29' }));
  await assert.rejects(saveReporterTask(pool, user, matter({ id: saved.id })), (error) => error.code === 'revision_required');
  await assert.rejects(listReporterTasks(pool, user, { owner_id: 'demo-pm-com' }), status(400));
  assert.equal((await listReporterTasks(pool, user)).length, 1);
});

test('meeting task RLS enforces owner and current project membership, with database audit guards', async (t) => {
  const { db, pool, admin } = await fixture(t);
  const saved = await saveReporterTask(pool, operator, matter());
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES ('demo-other-pm','同项目填报人','pm','approved')");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES ('demo-other-pm','demo-res')");
  assert.deepEqual(await listReporterTasks(pool, { id: 'demo-other-pm' }, { project_id: 'demo-res' }), []);
  await assert.rejects(saveReporterTask(pool, { id: 'demo-other-pm' }, matter({ id: saved.id, expected_revision: 1 })), status(403));
  await assert.rejects(saveReporterTask(pool, { id: 'demo-pm-com' }, matter()), status(403));
  await assert.rejects(saveReporterTask(pool, user, matter({ id: saved.id, project_id: 'demo-com', expected_revision: 1 })), status(403));
  assert.equal((await listReporterTasks(pool, operator)).length, 1);
  assert.deepEqual((await listReporterTasks(pool, { id: 'demo-president' })).map(row => row.id), [saved.id]);
  assert.deepEqual(await listReporterTasks(pool, { id: 'demo-pzo' }), []);
  await assert.rejects(listReporterTasks(pool, { id: 'demo-pzo' }, { project_id: 'demo-res' }), status(403));
  const rawWrite = (sql) => withIdentity(pool, user.id, (client) => client.query(sql, [saved.id]));
  for (const sql of ["UPDATE public.reporter_tasks SET owner_id='demo-other-pm' WHERE id=$1", 'UPDATE public.reporter_tasks SET revision=50 WHERE id=$1', "UPDATE public.reporter_tasks SET history='[]' WHERE id=$1", 'DELETE FROM public.reporter_tasks WHERE id=$1']) {
    // Setting history to its existing empty value is harmless; use a forged
    // entry to ensure the guard is exercised before any legitimate edit.
    await assert.rejects(rawWrite(sql.replace("history='[]'", "history='[{\"forged\":true}]'")), (error) => error.code === '42501');
  }
  await admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'", [user.id]);
  await assert.rejects(listReporterTasks(pool, user, { project_id: 'demo-res' }), status(403));
  await assert.rejects(saveReporterTask(pool, user, matter({ id: saved.id, expected_revision: 1 })), status(403));
  assert.deepEqual(await listReporterTasks(pool, user), []);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT history FROM public.reporter_tasks')).rows[0].history.length, 0);
});

test('leader replacements retain explicit and exact legacy identities, reject foreign ids and never associate by row position', async (t) => {
  const { pool } = await fixture(t);
  const leader = { id: 'demo-ops' };
  const group = { project_id: 'demo-res', period: '2026-10-19~2026-10-25', kind: 'ceo_brief' };
  const first = await replaceLeaderNotes(pool, leader, { ...group, items: [{ what: '安排一', due: '2026-10-30' }, { what: '安排二', due: '' }] });
  const second = await replaceLeaderNotes(pool, leader, { ...group, items: [
    { id: first[1].id, what: '安排二调整', due: '2026-11-01' }, { id: first[0].id, what: '安排一', due: '2026-10-30' }] });
  assert.equal(second[0].id, first[1].id);
  assert.equal(second[1].id, first[0].id);
  const third = await replaceLeaderNotes(pool, leader, { ...group, items: second.map(({ what, due }) => ({ what, due })) });
  assert.deepEqual(third.map((row) => row.id), second.map((row) => row.id));
  const foreign = (await replaceLeaderNotes(pool, leader, { ...group, project_id: 'demo-com', items: [{ what: '其他项目安排', due: '' }] }))[0];
  await assert.rejects(replaceLeaderNotes(pool, leader, { ...group, items: [{ id: foreign.id, what: '越界修改', due: '' }] }), status(400));
  await assert.rejects(replaceLeaderNotes(pool, leader, { ...group, items: [third[0], third[0]] }), status(400));
  const fourth = await replaceLeaderNotes(pool, leader, { ...group, items: [{ what: '旧客户端完全修改的新安排', due: '' }, { id: third[1].id, what: '安排一', due: '2026-10-30' }] });
  assert.notEqual(fourth[0].id, third[0].id);
  assert.equal(fourth[1].id, third[1].id);
  await assert.rejects(replaceLeaderNotes(pool, leader, { ...group, items: [{ id: fourth[0].id, what: '错误日期', due: '2026-02-30' }] }), status(400));
});

test('meeting endpoints use existing authenticated, same-origin sessions and expose no generic table bypass', async (t) => {
  const { pool, accounts } = await fixture(t);
  const app = createApp({ pool, config: { authCodeSecret: 'meeting-isolated-test' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = accounts.find((item) => item.id === operator.id);
  const call = async (route, body, cookie = '', origin = base) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), origin }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await call('/api/reporter-tasks/list', {})).status, 401);
  const login = await call('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 200);
  const saved = await call('/api/reporter-tasks/save', matter(), login.cookie);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.revision, 1);
  assert.equal((await call('/api/reporter-tasks/list', {}, login.cookie)).body.data.length, 1);
  const pmAccount = accounts.find((item) => item.id === user.id);
  const pmLogin = await call('/api/auth/login', { email: pmAccount.email, password: pmAccount.password });
  assert.equal((await call('/api/reporter-tasks/list', {}, pmLogin.cookie)).body.data.length, 1);
  assert.equal((await call('/api/reporter-tasks/save', matter(), pmLogin.cookie)).status, 403);
  assert.equal((await call('/api/reporter-tasks/save', matter(), login.cookie, 'https://other.invalid')).status, 403);
  assert.equal((await call('/api/db', { table: 'reporter_tasks' }, login.cookie)).status, 400);
});

test('report follow-up HTTP writes reject malformed snapshots without modifying the report or its history', async (t) => {
  const { pool, accounts } = await fixture(t);
  const task = await saveReporterTask(pool, operator, matter({ title: '会议反馈', what: '确认验收资料', due: '' }));
  const server = createApp({ pool, config: { authCodeSecret: 'followup-boundary-isolated-test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = accounts.find((item) => item.id === user.id);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function query(body) {
    const response = await fetch(base + '/api/db', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const before = (await query({ table: 'reports', filters: [{ column: 'project_id', value: 'demo-res' }] })).body.data[0];
  const filters = [{ column: 'id', value: before.id }];
  const valid = { source_key: 'meeting:demo-res:' + task.id, source_type: 'meeting', source_id: task.id,
    title: '会议反馈', what: '确认验收资料', progress: '正在处理', due: '', status: 'in_progress', source_revision: task.revision };
  const invalid = [null, {}, [null], [[]], [{ ...valid, source_key: ' ' }], [{ ...valid, source_key: 123 }],
    [{ ...valid, source_key: 'x'.repeat(501) }], [{ ...valid, status: '任意状态' }], [{ ...valid, what: null }],
    [{ ...valid, progress: {} }], [{ ...valid, progress: 'x'.repeat(10001) }], [{ ...valid, what: '无效\u0000字符' }],
    [{ ...valid, source_missing: 'true' }], [{ ...valid, source_revision: 1.5 }], Array.from({ length: 501 }, () => valid)];
  for (const followups of invalid) {
    const result = await query({ table: 'reports', operation: 'update', filters, values: { biz: { ...before.biz, form_version: 2, followups } } });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, 'invalid_followups');
    const unchanged = (await query({ table: 'reports', filters })).body.data[0];
    assert.deepEqual(unchanged, before, 'rejected input must not alter business fields, timestamps, or revision history');
  }
  const rich = format({ 'biz.followups.0.what': delta(valid.what), 'biz.followups.0.progress': delta(valid.progress) });
  const saved = await query({ table: 'reports', operation: 'update', filters, values: { biz: { ...before.biz, form_version: 2, followups: [valid] }, rich_text: rich } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data[0].biz.followups.length, 1);
  const [followup] = saved.body.data[0].biz.followups;
  assert.deepEqual({ ...followup, source_revision: valid.source_revision, source_updated_at: undefined }, { ...valid, source_updated_at: undefined });
  assert.equal(followup.source_revision, task.revision + 1);
  assert.ok(Number.isFinite(Date.parse(followup.source_updated_at)));
  const updatedTask = (await listReporterTasks(pool, user, { id: task.id }))[0];
  assert.equal(updatedTask.progress, valid.progress);
  assert.equal(updatedTask.revision, followup.source_revision);
  assert.deepEqual(updatedTask.rich_text.fields.progress, rich.fields['biz.followups.0.progress']);
  assert.deepEqual(saved.body.data[0].rich_text, rich);
  assert.equal(saved.body.data[0].history.length, before.history.length + 1);
  assert.deepEqual(saved.body.data[0].history.at(-1).data.biz, before.biz);
  const legacy = await query({ table: 'reports', operation: 'update', filters, values: { biz: { retained_legacy_value: '兼容无同步事项的旧结构' } } });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.deepEqual(legacy.body.data[0].biz, { retained_legacy_value: '兼容无同步事项的旧结构' });
});
