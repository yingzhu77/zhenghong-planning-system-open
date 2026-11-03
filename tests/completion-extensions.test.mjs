import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { withIdentity } from '../server/database.mjs';
import { saveReporterTask } from '../server/reporter-tasks.mjs';
import { listCompletions, previewCompletion, requestCompletion, reviewCompletion, withdrawCompletion } from '../server/completions.mjs';

const pm = { id: 'demo-pm-res' }, ops = { id: 'demo-ops' };
const review = row => ({ id: row.id, expected_revision: row.revision, decision: 'approve' });
async function fixture(t) {
  // No .env or live pool: each test owns a disposable, isolated PostgreSQL DB.
  const db = await initializedDatabase(); t.after(() => db.close());
  for (const name of ['013-operator-meetings.sql', '014-completion-extensions.sql']) await db.exec(await readFile(new URL('../db/' + name, import.meta.url), 'utf8'));
  const admin = testPool(db, null); await seedDemo(admin);
  const node = (await admin.query("SELECT id::text AS id FROM public.milestones WHERE project_id='demo-res' AND line='工程' ORDER BY id LIMIT 1")).rows[0];
  await admin.query("UPDATE public.milestones SET forecast_date='2026-10-30' WHERE id=$1", [node.id]);
  const note = (await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,due,author_name) VALUES('demo-res','第43周','ceo_brief','核对匿名专项资料','2026-10-30','匿名领导') RETURNING id")).rows[0];
  const report = (await admin.query("SELECT id::text AS id,biz FROM public.reports WHERE project_id='demo-res' LIMIT 1")).rows[0];
  await admin.query('UPDATE public.reports SET biz=$1 WHERE id=$2', [JSON.stringify({ ...report.biz, items: [{ source_id: 'extension-plan', name: '匿名计划', mod: '工程', due: '2026-10-30', prog: '处理中' }] }), report.id]);
  const pool = testPool(db);
  const meeting = await saveReporterTask(pool, ops, { project_id: 'demo-res', owner_id: pm.id, title: '匿名会议', what: '落实匿名事项', due: '2026-10-30' });
  return { db, admin, pool, node, note, report, meeting, keys: {
    node: 'milestone:demo-res:' + node.id, leader: 'leader:demo-res:' + note.id,
    meeting: 'meeting:demo-res:' + meeting.id, plan: 'plan:demo-res:' + report.id + ':items:extension-plan' } };
}
async function extend(f, key, requested_due = '2026-11-10') {
  const source = await previewCompletion(f.pool, pm, { source_key: key });
  return requestCompletion(f.pool, pm, { source_key: key, source_version: source.source_version,
    request_type: 'extension', requested_due, completion_note: '需要补充核对资料，申请延期' });
}
async function complete(f, key, completion_date = '2026-11-05') {
  const source = await previewCompletion(f.pool, pm, { source_key: key });
  return requestCompletion(f.pool, pm, { source_key: key, source_version: source.source_version, completion_date, completion_note: '已完成并核对资料' });
}

test('approved extensions change execution dates without completing any source or changing original dates', async t => {
  const f = await fixture(t);
  for (const key of Object.values(f.keys)) {
    const initial = await previewCompletion(f.pool, pm, { source_key: key });
    const application = await extend(f, key);
    assert.equal(application.request_type, 'extension'); assert.equal(application.completion_date, null);
    assert.equal(application.effective_due, '2026-10-30');
    await assert.rejects(complete(f, key), e => e.code === 'invalid_transition');
    const approved = await reviewCompletion(f.pool, ops, review(application));
    assert.equal(approved.request_type, 'extension'); assert.equal(approved.status, 'approved');
    const current = await previewCompletion(f.pool, pm, { source_key: key });
    assert.equal(current.effective_due, '2026-11-10'); assert.equal(current.original_due, '2026-10-30');
    assert.equal(current.source_version, initial.source_version);
    assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, false);
    const done = await complete(f, key);
    assert.equal(done.request_type, 'completion'); assert.equal(done.completion_category, 'on_time');
    assert.equal(done.deadline_at_request, '2026-11-10');
    const rows = await listCompletions(f.pool, pm, { source_keys: [key] });
    assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.request_type === 'completion').length, 1);
    if (key !== f.keys.node) await reviewCompletion(f.pool, ops, review(done));
    else {
      await reviewCompletion(f.pool, ops, review(done));
      assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, true);
      await f.admin.query('UPDATE public.milestones SET done=false WHERE id=$1', [f.node.id]);
    }
  }
  assert.equal((await f.admin.query('SELECT due FROM public.leader_notes WHERE id=$1', [f.note.id])).rows[0].due, '2026-10-30');
  assert.equal((await f.admin.query('SELECT forecast_date::text AS date FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].date, '2026-10-30');
});

test('extension audit, withdrawals, source changes and date classification retain separate identities', async t => {
  const f = await fixture(t), key = f.keys.plan;
  await assert.rejects(extend(f, key, '2026-10-29'), e => e.status === 400);
  const withdrawn = await extend(f, key);
  await withdrawCompletion(f.pool, pm, { id: withdrawn.id, expected_revision: withdrawn.revision });
  const first = await extend(f, key);
  assert.notEqual(first.id, withdrawn.id);
  await reviewCompletion(f.pool, ops, review(first));
  const second = await extend(f, key, '2026-11-20');
  await reviewCompletion(f.pool, ops, review(second));
  await f.admin.query("UPDATE public.reports SET biz=jsonb_set(biz,'{items,0,prog}','\"新的进展\"') WHERE id=$1", [f.report.id]);
  assert.equal((await previewCompletion(f.pool, pm, { source_key: key })).effective_due, '2026-11-20');
  const done = await complete(f, key, '2026-11-21');
  assert.equal(done.completion_category, 'late');
  const page = await listCompletions(f.pool, pm, { source_keys: [key], request_type: 'extension' });
  assert.equal(page.length, 3); assert.equal(page.filter(row => row.status === 'approved').length, 2);
  assert.equal(page.filter(row => row.status === 'approved').every(row => !row.source_changed), true);
  const detail = (await listCompletions(f.pool, pm, { id: first.id }))[0];
  assert.equal(detail.history.length, 1); assert.equal(detail.history[0].data.status, 'pending');
  await withdrawCompletion(f.pool, pm, { id: done.id, expected_revision: done.revision });
  await f.admin.query("UPDATE public.reports SET biz=jsonb_set(biz,'{items,0,name}','\"变更后的计划内容\"') WHERE id=$1", [f.report.id]);
  assert.equal((await previewCompletion(f.pool, pm, { source_key: key })).effective_due, '2026-10-30');
  assert.equal((await listCompletions(f.pool, pm, { id: first.id }))[0].source_changed, true);
});

test('only ops approve extensions; stale versions, cross-project owners and direct type rewrites are rejected', async t => {
  const f = await fixture(t), row = await extend(f, f.keys.leader);
  await assert.rejects(reviewCompletion(f.pool, pm, review(row)), e => e.status === 403);
  await assert.rejects(previewCompletion(f.pool, { id: 'demo-pm-com' }, { source_key: f.keys.leader }), e => e.status === 403);
  await assert.rejects(withIdentity(f.pool, pm.id, client => client.query("UPDATE public.completion_requests SET status='approved' WHERE id=$1", [row.id])), e => e.code === '42501');
  await assert.rejects(withIdentity(f.pool, pm.id, client => client.query("UPDATE public.completion_requests SET request_type='completion',completion_date='2026-10-30',requested_due=NULL,status='withdrawn' WHERE id=$1", [row.id])), e => e.code === '42501');
  const approved = await reviewCompletion(f.pool, ops, review(row));
  await assert.rejects(reviewCompletion(f.pool, ops, { ...review(approved), decision: 'reopen', note: '直接重开' }), e => e.code === 'invalid_transition');
  await assert.rejects(reviewCompletion(f.pool, ops, review(row)), e => e.code === 'revision_conflict');
  await f.db.exec('RESET ROLE');
  const sql = await readFile(new URL('../db/014-completion-extensions.sql', import.meta.url), 'utf8');
  await f.db.exec(sql); await f.db.exec(sql);
  assert.equal((await previewCompletion(f.pool, pm, { source_key: f.keys.leader })).effective_due, '2026-11-10');
  assert.equal((await listCompletions(f.pool, pm, { id: row.id }))[0].history.length, 1);
});

test('named coordination recipients use exact identity while preserving the original author scope', async t => {
  const f = await fixture(t), recipient = { id: 'named-coordination-recipient' };
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,'匿名协调承办人','pm','approved','工程')", [recipient.id]);
  await f.admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,'named-coordination-recipient@example.invalid','isolated-unused-auth-value')", [recipient.id]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')", [recipient.id]);
  const author = (await f.admin.query('SELECT name FROM public.profiles WHERE user_id=$1', [pm.id])).rows[0];
  const items = [{ source_id: 'named-coord', who_id: recipient.id, who: author.name, what: '请' + author.name + '协助工程资料', by: '2026-10-30' },
    { source_id: 'legacy-coord', who: author.name, what: '旧版协调事项', by: '2026-10-30' }];
  await f.admin.query('UPDATE public.reports SET coord_items=$1 WHERE id=$2', [JSON.stringify(items), f.report.id]);
  const key = 'coord:demo-res:' + f.report.id + ':coord:named-coord';
  assert.equal((await previewCompletion(f.pool, pm, { source_key: key })).who_id, recipient.id);
  const source = await previewCompletion(f.pool, recipient, { source_key: key });
  assert.equal(source.who_id, recipient.id);
  const pending = await requestCompletion(f.pool, recipient, { source_key: key, source_version: source.source_version,
    request_type: 'extension', requested_due: '2026-11-10', completion_note: '匿名协调延期' });
  await assert.rejects(reviewCompletion(f.pool, ops, review(pending)), e => e.status === 403);
  await reviewCompletion(f.pool, pm, review(pending));
  const authorExtension = await extend(f, key, '2026-11-12');
  await assert.rejects(reviewCompletion(f.pool, ops, review(authorExtension)), e => e.status === 403);
  await reviewCompletion(f.pool, pm, review(authorExtension));
  assert.equal((await previewCompletion(f.pool, pm, { source_key: key })).effective_due, '2026-11-12');
  items[0].who_id = pm.id;
  await f.admin.query('UPDATE public.reports SET coord_items=$1 WHERE id=$2', [JSON.stringify(items), f.report.id]);
  await assert.rejects(previewCompletion(f.pool, recipient, { source_key: key }), e => e.status === 403);
  const reassigned = await previewCompletion(f.pool, pm, { source_key: key });
  assert.equal(reassigned.effective_due, '2026-10-30'); assert.notEqual(reassigned.source_version, source.source_version);
  assert.equal((await listCompletions(f.pool, pm, { id: authorExtension.id }))[0].source_changed, true);
  for (const invalidId of ['', null, 17, {}]) {
    items[0].who_id = invalidId;
    items[0].who = '匿名协调承办人'; items[0].what = '请匿名协调承办人协助工程资料';
    await f.admin.query('UPDATE public.reports SET coord_items=$1 WHERE id=$2', [JSON.stringify(items), f.report.id]);
    await assert.rejects(previewCompletion(f.pool, recipient, { source_key: key }), e => e.status === 403);
  }
  const legacy = await previewCompletion(f.pool, pm, { source_key: 'coord:demo-res:' + f.report.id + ':coord:legacy-coord' });
  assert.equal(Object.hasOwn(legacy, 'who_id'), false);
});
