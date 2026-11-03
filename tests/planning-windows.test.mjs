import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';

const sandbox = { window: {} };
vm.runInNewContext(await readFile(new URL('../web/planning-windows.js', import.meta.url), 'utf8'), sandbox);
const W = sandbox.window.PlanningWindows;
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy week-only labels retain the same report scope and month as dated labels', () => {
  assert.equal(W.periodStart('第43周', '2026-10-21'), '2026-10-19');
  assert.equal(W.samePeriod('第43周', '第43周（10.19–10.25）', '2026-10-21', '2026-10-21'), true);
  assert.equal(W.periodStart('第1周', '2027-01-02'), '2027-01-04');
  assert.equal(W.periodStart('第53周', '2027-01-02'), '2026-12-28');
  assert.equal(W.periodStart('第54周', '2026-10-21'), '');
});

test('report week and rolling month use calendar boundaries across months, years and leap days', () => {
  assert.deepEqual(plain(W.windowFor('2026-10-19', 'week')), { start: '2026-10-19', end: '2026-10-25', exclusiveEnd: '2026-10-26' });
  assert.deepEqual(plain(W.windowFor('2026-10-19', 'month')), { start: '2026-10-19', end: '2026-11-18', exclusiveEnd: '2026-11-19' });
  assert.deepEqual(plain(W.windowFor('2026-12-28', 'week')), { start: '2026-12-28', end: '2027-01-03', exclusiveEnd: '2027-01-04' });
  assert.equal(W.windowFor('2026-01-31', 'month').exclusiveEnd, '2026-02-28');
  assert.equal(W.windowFor('2024-01-31', 'month').exclusiveEnd, '2024-02-29');
  assert.equal(W.addMonth('2024-12-31'), '2025-01-31');
  assert.equal(W.todayShanghai('2026-12-31T16:05:00Z'), '2027-01-01');
  assert.equal(W.monday('2027-01-03'), '2026-12-28');
  assert.equal(W.windowFor('2026-02-30', 'week'), null);
  assert.equal(W.windowFor('2026-10-19', 'year'), null);
});

test('period identity includes the calendar year and anchors legacy labels to report creation', () => {
  const selected = '第43周（10.19–10.25）';
  assert.equal(W.periodStart(selected, '2026-10-21T07:00:00Z'), '2026-10-19');
  assert.equal(W.periodStart('第53周（12.28–01.03）', '2027-01-02'), '2026-12-28');
  assert.equal(W.periodStart('第43周（2026.10.19–2026.10.25）'), '2026-10-19');
  assert.equal(W.samePeriod(selected, selected, '2026-10-21', '2026-10-23'), true);
  assert.equal(W.samePeriod('第1周（12.30–01.05）', '第1周（12.29–01.04）', '2025-01-03', '2026-01-02'), false);
  assert.equal(W.periodStart('第43周', '2026-10-21'), '2026-10-19');
  assert.equal(W.samePeriod('第43周', '第43周', '2025-10-21', '2026-10-21'), false);
});

test('automatic nodes require explicit scope, stable identity and the baseline plan date', () => {
  const rows = [
    { id: 1, project_id: 'alpha', name: '节点甲', plan_date: '2026-10-19', forecast_date: '2026-12-01', is_key: true, discipline: '工程' },
    { id: 2, project_id: 'alpha', name: '节点乙', plan_date: '2026-11-18', is_key: true, discipline: '工程', done: true },
    { id: 3, project_id: 'alpha', name: '截止外节点', plan_date: '2026-11-19', is_key: true, discipline: '工程' },
    { id: 4, project_id: 'alpha', name: '未分配节点', plan_date: '2026-10-20', is_key: true, line: '工程', owner_name: '工程责任人' },
    { id: 5, project_id: 'alpha', name: '其他专业', plan_date: '2026-10-20', is_key: true, discipline: '设计' },
    { id: 6, project_id: 'private', name: '无权项目', plan_date: '2026-10-20', is_key: true, discipline: '工程' },
    { id: 7, project_id: 'alpha', name: '普通节点', plan_date: '2026-10-20', is_key: false, discipline: '工程' },
    { id: 8, project_id: 'beta', name: '商业明确节点', plan_date: '2026-10-21', is_key: true, line: '工程', biz_line: '机电工程' },
    { id: 9, project_id: 'beta', name: '商业未分配节点', plan_date: '2026-10-21', is_key: true, line: '工程' }
  ];
  const options = { projectId: 'alpha', discipline: '工程', window: W.windowFor('2026-10-19', 'month') };
  assert.deepEqual(plain(W.scopedMilestones(rows, options).map(row => row.id)), [1, 2]);
  assert.deepEqual(plain(W.scopedMilestones(rows, { ...options, discipline: '' })), []);
  assert.deepEqual(plain(W.scopedMilestones(rows, { ...options, allScopes: true, includeUnassigned: true }).map(row => row.id)), [1, 4, 5, 2]);
  assert.deepEqual(plain(W.scopedMilestones(rows, { projectId: 'beta', commercial: true, bizLine: '机电工程', window: options.window }).map(row => row.id)), [8]);
  assert.deepEqual(plain(W.scopedMilestones(rows, { projectId: 'beta', commercial: true, bizLine: '土建工程（东地块）', window: options.window })), []);
});

test('prefill preserves submitted snapshots, draft text, rich text and manual rows without name rebinding', () => {
  const baselines = [{ id: 10, name: '基准新名称', plan_date: '2026-10-20', forecast_date: '2026-10-21', is_key: true },
    { id: 11, name: '同名手填节点', plan_date: '2026-10-22', is_key: true }];
  const saved = [{ milestone_id: 10, name: '提交时名称', plan: '2026-10-19', prog: '保留填报进展', _rich: { prog: { v: 1 } } },
    { name: '同名手填节点', custom: true, prog: '手填内容' }];
  const before = JSON.stringify(saved);
  for (const flags of [{ submitted: true }, { edited: true }]) {
    const result = W.prefillNodes(saved, baselines, flags);
    assert.equal(JSON.stringify(result.rows), before);
    assert.equal(result.rows[0], saved[0]);
    assert.deepEqual(plain(result.additions.map(row => row.milestone_id)), [11]);
  }
  const blank = W.prefillNodes([], baselines, {});
  assert.equal(blank.rows.length, 2);
  assert.equal(blank.rows[0].milestone_id, 10);
  assert.equal(blank.rows[0].prog, '');
  assert.equal(JSON.stringify(saved), before);
});

test('display grouping aggregates only the supplied authorized children and preserves original identities', () => {
  const a = { id: 'child-a', name: '甲期', display_group: '组甲' }, b = { id: 'child-b', name: '乙期', display_group: '组甲' };
  const grouped = W.groupProjects([a, b, { id: 'child-c', name: '独立项目' }]);
  assert.deepEqual(plain(grouped.map(group => ({ name: group.name, ids: group.projects.map(project => project.id) }))), [
    { name: '组甲', ids: ['child-a', 'child-b'] }, { name: '独立项目', ids: ['child-c'] }
  ]);
  assert.equal(grouped[0].projects[0], a);
  assert.deepEqual(plain(W.groupProjects([a])[0].projects.map(project => project.id)), ['child-a']);
});

test('scope migration is additive and repeatable while API and database keep PM scope edits forbidden', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name) VALUES('scope-fixture','匿名住宅'),('hidden-fixture','未授权住宅')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES('scope-operator','匿名运营','ops','approved',NULL),('scope-reporter','匿名填报人','pm','approved','工程')");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('scope-reporter','scope-fixture')");
  const milestone = (await admin.query("INSERT INTO public.milestones(project_id,name,plan_date,line,note) VALUES('scope-fixture','原节点','2026-10-20','工程','原说明') RETURNING id")).rows[0];
  const metadata = async () => (await admin.query("SELECT oid,proowner,proacl::text AS acl,prosrc FROM pg_proc WHERE oid='app_private.guard_milestone_update()'::regprocedure")).rows;
  const before = await metadata();
  const migration = await readFile(new URL('../db/015-admin-plan-scopes.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  assert.deepEqual(await metadata(), before);
  const initial = (await admin.query('SELECT name,line,note,discipline,biz_line FROM public.milestones WHERE id=$1', [milestone.id])).rows[0];
  assert.deepEqual(initial, { name: '原节点', line: '工程', note: '原说明', discipline: null, biz_line: null });
  await executeDatabase(pool, { id: 'scope-operator' }, { table: 'projects', operation: 'update', values: { display_group: '匿名展示组' }, filters: [{ column: 'id', value: 'scope-fixture' }] });
  await executeDatabase(pool, { id: 'scope-operator' }, { table: 'milestones', operation: 'update', values: { discipline: '工程', biz_line: null }, filters: [{ column: 'id', value: milestone.id }] });
  await assert.rejects(executeDatabase(pool, { id: 'scope-reporter' }, { table: 'milestones', operation: 'update', values: { discipline: '设计' }, filters: [{ column: 'id', value: milestone.id }] }), error => error.status === 403);
  await assert.rejects(withIdentity(pool, 'scope-reporter', client => client.query('UPDATE public.milestones SET biz_line=$1 WHERE id=$2', ['机电工程', milestone.id])), error => error.code === '42501');
  await assert.rejects(executeDatabase(pool, { id: 'scope-operator' }, { table: 'milestones', operation: 'update', values: { biz_line: '*' }, filters: [{ column: 'id', value: milestone.id }] }), error => error.status === 400);
  await assert.rejects(executeDatabase(pool, { id: 'scope-operator' }, { table: 'projects', operation: 'update', values: { display_group: ' 组甲' }, filters: [{ column: 'id', value: 'scope-fixture' }] }), error => error.status === 400);
  const visible = await executeDatabase(pool, { id: 'scope-reporter' }, { table: 'projects', columns: 'id,display_group' });
  assert.deepEqual(visible, [{ id: 'scope-fixture', display_group: '匿名展示组' }]);
  const other = (await admin.query("INSERT INTO public.milestones(project_id,name,discipline) VALUES('scope-fixture','其他专业节点','设计'),('hidden-fixture','其他项目节点','工程') RETURNING id")).rows;
  const report = milestone_id => ({ table: 'reports', operation: 'insert', values: { project_id: 'scope-fixture', period: '第43周（2026.10.19–2026.10.25）', line: '综合',
    node_items: [{ milestone_id, name: '填报节点', plan: '2026-10-20' }], biz: { nodes: [{ milestone_id, name: '填报节点', plan: '2026-10-20', prog: '保留进展' }] } } });
  for (const invalid of [other[0].id, other[1].id, '*', -1, '9223372036854775808']) {
    await assert.rejects(executeDatabase(pool, { id: 'scope-reporter' }, report(invalid)), error => error.code === 'invalid_milestone_reference');
  }
  const submitted = (await executeDatabase(pool, { id: 'scope-reporter' }, report(milestone.id)))[0];
  await executeDatabase(pool, { id: 'scope-operator' }, { table: 'milestones', operation: 'update', values: { discipline: '设计' }, filters: [{ column: 'id', value: milestone.id }] });
  const preserved = (await executeDatabase(pool, { id: 'scope-reporter' }, { table: 'reports', operation: 'update', values: { node_items: submitted.node_items, biz: submitted.biz }, filters: [{ column: 'id', value: submitted.id }] }))[0];
  assert.equal(String(preserved.node_items[0].milestone_id), String(milestone.id));
  assert.equal(preserved.biz.nodes[0].prog, '保留进展', 'later baseline scope changes must not invalidate the saved report snapshot');
});

test('app baseline integration keeps empty report snapshots, stable node identity and authorized grouped children', async () => {
  const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const elements = { root: { innerHTML: '' } };
  const context = { console, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    document: { getElementById: id => elements[id] || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ auth: {}, database: {} }) } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('../web/planning-windows.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../web/baseline-core.js', import.meta.url), 'utf8'), context);
  const boundary = appSource.indexOf('  (async function boot() {');
  assert.ok(boundary > 0);
  vm.runInContext(appSource.slice(0, boundary) + '\nwindow.__plan={S,dataState,configureReporter,prepareWindowNodes,personalWindowNodes,overviewNodeHtml,overviewProjectGroups,bizNodeOptions,currentPeriod};\n})();', context);
  const h = context.__plan, state = h.S;
  h.dataState.milestones = {ready:true}; h.configureReporter();
  state.uid = 'anonymous-plan-reporter';
  state.profile = { user_id: state.uid, role: 'pm', status: 'approved', discipline: '工程' };
  state.projects = [{ id: 'alpha', name: '匿名一期', display_group: '匿名组' }, { id: 'hidden', name: '匿名二期', display_group: '匿名组' }];
  state.pmProject = 'alpha'; state.pmLine = '综合'; state.pmPeriod = h.currentPeriod();
  const week = context.PlanningWindows.windowFor(context.PlanningWindows.periodStart(state.pmPeriod), 'week');
  state.milestones = [{ id: 101, project_id: 'alpha', name: '本周已归属节点', plan_date: week.start, forecast_date: week.end, is_key: true, discipline: '工程' },
    { id: 102, project_id: 'alpha', name: '未分配节点', plan_date: week.start, is_key: true, line: '工程' },
    { id: 103, project_id: 'hidden', name: '其他项目节点', plan_date: week.start, is_key: true, discipline: '工程' }];
  state.bizNodes = []; state.pmReport = null; state.draftRestored = false;
  h.prepareWindowNodes();
  assert.deepEqual(plain(state.bizNodes), [], 'the read-only baseline projection must not populate report nodes');
  assert.deepEqual(plain(h.personalWindowNodes().map(node => node.id)), [101], 'the original explicit scope and stable baseline IDs remain available');
  state.pmReport = { id: 'empty-snapshot', period: state.pmPeriod, biz: { nodes: [] } }; state.bizNodes = [];
  h.prepareWindowNodes();
  assert.deepEqual(plain(state.bizNodes), []);
  assert.deepEqual(plain(state.pendingBaselineNodes), [], 'an empty submitted snapshot remains empty and has no editable prefill queue');
  const html = h.overviewNodeHtml([], 'alpha', '工程', false);
  assert.match(html, /本周已归属节点/); assert.match(html, /预计完成日/);
  assert.doesNotMatch(html, /当周节点进展|报告保留进展/, 'management baseline projection must not expose personal feedback');
  assert.doesNotMatch(html, /其他项目节点|未分配节点/);
  state.profile.role = 'pzo'; state.profile.project_id = 'alpha'; state.pms = [];
  assert.deepEqual(plain(h.overviewProjectGroups().map(group => group.projects.map(project => project.id))), [['alpha']]);
  state.profile.role = 'pm'; state.profile.discipline = '';
  assert.deepEqual(plain(h.bizNodeOptions('alpha')), [], 'an unassigned reporter cannot bind unassigned baseline nodes');
  const report = { id: 'report-snapshot', project_id: 'alpha', author_name: '匿名填报人', biz: { nodes: [{ milestone_id: 101, name: '提交时节点', plan: week.start, forecast: '', prog: '报告保留进展' }] } };
  const before = plain(report), snapshotHtml = h.overviewNodeHtml([report], 'alpha', '工程', false);
  assert.match(snapshotHtml, new RegExp('<td[^>]*data-label="预计完成日（原保存）"[^>]*>' + week.end + '</td>'), 'management projection uses the original baseline forecast');
  assert.doesNotMatch(snapshotHtml, /提交时节点|报告保留进展/);
  assert.deepEqual(plain(report), before, 'reading the baseline must not fill a blank saved report forecast');
});

test('app current report week follows Shanghai Monday in a UTC browser at the Sunday boundary', async () => {
  // Give the actual app a UTC browser calendar while freezing the instant at
  // Shanghai Monday 00:30. This detects using browser-local currentPeriod().
  class UTCBrowserDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-25T16:30:00Z'])); }
    getFullYear() { return this.getUTCFullYear(); }
    getMonth() { return this.getUTCMonth(); }
    getDate() { return this.getUTCDate(); }
    getDay() { return this.getUTCDay(); }
    setDate(value) { return this.setUTCDate(value); }
  }
  const context = { console, Date: UTCBrowserDate, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    document: { getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ auth: {}, database: {} }) } };
  context.window = context; vm.createContext(context);
  vm.runInContext(await readFile(new URL('../web/planning-windows.js', import.meta.url), 'utf8'), context);
  const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const boundary = appSource.indexOf('  (async function boot() {');
  vm.runInContext(appSource.slice(0, boundary) + '\nwindow.__period={currentPeriod,periodList,S};\n})();', context);
  assert.equal(context.__period.currentPeriod(), '第44周（10.26–11.01）');
  assert.ok(context.__period.periodList().includes('第44周（10.26–11.01）'));
});
