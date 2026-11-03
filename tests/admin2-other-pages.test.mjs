import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const web = new URL('../web/', import.meta.url);
const source = readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0, 'the actual App boot boundary must remain identifiable');
const exposed = source.slice(0, boundary) + '\nwindow.audit={S,App,dataState,loadData,configureReporter,currentPeriod,viewProjectDetail,reportSnapshotHtml,reportHistoryHtml,allCoord,viewCoord,viewNodes,reportAttachmentScope,completionSourceKeys,overviewNodeHtml};\n})();';
const scope = { id: 'anonymous-residential-scope', name: '匿名住宅统一范围', anchor_project_id: 'r1', project_ids: ['r1', 'r2', 'r3'], effective_week: '2026-10-19' };
const projects = scope.project_ids.map((id, index) => ({ id, name: ['匿名住宅一期', '匿名住宅二期', '匿名住宅三期'][index], project_type: 'res', active: true }));
const attachmentId = '10000000-0000-4000-8000-000000000081';
const oldAttachmentId = '10000000-0000-4000-8000-000000000082';
const plain = value => JSON.parse(JSON.stringify(value));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-10-22T04:00:00Z'])); }
  static now() { return +new Date('2026-10-22T04:00:00Z'); }
}

function harness() {
  const elements = { root: { innerHTML: '' }, toast: { style: {} } }, downloads = [], requests = [], fixture = { statistics: null };
  const sandbox = { console, Date: FixedDate, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: blob => { downloads.push(blob.parts.join('')); return 'blob:anonymous-csv'; }, revokeObjectURL() {} },
    document: { getElementById: id => elements[id] || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {},
      createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } },
    fetch: async (url, options) => {
      assert.equal(url, '/api/project-plan-statistics'); requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => plain(fixture.statistics) };
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ auth: {}, database: { from() { throw new Error('This read-only VM test must not access a database'); } } }) } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  for (const name of ['rich-text.js', 'planning-windows.js', 'report-scopes.js', 'report-attachments.js', 'baseline-core.js'])
    vm.runInContext(readFileSync(new URL(name, web), 'utf8'), sandbox);
  vm.runInContext(exposed, sandbox);
  const h = sandbox.audit;
  Object.assign(h.S, { uid: 'anonymous-ops', session: {}, profile: { user_id: 'anonymous-ops', role: 'ops', name: '匿名管理员', status: 'approved' },
    view: 'detail', detailPid: 'r2', detailPeriod: '2026-10-19', detailTab: 'report', projects: plain(projects), reportScopes: [plain(scope)],
    reports: [], reportAttachments: [], milestones: [], members: [], versions: [], reviews: [], leaderNotes: [], coordinationTasks: [], monthlyPlans: [] });
  h.configureReporter();
  return { ...h, sandbox, downloads, requests, fixture };
}

function groupReport() {
  return { id: 701, project_id: 'r1', report_scope_id: scope.id, scope_project_ids: scope.project_ids.slice(), period: '2026-10-19', line: '综合',
    author_id: 'original-author', author_name: '原填报人', submitted_at: '2026-10-20T02:00:00Z',
    coord_items: [{ project_id: 'r3', source_id: 'coord-3', who: '原协调对象', what: '三期协调内容', by: '2026-10-25' }],
    biz: { form_version: 2, nodes: [{ project_id: 'r2', source_id: 'node-2', name: '二期核心节点', plan: '2026-10-23', prog: '节点原进展' }],
      items: [{ project_id: 'r3', source_id: 'item-3', name: '三期计划事项', mod: '工程', due: '2026-10-21', prog: '计划原进展' }],
      handover: [{ project_id: 'r2', source_id: 'handover-2', what: '二期移交内容', to: '原接收人', due: '2026-10-25' }],
      followups: [{ project_id: 'r2', source_key: 'meeting:r2:original-meeting', what: '原同步来源', progress: '原跟进' }], attachments: [attachmentId] },
    rich_text: { v: 1, fields: { 'biz.nodes.0.prog': { ops: [{ insert: '节点原进展', attributes: { bold: true, color: '#d81e06' } }] },
      'coord_items.0.what': { ops: [{ insert: '三期协调内容', attributes: { bold: true } }] } } } };
}

function sourceLine(html, marker) {
  const line = html.split('<div>· ').slice(1).find(value => value.includes(marker));
  assert.ok(line, 'snapshot must render the original item: ' + marker);
  return line.split('</div>')[0];
}

test('actual group detail and history identify the reporting scope and every original item project without inferring unknown sources by name', () => {
  const h = harness(), report = groupReport();
  report.biz.nodes.push({ project_id: 'unknown-project', source_id: 'unknown-node', name: '同名节点', plan: '2026-10-23', prog: '未知项目原进展' });
  report.biz.items.push({ source_id: 'unmarked-item', name: '未标记项目的原计划事项', mod: '工程', due: '2026-10-25' });
  const previous = plain(report); previous.biz.handover[0].what = '二期历史移交内容'; previous.author_name = '历史原作者';
  previous.biz.attachments = [oldAttachmentId];
  report.history = [{ at: '2026-10-21T02:00:00Z', by: 'original-author', data: previous }];
  h.S.milestones = [{ id: 81, project_id: 'r2', name: '同名节点', plan_date: '2026-10-23' }];
  h.S.reports = [report];
  h.S.reportAttachments = [{ id: attachmentId, name: '当前原附件.png', mime: 'image/png', size: 32, inline: true },
    { id: oldAttachmentId, name: '历史原附件.png', mime: 'image/png', size: 32, inline: true }];
  const before = JSON.stringify(report), detail = h.viewProjectDetail(), snapshot = h.reportSnapshotHtml(report);
  for (const html of [detail, snapshot, h.reportHistoryHtml(report)]) {
    assert.match(html, /匿名住宅统一范围/);
    for (const project of projects) assert.ok(html.includes(project.name), 'the stored member project must remain identifiable: ' + project.id);
  }
  for (const [marker, expected] of [['二期核心节点', '匿名住宅二期'], ['三期计划事项', '匿名住宅三期'], ['二期移交内容', '匿名住宅二期'], ['三期协调内容', '匿名住宅三期']])
    assert.ok(sourceLine(snapshot, marker).includes(expected), marker + ' must label its own project, rather than the group anchor');
  for (const marker of ['同名节点', '未标记项目的原计划事项']) {
    const line = sourceLine(snapshot, marker);
    assert.match(line, /未知|未标|未指定|未明确/);
    for (const project of projects) assert.ok(!line.includes(project.name), 'an unknown source cannot be guessed from the report anchor or a same-name baseline');
  }
  const history = h.reportHistoryHtml(report);
  assert.ok(sourceLine(history, '二期历史移交内容').includes('匿名住宅二期'));
  assert.match(history, /历史原作者/); assert.match(history, /当前原附件\.png/); assert.match(history, /历史原附件\.png/);
  assert.match(snapshot, /font-weight:700|<strong>|<b>/); assert.match(snapshot, /class="rt-red"/);
  assert.equal(JSON.stringify(report), before, 'detail and historical rendering must not rewrite source IDs, rich text, authors, attachment IDs or snapshots');
});

test('actual coordination keeps real member projects while node detail and CSV use effective statistics rather than stale raw completion', async () => {
  const h = harness(), report = groupReport();
  report.coord_items.push({ project_id: 'unknown-project', source_id: 'unknown-coord', who: '未知对象', what: '未知归属协调' },
    { source_id: 'unmarked-coord', who: '未标对象', what: '未标记项目协调' });
  const previousYear = groupReport(); previousYear.id = 702; previousYear.period = '第43周（10.20–10.26）'; previousYear.submitted_at = '2025-10-21T02:00:00Z';
  previousYear.coord_items = [{ project_id: 'r2', source_id: 'old-year-coordinate', who: '往年对象', what: '往年同周协调不得进入本期' }];
  previousYear.biz = {};
  h.S.reports = [report, previousYear];
  const before = JSON.stringify(h.S.reports), rows = plain(h.allCoord());
  assert.equal(rows.find(row => row.what === '三期协调内容')?.pid, 'r3');
  assert.equal(rows.find(row => row.what.includes('二期移交内容'))?.pid, 'r2');
  assert.equal(rows.find(row => row.what.includes('三期计划事项'))?.pid, 'r3');
  for (const marker of ['未知归属协调', '未标记项目协调']) {
    const row = rows.find(value => value.what === marker); assert.ok(row);
    assert.notEqual(row.pid, 'r1', 'unknown group-item ownership must not become the group anchor');
  }
  assert.ok(rows.every(row => !row.what.includes('往年同周协调')));
  assert.match(h.viewCoord(), /匿名住宅二期/); assert.match(h.viewCoord(), /匿名住宅三期/);
  h.S.projects.push({ id: 'com', name: '匿名商业项目', project_type: 'com', active: true }); h.S.view = 'nodesCom';
  h.S.milestones = [{ id: 91, project_id: 'com', name: '商业原基准节点', plan_date: '2026-10-20', forecast_date: '2026-10-24', biz_line: '工程', is_key: false, done: true },
    { id: 92, project_id: 'com', name: '商业审核完成节点', plan_date: '2026-10-21', forecast_date: '2026-10-23', biz_line: '工程', is_key: true, done: false }];
  const milestonesBefore = JSON.stringify(h.S.milestones);
  assert.match(h.viewNodes(), /尚未读取|未匹配/); h.App.exportNodes(); assert.equal(h.downloads.length, 0);
  h.fixture.statistics = { data: { source: 'res_baseline', filters: { kind: 'res' }, rows: [] } };
  assert.equal(await h.loadData(['nodeStatistics'], true), false, 'a cross-type response is a read failure rather than an empty or successful commercial inventory');
  assert.equal(h.requests.at(-1).body.kind, 'com', 'the requested view selects the API kind even before renderShell updates the previous ptype');
  assert.equal(h.S.ptype, 'res'); assert.equal(h.dataState.nodeStatistics.ready, false);
  assert.match(h.viewNodes(), /尚未读取|未匹配/); h.App.exportNodes(); assert.equal(h.downloads.length, 0);
  h.fixture.statistics = { data: { source: 'com_baseline', filters: { kind: 'com' }, rows: [
    { source_key: 'milestone:com:91', title: '商业原基准节点', completed: false, plan_due: '2026-10-20', forecast_due: '2026-10-24', deviation: 4 },
    { source_key: 'milestone:com:92', title: '商业审核完成节点', completed: true, plan_due: '2026-10-21', forecast_due: '2026-10-23', deviation: null }
  ] } };
  // Exercise the retained helper independently: a failed read normalizes the
  // removed menu route, while current navigation uses unified statistics.
  h.S.view = 'nodesCom';
  assert.equal(await h.loadData(['nodeStatistics'], true), true); h.S.view = 'nodesCom'; h.S.ptype = 'com';
  const nodes = h.viewNodes(); assert.match(nodes, /商业基准节点明细/); assert.match(nodes, /商业原基准节点/);
  assert.doesNotMatch(nodes, /已确认月计划统计/);
  const row = nodes.split('<tr>').find(value => value.includes('商业原基准节点')).split('</tr>')[0];
  assert.match(row, /2026-10-24/); assert.match(row, /\+4 天/); assert.doesNotMatch(row, /已完成/);
  h.App.exportNodes(); assert.equal(h.downloads.length, 1);
  const csvRow = h.downloads[0].split('\r\n').find(value => value.includes('商业原基准节点'));
  assert.match(csvRow, /2026-10-24/); assert.match(csvRow, /\+4 天/); assert.doesNotMatch(csvRow, /已完成/);
  assert.match(h.downloads[0].split('\r\n').find(value => value.includes('商业审核完成节点')), /已完成/);
  h.S.nodeStatistics = [];
  assert.match(h.viewNodes(), /尚未读取|未匹配/); h.App.exportNodes(); assert.equal(h.downloads.length, 1, 'missing source-key status cannot silently fall back to raw done or export it');
  assert.equal(JSON.stringify(h.S.milestones), milestonesBefore, 'effective completion is a read-only projection and cannot alter the source or approval snapshot');
  assert.equal(JSON.stringify(h.S.reports), before);
});

test('actual detail body, attachment scope and completion keys resolve the same stored week across aliases without mixing another year with the same week number', () => {
  const h = harness(), current = groupReport(), previousYear = groupReport();
  previousYear.id = 702; previousYear.period = '第43周（10.20–10.26）'; previousYear.submitted_at = '2025-10-21T02:00:00Z';
  previousYear.biz.items = [{ project_id: 'r2', source_id: 'old-year-item', name: '往年同周计划正文', due: '2025-10-25' }];
  previousYear.biz.nodes = []; previousYear.biz.handover = []; previousYear.biz.followups = []; previousYear.coord_items = [];
  previousYear.biz.attachments = [oldAttachmentId];
  h.S.reports = [previousYear, current];
  h.S.reportAttachments = [{ id: attachmentId, name: '本周原附件.png', mime: 'image/png', size: 32, inline: true },
    { id: oldAttachmentId, name: '往年同周附件.png', mime: 'image/png', size: 32, inline: true }];
  const expected = ['coord:r1:701:coord:coord-3', 'coord:r1:701:handover:handover-2', 'meeting:r2:original-meeting',
    'plan:r1:701:items:item-3', 'plan:r1:701:nodes:node-2'].sort();
  assert.equal(h.currentPeriod(), '第43周（10.19–10.25）');
  for (const period of [h.currentPeriod(), '2026-10-19', '第43周（2026.10.19–2026.10.25）']) {
    h.S.detailPeriod = period;
    for (const tab of ['report', 'history']) {
      h.S.detailTab = tab;
      const html = h.viewProjectDetail();
      assert.match(html, /三期计划事项/); assert.match(html, /本周原附件\.png/);
      assert.doesNotMatch(html, /往年同周计划正文|往年同周附件/);
      assert.deepEqual(plain(h.reportAttachmentScope()), { report_ids: ['701'] });
      assert.deepEqual(plain(h.completionSourceKeys()), expected, 'claim keys must keep original anchor report identities and exact external source keys');
    }
  }
  h.S.detailPeriod = '2025-10-20'; h.S.detailTab = 'report';
  const oldHtml = h.viewProjectDetail(); assert.match(oldHtml, /往年同周计划正文/); assert.match(oldHtml, /往年同周附件/);
  assert.doesNotMatch(oldHtml, /三期计划事项|本周原附件/);
  assert.deepEqual(plain(h.reportAttachmentScope()), { report_ids: ['702'] });
  assert.deepEqual(plain(h.completionSourceKeys()), ['plan:r1:702:items:old-year-item']);
});

test('actual management core uses four read-only baseline columns for residential expertise, all group members and commercial all/key scope without showing old feedback', () => {
  const h = harness();
  h.S.projects.push({ id: 'ordinary', name: '匿名独立住宅', project_type: 'res', active: true }, { id: 'com', name: '匿名商业项目', project_type: 'com', active: true });
  const milestone = (id, project_id, name, fields = {}) => ({ id, project_id, name, plan_date: '2026-10-23', forecast_date: '2026-10-26', is_key: true, ...fields });
  h.S.milestones = [milestone(101, 'ordinary', '普通住宅工程关键基准', { discipline: '工程' }),
    milestone(102, 'ordinary', '普通住宅工程非关键基准', { discipline: '工程', is_key: false }),
    milestone(103, 'ordinary', '普通住宅设计关键基准', { discipline: '设计' }),
    milestone(201, 'r1', '一期工程基准', { discipline: '工程' }), milestone(202, 'r2', '二期设计基准', { discipline: '设计' }), milestone(203, 'r3', '三期原基准'),
    milestone(301, 'com', '商业机电关键基准', { biz_line: '机电工程' }),
    milestone(302, 'com', '商业机电非关键基准', { biz_line: '机电工程', is_key: false }),
    milestone(303, 'com', '商业其他模块基准', { biz_line: '建筑结构设计' })];
  h.S.reports = [{ id: 801, project_id: 'ordinary', period: '2026-10-19', line: '综合', submitted_at: '2026-10-20T02:00:00Z',
    biz: { form_version: 2, nodes: [{ milestone_id: 101, name: '普通住宅工程关键基准', prog: '普通旧手填反馈不得展示' }, { name: '原手填独立事项', prog: '原手填独立进展' }] },
    node_items: [{ name: '原住宅研判节点', reason: '原研判进度不得展示' }] },
    { id: 802, project_id: 'r1', report_scope_id: scope.id, scope_project_ids: scope.project_ids.slice(), period: '2026-10-19', submitted_at: '2026-10-20T02:00:00Z',
      biz: { form_version: 2, nodes: [{ project_id: 'r2', milestone_id: 202, name: '二期设计基准', prog: '组报旧手填反馈不得展示' }] } },
    { id: 803, project_id: 'com', period: '2026-10-19', line: '机电工程', submitted_at: '2026-10-20T02:00:00Z',
      biz: { nodes: [{ milestone_id: 301, name: '商业机电关键基准', prog: '商业旧手填反馈不得展示' }] } }];
  h.dataState.milestones = { ready: true, revision: 0 };
  const before = JSON.stringify({ reports: h.S.reports, milestones: h.S.milestones });
  function reminder(html) {
    const header = /<thead>([\s\S]*?)<\/thead>/.exec(html);
    assert.ok(header); assert.equal((header[1].match(/<th(?:\s[^>]*)?>/g) || []).length, 4);
    assert.match(html, /原计划完成日/); assert.match(html, /预计完成日/);
    assert.doesNotMatch(html, /旧手填反馈|原手填独立|原研判进度|当周节点进展|当周节点卡点|本周未提供节点反馈|<textarea|contenteditable/);
  }
  const ordinary = h.overviewNodeHtml(h.S.reports, 'ordinary', '工程', false);
  reminder(ordinary); assert.match(ordinary, /普通住宅工程关键基准/);
  assert.doesNotMatch(ordinary, /普通住宅工程非关键基准|普通住宅设计关键基准|一期工程基准|原住宅研判节点/);
  const group = h.overviewNodeHtml(h.S.reports, 'r1', null, false, scope.project_ids.slice());
  reminder(group);
  for (const [id, name] of [[201, '一期工程基准'], [202, '二期设计基准'], [203, '三期原基准']]) {
    assert.ok(group.includes(name)); assert.ok(group.includes('milestone:r' + (id - 200) + ':' + id));
  }
  const all = h.overviewNodeHtml(h.S.reports, 'com', '机电工程', true);
  reminder(all); assert.match(all, /商业机电关键基准/); assert.match(all, /商业机电非关键基准/); assert.doesNotMatch(all, /商业其他模块基准/);
  const filter = /data-scope="([^"]+)"/.exec(all); assert.ok(filter);
  h.sandbox.BaselineCore.configure({ S: h.S, esc: value => String(value ?? ''), baselineState: () => h.dataState.milestones, render() {}, flush() {} });
  h.sandbox.BaselineCore.setKeyOnly('key', filter[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  const key = h.overviewNodeHtml(h.S.reports, 'com', '机电工程', true);
  reminder(key); assert.match(key, /商业机电关键基准/); assert.doesNotMatch(key, /商业机电非关键基准|商业其他模块基准/);
  h.sandbox.BaselineCore = null;
  const failure = h.overviewNodeHtml(h.S.reports, 'ordinary', '工程', false);
  assert.match(failure, /role="alert"/); assert.match(failure, /项目基准节点组件读取失败/);
  assert.doesNotMatch(failure, /旧手填反馈|原手填独立|原住宅研判节点|普通住宅工程关键基准/);
  assert.equal(JSON.stringify({ reports: h.S.reports, milestones: h.S.milestones }), before, 'management projection never rewrites reports, feedback, original baselines or their approval identities');
});
