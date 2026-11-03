import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const scripts = await Promise.all(['planning-windows.js', 'rich-text.js', 'baseline-core.js'].map(name => readFile(new URL('../web/' + name, import.meta.url), 'utf8')));
const plain = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function fixture() {
  const S = { uid: 'reporter', session: {}, projects: [{ id: 'a', name: '匿名商业甲', project_type: 'com' }, { id: 'b', name: '匿名项目乙' }],
    milestones: [], reports: [], bizNodes: [], monthlyPlans: [], bizItems: [], pmProject: 'a', pmLine: '机电工程', pmPeriod: '2026-10-19' };
  const read = { ready: true }, sandbox = { window: {} }, effects = { renders: 0, flushes: 0 };
  vm.createContext(sandbox); scripts.forEach(source => vm.runInContext(source, sandbox));
  const api = sandbox.window.BaselineCore, windows = sandbox.window.PlanningWindows;
  const options = { S, esc, baselineState: () => read, richItem: sandbox.window.ZHRichText.field,
    render: () => effects.renders++, flush: () => effects.flushes++ };
  api.configure(options);
  const scope = { projectId: 'a', line: '机电工程', commercial: true, personal: true, window: windows.windowFor('2026-10-19', 'week') };
  return { S, api, windows, options, scope, read, effects };
}
function baseline(id, values = {}) {
  return { id, project_id: 'a', name: '基准节点' + id, plan_date: '2026-10-23', forecast_date: '2026-11-01', biz_line: '机电工程', is_key: false, ...values };
}
function report(period, nodes, values = {}) {
  return { id: period, project_id: 'a', line: '机电工程', period, submitted_at: period + 'T01:00:00Z', biz: { nodes }, ...values };
}

test('commercial includes all explicit module baselines in the original week and rolling month, using original plan dates', () => {
  const h = fixture();
  h.S.milestones = [baseline(1), baseline(2, { plan_date: '2026-11-18', is_key: true }), baseline(3, { plan_date: '2026-11-19' }),
    baseline(4, { biz_line: '开发', name: '其他模块' }), baseline(5, { project_id: 'b', name: '其他项目' }),
    baseline(6, { biz_line: null, name: '未分配' }), baseline(7, { plan_date: null }), baseline(8, { plan_date: '2026-10-26' })];
  assert.deepEqual(plain(h.api.coreRows(h.scope).map(row => row.milestone.id)), [1]);
  const month = { ...h.scope, personal: false, window: h.windows.windowFor('2026-10-19', 'month') };
  assert.deepEqual(plain(h.api.coreRows(month).map(row => row.milestone.id)), [1, 8, 2]);
  assert.deepEqual(plain(h.api.coreRows({ ...month, keyOnly: true }).map(row => row.milestone.id)), [2]);
  assert.deepEqual(plain(h.api.coreRows({ ...month, line: null }).map(row => row.milestone.id)), [6]);
  assert.equal(h.api.coreState(month).missingDate, 1);
  assert.doesNotMatch(h.api.coreHtml(h.scope), /其他模块|其他项目|未分配<|基准节点7/);
});

test('cross-year personal week and rolling month keep exclusive date boundaries', () => {
  const h = fixture();
  h.S.milestones = [baseline(1, { plan_date: '2026-12-28' }), baseline(2, { plan_date: '2027-01-03' }),
    baseline(3, { plan_date: '2027-01-04' }), baseline(4, { plan_date: '2027-01-27' }), baseline(5, { plan_date: '2027-01-28' })];
  const options = { ...h.scope, window: h.windows.windowFor('2026-12-28', 'week') };
  assert.deepEqual(plain(h.api.coreRows(options).map(row => row.milestone.id)), [1, 2]);
  assert.deepEqual(plain(h.api.coreRows({ ...options, personal: false, window: h.windows.windowFor('2026-12-28', 'month') }).map(row => row.milestone.id)), [1, 2, 3, 4]);
});

test('no baseline never falls back to confirmed month plans, month drafts, same names or old handwritten rows', () => {
  const h = fixture();
  h.S.monthlyPlans = [{ project_id: 'a', line: '机电工程', items: [{ name: '月计划同名', due: '2026-10-23', prog: '月计划进展' }] }];
  h.S.bizItems = [{ name: '本机月计划草稿', due: '2026-10-23' }];
  h.S.bizNodes = [{ name: '旧手填节点', plan: '2026-10-23', prog: '历史手填反馈' }];
  h.S.reports = [report('2026-10-12', [{ name: '历史节点', plan: '2026-10-23', prog: '不能投影' }])];
  const before = JSON.stringify(h.S);
  assert.equal(h.api.coreState(h.scope).status, 'not-imported');
  const html = h.api.personalCoreHtml();
  assert.match(html, /尚未导入项目基准节点/);
  assert.doesNotMatch(html, /月计划同名|月计划进展|本机月计划草稿|旧手填节点|不能投影/);
  assert.equal(JSON.stringify(h.S), before);
});

test('read failure and pending refresh never masquerade as an unimported baseline', () => {
  const h = fixture();
  h.read.ready = false;
  assert.equal(h.api.coreState(h.scope).status, 'loading');
  assert.doesNotMatch(h.api.coreHtml(h.scope), /尚未导入/);
  h.read.error = '连接失败 <detail>';
  assert.equal(h.api.coreState(h.scope).status, 'error');
  assert.match(h.api.coreHtml(h.scope), /读取失败：连接失败 &lt;detail&gt;/);
  h.S.milestones = [baseline(1)];
  assert.equal(h.api.coreRows(h.scope).length, 0);
  delete h.read.error; h.read.ready = true;
  assert.match(h.api.coreHtml(h.scope), /基准节点1/);
});

test('module mismatch, missing dates, out-of-window and key-only empties have distinct explanations', () => {
  const h = fixture();
  h.S.milestones = [baseline(1, { biz_line: null })];
  assert.equal(h.api.coreState(h.scope).status, 'no-scope');
  assert.match(h.api.coreHtml(h.scope), /当前商业模块暂无明确匹配/);
  h.S.milestones = [baseline(1, { plan_date: '2026-02-30' })];
  assert.equal(h.api.coreState(h.scope).status, 'missing-date');
  h.S.milestones.push(baseline(2, { plan_date: '2026-10-26' }));
  assert.equal(h.api.coreState(h.scope).status, 'no-window');
  assert.match(h.api.coreHtml(h.scope), /1 个当前范围节点缺有效计划日期/);
  h.S.milestones.push(baseline(3));
  assert.equal(h.api.coreState({ ...h.scope, keyOnly: true }).status, 'no-key');
  assert.doesNotMatch(h.api.coreHtml({ ...h.scope, keyOnly: true }), /尚未导入/);
});

test('precise original project and milestone feedback preserves current blank values and rich text, without name joining', () => {
  const h = fixture();
  h.S.milestones = [baseline(1, { name: '同名事项', note: '原保存说明' }), baseline(2)];
  h.S.reports = [report('2026-10-12', [{ milestone_id: 1, name: '同名事项', prog: '旧反馈不能填空', blocker: '旧卡点' }]),
    report('2026-10-19', [{ milestone_id: 1, name: '旧快照名称', plan: '2026-01-01', prog: '', blocker: '' },
      { name: '同名事项', prog: '同名手填不得关联' }, { milestone_id: 2, prog: '加粗进展', blocker: '节点卡点' }],
    { rich_text: { v: 1, fields: { 'biz.nodes.2.prog': { ops: [{ insert: '加粗进展', attributes: { bold: true } }] } } } }),
    report('2026-10-19', [{ milestone_id: 1, prog: '其他项目同ID' }], { project_id: 'b' }),
    report('2026-10-26', [{ milestone_id: 1, prog: '未来反馈' }])];
  h.S.monthlyPlans = [{ items: [{ name: '同名事项', prog: '月计划反馈' }] }];
  const html = h.api.coreHtml(h.scope);
  assert.match(html, /原反馈留空/); assert.match(html, /<strong>加粗进展<\/strong>/);
  assert.match(html, /原计划完成日/); assert.match(html, /2026-10-23/);
  assert.match(html, /节点说明（原保存）/); assert.match(html, /预计完成日（原保存）/);
  assert.doesNotMatch(html, /旧反馈不能填空|旧卡点|同名手填不得关联|其他项目同ID|未来反馈|月计划反馈|2026-01-01/);
});

test('older exact feedback stays visibly historical and never supplies current feedback', () => {
  const h = fixture(); h.S.milestones = [baseline(1)];
  h.S.reports = [report('2026-10-12', [{ milestone_id: 1, prog: '历史进展', blocker: '' }])];
  const state = h.api.coreState(h.scope);
  assert.equal(state.rows[0].current, null);
  assert.equal(state.rows[0].previous.period, '2026-10-12');
  const html = h.api.coreHtml(h.scope);
  assert.match(html, /本周未提供节点反馈/); assert.match(html, /原节点历史反馈（2026-10-12）/);
  assert.match(html, /历史进展/);
});

test('personal exact node drafts remain read-only, preserve explicit blanks and never mutate stored rows', () => {
  const h = fixture(); h.S.milestones = [baseline(1)]; h.S.draftRestored = true;
  h.S.reports = [report('2026-10-19', [{ milestone_id: 1, prog: '服务端旧值' }])];
  h.S.bizNodes = [{ milestone_id: 1, prog: '', blocker: '原稿卡点', _rich: { blocker: { ops: [{ insert: '原稿卡点', attributes: { color: '#ff0000' } }] } } }];
  const before = JSON.stringify(h.S), html = h.api.personalCoreHtml();
  assert.match(html, /原反馈留空/); assert.match(html, /本机草稿/); assert.match(html, /原稿卡点/);
  assert.doesNotMatch(html, /服务端旧值|<input|<textarea|App.addBizNode/);
  assert.equal(JSON.stringify(h.S), before);
});

test('residential grouping keeps actual source project IDs and original key-only default', () => {
  const h = fixture();
  h.S.milestones = [baseline(1, { discipline: '工程', is_key: true }), baseline(2, { project_id: 'b', discipline: '设计', is_key: true }),
    baseline(3, { project_id: 'b', discipline: '工程' })];
  const grouped = { ...h.scope, commercial: false, personal: false, projectIds: ['a', 'b'], allScopes: true };
  h.S.reports = [report('2026-10-19', [{ milestone_id: 2, project_id: 'b', prog: '乙项目精确反馈' }])];
  assert.deepEqual(plain(h.api.coreRows(grouped).map(row => row.sourceKey)), ['milestone:a:1', 'milestone:b:2']);
  assert.match(h.api.coreHtml({ ...grouped, personal: true }), /乙项目精确反馈/);
  assert.doesNotMatch(h.api.coreHtml({ ...grouped, personal: true, reports: [] }), /乙项目精确反馈/);
  assert.doesNotMatch(h.api.coreHtml(grouped), /乙项目精确反馈/);
});

test('manager baseline reminders use four columns, fold optional baseline information and never read or display report feedback', () => {
  const h = fixture();
  h.S.milestones = [baseline(1, { note: '原保存基准说明', standard: '原完成标准', rich_text: { v: 1, fields: {
    note: { ops: [{ insert: '原保存基准说明', attributes: { bold: true } }] }
  } } }), baseline(2, { is_key: true })];
  h.S.reports = [report('2026-10-19', [{ milestone_id: 1, prog: '管理端不汇报的当周进展', blocker: '管理端不汇报的卡点' }]),
    report('2026-10-12', [{ milestone_id: 2, prog: '管理端不展示的历史反馈' }])];
  const { personal, ...scope } = h.scope;
  const manager = { ...scope, window: h.windows.windowFor('2026-10-19', 'month') }, before = JSON.stringify(h.S);
  const html = h.api.coreHtml(manager);
  assert.equal((html.match(/<th(?:\s|>)/g) || []).length, 4);
  assert.equal((html.match(/<td(?:\s|>)/g) || []).length, 8);
  assert.match(html, /data-source-key="milestone:a:1"/); assert.match(html, /data-source-key="milestone:a:2"/);
  assert.match(html, /2026-10-23/); assert.match(html, /2026-11-01/); assert.match(html, /核心基准节点范围/);
  assert.equal((html.match(/<details><summary>基准补充信息<\/summary>/g) || []).length, 1, 'only a node with saved supplemental information has the initially collapsed details');
  assert.match(html, /<td data-label="基准节点">[\s\S]*?<details><summary>基准补充信息<\/summary>/);
  assert.match(html, /完成标准：原完成标准/); assert.match(html, /节点说明（原保存）：<strong>原保存基准说明<\/strong>/);
  assert.doesNotMatch(html, /当周节点进展|当周节点卡点|未提供节点反馈|原反馈留空|原节点历史反馈|管理端不汇报|管理端不展示|未填写节点说明/);
  assert.ok(h.api.coreRows(manager).every(row => row.current === null && row.previous === null));
  const personalHtml = h.api.personalCoreHtml();
  assert.equal((personalHtml.match(/<th(?:\s|>)/g) || []).length, 7);
  assert.match(personalHtml, /管理端不汇报的当周进展/); assert.match(personalHtml, /管理端不汇报的卡点/);
  assert.equal(JSON.stringify(h.S), before);
});

test('commercial filter re-renders without database writes or changing residential key-only defaults', () => {
  const h = fixture(); h.S.milestones = [baseline(1), baseline(2, { is_key: true })];
  const html = h.api.coreHtml(h.scope), scope = /data-scope="([^"]+)"/.exec(html)[1].replaceAll('&quot;', '"');
  const before = JSON.stringify(h.S);
  h.api.setKeyOnly('key', scope);
  assert.deepEqual(plain(h.api.coreRows(h.scope).map(row => row.milestone.id)), [2]);
  assert.deepEqual(h.effects, { renders: 1, flushes: 1 });
  assert.equal(JSON.stringify(h.S), before);
  assert.equal(h.windows.scopedMilestones(h.S.milestones, { projectId: 'a', commercial: true, bizLine: '机电工程', keyOnly: false, window: h.scope.window }).length, 2);
  assert.equal(h.windows.scopedMilestones(h.S.milestones, { projectId: 'a', commercial: true, bizLine: '机电工程', window: h.scope.window }).length, 1);
});
