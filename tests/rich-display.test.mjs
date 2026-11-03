import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelSource = fs.readFileSync(path.join(project, 'web/rich-text.js'), 'utf8');
const appSource = fs.readFileSync(path.join(project, 'web/app.js'), 'utf8');
const bootStart = appSource.indexOf('  (async function boot() {');
assert.ok(bootStart > 0, 'app boot boundary must exist for isolated display tests');
const hooks = ['S', 'currentPeriod', 'riskCell', 'nextCell', 'reportSnapshotHtml', 'reportHistoryHtml',
  'myBizLedger', 'needsFromOthers', 'needTable', 'briefRowsHtml', 'leaderPmCard', 'ceoReviewHtml',
  'pzoReviewHtml', 'coordBrief', 'allCoord', 'decisionItems', 'bizLeaderCard', 'viewPMHistory',
  'viewBoard', 'viewPres', 'viewPMCenter', 'viewPMCenterRes', 'App', 'richBinding', 'richPartialUpdate',
  'briefDraftRows', 'captureBriefDrafts', 'replaceLeaderNotes'];

function harness(options = {}) {
  const root = { innerHTML: '' };
  const elements = { toast: { style: {} }, ...options.elements };
  const writes = [], records = options.records || {};
  function from(table) {
    let payload, method;
    const filters = [];
    const chain = {
      select() { return chain; }, order() { return chain; }, limit() { return chain; },
      eq(key, value) { filters.push([key, value]); return chain; },
      update(value) { payload = value; method = 'update'; return chain; },
      upsert(value) { payload = value; method = 'upsert'; return chain; },
      then(resolve, reject) {
        if (method) {
          writes.push({ table, payload, method });
          if (method === 'upsert') records[table] = [payload];
          else (records[table] || []).forEach(row => {
            if (filters.every(([key, value]) => row[key] === value)) Object.assign(row, payload);
          });
        }
        return Promise.resolve({ data: records[table] || [], error: null }).then(resolve, reject);
      }
    };
    return chain;
  }
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout() {},
    addEventListener() {}, removeEventListener() {},
    document: {
      getElementById: id => id === 'root' ? root : elements[id] || null,
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      body: { appendChild() {} }
    },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ database: { from }, auth: {} }) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(modelSource, sandbox, { filename: 'rich-text.js' });
  vm.runInContext(appSource.slice(0, bootStart) + '\nwindow.__display = {' + hooks.join(',') + '};\n})();', sandbox, { filename: 'app.js' });
  const display = sandbox.__display;
  const S = display.S;
  S.uid = 'display-test-pm';
  S.profile = { user_id: S.uid, name: '测试经理', role: 'pm', status: 'approved', project_id: 'res' };
  S.projects = [{ id: 'res', name: '住宅测试', project_type: 'res' }, { id: 'com', name: '商业测试', project_type: 'com' }];
  S.members = [S.profile];
  S.memberships = [{ user_id: S.uid, project_id: 'res' }, { user_id: S.uid, project_id: 'com' }];
  S.milestones = []; S.reports = []; S.reviews = []; S.leaderNotes = []; S.orgList = [];
  S.pmProject = 'res'; S.pmPeriod = display.currentPeriod();
  return { ...display, rt: sandbox.ZHRichText, sandbox, writes, elements, records };
}

const bold = text => ({ ops: [{ insert: text, attributes: { bold: true } }] });
const red = text => ({ ops: [{ insert: text, attributes: { color: '#d81e06' } }] });
const sidecar = fields => ({ v: 1, fields });
function report(h, extra = {}) {
  return {
    id: 71, project_id: 'res', period: h.currentPeriod(), line: '综合', status: '正常',
    author_id: h.S.uid, author_name: '测试经理', node_items: [], speed_items: [], effect_items: [],
    coord_items: [], next_items: [], updated_at: '2026-10-16T01:00:00Z', ...extra
  };
}

test('residential snapshot and summary render structured formatting, multiline text and escaped content', () => {
  const h = harness();
  const r = report(h, {
    change_text: '进度可控', dev_text: '第一行\n第二行', projection: '<img src=x onerror=alert(1)>',
    speed_items: [{ act: '增加班组', gain: '追回三天' }], effect_items: [{ act: '联合验收', target: '一次成型' }],
    coord_items: [{ who: '负责人', what: '确认材料', by: '' }],
    rich_text: sidecar({ change_text: bold('进度可控'), dev_text: red('第一行\n第二行'),
      projection: red('<img src=x onerror=alert(1)>'), 'speed_items.0.act': red('增加班组'),
      'speed_items.0.gain': bold('追回三天'), 'effect_items.0.act': bold('联合验收'),
      'effect_items.0.target': red('一次成型'), 'coord_items.0.what': red('确认材料') })
  });
  h.S.reports = [r];
  const html = h.reportSnapshotHtml(r);
  assert.match(html, /<strong>进度可控<\/strong>/);
  assert.match(html, /<span class="rt-red">第一行<br>第二行<\/span>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<span class="rt-red">增加班组<\/span>/);
  assert.match(html, /<strong>追回三天<\/strong>/);
  assert.match(h.coordBrief(r), /<span class="rt-red">确认材料<\/span>/);
  h.S.ptype = 'res';
  assert.match(h.viewBoard(), /<strong>进度可控<\/strong>/);
  assert.match(h.viewPres(), /<span class="rt-red">增加班组<\/span>/);
});

test('next commitments retain original field indices after blank entries are hidden', () => {
  const h = harness();
  const r = report(h, { next_items: ['', '完成定标', '完成验收'], rich_text: sidecar({
    'next_items.1': red('完成定标'), 'next_items.2': bold('完成验收')
  }) });
  h.rt.attach(r);
  const html = h.nextCell(r);
  assert.match(html, /1\. <span class="rt-red">完成定标<\/span>/);
  assert.match(html, /2\. <strong>完成验收<\/strong>/);
});

test('commercial report, ledger projections and leader cards preserve item-specific formatting', () => {
  const h = harness();
  const r = report(h, { project_id: 'com', line: '机电工程', biz: {
    nodes: [{ name: '节点', plan: '', prog: '第一行\n第二行' }],
    items: [{ name: '相同文字', due: '', prog: '进展一' }, { name: '相同文字', due: '', prog: '进展二' }],
    handover: [{ what: '移交资料', to: '负责人', due: '' }]
  }, rich_text: sidecar({ 'biz.nodes.0.prog': red('第一行\n第二行'),
    'biz.items.0.name': bold('相同文字'), 'biz.items.1.name': red('相同文字'),
    'biz.items.1.prog': bold('进展二'), 'biz.handover.0.what': red('移交资料') }) });
  h.rt.attach(r); h.S.reports = [r]; h.S.pmProject = 'com'; h.S.profile.project_id = 'com';
  h.S.profile.biz_line = '机电工程'; h.S.pmLine = '机电工程';
  const html = h.reportSnapshotHtml(r);
  assert.match(html, /<strong>相同文字<\/strong>/);
  assert.match(html, /<span class="rt-red">相同文字<\/span>/);
  const group = h.myBizLedger('com').byPeriod[r.period];
  assert.equal(h.rt.field(group.o.items[0], 'name'), '<strong>相同文字</strong>');
  assert.equal(h.rt.field(group.o.items[1], 'name'), '<span class="rt-red">相同文字</span>');
  assert.match(html, /<strong>进展二<\/strong>/, 'saved report display retains item-specific progress formatting');
  assert.equal(h.rt.field(group.o.items[1], 'prog'), '<strong>进展二</strong>');
  assert.match(h.bizLeaderCard(h.S.projects[1]), /<span class="rt-red">第一行<br>第二行<\/span>/);
  assert.match(h.viewPMHistory(), /<span class="rt-red">移交资料<\/span>/);
});

test('read-only leadership notes, reviews and their row projections render formatting', () => {
  const h = harness();
  const note = { id: 9, project_id: 'res', period: h.currentPeriod(), kind: 'ceo_brief', what: '关注消防', due: '',
    rich_text: sidecar({ what: red('关注消防') }) };
  const review = { project_id: 'res', period: h.currentPeriod(), kind: 'ceo', speed: '达标', effect: '良好', note: '持续跟进',
    rich_text: sidecar({ note: bold('持续跟进') }) };
  h.rt.attach(note); h.rt.attach(review); h.S.leaderNotes = [note]; h.S.reviews = [review];
  assert.match(h.briefRowsHtml('res', 'ceo_brief', false), /<span class="rt-red">关注消防<\/span>/);
  assert.match(h.ceoReviewHtml('res'), /<strong>持续跟进<\/strong>/);
  assert.doesNotMatch(h.leaderPmCard('res', true), /关注消防/, 'legacy leadership notes stay out of the personal card');
  assert.equal(h.rt.field(note, 'what'), '<span class="rt-red">关注消防</span>', 'hiding the old personal entry must not change its saved formatting');
  assert.match(h.leaderPmCard('res', true), /<strong>持续跟进<\/strong>/);
});

test('historical snapshots use their own formatting and legacy marker records remain readable', () => {
  const h = harness();
  const previous = report(h, { change_text: '相同正文', rich_text: sidecar({ change_text: red('相同正文') }) });
  const current = report(h, { change_text: '相同正文', rich_text: sidecar({ change_text: bold('相同正文') }),
    history: [{ at: '2026-10-16T02:00:00Z', by: h.S.uid, data: previous }] });
  const html = h.reportHistoryHtml(current);
  assert.match(html, /<strong>相同正文<\/strong>/);
  assert.match(html, /<span class="rt-red">相同正文<\/span>/);
  const legacy = h.reportSnapshotHtml(report(h, { change_text: '**加粗**与==标红==' }));
  assert.match(legacy, /<strong>加粗<\/strong>/);
  assert.match(legacy, /<span class="rt-red">标红<\/span>/);
});

test('coordination projections preserve source formatting including combined business text', () => {
  const h = harness();
  const r = report(h, { project_id: 'com', coord_items: [{ who: '决策人', what: '协调事项' }], biz: {
    nodes: [], handover: [{ what: '移交资料' }], items: [{ name: '商业事项', coord: '需协调', prog: '未完成', due: '2000-01-01' }]
  }, rich_text: sidecar({ 'coord_items.0.what': bold('协调事项'), 'biz.handover.0.what': red('移交资料'),
    'biz.items.0.name': red('商业事项'), 'biz.items.0.coord': bold('需协调') }) });
  h.rt.attach(r); h.S.reports = [r]; h.S.orgList = [{ name: '决策人', level: 1 }];
  const all = h.allCoord();
  assert.equal(h.rt.field(all[0], 'what'), '<strong>协调事项</strong>');
  assert.match(all[1].whatHtml, /<span class="rt-red">移交资料<\/span>/);
  const decision = h.decisionItems();
  assert.equal(h.rt.field(decision[0], 'what'), '<strong>协调事项</strong>');
  assert.match(decision[1].whatHtml, /<span class="rt-red">商业事项<\/span>：<strong>需协调<\/strong>/);
});

test('legacy leadership draft formatting survives redraw while cancelled review handlers make no write', async () => {
  const h = harness({ elements: { ceonote_res: { value: '保存评语' } } });
  h.S.profile.role = 'ops'; h.S.view = 'pres';
  h.richBinding('ceonote_res').set(red('保存评语'));
  h.richBinding('pzonote_com').set(bold('另一项目未保存'));
  assert.match(h.ceoReviewHtml('res'), />保存评语<\/textarea>/);
  assert.match(h.pzoReviewHtml('com'), />另一项目未保存<\/textarea>/);
  await h.App.saveCeoReview('res');
  await h.App.savePzoReview('com');
  assert.equal(h.writes.length, 0);
  assert.equal(h.S.reviewRichDrafts['ceo:res'].note, '保存评语');
  assert.equal(h.S.reviewRichDrafts['pzo:com'].note, '另一项目未保存');
  assert.match(h.ceoReviewHtml('res'), /保存评语/);
});

test('brief drafts preserve formatting and replacement request excludes editing metadata', async () => {
  const h = harness();
  const note = { project_id: 'res', period: h.currentPeriod(), kind: 'ceo_brief', what: '关注消防',
    rich_text: sidecar({ what: red('关注消防') }) };
  h.rt.attach(note); h.S.leaderNotes = [note];
  const rows = h.briefDraftRows('res', 'ceo_brief');
  assert.equal(h.rt.field(rows[0], 'what'), '<span class="rt-red">关注消防</span>');
  let request;
  h.sandbox.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: [] }) };
  };
  await h.replaceLeaderNotes('res', h.currentPeriod(), 'ceo_brief', rows);
  assert.equal(h.rt.field(request.items[0], 'what'), '<span class="rt-red">关注消防</span>');
  assert.doesNotMatch(JSON.stringify(request), /_rich/);
});

test('milestone format-only save preserves other formatting and is not resubmitted unchanged', async () => {
  const h = harness({ elements: { ml_fc_11: { value: '2026-11-01' }, ml_note_11: { value: '卡点说明' } }, records: { milestones: [{ id: 11 }] } });
  h.S.view = 'mline';
  const milestone = { id: 11, project_id: 'res', name: '测试节点', plan_date: '2026-11-01', forecast_date: '2026-11-01', note: '卡点说明',
    rich_text: sidecar({ name: bold('测试节点') }) };
  h.S.milestones = [milestone]; h.rt.attach(milestone);
  h.richBinding('ml_note_11').set(red('卡点说明'));
  await h.App.mlineSave();
  assert.equal(h.writes.length, 1);
  const saved = h.writes[0].payload;
  assert.equal(h.rt.field(saved, 'note'), '<span class="rt-red">卡点说明</span>');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.rich_text.fields.name)), bold('测试节点'));
  assert.doesNotMatch(JSON.stringify(saved), /_rich/);
  await h.App.mlineSave();
  assert.equal(h.writes.length, 1, 'format was already saved; unchanged second save must not write again');
});

test('narrow business updates replace only changed formatting paths and remove stale entries', () => {
  const h = harness();
  const previous = report(h, { rich_text: sidecar({ change_text: bold('已存正文'),
    'biz.items.0.name': red('保留事项'), 'biz.handover.0.what': red('旧移交'), 'coord_items.1.what': red('已删除协调') }) });
  const hand = { what: '新移交', _rich: { what: bold('新移交') } };
  const patch = h.richPartialUpdate(previous, { biz: { items: [{ name: '保留事项' }], handover: [hand] } }, ['biz.handover']);
  assert.deepEqual(JSON.parse(JSON.stringify(patch.rich_text.fields['biz.items.0.name'])), red('保留事项'));
  assert.equal(h.rt.field(patch, 'biz.handover.0.what'), '<strong>新移交</strong>');
  const coords = h.richPartialUpdate(previous, { coord_items: [], coord: '无' }, ['coord_items', 'coord']);
  assert.equal(coords.rich_text.fields['coord_items.1.what'], undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(coords.rich_text.fields.change_text)), bold('已存正文'));
  assert.doesNotMatch(JSON.stringify(patch), /_rich/);
});
