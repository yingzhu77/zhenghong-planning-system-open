import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const richSource = readFileSync(new URL('../web/rich-text.js', import.meta.url), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);

function harness(options = {}) {
  const elements = { root: { innerHTML: '' }, toast: { style: {} } }, writes = [];
  let failId;
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, removeEventListener() {}, body: { appendChild() {} }
    },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ auth: {}, database: {
      from(table) {
        let payload, id;
        const chain = {
          update(value) { payload = value; return chain; },
          eq(key, value) { if (key === 'id') id = value; return chain; }, select() { return chain; },
          then(resolve, reject) {
            writes.push({ table, id, payload });
            return Promise.resolve(id === failId ? { data: [], error: { message: 'anonymous failure' } } : { data: [{ id, ...payload }], error: null }).then(resolve, reject);
          }
        };
        return chain;
      }
    } }) },
    ReporterTasks: { configure() {}, binding() { return null; }, capture() {}, prepare() {},
      sourceItems: () => [], snapshotHtml: () => '', pendingHtml: pid => '<section class="card reporter-pending">统一待处理事项 ' + pid + '</section>' }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(richSource, sandbox);
  if (options.merged) for (const name of ['planning-windows.js','report-scopes.js']) vm.runInContext(readFileSync(new URL('../web/' + name, import.meta.url),'utf8'),sandbox);
  vm.runInContext(source.slice(0, boundary) + '\nwindow.__workbench={S,App,viewMyLine,viewPMCenter,viewPMCenterRes,viewMyProjects,submittedThisWeek,reportHistoryHtml,planningNavItems,richBinding,currentPeriod,personalPriorityCard};\n})();', sandbox);
  const h = sandbox.__workbench, S = h.S;
  S.uid = 'anonymous-pm';
  S.profile = { user_id: S.uid, role: 'pm', status: 'approved', project_id: 'a', name: '匿名填报人' };
  S.projects = [{ id: 'a', name: '住宅项目甲', sort_order: 1 }, { id: 'b', name: '商业项目乙', project_type: 'com', sort_order: 2 }, { id: 'private', name: '未授权项目' }];
  S.pms = [{ user_id: S.uid, project_id: 'a' }, { user_id: S.uid, project_id: 'b' }];
  S.pmProject = 'a'; S.pmPeriod = h.currentPeriod(); S.view = 'mline';
  S.reports = []; S.milestones = []; S.orgList = []; S.reviews = []; S.leaderNotes = [];
  return { ...h, sandbox, elements, writes, fail: id => { failId = id; } };
}
function node(id, project_id, extra = {}) {
  return { id, project_id, name: '匿名节点' + id, line: '工程', plan_date: '2027-03-01', forecast_date: '', note: '', done: false, ...extra };
}

test('reporter project filter, date modes, grouping and discipline respect authorized projects', () => {
  const h = harness();
  h.S.milestones = [node(1, 'a', { name: '计划早但预计晚', plan_date: '2027-01-01', forecast_date: '2027-04-01' }), node(2, 'a', { name: '预计先到期', plan_date: '2027-03-01', forecast_date: '2027-02-01' }), node(3, 'b', { name: '乙项目设计节点', line: '设计' }), node(4, 'private', { name: '不可见节点' })];
  let html = h.viewMyLine();
  const rows = html.slice(html.indexOf('我负责的节点'));
  assert.ok(rows.indexOf('预计先到期') < rows.indexOf('计划早但预计晚'));
  assert.match(rows, /data-project="a"/); assert.match(rows, /data-project="b"/);
  assert.doesNotMatch(html, /不可见节点|未授权项目/);
  h.S.filters.mlineSort = 'plan';
  html = h.viewMyLine();
  const planRows = html.slice(html.indexOf('我负责的节点'));
  assert.ok(planRows.indexOf('计划早但预计晚') < planRows.indexOf('预计先到期'));
  h.S.filters.mlineP = 'b';
  html = h.viewMyLine();
  assert.doesNotMatch(html, /data-milestone="[124]"|匿名节点4/); assert.match(html, /data-milestone="3"/);
  h.S.profile.discipline = '工程';
  assert.doesNotMatch(h.viewMyLine(), /ml_fc_3|data-milestone="3"/);
  h.App.mlineFilter('mlineP', 'private');
  assert.equal(h.S.filters.mlineP, 'b');
});

test('the read-only project tables preserve every authorized node without weekly editing controls', () => {
  const h = harness();
  h.S.milestones = Array.from({ length: 24 }, (_, i) => node(i + 1, i % 2 ? 'b' : 'a', { name: i === 0 ? '项目施工图设计' : i === 1 ? '竣工验收' : '自定义事项' + i, done: i === 23 }));
  const html = h.viewMyLine(), rows = html.slice(html.indexOf('我负责的节点'));
  assert.equal((rows.match(/data-milestone="/g) || []).length, 24);
  assert.doesNotMatch(rows, /id="ml_fc_|id="ml_note_|App\.mlineSave\(|保存预计时间与说明/);
  assert.match(rows, /完成[／/]延期申报/);
  assert.match(rows, /项目施工图设计/); assert.match(rows, /竣工验收/); assert.match(rows, /自定义事项23/);
  assert.match(rows, /data-project="a"/); assert.match(rows, /data-project="b"/);
  assert.doesNotMatch(html, /专业流水线|reporter-flow-stages|上游没交|下游就动不了/);
});

test('capturing an unchanged node does not create a dirty draft or write request', async () => {
  const h = harness();
  h.S.milestones = [node(1, 'a')];
  h.elements.ml_fc_1 = { value: '' }; h.elements.ml_note_1 = { value: '' };
  h.App.mlineCapture();
  assert.equal(Object.keys(h.S.mlineDraft).length, 0);
  await h.App.mlineSave();
  assert.equal(h.writes.length, 0);
});

test('workbench keeps residential node analysis, limits pending work to critical sources, and preserves monthly content in history', () => {
  const h = harness();
  h.S.reports = [{ id: 1, author_id: h.S.uid, project_id: 'a', period: h.S.pmPeriod,
    node_items: [{ name: '住宅研判节点', plan: '2027-01-01', forecast: '2027-01-20', reason: '匿名原因' }],
    next_items: ['旧版下周工作内容'], coord_items: [],
    biz: { form_version: 2, items: [{ mod: '工程', name: '新版计划事项', due: '2027-01-05', prog: '推进中', rich_text: { v: 1, fields: { name: { ops: [{ insert: '新版计划事项', attributes: { bold: true } }] } } } }] } }];
  h.sandbox.ZHRichText.attach(h.S.reports[0]);
  h.sandbox.ReporterTasks.sourceItems = () => ['a', 'b'].flatMap(pid => [
    {source_key: 'meeting:' + pid + ':meeting-1', source_type: 'meeting', title: '会议要求', what: '明确会议重点', due: '2020-01-01', progress: '会议推进中',
      rich_text: {v: 1, fields: {what: {ops: [{insert: '明确会议重点', attributes: {bold: true, color: '#d81e06'}}]}}}},
    {source_key: 'leader:' + pid + ':leader-1', source_type: 'leader', title: '领导交办', what: '领导交办重点', due: '2020-01-02', progress: ''},
    {source_key: 'coord:' + pid + ':report-1:coord:item-1', source_type: 'coord', title: '他人需求', what: '他人指向本人的需求', due: '', progress: ''},
    {source_key: 'plan:' + pid + ':report-1:items:item-1', source_type: 'plan', title: '当月计划', what: '不可混入待处理的月度来源', due: '', progress: ''}
  ]).concat({source_key: 'meeting:private:meeting-2', source_type: 'meeting', title: '会议要求', what: '不可混入的其他项目事项', due: '', progress: ''});
  const res = h.viewPMCenterRes('a');
  assert.match(res, /workgrid onecol/); assert.match(res, /住宅研判节点/); assert.match(res, /偏差 ≥15 天/);
  const pending = h.personalPriorityCard('a');
  assert.match(pending, /<span class="rt-red"><strong>明确会议重点<\/strong><\/span>/);
  assert.doesNotMatch(pending, /领导交办重点/); assert.match(pending, /他人指向本人的需求/); assert.match(pending, /P0 紧急/);
  assert.doesNotMatch(pending, /新版计划事项|住宅研判节点|不可混入待处理的月度来源|不可混入的其他项目事项/);
  assert.match(h.reportHistoryHtml(h.S.reports[0]), /<strong>新版计划事项<\/strong>/);
  assert.equal(h.S.reports[0].biz.items[0].prog, '推进中');
  assert.doesNotMatch(res, /<aside|下周必须完成|我的近期台账|需要谁协调/);
  assert.equal((res.match(/class="card reporter-pending"/g) || []).length,1);
  assert.doesNotMatch(res,/他人向我提出的需求|会议跟踪事项|personal-priority-summary/);
  h.S.pmProject = 'b';
  const biz = h.viewPMCenter();
  assert.doesNotMatch(biz, /我的模块分布/);
  const commercialPending = h.personalPriorityCard('b');
  assert.match(commercialPending, /明确会议重点|他人指向本人的需求/);assert.doesNotMatch(commercialPending,/领导交办重点/);
  assert.doesNotMatch(commercialPending, /新版计划事项|住宅研判节点|不可混入待处理的月度来源|不可混入的其他项目事项/);
  assert.equal((biz.match(/class="card reporter-pending"/g) || []).length,1);
  assert.doesNotMatch(biz,/他人向我提出的需求|会议跟踪事项|personal-priority-summary/);
  const nav = h.planningNavItems();
  assert.equal(nav[0].k, 'center'); assert.equal(nav[1].k, 'mline');
});

test('merged professional personal status and workbench ignore peer disciplines, peer authors and original comprehensive reports', () => {
  const h = harness({merged:true}), S = h.S, period = '2026-10-12';
  const scope = {id:'anonymous-professional-scope',name:'合并住宅',anchor_project_id:'a',project_ids:['a','phase'],
    reporting_mode:'professional',effective_week:'2026-10-19'};
  S.projects.push({id:'phase',name:'原二期',project_type:'res'});
  S.pms.push({user_id:S.uid,project_id:'phase'});
  Object.assign(S,{pmReportScope:scope,pmScopeId:scope.id,pmPeriod:period,pmLine:'工程',view:'center',reportScopes:[scope]});
  S.profile.discipline = '工程';
  function report(id,name,extra={}) {return {id,project_id:'a',period,line:'工程',report_scope_id:scope.id,
    scope_project_ids:scope.project_ids.slice(),author_id:S.uid,author_name:'原作者',submitted_at:'2026-10-13T01:00:00Z',
    node_items:[{source_id:'node-'+id,name:name+'节点',custom:true,plan:'2026-10-15',forecast:'2026-10-16'}],
    biz:{form_version:2,nodes:[],items:[{source_id:'item-'+id,mod:'工程',name,prog:'原进展'}]},...extra};}
  S.reports=[report(11,'其他专业已提交',{line:'设计',author_id:'peer-designer'}),
    report(12,'本人原综合',{line:'综合'}),report(13,'本人原分期综合',{line:'综合',report_scope_id:null,scope_project_ids:null}),
    report(14,'同专业另一作者',{author_id:'peer-engineer'}),report(15,'本人另一范围',{report_scope_id:'other-scope'}),
    report(16,'本人原分期专业',{report_scope_id:null,scope_project_ids:null})];
  const before = JSON.stringify(S.reports);
  assert.equal(h.submittedThisWeek('a'),false,'他专业、他人作者、旧综合或旧范围不能标记本人已报');
  let projectRow = h.viewMyProjects().split('<tr>').find(row=>row.includes('<b>合并住宅</b>'));
  assert.ok(projectRow);assert.match(projectRow,/未填报/);assert.doesNotMatch(projectRow,/badge green">已填报/);
  let center = h.viewPMCenterRes('a');
  assert.match(center,/尚未填报/);
  assert.doesNotMatch(center,/其他专业已提交|本人原综合|本人原分期综合|同专业另一作者|本人另一范围|本人原分期专业/);
  assert.match(h.reportHistoryHtml(S.reports[1]),/本人原综合/,'旧综合内容仍能通过原只读历史查看');
  S.reports.push(report(17,'本人本专业当前提交'));
  assert.equal(h.submittedThisWeek('a'),true);
  projectRow = h.viewMyProjects().split('<tr>').find(row=>row.includes('<b>合并住宅</b>'));
  assert.match(projectRow,/badge green">已填报/);
  center = h.viewPMCenterRes('a');
  assert.match(center,/本人本专业当前提交/);
  assert.doesNotMatch(center,/其他专业已提交|本人原综合|本人原分期综合|同专业另一作者|本人另一范围|本人原分期专业/);
  assert.equal(JSON.stringify(S.reports.slice(0,-1)),before,'展示不得更改旧报告身份、内容或来源');
  assert.deepEqual(h.writes,[]);
});

test('filter changes preserve unsaved dates and rich notes; save includes hidden authorized drafts and retains failures', async () => {
  const h = harness();
  h.S.milestones = [node(1, 'a'), node(2, 'b'), node(3, 'private')];
  h.elements.ml_fc_1 = { value: '2027-05-01' }; h.elements.ml_note_1 = { value: '保留加粗说明' };
  h.richBinding('ml_note_1').set({ ops: [{ insert: '保留加粗说明', attributes: { bold: true } }] });
  h.App.mlineFilter('mlineP', 'b');
  delete h.elements.ml_fc_1; delete h.elements.ml_note_1;
  h.elements.ml_fc_2 = { value: '2027-06-01' }; h.elements.ml_note_2 = { value: '保存失败应保留' };
  h.S.mlineDraft[3] = { forecast_date: '2027-10-01', note: '不能越权写入' };
  h.fail(2);
  await h.App.mlineSave();
  assert.deepEqual(h.writes.map(x => x.id), [1, 2]);
  assert.equal(h.writes[0].payload.forecast_date, '2027-05-01');
  assert.equal(h.writes[0].payload.rich_text.fields.note.ops[0].attributes.bold, true);
  assert.equal(h.S.mlineDraft[1], undefined);
  assert.equal(h.S.mlineDraft[2].note, '保存失败应保留');
  assert.equal(h.S.mlineDraft[3].note, '不能越权写入');
  assert.equal(h.S.milestones[0].plan_date, '2027-03-01');
});
