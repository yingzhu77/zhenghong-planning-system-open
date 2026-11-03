import test from 'node:test';
import assert from 'node:assert/strict';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { projectPlanStatistics } from '../server/project-plan-statistics.mjs';
import { confirmMonthlyPlan } from '../server/monthly-plans.mjs';
import { previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';
import { executeDatabase } from '../server/database.mjs';

const ops = { id: 'demo-ops' }, pm = { id: 'demo-pm-res' }, commercial = { id: 'demo-pm-com' };
const addDays = (day, count) => new Date(new Date(day + 'T00:00:00Z').getTime() + count * 86400000).toISOString().slice(0, 10);
const approval = row => ({ id: row.id, expected_revision: row.revision, decision: 'approve' });
async function request(pool, owner, source_key, extra) {
  const source = await previewCompletion(pool, owner, { source_key });
  return requestCompletion(pool, owner, { source_key, source_version: source.source_version, completion_note: '匿名隔离验证依据', ...extra });
}

test('project plan statistics keep source denominators, current approvals and authorized project scope', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  const today = (await projectPlanStatistics(pool, ops)).today;
  const monday = addDays(today, 1 - (new Date(today + 'T00:00:00Z').getUTCDay() || 7));
  const month = monday.slice(0, 7), line = '土建工程（东地块）';
  await admin.query("UPDATE public.projects SET display_group='匿名住宅展示组' WHERE id='demo-res'");
  await admin.query("INSERT INTO public.projects(id,name,project_type,display_group) VALUES('other-phase','匿名住宅二期',NULL,'匿名住宅展示组')");
  await admin.query("INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,discipline,done) VALUES('other-phase','隔离无权限节点',$1,$1,'设计',false)", [today]);
  await admin.query("DELETE FROM public.milestones WHERE project_id='demo-res'");
  const nodes = (await admin.query("INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,discipline,line,is_key,level,done) VALUES ('demo-res','缺预计日期',$1,NULL,'工程','工程',true,'一级',false),('demo-res','轻微偏差',$2,$3,'工程','工程',true,'一级',false),('demo-res','关注偏差',$2,$4,'工程','工程',false,'二级',false),('demo-res','严重偏差',$2,$5,'设计','设计',false,'二级',false),('demo-res','历史已完无实际日期',$1,NULL,'开发报建','开发报建',false,'二级',true),('demo-res','审批完成节点',$1,$1,'工程','工程',true,'一级',false),('demo-res','延期未完成节点',$1,$1,'工程','工程',false,'二级',false),('demo-res','变更后失效审批',$1,$1,'工程','工程',false,'二级',false) RETURNING id::text AS id,name", [addDays(today, -5), today, addDays(today, 3), addDays(today, 6), addDays(today, 15)])).rows;
  const key = name => 'milestone:demo-res:' + nodes.find(row => row.name === name).id;
  for (const name of ['审批完成节点', '变更后失效审批']) {
    const row = await request(pool, pm, key(name), { completion_date: addDays(today, -6) });
    await reviewCompletion(pool, ops, approval(row));
  }
  const extended = await request(pool, pm, key('延期未完成节点'), { request_type: 'extension', requested_due: addDays(today, 10) });
  await reviewCompletion(pool, ops, approval(extended));
  await admin.query("UPDATE public.milestones SET name='来源变更失效' WHERE id=$1", [nodes.find(row => row.name === '变更后失效审批').id]);

  await t.test('residential numerator distinguishes historical marks, valid approvals, extensions and missing dates', async () => {
    const result = await projectPlanStatistics(pool, ops, { kind: 'res', project_id: 'demo-res' });
    assert.equal(result.rows.length, 8); assert.equal(result.totals.completed, 2); assert.equal(result.totals.incomplete, 6);
    assert.equal(result.totals.forecast_delayed, 3); assert.equal(result.totals.insufficient, 2);
    assert.equal(result.totals.on_time, 1); assert.equal(result.totals.timeliness_covered, 1); assert.equal(result.totals.timeliness_unknown, 1);
    const find = title => result.rows.find(row => row.title === title);
    assert.equal(find('缺预计日期').risk, 'insufficient'); assert.equal(find('缺预计日期').deviation, null); assert.equal(find('缺预计日期').overdue, true);
    assert.equal(find('轻微偏差').risk, 'slight'); assert.equal(find('关注偏差').risk, 'attention'); assert.equal(find('严重偏差').risk, 'severe');
    assert.equal(find('审批完成节点').deviation, null); assert.equal(find('审批完成节点').risk, 'completed');
    assert.equal(find('历史已完无实际日期').completion_basis, 'legacy'); assert.equal(find('历史已完无实际日期').on_time, null);
    assert.equal(find('来源变更失效').completed, false, 'done set by a stale approval is not reclassified as a historical mark');
    assert.equal(find('延期未完成节点').completed, false); assert.equal(find('延期未完成节点').effective_due, addDays(today, 10));
    assert.equal(find('延期未完成节点').plan_due, addDays(today, -5)); assert.equal(find('延期未完成节点').overdue, false);
    assert.equal(result.totals.completion_rate, 25);
  });
  await t.test('legacy null project type stays residential in denominators and filter options without rewriting data', async () => {
    const residential = await projectPlanStatistics(pool, ops, { kind: 'res', project_id: 'other-phase' });
    assert.equal(residential.totals.total, 1); assert.equal(residential.rows[0].project_id, 'other-phase');
    assert.equal(residential.options.projects.find(project => project.id === 'other-phase').project_type, 'res');
    const business = await projectPlanStatistics(pool, ops, { kind: 'com', project_id: 'other-phase' });
    assert.equal(business.totals.total, 0); assert.equal(business.options.projects.some(project => project.id === 'other-phase'), false);
    assert.equal((await admin.query("SELECT project_type FROM public.projects WHERE id='other-phase'")).rows[0].project_type, null);
  });
  await t.test('all filters feed the same row set and summary, with calendar validation', async () => {
    const result = await projectPlanStatistics(pool, ops, { kind: 'res', project_id: 'demo-res', display_group: '匿名住宅展示组', discipline: '工程', key_only: true,
      level: '一级', completion: 'incomplete', risk: 'insufficient', date_mode: 'custom', start: addDays(today, -10), end: today });
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].title, '缺预计日期');
    assert.equal(result.totals.total, result.rows.length); assert.equal(result.projects[0].total, result.rows.length);
    for (const date_mode of ['week', 'month', 'next30']) {
      const dated = await projectPlanStatistics(pool, ops, { kind: 'res', date_mode });
      assert.ok(dated.rows.every(row => row.plan_due >= dated.filters.start && row.plan_due <= dated.filters.end));
    }
    for (const bad of [{ date_mode: 'custom', start: '2026-02-30', end: '2026-03-01' }, { key_only: 'true' }, { month: '2026-13' }, { unexpected: '' }])
      await assert.rejects(projectPlanStatistics(pool, ops, bad), error => error.status === 400);
  });
  await t.test('manager read-only statistics use original RLS even when display group contains other phases', async () => {
    await admin.query("UPDATE public.profiles SET project_id='demo-res' WHERE user_id='demo-pzo'");
    await admin.query("DELETE FROM public.project_members WHERE user_id='demo-pzo'");
    for (const id of ['demo-ops', 'demo-president']) assert.equal((await projectPlanStatistics(pool, { id }, { display_group: '匿名住宅展示组' })).totals.project_count, 2);
    const result = await projectPlanStatistics(pool, { id: 'demo-pzo' }, { display_group: '匿名住宅展示组' });
    assert.equal(result.totals.project_count, 1); assert.ok(result.rows.every(row => row.project_id === 'demo-res'));
    assert.equal(result.options.projects.some(row => row.id === 'other-phase'), false);
    await assert.rejects(projectPlanStatistics(pool, { id: 'demo-pzo' }, { project_id: 'other-phase' }), error => error.status === 403);
    await assert.rejects(projectPlanStatistics(pool, pm, {}), error => error.status === 403);
  });

  const items = [
    { source_id: 'unreported', mod: '一组', name: '未报确认事项', due: addDays(today, -2) },
    { source_id: 'approved', mod: '一组', name: '审核完成事项', due: addDays(today, -5) },
    { source_id: 'extension', mod: '一组', name: '批准延期事项', due: addDays(today, -5) },
    { source_id: 'prose', mod: '二组', name: '文字自称完成', due: today },
    { source_id: 'undated', mod: '二组', name: '缺计划时间事项', due: '' },
    { source_id: 'legacy', mod: '二组', name: '兼容既有反馈审核', due: addDays(today, -5) }
  ];
  const previous = addDays(monday, -7), future = addDays(monday, 7);
  // This snapshot predates confirmation, as existing production reports do.
  const old = (await executeDatabase(pool, commercial, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'demo-com', period: previous, line, biz: { monthly_plan_month: month, items: [{ ...items[5], prog: '历史反馈', blocker: '' }] }
  } }))[0];
  const plan = await confirmMonthlyPlan(pool, commercial, { project_id: 'demo-com', line, month, items });
  const monthly = id => 'monthly:demo-com:' + plan.id + ':' + id;
  const ext = await request(pool, commercial, monthly('approved'), { request_type: 'extension', requested_due: addDays(today, 5) });
  await reviewCompletion(pool, ops, approval(ext));
  const complete = await request(pool, commercial, monthly('approved'), { completion_date: today });
  await reviewCompletion(pool, ops, approval(complete));
  const notComplete = await request(pool, commercial, monthly('extension'), { request_type: 'extension', requested_due: addDays(today, 7) });
  await reviewCompletion(pool, ops, approval(notComplete));
  await executeDatabase(pool, commercial, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'demo-com', period: monday, line, biz: { monthly_plan_id: plan.id, monthly_plan_month: month,
      items: items.map(item => ({ ...item, prog: item.source_id === 'prose' ? '已完成' : ['approved', 'extension'].includes(item.source_id) ? '本周进展' : '', blocker: '' })) }
  } });
  // Legacy reports remain separate snapshots; only exact ids and fixed fields
  // can supply feedback or an existing approval for this denominator item.
  const legacyKey = 'plan:demo-com:' + old.id + ':items:legacy';
  const oldCompletion = await request(pool, commercial, legacyKey, { completion_date: addDays(today, -6) });
  await reviewCompletion(pool, ops, approval(oldCompletion));
  // A future week can cross a month boundary. Its feedback must reference that
  // month's own confirmation rather than bypass the monthly identity guard.
  const futureMonth = future.slice(0, 7);
  const futurePlan = futureMonth === month ? plan : await confirmMonthlyPlan(pool, commercial, { project_id: 'demo-com', line, month: futureMonth, items });
  await executeDatabase(pool, commercial, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'demo-com', period: future, line, biz: { monthly_plan_id: futurePlan.id, monthly_plan_month: futureMonth, items: items.map(item => ({ ...item, prog: item.source_id === 'unreported' ? '未来周反馈不得倒灌' : '', blocker: '' })) }
  } });
  await t.test('original monthly and report approval sources remain separate from the new baseline inventory', async () => {
    const monthlyBefore = await previewCompletion(pool, commercial, { source_key: monthly('approved') });
    const reportBefore = await previewCompletion(pool, commercial, { source_key: legacyKey });
    const result = await projectPlanStatistics(pool, ops, { kind: 'com', month, project_id: 'demo-com' });
    assert.equal(result.source, 'com_baseline');
    assert.ok(result.rows.every(row => row.source_key.startsWith('milestone:demo-com:')));
    assert.ok(result.rows.every(row => row.source_id !== 'unreported' && row.source_id !== 'legacy'));
    assert.equal((await previewCompletion(pool, commercial, { source_key: monthly('approved') })).source_version, monthlyBefore.source_version);
    assert.equal((await previewCompletion(pool, commercial, { source_key: legacyKey })).source_version, reportBefore.source_version);
    assert.equal((await admin.query('SELECT source_key FROM public.completion_requests WHERE id=$1', [oldCompletion.id])).rows[0].source_key, legacyKey);
    assert.equal((await admin.query('SELECT source_key,status FROM public.completion_requests WHERE id=$1', [complete.id])).rows[0].status, 'approved');
    const saved = (await admin.query('SELECT items FROM public.monthly_plans WHERE id=$1', [plan.id])).rows[0];
    assert.equal(saved.items.length, items.length);
    assert.deepEqual(saved.items.map(item => item.source_id), items.map(item => item.source_id));
    const reports = (await admin.query('SELECT biz FROM public.reports WHERE project_id=$1', ['demo-com'])).rows;
    assert.ok(reports.some(report => report.biz.items.some(item => item.prog === '未来周反馈不得倒灌')));
    assert.ok(reports.some(report => report.biz.items.some(item => item.prog === '已完成')));
  });

  await admin.query("DELETE FROM public.milestones WHERE project_id='demo-com'");
  const businessNodes = (await admin.query(`INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,line,discipline,biz_line,is_key,level,done) VALUES
    ('demo-com','未报确认事项',$1,$2,'工程','工程',$3,false,'二级',false),
    ('demo-com','基准审核完成',$4,$4,'工程','工程',$3,true,'一级',false),
    ('demo-com','基准批准延期',$4,$4,'工程','工程',$3,false,'二级',false),
    ('demo-com','基准历史完成',$4,NULL,'工程','工程',NULL,false,'二级',true),
    ('demo-com','缺原计划日期',NULL,NULL,'工程','工程','成本',false,'二级',false),
    ('demo-com','缺预计日期',$5,NULL,'工程','工程',NULL,false,'二级',false),
    ('demo-com','按时到期未完成',$6,$6,'设计','设计',$3,true,'一级',false)
    RETURNING id::text AS id,name`, [addDays(today, 50), addDays(today, 65), line, addDays(today, -5), addDays(today, -1), today])).rows;
  const businessKey = name => 'milestone:demo-com:' + businessNodes.find(row => row.name === name).id;
  const baselineComplete = await request(pool, commercial, businessKey('基准审核完成'), { completion_date: addDays(today, -6) });
  await reviewCompletion(pool, ops, approval(baselineComplete));
  const baselineExtension = await request(pool, commercial, businessKey('基准批准延期'), { request_type: 'extension', requested_due: addDays(today, 7) });
  await reviewCompletion(pool, ops, approval(baselineExtension));
  const approvedSource = await previewCompletion(pool, commercial, { source_key: businessKey('基准审核完成') });
  // Module attribution is display metadata. It must not alter source hashes or
  // grant milestone claim rights, which still follow the original line ACL.
  await admin.query("UPDATE public.milestones SET biz_line='成本',discipline='设计' WHERE id=$1", [businessNodes.find(row => row.name === '基准审核完成').id]);
  await t.test('commercial baseline uses all dates and all nodes, exact identities and unchanged approval hashes', async () => {
    const result = await projectPlanStatistics(pool, ops, { kind: 'com', project_id: 'demo-com', month: '2000-01' });
    assert.equal(result.source, 'com_baseline'); assert.equal(result.totals.total, 7);
    assert.equal(result.totals.completed, 2); assert.equal(result.totals.incomplete, 5);
    assert.equal(result.totals.forecast_delayed, 1); assert.equal(result.totals.insufficient, 3);
    assert.equal(result.totals.on_time, 1); assert.equal(result.totals.timeliness_covered, 1); assert.equal(result.totals.timeliness_unknown, 1);
    const find = title => result.rows.find(row => row.title === title);
    assert.equal(find('未报确认事项').plan_due, addDays(today, 50), 'same-named monthly item cannot supply the baseline date');
    assert.equal(find('未报确认事项').risk, 'severe'); assert.equal(find('未报确认事项').is_key, false);
    assert.equal(find('未报确认事项').progress, undefined, 'monthly feedback is never borrowed');
    assert.equal(result.filters.month, undefined, 'confirmed month is not a baseline filter');
    assert.equal(find('基准审核完成').completed, true); assert.equal(find('基准审核完成').discipline, '成本');
    assert.equal(find('基准审核完成').module, '成本'); assert.equal(find('基准审核完成').risk, 'completed');
    assert.equal(find('基准历史完成').completion_basis, 'legacy'); assert.equal(find('基准历史完成').on_time, null);
    assert.equal(find('基准历史完成').discipline, '未归属'); assert.equal(find('缺预计日期').overdue, true);
    assert.equal(find('缺预计日期').deviation, null); assert.equal(find('缺原计划日期').plan_due, '');
    assert.equal(find('基准批准延期').completed, false); assert.equal(find('基准批准延期').effective_due, addDays(today, 7));
    assert.equal(find('基准批准延期').plan_due, addDays(today, -5)); assert.equal(find('基准批准延期').overdue, false);
    assert.deepEqual(result.options.disciplines, ['土建工程（东地块）', '成本', '未归属']);
    assert.equal((await previewCompletion(pool, commercial, { source_key: businessKey('基准审核完成') })).source_version, approvedSource.source_version);
    await assert.rejects(previewCompletion(pool, commercial, { source_key: businessKey('按时到期未完成') }), error => error.status === 403);
    const otherMonth = await projectPlanStatistics(pool, ops, { kind: 'com', project_id: 'demo-com', month: '2099-12' });
    assert.deepEqual(otherMonth.rows.map(row => row.source_key), result.rows.map(row => row.source_key));
  });
  await t.test('commercial module, key, level, risk and original-date filters share the summary denominator', async () => {
    const filter = { kind: 'com', project_id: 'demo-com', discipline: line, key_only: true, level: '一级', completion: 'incomplete', date_mode: 'custom', start: today, end: today };
    const result = await projectPlanStatistics(pool, ops, filter);
    assert.equal(result.totals.total, 1); assert.equal(result.rows[0].title, '按时到期未完成'); assert.equal(result.projects[0].total, 1);
    assert.equal((await projectPlanStatistics(pool, ops, { kind: 'com', discipline: '未归属' })).totals.total, 2);
    assert.equal((await projectPlanStatistics(pool, ops, { kind: 'com', risk: 'severe' })).totals.total, 1);
    for (const date_mode of ['week', 'month', 'next30']) {
      const dated = await projectPlanStatistics(pool, ops, { kind: 'com', date_mode });
      assert.ok(dated.rows.every(row => row.plan_due && row.plan_due >= dated.filters.start && row.plan_due <= dated.filters.end));
      assert.equal(dated.totals.total, dated.rows.length);
    }
    await reviewCompletion(pool, ops, { ...approval({ ...baselineComplete, revision: baselineComplete.revision + 1 }), decision: 'reopen', note: '匿名重开验证' });
    assert.equal((await projectPlanStatistics(pool, ops, { kind: 'com' })).totals.completed, 1);
    assert.equal((await admin.query('SELECT source_key FROM public.completion_requests WHERE id=$1', [oldCompletion.id])).rows[0].source_key, legacyKey);
  });
});

test('unified baseline statistics combine allowed project types without merging duplicate names or changing approval semantics', async t => {
  // A fresh anonymous database with no live environment, files or mail service.
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  const today = (await projectPlanStatistics(pool, ops)).today, originalDue = addDays(today, -5), extendedDue = addDays(today, 7);
  await admin.query("UPDATE public.projects SET name='同名项目',display_group='混合展示组' WHERE id IN ('demo-res','demo-com')");
  await admin.query("INSERT INTO public.projects(id,name,project_type,display_group) VALUES('legacy-res','原类型未填写项目',NULL,'另一展示组'),('hidden-com','其他负责人的商业项目','com','混合展示组'),('empty-com','尚未导入基准的商业项目','com','无基准商业组')");
  await admin.query("DELETE FROM public.milestones WHERE project_id IN ('demo-res','demo-com')");
  const nodes = (await admin.query(`INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,line,discipline,biz_line,is_key,level) VALUES
    ('demo-res','同名基准节点',$1,$1,'工程','工程','成本',true,'一级'),
    ('demo-com','同名基准节点',$1,$1,'工程','设计','机电工程',true,'一级'),
    ('hidden-com','同名基准节点',$2,$2,'工程','工程','开发',false,'二级'),
    ('legacy-res','旧项目基准节点',$3,$3,'设计','设计',NULL,false,'二级')
    RETURNING id::text AS id,project_id`, [originalDue, today, addDays(today, 2)])).rows;
  const key = pid => 'milestone:' + pid + ':' + nodes.find(node => node.project_id === pid).id;
  const completed = await request(pool, pm, key('demo-res'), { completion_date: addDays(today, -6) });
  await reviewCompletion(pool, ops, approval(completed));
  const extension = await request(pool, commercial, key('demo-com'), { request_type: 'extension', requested_due: extendedDue });
  await reviewCompletion(pool, ops, approval(extension));
  await confirmMonthlyPlan(pool, commercial, { project_id: 'demo-com', line: '土建工程（东地块）', month: today.slice(0, 7),
    items: [{ source_id: 'monthly-only-source', name: '只有月计划中的事项', mod: '月计划模块', due: originalDue }] });
  const before = async () => (await admin.query("SELECT jsonb_build_object('nodes',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.milestones n),'approvals',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.completion_requests c),'monthly',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.monthly_plans m)) AS value")).rows[0].value;
  const original = await before();

  await t.test('default and explicit all use every original baseline and expose commercial display groups even before an import', async () => {
    const result = await projectPlanStatistics(pool, ops), explicit = await projectPlanStatistics(pool, ops, { kind: 'all' });
    assert.equal(result.source, 'all_baseline'); assert.equal(result.filters.kind, 'all');
    assert.deepEqual(explicit.rows, result.rows); assert.equal(result.totals.total, 4); assert.equal(result.totals.project_count, 4);
    assert.equal(result.totals.completed, 1); assert.equal(result.totals.incomplete, 3); assert.equal(result.totals.completion_rate, 25);
    assert.deepEqual(new Set(result.options.projects.map(project => project.id)), new Set(['demo-res', 'demo-com', 'legacy-res', 'hidden-com', 'empty-com']));
    assert.deepEqual(new Set(result.options.groups), new Set(['混合展示组', '另一展示组', '无基准商业组']));
    assert.equal(result.options.projects.find(project => project.id === 'empty-com').project_type, 'com');
    assert.ok(result.rows.every(row => row.source_key.startsWith('milestone:')));
    assert.ok(result.rows.every(row => row.title !== '只有月计划中的事项'));
    assert.equal(result.rows.find(row => row.project_id === 'legacy-res').project_type, 'res');
    assert.equal(result.projects.find(project => project.id === 'legacy-res').project_type, 'res');
    assert.equal((await admin.query("SELECT project_type FROM public.projects WHERE id='legacy-res'")).rows[0].project_type, null);
    const empty = await projectPlanStatistics(pool, ops, { display_group: '无基准商业组' });
    assert.equal(empty.totals.total, 0); assert.equal(empty.totals.completion_rate, null); assert.deepEqual(empty.rows, []);
  });

  await t.test('mixed-group rows, project comparisons and totals share exact project IDs and original-date filters', async () => {
    const result = await projectPlanStatistics(pool, ops, { display_group: '混合展示组' });
    assert.equal(result.totals.total, 3); assert.equal(result.totals.project_count, 3); assert.equal(result.totals.group_count, 1);
    assert.equal(result.totals.completed, 1); assert.equal(result.totals.incomplete, 2);
    assert.equal(result.projects.reduce((total, project) => total + project.total, 0), result.totals.total);
    assert.equal(result.projects.reduce((total, project) => total + project.completed, 0), result.totals.completed);
    const duplicates = result.projects.filter(project => project.name === '同名项目');
    assert.equal(duplicates.length, 2); assert.deepEqual(new Set(duplicates.map(project => project.id)), new Set(['demo-res', 'demo-com']));
    assert.deepEqual(new Set(duplicates.map(project => project.project_type)), new Set(['res', 'com']));
    const residential = result.rows.find(row => row.project_id === 'demo-res'), business = result.rows.find(row => row.project_id === 'demo-com');
    assert.equal(residential.discipline, '工程'); assert.equal(residential.module, ''); assert.equal(residential.project_type, 'res');
    assert.equal(residential.completed, true); assert.equal(residential.completion_basis, 'approval'); assert.equal(residential.on_time, true);
    assert.equal(business.discipline, '机电工程'); assert.equal(business.module, '机电工程'); assert.equal(business.project_type, 'com');
    assert.equal(business.extension_approved, true); assert.equal(business.completed, false); assert.equal(business.plan_due, originalDue);
    assert.equal(business.effective_due, extendedDue); assert.equal(business.overdue, false);
    const filtered = await projectPlanStatistics(pool, ops, { display_group: '混合展示组', discipline: '机电工程', key_only: true, level: '一级',
      completion: 'incomplete', date_mode: 'custom', start: originalDue, end: today });
    assert.equal(filtered.totals.total, 1); assert.equal(filtered.rows[0].project_id, 'demo-com'); assert.equal(filtered.projects[0].total, 1);
    assert.equal((await projectPlanStatistics(pool, ops, { discipline: '成本' })).totals.total, 0, 'residential classification never borrows its commercial attribution field');
    assert.equal((await previewCompletion(pool, pm, { source_key: key('demo-res') })).source_version, completed.source_version);
  });

  await t.test('explicit residential and commercial requests retain compatible partitions and source identifiers', async () => {
    const all = await projectPlanStatistics(pool, ops), res = await projectPlanStatistics(pool, ops, { kind: 'res' }), com = await projectPlanStatistics(pool, ops, { kind: 'com' });
    assert.equal(res.source, 'res_baseline'); assert.equal(com.source, 'com_baseline');
    assert.ok(res.rows.every(row => row.project_type === 'res')); assert.ok(com.rows.every(row => row.project_type === 'com'));
    assert.equal(all.totals.total, res.totals.total + com.totals.total);
    assert.equal(all.totals.completed, res.totals.completed + com.totals.completed);
    assert.deepEqual(new Set(all.rows.map(row => row.source_key)), new Set([...res.rows, ...com.rows].map(row => row.source_key)));
    await assert.rejects(projectPlanStatistics(pool, ops, { kind: 'other' }), error => error.status === 400);
  });

  await t.test('project managers see only their primary and explicitly assigned projects across both types', async () => {
    await admin.query("UPDATE public.profiles SET project_id='demo-res' WHERE user_id='demo-pzo'");
    await admin.query("DELETE FROM public.project_members WHERE user_id='demo-pzo'");
    await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pzo','demo-com')");
    const result = await projectPlanStatistics(pool, { id: 'demo-pzo' }, { display_group: '混合展示组' });
    assert.equal(result.source, 'all_baseline'); assert.equal(result.totals.total, 2); assert.equal(result.totals.project_count, 2);
    assert.deepEqual(new Set(result.rows.map(row => row.project_id)), new Set(['demo-res', 'demo-com']));
    assert.deepEqual(new Set(result.options.projects.map(project => project.id)), new Set(['demo-res', 'demo-com']));
    assert.deepEqual(new Set(result.projects.map(project => project.project_type)), new Set(['res', 'com']));
    await assert.rejects(projectPlanStatistics(pool, { id: 'demo-pzo' }, { project_id: 'hidden-com' }), error => error.status === 403);
    for (const id of ['demo-ops', 'demo-president']) assert.equal((await projectPlanStatistics(pool, { id }, { display_group: '混合展示组' })).totals.project_count, 3);
    await assert.rejects(projectPlanStatistics(pool, pm), error => error.status === 403);
  });
  assert.deepEqual(await before(), original, 'statistics reads do not rewrite baselines, monthly sources or audit history');
});
