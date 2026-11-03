import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { withIdentity } from '../server/database.mjs';
import { completionStatistics } from '../server/completion-statistics.mjs';
import { previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';
import { saveReporterTask } from '../server/reporter-tasks.mjs';

const pm = { id: 'demo-pm-res' }, ops = { id: 'demo-ops' };
const range = { start: '2026-10-19', end: '2026-10-25' };
const approval = row => ({ id: row.id, expected_revision: row.revision, decision: 'approve' });
test('complete employee statistics preserve authorization, dates, frozen deadlines and source identity', async t => {
  // No inherited environment or live network: disposable PostgreSQL state only.
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  await t.test('only operators read active login-backed people, including zero counts', async () => {
    for (const id of ['demo-pm-res', 'demo-president', 'demo-pzo']) await assert.rejects(completionStatistics(pool, { id }, range), error => error.status === 403);
    await assert.rejects(completionStatistics(pool, ops, { ...range, project_id: 'missing-project' }), error => error.status === 403);
    await assert.rejects(completionStatistics(pool, ops, { start: '2026-02-30', end: '2026-03-01' }), error => error.status === 400);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('history-no-login','匿名历史档案','pm','approved')");
    const result = await completionStatistics(pool, ops, range);
    assert.equal(result.employees.length, 5); assert.equal(result.totals.completed, 0);
    assert.equal(result.employees.every(person => person.counts.completed === 0), true);
    assert.equal(result.employees.some(person => person.user_id === 'history-no-login'), false);
    const byProject = await completionStatistics(pool, ops, { ...range, project_id: 'demo-res' });
    assert.equal(byProject.employees.some(person => person.user_id === 'demo-pm-com'), false);
    assert.equal(byProject.employees.some(person => person.user_id === 'demo-president'), true);
  });
  let approved;
  await t.test('more than one queue page is aggregated without per-item source SQL, using actual completion dates', async () => {
    const notes = (await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,due,author_name) SELECT 'demo-res','第43周','ceo_brief','匿名统计事项 '||n,CASE WHEN n=103 THEN '' ELSE '2026-10-20' END,'匿名领导' FROM generate_series(1,103) n RETURNING id")).rows;
    const sources = [];
    for (const note of notes) sources.push(await previewCompletion(pool, pm, { source_key: 'leader:demo-res:' + note.id }));
    const rows = sources.map((source, index) => ({ id: randomUUID(), source_key: source.source_key, source_version: source.source_version, project_id: source.project_id,
      source_id: source.source_key.split(':').at(-1), kind: source.kind, title: source.title, what: source.what, due: source.due, source_snapshot: source,
      completion_date: index === 101 ? '2026-10-21' : '2026-10-19' }));
    approved = await withIdentity(pool, pm.id, async client => (await client.query(
      "INSERT INTO public.completion_requests(id,source_key,source_version,project_id,source_id,kind,owner_id,title,what,due,source_snapshot,completion_date,completion_note) SELECT x.id::uuid,x.source_key,x.source_version,x.project_id,x.source_id,x.kind,$2,x.title,x.what,x.due,x.source_snapshot,x.completion_date::date,'匿名完成证据' FROM jsonb_to_recordset($1::jsonb) x(id text,source_key text,source_version text,project_id text,source_id text,kind text,title text,what text,due text,source_snapshot jsonb,completion_date text) RETURNING id,revision,source_key",
      [JSON.stringify(rows), pm.id])).rows);
    // Exercise the normal review trigger in bulk; history and reviewer fields
    // remain database generated rather than being manufactured by the fixture.
    await withIdentity(pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='approved' WHERE id=ANY($1::uuid[])", [approved.map(row => row.id)]));
    let queries = 0;
    const tracked = { async connect() { const client = await pool.connect(); return { query(...args) { queries++; return client.query(...args); }, release: () => client.release() }; } };
    const result = await completionStatistics(tracked, ops, range);
    assert.equal(result.meta.rows_checked, 103); assert.equal(result.totals.completed, 103);
    assert.equal(result.totals.on_time, 101); assert.equal(result.totals.late, 1); assert.equal(result.totals.undetermined, 1);
    assert.ok(queries < 20, 'bulk source loading keeps DB round trips independent of row count: ' + queries);
    const actualDay = await completionStatistics(pool, ops, { start: '2026-10-19', end: '2026-10-19', kind: 'leader', owner_id: pm.id });
    assert.equal(actualDay.totals.completed, 102);
    assert.equal(actualDay.employees.length, 1); assert.equal(actualDay.employees[0].categories.length, 1);
    const later = await completionStatistics(pool, ops, { start: '2026-11-01', end: '2026-11-30' });
    assert.equal(later.totals.completed, 0);
  });
  await t.test('reopened and changed sources leave current completion counts; resubmission stays one item', async () => {
    const record = (await withIdentity(pool, ops.id, client => client.query('SELECT id,revision FROM public.completion_requests WHERE id=$1', [approved[0].id]))).rows[0];
    const reopened = await reviewCompletion(pool, ops, { ...approval(record), decision: 'reopen', note: '匿名核实后重开' });
    let result = await completionStatistics(pool, ops, range);
    assert.equal(result.totals.completed, 102); assert.equal(result.totals.reopened, 1);
    const source = await previewCompletion(pool, pm, { source_key: approved[0].source_key });
    const resubmitted = await requestCompletion(pool, pm, { source_key: source.source_key, source_version: source.source_version,
      expected_revision: reopened.revision, completion_date: '2026-10-20', completion_note: '匿名补充完成证据' });
    await reviewCompletion(pool, ops, approval(resubmitted));
    await admin.query("UPDATE public.leader_notes SET what=what||'（已变更）' WHERE id=$1", [approved[1].source_key.split(':').at(-1)]);
    result = await completionStatistics(pool, ops, range);
    assert.equal(result.totals.completed, 102); assert.equal(result.totals.source_changed, 1); assert.equal(result.totals.reopened, 0);
  });
  await t.test('approved extension is separate from completion and cannot recategorize a saved old deadline', async () => {
    const task = await saveReporterTask(pool, ops, { project_id: 'demo-res', owner_id: pm.id, title: '匿名统计会议', what: '核验延期归期', due: '2026-10-20' });
    const key = 'meeting:demo-res:' + task.id;
    const source = await previewCompletion(pool, pm, { source_key: key });
    const extension = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
      request_type: 'extension', requested_due: '2026-10-24', completion_note: '匿名延期说明' });
    await reviewCompletion(pool, ops, approval(extension));
    let result = await completionStatistics(pool, ops, { ...range, kind: 'meeting' });
    assert.equal(result.totals.completed, 0);
    const requestDay = (await admin.query("SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM public.completion_requests WHERE id=$1", [extension.id])).rows[0].day;
    const extensionStats = await completionStatistics(pool, ops, { start: requestDay, end: requestDay, kind: 'meeting' });
    assert.equal(extensionStats.totals.extension_requested, 1); assert.equal(extensionStats.totals.extension_approved, 1);
    const completion = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
      completion_date: '2026-10-23', completion_note: '批准期限内完成' });
    await reviewCompletion(pool, ops, approval(completion));
    result = await completionStatistics(pool, ops, { ...range, kind: 'meeting' });
    assert.equal(result.totals.completed, 1); assert.equal(result.totals.on_time, 1); assert.equal(result.totals.late, 0);
    const reopened = await reviewCompletion(pool, ops, { ...approval({ ...completion, revision: completion.revision + 1 }), decision: 'reopen', note: '匿名重开' });
    const extension2 = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
      request_type: 'extension', requested_due: '2026-10-28', completion_note: '第二次延期' });
    await reviewCompletion(pool, ops, approval(extension2));
    const repeated = await completionStatistics(pool, ops, { start: requestDay, end: requestDay, kind: 'meeting' });
    assert.equal(repeated.totals.extension_requested, 1); assert.equal(repeated.totals.extension_approved, 1);
    assert.equal(repeated.totals.completed, 0); assert.equal(repeated.totals.reopened, requestDay === '2026-10-23' ? 1 : 0);
    assert.equal(reopened.status, 'reopened');
  });
  await t.test('bulk source cache checks baseline, report plans and coordination without losing source boundaries', async () => {
    const node = (await admin.query("SELECT id::text AS id FROM public.milestones WHERE project_id='demo-res' AND line='工程' LIMIT 1")).rows[0];
    await admin.query("UPDATE public.milestones SET forecast_date='2026-10-22' WHERE id=$1", [node.id]);
    const report = (await admin.query("SELECT id::text AS id,biz FROM public.reports WHERE project_id='demo-res' LIMIT 1")).rows[0];
    await admin.query('UPDATE public.reports SET biz=$1,coord_items=$2 WHERE id=$3', [JSON.stringify({ ...report.biz,
      items: [{ source_id: 'stats-plan', name: '匿名本期计划', due: '2026-10-22', prog: '' }] }),
      JSON.stringify([{ source_id: 'stats-coord', who_id: pm.id, who: '匿名承办人', what: '匿名协调资料', by: '2026-10-22' }]), report.id]);
    for (const key of ['milestone:demo-res:' + node.id, 'plan:demo-res:' + report.id + ':items:stats-plan', 'coord:demo-res:' + report.id + ':coord:stats-coord']) {
      const source = await previewCompletion(pool, pm, { source_key: key });
      const row = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
        completion_date: '2026-10-21', completion_note: '匿名来源验证' });
      if (source.kind === 'coord') {
        await assert.rejects(reviewCompletion(pool, ops, approval(row)), error => error.status === 403);
        await reviewCompletion(pool, pm, approval(row));
      } else await reviewCompletion(pool, ops, approval(row));
    }
    for (const kind of ['milestone', 'plan', 'coord']) {
      const result = await completionStatistics(pool, ops, { ...range, kind, discipline: '工程' });
      assert.equal(result.totals.completed, 1, kind); assert.equal(result.totals.on_time, 1, kind);
      assert.equal(result.totals.source_changed, 0, kind);
    }
    await admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2', [pm.id, 'demo-res']);
    const lost = await completionStatistics(pool, ops, { ...range, owner_id: pm.id, kind: 'coord' });
    assert.equal(lost.totals.completed, 0); assert.equal(lost.totals.source_changed, 1);
  });
});
