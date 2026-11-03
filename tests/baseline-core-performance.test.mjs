import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const scripts = ['planning-windows.js', 'rich-text.js', 'baseline-core.js'].map(name =>
  readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const context = {console}; context.window = context; vm.createContext(context);
  scripts.forEach(source => vm.runInContext(source, context));
  const S = {uid: 'anonymous', session: {}, projects: [{id: 'a', name: '项目甲'}, {id: 'b', name: '项目乙'}],
    pmProject: 'a', pmLine: '机电工程', pmPeriod: '2026-10-19', pmReport: null, reports: [], milestones: [], bizNodes: []};
  context.BaselineCore.configure({S, esc: value => String(value ?? ''), richItem: context.ZHRichText.field});
  const options = {projectId: 'a', projectIds: ['a', 'b'], line: '机电工程', commercial: true, personal: true,
    window: context.PlanningWindows.windowFor('2026-10-19', 'week')};
  return {S, context, api: context.BaselineCore, options};
}
function milestone(id, project_id = 'a') {
  return {id, project_id, name: '节点' + id, biz_line: '机电工程', plan_date: '2026-10-23'};
}
function report(id, period, nodes, extra = {}) {
  return {id, period, project_id: 'a', submitted_at: period + 'T12:00:00Z', biz: {nodes}, ...extra};
}

test('baseline feedback keeps exact project identity, original tie ordering, rich paths and first duplicate draft', () => {
  const h = harness();
  h.S.milestones = [milestone(1), milestone(2), milestone(1, 'b')];
  h.S.reports = [report('old', '2026-10-12', [{milestone_id: 2, prog: '历史记录'}]),
    report('z', '2026-10-19', [{milestone_id: 1, prog: '同时间ID较后'}]),
    report('a', '2026-10-19', [{milestone_id: 1, prog: ''}, {milestone_id: 1, prog: '重复节点不覆盖前行'},
      {milestone_id: 1, project_id: 'b', prog: '乙项目原进展'}]),
    report('future', '2026-10-26', [{milestone_id: 2, prog: '未来记录'}])];
  h.S.bizNodes = [{milestone_id: 1, prog: '', blocker: '本机卡点'}, {milestone_id: 1, prog: '重复草稿不覆盖前行'}];
  const before = plain(h.S), rows = plain(h.api.coreRows(h.options));
  const a1 = rows.find(row => row.sourceKey === 'milestone:a:1');
  const a2 = rows.find(row => row.sourceKey === 'milestone:a:2');
  const b1 = rows.find(row => row.sourceKey === 'milestone:b:1');
  assert.equal(a1.current.node.prog, ''); assert.equal(a1.current.node.blocker, '本机卡点');
  assert.equal(a1.current.draft, true); assert.equal(a1.previous, null);
  assert.equal(a2.current, null); assert.equal(a2.previous.node.prog, '历史记录');
  assert.equal(b1.current.record.id, 'a'); assert.equal(b1.current.path, 'biz.nodes.2.');
  assert.equal(b1.current.node.prog, '乙项目原进展');
  h.S.bizNodes = [];
  const withoutDraft = h.api.coreRows(h.options).find(row => row.sourceKey === 'milestone:a:1');
  assert.equal(withoutDraft.current.record.id, 'a'); assert.equal(withoutDraft.current.path, 'biz.nodes.0.');
  assert.equal(withoutDraft.current.node.prog, '', 'a blank current row must not inherit an older or duplicate value');
  h.S.bizNodes = before.bizNodes;
  assert.deepEqual(plain(h.S), before);
});

test('each baseline render reads current arrays and explicit report overrides without retaining feedback', () => {
  const h = harness(); h.S.milestones = [milestone(1)];
  h.S.reports = [report('one', '2026-10-19', [{milestone_id: 1, prog: '第一次'}])];
  assert.equal(h.api.coreRows(h.options)[0].current.node.prog, '第一次');
  h.S.reports[0].biz.nodes[0].prog = '原对象修改';
  assert.equal(h.api.coreRows(h.options)[0].current.node.prog, '原对象修改');
  h.S.reports = [report('two', '2026-10-19', [{milestone_id: 1, prog: '刷新记录'}])];
  assert.equal(h.api.coreRows(h.options)[0].current.record.id, 'two');
  assert.equal(h.api.coreRows({...h.options, reports: []})[0].current, null);
  h.S.reports = [];
  assert.equal(h.api.coreRows(h.options)[0].current, null);
  assert.equal(h.api.coreRows(h.options)[0].previous, null);
});

test('report date parsing stays proportional to reports as the number of displayed milestones grows', () => {
  const h = harness();
  h.S.reports = Array.from({length: 60}, (_, index) => report('r' + index, '2026-10-19',
    Array.from({length: 40}, (_, node) => ({milestone_id: node + 1, prog: '原反馈' + node}))));
  const original = h.context.PlanningWindows.periodStart;
  let dateReads = 0;
  h.context.PlanningWindows.periodStart = (...args) => { dateReads++; return original(...args); };
  h.S.milestones = [milestone(1)]; h.api.coreRows(h.options); const singleReads = dateReads;
  dateReads = 0;
  h.S.milestones = Array.from({length: 40}, (_, index) => milestone(index + 1));
  assert.equal(h.api.coreRows(h.options).length, 40);
  assert.equal(dateReads, singleReads, 'adding nodes must not reparse all reports once for each node');
  assert.ok(dateReads <= h.S.reports.length + 1);
  dateReads = 0;
  Object.defineProperty(h.S, 'reports', {get() { throw new Error('manager projection must not read feedback'); }});
  assert.ok(h.api.coreRows({...h.options, personal: false}).every(row => row.current === null && row.previous === null));
  assert.equal(dateReads, 0);
});
