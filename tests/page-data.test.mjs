import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium, expect as browserExpect} from '@playwright/test';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace('window.App = App;', 'window.App = App; window.audit = {S, dataSources, loadData, loadPageData, resetPageData, pageDataKeys, planningNavItems, preparePM, renderShell, queryCompletions, loadMoreCompletions, afterLogin, readCompletionKeys, completionSourceKeys, invalidateData,configureReporter,bindDraftAutosave};')
  .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
const fixtureSource = fs.readFileSync(new URL('./frontend-render.mjs', import.meta.url), 'utf8');
const sample = vm.runInNewContext(fixtureSource.slice(fixtureSource.indexOf('function pad2'), fixtureSource.indexOf('\nfunction run(')) + ';DB;', {Date});
const reporterModules = ['planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'reporter-tasks.js', 'completion-review.js', 'coordination-workbench.js', 'monthly-plans.js', 'monthly-summaries.js', 'report-attachments.js', 'reporter-archive.js', 'admin-archive.js']
  .map(name => [name, fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8')]);
const loginBoot = fs.readFileSync(new URL('../web/login-boot.js', import.meta.url), 'utf8');

test('commercial form keeps a baseline-only core while real monthly feedback and preserved node drafts save independently', async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1600,height:1000}});
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<div id="root"></div><div id="toast"></div>'}));
    await page.goto('http://monthly-core.test/');
    await page.evaluate(()=>{
      window.pageTables={};
      window.WorkBuddyCloud={createWorkBuddyCloud:()=>({auth:{},database:{from(table){const q={select(){return q;},eq(){return q;},limit(){return q;},order(){return q;},then(resolve){return Promise.resolve({data:window.pageTables[table] || [],error:null}).then(resolve);}};return q;}}})};
      window.fetch=async()=>new Response(JSON.stringify({data:[],error:null}),{headers:{'content-type':'application/json'}});
    });
    for(const name of ['styles.css','planning-ui.css','vendor/quill/quill.core.css'])await page.addStyleTag({content:fs.readFileSync(new URL('../web/'+name,import.meta.url),'utf8')});
    for(const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js','planning-windows.js','baseline-core.js','report-scopes.js','monthly-plans.js'])await page.addScriptTag({content:fs.readFileSync(new URL('../web/'+name,import.meta.url),'utf8')});
    await page.addScriptTag({content:app});
    await page.evaluate(async()=>{
      const h=window.audit,S=h.S;
      Object.assign(S,{uid:'anonymous',session:{},profile:{user_id:'anonymous',name:'匿名填报人',role:'pm',status:'approved',biz_line:'土建工程（东地块）'},
        projects:[{id:'p1',name:'匿名项目',project_type:'com'}],pms:[{project_id:'p1',user_id:'anonymous'}],view:'form',pmProject:'p1',pmLine:'土建工程（东地块）',pmPeriod:'2026-10-19',pmReport:null,
        bizNodes:[{source_id:'legacy',name:'必须保留的旧节点',prog:'旧节点草稿'}],bizItems:[{source_id:'fixed',mod:'模块',name:'已确认事项',due:'2026-10-23',prog:'',blocker:''}],
        monthlyPlans:[{id:'confirmed',project_id:'p1',line:'土建工程（东地块）',plan_month:'2026-10-01',confirmed_by:'anonymous',items:[{source_id:'fixed',mod:'模块',name:'已确认事项',due:'2026-10-23'}]}]});
      window.pageTables.milestones=[{id:101,project_id:'p1',name:'仅来自基准的节点',biz_line:'土建工程（东地块）',plan_date:'2026-10-23',forecast_date:'2026-10-24',note:'原保存说明',is_key:false}];
      await h.loadData(['milestones']);h.configureReporter();h.renderShell();h.bindDraftAutosave();
    });
    await browserExpect(page.locator('#baseline-core-summary')).toContainText('仅来自基准的节点');
    await browserExpect(page.locator('#baseline-core-summary')).toContainText('本周未提供节点反馈');
    await browserExpect(page.locator('#baseline-core-summary')).not.toContainText('已确认事项');
    await browserExpect(page.locator('#baseline-core-summary input, #baseline-core-summary textarea')).toHaveCount(0);
    const editor=page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor');
    await editor.fill('浏览器输入的新进展\n遇到卡点：浏览器输入的卡点');
    await editor.press('Control+A');
    await page.locator('.selection-format-toolbar').getByRole('button',{name:'加粗',exact:true}).click();
    await browserExpect(page.locator('[data-rich-editor-for="bi_blocker_0"]')).toHaveCount(0);
    await browserExpect(page.locator('#baseline-core-summary')).not.toContainText('浏览器输入的新进展');
    await browserExpect(page.locator('#baseline-core-summary')).not.toContainText('浏览器输入的卡点');
    await browserExpect(editor.locator('strong')).toHaveText(['浏览器输入的新进展', '遇到卡点：浏览器输入的卡点']);
    assert.equal(await page.evaluate(()=>window.audit.S.bizNodes[0].prog),'旧节点草稿');
    await browserExpect.poll(()=>page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('旧节点草稿')&&value.includes('浏览器输入的新进展')&&value.includes('浏览器输入的卡点'))),
      {message:'baseline projection must preserve original nodes and edited monthly feedback together in the local draft'}).toBe(true);
    if(process.env.MONTHLY_CORE_SCREENSHOT)await page.screenshot({path:process.env.MONTHLY_CORE_SCREENSHOT,fullPage:true});
  } finally {await browser.close();}
});

function fixture(role = 'ops') {
  const tables = structuredClone(sample), calls = [], root = {innerHTML: '', querySelectorAll: () => []}, downloads = [], dom = new Map();
  const assets = Object.fromEntries(['app.js', 'reporter-tasks.js', 'reporter-tasks.css', 'reporter-workbench.css', 'completion-review.js', 'completion-review.css',
    'report-attachments.js', 'report-attachments.css', 'reporter-archive.js', 'reporter-archive.css', 'admin-archive.js', 'admin-archive.css', 'admin-overview.css',
    'rich-text.js', 'rich-editor.js','planning-windows.js','report-scopes.js','baseline-core.js','coordination-workbench.js', 'monthly-plans.js', 'monthly-summaries.js', 'vendor/quill/quill.js', 'vendor/quill/quill.core.css'].map(key => [key, '/assets/' + key]));
  dom.set('planning-assets', {textContent: JSON.stringify(assets)}); dom.set('toast', {style: {}});
  const profile = {user_id: 'current', name: '当前演示用户', role, status: 'approved', project_id: 'p1', biz_line: '土建工程（东地块）'};
  tables.profiles = [profile, {user_id: 'other', name: '另一演示成员', role: 'pm', status: 'approved'}];
  tables.project_members = [{user_id: 'current', project_id: 'p1'}, {user_id: 'current', project_id: 'p3'}];
  tables['@projectPeople'] = [{user_id: profile.user_id, name: profile.name, role, discipline: '工程', biz_line: profile.biz_line}];
  let handler = operation => ({data: tables[operation.table] || [], error: null});
  const database = {from(table) {
    const operation = {table, operation: 'select', filters: []};
    const q = {select() {return q;}, order() {return q;}, eq(column, value) {operation.filters.push({column, value}); return q;}, limit() {return q;},
      upsert(values) {operation.operation = 'upsert'; operation.values = values; return q;},
      update(values) {operation.operation = 'update'; operation.values = values; return q;},
      then(resolve, reject) {calls.push(operation); return Promise.resolve(handler(operation)).then(resolve, reject);}};
    return q;
  }};
  const body = {children: [], appendChild(element) {this.children.push(element); element.parentNode = this; dom.set(element.id, element);},
    removeChild(element) {this.children = this.children.filter(item => item !== element); dom.delete(element.id);}};
  const window = {WorkBuddyCloud: {createWorkBuddyCloud: () => ({database, auth: {signOut: async () => ({}), getSession: async () => ({data: null})}})}, scrollTo() {}, confirm: () => true};
  const document = {getElementById: id => id === 'root' ? root : dom.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {}, body,
    createElement(tag) {return {tagName: tag.toUpperCase(), innerHTML: '', style: {}, addEventListener() {}, remove() {},
      querySelector(selector) {return selector === '.modalbox' ? {style: {}} : null;}, querySelectorAll: () => []};},
    head: {appendChild(element) {downloads.push(element.src || element.href); Promise.resolve().then(() => element.onload());}}};
  window.document = document;
  const context = {window, document,
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}}, Date, console, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, init) => {
      if(url==='/api/commercial-module-grants'){assert.equal(init.method,'GET');assert.equal(init.body,undefined);const operation={table:'@businessModuleGrants',operation:'select',query:{}};calls.push(operation);const result=await handler(operation);return {ok:!result?.error,json:async()=>result};}
      if(url.startsWith('/api/monthly-summaries?month=')){
        assert.equal(init.method,'GET');assert.equal(init.body,undefined);
        const operation={table:'@monthlySummaries',operation:'select',query:{month:new URL(url,'http://anonymous.test').searchParams.get('month')}};calls.push(operation);const result=await handler(operation);return {ok:!result?.error,json:async()=>result};
      }
      const sources = {'/api/report-scopes/list':'@reportScopes','/api/monthly-plans/list':'@monthlyPlans','/api/reporter-tasks/list': '@reporterTasks', '/api/project-people/list': '@projectPeople', '/api/completions/list': '@completions','/api/coordination-tasks/list':'@coordinationTasks','/api/coordination-tasks/create':'@coordinationCreate',
        '/api/report-attachments/list': '@reportAttachments', '/api/project-plan-statistics':'@nodeStatistics'};
      assert.ok(sources[url], 'unexpected read endpoint: ' + url);
      const operation = {table: sources[url], operation: 'select', query: JSON.parse(init.body)};
      calls.push(operation);
      let result = await handler(operation);
      if(operation.table==='@nodeStatistics' && !result.error && Array.isArray(result.data)){
        const kind=operation.query.kind,ids=new Set(tables.projects.filter(row=>(row.project_type || 'res')===kind).map(row=>row.id));
        result={data:{source:kind+'_baseline',filters:{kind},rows:tables.milestones.filter(row=>ids.has(row.project_id)).map(row=>({
          source_key:'milestone:'+row.project_id+':'+row.id,title:row.name,completed:!!row.done,plan_due:row.plan_date || '',forecast_due:row.forecast_date || '',
          deviation:row.done || !row.plan_date || !row.forecast_date?null:Math.round((new Date(row.forecast_date)-new Date(row.plan_date))/86400000)
        }))}};
      }
      return {ok: !result?.error, json: async () => ({has_more: false, next_cursor: null, ...result})};
    }};
  vm.createContext(context);
  for (const [name, source] of reporterModules) vm.runInContext(source, context, {filename: name});
  vm.runInContext(app, context);
  const audit = window.audit;
  Object.assign(audit.S, {uid: 'current', session: {user: {id: 'current'}}, profile, pmProject: 'p1'});
  return {...audit, App: window.App, root, calls, tables, downloads, dom, window,
    installLoginBoot() {vm.runInContext(loginBoot, context, {filename: 'login-boot.js'});}, setHandler(fn) {handler = fn;}};
}

test('every authorized page and detail tab renders the same content as a complete table snapshot', async () => {
  for (const role of ['ops', 'pm', 'president', 'pzo']) {
    const routes = fixture(role).planningNavItems().map(item => ({view: item.k}));
    for (const pid of role === 'pzo' ? ['p3'] : ['p1', 'p3']) {
      for (const tab of role === 'pzo' ? ['report', 'review', 'history'] : ['report', 'review', 'history', 'data']) routes.push({view: 'detail', pid, tab});
    }
    for (const route of routes) {
      const full = fixture(role), lazy = fixture(role);
      for (const f of [full, lazy]) Object.assign(f.S, {view: route.view, detailPid: route.pid, detailTab: route.tab});
      await full.loadData(Object.keys(full.dataSources)); await lazy.loadPageData();
      for (const f of [full, lazy]) {
        if (route.view === 'form' || route.view === 'center') await f.preparePM();
        f.renderShell();
      }
      assert.equal(lazy.root.innerHTML, full.root.innerHTML, JSON.stringify({role, ...route}));
    }
  }
});

test('monthly completion summaries use month-scoped GET snapshots and a failed refresh never renders prior month content',async()=>{
  const f=fixture();f.S.view='presCom';f.S.overviewUI.period='2026-10-26';
  f.setHandler(operation=>operation.table==='@monthlySummaries'?{data:[{id:'summary-'+operation.query.month,project_id:'p3',month:operation.query.month,line:'机电工程',owner_id:'anonymous-owner',owner_name:'匿名提报人',items:[{source_id:'source',name:operation.query.month+'月度独立原文',progress:'已完成现场核查'}]}]}:{data:f.tables[operation.table] || []});
  assert.equal(await f.loadPageData(),true);f.renderShell();assert.match(f.root.innerHTML,/2026-10月度独立原文/);assert.match(f.root.innerHTML,/不计作周报提交/);
  const first=f.calls.filter(call=>call.table==='@monthlySummaries').length;await f.loadData(['monthlySummaries']);assert.equal(f.calls.filter(call=>call.table==='@monthlySummaries').length,first);
  f.S.overviewUI.period='2026-11-02';assert.equal(await f.loadData(['monthlySummaries']),true);f.renderShell();assert.match(f.root.innerHTML,/2026-11月度独立原文/);assert.doesNotMatch(f.root.innerHTML,/2026-10月度独立原文/);
  f.setHandler(operation=>operation.table==='@monthlySummaries'?{error:{message:'匿名网络中断'}}:{data:f.tables[operation.table] || []});assert.equal(await f.loadData(['monthlySummaries'],true),false);f.renderShell();assert.match(f.root.innerHTML,/月度汇总读取失败/);assert.doesNotMatch(f.root.innerHTML,/2026-11月度独立原文/);
});

test('commercial extra grants load as read-only session data and an authorization read failure blocks the extra scope without switching its draft',async()=>{
  const f=fixture('pm');f.tables.projects.push({id:'hf',name:'匿名双专业商业',project_type:'com'});f.tables.project_members.push({user_id:'current',project_id:'hf'});Object.assign(f.S.profile,{project_id:'hf',biz_line:'建筑结构设计'});f.S.pmProject='hf';f.S.view='form';
  f.setHandler(operation=>operation.table==='@businessModuleGrants'?{data:[{user_id:'current',project_id:'hf',line:'设计部'}]}:{data:f.tables[operation.table] || []});assert.equal(await f.loadPageData(),true);await f.preparePM();f.renderShell();
  assert.equal(f.S.profile.biz_line,'建筑结构设计');assert.match(f.root.innerHTML,/我的商业专业/);assert.match(f.root.innerHTML,/<option value="建筑结构设计"/);assert.match(f.root.innerHTML,/<option value="设计部"/);await f.App.pmLineSet('设计部');assert.equal(f.S.pmLine,'设计部');
  f.setHandler(operation=>operation.table==='@businessModuleGrants'?{error:{message:'匿名授权接口中断'}}:{data:f.tables[operation.table] || []});assert.equal(await f.loadData(['businessModuleGrants'],true),false);f.renderShell();assert.equal(f.S.pmLine,'设计部');assert.match(f.root.innerHTML,/附加专业授权读取失败，原草稿保留/);assert.match(f.root.innerHTML,/App.submitReport\(\)" disabled/);assert.deepEqual(Array.from(f.window.MonthlyPlans.aiContext()),[]);
  f.resetPageData();assert.deepEqual(Array.from(f.S.businessModuleGrants),[]);
});

test('a monthly summary arriving after logout cannot populate another account snapshot',async()=>{
  const f=fixture();f.S.view='presCom';f.S.overviewUI.period='2026-10-26';let release;
  f.setHandler(operation=>operation.table==='@monthlySummaries'?new Promise(resolve=>{release=resolve;}):{data:[]});const pending=f.loadData(['monthlySummaries']);f.resetPageData();f.S.uid='new-account';f.S.session={user:{id:'new-account'}};
  release({data:[{id:'old-summary',project_id:'p3',month:'2026-10',line:'机电工程',items:[{name:'旧账号隐私'}]}]});await pending;assert.deepEqual(Array.from(f.S.monthlySummaries),[]);assert.doesNotMatch(f.root.innerHTML,/旧账号隐私/);
});

test('parallel page requests share a read; a loaded table is reused', async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => {release = resolve;}));
  const a = f.loadData(['projects']), b = f.loadData(['projects']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); release({data: [{id: 'new'}], error: null});
  await Promise.all([a, b]); await f.loadData(['projects']);
  assert.equal(f.calls.length, 1); assert.equal(f.S.projects[0].id, 'new');
});

test('independent coordination loads before completion metadata and reaches PM work in both project types without reports', async () => {
  for (const pid of ['p1','p3']) {
    const f=fixture('pm'), id='10000000-0000-4000-8000-000000000201',key='coord:'+pid+':'+id;
    const row={id,project_id:pid,author_id:'other',author_name:'匿名协调发起人',owner_id:'current',owner_name:'当前演示用户',what:'无需周报的独立协调',due:'2026-11-01',created_at:'2026-10-21T08:00:00Z',source_key:key};
    Object.assign(f.S,{view:'center',pmProject:pid,pmPeriod:'第1周'});
    f.setHandler(operation=>({data:operation.table==='reports'?[]:operation.table==='@coordinationTasks'?[row]:f.tables[operation.table] || [],error:null}));
    await f.loadPageData();await f.preparePM();f.renderShell();
    assert.ok(f.calls.findIndex(call=>call.table==='@coordinationTasks')<f.calls.findIndex(call=>call.table==='@completions'));
    assert.ok(f.completionSourceKeys().includes(key));
    assert.equal(f.window.ReporterTasks.sourceItems().filter(item=>item.source_key===key).length,1);
    assert.ok(f.S.followupRows.some(item=>item.source_key===key && item.source_type==='coord'));
    assert.match(f.root.innerHTML,/无需周报的独立协调/);assert.match(f.root.innerHTML,/协调申请/);
    assert.equal(f.S.reports.length,0);assert.equal(f.calls.some(call=>call.operation!=='select'),false);
    const reads=f.calls.length;f.configureReporter();f.renderShell();assert.equal(f.calls.length,reads,'composer reuses loaded people and task snapshots');
  }
});

test('coordination creation integrates its source and clears rendered fields without creating or modifying a report',async()=>{
  const f=fixture('pm');f.S.view='coordination';let created=null;
  f.setHandler(operation=>{
    if(operation.table==='@coordinationCreate')return {data:created={...operation.query,author_id:'current',author_name:'当前演示用户',owner_name:'当前演示用户',created_at:'2026-10-21T08:00:00Z',source_key:'coord:p1:'+operation.query.id},error:null};
    return {data:operation.table==='reports'?[]:operation.table==='@coordinationTasks'?created?[created]:[]:f.tables[operation.table] || [],error:null};
  });
  await f.loadPageData();await f.preparePM();f.renderShell();
  f.dom.set('coordination_owner_id_p1',{value:'current'});f.dom.set('coordination_what_p1',{value:'工作台即时发起'});f.dom.set('coordination_due_p1',{value:'2026-11-02'});
  const reportDraft=JSON.stringify(f.S.coordRows);
  await f.window.CoordinationWorkbench.create('p1');
  assert.ok(created);assert.equal(f.S.coordinationTasks.length,1);assert.equal(f.S.reports.length,0);
  assert.equal(JSON.stringify(f.S.coordRows),reportDraft);assert.ok(f.window.ReporterTasks.sourceItems().some(row=>row.source_key===created.source_key));
  assert.match(f.root.innerHTML,/<textarea id="coordination_what_p1"[^>]*><\/textarea>/,'the old DOM cannot repopulate the newly cleared composer');
  assert.equal(f.calls.filter(call=>call.table==='@coordinationCreate').length,1);
  assert.equal(f.calls.some(call=>['reports','leader_notes'].includes(call.table) && call.operation!=='select'),false);
});

test('ops coordination page displays independent author, owner and deadline before any completion request, with no creator controls',async()=>{
  const f=fixture('ops');f.S.view='coord';
  f.tables['@coordinationTasks']=[{id:'10000000-0000-4000-8000-000000000202',project_id:'p1',author_id:'a',author_name:'匿名发起甲',owner_id:'b',owner_name:'匿名承办乙',what:'尚无完成申请的协调',due:'2026-11-03',source_key:'coord:p1:10000000-0000-4000-8000-000000000202'}];
  await f.loadPageData();f.renderShell();
  for(const text of ['独立协调事项','匿名发起甲','匿名承办乙','尚无完成申请的协调'])assert.ok(f.root.innerHTML.includes(text));
  assert.doesNotMatch(f.root.innerHTML,/CoordinationWorkbench\.create|CompletionReview\.review/);
  assert.ok(f.calls.some(call=>call.table==='@coordinationTasks'));
});

test('a failed table stays visible as an error and can be retried without caching failure as empty success', async () => {
  const f = fixture(); f.setHandler(() => ({data: null, error: {message: '模拟连接失败'}}));
  assert.equal(await f.loadData(['projects']), false);
  assert.match(f.S.loadErrors.join(), /项目：模拟连接失败/);
  f.setHandler(() => ({data: [{id: 'restored'}], error: null}));
  assert.equal(await f.loadData(['projects']), true);
  assert.equal(f.calls.length, 2); assert.equal(f.S.loadErrors.length, 0);
});

test('a save invalidates an older in-flight snapshot and all waiters share the replacement', async () => {
  const f = fixture(); let release;
  f.setHandler(() => f.calls.length === 1 ? new Promise(resolve => {release = resolve;}) : {data: [{id: 'after-save'}], error: null});
  const first = f.loadData(['projects']); await new Promise(resolve => setImmediate(resolve));
  const saved = f.loadData(['projects'], true);
  release({data: [{id: 'before-save'}], error: null}); await Promise.all([first, saved]);
  assert.equal(f.calls.length, 2); assert.equal(f.S.projects[0].id, 'after-save');
});

test('logout clears table snapshots and late replies cannot restore the previous account data', async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => {release = resolve;}));
  const first = f.loadData(['projects']); await new Promise(resolve => setImmediate(resolve));
  await f.App.logout(); release({data: [{id: 'old-account-private-data'}], error: null}); await first;
  assert.equal(f.S.uid, null); assert.equal(f.S.projects.length, 0);
});

test('manual refresh fetches the visible page and invalidates other visited pages for later use', async () => {
  const f = fixture(); await f.loadData(Object.keys(f.dataSources)); f.calls.length = 0;
  f.S.view = 'members'; await f.loadPageData(true);
  assert.deepEqual(f.calls.map(x => x.table).sort(), ['@businessModuleGrants', '@reportScopes', 'profiles', 'project_members', 'projects']);
  f.calls.length = 0; f.S.view = 'master'; await f.loadPageData();
  assert.deepEqual(f.calls.map(x => x.table).sort(), ['milestones', 'project_drawings', 'project_master', 'project_phases']);
});

test('saving master data only refreshes its table', async () => {
  const f = fixture(); f.S.view = 'master'; await f.loadPageData(); f.calls.length = 0;
  await f.App.masterSave('p1');
  assert.deepEqual(f.calls.map(x => [x.table, x.operation]), [['project_master', 'upsert'], ['project_master', 'select']]);
});

test('a refresh finishing after a newer navigation cannot render that page before its data arrives', async () => {
  const f = fixture(); await f.loadData(Object.keys(f.dataSources)); f.root.innerHTML = 'previous-page';
  let release;
  f.setHandler(operation => operation.table === 'project_drawings' ? new Promise(resolve => {release = resolve;}) : {data: f.tables[operation.table] || [], error: null});
  f.S.view = 'members'; const refresh = f.App.reload();
  const next = f.App.view('master'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.root.innerHTML, 'previous-page');
  release({data: f.tables.project_drawings, error: null}); await Promise.all([refresh, next]);
  assert.match(f.root.innerHTML, /项目总图/);
});

test('review and attachment reads are limited to their actual page consumers', async () => {
  const form = fixture('pm'); form.S.view = 'form'; await form.loadPageData();
  assert.ok(form.calls.some(call => call.table === '@reporterTasks'));
  assert.ok(form.calls.some(call => call.table === '@completions'));
  assert.ok(form.calls.some(call => call.table === '@reportAttachments'));
  for (const view of ['mline', 'center']) {
    const f = fixture('pm'); f.S.view = view; await f.loadPageData();
    assert.ok(f.calls.some(call => call.table === '@completions'), view);
    assert.equal(f.calls.some(call => call.table === '@reportAttachments'), false, view);
  }
  for (const role of ['ops', 'president', 'pzo']) {
    const f = fixture(role); f.S.view = role === 'pzo' ? 'presCom' : 'pres'; await f.loadPageData();
    assert.ok(f.calls.some(call => call.table === '@reportAttachments'), role + ' overview must fetch actual report attachments');
    assert.ok(f.calls.some(call => call.table === '@reporterTasks'), role + ' overview reads existing leadership arrangements');
    assert.equal(f.calls.some(call => call.table === '@completions'), false, role + ' overview must not fetch an unrelated approval queue');
    assert.ok(f.calls.some(call => call.table === 'milestones'), role + ' overview must load the rolling baseline window');
    const overviewIds = new Set(f.calls.filter(call => call.table === '@reportAttachments').flatMap(call => call.query.report_ids || []));
    f.calls.length = 0; Object.assign(f.S, {view: 'detail', detailPid: role === 'pzo' ? 'p3' : 'p1', detailTab: 'report'});
    await f.loadPageData();
    assert.ok(f.calls.some(call => call.table === '@completions'), role + ' report review state');
    const detailIds = f.S.reports.filter(report => report.project_id === f.S.detailPid && report.period === (f.S.detailPeriod || f.S.pmPeriod)).map(report => String(report.id));
    assert.ok(detailIds.length, role + ' fixture must include reports for the selected detail period');
    assert.ok(f.calls.some(call => call.table === '@reportAttachments') || overviewIds.size === detailIds.length && detailIds.every(id => overviewIds.has(id)), role + ' detail must read its attachments or reuse the identical loaded report scope');
    assert.equal(f.calls.some(call => call.table === '@reporterTasks'), false, role + ' cannot read owner meeting lists');
  }
  const ops = fixture(); ops.S.view = 'completion'; await ops.loadPageData();
  assert.ok(ops.calls.some(call => call.table === '@completions'));
  assert.equal(ops.calls.some(call => call.table === '@reportAttachments'), false);
});

test('returning to an unchanged report page reuses metadata while a manual refresh rereads only that page', async () => {
  const f = fixture('pm'); f.S.view = 'form'; await f.loadPageData();
  f.S.view = 'master'; await f.loadPageData(); f.calls.length = 0;
  f.S.view = 'form'; await f.loadPageData();
  assert.equal(f.calls.length, 0, 'returning from archive must not reread an already loaded report');
  await f.loadPageData(true);
  assert.ok(f.calls.some(call => call.table === '@reportAttachments'));
  assert.ok(f.calls.some(call => call.table === '@completions'));
  assert.equal(f.calls.some(call => ['project_master', 'project_phases', 'project_drawings'].includes(call.table)), false);
});

test('real-name recipients follow the prepared project scope, reuse an unchanged list and refresh after membership invalidation', async () => {
  const f = fixture('pm'); f.S.view = 'form'; f.S.pmProject = null;
  f.setHandler(operation => operation.table === '@projectPeople'
    ? {data: [{user_id: 'person-' + operation.query.project_id, name: operation.query.project_id === 'p1' ? '甲项目候选' : '乙项目候选', role: 'pm', discipline: '工程'}]}
    : {data: f.tables[operation.table] || [], error: null});
  await f.loadPageData(); await f.preparePM(); f.renderShell();
  let recipients = f.calls.filter(call => call.table === '@projectPeople');
  assert.equal(recipients.length, 1); assert.equal(recipients[0].query.project_id, 'p1');
  assert.ok(f.calls.indexOf(recipients[0]) > f.calls.findIndex(call => call.table === 'project_members'));
  assert.match(f.root.innerHTML, /甲项目候选/); assert.doesNotMatch(f.root.innerHTML, /乙项目候选/);
  const firstCount = f.calls.length; await f.loadPageData(); assert.equal(f.calls.length, firstCount);
  f.S.pmProject = 'p3'; await f.loadData(['projectPeople']);
  assert.equal(f.S.projectPeople[0].name, '乙项目候选');
  f.invalidateData(['pms']); await f.loadData(['projectPeople']);
  recipients = f.calls.filter(call => call.table === '@projectPeople');
  assert.deepEqual(recipients.map(call => call.query.project_id), ['p1', 'p3', 'p3']);
});

test('review queue pagination keeps its filter and explicitly requests all statuses when the filter is cleared', async () => {
  const f = fixture(); f.S.view = 'completion';
  f.setHandler(operation => {
    if (operation.table !== '@completions') return {data: f.tables[operation.table] || []};
    if (operation.query.status === 'all') return {data: [], meta: {has_more: false, next_cursor: null}};
    return operation.query.cursor
      ? {data: [{id: 'page-two', revision: 1}], meta: {has_more: false, next_cursor: null}}
      : {data: [{id: 'page-one', revision: 1}], meta: {has_more: true, next_cursor: 'next-page'}};
  });
  await f.loadPageData();
  assert.equal(f.S.completionMeta.has_more, true);
  await f.loadMoreCompletions();
  const requests = f.calls.filter(call => call.table === '@completions');
  assert.equal(requests[1].query.status, 'pending');
  assert.equal(requests[1].query.cursor, 'next-page');
  assert.deepEqual(Array.from(f.S.completionQueueIds), ['page-one', 'page-two']);
  assert.equal(f.S.completionMeta.has_more, false);
  await f.queryCompletions({project_id: 'p1', status: ''});
  const last = f.calls.filter(call => call.table === '@completions').at(-1);
  assert.equal(last.query.status, 'all'); assert.equal(last.query.project_id, 'p1');
  assert.equal(f.S.completionQueueIds.length, 0);
});

test('visible source status reads do not insert supplemental approvals into the paginated personal queue', async () => {
  const f = fixture('pm'); f.S.view = 'mline';
  f.setHandler(operation => {
    if (operation.table !== '@completions') return {data: f.tables[operation.table] || []};
    return operation.query.source_keys
      ? {data: [{id: 'visible-approved', revision: 2, status: 'approved'}], meta: {has_more: false}}
      : {data: [{id: 'queued-pending', revision: 1, status: 'pending'}], meta: {has_more: true, next_cursor: 'queue-next'}};
  });
  await f.loadPageData();
  assert.ok(f.S.completions.some(row => row.id === 'visible-approved'));
  assert.deepEqual(Array.from(f.S.completionQueueIds), ['queued-pending']);
  assert.equal(f.S.completionMeta.next_cursor, 'queue-next');
  f.calls.length = 0; await f.loadPageData();
  assert.equal(f.calls.length, 0);
});

test('initial PM login executes the real login loader and loads completion plus attachment workflows before rendering', async () => {
  const f = fixture('pm'); f.installLoginBoot();
  await f.afterLogin();
  for (const file of ['completion-review.js', 'completion-review.css', 'report-attachments.js', 'report-attachments.css']) {
    assert.equal(f.downloads.filter(url => url === '/assets/' + file).length, 1, file + ' must load on the first PM login');
  }
  assert.equal(f.S.view, 'form');
  assert.match(f.root.innerHTML, /待处理事项清单/);
  assert.match(f.root.innerHTML, /附件/);
  const count = f.downloads.length;
  await f.window.PlanningBoot.ensureWorkflow(true);
  assert.equal(f.downloads.length, count, 'loaded workflow resources are reused');
});

test('a leader opens a report version from summary with only that report metadata and without navigating', async () => {
  const f = fixture('president'); f.S.view = 'pres'; await f.loadPageData(); f.renderShell(); f.installLoginBoot();
  const report = f.S.reports.find(r => r.project_id === 'p1'), attachmentId = '11111111-1111-4111-8111-111111111111';
  report.biz = { attachments: [attachmentId], followups: [{ source_key: 'leader:p1:history-lead', source_type: 'leader', title: '历史跟进', what: '原填报事项', progress: '当期反馈', status: 'completed' }] };
  report.coord_items = [{ source_id: 'history-coord', who: '测试承办人', what: '待办' }];
  const before = f.root.innerHTML, queueBefore = Array.from(f.S.completionQueueIds || []); f.calls.length = 0;
  f.setHandler(operation => {
    if (operation.table === '@reportAttachments') return {data: [{id: attachmentId, project_id: 'p1', owner_id: report.author_id,
      period: report.period, name: '版本附件.pdf', mime: 'application/pdf', size: 1200, inline: true}]};
    if (operation.table === '@completions') return {data: [{id: 'history-approved', source_key: 'leader:p1:history-lead', owner_id: report.author_id,
      owner_name: '测试承办人', project_id: 'p1', kind: 'leader', status: 'approved', revision: 2, completion_date: '2026-10-20',
      completion_note: '已核验', source_snapshot: {title: '历史跟进', what: '原事项', report_id: report.id}}], meta: {has_more: false}};
    throw new Error('history must not read unrelated tables: ' + operation.table);
  });
  await f.App.showReportHistory(report.id);
  assert.equal(f.S.view, 'pres'); assert.equal(f.root.innerHTML, before);
  assert.deepEqual(Array.from(f.S.completionQueueIds || []), queueBefore);
  const attachmentRead = f.calls.find(c => c.table === '@reportAttachments');
  assert.deepEqual(attachmentRead.query.report_ids, [String(report.id)]);
  const statusRead = f.calls.find(c => c.table === '@completions');
  assert.ok(statusRead.query.source_keys.includes('leader:p1:history-lead'));
  assert.ok(statusRead.query.source_keys.includes('coord:p1:' + report.id + ':coord:history-coord'));
  assert.equal(statusRead.query.status, undefined, 'source-key reads must not inherit the ops pending queue filter');
  assert.equal(f.calls.every(c => c.table.startsWith('@')), true);
  const modal = f.dom.get('zh_modal');
  assert.ok(modal, 'the result is a version modal over the summary');
  assert.match(modal.innerHTML, /版本附件.pdf/); assert.match(modal.innerHTML, /已审核销项/);
});

test('late version metadata cannot open the previous report after navigation', async () => {
  const f = fixture('president'); f.S.view = 'pres'; await f.loadPageData();
  const report = f.S.reports.find(r => r.project_id === 'p1'); let release, held = false;
  f.setHandler(operation => {
    if (operation.table === '@reportAttachments' && !held) { held = true; return new Promise(resolve => {release = resolve;}); }
    return {data: f.tables[operation.table] || [], meta: {has_more: false}};
  });
  const history = f.App.showReportHistory(report.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.App.view('presCom');
  release({data: []}); await history;
  assert.equal(f.S.view, 'presCom'); assert.equal(f.dom.has('zh_modal'), false);
});

test('source-key status reads consume every batch and cursor page without changing the review queue metadata', async () => {
  const f = fixture('ops'), keys = Array.from({length: 501}, (_, index) => 'leader:p1:key-' + index);
  f.S.completionQuery = {status: 'pending'}; f.S.completionQueueIds = ['main-queue']; f.S.completionMeta = {has_more: true, next_cursor: 'queue-cursor'};
  f.setHandler(operation => {
    assert.equal(operation.table, '@completions'); assert.equal(operation.query.status, undefined);
    assert.equal(operation.query.limit, 500); assert.ok(operation.query.source_keys.length <= 250);
    const first = operation.query.source_keys[0];
    return operation.query.cursor ? {data: [{id: first + '-last', status: 'rejected'}], meta: {has_more: false}}
      : {data: [{id: first + '-first', status: 'approved'}], meta: {has_more: true, next_cursor: 'next-' + first}};
  });
  const result = await f.readCompletionKeys(keys);
  assert.equal(result.error, undefined); assert.equal(result.data.length, 6); assert.equal(f.calls.length, 6);
  assert.equal(result.data.filter(r => r.status === 'approved').length, 3);
  assert.deepEqual(Array.from(f.S.completionQueueIds), ['main-queue']); assert.equal(f.S.completionMeta.next_cursor, 'queue-cursor');
  assert.equal(f.S.completionQuery.status, 'pending');
});

test('an invalid status pagination cursor produces a visible read error instead of a successful incomplete snapshot', async () => {
  for (const repeated of [false, true]) {
    const f = fixture();
    f.setHandler(() => ({data: [{id: 'partial'}], meta: {has_more: true, next_cursor: repeated ? 'same-cursor' : null}}));
    const result = await f.readCompletionKeys(['leader:p1:key']);
    assert.match(result.error.message, /分页响应无效/);
    assert.equal(f.calls.length, repeated ? 2 : 1);
  }
});

test('leader detail source keys stay within the selected report project and period', async () => {
  const f = fixture('ops'); f.S.view = 'detail'; f.S.detailPid = 'p1';
  const selected = structuredClone(f.tables.reports[0]); f.S.detailPeriod = selected.period;
  selected.coord_items = [{source_id: 'selected-coord', what: '协调事项'}]; selected.biz = {items: [{source_id: 'selected-plan', name: '计划事项'}]};
  f.tables.reports = [selected, {...structuredClone(selected), id: 'other-project', project_id: 'p3', coord_items: [{source_id: 'wrong-project'}]},
    {...structuredClone(selected), id: 'other-period', period: '第1周', coord_items: [{source_id: 'wrong-period'}]}];
  await f.loadPageData();
  const reads = f.calls.filter(c => c.table === '@completions' && c.query.source_keys);
  assert.ok(reads.length > 0);
  const keys = reads.flatMap(c => c.query.source_keys);
  assert.ok(keys.includes('coord:p1:' + selected.id + ':coord:selected-coord'));
  assert.ok(keys.includes('plan:p1:' + selected.id + ':items:selected-plan'));
  assert.equal(keys.some(key => /wrong-project|wrong-period|other-project|other-period/.test(key)), false);
});

test('changing a source table invalidates completion state and changing reports also invalidates attachment metadata', async () => {
  for (const source of ['reports', 'milestones', 'leaderNotes', 'reporterTasks']) {
    const f = fixture('pm'); f.S.view = 'form'; await f.loadPageData(); f.calls.length = 0;
    await f.loadData([source], true);
    assert.equal(f.calls.some(c => c.table === '@completions'), false, 'dependent state waits until its next consumer read');
    f.calls.length = 0; await f.loadPageData();
    assert.ok(f.calls.some(c => c.table === '@completions'), source + ' must refresh derived source approval');
    assert.equal(f.calls.some(c => c.table === '@reportAttachments'), source === 'reports', source + ' attachment invalidation');
  }
});

test('PM history requests attachment metadata for every visible report in the selected project including another author', async () => {
  const f = fixture('pm'); f.S.view = 'history'; f.S.pmProject = 'p1';
  const base = structuredClone(f.tables.reports[0]);
  f.tables.reports = [{...base, id: 'own-report', author_id: 'current'}, {...base, id: 'other-author-report', author_id: 'other'},
    {...base, id: 'other-project-report', project_id: 'p3', author_id: 'current'}];
  await f.loadPageData();
  const reads = f.calls.filter(call => call.table === '@reportAttachments');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].query.report_ids, ['other-author-report', 'own-report']);
});

test('malformed historical followups do not crash source-key metadata discovery', async () => {
  const f = fixture('pm'); f.S.view = 'history';
  f.tables.reports[0].biz = {followups: {invalid: true}};
  assert.equal(await f.loadPageData(), true);
  assert.equal(f.S.loadErrors.length, 0);
});

test('period and project switch entries read the new attachment scope before preparing and submitting its selected files', async () => {
  for (const entry of ['period', 'switchProject']) {
    const f = fixture('pm'), oldId = '11111111-1111-4111-8111-111111111111', nextId = '22222222-2222-4222-8222-222222222222';
    const oldPeriod = '第42周', nextPeriod = entry === 'period' ? '第43周' : oldPeriod, nextProject = entry === 'switchProject' ? 'p3' : 'p1';
    const base = structuredClone(f.tables.reports[0]);
    function submitted(id, project, period, attachment) { return {...structuredClone(base), id, project_id: project, period, author_id: 'current', author_name: '当前演示用户',
      line: project === 'p3' ? '土建工程（东地块）' : '综合', biz: {form_version: 2, nodes: [], items: [{source_id: id + '-item', name: '已登记工作计划', mod: '综合', prog: '按计划推进'}], followups: [], attachments: [attachment]}}; }
    f.tables.reports = [submitted('old-report', 'p1', oldPeriod, oldId), submitted('next-report', nextProject, nextPeriod, nextId)];
    f.S.view = 'form'; f.S.pmPeriod = oldPeriod;
    f.setHandler(operation => {
      if (operation.table === '@reportAttachments') {
        const next = operation.query.project_id === nextProject && operation.query.period === nextPeriod;
        return {data: [{id: next ? nextId : oldId, owner_id: 'current', project_id: operation.query.project_id, period: operation.query.period,
          line: operation.query.line, name: next ? '新范围文件.pdf' : '原范围文件.pdf', mime: 'application/pdf', size: 1200, inline: true}]};
      }
      if (operation.table === 'reports' && operation.operation === 'upsert') return {data: null, error: {message: 'capture submission payload only'}};
      return {data: f.tables[operation.table] || []};
    });
    await f.loadPageData(); await f.preparePM();
    assert.equal(f.window.ReportAttachments.validationError(), ''); f.calls.length = 0;
    if (entry === 'period') await f.App.period(nextPeriod); else await f.App.switchProject(nextProject);
    const metadata = f.calls.find(c => c.table === '@reportAttachments');
    assert.ok(metadata, entry + ' must read the new scope'); assert.equal(metadata.query.project_id, nextProject); assert.equal(metadata.query.period, nextPeriod);
    assert.deepEqual(Array.from(f.S.attachmentIds), [nextId]);
    assert.equal(f.window.ReportAttachments.validationError(), '', entry + ' must not reject the new report using old scope metadata');
    assert.match(f.root.innerHTML, /新范围文件.pdf/);
    await f.App.submitReport();
    const write = f.calls.find(c => c.table === 'reports' && c.operation === 'upsert');
    assert.ok(write, entry + ' submission reaches the persistence boundary');
    assert.deepEqual(Array.from(write.values.biz.attachments), [nextId]);
  }
});

test('each actual milestone save entry invalidates old approval even when the approval refresh fails', async () => {
  for (const entry of ['msSet', 'mlineSave', 'lineSaveAll']) {
    const f = fixture(entry === 'mlineSave' ? 'pm' : 'ops'); f.S.view = entry === 'mlineSave' ? 'mline' : 'nodes';
    await f.loadPageData(); const milestone = f.S.milestones[0], key = 'milestone:' + milestone.project_id + ':' + milestone.id;
    f.S.completions = [{id: 'previous-approved', source_key: key, owner_id: 'current', status: 'approved', revision: 1}]; f.renderShell(); f.calls.length = 0;
    f.setHandler(operation => operation.table === 'milestones' && operation.operation === 'update' ? {data: [{id: milestone.id}]}
      : operation.table === '@completions' ? {data: null, error: {message: '模拟审核状态读取失败'}} : {data: f.tables[operation.table] || []});
    if (entry === 'msSet') await f.App.msSet(milestone.id, '2027-08-01');
    else if (entry === 'mlineSave') { f.dom.set('ml_fc_' + milestone.id, {value: '2027-08-02'}); await f.App.mlineSave(); }
    else { f.dom.set('ln_line_' + milestone.id, {value: '设计'}); await f.App.lineSaveAll(); }
    assert.ok(f.calls.some(c => c.table === 'milestones' && c.operation === 'update'), entry + ' must exercise a real update');
    assert.ok(f.calls.some(c => c.table === '@completions'), entry + ' must reread approval after changing its source');
    assert.equal(f.S.completions[0].source_changed, true, entry);
    assert.equal(f.window.CompletionReview.approved(key, 'current'), false, entry + ' must not retain effective approval after a failed refresh');
  }
});

test('a late milestone save response after switching accounts cannot mutate new state or start approval reads', async () => {
  const f = fixture(); f.S.view = 'nodes'; await f.loadPageData(); const old = f.S.milestones[0]; let release;
  f.setHandler(operation => operation.operation === 'update' ? new Promise(resolve => {release = resolve;}) : {data: []}); f.calls.length = 0;
  const saving = f.App.msSet(old.id, '2027-09-01'); await new Promise(resolve => setImmediate(resolve));
  f.S.uid = 'new-account'; f.S.session = {user: {id: 'new-account'}};
  f.S.milestones = [{id: old.id, project_id: old.project_id, forecast_date: '2028-01-01'}];
  f.S.completions = [{id: 'new-account-approved', owner_id: 'new-account', source_key: 'milestone:' + old.project_id + ':' + old.id, status: 'approved'}];
  release({data: [{id: old.id}]}); await saving;
  assert.equal(f.S.milestones[0].forecast_date, '2028-01-01'); assert.equal(f.S.completions[0].source_changed, undefined);
  assert.equal(f.calls.some(c => c.table === '@completions'), false);
});

test('same-page version requests opened A then B only display B when A finishes last', async () => {
  const f = fixture('president'); f.S.view = 'pres'; await f.loadPageData();
  const base = structuredClone(f.S.reports[0]);
  f.S.reports = [{...structuredClone(base), id: '101', change_text: 'A版本内容'}, {...structuredClone(base), id: '102', change_text: 'B版本内容'}];
  const releases = new Map();
  f.setHandler(operation => operation.table === '@reportAttachments' ? new Promise(resolve => releases.set(operation.query.report_ids[0], resolve)) : {data: []});
  const a = f.App.showReportHistory('101'), b = f.App.showReportHistory('102');
  await new Promise(resolve => setImmediate(resolve));
  releases.get('102')({data: []}); await b;
  const latest = f.dom.get('zh_modal'); assert.ok(latest); assert.match(latest.innerHTML, /B版本内容/);
  releases.get('101')({data: []}); await a;
  assert.equal(f.dom.get('zh_modal'), latest); assert.match(latest.innerHTML, /B版本内容/); assert.doesNotMatch(latest.innerHTML, /A版本内容/);
  assert.equal(f.S.view, 'pres');
});

test('commercial attachment loading derives a real assigned module before PM preparation and missing assignment makes no request', async () => {
  for (const assignment of ['*', '机电设计', null, '未知模块']) {
    const f = fixture('pm'); f.S.view = 'form'; f.S.pmProject = 'p3'; f.S.pmLine = '*'; f.S.profile.biz_line = assignment;
    await f.loadPageData();
    const reads = f.calls.filter(call => call.table === '@reportAttachments');
    if (assignment === '*' || assignment === '机电设计') {
      assert.equal(reads.length, 1); assert.equal(reads[0].query.project_id, 'p3');
      assert.equal(reads[0].query.line, assignment === '*' ? '土建工程（东地块）' : '机电设计');
      assert.notEqual(reads[0].query.line, '*');
    } else assert.equal(reads.length, 0, 'an unassigned module must not query a guessed attachment scope');
    await f.preparePM();
    assert.equal(f.S.pmLine, assignment === '*' ? '土建工程（东地块）' : assignment === '机电设计' ? assignment : '');
  }
});

test('an in-flight wildcard module transition blocks a second scope change and an unchanged completed scope is reused', async () => {
  const f = fixture('pm'), ids = {'土建工程（东地块）': '10000000-0000-4000-8000-000000000001', 机电工程: '10000000-0000-4000-8000-000000000002', 精装工程: '10000000-0000-4000-8000-000000000003'};
  f.S.profile.biz_line = '*'; f.S.view = 'form'; f.S.pmProject = 'p3'; f.S.pmLine = '土建工程（东地块）';
  const base = structuredClone(f.tables.reports[0]);
  f.tables.reports = Object.keys(ids).map((line, index) => ({...structuredClone(base), id: index + 100, project_id: 'p3', line,
    author_id: 'current', period: f.S.pmPeriod, biz: {nodes: [], items: [{name: line + '计划'}], followups: [], attachments: [ids[line]]}}));
  let releaseFirst, held = false;
  function dataFor(line) {return {data: [{id: ids[line], project_id: 'p3', period: f.S.pmPeriod, line, owner_id: 'current', name: line + '.pdf', mime: 'application/pdf', size: 1234, inline: true}]};}
  f.setHandler(op => {
    if (op.table === '@reportAttachments') {
      if (op.query.line === '机电工程' && !held) {held = true; return new Promise(resolve => {releaseFirst = resolve;});}
      return dataFor(op.query.line);
    }
    return {data: f.tables[op.table] || []};
  });
  await f.loadPageData(); await f.preparePM(); f.calls.length = 0;
  const first = f.App.pmLineSet('机电工程'); await new Promise(resolve => setImmediate(resolve)); assert.ok(releaseFirst);
  const last = f.App.pmLineSet('精装工程'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.S.pmLine, '机电工程'); assert.ok(f.S.pmScopeTransition); assert.match(f.root.innerHTML, /正在加载填报页面/);
  releaseFirst(dataFor('机电工程')); await Promise.all([first, last]);
  assert.equal(f.S.pmLine, '机电工程'); assert.equal(f.S.reportAttachments[0].line, '机电工程');
  assert.equal(f.S.pmScopeTransition, null);
  await f.App.pmLineSet('精装工程');
  assert.equal(f.S.pmLine, '精装工程'); assert.equal(f.S.pmReport.line, '精装工程');
  assert.equal(f.S.reportAttachments[0].line, '精装工程'); assert.deepEqual(Array.from(f.S.attachmentIds), [ids.精装工程]);
  assert.equal(f.window.ReportAttachments.validationError(), ''); assert.match(f.root.innerHTML, /精装工程.pdf/); assert.doesNotMatch(f.root.innerHTML, /机电工程.pdf/);
  assert.deepEqual(f.calls.filter(op => op.table === '@reportAttachments').map(op => op.query.line), ['机电工程', '精装工程']);
  f.calls.length = 0; await f.App.pmLineSet('精装工程'); assert.equal(f.calls.length, 0);
});

test('native changes with a delayed new scope cannot autosave old DOM after 700ms; normal current-scope autosave still works', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
    .replace('window.App = App;', 'window.App = App; window.scopeTest = {S,loadPageData,preparePM,renderShell,bindDraftAutosave,currentPeriod,draftKey};')
    .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
  try {
    for (const entry of ['module', 'period', 'project', 'history']) {
      const context = await browser.newContext();
      try {
        // A routed synthetic origin provides real DOM, events, localStorage and
        // real browser timers. No local or production service is contacted.
        await context.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>'}));
        const page = await context.newPage(); await page.goto('http://reporter-scope.test/');
        await page.evaluate(() => {
          window.fixtureTables = {}; window.fixtureWrites = []; window.attachmentUploads = 0;
          window.WorkBuddyCloud = {createWorkBuddyCloud: () => ({database: {from(table) {
            const op = {table, operation: 'select'};
            const q = {select() {return q;}, order() {return q;}, eq() {return q;}, limit() {return q;},
              upsert(values) {op.operation = 'upsert'; op.values = values; return q;},
              then(resolve, reject) {if (op.operation !== 'select') window.fixtureWrites.push(op); return Promise.resolve({data: window.fixtureTables[table] || [], error: null}).then(resolve, reject);}};
            return q;
          }}})};
          window.fetch = async (url, options) => {
            if (String(url).startsWith('/api/report-attachments/upload')) window.attachmentUploads++;
            if (url === '/api/report-attachments/list' && window.holdNextAttachmentRead) {
              window.holdNextAttachmentRead = false; window.waitingForAttachmentRead = true;
              await new Promise(resolve => {window.releaseAttachmentRead = resolve;});
            }
            return new Response(JSON.stringify({data: [], error: null, meta: {has_more: false}}), {status: 200, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
          };
        });
        await page.addScriptTag({content: fs.readFileSync(new URL('../web/report-attachments.js', import.meta.url), 'utf8')});
        await page.addScriptTag({content: source});
        await page.evaluate(async entry => {
          const h = window.scopeTest, period = h.currentPeriod(), residential = entry === 'project';
          const projects = [{id: 'p1', name: '匿名项目甲', project_type: residential ? 'res' : 'com'}, {id: 'p2', name: '匿名项目乙', project_type: 'res'}];
          const initialLine = residential ? '综合' : '土建工程（东地块）';
          const make = (id, pid, line, period, name) => ({id, project_id: pid, line, period, author_id: 'anonymous', author_name: '匿名填报人',
            updated_at: '2020-01-01T00:00:00Z', node_items: [], coord_items: [], biz: {form_version: 2, nodes: [], items: [{name, prog: ''}], attachments: [], followups: []}});
          window.fixtureTables.projects = projects;
          window.fixtureTables.project_members = projects.map(p => ({project_id: p.id, user_id: 'anonymous'}));
          window.fixtureTables.reports = [make(1, 'p1', initialLine, period, '旧范围计划'), make(2, 'p1', '机电工程', period, '新范围计划'),
            make(3, 'p1', initialLine, '第42周', '新范围计划'), make(4, 'p2', '综合', period, '新范围计划')];
          Object.assign(h.S, {uid: 'anonymous', session: {user: {id: 'anonymous'}}, profile: {user_id: 'anonymous', role: 'pm', status: 'approved', name: '匿名填报人', project_id: 'p1', biz_line: '*'},
            view: 'form', pmProject: 'p1', pmPeriod: period, pmLine: initialLine});
          await h.loadPageData(); await h.preparePM(); h.renderShell(); h.bindDraftAutosave();
          window.oldDraftKey = h.draftKey(); window.holdNextAttachmentRead = true;
        }, entry);
        await page.locator('#bi_nm_0').fill('旧范围尚未提交的输入');
        await page.locator('#bi_nm_0').dispatchEvent('change');
        if (entry === 'module') await page.locator('#planBizLine').selectOption('机电工程');
        else if (entry === 'period') await page.locator('#pmPeriod').selectOption('第42周');
        else if (entry === 'project') await page.locator('#planProject').selectOption('p2');
        else await page.locator('.planning-mainnav').getByRole('button', {name: '历史记录', exact: true}).click();
        await page.waitForFunction(() => window.waitingForAttachmentRead === true);
        await browserExpect(page.locator('[role="status"]')).toContainText('正在加载填报页面');
        await browserExpect(page.locator('#bi_nm_0')).toHaveCount(0);
        await page.waitForTimeout(900); // Exercise the actual 700ms change timer.
        await page.evaluate(async () => {
          await window.App.submitReport();
          await window.ReportAttachments.upload({files: [new File(['anonymous'], 'anonymous.png', {type: 'image/png'})], value: 'selected'});
        });
        assert.deepEqual(await page.evaluate(() => ({writes: window.fixtureWrites.length, uploads: window.attachmentUploads})), {writes: 0, uploads: 0}, entry);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(window.oldDraftKey)).bizItems[0].name), '旧范围尚未提交的输入', entry);
        await page.evaluate(() => window.releaseAttachmentRead());
        await page.waitForFunction(() => !window.scopeTest.S.pmScopeTransition);
        if (entry === 'history') {
          await page.locator('.planning-mainnav').getByRole('button', {name: '本期填报', exact: true}).click();
          await browserExpect(page.locator('#bi_nm_0')).toHaveValue('旧范围尚未提交的输入');
        } else {
          await browserExpect(page.locator('#bi_nm_0')).toHaveValue('新范围计划');
          assert.notEqual(await page.evaluate(() => window.scopeTest.draftKey()), await page.evaluate(() => window.oldDraftKey), entry);
        }
        await page.locator('#bi_nm_0').fill('当前范围正常自动保存');
        await page.locator('#bi_nm_0').dispatchEvent('change'); await page.waitForTimeout(900);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(window.scopeTest.draftKey())).bizItems[0].name), '当前范围正常自动保存', entry);
        assert.deepEqual(await page.evaluate(() => ({writes: window.fixtureWrites.length, uploads: window.attachmentUploads})), {writes: 0, uploads: 0}, entry);
      } finally {await context.close();}
    }
  } finally {await browser.close();}
});

test('actual app synchronization refresh preserves other form names, dates and Quill formatting typed before and during a delayed source reload', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
    .replace('window.App = App;', 'window.App = App; window.scopeTest = {S,loadPageData,preparePM,renderShell,currentPeriod,draftKey};')
    .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
  try {
    for (const fail of [false, true]) {
      const context = await browser.newContext();
      try {
        await context.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>'}));
        const page = await context.newPage(); await page.goto('http://reporter-sync.test/');
        await page.evaluate(() => {
          window.fixtureTables = {};
          window.WorkBuddyCloud = {createWorkBuddyCloud: () => ({database: {from(table) {
            const q = {select() {return q;}, order() {return q;}, eq() {return q;}, limit() {return q;},
              then(resolve, reject) {return (async () => {
                if (table === 'reports' && window.holdNextReportRead) {
                  window.holdNextReportRead = false; window.waitingForReportRead = true;
                  await new Promise(done => {window.releaseReportRead = done;});
                  if (window.failReportRead) return {data: null, error: {message: '匿名来源读取失败'}};
                }
                return {data: window.fixtureTables[table] || [], error: null};
              })().then(resolve, reject);}};
            return q;
          }}})};
          window.fetch = async () => new Response(JSON.stringify({data: [], error: null, meta: {has_more: false}}), {status: 200, headers: {'content-type': 'application/json'}});
        });
        for (const name of ['styles.css','planning-ui.css','report3-layout.css','personal-report4.css','selection-format.css','reporter-tasks.css','vendor/quill/quill.core.css']) {
          await page.addStyleTag({content: fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8')});
        }
        for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'reporter-tasks.js']) {
          await page.addScriptTag({content: fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8')});
        }
        await page.addScriptTag({content: source});
        await page.evaluate(async fail => {
          const h = window.scopeTest, period = h.currentPeriod();
          window.fixtureTables.projects = [{id: 'p1', name: '匿名同步项目', project_type: 'com'}];
          window.fixtureTables.project_members = [{project_id: 'p1', user_id: 'anonymous'}];
          window.fixtureTables.leader_notes = [{id: 'shared', project_id: 'p1', period, what: '匿名领导安排'}];
          window.fixtureTables.reports = [{id: 1, project_id: 'p1', line: '土建工程（东地块）', period, author_id: 'anonymous', author_name: '匿名填报人',
            updated_at: '2020-01-01T00:00:00Z', node_items: [], coord_items: [], biz: {nodes: [], items: [{name: '初始事项甲'}, {name: '初始事项乙'}], followups: []}}];
          Object.assign(h.S, {uid: 'anonymous', session: {user: {id: 'anonymous'}}, profile: {role: 'pm', status: 'approved', name: '匿名填报人', project_id: 'p1', biz_line: '*'},
            view: 'form', pmProject: 'p1', pmPeriod: period, pmLine: '土建工程（东地块）'});
          await h.loadPageData(); await h.preparePM(); h.renderShell();
          window.holdNextReportRead = true; window.failReportRead = fail;
        }, fail);
        async function rich(id, text, bold = false) {
          const wrap = page.locator('[data-rich-editor-for="' + id + '"]'), editor = wrap.locator('.ql-editor');
          await editor.fill(text);
          if (bold) {
            await editor.press('Control+A');
            const button=page.getByRole('toolbar', {name: '所选文字格式'}).getByRole('button', {name: '加粗', exact: true});
            if(await button.getAttribute('aria-pressed')!=='true')await button.click();
          }
        }
        for (const index of [0, 1]) {
          await rich('bi_nm_' + index, '刷新前名称' + index);
          await page.locator('#bi_due_' + index).fill('2027-03-01');
          await rich('bi_pg_' + index, '刷新前加粗进展' + index, true);
        }
        await page.getByRole('button', {name: '更新待办事项', exact: true}).click();
        await page.waitForFunction(() => window.waitingForReportRead === true);
        await rich('bi_nm_0', '等待期间新增名称');
        await page.locator('#bi_due_0').fill('2027-04-02');
        await rich('bi_pg_0', '等待期间加粗进展', true);
        await page.evaluate(() => window.releaseReportRead());
        await browserExpect(page.getByRole('button', {name: '更新待办事项', exact: true})).toBeEnabled();
        await browserExpect(page.locator('[data-rich-editor-for="bi_nm_0"] .ql-editor')).toHaveText('等待期间新增名称');
        await browserExpect(page.locator('#bi_due_0')).toHaveValue('2027-04-02');
        await browserExpect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toHaveText('等待期间加粗进展');
        await browserExpect(page.locator('[data-rich-editor-for="bi_nm_1"] .ql-editor')).toHaveText('刷新前名称1');
        await browserExpect(page.locator('#bi_due_1')).toHaveValue('2027-03-01');
        await browserExpect(page.locator('[data-rich-editor-for="bi_pg_1"] .ql-editor strong')).toHaveText('刷新前加粗进展1');
        const draft = await page.evaluate(() => JSON.parse(localStorage.getItem(window.scopeTest.draftKey())));
        assert.equal(draft.bizItems[0].name, '等待期间新增名称'); assert.equal(draft.bizItems[0].due, '2027-04-02');
        assert.equal(draft.bizItems[0]._rich.prog.ops[0].attributes.bold, true);
        assert.equal(draft.bizItems[1].name, '刷新前名称1');
        await browserExpect(page.locator('#toast')).toContainText(fail ? '同步来源更新失败' : '已更新可同步来源');
      } finally {await context.close();}
    }
  } finally {await browser.close();}
});
