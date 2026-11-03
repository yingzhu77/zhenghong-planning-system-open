import test from 'node:test';
import assert from 'node:assert/strict';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { confirmMonthlyPlan } from '../server/monthly-plans.mjs';
import { executeDatabase } from '../server/database.mjs';
import { previewCompletion, requestCompletion, reviewCompletion, listCompletions } from '../server/completions.mjs';
import { completionStatistics } from '../server/completion-statistics.mjs';

const pm = { id: 'demo-pm-com' }, ops = { id: 'demo-ops' };
test('one confirmed monthly item keeps one completion source across weekly reports and frozen-deadline statistics', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  const line = '土建工程（东地块）';
  const item = { source_id: 'monthly-source-sentinel', mod: '砌筑', name: '匿名月计划固定事项', due: '2026-11-20' };
  const plan = await confirmMonthlyPlan(pool, pm, { project_id: 'demo-com', line, month: '2026-11', items: [item] });
  const key = 'monthly:demo-com:' + plan.id + ':' + item.source_id;
  const original = await previewCompletion(pool, pm, { source_key: key });
  assert.equal(original.kind, 'plan'); assert.equal(original.review_authority, 'ops');
  assert.equal(original.what, item.name); assert.equal(original.due, item.due);
  await assert.rejects(previewCompletion(pool, { id: 'demo-pm-res' }, { source_key: key }), error => [403, 404].includes(error.status));
  await assert.rejects(previewCompletion(pool, pm, { source_key: key.replace(item.source_id, 'absent-item') }), error => error.status === 404);
  for (const [period, progress] of [['第45周（11.02–11.08）', '第一周推进'], ['第46周（11.09–11.15）', '第二周推进']]) {
    await executeDatabase(pool, pm, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: [{
      project_id: 'demo-com', period, line, biz: { monthly_plan_id: plan.id, monthly_plan_month: '2026-11',
        items: [{ ...item, prog: progress, blocker: '匿名当周卡点' }] }
    }] });
    assert.equal((await previewCompletion(pool, pm, { source_key: key })).source_version, original.source_version);
  }
  let source = await previewCompletion(pool, pm, { source_key: key });
  const extension = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
    request_type: 'extension', requested_due: '2026-11-25', completion_note: '匿名延期理由' });
  await reviewCompletion(pool, ops, { id: extension.id, expected_revision: extension.revision, decision: 'approve' });
  source = await previewCompletion(pool, pm, { source_key: key });
  assert.equal(source.effective_due, '2026-11-25');
  const request = await requestCompletion(pool, pm, { source_key: key, source_version: source.source_version,
    completion_date: '2026-11-24', completion_note: '匿名实际完成证据' });
  assert.equal(request.completion_category, 'on_time');
  const approved = await reviewCompletion(pool, ops, { id: request.id, expected_revision: request.revision, decision: 'approve' });
  assert.equal(approved.effective_status, 'approved');
  const rows = await listCompletions(pool, pm, { source_keys: [key], status: 'all' });
  assert.equal(rows.filter(row => row.request_type === 'completion').length, 1);
  const stats = await completionStatistics(pool, ops, { project_id: 'demo-com', kind: 'plan', start: '2026-11-01', end: '2026-11-30' });
  assert.equal(stats.totals.completed, 1); assert.equal(stats.totals.on_time, 1);
  assert.equal(stats.totals.source_changed, 0);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.monthly_plans')).rows[0].n, 1);
});
