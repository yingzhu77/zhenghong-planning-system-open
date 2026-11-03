import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { BUSINESS_MODULES } from '../server/commercial-modules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = fs.readFileSync(path.join(root, 'web/rich-text.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'web/reporter-tasks.js'), 'utf8');
const completionSource = fs.readFileSync(path.join(root, 'web/completion-review.js'), 'utf8');
const BIZ_LINES = BUSINESS_MODULES;
process.env.TZ = 'Asia/Shanghai';
const fixedTime = '2026-10-20T08:00:00Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return Date.parse(fixedTime); }
}
function harness(overrides = {}) {
  const elements = {}, messages = [], calls = [];
  let renders = 0, loads = 0;
  const S = { uid: 'owner', profile: { name: '测试经理', biz_line: '土建工程' }, pmProject: 'p1', pmPeriod: '第43周', pmLine: '土建工程',
    projects: [{ id: 'p1' }, { id: 'p2' }], pmReport: null, reports: [], leaderNotes: [], reporterTasks: [], followupRows: [] };
  const sandbox = { Date: FixedDate, document: { getElementById: id => elements[id] || null } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(model, sandbox);
  vm.runInContext(source, sandbox);
  const rt = sandbox.ZHRichText, api = sandbox.ReporterTasks;
  const options = { S, bizLines: BIZ_LINES, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    richItem: rt.field, richCopy: rt.copy, richCollect: row => rt.collect(JSON.parse(JSON.stringify(row))),
    weekNo: period => Number(/第(\d+)周/.exec(period || '')?.[1]) || null, currentPeriod: () => '第43周',
    toast: (...args) => messages.push(args), render: () => renders++, reloadTasks: async () => { loads++; },
    saveDraft: () => {}, flush: () => {}, reloadSources: async () => {}, loadPeople: async () => ({ data: [{ user_id: 'owner', name: '测试承办人', role: 'pm' }] }), request: async (url, body) => { calls.push({ url, body }); return { data: { ...body, id: 'saved', revision: 1 } }; }, ...overrides };
  api.configure(options);
  return { S, api, rt, elements, messages, calls, options, sandbox, get renders() { return renders; }, get loads() { return loads; } };
}
function note(id, extra = {}) { return { id, project_id: 'p1', kind: 'ceo_brief', period: '第43周', what: '领导安排', due: '', author_name: '测试领导', created_at: fixedTime, ...extra }; }
function meeting(id, extra = {}) { return { id, project_id: 'p1', owner_id: 'owner', owner_name: '测试经理', title: '例会事项', what: '落实例会结论', due: '', status: 'open', progress: '', created_at: fixedTime, updated_at: fixedTime, revision: 1, ...extra }; }
function report(id, extra = {}) { return { id, project_id: 'p1', author_id: 'other', author_name: '其他专业', period: '第43周', submitted_at: fixedTime, coord_items: [], biz: {}, ...extra }; }
function saved(key, extra = {}) { return { source_key: key, source_type: 'leader', source_id: key.split(':').at(-1), title: '总裁安排事项', what: '领导安排', due: '', source_period: '第42周', source_author: '测试领导', status: 'in_progress', progress: '已对接', ...extra }; }
function coordination(id, extra = {}) { return { id, project_id: 'p1', owner_id: 'owner', author_id: 'other', author_name: '测试提出人', what: '协调事项', source_key: 'coord:p1:' + id, ...extra }; }
function savedCoord(id, extra = {}) { return saved('coord:p1:' + id, { source_type: 'coord', source_id: String(id), title: '他人需求事项', what: '协调事项', source_author: '测试提出人', ...extra }); }
function reportCoordination(ids) { return report('feedback-source', { coord_items: ids.map(id => ({ source_id: String(id), who_id: 'owner', who: '测试经理', what: '协调事项' })) }); }
function savedReportCoord(id, extra = {}) { return saved('coord:p1:feedback-source:coord:' + id, { source_type: 'coord', source_id: String(id), title: '他人需求事项', what: '协调事项', source_author: '其他专业', ...extra }); }
function previous(rows) { return report('previous', { author_id: 'owner', period: '第42周', submitted_at: '2026-10-13T08:00:00Z', biz: { followups: rows } }); }
function enableApproval(h) {
  h.S.profile.role = 'pm'; h.S.completions = [];
  vm.runInContext(completionSource, h.sandbox);
  h.sandbox.CompletionReview.configure({ ...h.options, loadData: async () => true });
  return h.sandbox.CompletionReview;
}

test('sources respect project, owner, selected period and existing name/module matching', () => {
  const h = harness();
  h.S.leaderNotes = [note(1), note(2, { project_id: 'p2' }), note(3, { period: '第44周', created_at: '2026-10-27T08:00:00Z' })];
  h.S.reporterTasks = [meeting('mine'), meeting('other', { owner_id: 'another' }), meeting('future', { created_at: '2026-10-27T08:00:00Z' })];
  h.S.reports = [report('source', { coord_items: [{ id: 'coord-id', who: '测试经理', what: '向本人协调' }, { who: '无关人员', what: '不相关' }],
    biz: { handover: [{ id: 'handover-id', to: '土建工程', what: '移交工作面' }] } }), report('self', { author_id: 'owner', coord_items: [{ who: '测试经理', what: '本人提出不带入' }] })];
  const notesBefore = JSON.stringify(h.S.leaderNotes);
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 3);
  assert.deepEqual(new Set(h.S.followupRows.map(row => row.source_type)), new Set(['coord', 'meeting']));
  assert.equal(JSON.stringify(h.S.leaderNotes), notesBefore, 'retired leader records are preserved without becoming new pending sources');
  assert.equal(h.S.followupRows.some(row => row.source_key.startsWith('leader:')), false);
  assert.match(h.S.followupRows.find(row => row.what === '向本人协调').source_key, /p1:source:coord:coord-id$/);
});

test('independent coordination reaches its exact owner without any report or selected-week dependency and preserves existing feedback',()=>{
  const h=harness();const completion=enableApproval(h);
  h.S.pmPeriod='第1周';h.S.coordinationTasks=[
    {id:'10000000-0000-4000-8000-000000000101',project_id:'p1',author_id:'other',author_name:'独立发起人',owner_id:'owner',what:'独立即时协调',due:'2026-11-01',created_at:'2026-12-01T00:00:00Z',source_key:'coord:p1:10000000-0000-4000-8000-000000000101'},
    {id:'other-person',project_id:'p1',owner_id:'another',what:'非本人承办'},
    {id:'other-project',project_id:'p2',owner_id:'owner',what:'非当前项目'}];
  h.S.pmReport={biz:{followups:[saved('leader:p1:original',{progress:'已填进展保留'})]}};
  h.api.prepare();
  const item=h.api.sourceItems().find(row=>row.independent);
  assert.equal(item.what,'独立即时协调');assert.equal(item.source_author,'独立发起人');assert.equal(item.source_type,'coord');
  assert.equal(h.S.reports.length,0);assert.equal(h.S.followupRows.length,2);assert.equal(h.S.followupRows[0].progress,'已填进展保留');
  h.api.prepareCoordination();assert.equal(h.S.followupRows.length,2,'repeated preparation cannot duplicate the independent source');
  h.S.completions=[{source_key:item.source_key,owner_id:'owner',status:'approved'}];
  assert.equal(completion.approved(item.source_key),true);assert.equal(h.api.sourceItems().some(row=>row.independent),false);
});

test('explicit coordination recipient ids override name and module mentions while legacy records still match', () => {
  const h = harness();
  h.S.reports = [report('named-targets', { coord_items: [
    { id: 'mine-id', who_id: 'owner', who: '曾用姓名', what: '需确认设计安排' },
    { id: 'another-id', who_id: 'someone-else', who: '测试经理', what: '请土建工程协同处理' },
    { id: 'invalid-id', who_id: '', who: '测试经理', what: '不能通过正文冒认实名接收人' },
    { id: 'legacy-name', who: '测试经理', what: '原姓名指派保留' },
    { id: 'legacy-body', who: '其他专业', what: '原土建工程需求保留' }
  ] })];
  assert.deepEqual(Array.from(h.api.sourceItems(), row => row.source_id), ['mine-id', 'legacy-name', 'legacy-body']);
});

test('wildcard module authorization matches every explicitly configured real module for coordination and handover', () => {
  const h = harness(); h.S.profile.biz_line = '*';
  assert.equal(BIZ_LINES.length, 13);
  h.S.reports = [report('all-modules', {
    coord_items: BIZ_LINES.map((line, i) => ({ id: 'coord-' + i, who: line, what: '协同事项' })),
    biz: { handover: BIZ_LINES.map((line, i) => ({ id: 'handover-' + i, to: line, what: '移交事项' })) }
  }), report('mentioned-module', { coord_items: [{ who: '其他专业', what: '请机电工程协同处理' }] })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, BIZ_LINES.length * 2 + 1);
  assert.equal(h.S.followupRows.filter(row => row.title === '他人需求事项').length, BIZ_LINES.length + 1);
  assert.equal(h.S.followupRows.filter(row => row.title === '他人工作面移交').length, BIZ_LINES.length);
});

test('wildcard module authorization excludes unknown modules and literal stars while preserving name matching', () => {
  const h = harness(); h.S.profile.biz_line = '*';
  h.S.reports = [report('wildcard-boundary', { coord_items: [
    { who: '未知模块', what: '无关事项' }, { who: '*', what: '星号不是事项接收人' },
    { who: '未知模块', what: '请*处理' }, { who: '测试经理', what: '点名协同' },
    { who: '未知模块', what: '请测试经理协同' }
  ], biz: { handover: [{ to: '*', what: '星号移交' }, { to: '未知模块', what: '未知移交' }] } })];
  h.api.prepare();
  assert.deepEqual(Array.from(h.S.followupRows, row => row.what), ['点名协同', '请测试经理协同']);
});

test('a fixed module stays limited to itself and a null module only matches explicit names', () => {
  for (const line of ['土建工程', null]) {
    const h = harness(); h.S.profile.biz_line = line;
    h.S.reports = [report('fixed-boundary', { coord_items: [
      { who: '土建工程', what: '土建事项' }, { who: '机电工程', what: '机电事项' },
      { who: '*', what: '星号事项' }, { who: '测试经理', what: '点名事项' }
    ] })];
    h.api.prepare();
    assert.deepEqual(Array.from(h.S.followupRows, row => row.what), line ? ['土建事项', '点名事项'] : ['点名事项']);
  }
});

test('an explicit extra-profession callback matches its coordination sources without adding another profession or rewriting old feedback',()=>{
  let lines=['建筑结构设计','设计部'];const h=harness({myBizLines:()=>lines});h.S.profile.biz_line='建筑结构设计';h.S.reports=[report('explicit-extra',{coord_items:[{id:'extra',who:'设计部',what:'附加专业协调事项'},{id:'foreign',who:'机电设计',what:'其他专业事项'}]})];const before=JSON.stringify(h.S.reports);
  assert.deepEqual(Array.from(h.api.sourceItems(),row=>row.what),['附加专业协调事项']);lines=['建筑结构设计'];assert.deepEqual(Array.from(h.api.sourceItems()),[]);assert.equal(JSON.stringify(h.S.reports),before);
});

test('wildcard authorization without a configured module list fails closed for module matching', () => {
  const h = harness({ bizLines: undefined }); h.S.profile.biz_line = '*';
  h.S.reports = [report('missing-list', { coord_items: [
    { who: '土建工程', what: '模块事项' }, { who: '*', what: '星号事项' }, { who: '测试经理', what: '点名事项' }
  ] })];
  h.api.prepare();
  assert.deepEqual(Array.from(h.S.followupRows, row => row.what), ['点名事项']);
});

test('the same coordination content in different source reports never shares an identity', () => {
  const h = harness(), item = { who: '测试经理', what: '相同文字' };
  h.S.reports = [report('a', { coord_items: [item] }), report('b', { coord_items: [item] })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 2);
  assert.notEqual(h.S.followupRows[0].source_key, h.S.followupRows[1].source_key);
});

test('historical prior personal feedback rolls forward; completed feedback suppresses its source', async () => {
  const h = harness({ currentPeriod: () => '第44周' });
  h.S.reports = [reportCoordination([1, 2]), previous([savedReportCoord('1', { status: 'completed' }), savedReportCoord('2')])];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].source_key, 'coord:p1:feedback-source:coord:2');
  assert.equal(h.S.followupRows[0].progress, '已对接');
  await h.api.refreshSources();
  assert.equal(h.S.followupRows.length, 1, 'refresh must not revive prior completed sources');
});

test('commercial wildcard modules prepare independent prior feedback for shared project sources', () => {
  const h = harness({ isCommercial: () => true }); h.S.profile.biz_line = '*';
  h.S.coordinationTasks = [coordination('1')];
  h.S.reporterTasks = [meeting('shared', { progress: '会议原始进度' })];
  const prior = (line, prefix) => ({ ...previous([
    savedCoord('1', { progress: prefix + '协调反馈' }),
    saved('meeting:p1:shared', { source_type: 'meeting', progress: prefix + '会议反馈' })
  ]), id: line || 'legacy-combined', line });
  h.S.reports = [prior('土建工程', '土建'), prior('机电工程', '机电'), prior(undefined, '综合')];
  for (const [line, coordinationProgress, meetingProgress] of [
    ['土建工程', '土建协调反馈', '土建会议反馈'],
    ['机电工程', '机电协调反馈', '机电会议反馈'],
    ['精装工程', '', '会议原始进度']
  ]) {
    h.S.pmLine = line; h.api.prepare();
    assert.equal(h.S.followupRows.length, 2);
    assert.equal(h.S.followupRows.find(row => row.source_key === 'coord:p1:1').progress, coordinationProgress);
    assert.equal(h.S.followupRows.find(row => row.source_key === 'meeting:p1:shared').progress, meetingProgress);
  }
  assert.equal(h.S.reports[0].biz.followups[0].progress, '土建协调反馈');
  assert.equal(h.S.reports[1].biz.followups[0].progress, '机电协调反馈');
});

test('historical completed feedback from another commercial module does not suppress an unreported module source', () => {
  const h = harness({ isCommercial: () => true, currentPeriod: () => '第44周' }); h.S.profile.biz_line = '*';
  h.S.reports = [reportCoordination([1]), { ...previous([savedReportCoord('1', { status: 'completed', progress: '土建已完成' })]), line: '土建工程' }];
  h.S.pmLine = '土建工程'; h.api.prepare();
  assert.equal(h.S.followupRows.length, 0);
  h.S.pmLine = '机电工程'; h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].source_key, 'coord:p1:feedback-source:coord:1');
  assert.equal(h.S.followupRows[0].status, 'open');
  assert.equal(h.S.followupRows[0].progress, '');
});

test('residential and omitted commercial callbacks retain project-wide prior feedback behavior', () => {
  for (const options of [{ isCommercial: () => false }, {}]) {
    const h = harness(options); h.S.pmLine = '综合';
    h.S.coordinationTasks = [coordination('1')];
    h.S.reports = [
      { ...previous([savedCoord('1', { progress: '较早反馈' })]), line: '土建工程', updated_at: '2026-10-13T08:00:00Z' },
      { ...previous([savedCoord('1', { progress: '最近反馈' })]), id: 'recent', line: '机电工程', updated_at: '2026-10-14T08:00:00Z' }
    ];
    h.api.prepare();
    assert.equal(h.S.followupRows.length, 1);
    assert.equal(h.S.followupRows[0].progress, '最近反馈');
  }
});

test('a submitted snapshot including an empty snapshot is not rewritten by new sources', () => {
  const h = harness(), existing = saved('leader:p1:1', { what: '当期原文', status: 'completed' });
  h.S.pmReport = report('current', { author_id: 'owner', biz: { followups: [existing] } });
  h.S.leaderNotes = [note(1, { what: '修改后的原文' }), note(2)];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].what, '当期原文');
  h.S.followupRows[0].progress = '编辑草稿';
  assert.equal(existing.progress, '已对接');
  h.S.pmReport.biz.followups = [];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 0);
});

test('explicit source refresh appends sources while preserving current feedback and completion', async () => {
  const h = harness();
  h.S.pmReport = report('current', { author_id: 'owner', biz: { followups: [savedCoord('1', { status: 'completed' })] } });
  h.S.coordinationTasks = [coordination('1'), coordination('2')];
  h.api.prepare();
  h.elements.followup_progress_0 = { value: '刚刚输入的内容' };
  await h.api.refreshSources();
  assert.equal(h.S.followupRows.length, 2);
  assert.equal(h.S.followupRows[0].status, 'completed');
  assert.equal(h.S.followupRows[0].progress, '刚刚输入的内容');
  assert.equal(h.S.pmReport.biz.followups.length, 1);
});

test('replacing a legacy item at the same array position never consumes the new item as old feedback', () => {
  const h = harness();
  const src = report('coord-source', { coord_items: [{ who: '测试经理', what: '原事项' }] });
  h.S.reports = [src]; h.api.prepare();
  const old = { ...h.S.followupRows[0], progress: '已反馈' };
  src.coord_items[0].what = '来源更新的事项';
  h.S.reports.push(previous([old]));
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 2);
  assert.equal(h.S.followupRows[0].progress, '已反馈');
  assert.equal(h.S.followupRows[0].source_updated, true);
  assert.equal(h.S.followupRows[0].source_missing, true);
  assert.equal(h.S.followupRows[0].what, '原事项');
  assert.equal(h.S.followupRows[1].what, '来源更新的事项');
  assert.equal(h.S.followupRows[1].progress, '');
});

test('removed sources preserve active feedback and are identified in the form', () => {
  const h = harness();
  h.S.reports = [previous([savedCoord('removed')])];
  h.api.prepare();
  assert.equal(h.S.followupRows[0].source_missing, true);
  assert.match(h.api.formHtml(), /来源已更新或已移除/);
});

test('meeting completion stays in its completion period then stops rolling despite an older open report', () => {
  const h = harness();
  const task = meeting('closed', { created_at: '2026-10-12T08:00:00Z', status: 'completed', completed_at: '2026-10-20T08:00:00Z' });
  h.S.reporterTasks = [task];
  h.S.reports = [previous([saved('meeting:p1:closed', { source_type: 'meeting' })])];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].status, 'completed');
  h.S.pmPeriod = '第44周'; h.api.prepare();
  assert.equal(h.S.followupRows.length, 0);
});

test('rich progress survives binding, capture, collect and saved history display with escaping', () => {
  const h = harness();
  h.S.followupRows = [saved('leader:p1:1', { title: '<script>title</script>', what: '<img src=x>' })];
  const doc = { ops: [{ insert: '当期反馈', attributes: { bold: true, color: '#d81e06' } }] };
  h.api.binding('followup_progress_0').set(doc);
  h.elements.followup_progress_0 = { value: '当期反馈' };
  const data = h.rt.collect({ biz: { followups: h.api.rows() } });
  assert.equal(data.rich_text.fields['biz.followups.0.progress'].ops[0].attributes.bold, true);
  const html = h.api.snapshotHtml(data);
  assert.match(html, /<strong>当期反馈<\/strong>/);
  assert.match(html, /&lt;script&gt;title&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
});

test('operator meeting creation assigns a project reporter, preserves rich text and reloads only meeting data', async () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.api.renderAdmin(); await h.api.edit();
  Object.assign(h.elements, { meeting_title: { value: '  新例会  ' }, meeting_what: { value: '会议事项' }, meeting_due: { value: '2026-10-25' },
    meeting_owner: { value: 'owner' } });
  h.api.binding('meeting_what').set({ ops: [{ insert: '会议事项', attributes: { bold: true } }] });
  await h.api.save();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/reporter-tasks/save');
  assert.equal(h.calls[0].body.title, '新例会');
  assert.equal(h.calls[0].body.owner_id, 'owner');
  assert.equal(h.calls[0].body.rich_text.fields.what.ops[0].attributes.bold, true);
  assert.equal(h.loads, 1);
  assert.equal(h.S.reporterTasks.length, 1);
});

test('PM can only update assigned progress while operator requires a project reporter candidate', async () => {
  const h = harness(); h.S.profile.role = 'pm';
  h.api.edit(); await h.api.save(); assert.equal(h.calls.length, 0);
  assert.doesNotMatch(h.api.workbenchHtml('p1'), /会中录入|onclick="ReporterTasks.edit\(\)"/);
  h.S.reporterTasks = [meeting('assigned')]; h.api.edit(0);
  h.elements.meeting_title = { value: '不能改写原主题' }; h.elements.meeting_due = { value: '2030-01-01' }; h.elements.meeting_progress = { value: '推进中' };
  await h.api.save(); assert.equal(h.calls[0].body.title, undefined); assert.equal(h.calls[0].body.due, undefined); assert.equal(h.calls[0].body.progress, '推进中');
  h.S.profile.role = 'ops'; h.api.renderAdmin(); await h.api.edit();
  h.elements.meeting_title = { value: '新会议' }; h.elements.meeting_what = { value: '待落实' }; h.elements.meeting_owner = { value: 'not-in-project' };
  await h.api.save(); assert.equal(h.calls.length, 1); assert.match(h.messages.at(-1)[0], /本项目名单/);
});

test('editing sends expected revision; 409 retains the submitted editing text', async () => {
  const h = harness({ request: async () => ({ error: { code: 'revision_conflict', message: 'conflict' } }) });
  h.S.profile.role = 'ops'; h.api.renderAdmin();
  h.S.reporterTasks = [meeting('existing', { revision: 3 })];
  await h.api.edit(0);
  h.elements.meeting_what = { value: '保留输入' };
  await h.api.save();
  assert.match(h.api.renderAdmin(), /保留输入/);
  assert.match(h.messages.at(-1)[0], /刷新数据后重新编辑/);
  assert.equal(h.loads, 0);
  const ok = harness(); ok.S.reporterTasks = [meeting('existing', { revision: 3 })];
  ok.api.edit(0); await ok.api.save();
  assert.equal(ok.calls[0].body.expected_revision, 3);
  assert.equal(ok.calls[0].body.id, 'existing');
  assert.equal(ok.calls[0].body.title, undefined);
  assert.equal(ok.calls[0].body.what, undefined);
  assert.equal(ok.calls[0].body.due, undefined);
});

test('network failure preserves edits; double clicks do not create a second request', async () => {
  let resolve, count = 0;
  const h = harness({ request: () => { count++; return new Promise(done => { resolve = done; }); } });
  h.S.profile.role = 'ops'; h.api.renderAdmin();
  h.S.reporterTasks = [meeting('existing')]; await h.api.edit(0); h.elements.meeting_what = { value: '不丢输入' };
  const saving = h.api.save(); await h.api.save();
  assert.equal(count, 1);
  resolve({ error: { message: '网络断开' } }); await saving;
  assert.match(h.api.renderAdmin(), /不丢输入/);
  assert.match(h.messages.at(-1)[0], /网络断开/);
});

test('a late save response cannot populate another signed-in account', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  h.S.reporterTasks = [meeting('existing')]; h.api.edit(0); h.elements.meeting_progress = { value: '旧用户内容' };
  const saving = h.api.save();
  const next = { ...h.S, uid: 'new-owner', reporterTasks: [] };
  h.api.configure({ ...h.options, S: next });
  resolve({ data: meeting('late') }); await saving;
  assert.equal(next.reporterTasks.length, 0);
  assert.equal(h.loads, 0);
});

test('local Monday after midnight belongs to the new week for meeting creation and completion', () => {
  const h = harness();
  const monday = '2026-10-18T16:05:00Z'; // 2026-10-19 00:05 Asia/Shanghai.
  assert.equal(new Date(monday).getDay(), 1);
  h.S.reporterTasks = [meeting('new-monday', { created_at: monday }), meeting('closed-monday', {
    created_at: '2026-10-12T01:00:00Z', status: 'completed', completed_at: monday
  })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 2);
  assert.equal(h.S.followupRows.find(row => row.source_id === 'new-monday').source_period, '第43周');
  assert.equal(h.S.followupRows.find(row => row.source_id === 'closed-monday').status, 'completed');
  h.S.pmPeriod = '第42周'; h.api.prepare();
  assert.equal(h.S.followupRows.some(row => row.source_id === 'new-monday'), false, 'future local-week meeting is not shown in the prior period');
});

test('source refresh actually reloads, prevents duplicate clicks and retains edits typed while waiting', async () => {
  const h = harness(); let resolve, count = 0;
  h.S.followupRows = [savedCoord('1')];
  h.S.coordinationTasks = [coordination('1')];
  h.elements.followup_progress_0 = { value: '刷新前草稿' };
  h.options.reloadSources = () => { count++; return new Promise(done => { resolve = done; }); };
  const refreshing = h.api.refreshSources();
  assert.match(h.api.formHtml(), /disabled>更新中/);
  await h.api.refreshSources(); assert.equal(count, 1);
  h.elements.followup_progress_0.value = '等待期间的新输入';
  h.S.coordinationTasks.push(coordination('2')); resolve(); await refreshing;
  assert.equal(h.S.followupRows.length, 2);
  assert.equal(h.S.followupRows[0].progress, '等待期间的新输入');
  assert.match(h.messages.at(-1)[0], /已更新可同步来源/);
  assert.doesNotMatch(h.api.formHtml(), /disabled>更新中/);
});

test('a failed source reload preserves current feedback and reports failure without a success notice', async () => {
  const h = harness({ reloadSources: async () => { throw new Error('读取会议来源失败'); } });
  h.S.followupRows = [saved('leader:p1:1')];
  h.elements.followup_progress_0 = { value: '保留我的输入' };
  await h.api.refreshSources();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].progress, '保留我的输入');
  assert.match(h.messages.at(-1)[0], /更新失败.*读取会议来源失败/);
  assert.equal(h.messages.at(-1)[1], 'err');
  assert.equal(h.messages.some(args => args[0].startsWith('已更新')), false);
  assert.doesNotMatch(h.api.formHtml(), /disabled>更新中/);
});

test('a source refresh finishing after changing project, period or module does not merge into the new form', async () => {
  for (const change of [S => { S.pmProject = 'p2'; }, S => { S.pmPeriod = '第44周'; }, S => { S.pmLine = '机电工程'; }]) {
    const h = harness(); let resolve;
    h.S.followupRows = [saved('leader:p1:1')];
    h.options.reloadSources = () => new Promise(done => { resolve = done; });
    const pending = h.api.refreshSources();
    change(h.S); h.S.followupRows = [saved('new-form', { progress: '新表单内容' })];
    resolve(); await pending;
    assert.equal(h.S.followupRows.length, 1);
    assert.equal(h.S.followupRows[0].source_key, 'new-form');
    assert.equal(h.S.followupRows[0].progress, '新表单内容');
    assert.equal(h.messages.length, 0);
  }
});

test('a source refresh rejected after changing module does not notify or save into the new form', async () => {
  let reject, saves = 0;
  const h = harness({ saveDraft: () => saves++, reloadSources: () => new Promise((resolve, fail) => { reject = fail; }) });
  h.S.followupRows = [saved('leader:p1:1')];
  const pending = h.api.refreshSources();
  h.S.pmLine = '机电工程'; h.S.followupRows = [saved('new-module', { progress: '新模块输入' })];
  const renders = h.renders;
  reject(new Error('旧模块读取失败')); await pending;
  assert.equal(h.S.followupRows[0].source_key, 'new-module');
  assert.equal(h.S.followupRows[0].progress, '新模块输入');
  assert.equal(saves, 1, 'only the original pre-refresh draft is saved');
  assert.equal(h.renders, renders);
  assert.equal(h.messages.length, 0);
  assert.doesNotMatch(h.api.formHtml(), /disabled>更新中/);
});

test('same user with a new session drops the old meeting editor and ignores a pending source refresh', async () => {
  const h = harness(); let resolve;
  h.S.profile.role = 'ops'; h.S.session = { id: 'old-session' }; h.api.configure(h.options); h.api.renderAdmin();
  h.S.reporterTasks = [meeting('existing')]; await h.api.edit(0); h.elements.meeting_what = { value: '旧会话未保存内容' }; h.api.capture();
  assert.match(h.api.renderAdmin(), /旧会话未保存内容/);
  h.options.reloadSources = () => new Promise(done => { resolve = done; });
  const pending = h.api.refreshSources();
  h.S.session = { id: 'new-session' }; h.S.followupRows = [saved('new-session-row')]; h.api.configure(h.options);
  assert.doesNotMatch(h.api.renderAdmin(), /旧会话未保存内容/);
  resolve(); await pending;
  assert.equal(h.S.followupRows[0].source_key, 'new-session-row');
  assert.equal(h.messages.length, 0);
});

test('a meeting reopened in a later period returns with current task status and preserves prior completion feedback', () => {
  // Viewing an older period uses its rolling snapshot; current live sync is covered below.
  const h = harness({ currentPeriod: () => '第44周' });
  const completed = saved('meeting:p1:reopened', { source_type: 'meeting', source_id: 'reopened', status: 'completed', progress: '前次已落实', source_revision: 2 });
  h.S.reports = [previous([completed])];
  h.S.reporterTasks = [meeting('reopened', { status: 'in_progress', revision: 3, completed_at: null, progress: '按新要求继续处理',
    created_at: '2026-10-12T08:00:00Z', updated_at: fixedTime })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  const row = h.S.followupRows[0];
  assert.equal(row.status, 'in_progress');
  assert.equal(row.progress, '按新要求继续处理');
  assert.equal(row.source_reopened, true);
  assert.equal(row.previous_completed_progress, '前次已落实');
  assert.equal(row.previous_completed_period, '第42周');
  assert.match(h.api.formHtml(), /会议事项已重新打开/);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, '前次已落实');
});

test('an unchanged open meeting does not override feedback completed in its own period', () => {
  // Viewing an older period uses its rolling snapshot; current live sync is covered below.
  const h = harness({ currentPeriod: () => '第44周' });
  h.S.reports = [previous([saved('meeting:p1:closed-in-report', { source_type: 'meeting', status: 'completed', source_revision: 1 })])];
  h.S.reporterTasks = [meeting('closed-in-report', { created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-14T08:00:00Z', revision: 1 })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 0);
});

test('a meeting completed then reopened in the same week rolls into the following week by revision evidence', () => {
  // Viewing an older period uses its rolling snapshot; current live sync is covered below.
  const h = harness({ currentPeriod: () => '第44周' });
  h.S.reports = [previous([saved('meeting:p1:same-week', { source_type: 'meeting', status: 'completed', source_revision: 2, progress: '上次完成' })])];
  h.S.reporterTasks = [meeting('same-week', { status: 'open', revision: 3, completed_at: null, created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-15T08:00:00Z' })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].status, 'open');
  assert.equal(h.S.followupRows[0].source_reopened, true);
  assert.equal(h.S.followupRows[0].previous_completed_progress, '上次完成');
});

test('old meeting feedback without a revision uses exact report saved time for reopen ordering', () => {
  // Viewing an older period uses its rolling snapshot; current live sync is covered below.
  const h = harness({ currentPeriod: () => '第44周' });
  const old = previous([saved('meeting:p1:legacy-reopen', { source_type: 'meeting', status: 'completed' })]);
  old.updated_at = '2026-10-14T10:00:00Z';
  h.S.reports = [old];
  h.S.reporterTasks = [meeting('legacy-reopen', { status: 'open', revision: 3, completed_at: null, created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-14T11:00:00Z' })];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1, 'same-week update after the saved feedback is a reopen');
  h.S.reporterTasks[0].updated_at = '2026-10-14T09:00:00Z';
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 0, 'task update before the completed feedback cannot reopen it');
});

test('damaged snapshot rows render valid content and a visible incomplete-data warning without crashing', () => {
  const h = harness();
  const raw = { biz: { followups: [null, 3, {}, saved('valid', { what: '可读取的事项' })] } };
  const html = h.api.snapshotHtml(raw);
  assert.match(html, /可读取的事项/);
  assert.match(html, /部分同步事项记录格式异常/);
  assert.match(html, /待核对原记录/);
  assert.equal(raw.biz.followups.length, 4);
  assert.equal(raw.biz.followups[0], null);
  assert.doesNotThrow(() => h.api.snapshotHtml({ biz: { followups: [null] } }));
  assert.match(h.api.snapshotHtml({ biz: { followups: 'damaged' } }), /格式异常/);
});

test('prepare reports an invalid saved list instead of replacing it with fresh sources or a normal empty result', () => {
  const h = harness();
  h.S.pmReport = report('bad-current', { author_id: 'owner', biz: { followups: { broken: true } } });
  h.S.leaderNotes = [note(1)];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 0);
  assert.match(h.api.validationError(), /格式异常/);
  assert.match(h.api.formHtml(), /未能完整读取/);
  assert.doesNotMatch(h.api.formHtml(), /本期暂无需要同步/);
  assert.deepEqual(h.S.pmReport.biz.followups, { broken: true });
});

test('damaged prior feedback and restored draft items also remain visibly incomplete', () => {
  const h = harness();
  h.S.reports = [previous([null, savedCoord('valid')])];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.match(h.api.validationError(), /格式异常/);
  assert.match(h.api.formHtml(), /部分同步事项记录格式异常/);
  h.S.reports = []; h.api.prepare();
  h.S.followupRows = [null, savedCoord('draft-valid')];
  assert.doesNotThrow(() => h.api.capture());
  assert.match(h.api.validationError(), /格式异常/);
  assert.match(h.api.formHtml(), /部分同步事项记录格式异常/);
  assert.equal(h.S.followupRows.length, 1);
});

test('approval mode rolls all personally completed sources until review rather than inventing legacy approval', () => {
  const h = harness(); enableApproval(h);
  h.S.coordinationTasks = [coordination('1')];
  h.S.reporterTasks = [meeting('meeting-complete', { status: 'completed', completed_at: '2026-10-14T08:00:00Z', created_at: '2026-10-12T08:00:00Z' })];
  h.S.reports = [report('source', { coord_items: [{ source_id: 'c1', who: '测试经理', what: '协调内容' }] }), previous([
    savedCoord('1', { status: 'completed' }),
    saved('coord:p1:source:coord:c1', { source_type: 'coord', status: 'completed' }),
    saved('meeting:p1:meeting-complete', { source_type: 'meeting', status: 'completed', source_revision: 1 })
  ])];
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 3);
  assert.equal(h.S.followupRows.every(r => r.status === 'completed'), true, 'historical personal completion feedback remains intact');
  assert.equal(h.S.completions.length, 0, 'no approval is synthesized from old completed fields');
  assert.equal(h.S.followupRows.some(row => row.source_type === 'leader'), false);
  assert.match(h.api.formHtml(), /完成.*延期申报/);
  assert.match(h.api.formHtml(), /未申请审核/);
  assert.match(h.api.workbenchHtml('p1'), /本人反馈完成/);
  assert.match(h.api.workbenchHtml('p1'), /完成.*延期申报/);
});

test('pending, another owner approval and changed-source approval all keep an item rolling', () => {
  const h = harness(); enableApproval(h);
  h.S.coordinationTasks = [coordination('1'), coordination('2'), coordination('3')];
  h.S.reports = [previous([1, 2, 3].map(id => savedCoord(String(id), { status: 'completed' })))];
  h.S.completions = [
    { id: '10000000-0000-4000-8000-000000000001', source_key: 'coord:p1:1', owner_id: 'owner', status: 'pending' },
    { id: '10000000-0000-4000-8000-000000000002', source_key: 'coord:p1:2', owner_id: 'another-owner', status: 'approved' },
    { id: '10000000-0000-4000-8000-000000000003', source_key: 'coord:p1:3', owner_id: 'owner', status: 'approved', effective_status: 'source_changed', source_changed: true }
  ];
  h.api.prepare(); assert.equal(h.S.followupRows.length, 3);
  h.S.completions[0].status = 'approved'; h.api.prepare();
  assert.equal(h.S.followupRows.length, 2);
  assert.equal(h.S.followupRows.some(r => r.source_key === 'coord:p1:1'), false);
  h.S.completions[1].owner_id = 'owner'; h.S.completions[2].source_changed = false; h.S.completions[2].effective_status = 'approved';
  h.api.prepare(); assert.equal(h.S.followupRows.length, 0);
});

test('approval removal affects new rolling rows while saved report snapshots remain unchanged', () => {
  const h = harness(); enableApproval(h);
  const original = saved('leader:p1:1', { status: 'completed', progress: '当期本人完成反馈' });
  h.S.pmReport = report('saved-current', { author_id: 'owner', biz: { followups: [original] } });
  h.S.completions = [{ source_key: 'leader:p1:1', owner_id: 'owner', status: 'approved' }];
  h.api.prepare(); assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].status, 'completed');
  assert.match(h.api.snapshotHtml(h.S.pmReport), /当期本人反馈/);
  assert.equal(original.progress, '当期本人完成反馈');
});

test('current-week meeting feedback uses live task revision while preserving prior completion history', () => {
  const h = harness();
  h.S.reports = [previous([saved('meeting:p1:current-live', { source_type: 'meeting', status: 'completed',
    source_revision: 2, progress: '历史已完成反馈' })])];
  h.S.reporterTasks = [meeting('current-live', { status: 'in_progress', revision: 3,
    created_at: '2026-10-12T08:00:00Z', progress: '当前实时会议进展' })];
  const history = JSON.stringify(h.S.reports);
  h.api.prepare();
  assert.equal(h.S.followupRows.length, 1);
  assert.equal(h.S.followupRows[0].source_revision, 3);
  assert.equal(h.S.followupRows[0].progress, '当前实时会议进展');
  assert.equal(h.S.followupRows[0].status, 'in_progress');
  assert.equal(JSON.stringify(h.S.reports), history);
  assert.match(h.api.snapshotHtml(h.S.reports[0]), /历史已完成反馈/);
  assert.match(h.api.formHtml(), /当前实时会议进展/);
});
