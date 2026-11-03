import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { withIdentity } from '../server/database.mjs';
import { assignLeaderRequirement, listReporterTasks, saveReporterTask } from '../server/reporter-tasks.mjs';

const migration = await readFile(new URL('../db/019-meeting-categories.sql', import.meta.url), 'utf8');
const ops = { id: 'demo-ops' }, president = { id: 'demo-president' }, pzo = { id: 'demo-pzo' }, pm = { id: 'demo-pm-res' };
const status = expected => error => error.status === expected;
const matter = extra => ({ project_id: 'demo-res', owner_id: pm.id, title: '明确责任人', what: '确认本周事项', due: '2026-10-30', ...extra });
async function fixture(t) {
  const db = await initializedDatabase({ through: 18 }); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await seedDemo(admin);
  return { db, admin, pool, apply: () => db.exec(migration) };
}

test('019 preserves existing matter identities and audit history, and repeated application does not classify legacy rows', async t => {
  const { db, admin, apply } = await fixture(t);
  const id = '11000000-0000-4000-8000-000000000001';
  await admin.query('INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,title,what) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, 'demo-res', pm.id, '原责任人', '原会议', '原事项']);
  const before = (await admin.query('SELECT to_jsonb(t) AS row FROM public.reporter_tasks t WHERE id=$1', [id])).rows[0].row;
  await apply(); await apply();
  const after = (await admin.query('SELECT to_jsonb(t) AS row FROM public.reporter_tasks t WHERE id=$1', [id])).rows[0].row;
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
  assert.equal(after.meeting_kind, 'legacy'); assert.equal(after.proposer_id, null);
  const audit = (await admin.query('SELECT revision,history FROM public.reporter_tasks WHERE id=$1', [id])).rows[0];
  assert.equal(audit.revision, before.revision); assert.deepEqual(audit.history, before.history);
  await db.exec('RESET ROLE');
});

test('leaders record only their requirements; operators enter decisions and record the actual proposer separately', async t => {
  const { pool, apply } = await fixture(t); await apply();
  const requirement = await saveReporterTask(pool, president, matter({ meeting_kind: 'requirement' }));
  assert.equal(requirement.proposer_id, president.id); assert.equal(requirement.proposer_role, 'president');
  assert.equal(requirement.proposer_name, '演示总裁'); assert.equal(requirement.created_by, president.id);
  const delegated = await saveReporterTask(pool, ops, matter({ meeting_kind: 'requirement', proposer_id: president.id }));
  assert.equal(delegated.created_by, ops.id); assert.equal(delegated.proposer_id, president.id);
  const special = await saveReporterTask(pool, ops, matter({ meeting_kind: 'special' }));
  assert.equal(special.meeting_kind, 'special'); assert.equal(special.proposer_id, null);
  await assert.rejects(saveReporterTask(pool, president, matter({ meeting_kind: 'special' })), status(403));
  await assert.rejects(saveReporterTask(pool, president, matter({ meeting_kind: 'requirement', proposer_id: pzo.id })), status(403));
  await assert.rejects(saveReporterTask(pool, ops, matter({ meeting_kind: 'requirement' })), status(400));
  await assert.rejects(saveReporterTask(pool, pzo, matter({ meeting_kind: 'requirement' })), status(403));
  assert.equal((await listReporterTasks(pool, president, { project_id: 'demo-res', meeting_kind: 'requirement' })).length, 2);
  const feedback = await saveReporterTask(pool, pm, { id: requirement.id, project_id: 'demo-res', expected_revision: requirement.revision, progress: '当周已反馈', status: 'in_progress' });
  assert.equal(feedback.progress, '当周已反馈'); assert.equal(feedback.proposer_name, requirement.proposer_name);
  await assert.rejects(saveReporterTask(pool, pm, { id: requirement.id, project_id: 'demo-res', expected_revision: feedback.revision, meeting_kind: 'special' }), status(403));
  await assert.rejects(saveReporterTask(pool, pm, { id: requirement.id, project_id: 'demo-res', expected_revision: feedback.revision, status: 'completed' }), status(400));
  await assert.rejects(withIdentity(pool, president.id, client => client.query("UPDATE public.reporter_tasks SET proposer_name='伪造提出人' WHERE id=$1", [requirement.id])), error => error.code === '42501');
});

test('assigning an existing leadership note preserves source and content, records ownership audit and rejects stale or forged assignment', async t => {
  const { pool, admin, apply } = await fixture(t); await apply();
  const note = (await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,due,author_name) VALUES ('demo-res','2026-10-19','ceo_brief','必须保留的历史要求','2026-10-30','原提出人') RETURNING *")).rows[0];
  const assigned = await assignLeaderRequirement(pool, ops, { id: note.id, project_id: 'demo-res', owner_id: pm.id, expected_owner_id: null });
  assert.equal(assigned.id, note.id); assert.equal(assigned.what, note.what); assert.equal(assigned.author_name, note.author_name);
  assert.equal(assigned.owner_id, pm.id); assert.equal(assigned.assignment_history.length, 1);
  assert.equal(assigned.assignment_history[0].by, ops.id);
  await assert.rejects(assignLeaderRequirement(pool, ops, { id: note.id, project_id: 'demo-res', owner_id: pm.id, expected_owner_id: null }), status(409));
  await assert.rejects(assignLeaderRequirement(pool, president, { id: note.id, project_id: 'demo-res', owner_id: pm.id, expected_owner_id: pm.id }), status(403));
  await assert.rejects(withIdentity(pool, president.id, client => client.query('UPDATE public.leader_notes SET owner_id=NULL WHERE id=$1', [note.id])), error => error.code === '42501');
  await withIdentity(pool, president.id, client => client.query('UPDATE public.leader_notes SET what=$1 WHERE id=$2', ['领导仍可编辑本人职责范围要求', note.id]));
  const edited = (await admin.query('SELECT * FROM public.leader_notes WHERE id=$1', [note.id])).rows[0];
  assert.equal(edited.owner_id, pm.id); assert.equal(edited.assignment_history.length, 1);
});
