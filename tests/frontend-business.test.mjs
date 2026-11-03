import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace('window.App = App;', 'window.App = App; window.audit = { S, maxDelay, suggestSpeed, statusOf, itemOverdue, itemState, viewDual, viewBoard, viewPres, viewPresCom, viewMyProjects, viewPMForm, viewMaster, viewMembers, viewPMCenter, viewPMHistory, reporterNodeSectionHtml, reportHistoryHtml, briefRowsHtml, buildNodeRows, buildEditRows, buildBizRows, currentPeriod, configureReporter, preparePM, loadPageData, reportAttachmentScope, planningAIContext, BIZ_LINES, businessLinesForProject, myBizLines, canReportBizLine, lineStat, overviewFilterHtml, draftKey }; renderShell = function () {};')
  .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');

function fixture(richText = false, modules = false) {
  const calls = [], requests = [];
  const elements = new Map([
    ['root', { innerHTML: '', querySelectorAll: () => [] }],
    ['toast', { style: {} }], ['f_change', { value: '本周变化' }], ['obName', { value: '申请人' }]
  ]);
  let handler = operation => operation.operation === 'insert'
    ? { data: [operation.values], error: null } : { data: [], error: null };
  let requestHandler = () => ({ data: [], error: null });
  const db = { from(table) {
    const operation = { table, operation: 'select', filters: [] };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(column, value) { operation.filters.push({ column, value }); return q; },
      insert(values) { operation.operation = 'insert'; operation.values = values; return q; },
      update(values) { operation.operation = 'update'; operation.values = values; return q; },
      upsert(values) { operation.operation = 'upsert'; operation.values = values; return q; },
      delete() { operation.operation = 'delete'; return q; },
      then(resolve, reject) { calls.push(operation); return Promise.resolve(handler(operation)).then(resolve, reject); }
    };
    return q;
  } };
  const window = { WorkBuddyCloud: { createWorkBuddyCloud: () => ({ database: db }) }, confirm: () => true };
  const storage = { getItem: () => null, removeItem() {}, setItem() {} };
  const context = {
    window, document: { getElementById: id => elements.get(id) || null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    localStorage: storage, Date, console,
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      const body=options.body===undefined?{}:JSON.parse(options.body);requests.push({ url, ...options, json: body });
      const result = requestHandler(url, body);
      return { ok: !result.error, json: async () => result };
    }
  };
  window.document = context.document;
  window.localStorage=storage;
  if(richText) vm.runInNewContext(fs.readFileSync(new URL('../web/rich-text.js', import.meta.url), 'utf8'),context);
  if (modules) for (const name of ['reporter-tasks.js', 'completion-review.js', 'report-attachments.js']) {
    vm.runInNewContext(fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'), context, {filename: name});
  }
  vm.runInNewContext(source, context);
  const audit = window.audit;
  Object.assign(audit.S, { uid: 'u1', profile: { name: '测试', role: 'pm', status: 'approved' }, pmProject: 'p1', projects: [{ id: 'p1', name: '测试项目', project_type: 'res' }] });
  if (modules) audit.configureReporter();
  return { ...audit, App: window.App, ReportAttachments: window.ReportAttachments, ReporterTasks: window.ReporterTasks, CompletionReview: window.CompletionReview,
    calls, requests, elements, storage, loadModule(name){vm.runInNewContext(fs.readFileSync(new URL('../web/'+name,import.meta.url),'utf8'),context);audit.configureReporter();return window;},setHandler(fn) { handler = fn; }, setRequestHandler(fn) { requestHandler = fn; } };
}

test('commercial module switching is explicit for wildcard accounts and fixed or unassigned accounts stay locked', async () => {
  for (const assignment of ['*', '机电工程', null, '未知模块']) {
    const f = fixture(false, true);
    Object.assign(f.S.profile, {project_id: 'p1', biz_line: assignment});
    f.S.projects[0].project_type = 'com'; f.S.view = 'form'; f.S.pmLine = '精装工程';
    await f.preparePM();
    const html = f.viewPMForm();
    if (assignment === '*') {
      assert.equal(f.S.pmLine, '精装工程');
      assert.match(html, /测试账号 · 可切换商业模块/);
      const select = html.match(/<select id="planBizLine"[\s\S]*?<\/select>/)[0];
      assert.equal((select.match(/<option /g) || []).length, f.businessLinesForProject('p1').length);
      for (const line of f.businessLinesForProject('p1')) assert.ok(select.includes('value="' + line + '"'));
      assert.doesNotMatch(select, /value="\*"/);
    } else {
      assert.doesNotMatch(html, /id="planBizLine"|App\.pmLineSet/);
      assert.equal(f.S.pmLine, assignment === '机电工程' ? assignment : '');
      assert.match(html, assignment === '机电工程' ? /我的模块（固定 · 管理员指定）/ : /待管理员分配/);
      const before = f.S.pmLine;
      await f.App.pmLineSet(f.BIZ_LINES[0]);
      assert.equal(f.S.pmLine, before); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
    }
  }
});

test('unassigned commercial reports retain drafts while submission and attachment upload stop before any request', async () => {
  const f = fixture(false, true), drafts = new Map();
  Object.assign(f.S.profile, {project_id: 'p1', biz_line: null});
  f.S.projects[0].project_type = 'com'; f.S.view = 'form'; f.S.pmLine = f.BIZ_LINES[0];
  const legacyKey = f.draftKey(), legacy = JSON.stringify({ts: Date.now(), bizNodes: [{name: '先前模块草稿'}]});
  drafts.set(legacyKey, legacy);
  f.storage.getItem = key => drafts.get(key) || null;
  f.storage.setItem = (key, value) => drafts.set(key, value);
  f.storage.removeItem = key => drafts.delete(key);
  await f.preparePM();
  assert.equal(f.S.pmLine, ''); assert.equal(f.S.pmReport, null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.reportAttachmentScope())), {ids: []});
  f.S.bizNodes = [{name: '等待分配时的草稿', prog: '待管理员确认模块'}];
  await f.App.submitReport();
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(drafts.get(legacyKey), legacy, 'revoking a module must not delete its previously saved local draft');
  assert.equal(JSON.parse(drafts.get(f.draftKey())).bizNodes[0].name, '等待分配时的草稿');
  assert.match(f.viewPMForm(), /onclick="App.submitReport\(\)" disabled/);
  assert.doesNotMatch(f.ReportAttachments.formHtml(), /id="report-attachment-upload"/);
  await f.ReportAttachments.upload({files: [{name: '未授权.png', type: 'image/png', size: 1234}], value: 'selected'});
  assert.equal(f.requests.length, 0, 'no upload may use a guessed or wildcard module');
  await f.App.saveHand(); await f.App.saveCoord();
  assert.equal(f.calls.length, 0, 'legacy direct save actions must honor missing module assignment');
});

test('wildcard module selector rejects unknown values, unauthorized projects and lost draft storage', async () => {
  const f = fixture(); Object.assign(f.S.profile, {project_id: 'p1', biz_line: '*'});
  const initial = f.BIZ_LINES[0];
  f.S.projects[0].project_type = 'com'; f.S.pmLine = initial; f.S.view = 'form';
  await f.App.pmLineSet('*'); await f.App.pmLineSet('未知模块');
  assert.equal(f.S.pmLine, initial); assert.equal(f.calls.length, 0);
  f.S.projects.push({id: 'unassigned', project_type: 'com'}); f.S.pmProject = 'unassigned';
  await f.App.pmLineSet('机电工程'); assert.equal(f.S.pmLine, initial);
  f.S.pmProject = 'p1'; f.storage.setItem = () => {throw new Error('storage unavailable');};
  await f.App.pmLineSet('机电工程');
  assert.equal(f.S.pmLine, initial, 'failed local storage must retain the current module and input');
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
});

test('wildcard accounts switch every actual report module with separate rich drafts and attachment metadata', async () => {
  const f = fixture(true, true), store = new Map(), lines = Array.from(f.businessLinesForProject('p1')), period = '第43周';
  Object.assign(f.S.profile, {project_id: 'p1', biz_line: '*'});
  f.S.projects[0].project_type = 'com'; f.S.view = 'form'; f.S.pmPeriod = period;
  const projects = structuredClone(f.S.projects);
  const reports = lines.map((line, index) => ({id: index + 1, project_id: 'p1', period, line, author_id: 'u1', author_name: '测试',
    submitted_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', node_items: [], coord_items: [],
    biz: {nodes: [{source_id: 'node-' + index, name: line + '节点', plan: '2027-01-01', prog: line + '原进展'}],
      items: [], followups: [], attachments: ['10000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')]}}));
  const original = JSON.stringify(reports);
  f.storage.getItem = key => store.get(key) || null; f.storage.setItem = (key, value) => store.set(key, value); f.storage.removeItem = key => store.delete(key);
  f.setHandler(op => op.operation === 'upsert' ? {data: null, error: {message: 'capture payload only'}}
    : {data: op.table === 'projects' ? projects : op.table === 'reports' ? reports : []});
  f.setRequestHandler((url, body) => {
    if (url !== '/api/report-attachments/list') return {data: []};
    assert.ok(lines.includes(body.line), 'attachment list uses an actual authorized module');
    const report = reports.find(row => row.line === body.line);
    return {data: [{id: report.biz.attachments[0], owner_id: 'u1', project_id: 'p1', period, line: body.line,
      name: body.line + '附件.pdf', mime: 'application/pdf', size: 1234, inline: true}]};
  });
  await f.loadPageData(); await f.preparePM();
  assert.equal(f.S.pmLine, lines[0]);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    assert.equal(f.S.pmLine, line); assert.equal(f.S.pmReport.line, line);
    assert.equal(f.S.bizNodes[0].name, line + '节点');
    f.S.bizNodes[0].prog = line + '本机草稿';
    f.S.bizNodes[0]._rich = {prog: {ops: [{insert: line + '本机草稿', attributes: {bold: true}}]}};
    assert.deepEqual(Array.from(f.S.attachmentIds), reports[index].biz.attachments);
    assert.equal(f.ReportAttachments.validationError(), '');
    await f.App.pmLineSet(lines[(index + 1) % lines.length]);
  }
  for (const line of lines) {
    if (f.S.pmLine !== line) await f.App.pmLineSet(line);
    assert.equal(f.S.bizNodes[0].prog, line + '本机草稿');
    assert.equal(f.S.bizNodes[0]._rich.prog.ops[0].attributes.bold, true);
    assert.equal(f.S.reportAttachments[0].line, line);
    assert.equal(f.ReportAttachments.validationError(), '');
  }
  assert.equal(store.size, lines.length); assert.equal(JSON.stringify(reports), original, 'switching does not mutate saved report arrays');
  await f.App.submitReport();
  const write = f.calls.find(op => op.operation === 'upsert');
  assert.equal(write.values.line, lines.at(-1));
  assert.deepEqual(Array.from(write.values.biz.attachments), reports.at(-1).biz.attachments);
  assert.notEqual(write.values.line, '*');
});

test('workbench original-report action carries its actual module and revoked modules cannot reopen for editing', async () => {
  const f = fixture(false, true); Object.assign(f.S.profile, {project_id: 'p1', biz_line: '*'});
  f.S.projects[0].project_type = 'com'; f.S.pmLine = f.BIZ_LINES[0]; f.S.view = 'center';
  const report = {id: 12, project_id: 'p1', period: '第42周', line: '机电工程', author_id: 'u1',
    biz: {items: [{source_id: 'mep-item', name: '机电原事项'}], nodes: [{name: '机电原自主节点'}]}};
  f.S.reports = [report]; f.configureReporter();
  const workbench = f.reporterNodeSectionHtml('p1');
  assert.match(workbench, /机电原自主节点/);
  assert.match(workbench, /App.fillProject\(&quot;p1&quot;,&quot;第42周&quot;,&quot;机电工程&quot;\)/);
  assert.doesNotMatch(workbench, /机电原事项/, 'monthly plan items are maintained in the reporting form rather than repeated in the node workbench');
  assert.match(f.viewMyProjects(), /全部商业模块（测试）/);
  assert.match(f.viewPMCenter(), /全部商业模块（测试）/);
  assert.match(f.viewPMHistory(), /机电工程/);
  f.setHandler(op => ({data: op.table === 'projects' ? f.S.projects : op.table === 'reports' ? [report] : []}));
  await f.App.fillProject('p1', '第42周', '机电工程');
  assert.equal(f.S.pmLine, '机电工程'); assert.equal(f.S.pmReport.id, 12);
  f.S.profile.biz_line = f.BIZ_LINES[0]; f.S.pmLine = f.BIZ_LINES[0]; f.calls.length = 0; f.requests.length = 0;
  assert.doesNotMatch(f.reporterNodeSectionHtml('p1'), /机电原自主节点|App.fillProject/, 'revoked source modules must not expose a completion action for personal old reports');
  await f.App.fillProject('p1', '第42周', '机电工程');
  assert.equal(f.S.pmLine, f.BIZ_LINES[0]); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  assert.match(f.viewPMHistory(), /机电工程/, 'revoking wildcard write access preserves project-readable history');
});

test('operations member assignment exposes an explicit test wildcard alongside fixed real modules', () => {
  const f = fixture(); f.S.profile.role = 'ops'; f.S.projects[0].project_type = 'com';
  f.S.members = [{user_id: 'assigned', role: 'pm', status: 'approved', name: '匿名测试填报人', biz_line: '*', project_id: 'p1'}];
  const html = f.viewMembers();
  assert.match(html, /<option value="\*" selected>全部商业模块（测试）<\/option>/);
  for (const line of f.businessLinesForProject('p1')) assert.ok(html.includes('<option value="' + line + '"'));
  assert.doesNotMatch(html,/<option value="设计部"/);
});

test('design department is available only in its commercial project and does not extend fixed designer permissions or draft identity',async()=>{
  const f=fixture(false,true);f.S.projects=[{id:'hf',name:'匿名新部门项目',project_type:'com'},{id:'p1',name:'匿名其他商业',project_type:'com'}];f.S.pms=[{project_id:'hf',user_id:'u1'},{project_id:'p1',user_id:'u1'}];f.S.profile.project_id='hf';f.S.pmProject='hf';f.S.view='form';
  assert.equal(f.BIZ_LINES.length,13);assert.equal(f.businessLinesForProject('hf').length,13);assert.equal(f.businessLinesForProject('p1').length,12);assert.equal(f.businessLinesForProject().length,12);
  f.S.profile.biz_line='设计部';await f.preparePM();assert.equal(f.S.pmLine,'设计部');assert.match(f.viewPMForm(),/我的模块（固定 · 管理员指定）/);assert.match(f.viewPMForm(),/<b>设计部<\/b>/);const key=f.draftKey();assert.match(key,/设计部/);
  const original=JSON.stringify(f.S.profile);await f.App.fillProject('p1','第43周','设计部');assert.equal(f.S.pmProject,'hf');assert.equal(f.S.pmLine,'设计部');assert.equal(f.draftKey(),key);assert.equal(JSON.stringify(f.S.profile),original);assert.equal(f.requests.length,0);
  for(const line of ['建筑结构设计','机电设计','精装设计']){f.S.profile.biz_line=line;await f.preparePM();assert.equal(f.S.pmLine,line);assert.equal(f.canReportBizLine('设计部','hf'),false);await f.App.fillProject('hf','第43周','设计部');assert.equal(f.S.pmLine,line);}
  f.S.profile.biz_line='*';assert.ok(f.myBizLines('hf').includes('设计部'));assert.ok(!f.myBizLines('p1').includes('设计部'));assert.equal(f.lineStat('hf').total,13);assert.equal(f.lineStat('p1').total,12);
  f.S.profile.biz_line='设计部';f.S.pmProject='p1';await f.preparePM();assert.equal(f.S.pmLine,'');assert.doesNotMatch(f.viewPMForm(),/<b>设计部<\/b>/);assert.equal(f.canReportBizLine('设计部','p1'),false);
});

test('management department options and overview cards are scoped without moving the three original design reports',()=>{
  const f=fixture();f.S.profile.role='ops';f.S.projects=[{id:'hf',name:'匿名新部门项目',project_type:'com'},{id:'p1',name:'匿名其他商业',project_type:'com'}];f.S.members=[{user_id:'hf-owner',role:'pm',status:'approved',name:'匿名新项目提报人',biz_line:'建筑结构设计',project_id:'hf'},{user_id:'other-owner',role:'pm',status:'approved',name:'匿名其他项目提报人',biz_line:'机电设计',project_id:'p1'}];
  const html=f.viewMembers(),memberRows=html.match(/<tr>[\s\S]*?<\/tr>/g);assert.match(memberRows.find(row=>row.includes('匿名新项目提报人')),/<option value="设计部"/);assert.doesNotMatch(memberRows.find(row=>row.includes('匿名其他项目提报人')),/<option value="设计部"/);
  f.S.reports=['建筑结构设计','机电设计','精装设计'].map((line,index)=>({id:index+1,project_id:'hf',author_id:'old-'+index,author_name:'匿名原提报人',period:f.currentPeriod(),line,biz:{items:[{name:'原'+line+'事项'}]}}));const before=JSON.stringify(f.S.reports),overview=f.viewPresCom();
  assert.equal((overview.match(/data-module="设计部"/g)||[]).length,1);assert.match(overview,/商业 · 13 个专业模块/);assert.match(overview,/商业 · 12 个专业模块/);for(const line of ['建筑结构设计','机电设计','精装设计'])assert.match(overview,new RegExp('data-module="'+line+'"[\\s\\S]*?原'+line+'事项'));assert.equal(JSON.stringify(f.S.reports),before);
});

test('a project-specific extra profession supplements the primary one without granting it to peers or another commercial project',()=>{
  const f=fixture();Object.assign(f.S.profile,{project_id:'hf',biz_line:'建筑结构设计'});f.S.pmProject='hf';f.S.projects=[{id:'hf',name:'匿名商业',project_type:'com'},{id:'other-com',name:'另一匿名商业',project_type:'com'}];f.S.pms=[{user_id:'u1',project_id:'hf'},{user_id:'u1',project_id:'other-com'}];
  f.S.businessModuleGrants=[{user_id:'u1',project_id:'hf',line:'设计部'},{user_id:'peer',project_id:'hf',line:'设计部'},{user_id:'u1',project_id:'other-com',line:'设计部'},{user_id:'u1',project_id:'hf',line:'*'}];
  assert.deepEqual(Array.from(f.myBizLines('hf')),['建筑结构设计','设计部']);assert.deepEqual(Array.from(f.myBizLines('other-com')),['建筑结构设计']);assert.equal(f.S.profile.biz_line,'建筑结构设计');assert.match(f.viewPMForm(),/我的商业专业/);assert.match(f.viewPMForm(),/id="planBizLine"/);assert.doesNotMatch(f.viewPMForm(),/测试账号 · 可切换/);
  f.S.uid='peer-without-extra';assert.deepEqual(Array.from(f.myBizLines('hf')),['建筑结构设计']);f.S.uid='u1';f.S.pms=[];f.S.profile.project_id='other-com';assert.equal(f.canReportBizLine('设计部','hf'),false);
});

test('two authorized commercial professions retain separate rich drafts, report identity, attachments, monthly plans and AI scope',async()=>{
  const f=fixture(true,true),store=new Map(),period='2026-10-26',lines=['建筑结构设计','设计部'];Object.assign(f.S.profile,{project_id:'hf',biz_line:lines[0]});f.S.projects=[{id:'hf',name:'匿名双专业商业',project_type:'com'}];f.S.pms=[{user_id:'u1',project_id:'hf'}];f.S.pmProject='hf';f.S.pmPeriod=period;f.S.view='form';
  const reports=lines.map((line,index)=>({id:index+1,project_id:'hf',period,line,author_id:'u1',author_name:'匿名提报人',submitted_at:period+'T01:00:00Z',node_items:[],coord_items:[],biz:{nodes:[{source_id:'node-'+index,name:line+'节点',plan:'2026-10-31',prog:line+'原进展'}],items:[],followups:[],attachments:['10000000-0000-4000-8000-'+String(index+1).padStart(12,'0')]}})),before=JSON.stringify(reports);
  f.storage.getItem=key=>store.get(key)||null;f.storage.setItem=(key,value)=>store.set(key,value);f.storage.removeItem=key=>store.delete(key);
  f.setHandler(op=>({data:op.table==='projects'?f.S.projects:op.table==='project_members'?f.S.pms:op.table==='reports'?reports:[]}));f.setRequestHandler((url,body)=>url==='/api/commercial-module-grants'?{data:[{user_id:'u1',project_id:'hf',line:'设计部'}]}:url==='/api/report-attachments/list'?{data:[{id:reports.find(row=>row.line===body.line).biz.attachments[0],owner_id:'u1',project_id:'hf',period,line:body.line,mime:'application/pdf',name:'匿名附件.pdf',size:1234,inline:true}]}:{data:[]});
  await f.loadPageData();await f.preparePM();assert.equal(f.S.pmLine,lines[0]);const keys=[];
  for(const line of lines){if(f.S.pmLine!==line)await f.App.pmLineSet(line);keys.push(f.draftKey());assert.equal(f.S.pmReport.line,line);f.S.bizNodes[0].prog=line+'未提交草稿';f.S.bizNodes[0]._rich={prog:{ops:[{insert:line+'未提交草稿',attributes:{bold:true}}]}};await f.App.pmLineSet(lines.find(value=>value!==line));}
  assert.notEqual(keys[0],keys[1]);for(const line of lines){await f.App.pmLineSet(line);assert.equal(f.S.bizNodes[0].prog,line+'未提交草稿');assert.equal(f.S.bizNodes[0]._rich.prog.ops[0].attributes.bold,true);assert.equal(f.S.reportAttachments[0].line,line);assert.equal(f.ReportAttachments.validationError(),'');}
  const window=f.loadModule('planning-windows.js');f.loadModule('monthly-plans.js');f.viewPMForm();const extra=f.planningAIContext();assert.equal(extra.line,'设计部');assert.equal(extra.canEdit,true);assert.ok(extra.monthly_plans.length>0,'an explicitly granted profession can build its own monthly draft context');
  await f.App.pmLineSet('建筑结构设计');f.viewPMForm();const primary=f.planningAIContext();assert.equal(primary.line,'建筑结构设计');assert.equal(primary.canEdit,true);assert.notEqual(primary.key,extra.key);assert.notEqual(primary.monthly_plans[0].signature,extra.monthly_plans[0].signature);assert.ok(window.MonthlyPlans.aiContext().length>0);
  f.S.businessModuleGrants=[];const extraRaw=store.get(keys[1]);await f.App.pmLineSet('设计部');assert.equal(f.S.pmLine,'建筑结构设计');assert.equal(store.get(keys[1]),extraRaw);assert.equal(f.S.profile.biz_line,'建筑结构设计');assert.equal(JSON.stringify(reports),before);
});

test('real PM preparation keeps meeting feedback separate by module and preserves excluded legacy leader records', async () => {
  const f = fixture(false, true); Object.assign(f.S.profile, {project_id: 'p1', biz_line: '*'});
  const lines = [f.BIZ_LINES[0], '机电工程', '精装工程'];
  f.S.projects[0].project_type = 'com'; f.S.pmPeriod = '第43周'; f.S.pmLine = lines[0];
  f.S.leaderNotes = [{id: 'shared-note', project_id: 'p1', period: '第42周', what: '共享领导安排', kind: 'ceo_brief'}];
  f.S.reporterTasks = [{id: 'shared-meeting', project_id: 'p1', period: '第42周', owner_id: 'u1', meeting_kind: 'requirement',
    what: '会议要求事项', status: 'open', revision: 1}];
  const source = 'meeting:p1:shared-meeting';
  f.S.reports = lines.slice(0, 2).map((line, index) => ({id: index + 1, project_id: 'p1', author_id: 'u1', period: '第42周', line,
    biz: {followups: [{source_key: source, source_type: 'meeting', what: '会议要求事项', status: 'in_progress', progress: line + '单独进展'},
      {source_key: 'leader:p1:shared-note', source_type: 'leader', what: '共享领导安排', status: 'in_progress', progress: '既有历史反馈'}]}}));
  const before = JSON.stringify({notes: f.S.leaderNotes, reports: f.S.reports});
  for (const line of lines) {
    f.S.pmLine = line; await f.preparePM();
    assert.equal(f.S.followupRows.length, 1); assert.equal(f.S.followupRows[0].source_key, source);
    assert.equal(f.S.followupRows[0].progress, line === '精装工程' ? '' : line + '单独进展');
    assert.doesNotMatch(f.ReporterTasks.formHtml(), /共享领导安排|既有历史反馈/);
  }
  assert.equal(JSON.stringify({notes: f.S.leaderNotes, reports: f.S.reports}), before, 'excluding obsolete personal sources must not erase saved historical records');
});

test('local draft feedback distinguishes stored data, storage failure and server submission', () => {
  const f = fixture(), status = { textContent: '', setAttribute(name, value) { this[name] = value; } };
  f.S.view = 'form'; f.elements.set('planDraftStatus', status);
  let persisted;
  f.storage.setItem = (key, value) => { persisted = JSON.parse(value); };
  f.App.saveDraftNow();
  assert.equal(persisted.change, '本周变化');
  assert.equal(status['data-state'], 'saved');
  assert.match(status.textContent, /本机草稿已保存（未提交）/);
  f.storage.setItem = () => { throw new Error('QuotaExceededError'); };
  f.elements.get('f_change').value = '未能暂存的修改';
  f.App.saveDraftNow();
  assert.equal(status['data-state'], 'error');
  assert.match(status.textContent, /保存失败/);
  assert.equal(persisted.change, '本周变化');
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
});

test('new delayed nodes determine the first report status, without stale saved status', async () => {
  const f = fixture();
  f.S.bizNodes = [{ name: '延期节点', plan: '2026-10-01', forecast: '2026-10-31', prog: '延期30天' }];
  f.setHandler(operation => {
    if (operation.operation === 'upsert') return { data: null, error: { message: 'stop after capturing the payload' } };
    return { data: [], error: null };
  });
  await f.App.submitReport();
  const report = f.calls.find(call => call.operation === 'upsert').values;
  assert.equal(report.status, '异常');
  assert.equal(report.self_speed, '滞后');
  f.S.reports = [{ ...report, status: '正常' }];
  assert.equal(f.statusOf('p1'), '异常');
});

test('all dated nodes ahead of plan can reach the leading category', () => {
  const f = fixture();
  f.S.milestones = [
    { project_id: 'p1', plan_date: '2026-10-20', forecast_date: '2026-10-10' },
    { project_id: 'p1', plan_date: '2026-11-01', forecast_date: '' }
  ];
  assert.equal(f.maxDelay('p1'), -10);
  assert.equal(f.suggestSpeed('p1'), '领跑');
});

test('negative completion phrases remain overdue and explicit completion closes items', () => {
  const f = fixture();
  for (const prog of ['未完成', '尚未完成', '未验收', '尚未完成，等待资料']) {
    const item = { due: '2020-01-01', prog };
    assert.equal(f.itemOverdue(item), true, prog);
    assert.equal(f.itemState(item), 'overdue', prog);
  }
  for (const prog of ['已完成', '已验收', '完成']) {
    assert.equal(f.itemOverdue({ due: '2020-01-01', prog }), false, prog);
    assert.equal(f.itemState({ due: '2020-01-01', prog }), 'done', prog);
  }
});

test('dual matrix follows current leadership assessment rather than removed self-rating', () => {
  const f = fixture();
  f.S.reports = [{ project_id: 'p1', period: f.currentPeriod(), self_speed: '达标', self_effect: null }];
  f.S.reviews = [{ project_id: 'p1', period: f.currentPeriod(), kind: 'ceo', speed: '领跑', effect: '优秀' }];
  const html = f.viewDual();
  const excellentRow = html.match(/<tr><td class="mxlabel">[\s\S]*?优秀[\s\S]*?<\/tr>/)[0];
  assert.match(excellentRow, /测试项目/);
  assert.doesNotMatch(html, /请督促其补齐|未自评/);
});

test('operations role can add leadership notes and saves through one transaction request', async () => {
  const f = fixture(); f.S.profile.role = 'ops';
  f.App.addCeoBrief('p1'); f.App.addPzoNote('p1');
  assert.match(f.briefRowsHtml('p1', 'ceo_brief', true), /cbw_p1_0/);
  assert.match(f.briefRowsHtml('p1', 'pzo_note', true), /pzw_p1_0/);
  f.elements.set('cbw_p1_0', { value: '协调验收' }); f.elements.set('cbd_p1_0', { value: '2026-10-30' });
  await f.App.saveCeoBriefs('p1');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/leader-notes/replace');
  assert.equal(f.requests[0].credentials, 'same-origin');
  assert.deepEqual(f.requests[0].json.items, [{ what: '协调验收', due: '2026-10-30' }]);
  assert.equal(f.calls.some(call => ['delete', 'insert'].includes(call.operation)), false);
});

test('onboarding creates only a pending PM profile without self-assignment', async () => {
  const f = fixture();
  f.S.roleChoice = 'ops'; f.S.obProjects = ['p1']; f.S.obLine = '土建工程';
  await f.App.onboardSubmit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].table, 'profiles');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].values)), { name: '申请人', role: 'pm', status: 'pending' });
  assert.match(f.elements.get('root').innerHTML, /等待审核/);
});

test('historical leadership ratings remain in legacy summaries and the PM project view', () => {
  const f = fixture();
  f.S.profile.project_id = 'p1';
  f.S.reports = [{ project_id: 'p1', period: f.currentPeriod(), self_speed: '滞后', self_effect: '待改善' }];
  f.S.reviews = [{ project_id: 'p1', period: f.currentPeriod(), kind: 'ceo', speed: '领跑', effect: '优秀' }];
  for (const html of [f.viewBoard(), f.viewMyProjects()]) {
    assert.match(html, /领跑/);
    assert.match(html, /优秀/);
    assert.doesNotMatch(html, /待改善|双维自评/);
  }
});

test('adding reporter rows preserves current plan text and leaves residential legacy fields intact', () => {
  for (const existing of [null, { change_text: '旧内容', next_items: ['旧计划'], dev_text:'原风险' }]) {
    const f=fixture();f.S.pmReport=existing;
    const before=JSON.stringify(existing);
    f.S.bizItems=[{name:'原事项',prog:'原进展'}];
    f.elements.set('bi_nm_0',{value:'重新填写的事项'});
    f.elements.set('bi_pg_0',{value:'最新计划进展'});
    f.App.addBizItem();
    const html=f.viewPMForm();
    assert.match(html,/重新填写的事项/);assert.match(html,/最新计划进展/);
    assert.equal(JSON.stringify(existing),before);
    assert.equal(f.S.bizItems.length,2);
    if(existing) {assert.match(html,/原风险/);assert.match(html,/旧计划/);}
  }
});

test('leader-note rows keep unsaved text when adding and stage deletions until save', async () => {
  const f = fixture(); f.S.profile.role = 'ops';
  f.S.leaderNotes = [{ id: 1, project_id: 'p1', period: f.currentPeriod(), kind: 'ceo_brief', what: '原批示' }];
  f.briefRowsHtml('p1', 'ceo_brief', true);
  f.elements.set('cbw_p1_0', { value: '修改后的批示' });
  f.App.addCeoBrief('p1');
  assert.match(f.briefRowsHtml('p1', 'ceo_brief', true), /修改后的批示/);
  f.elements.set('cbw_p1_1', { value: '第二条批示' });
  await f.App.delCeoBriefRow('p1', 0);
  const html = f.briefRowsHtml('p1', 'ceo_brief', true);
  assert.match(html, /第二条批示/);
  assert.doesNotMatch(html, /修改后的批示/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.S.leaderNotes[0].what, '原批示');
  f.elements.set('cbw_p1_0', { value: '第二条批示' });
  f.elements.delete('cbw_p1_1');
  await f.App.saveCeoBriefs('p1');
  assert.deepEqual(f.requests[0].json.items, [{ what: '第二条批示', due: '' }]);
});

test('failed note replacement retains the draft and read-only notes have no edit controls', async () => {
  const f = fixture(); f.S.profile.role = 'ops';
  f.S.leaderNotes = [{ id: 1, project_id: 'p1', period: f.currentPeriod(), kind: 'pzo_note', what: '已保存批示' }];
  f.briefRowsHtml('p1', 'pzo_note', true);
  f.elements.set('pzw_p1_0', { value: '待重试修改' });
  f.setRequestHandler(() => ({ data: null, error: { message: '保存失败' } }));
  await f.App.savePzoNotes('p1');
  assert.match(f.briefRowsHtml('p1', 'pzo_note', true), /待重试修改/);
  const readonly = f.briefRowsHtml('p1', 'pzo_note', false);
  assert.match(readonly, /已保存批示/);
  assert.doesNotMatch(readonly, /<input|<button/);
});

test('revision viewer renders saved residential and commercial content without trusting HTML', () => {
  const f = fixture();
  const original = { project_id: 'p1', author_name: '原作者', change_text: '原始变化 <img src=x onerror=alert(1)>', next_items: ['原计划'],
    node_items: [{ name: '原节点', plan: '2026-10-01', forecast: '2026-10-10', reason: '原原因' }] };
  const current = { ...original, change_text: '修改后变化', history: [{ by: 'u1', at: '2026-10-16T00:00:00Z', data: original }] };
  let html = f.reportHistoryHtml(current);
  assert.match(html, /历史版本 1/);
  assert.match(html, /修改后变化/);
  assert.match(html, /原始变化 &lt;img/);
  assert.match(html, /原节点/);
  assert.doesNotMatch(html, /<img/);
  f.S.projects[0].project_type = 'com';
  html = f.reportHistoryHtml({ project_id: 'p1', biz: { items: [{ name: '商业事项', mod: '土建工程', due: '2026-10-30', prog: '未完成' }] }, history: [] });
  assert.match(html, /商业事项/);
  assert.match(html, /未完成/);
});

test('coordination edit placeholders never change saved reports and empty history rows are hidden', () => {
  const f = fixture();
  const saved = { project_id: 'p1', coord_items: [{ who: '', what: '需要协调验收', by: '' }] };
  f.S.pmReport = saved;
  f.buildEditRows();
  assert.equal(saved.coord_items.length, 1);
  f.S.coordRows[0].what = '尚未保存的修改';
  assert.equal(saved.coord_items[0].what, '需要协调验收');
  const historical = { ...saved, coord_items: [null, {}, { who: ' ', what: '', by: '' }, ...saved.coord_items] };
  const html = f.reportHistoryHtml(historical);
  assert.match(html, /未指定：需要协调验收/);
  assert.doesNotMatch(html, /未指定： · 最晚/);
  assert.equal((html.match(/· 最晚/g) || []).length, 1);
});

test('commercial reports can be saved twice after reload with nullable legacy dates', async () => {
  const f = fixture();
  f.S.projects[0].project_type = 'com';
  f.S.profile.biz_line = f.BIZ_LINES[0];
  f.S.pmLine = f.BIZ_LINES[0];
  f.S.bizNodes = [{ name: '商业核心节点', plan: '2026-10-30', prog: '尚未完成' }];
  const projects = structuredClone(f.S.projects);
  let saved = null;
  f.setHandler(operation => {
    if (operation.operation === 'upsert') {
      assert.equal(operation.values.node_forecast, null);
      assert.equal(operation.values.node_plan, '2026-10-30');
      saved = { ...structuredClone(operation.values), id: 1, author_id: 'u1' };
      return { data: [structuredClone(saved)], error: null };
    }
    const data = operation.table === 'projects' ? projects : operation.table === 'reports' && saved ? [structuredClone(saved)] : [];
    return { data: structuredClone(data), error: null };
  });
  await f.App.submitReport();
  assert.equal(f.S.pmReport.id, 1);
  assert.equal(f.S.myRows[0].forecast, '');
  f.S.bizNodes[0].prog = '第二次保存进展';
  await f.App.submitReport();
  assert.equal(f.calls.filter(call => call.operation === 'upsert').length, 2);
  assert.equal(saved.biz.nodes[0].prog, '第二次保存进展');
});

test('residential custom nodes without dates use null database date fields', async () => {
  const f = fixture();
  f.S.bizNodes = [{ name: '待确定日期节点', prog: '等待审批日期', custom: true }];
  f.setHandler(operation => operation.operation === 'upsert'
    ? { data: null, error: { message: 'stop after capturing payload' } } : { data: [], error: null });
  await f.App.submitReport();
  const saved = f.calls.find(call => call.operation === 'upsert').values;
  assert.equal(saved.node_plan, null);
  assert.equal(saved.node_forecast, null);
  assert.equal(saved.node_items[0].reason, '等待审批日期');
});

test('editing report arrays leaves all saved residential and commercial records intact', () => {
  const f = fixture();
  const saved = {
    node_items: [{ name: '节点', plan: '2026-10-20', reason: '原节点原因' }],
    speed_items: [{ act: '原提速对策', gain: '原目标' }], effect_items: [{ act: '原效果保障', target: '原效果' }],
    coord_items: [{ who: '工程部', what: '原协调' }],
    biz: { nodes: [{ name: '商业节点', prog: '原节点进展' }], items: [{ name: '商业事项', prog: '原事项进展' }], handover: [{ what: '原移交事项' }] }
  };
  const original = structuredClone(saved);
  f.S.pmReport = saved;
  f.buildNodeRows(); f.buildEditRows(); f.buildBizRows();
  for (const [id, value] of Object.entries({ nd_rs_0: '新原因', sp_act_0: '新提速', ef_act_0: '新保障',
    co_what_0: '新协调', bn_pg_0: '新节点进展', bi_pg_0: '新事项进展', bh_what_0: '新移交事项' })) {
    f.elements.set(id, { value });
  }
  f.App.addBizItem();
  assert.deepEqual(saved, original);
  assert.equal(f.S.bizNodes[0].prog, '新节点进展');
  assert.equal(f.S.bizItems[0].prog, '新事项进展');
  assert.equal(f.S.bizHand[0].what, '新移交事项');
});

test('drawing cards open PDFs and opaque links without broken image previews', () => {
  const f = fixture(); f.S.profile.role = 'ops';
  f.S.drawings = [
    { id: 1, project_id: 'p1', kind: '项目总图', name: '验收资料', path: 'drawings/p1/document.pdf', url: '/api/files/drawings/p1/document.pdf' },
    { id: 2, project_id: 'p1', kind: '项目总图', name: '外部资料链接', url: 'https://example.test/share/opaque-link' },
    { id: 3, project_id: 'p1', kind: '项目总图', name: '项目图片', url: '/api/files/drawings/p1/image.png' }
  ];
  const html = f.viewMaster();
  assert.match(html, /打开 PDF 文档/);
  assert.match(html, /验收资料/);
  assert.match(html, /href="https:\/\/example\.test\/share\/opaque-link"/);
  assert.match(html, /打开附件链接/);
  assert.match(html, /<img src="\/api\/files\/drawings\/p1\/image\.png"/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /accept="[^\"]*image\/png[^\"]*image\/jpeg[^\"]*image\/webp[^\"]*application\/pdf"/);
  assert.doesNotMatch(html, /accept="image\/\*"/);
  assert.equal(f.requests.length, 0);
});


test('new residential form preserves legacy data and formatting for existing manager readers', async () => {
  const f=fixture(true);
  const original={project_id:'p1',period:f.currentPeriod(),line:'综合',change_text:'重点关注',dev_text:'保留风险',projection:'保留影响',impact:'成本',
    next_items:['保留下期承诺'],speed_items:[{act:'保留提速对策'}],effect_items:[{act:'保留保障'}],
    node_items:[{name:'原节点',plan:'2026-10-01',forecast:'2026-10-31',reason:'持续推进'}],
    rich_text:{v:1,fields:{change_text:{ops:[{insert:'重点关注',attributes:{bold:true,color:'#d81e06'}}]}}}};
  const before=JSON.stringify(original);f.S.pmReport=original;f.S.pmPeriod=f.currentPeriod();f.buildBizRows();
  f.setHandler(operation=>operation.operation==='upsert'?{error:{message:'capture payload'}}:{data:[]});
  await f.App.submitReport();
  const saved=f.calls.find(call=>call.operation==='upsert').values;
  assert.equal(saved.dev_text,'保留风险');assert.equal(saved.projection,'保留影响');assert.equal(saved.impact,'成本');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.next_items)),original.next_items);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.speed_items)),original.speed_items);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.effect_items)),original.effect_items);
  assert.equal(saved.node_items[0].forecast,'2026-10-31');assert.equal(saved.line,'综合');
  assert.equal(saved.biz.form_version,2);assert.ok(saved.rich_text.fields.change_text.ops.some(op=>op.insert==='重点关注' && op.attributes.bold && op.attributes.color==='#d81e06'));
  assert.equal(saved.rich_text.fields.change_text.ops.map(op=>op.insert).join(''),saved.change_text);
  assert.equal(JSON.stringify(original),before);
});

test('saving existing master fields preserves new grouped archive data',async()=>{
  const f=fixture();f.S.profile.role='ops';
  const products=[{name:'住宅',area:100}];f.S.master=[{project_id:'p1',fields:{city:'原城市',products,product_area_total:100}}];
  f.elements.set('mf_city',{value:'新城市'});
  f.setHandler(operation=>operation.operation==='upsert'?{error:{message:'capture payload'}}:{data:[]});
  await f.App.masterSave('p1');
  const fields=f.calls.find(call=>call.operation==='upsert').values.fields;
  assert.equal(fields.city,'新城市');assert.deepEqual(fields.products,products);assert.equal(fields.product_area_total,100);
});


test('a late report submission cannot delete a new account draft or navigate its page',async()=>{
  const f=fixture();f.S.pmPeriod=f.currentPeriod();f.S.bizItems=[{name:'待保存事项',prog:'原会话进展'}];
  let release;const removed=[];f.storage.removeItem=key=>removed.push(key);
  f.setHandler(operation=>operation.operation==='upsert'?new Promise(resolve=>{release=()=>resolve({data:[operation.values]});}):{data:[]});
  const pending=f.App.submitReport();await new Promise(resolve=>setImmediate(resolve));
  f.S.uid='new-user';f.S.session={user:{id:'new-user'}};f.S.view='center';f.S.submittingReport={newer:true};
  release();await pending;
  assert.equal(f.S.view,'center');assert.equal(removed.length,0);assert.equal(f.S.submittingReport.newer,true);
  assert.equal(f.calls.length,1);
});

test('saving an earlier project keeps a newly selected project and only clears the original draft',async()=>{
  const f=fixture();f.S.pmPeriod=f.currentPeriod();f.S.bizItems=[{name:'待保存事项',prog:'已提交进展'}];
  let release;const removed=[];f.storage.removeItem=key=>removed.push(key);
  f.setHandler(operation=>operation.operation==='upsert'?new Promise(resolve=>{release=()=>resolve({data:[operation.values]});}):{data:[]});
  const pending=f.App.submitReport();await new Promise(resolve=>setImmediate(resolve));
  f.S.pmProject='p2';f.S.view='center';release();await pending;
  assert.equal(f.S.pmProject,'p2');assert.equal(f.S.view,'center');assert.equal(removed.length,1);assert.match(removed[0],/_p1_/);
});


test('double submission during the remote version check issues only one write',async()=>{
  const f=fixture();f.S.pmPeriod=f.currentPeriod();f.S.pmReport={updated_at:'2026-10-20T00:00:00Z'};f.S.bizItems=[{name:'事项',prog:'进展'}];
  let release;f.setHandler(operation=>operation.operation==='select'?new Promise(resolve=>{release=()=>resolve({data:[]});}):{error:{message:'capture write'}});
  const first=f.App.submitReport();await new Promise(resolve=>setImmediate(resolve));const second=f.App.submitReport();
  assert.equal(f.calls.length,1);release();await Promise.all([first,second]);
  assert.equal(f.calls.filter(x=>x.operation==='upsert').length,1);assert.equal(f.S.submittingReport,null);
});

test('legacy personal plan and coordination rows keep their new source identities across subsequent submissions', async () => {
  const f = fixture(); f.S.pmPeriod = f.currentPeriod();
  const prior = {id: 17, project_id: 'p1', period: f.S.pmPeriod, line: '综合',
    biz: {nodes: [{name: '同名节点', prog: '原进展'}, {name: '同名节点', prog: '另一条原进展'}],
      items: [{name: '自建计划', prog: '等待材料'}], handover: [{what: '移交材料', to: '工程'}]},
    coord_items: [{who: '工程', what: '协调材料'}]};
  const before = structuredClone(prior); f.S.pmReport = prior;
  f.buildBizRows(); f.buildEditRows();
  f.setHandler(operation => operation.operation === 'upsert' ? {error: {message: 'capture payload'}} : {data: []});
  await f.App.submitReport();
  const first = structuredClone(f.calls.find(operation => operation.operation === 'upsert').values);
  const ids = first.biz.nodes.concat(first.biz.items, first.biz.handover, first.coord_items).map(row => row.source_id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(ids).size, ids.length, 'identical titles are separate source records');
  f.S.bizNodes[0].prog = '修改后的进展'; f.S.bizItems[0].name = '修改后的计划名称';
  await f.App.submitReport();
  const second = f.calls.filter(operation => operation.operation === 'upsert')[1].values;
  assert.deepEqual(Array.from(second.biz.nodes.concat(second.biz.items, second.biz.handover, second.coord_items), row => row.source_id), ids);
  assert.deepEqual(prior, before, 'assigning identities must not rewrite the saved report or its historical fields');
});

test('report attachment UUIDs survive draft, submission and leader revision display without changing the original snapshot', async () => {
  const f = fixture(false, true), id = '02c721cc-a07e-4be4-a287-818e474d631a';
  f.S.pmPeriod = f.currentPeriod(); f.S.pmLine = '综合';
  f.S.reportAttachments = [{id, project_id: 'p1', period: f.S.pmPeriod, line: '综合', owner_id: 'u1',
    name: '完成照片.png', mime: 'image/png', size: 1024, inline: true}];
  const report = {id: 5, author_id: 'u1', project_id: 'p1', period: f.S.pmPeriod, line: '综合',
    biz: {attachments: [id], nodes: [], items: [{name: '已提交计划', prog: '继续处理'}], followups: []}};
  const before = structuredClone(report); f.S.reports = [report];
  await f.preparePM(); f.S.view = 'form';
  let draft; f.storage.setItem = (_key, value) => {draft = JSON.parse(value);};
  f.App.saveDraftNow();
  assert.deepEqual(draft.attachmentIds, [id]);
  assert.equal(JSON.stringify(draft).includes('data:image'), false, 'drafts contain references rather than image bytes');
  assert.match(f.viewPMForm(), /五、附件资料/);
  f.setHandler(operation => operation.operation === 'upsert' ? {error: {message: 'capture payload'}} : {data: []});
  await f.App.submitReport();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(operation => operation.operation === 'upsert').values.biz.attachments)), [id]);
  f.S.profile.role = 'president'; f.configureReporter();
  const html = f.reportHistoryHtml({...report, history: [{at: '2026-10-20T00:00:00Z', by: 'u1', data: report}]});
  assert.match(html, /完成照片\.png/);
  assert.match(html, new RegExp('/api/report-attachments/' + id));
  assert.doesNotMatch(html, /report-attachment-upload|ReportAttachments\.toggle/);
  assert.deepEqual(report, before);
});
