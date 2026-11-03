import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { saveReporterTask } from '../server/reporter-tasks.mjs';
import { listCompletions, previewCompletion, requestCompletion, reviewCompletion, withdrawCompletion } from '../server/completions.mjs';

const pm = { id: 'demo-pm-res' }, other = { id: 'completion-other-pm' }, ops = { id: 'demo-ops' };
const status = (value) => (error) => error.status === value;
const approval = (row, decision = 'approve', note = '') => ({ id: row.id, expected_revision: row.revision, decision, note });
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  for (const name of ['013-operator-meetings.sql', '014-completion-extensions.sql']) await db.exec(await readFile(new URL('../db/' + name, import.meta.url), 'utf8'));
  const admin = testPool(db, null); await seedDemo(admin);
  // This fixture explicitly assigns the residential review scope as well as
  // the commercial primary project supplied by the anonymous seed.
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pzo','demo-res')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,'同项目匿名经理','pm','approved','工程')", [other.id]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')", [other.id]);
  const node = (await admin.query("SELECT id::text AS id FROM public.milestones WHERE project_id='demo-res' AND line='工程' ORDER BY id LIMIT 1")).rows[0];
  const report = (await admin.query("SELECT id::text AS id,biz FROM public.reports WHERE project_id='demo-res' LIMIT 1")).rows[0];
  const note = (await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,due,author_name) VALUES('demo-res','第43周','ceo_brief','核对验收资料','2026-10-30','匿名领导') RETURNING id")).rows[0];
  const pool = testPool(db);
  const meeting = await saveReporterTask(pool, ops, { project_id: 'demo-res', owner_id: pm.id, title: '匿名例会', what: '落实会议要求', due: '', status: 'open', progress: '' });
  const biz = { ...(report.biz || {}), nodes: [{ source_id: 'node-stable-id', name: '本月节点', plan: '2026-10-30', prog: '处理中' }],
    items: [{ source_id: 'item-stable-id', mod: '工程', name: '自建计划事项', due: '2026-10-30', prog: '处理中' }],
    handover: [{ source_id: 'handover-stable-id', what: '移交工作面', to: '同项目匿名经理', due: '' }] };
  await admin.query('UPDATE public.reports SET biz=$1,coord_items=$2 WHERE id=$3', [JSON.stringify(biz), JSON.stringify([{ source_id: 'coord-stable-id', who: '同项目匿名经理', what: '协调专项资料', by: '' }]), report.id]);
  return { db, admin, pool, node, report, meeting, keys: { node: 'milestone:demo-res:' + node.id,
    leader: 'leader:demo-res:' + note.id, meeting: 'meeting:demo-res:' + meeting.id,
    coord: 'coord:demo-res:' + report.id + ':coord:coord-stable-id', handover: 'coord:demo-res:' + report.id + ':handover:handover-stable-id',
    planNode: 'plan:demo-res:' + report.id + ':nodes:node-stable-id', plan: 'plan:demo-res:' + report.id + ':items:item-stable-id' } };
}
async function apply(f, key, user = pm, extra = {}) {
  const preview = await previewCompletion(f.pool, user, { source_key: key });
  return requestCompletion(f.pool, user, { source_key: key, source_version: preview.source_version, completion_date: '2026-10-20', completion_note: '完成结果说明', ...extra });
}

test('completion migration is repeatable and preserves original reports, users and legacy completion flags', async (t) => {
  const f = await fixture(t);
  const row = await apply(f, f.keys.leader);
  await f.db.exec('RESET ROLE');
  const snapshot = async () => (await f.db.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM public.profiles p),'nodes',(SELECT jsonb_agg(to_jsonb(m)) FROM public.milestones m),'requests',(SELECT jsonb_agg(to_jsonb(c)) FROM public.completion_requests c)) AS data")).rows[0].data;
  const before = await snapshot(), sql = await readFile(new URL('../db/007-completion-review.sql', import.meta.url), 'utf8');
  await f.db.exec(sql); await f.db.exec(sql);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.requests[0].id, row.id);
});

test('all actual source kinds resolve server content with owner, project and directed-recipient boundaries', async (t) => {
  const f = await fixture(t);
  for (const key of Object.values(f.keys)) {
    const preview = await previewCompletion(f.pool, pm, { source_key: key });
    assert.match(preview.source_version, /^[a-f0-9]{64}$/);
    const row = await apply(f, key);
    assert.equal(row.owner_id, pm.id); assert.equal(row.what, preview.what);
    assert.equal(row.source_snapshot.what, preview.what); assert.equal(row.status, 'pending');
  }
  assert.equal((await apply(f, f.keys.coord, other)).owner_id, other.id);
  assert.equal((await apply(f, f.keys.handover, other)).owner_id, other.id);
  await assert.rejects(previewCompletion(f.pool, other, { source_key: f.keys.plan }), status(403));
  await assert.rejects(previewCompletion(f.pool, other, { source_key: f.keys.meeting }), status(404));
  await assert.rejects(previewCompletion(f.pool, { id: 'demo-pm-com' }, { source_key: f.keys.node }), status(403));
  assert.equal((await listCompletions(f.pool, other)).length, 2);
  assert.equal((await listCompletions(f.pool, { id: 'demo-pm-com' })).length, 0);
});

test('ops alone review; rejected and withdrawn requests resubmit with immutable applicant snapshots and history', async (t) => {
  const f = await fixture(t), original = await apply(f, f.keys.leader);
  for (const user of [pm, { id: 'demo-president' }, { id: 'demo-pzo' }]) await assert.rejects(reviewCompletion(f.pool, user, approval(original)), status(403));
  const rejected = await reviewCompletion(f.pool, ops, approval(original, 'reject', '请补充完成结果'));
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reviewer_id, ops.id); assert.equal(rejected.revision, 2);
  const repeated = await apply(f, f.keys.leader, pm, { expected_revision: rejected.revision, completion_note: '已补充结果' });
  assert.equal(repeated.id, original.id); assert.equal(repeated.status, 'pending'); assert.equal(repeated.reviewer_id, null);
  const withdrawn = await withdrawCompletion(f.pool, pm, { id: repeated.id, expected_revision: repeated.revision });
  assert.equal(withdrawn.status, 'withdrawn');
  const again = await apply(f, f.keys.leader, pm, { expected_revision: withdrawn.revision });
  const approved = await reviewCompletion(f.pool, ops, approval(again));
  assert.equal(approved.status, 'approved'); assert.ok(approved.approved_at);
  const detail = (await listCompletions(f.pool, pm, { id: original.id }))[0];
  assert.equal(detail.history.length, 5);
  assert.equal(detail.history[0].data.completion_note, '完成结果说明');
  assert.equal(detail.history[1].data.review_note, '请补充完成结果');
  assert.equal(detail.history.every((entry) => !Object.hasOwn(entry.data, 'history')), true);
  for (const user of [{ id: 'demo-president' }, { id: 'demo-pzo' }]) assert.equal((await listCompletions(f.pool, user, { id: original.id }))[0].status, 'approved');
  await assert.rejects(reviewCompletion(f.pool, ops, approval(approved, 'reopen')), status(400));
});

test('stale preview and review conflict retain pending records, and approved changed sources are no longer effective approvals', async (t) => {
  const f = await fixture(t), preview = await previewCompletion(f.pool, pm, { source_key: f.keys.leader });
  await f.admin.query("UPDATE public.leader_notes SET what='变更后的要求' WHERE id=$1", [f.keys.leader.split(':').at(-1)]);
  await assert.rejects(requestCompletion(f.pool, pm, { source_key: f.keys.leader, source_version: preview.source_version, completion_date: '2026-10-20', completion_note: '完成' }), (e) => e.code === 'source_changed');
  assert.equal((await listCompletions(f.pool, pm)).length, 0);
  const pending = await apply(f, f.keys.leader);
  await f.admin.query("UPDATE public.leader_notes SET what='再次变更要求' WHERE id=$1", [f.keys.leader.split(':').at(-1)]);
  await assert.rejects(reviewCompletion(f.pool, ops, approval(pending)), (e) => e.status === 409 && e.code === 'source_changed');
  let detail = (await listCompletions(f.pool, pm, { id: pending.id }))[0];
  assert.equal(detail.status, 'pending'); assert.equal(detail.history.length, 0); assert.equal(detail.source_changed, true);
  const rejected = await reviewCompletion(f.pool, ops, approval(pending, 'reject', '原要求变更，退回核对'));
  const next = await apply(f, f.keys.leader, pm, { expected_revision: rejected.revision });
  const approved = await reviewCompletion(f.pool, ops, approval(next));
  await f.admin.query("UPDATE public.leader_notes SET due='2026-11-30' WHERE id=$1", [f.keys.leader.split(':').at(-1)]);
  detail = (await listCompletions(f.pool, pm, { id: approved.id }))[0];
  assert.equal(detail.status, 'approved'); assert.equal(detail.effective_status, 'source_changed');
  await f.admin.query('DELETE FROM public.leader_notes WHERE id=$1', [f.keys.leader.split(':').at(-1)]);
  detail = (await listCompletions(f.pool, pm, { id: approved.id }))[0];
  assert.equal(detail.source_missing, true); assert.equal(detail.effective_status, 'source_missing');
});

test('node approvals are per owner while ops reopening updates every approved owner and the global done flag atomically', async (t) => {
  const f = await fixture(t), a = await apply(f, f.keys.node), b = await apply(f, f.keys.node, other);
  const approvedA = await reviewCompletion(f.pool, ops, approval(a));
  assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, true);
  const approvedB = await reviewCompletion(f.pool, ops, approval(b));
  assert.equal(approvedB.status, 'approved'); assert.equal(approvedB.source_changed, false);
  const waitingOwner = { id: 'completion-waiting-pm' };
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,'待审匿名经理','pm','approved','工程')", [waitingOwner.id]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')", [waitingOwner.id]);
  const waiting = await apply(f, f.keys.node, waitingOwner);
  const reopened = await reviewCompletion(f.pool, ops, approval(approvedA, 'reopen', '验收标准变化，需要重新核对'));
  assert.equal(reopened.status, 'reopened'); assert.equal(reopened.reopened_count, 2);
  assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, false);
  const second = (await listCompletions(f.pool, other, { id: b.id }))[0];
  assert.equal(second.status, 'reopened'); assert.equal(second.history.length, 2);
  assert.equal(second.history[1].data.status, 'approved');
  const stillWaiting = (await listCompletions(f.pool, waitingOwner, { id: waiting.id }))[0];
  assert.equal(stillWaiting.status, 'pending'); assert.equal(stillWaiting.revision, waiting.revision);
  assert.equal(stillWaiting.history.length, 0);
  const pending = await apply(f, f.keys.node, other, { expected_revision: second.revision });
  const rejected = await reviewCompletion(f.pool, ops, approval(pending, 'reject', '尚未达到节点标准'));
  assert.equal(rejected.status, 'rejected');
  assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, false);
});

test('legacy done is not fabricated as approval and rejecting another owner does not clear an approved global node', async (t) => {
  const f = await fixture(t);
  await f.admin.query('UPDATE public.milestones SET done=true WHERE id=$1', [f.node.id]);
  assert.equal((await previewCompletion(f.pool, pm, { source_key: f.keys.node })).legacy_completed, true);
  await assert.rejects(apply(f, f.keys.node), (e) => e.code === 'legacy_completed');
  assert.equal((await listCompletions(f.pool, pm)).length, 0);
  await f.admin.query('UPDATE public.milestones SET done=false WHERE id=$1', [f.node.id]);
  const a = await apply(f, f.keys.node), b = await apply(f, f.keys.node, other);
  await reviewCompletion(f.pool, ops, approval(a));
  await reviewCompletion(f.pool, ops, approval(b, 'reject', '此承办人的证据不足'));
  assert.equal((await f.admin.query('SELECT done FROM public.milestones WHERE id=$1', [f.node.id])).rows[0].done, true);
});

test('database RLS and audit guard reject direct approval, identity forgery, history rewriting and unauthorized meeting helpers', async (t) => {
  const f = await fixture(t), row = await apply(f, f.keys.meeting);
  const raw = (user, sql, values = [row.id]) => withIdentity(f.pool, user.id, (client) => client.query(sql, values));
  for (const sql of ["UPDATE public.completion_requests SET status='approved' WHERE id=$1", "UPDATE public.completion_requests SET history='[{\"forged\":true}]' WHERE id=$1", 'UPDATE public.completion_requests SET revision=90 WHERE id=$1', 'DELETE FROM public.completion_requests WHERE id=$1']) await assert.rejects(raw(pm, sql), (e) => e.code === '42501');
  await assert.rejects(raw(ops, "UPDATE public.completion_requests SET owner_id='completion-other-pm',status='approved' WHERE id=$1"), (e) => e.code === '42501');
  assert.deepEqual((await raw(other, 'SELECT * FROM public.completion_requests WHERE id=$1')).rows, []);
  assert.deepEqual((await raw(pm, 'SELECT * FROM app_private.completion_meeting_source($1,$2,$3)', ['demo-res', f.meeting.id, pm.id])).rows, []);
  const untouched = await saveReporterTask(f.pool, ops, { project_id: 'demo-res', owner_id: pm.id, title: '未申报会议', what: '私人工作事项', due: '', status: 'open', progress: '' });
  assert.deepEqual((await raw(ops, 'SELECT * FROM app_private.completion_meeting_source($1,$2,$3)', ['demo-res', untouched.id, pm.id])).rows, []);
  await assert.rejects(raw({ id: 'demo-president' }, 'SELECT app_private.lock_completion_source($1)'), (e) => e.code === '42501');
  const approved = await reviewCompletion(f.pool, ops, approval(row)); assert.equal(approved.status, 'approved');
  await f.admin.query("DELETE FROM public.project_members WHERE project_id='demo-res' AND user_id=$1", [pm.id]);
  assert.equal((await listCompletions(f.pool, pm)).length, 0);
  await assert.rejects(previewCompletion(f.pool, pm, { source_key: f.keys.meeting }), status(403));
});

test('pagination retains timestamp microseconds, source filters and scoped history without silently treating a page as complete', async (t) => {
  const f = await fixture(t);
  const a = await apply(f, f.keys.leader), b = await apply(f, f.keys.meeting), c = await apply(f, f.keys.plan);
  // Administrator-only fixture timestamp changes let all three records share
  // one JS millisecond, reproducing a real PostgreSQL cursor edge case.
  await f.admin.query('ALTER TABLE public.completion_requests DISABLE TRIGGER guard_completion_request');
  for (const [row, micro] of [[a, '123456'], [b, '123457'], [c, '123458']]) await f.admin.query('UPDATE public.completion_requests SET created_at=$1 WHERE id=$2', ['2026-10-20 08:00:00.' + micro + '+00', row.id]);
  await f.admin.query('ALTER TABLE public.completion_requests ENABLE TRIGGER guard_completion_request');
  let page = await listCompletions(f.pool, pm, { limit: 1 }), ids = [];
  while (true) { assert.equal(Object.hasOwn(page[0], 'history'), false); ids.push(page[0].id); if (!page.meta.has_more) break; page = await listCompletions(f.pool, pm, { limit: 1, cursor: page.meta.next_cursor }); }
  assert.deepEqual(ids, [c.id, b.id, a.id]);
  assert.equal((await listCompletions(f.pool, pm, { source_keys: [f.keys.meeting] })).length, 1);
  assert.equal((await listCompletions(f.pool, ops)).length, 3);
  await reviewCompletion(f.pool, ops, approval(a));
  assert.equal((await listCompletions(f.pool, ops)).length, 2);
  assert.equal((await listCompletions(f.pool, ops, { status: 'approved' })).length, 1);
  await assert.rejects(listCompletions(f.pool, pm, { cursor: 'invalid' }), status(400));
  await assert.rejects(listCompletions(f.pool, pm, { project_id: 'demo-com' }), status(403));
});

test('concurrent review and stale revisions cannot overwrite decisions or accept browser-supplied identities', async (t) => {
  const f = await fixture(t), row = await apply(f, f.keys.leader);
  const results = await Promise.allSettled([reviewCompletion(f.pool, ops, approval(row)), reviewCompletion(f.pool, ops, approval(row, 'reject', '并行退回'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'revision_conflict');
  const detail = (await listCompletions(f.pool, pm, { id: row.id }))[0]; assert.equal(detail.history.length, 1);
  const preview = await previewCompletion(f.pool, pm, { source_key: f.keys.plan });
  for (const extra of [{ owner_id: other.id }, { status: 'approved' }, { completion_date: '2026-02-30' }, { source_version: 'forged' }]) await assert.rejects(requestCompletion(f.pool, pm, { source_key: f.keys.plan, source_version: preview.source_version, completion_date: '2026-10-20', completion_note: '完成说明', ...extra }), status(400));
  await assert.rejects(executeDatabase(f.pool, pm, { table: 'completion_requests' }), status(400));
});

test('UUID source-key case variants share one applicant identity and remain visible to the reviewer', async (t) => {
  const f = await fixture(t);
  for (const key of [f.keys.meeting, f.keys.leader]) {
    const parts = key.split(':'), variant = [parts[0], parts[1], parts[2].toUpperCase()].join(':');
    const row = await apply(f, variant);
    assert.equal(row.source_key, key);
    await assert.rejects(apply(f, key), (e) => e.status === 409 && e.code === 'invalid_transition');
    assert.equal((await listCompletions(f.pool, pm, { source_keys: [variant] })).length, 1);
    assert.equal((await reviewCompletion(f.pool, ops, approval(row))).status, 'approved');
  }
  assert.equal((await listCompletions(f.pool, pm)).length, 2);
});
