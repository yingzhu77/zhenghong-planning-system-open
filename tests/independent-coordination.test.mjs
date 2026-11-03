import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { withIdentity } from '../server/database.mjs';
import { createCoordinationTask, listCoordinationTasks } from '../server/coordination-tasks.mjs';
import { resolveCompletionSource } from '../server/completion-sources.mjs';
import { previewCompletion, requestCompletion, listCompletions, reviewCompletion } from '../server/completions.mjs';
import { completionStatistics } from '../server/completion-statistics.mjs';

const origin = { id: 'independent-origin' }, owner = { id: 'independent-owner' }, other = { id: 'independent-other' }, ops = { id: 'independent-ops' };
const migration = await readFile(new URL('../db/017-independent-coordination.sql', import.meta.url), 'utf8');
const review = (row, decision = 'approve', note = '') => ({ id: row.id, expected_revision: row.revision, decision, note });
async function fixture(t) {
  // Explicit, empty, anonymous DB. No live config, SMTP, files or user sessions.
  const db = await initializedDatabase(); t.after(() => db.close());
  await db.exec(migration);
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('independent-res','匿名住宅','res'),('independent-com','匿名商业','com'),('independent-private','未授权项目','res')");
  for (const [id, name, role, primary, line] of [
    [origin.id, '匿名协调发起人', 'pm', null, '土建工程（东地块）'],
    [owner.id, '匿名协调承办人', 'pm', null, '土建工程（西地块）'],
    [other.id, '其他同项目人员', 'pm', null, '机电工程'],
    [ops.id, '匿名运营', 'ops', null, null],
    ['independent-president', '匿名总裁', 'president', null, null],
    ['independent-pzo', '匿名项目总', 'pzo', 'independent-res', null],
    ['independent-outsider', '其他项目人员', 'pm', null, null],
    ['independent-disabled', '停用人员', 'pm', null, null]
  ]) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,disabled) VALUES($1,$2,$3,$4)', [id, id + '@example.invalid', 'isolated-unused-auth-value', id === 'independent-disabled']);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline,biz_line) VALUES($1,$2,$3,'approved',$4,'工程',$5)", [id, name, role, primary, line]);
    if (role === 'pm') {
      const projects = id === 'independent-outsider' ? ['independent-private'] : ['independent-res', 'independent-com'];
      for (const pid of projects) await admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)', [id, pid]);
    }
  }
  const create = (project_id = 'independent-res', extra = {}, caller = origin) => createCoordinationTask(pool, caller, {
    id: randomUUID(), project_id, owner_id: owner.id, what: '请核对匿名专项资料', due: '2026-10-25', ...extra
  });
  return { db, admin, pool, create };
}
async function apply(f, source, extra = {}, caller = owner) {
  const preview = await previewCompletion(f.pool, caller, { source_key: source.source_key });
  return requestCompletion(f.pool, caller, { source_key: source.source_key, source_version: preview.source_version,
    completion_date: '2026-10-25', completion_note: '匿名可核验完成结果', ...extra });
}
async function extend(f, source) {
  const preview = await previewCompletion(f.pool, owner, { source_key: source.source_key });
  return requestCompletion(f.pool, owner, { source_key: source.source_key, source_version: preview.source_version,
    request_type: 'extension', requested_due: '2026-11-01', completion_note: '匿名申请延期原因' });
}

test('standalone coordination creates in residential and commercial projects without submitting reports, and retries are idempotent', async t => {
  const f = await fixture(t), id = randomUUID(), body = { id, owner_id: owner.id, what: '单独发起的协调申请', due: '' };
  const first = await f.create('independent-res', body);
  const again = await f.create('independent-res', { ...body, id: id.toUpperCase() });
  assert.deepEqual(again, first); assert.equal(first.due, '');
  assert.equal(first.source_key, 'coord:independent-res:' + id);
  assert.equal(first.author_id, origin.id); assert.equal(first.owner_id, owner.id);
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.reports')).rows[0].n, 0);
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.coordination_tasks')).rows[0].n, 1);
  for (const changed of [{ what: '不同内容' }, { due: '2026-10-30' }, { owner_id: other.id }]) {
    await assert.rejects(f.create('independent-res', { ...body, ...changed }), e => e.status === 409 && e.code === 'coordination_conflict');
  }
  await assert.rejects(f.create('independent-res', { ...body, owner_id: other.id }, owner), e => e.code === 'coordination_conflict');
  await assert.rejects(f.create('independent-res', { ...body, owner_id: other.id }, other), e => e.code === 'coordination_conflict');
  const commercial = await f.create('independent-com');
  assert.equal(commercial.project_id, 'independent-com', 'different assigned commercial modules may coordinate inside the same project');
  assert.equal((await listCoordinationTasks(f.pool, origin)).length, 2);
  assert.equal((await listCoordinationTasks(f.pool, owner)).length, 2);
  assert.equal((await listCoordinationTasks(f.pool, other)).length, 0);
  assert.equal((await listCoordinationTasks(f.pool, ops)).length, 2);
  assert.equal((await listCoordinationTasks(f.pool, { id: 'independent-president' })).length, 2);
  assert.equal((await listCoordinationTasks(f.pool, { id: 'independent-pzo' })).length, 1);
  await assert.rejects(listCoordinationTasks(f.pool, { id: 'independent-pzo' }, { project_id: 'independent-com' }), e => e.status === 403);
});

test('creation checks active project membership and direct SQL prevents identity forgery, edits and leader writes', async t => {
  const f = await fixture(t);
  for (const caller of [ops, { id: 'independent-president' }, { id: 'independent-pzo' }]) await assert.rejects(f.create('independent-res', {}, caller), e => e.status === 403);
  await assert.rejects(f.create('independent-private'), e => e.status === 403);
  for (const owner_id of ['independent-outsider', 'independent-disabled', ops.id]) await assert.rejects(f.create('independent-res', { owner_id }), e => e.status === 400);
  for (const bad of [{ id: 'not-a-uuid' }, { what: '' }, { due: '2026-02-30' }, { author_id: other.id }, { report_id: 123 }]) await assert.rejects(f.create('independent-res', bad), e => e.status === 400);
  await assert.rejects(withIdentity(f.pool, origin.id, client => client.query("INSERT INTO public.coordination_tasks(id,project_id,author_id,author_name,owner_id,owner_name,what) VALUES($1,'independent-res',$2,'伪造',$3,'伪造','非法冒用发起人')", [randomUUID(), other.id, owner.id])), e => e.code === '42501');
  await assert.rejects(withIdentity(f.pool, origin.id, client => client.query("INSERT INTO public.coordination_tasks(id,project_id,author_id,author_name,owner_id,owner_name,what) VALUES($1,'independent-res',$2,'伪造',$3,'伪造','停用承办人')", [randomUUID(), origin.id, 'independent-disabled'])), e => e.code === '42501');
  const source = await f.create();
  for (const caller of [origin, owner, ops]) {
    await assert.rejects(withIdentity(f.pool, caller.id, client => client.query("UPDATE public.coordination_tasks SET what='改写原申请' WHERE id=$1", [source.id])), e => e.code === '42501');
    await assert.rejects(withIdentity(f.pool, caller.id, client => client.query('DELETE FROM public.coordination_tasks WHERE id=$1', [source.id])), e => e.code === '42501');
  }
  const raw = await withIdentity(f.pool, origin.id, client => client.query("INSERT INTO public.coordination_tasks(id,project_id,author_id,author_name,owner_id,owner_name,what,created_at) VALUES($1,'independent-res',$2,'伪造姓名',$3,'伪造姓名','原生有效申请','2000-01-01') RETURNING author_name,owner_name,created_at", [randomUUID(), origin.id, owner.id]));
  assert.equal(raw.rows[0].author_name, '匿名协调发起人'); assert.equal(raw.rows[0].owner_name, '匿名协调承办人');
  assert.notEqual(new Date(raw.rows[0].created_at).getUTCFullYear(), 2000);
});

test('standalone source identity is precise and only the origin confirms completion, retaining owner and audit records', async t => {
  const f = await fixture(t), source = await f.create();
  const preview = await previewCompletion(f.pool, owner, { source_key: source.source_key });
  assert.equal(preview.kind, 'coord'); assert.equal(preview.report_id, undefined); assert.equal(preview.review_authority, 'initiator'); assert.equal(preview.can_review, false);
  await assert.rejects(previewCompletion(f.pool, origin, { source_key: source.source_key }), e => e.status === 403);
  await assert.rejects(previewCompletion(f.pool, other, { source_key: source.source_key }), e => [403, 404].includes(e.status));
  await assert.rejects(previewCompletion(f.pool, owner, { source_key: 'coord:independent-res:123' }), e => e.status === 400);
  await assert.rejects(previewCompletion(f.pool, owner, { source_key: 'coord:independent-private:' + source.id }), e => e.status === 403);
  await assert.rejects(requestCompletion(f.pool, owner, { source_key: source.source_key, source_version: preview.source_version, completion_date: '2026-10-25', completion_note: '冒用他人申报', owner_id: other.id }), e => e.status === 400);
  await assert.rejects(withIdentity(f.pool, other.id, client => resolveCompletionSource(client, other, source.source_key, { forOwnerId: owner.id })), e => e.status === 403);
  const pending = await apply(f, source);
  assert.equal(pending.report_id, null); assert.equal(pending.owner_id, owner.id);
  const initiated = await listCompletions(f.pool, origin, { review_scope: 'initiated' });
  assert.equal(initiated.length, 1); assert.equal(initiated[0].can_review, true);
  for (const caller of [owner, other, ops]) await assert.rejects(reviewCompletion(f.pool, caller, review(pending)), e => e.status === 403);
  assert.equal((await listCompletions(f.pool, ops, { id: pending.id }))[0].can_review, false);
  const approved = await reviewCompletion(f.pool, origin, review(pending));
  assert.equal(approved.reviewer_id, origin.id); assert.equal(approved.status, 'approved');
  await assert.rejects(reviewCompletion(f.pool, origin, review(pending)), e => e.code === 'revision_conflict');
  const reopened = await reviewCompletion(f.pool, origin, review(approved, 'reopen', '核实补充结果'));
  const again = await apply(f, source, { expected_revision: reopened.revision });
  assert.equal(again.id, pending.id); await reviewCompletion(f.pool, origin, review(again));
  assert.equal((await listCompletions(f.pool, origin, { id: pending.id }))[0].history.length, 4);
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.reports')).rows[0].n, 0);
});

test('standalone extensions and full employee statistics use approved deadlines and preserve unknown-date classification', async t => {
  const f = await fixture(t), source = await f.create('independent-com'), request = await extend(f, source);
  assert.equal(request.request_type, 'extension');
  await assert.rejects(reviewCompletion(f.pool, ops, review(request)), e => e.status === 403);
  await reviewCompletion(f.pool, origin, review(request));
  assert.equal((await previewCompletion(f.pool, owner, { source_key: source.source_key })).effective_due, '2026-11-01');
  const completed = await apply(f, source, { completion_date: '2026-10-30' });
  assert.equal(completed.completion_category, 'on_time'); assert.equal(completed.deadline_at_request, '2026-11-01');
  await reviewCompletion(f.pool, origin, review(completed));
  const unknown = await f.create('independent-res', { due: '' });
  const unknownRequest = await apply(f, unknown); assert.equal(unknownRequest.completion_category, 'unknown');
  await reviewCompletion(f.pool, origin, review(unknownRequest));
  const late = await f.create('independent-res');
  await reviewCompletion(f.pool, origin, review(await apply(f, late, { completion_date: '2026-10-26' })));
  const statistics = await completionStatistics(f.pool, ops, { kind: 'coord', start: '2000-01-01', end: '2100-12-31' });
  assert.equal(statistics.totals.completed, 3); assert.equal(statistics.totals.on_time, 1); assert.equal(statistics.totals.late, 1); assert.equal(statistics.totals.undetermined, 1);
  assert.equal(statistics.totals.extension_approved, 1); assert.equal(statistics.totals.source_changed, 0);
  assert.equal(statistics.employees.find(employee => employee.user_id === owner.id).counts.completed, 3);
  assert.equal(statistics.employees.find(employee => employee.user_id === origin.id).counts.completed, 0);
});

test('migration adds an empty source table and preserves old report coordination and handover authority', async t => {
  const f = await fixture(t);
  const report = (await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,coord_items,biz) VALUES('independent-res','第43周（10.19–10.25）','综合',$1,'匿名协调发起人',$2,$3) RETURNING id::text AS id", [origin.id,
    JSON.stringify([{ source_id: 'old-coord', who_id: owner.id, who: '匿名协调承办人', what: '原报告协调', by: '2026-10-25' }]),
    JSON.stringify({ handover: [{ source_id: 'old-handover', what: '原移交', to: '匿名协调承办人', due: '2026-10-25' }] })])).rows[0];
  const coord = { source_key: 'coord:independent-res:' + report.id + ':coord:old-coord' }, handover = { source_key: 'coord:independent-res:' + report.id + ':handover:old-handover' };
  const coordRequest = await apply(f, coord), handoverRequest = await apply(f, handover);
  await reviewCompletion(f.pool, origin, review(coordRequest)); await reviewCompletion(f.pool, ops, review(handoverRequest));
  const before = (await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'requests',(SELECT jsonb_agg(to_jsonb(c)) FROM public.completion_requests c),'auth',(SELECT jsonb_agg(to_jsonb(a)) FROM app_private.auth_users a)) AS data")).rows[0].data;
  const meta = (await f.admin.query("SELECT oid,proowner,proacl::text AS acl FROM pg_proc WHERE oid=ANY(ARRAY['app_private.is_initiator_coordination(text,text,text,bigint)'::regprocedure,'app_private.can_review_completion(text,text,text,bigint)'::regprocedure,'app_private.lock_completion_source(uuid)'::regprocedure]) ORDER BY oid")).rows;
  await f.db.exec(migration); await f.db.exec(migration);
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.coordination_tasks')).rows[0].n, 0);
  const after = (await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'requests',(SELECT jsonb_agg(to_jsonb(c)) FROM public.completion_requests c),'auth',(SELECT jsonb_agg(to_jsonb(a)) FROM app_private.auth_users a)) AS data")).rows[0].data;
  assert.deepEqual(after, before);
  assert.deepEqual((await f.admin.query("SELECT oid,proowner,proacl::text AS acl FROM pg_proc WHERE oid=ANY(ARRAY['app_private.is_initiator_coordination(text,text,text,bigint)'::regprocedure,'app_private.can_review_completion(text,text,text,bigint)'::regprocedure,'app_private.lock_completion_source(uuid)'::regprocedure]) ORDER BY oid")).rows, meta);
  const independent = await f.create();
  for (const pid of ['independent-private', 'independent-com']) {
    const allowed = await withIdentity(f.pool, ops.id, async client => (await client.query('SELECT app_private.can_review_completion($1,$2,$3,NULL) AS allowed', ['coord', independent.source_key, pid])).rows[0].allowed);
    assert.equal(allowed, false);
  }
  await assert.rejects(withIdentity(f.pool, ops.id, client => client.query('SELECT app_private.lock_completion_source($1)', [coordRequest.id])), e => e.code === '42501');
});
