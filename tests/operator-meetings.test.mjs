import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listProjectPeople, listReporterTasks, saveReporterTask } from '../server/reporter-tasks.mjs';
import { withIdentity } from '../server/database.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const ops = { id: 'demo-ops' }, pm = { id: 'demo-pm-res' };
const matter = (extra = {}) => ({ project_id: 'demo-res', owner_id: pm.id, title: '会议验收事项', what: '确认材料并反馈', due: '2026-11-02', ...extra });
const denied = (status) => (error) => error.status === status;
const migration = await readFile(new URL('../db/013-operator-meetings.sql', import.meta.url), 'utf8');
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await seedDemo(admin); await db.exec('RESET ROLE'); await db.exec(migration);
  return { db, admin, pool };
}

test('operator assigns one project reporter; reporter maintains progress without rewriting source or approval', async (t) => {
  const { pool } = await fixture(t);
  await assert.rejects(saveReporterTask(pool, pm, matter()), denied(403));
  const task = await saveReporterTask(pool, ops, matter({ rich_text: { v: 1, fields: { what: { ops: [{ insert: '确认材料并反馈', attributes: { bold: true } }] } } } }));
  assert.equal(task.owner_id, pm.id); assert.equal(task.created_by, ops.id);
  assert.equal((await listReporterTasks(pool, ops)).length, 1);
  assert.equal((await listReporterTasks(pool, pm)).length, 1);
  assert.deepEqual(await listReporterTasks(pool, { id: 'demo-pm-com' }), []);
  const progress = await saveReporterTask(pool, pm, { id: task.id, project_id: task.project_id, expected_revision: 1, progress: '正在整理', status: 'in_progress', rich_text: {} });
  assert.equal(progress.revision, 2); assert.deepEqual(progress.rich_text, task.rich_text);
  for (const patch of [{ title: '修改主题' }, { what: '修改内容' }, { due: '2026-12-01' }, { owner_id: 'demo-pm-com' }]) {
    await assert.rejects(saveReporterTask(pool, pm, { id: task.id, project_id: task.project_id, expected_revision: 2, ...patch }), denied(403));
  }
  await assert.rejects(saveReporterTask(pool, pm, { id: task.id, project_id: task.project_id, expected_revision: 2, status: 'completed' }), denied(400));
  await assert.rejects(saveReporterTask(pool, ops, matter({ id: task.id, expected_revision: 1 })), denied(409));
  await assert.rejects(saveReporterTask(pool, ops, matter({ owner_id: 'demo-pm-com' })), denied(400));
  const changed = await saveReporterTask(pool, ops, matter({ id: task.id, expected_revision: 2, what: '运营补充内容' }));
  assert.equal(changed.revision, 3); assert.equal(changed.progress, '正在整理');
  const history = (await listReporterTasks(pool, ops, { id: task.id }))[0].history;
  assert.equal(history.length, 2); assert.equal(history[1].data.what, '确认材料并反馈');
});

test('project people include authorized real identities only and reassignments retain audit while clearing prior progress', async (t) => {
  const { pool, admin } = await fixture(t);
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES ('same-project','另一填报人','pm','approved'),('archived-person','旧档案','pm','approved'),('disabled-person','停用人员','pm','approved')");
  await admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash,disabled) VALUES ('same-project','same@example.invalid','isolated-test',false),('disabled-person','disabled@example.invalid','isolated-test',true)");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES ('same-project','demo-res'),('archived-person','demo-res'),('disabled-person','demo-res')");
  const people = await listProjectPeople(pool, pm, { project_id: 'demo-res' });
  assert.deepEqual(people.map((p) => p.user_id).sort(), ['demo-ops', pm.id, 'demo-president', 'same-project'].sort());
  assert.deepEqual(Object.keys(people[0]).sort(), ['user_id', 'name', 'role', 'biz_line', 'discipline'].sort());
  await assert.rejects(listProjectPeople(pool, pm, { project_id: 'demo-com' }), denied(403));
  assert.ok((await listProjectPeople(pool, { id: 'demo-pzo' }, { project_id: 'demo-com' })).some((p) => p.user_id === 'demo-pzo'));
  await assert.rejects(listProjectPeople(pool, { id: 'demo-pzo' }, { project_id: 'demo-res' }), denied(403));
  const task = await saveReporterTask(pool, ops, matter({ progress: '旧承办人的进展', status: 'in_progress' }));
  const moved = await saveReporterTask(pool, ops, matter({ id: task.id, expected_revision: 1, owner_id: 'same-project', progress: '不应带给新承办人' }));
  assert.equal(moved.status, 'open'); assert.equal(moved.progress, ''); assert.equal(moved.owner_name, '另一填报人');
  assert.deepEqual(await listReporterTasks(pool, pm), []);
  assert.equal((await listReporterTasks(pool, { id: 'same-project' })).length, 1);
  const history = (await listReporterTasks(pool, ops, { id: task.id }))[0].history;
  assert.equal(history[0].data.owner_id, pm.id); assert.equal(history[0].data.progress, '旧承办人的进展');
});

test('migration is repeatable and raw runtime writes cannot bypass operator or source/audit boundaries', async (t) => {
  const { db, pool } = await fixture(t);
  const task = await saveReporterTask(pool, ops, matter());
  const raw = (user, sql, values = [task.id]) => withIdentity(pool, user.id, (client) => client.query(sql, values));
  for (const sql of ["UPDATE public.reporter_tasks SET what='forged' WHERE id=$1", "UPDATE public.reporter_tasks SET due='2026-12-31' WHERE id=$1", "UPDATE public.reporter_tasks SET status='completed' WHERE id=$1", "UPDATE public.reporter_tasks SET history='[{\"forged\":true}]' WHERE id=$1", "UPDATE public.reporter_tasks SET created_by='demo-president' WHERE id=$1"]) {
    await assert.rejects(raw(pm, sql), (error) => error.code === '42501');
  }
  await assert.rejects(raw(pm, "INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,title,what) VALUES($1,'demo-res','demo-pm-res','伪造','主题','内容')", ['d56e32c0-912e-4042-a182-465eb5309d02']), (error) => error.code === '42501');
  await db.exec('RESET ROLE');
  const before = (await db.query('SELECT to_jsonb(t) AS task FROM public.reporter_tasks t')).rows;
  await db.exec(migration); await db.exec(migration);
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS task FROM public.reporter_tasks t')).rows, before);
  assert.equal((await listReporterTasks(pool, ops, { id: task.id }))[0].history.length, 0);
});
