import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { withIdentity } from '../server/database.mjs';
import { saveReporterTask } from '../server/reporter-tasks.mjs';
import { listCompletions, previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';

const origin = { id: 'coord-origin' }, recipient = { id: 'coord-recipient' }, other = { id: 'coord-other' }, ops = { id: 'coord-ops' };
const migration = await readFile(new URL('../db/016-coordination-origin-review.sql', import.meta.url), 'utf8');
const review = (row, decision = 'approve', note = '') => ({ id: row.id, expected_revision: row.revision, decision, note });
async function fixture(t) {
  // Every test owns an anonymous, disposable DB. No environment or mail service.
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name) VALUES('coord-alpha','匿名住宅甲'),('coord-private','未授权住宅')");
  for (const [id, name, role] of [[origin.id, '匿名发起人', 'pm'], [recipient.id, '匿名承办人', 'pm'], [other.id, '同名匿名发起人', 'pm'], [ops.id, '匿名运营', 'ops'], ['coord-foreign', '其他项目人员', 'pm']]) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', [id, id + '@example.invalid', 'isolated-unused-auth-value']);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,$2,$3,'approved','工程')", [id, name, role]);
    if (role === 'pm') await admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)', [id, id === 'coord-foreign' ? 'coord-private' : 'coord-alpha']);
  }
  const coords = [
    { source_id: 'directed-completion', who_id: recipient.id, who: '匿名承办人', what: '核对专项资料', by: '2026-10-25' },
    { source_id: 'second-completion', who_id: recipient.id, who: '匿名承办人', what: '核对另一份资料', by: '2026-10-25' },
    { source_id: 'unknown-deadline', who_id: recipient.id, who: '匿名承办人', what: '核对无期限资料', by: '' },
    { source_id: 'legacy-name', who: '匿名承办人', what: '旧实名文字需求', by: '2026-10-25' }
  ];
  const report = (await admin.query("INSERT INTO public.reports(project_id,period,author_id,author_name,line,coord_items,biz) VALUES('coord-alpha','第43周（10.19–10.25）',$1,'匿名发起人','综合',$2,$3) RETURNING id::text AS id", [origin.id, JSON.stringify(coords), JSON.stringify({ handover: [{ source_id: 'handover-original', what: '移交匿名工作面', to: '匿名承办人', due: '2026-10-25' }] })])).rows[0];
  const foreignReport = (await admin.query("INSERT INTO public.reports(project_id,period,author_id,author_name,line,coord_items) VALUES('coord-alpha','第42周（10.12–10.18）',$1,'同名匿名发起人','综合',$2) RETURNING id::text AS id", [other.id, JSON.stringify([{ source_id: 'foreign-origin', who_id: recipient.id, who: '匿名承办人', what: '其他人发起需求', by: '2026-10-25' }])])).rows[0];
  const key = id => 'coord:coord-alpha:' + report.id + ':coord:' + id;
  return { db, admin, pool, report, coords, key, handover: 'coord:coord-alpha:' + report.id + ':handover:handover-original', foreignKey: 'coord:coord-alpha:' + foreignReport.id + ':coord:foreign-origin' };
}
async function apply(f, key, user = recipient, extra = {}) {
  const preview = await previewCompletion(f.pool, user, { source_key: key });
  return requestCompletion(f.pool, user, { source_key: key, source_version: preview.source_version,
    completion_date: '2026-10-25', completion_note: '匿名完成证据', ...extra });
}
async function extension(f, key) {
  const preview = await previewCompletion(f.pool, recipient, { source_key: key });
  return requestCompletion(f.pool, recipient, { source_key: key, source_version: preview.source_version,
    request_type: 'extension', requested_due: '2026-11-01', completion_note: '匿名延期说明' });
}

test('only exact source author reviews coordination; list scopes and database policies preserve other boundaries', async t => {
  const f = await fixture(t), key = f.key('directed-completion');
  const preview = await previewCompletion(f.pool, recipient, { source_key: key });
  assert.equal(preview.review_authority, 'initiator'); assert.equal(preview.can_review, false);
  const row = await apply(f, key), second = await apply(f, f.key('second-completion')), foreign = await apply(f, f.foreignKey);
  assert.equal((await listCompletions(f.pool, origin)).length, 0, 'default PM queue remains own applications');
  const initiated = await listCompletions(f.pool, origin, { review_scope: 'initiated', limit: 1 });
  assert.equal(initiated.length, 1); assert.equal(initiated.meta.has_more, true); assert.equal(initiated[0].can_review, true);
  const next = await listCompletions(f.pool, origin, { review_scope: 'initiated', limit: 1, cursor: initiated.meta.next_cursor });
  assert.equal(next.length, 1); assert.equal(next.meta.has_more, false); assert.notEqual(next[0].id, initiated[0].id);
  assert.deepEqual(new Set([initiated[0].id, next[0].id]), new Set([row.id, second.id]));
  assert.equal((await listCompletions(f.pool, origin, { review_scope: 'initiated', id: foreign.id })).length, 0);
  assert.equal((await listCompletions(f.pool, other, { id: row.id })).length, 0);
  assert.equal((await listCompletions(f.pool, ops, { id: row.id }))[0].can_review, false);
  for (const caller of [recipient, other, ops, { id: 'coord-foreign' }]) await assert.rejects(reviewCompletion(f.pool, caller, review(row)), e => e.status === 403);
  await assert.rejects(listCompletions(f.pool, ops, { review_scope: 'initiated' }), e => e.status === 403);
  const rawOps = await withIdentity(f.pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='approved' WHERE id=$1 RETURNING id", [row.id]));
  assert.equal(rawOps.rows.length, 0);
  await assert.rejects(withIdentity(f.pool, ops.id, client => client.query('SELECT app_private.lock_completion_source($1)', [row.id])), e => e.code === '42501');
  const approved = await reviewCompletion(f.pool, origin, review(row));
  assert.equal(approved.status, 'approved'); assert.equal(approved.reviewer_id, origin.id); assert.equal(approved.can_review, true);
  assert.equal((await listCompletions(f.pool, recipient, { id: second.id }))[0].status, 'pending', 'one owner/source approval never completes another item');
  await assert.rejects(reviewCompletion(f.pool, origin, review(row)), e => e.code === 'revision_conflict');
  const reopened = await reviewCompletion(f.pool, origin, review(approved, 'reopen', '资料需要补核'));
  assert.equal(reopened.status, 'reopened');
  const detail = (await listCompletions(f.pool, origin, { review_scope: 'initiated', id: row.id }))[0];
  assert.equal(detail.history.length, 2); assert.equal(detail.history[1].data.status, 'approved');
});

test('coordination extensions use origin confirmation and retained execution deadlines without completing the item', async t => {
  const f = await fixture(t), key = f.key('directed-completion'), request = await extension(f, key);
  await assert.rejects(reviewCompletion(f.pool, ops, review(request)), e => e.status === 403);
  const accepted = await reviewCompletion(f.pool, origin, review(request));
  assert.equal(accepted.request_type, 'extension'); assert.equal(accepted.status, 'approved');
  assert.equal((await previewCompletion(f.pool, recipient, { source_key: key })).effective_due, '2026-11-01');
  const completed = await apply(f, key, recipient, { completion_date: '2026-10-30' });
  assert.equal(completed.completion_category, 'on_time'); assert.equal(completed.deadline_at_request, '2026-11-01');
  const approved = await reviewCompletion(f.pool, origin, review(completed));
  assert.equal(approved.status, 'approved');
  const records = await listCompletions(f.pool, origin, { review_scope: 'initiated' });
  assert.equal(records.length, 2); assert.equal(records.filter(r => r.request_type === 'completion').length, 1);
  await assert.rejects(reviewCompletion(f.pool, origin, review(accepted, 'reopen', '不能销掉延期历史')), e => e.code === 'invalid_transition');
  const unknown = await apply(f, f.key('unknown-deadline'));
  assert.equal(unknown.completion_category, 'unknown');
  const late = await apply(f, f.key('second-completion'), recipient, { completion_date: '2026-10-26' });
  assert.equal(late.completion_category, 'late');
});

test('source changes prevent approval, retain exact-origin rejection and enforce project access revocation', async t => {
  const f = await fixture(t), row = await apply(f, f.key('directed-completion'));
  const changed = f.coords.map(item => item.source_id === 'directed-completion' ? { ...item, who_id: other.id, who: '同名匿名发起人' } : item);
  await f.admin.query('UPDATE public.reports SET coord_items=$1 WHERE id=$2', [JSON.stringify(changed), f.report.id]);
  await assert.rejects(reviewCompletion(f.pool, origin, review(row)), e => e.status === 409 && e.code === 'source_changed');
  const sourceChanged = (await listCompletions(f.pool, origin, { review_scope: 'initiated', id: row.id }))[0];
  assert.equal(sourceChanged.source_changed, true); assert.equal(sourceChanged.can_review, true);
  const rejected = await reviewCompletion(f.pool, origin, review(row, 'reject', '接收人员已变更，请核实'));
  assert.equal(rejected.status, 'rejected');
  const removed = await apply(f, f.key('second-completion'));
  await f.admin.query('UPDATE public.reports SET coord_items=$1 WHERE id=$2', [JSON.stringify(changed.filter(item => item.source_id !== 'second-completion')), f.report.id]);
  const missing = (await listCompletions(f.pool, origin, { review_scope: 'initiated', id: removed.id }))[0];
  assert.equal(missing.source_missing, true); assert.equal(missing.can_review, true);
  await assert.rejects(reviewCompletion(f.pool, origin, review(removed)), e => e.code === 'source_changed');
  assert.equal((await reviewCompletion(f.pool, origin, review(removed, 'reject', '来源事项已移除，退回核对'))).status, 'rejected');
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='coord-alpha'", [origin.id]);
  assert.equal((await listCompletions(f.pool, origin, { review_scope: 'initiated' })).length, 0);
  await assert.rejects(reviewCompletion(f.pool, origin, review(rejected, 'reopen', '越权核实')), e => e.status === 403);
});

test('handovers and meetings retain operator review and source authors cannot rewrite applicant evidence', async t => {
  const f = await fixture(t), handover = await apply(f, f.handover);
  assert.equal(handover.review_authority, 'ops');
  await assert.rejects(reviewCompletion(f.pool, origin, review(handover)), e => e.status === 403);
  assert.equal((await reviewCompletion(f.pool, ops, review(handover))).status, 'approved');
  const meeting = await saveReporterTask(f.pool, ops, { project_id: 'coord-alpha', owner_id: recipient.id, title: '匿名会议', what: '会议要求', due: '2026-10-25' });
  const meetingRequest = await apply(f, 'meeting:coord-alpha:' + meeting.id);
  assert.equal((await reviewCompletion(f.pool, ops, review(meetingRequest))).status, 'approved');
  const row = await apply(f, f.key('directed-completion'));
  for (const patch of ["completion_note='伪造申请材料'", "source_snapshot='{}'::jsonb", "report_id=NULL", "reviewer_id='coord-other'", "history='[]'::jsonb||jsonb_build_array('{}'::jsonb)"]) {
    await assert.rejects(withIdentity(f.pool, origin.id, client => client.query("UPDATE public.completion_requests SET status='approved'," + patch + ' WHERE id=$1', [row.id])), e => e.code === '42501');
  }
  assert.equal((await listCompletions(f.pool, origin, { id: row.id }))[0].status, 'pending');
  // Existing author-as-applicant capability remains; no new self-assignment ban.
  const own = await apply(f, f.key('legacy-name'), origin);
  assert.equal(own.owner_id, origin.id); assert.equal((await reviewCompletion(f.pool, origin, review(own))).status, 'approved');
});

test('migration retains historical operator decisions, auth, data and existing helper ownership and ACLs', async t => {
  const f = await fixture(t), request = await apply(f, f.key('directed-completion'));
  await f.db.exec('RESET ROLE');
  await f.db.exec(await readFile(new URL('../db/007-completion-review.sql', import.meta.url), 'utf8'));
  await withIdentity(f.pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='approved' WHERE id=$1", [request.id]));
  const snapshot = async () => (await f.admin.query("SELECT jsonb_build_object('requests',(SELECT jsonb_agg(to_jsonb(c)) FROM public.completion_requests c),'reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM public.profiles p),'auth',(SELECT jsonb_agg(to_jsonb(a)) FROM app_private.auth_users a)) AS value")).rows[0].value;
  const helperMeta = async () => (await f.admin.query("SELECT oid,proowner,proacl::text AS acl FROM pg_proc WHERE oid=ANY(ARRAY['app_private.guard_completion_request()'::regprocedure,'app_private.lock_completion_source(uuid)'::regprocedure]) ORDER BY oid")).rows;
  const before = await snapshot(), meta = await helperMeta();
  await f.db.exec(migration); await f.db.exec(migration);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await helperMeta(), meta);
  const old = (await listCompletions(f.pool, ops, { id: request.id }))[0];
  assert.equal(old.reviewer_id, ops.id); assert.equal(old.status, 'approved'); assert.equal(old.can_review, false);
  const reopened = await reviewCompletion(f.pool, origin, review(old, 'reopen', '按新责任人确认重新核实'));
  assert.equal(reopened.reviewer_id, origin.id);
  const detail = (await listCompletions(f.pool, origin, { id: request.id }))[0];
  assert.equal(detail.history[1].data.reviewer_id, ops.id);
});

test('later approved extensions do not reclassify legacy completion dates with an unset captured deadline', async t => {
  const f = await fixture(t), key = f.key('directed-completion');
  const request = await apply(f, key, recipient, { completion_date: '2026-10-30' });
  const approved = await reviewCompletion(f.pool, origin, review(request));
  await reviewCompletion(f.pool, origin, review(approved, 'reopen', '重新核实后续安排'));
  // Reproduce a genuine pre-extension-schema row in this disposable fixture.
  // Production migrations deliberately never backfill such historical values.
  await f.admin.query('ALTER TABLE public.completion_requests DISABLE TRIGGER USER');
  try {
    await f.admin.query("UPDATE public.completion_requests SET effective_due=NULL,source_snapshot=source_snapshot-'effective_due' WHERE id=$1", [request.id]);
  } finally { await f.admin.query('ALTER TABLE public.completion_requests ENABLE TRIGGER USER'); }
  const next = await extension(f, key);
  await reviewCompletion(f.pool, origin, review(next));
  const old = (await listCompletions(f.pool, recipient, { id: request.id }))[0];
  assert.equal(old.effective_due, '2026-11-01', 'current execution date may advance');
  assert.equal(old.deadline_at_request, '2026-10-25', 'legacy completed evidence uses its original retained deadline');
  assert.equal(old.completion_category, 'late');
});

test('missing or mismatched coordination bindings never fall back to operator review', async t => {
  const f = await fixture(t), key = f.key('directed-completion'), request = await apply(f, key);
  // Applicant resubmission legitimately edits source evidence. Corrupt linkage
  // must not become an alternate authority even when reached through raw SQL.
  const withdrawn = await withIdentity(f.pool, recipient.id, async client => (await client.query("UPDATE public.completion_requests SET status='withdrawn' WHERE id=$1 RETURNING revision", [request.id])).rows[0]);
  assert.ok(withdrawn.revision > request.revision);
  const pending = await withIdentity(f.pool, recipient.id, async client => (await client.query("UPDATE public.completion_requests SET status='pending',report_id=NULL WHERE id=$1 RETURNING revision", [request.id])).rows[0]);
  for (const caller of [origin, recipient, other, ops]) {
    const allowed = await withIdentity(f.pool, caller.id, async client => (await client.query('SELECT app_private.can_review_completion($1,$2,$3,$4) AS allowed', ['coord', key, 'coord-alpha', null])).rows[0].allowed);
    assert.equal(allowed, false, caller.id + ' cannot review an unbound coordination request');
  }
  await assert.rejects(reviewCompletion(f.pool, ops, { id: request.id, expected_revision: pending.revision, decision: 'approve' }), e => e.status === 403);
  const linked = Number(f.report.id);
  for (const [badKey, project, report] of [
    [key, 'coord-private', linked],
    ['coord:coord-private:' + f.report.id + ':coord:directed-completion', 'coord-alpha', linked],
    [key, 'coord-alpha', linked + 1000]
  ]) {
    for (const caller of [origin, ops]) {
      const allowed = await withIdentity(f.pool, caller.id, async client => (await client.query('SELECT app_private.can_review_completion($1,$2,$3,$4) AS allowed', ['coord', badKey, project, report])).rows[0].allowed);
      assert.equal(allowed, false, 'mismatched key/project/report cannot change the review authority');
    }
  }
  assert.equal((await listCompletions(f.pool, recipient, { id: request.id }))[0].can_review, false);
});
