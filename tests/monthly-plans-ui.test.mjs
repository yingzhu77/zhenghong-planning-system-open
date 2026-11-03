import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/monthly-plans.js', import.meta.url), 'utf8');
const windows = fs.readFileSync(new URL('../web/planning-windows.js', import.meta.url), 'utf8');
const rich = fs.readFileSync(new URL('../web/rich-text.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function plan(extra = {}) {
  return { id: 'confirmed-plan', project_id: 'p1', line: '机电工程', plan_month: '2026-10-01',
    confirmed_by: 'owner', confirmed_by_name: '匿名填报人', confirmed_at: '2026-09-30T06:00:00Z',
    items: [{ source_id: 'fixed-item', mod: '月度模块', name: '固定事项', due: '2026-10-30' }], ...extra };
}
function harness(handler, storage = new Map()) {
  const elements = {}, calls = [], messages = [], actionCalls = [], completionCalls = [];
  let renders = 0, flushes = 0, id = 0;
  const S = { uid: 'owner', session: {}, profile: { role: 'pm', biz_line: '机电工程' }, pmProject: 'p1', pmLine: '机电工程',
    pmPeriod: '2026-10-19', pmReport: null, projects: [{ id: 'p1', project_type: 'com' }, { id: 'p2', project_type: 'com' }],
    monthlyPlans: [], reports: [], bizItems: [], completions: [] };
  const completionRows = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const sandbox = { console, localStorage, document: { getElementById: key => elements[key] || null }, crypto: { randomUUID: () => 'generated-' + (++id) } };
  sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(rich, sandbox); vm.runInContext(windows, sandbox); vm.runInContext(source, sandbox);
  sandbox.CompletionReview = { actionHtml: (key, options) => { actionCalls.push({ key, ...options }); return '<span data-source="' + escape(key) + '">查看审核</span>'; } };
  const api = sandbox.MonthlyPlans;
  const options = { S, esc: escape, render: () => renders++, flush: () => flushes++,
    toast: (...args) => messages.push(args), richCopy: sandbox.ZHRichText.copy, richItem: sandbox.ZHRichText.field,
    richCollect: row => sandbox.ZHRichText.collect(clone(row)), completionFor: (key, owner) => {
      completionCalls.push({ key, owner }); return completionRows.get(key + ':' + owner) || null;
    }, request: async (url, body) => {
      calls.push({ url, body: clone(body) });
      return handler ? handler(url, body) : { data: plan({ plan_month: body.month + '-01', items: clone(body.items), rich_text: body.rich_text }), error: null };
    } };
  api.configure(options);
  return { S, api, options, elements, calls, messages, actionCalls, completionCalls, completionRows, sandbox, storage,
    get renders() { return renders; }, get flushes() { return flushes; } };
}
function fillNext(h, name = '下月独立事项') {
  h.api.select('next'); h.api.plannerHtml();
  h.api.edit(0, 'mod', '下月模块'); h.api.edit(0, 'name', name); h.api.edit(0, 'due', '2026-11-25');
}
function report(id, period, item, extra = {}) {
  return { id, project_id: 'p1', line: '机电工程', author_id: 'owner', period, submitted_at: period + 'T04:00:00Z',
    biz: { items: [item] }, ...extra };
}

test('commercial weekly core is a read-only projection of confirmed items and live feedback, preserving nodes and drafts', () => {
  const h = harness();
  h.S.monthlyPlans = [plan({items:[{source_id:'fixed-item',name:'本周固定事项',mod:'模块',due:'2026-10-23'}],
    rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'本周固定事项',attributes:{bold:true}}]}}}})];
  h.S.bizNodes = [{name:'旧手填节点',prog:'旧进展'}];
  h.S.bizItems = [{source_id:'fixed-item',name:'草稿不能改确认名',prog:'正在施工',blocker:'等材料',
    _rich:{prog:{ops:[{insert:'正在施工',attributes:{bold:true}}]}}}];
  const before = clone({nodes:h.S.bizNodes,items:h.S.bizItems});
  const html = h.api.personalCoreHtml();
  assert.match(html, /本周固定事项/); assert.doesNotMatch(html,/草稿不能改确认名|旧手填节点|<input|<textarea|App.addBizNode/);
  assert.match(html, /<strong>正在施工<\/strong>/); assert.match(html,/等材料|本机填写内容/);
  assert.deepEqual(clone({nodes:h.S.bizNodes,items:h.S.bizItems}),before);
  h.elements['monthly-core-summary']={innerHTML:''};
  h.S.bizItems[0].prog='刚更新的进展'; h.api.refreshCore();
  assert.match(h.elements['monthly-core-summary'].innerHTML,/刚更新的进展/);
  assert.equal(h.flushes,1); assert.equal(h.calls.length,0);
});

test('weekly core spans confirmed months and years while excluding other modules, projects and dates', () => {
  const h=harness(); h.S.pmPeriod='2026-12-28';
  h.S.monthlyPlans=[plan({id:'dec',plan_month:'2026-12-01',items:[{source_id:'d',name:'十二月事项',due:'2026-12-31'}]}),
    plan({id:'jan',plan_month:'2027-01-01',items:[{source_id:'j',name:'一月事项',due:'2027-01-03'},{source_id:'outside',name:'下周',due:'2027-01-04'}]}),
    plan({id:'other-project',project_id:'p2',items:[{source_id:'p',name:'其他项目',due:'2026-12-31'}]}),
    plan({id:'other-line',line:'开发',items:[{source_id:'l',name:'其他模块',due:'2026-12-31'}]})];
  const html=h.api.personalCoreHtml();
  assert.match(html,/十二月事项/); assert.match(html,/一月事项/);
  assert.doesNotMatch(html,/下周|其他项目|其他模块/);
  h.S.monthlyPlans=[]; h.S.bizItems=[{name:'未确认草稿',due:'2026-12-31',prog:'已填'}];
  assert.doesNotMatch(h.api.personalCoreHtml(),/未确认草稿|已填/);
  assert.match(h.api.personalCoreHtml(),/暂无已确认月计划/);
});

test('manager core joins exact plan and item identities, labels older feedback and never imports future reports', () => {
  const h=harness(), item={source_id:'fixed-item',name:'同名事项',due:'2026-10-23'};
  h.S.monthlyPlans=[plan({items:[item]})];
  h.S.reports=[report('old','2026-10-12',{...item,prog:'上周记录',blocker:'旧卡点'}, {biz:{monthly_plan_id:'confirmed-plan',items:[{...item,prog:'上周记录',blocker:'旧卡点'}]}}),
    report('future','2026-10-26',item,{biz:{monthly_plan_id:'confirmed-plan',items:[{...item,prog:'未来记录'}]}}),
    report('wrong-plan','2026-10-19',item,{biz:{monthly_plan_id:'other-plan',items:[{...item,prog:'同名不能串联'}]}})];
  const options={projectId:'p1',line:'机电工程',window:h.sandbox.PlanningWindows.windowFor('2026-10-19','month')};
  let html=h.api.coreHtml(options);
  assert.match(html,/本周未反馈/); assert.match(html,/最近历史反馈（2026-10-12）/); assert.match(html,/上周记录/);
  assert.doesNotMatch(html,/未来记录|同名不能串联/);
  h.S.reports.push(report('current','2026-10-19',item,{biz:{monthly_plan_id:'confirmed-plan',items:[{...item,prog:'本周最新',blocker:'本周卡点'}]}}));
  html=h.api.coreHtml(options);
  assert.match(html,/本周最新/); assert.match(html,/本周卡点/); assert.doesNotMatch(html,/上周记录|未来记录|同名不能串联/);
  assert.match(html,/data-section="nodes"/);
});

test('unbound historical reports never bind to a later confirmation or leak their draft feedback into automatic core', () => {
  const h=harness();
  const item={source_id:'fixed-item',name:'旧报告事项',due:'2026-10-23',prog:'原始历史进展'};
  h.S.pmReport=report('legacy','2026-10-19',item); h.S.reports=[h.S.pmReport];
  h.S.bizItems=[clone(item)]; h.S.bizNodes=[{name:'旧节点',prog:'旧节点进展'}];
  h.S.monthlyPlans=[plan({items:[{...item,name:'新确认事项',prog:undefined}]})];
  const before=clone({report:h.S.pmReport,items:h.S.bizItems,nodes:h.S.bizNodes});
  const html=h.api.personalCoreHtml();
  assert.match(html,/新确认事项/); assert.match(html,/本周未反馈/); assert.doesNotMatch(html,/原始历史进展/);
  assert.deepEqual(clone({report:h.S.pmReport,items:h.S.bizItems,nodes:h.S.bizNodes}),before);
});

test('confirmed baseline replaces stale draft columns while preserving only matching weekly feedback and its rich text', () => {
  const h = harness();
  h.S.monthlyPlans = [plan({ rich_text: { v: 1, fields: { 'items.0.name': { ops: [{ insert: '固定事项', attributes: { bold: true } }] } } } })];
  h.S.bizItems = [{ source_id: 'fixed-item', mod: '旧草稿模块', name: '被篡改的事项', due: '2030-01-01', prog: '当周进展', blocker: '当周卡点',
    _rich: { name: { ops: [{ insert: '被篡改的事项', attributes: { color: '#ff0000' } }] }, prog: { ops: [{ insert: '当周进展', attributes: { bold: true } }] } } },
  { source_id: 'deleted-from-plan', name: '陈旧多余事项', prog: '不能按名称配对' }];
  assert.equal(h.api.prepare(), true);
  assert.deepEqual(clone(h.S.bizItems[0]), { source_id: 'fixed-item', mod: '月度模块', name: '固定事项', due: '2026-10-30',
    prog: '当周进展', blocker: '当周卡点', _rich: {
      name: { ops: [{ insert: '固定事项', attributes: { bold: true } }] }, prog: { ops: [{ insert: '当周进展', attributes: { bold: true } }] } } });
  assert.equal(h.S.bizItems.length, 1);
  assert.deepEqual(clone(h.api.metadata()), { monthly_plan_id: 'confirmed-plan', monthly_plan_month: '2026-10' });
  h.api.prepare(); assert.equal(h.S.bizItems[0].prog, '当周进展');
  assert.match(h.api.actionHtml(h.S.bizItems[0]), /monthly:p1:confirmed-plan:fixed-item/);
});

test('a replaced plan UUID blocks an old weekly draft until explicit refresh preserves its original rich feedback',()=>{
  const first=harness(),old=plan({id:'old-plan-uuid'});
  first.S.monthlyPlans=[old];first.S.bizItems=[{...old.items[0],prog:'旧版本进展',blocker:'旧版本卡点',_rich:{prog:{ops:[{insert:'旧版本进展',attributes:{bold:true}}]}}}];
  first.api.prepare();const saved=clone({bizItems:first.S.bizItems,monthlyPlanReferences:first.api.planReferences(),ts:Date.parse('2026-10-20T00:00:00Z')});
  const raw=JSON.stringify(saved),h=harness();h.S.draft=clone(saved);h.S.draftRestored=true;h.S.bizItems=clone(saved.bizItems);
  h.S.monthlyPlans=[plan({id:'new-plan-uuid',items:[{...old.items[0],name:'管理员修正事项'}]})];
  assert.equal(h.api.prepare(),false);assert.equal(h.api.needsRefresh(),true);assert.deepEqual(clone(h.S.bizItems),saved.bizItems);
  assert.match(h.api.toolbarHtml(),/月计划版本已更新/);assert.equal(h.api.actionHtml(h.S.bizItems[0]),'');assert.deepEqual(clone(h.api.metadata()),{});
  h.api.acceptUpdated();assert.equal(h.api.needsRefresh(),false);assert.equal(h.S.bizItems[0].name,'管理员修正事项');assert.equal(h.S.bizItems[0].prog,'');
  assert.deepEqual(clone(h.S.monthlyUnmatchedItems),saved.bizItems);assert.equal(JSON.stringify(h.S.draft),raw);
  assert.deepEqual(clone(h.api.metadata()),{monthly_plan_id:'new-plan-uuid',monthly_plan_month:'2026-10'});assert.doesNotMatch(JSON.stringify(h.api.metadata()),/monthlyPlanReferences/);
});

test('old weekly drafts without version metadata use newer confirmation time only to request explicit review',()=>{
  const h=harness(),original={source_id:'fixed-item',mod:'原模块',name:'原草稿事项',prog:'不能丢的原进展'};
  h.S.draft={ts:Date.parse('2026-10-20T00:00:00Z'),bizItems:[clone(original)]};h.S.draftRestored=true;h.S.bizItems=[clone(original)];
  h.S.monthlyPlans=[plan({confirmed_at:'2026-10-21T00:00:00Z'})];assert.equal(h.api.prepare(),false);assert.equal(h.api.apply(),false);
  assert.deepEqual(clone(h.S.bizItems),[original]);assert.equal(h.api.needsRefresh(),true);
  h.api.acceptUpdated();assert.equal(h.S.bizItems[0].name,'固定事项');assert.equal(h.S.bizItems[0].prog,'');assert.deepEqual(clone(h.S.monthlyUnmatchedItems),[original]);
});

test('externally confirmed next plan retains the original private monthly draft, raw backup and formatting for readonly review',()=>{
  const h=harness();fillNext(h,'本机未提交原事项');h.api.binding('monthly_next_name_0').set({ops:[{insert:'本机未提交原事项',attributes:{bold:true,color:'#d81e06'}}]});
  assert.equal(h.api.saveDraft(),true);const key=[...h.storage.keys()][0];
  h.S.monthlyPlans=[plan({id:'administrator-plan',plan_month:'2026-11-01',items:[{source_id:'administrator-item',name:'服务器确认事项',due:'2026-11-25'}]})];
  assert.equal(h.api.saveDraft(),true);const raw=h.storage.get(key);assert.ok(raw);const html=h.api.toolbarHtml();
  assert.match(html,/本机未提交的原月计划草稿（只读保留）/);assert.match(html,/<strong>本机未提交原事项<\/strong>/);assert.match(html,/原月计划草稿备份/);assert.equal(h.storage.get(key),raw);
  const reopened=harness(undefined,h.storage);reopened.S.monthlyPlans=clone(h.S.monthlyPlans);reopened.api.select('next');assert.match(reopened.api.toolbarHtml(),/本机未提交原事项/);assert.equal(h.storage.get(key),raw);
  assert.equal(h.calls.length,0);assert.equal(reopened.calls.length,0);
});

function retainedNext(h) {
  fillNext(h,'重要下月原稿');h.api.binding('monthly_next_name_0').set({ops:[{insert:'重要下月原稿',attributes:{bold:true,color:'#d81e06'}}]});
  assert.equal(h.api.saveDraft(),true);const key=[...h.storage.keys()][0];return {key,raw:h.storage.get(key)};
}
test('a next-month 409 reads the canonical plan without deleting or rewriting the original raw and rich draft',async()=>{
  const h=harness(()=>({error:{code:'monthly_plan_confirmed',message:'已在另一端确认'}})),saved=retainedNext(h);
  h.options.loadData=async()=>{h.S.monthlyPlans=[plan({id:'admin-next',plan_month:'2026-11-01',items:[{source_id:'admin',name:'另一端不同事项'}]})];return true;};h.api.configure(h.options);
  assert.equal(await h.api.confirmNext(),true);assert.equal(h.storage.get(saved.key),saved.raw);assert.match(h.api.toolbarHtml(),/<strong>重要下月原稿<\/strong>/);
  const reopened=harness(undefined,h.storage);reopened.S.monthlyPlans=clone(h.S.monthlyPlans);reopened.api.select('next');assert.match(reopened.api.toolbarHtml(),/重要下月原稿/);assert.equal(h.storage.get(saved.key),saved.raw);
});
test('rejected next withdrawals restore the original raw bytes and rich draft for every explicit rejection',async()=>{
  for(const code of ['monthly_plan_in_use','monthly_plan_forbidden','invalid_monthly_plan','monthly_plan_changed']){
    const h=harness(()=>({error:{code,message:'拒绝撤回'}})),saved=retainedNext(h);h.sandbox.confirm=()=>true;
    h.S.monthlyPlans=[plan({id:'admin-next',plan_month:'2026-11-01',items:[{source_id:'admin',name:'另一端确认事项'}]})];
    assert.equal(await h.api.withdrawNext(),false,code);assert.equal(h.storage.get(saved.key),saved.raw,code);assert.match(h.api.toolbarHtml(),/<strong>重要下月原稿<\/strong>/);
  }
});
test('an unknown network response after next withdrawal preserves a new recovery draft when no original draft existed',async()=>{
  const h=harness(()=>({error:{message:'无法连接服务器，请检查网络后重试。'}}));h.sandbox.confirm=()=>true;
  const confirmed=plan({id:'withdraw-committed',plan_month:'2026-11-01',items:[{source_id:'recover-item',mod:'原模块',name:'网络丢响应的恢复事项',due:'2026-11-25'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'网络丢响应的恢复事项',attributes:{bold:true,color:'#d81e06'}}]}}}});
  h.S.monthlyPlans=[confirmed];h.api.select('next');assert.equal(h.storage.size,0);assert.equal(await h.api.withdrawNext(),false);assert.equal(h.storage.size,1);
  const raw=[...h.storage.values()][0];assert.equal(JSON.parse(raw).items[0].name,'网络丢响应的恢复事项');
  const reopened=harness(undefined,h.storage);reopened.api.select('next');assert.match(reopened.api.plannerHtml(),/网络丢响应的恢复事项/);assert.equal(reopened.api.binding('monthly_next_name_0').get().ops[0].attributes.bold,true);
});
test('a scoped current withdrawal stopped by form draft failure preserves original raw before any request',async()=>{
  const h=harness();vm.runInContext(fs.readFileSync(new URL('../web/report-scopes.js',import.meta.url),'utf8'),h.sandbox);h.sandbox.confirm=()=>true;
  h.S.projects[0].project_type='res';h.S.profile.discipline='工程';h.S.pmLine='工程';h.S.pmReportScope={id:'scope',anchor_project_id:'p1',project_ids:['p1'],reporting_mode:'professional'};
  h.api.plannerHtml();h.api.edit(0,'name','当前专业的原草稿');h.api.binding('monthly_next_name_0').set({ops:[{insert:'当前专业的原草稿',attributes:{bold:true}}]});h.api.saveDraft();
  const key=[...h.storage.keys()][0],raw=h.storage.get(key);h.S.monthlyPlans=[plan({line:'工程',report_scope_id:'scope',scope_project_ids:['p1']})];
  h.options.saveFormDraft=()=>false;h.api.configure(h.options);assert.equal(await h.api.withdrawCurrent(),false);
  assert.equal(h.calls.length,0);assert.equal(h.storage.get(key),raw);assert.match(h.api.toolbarHtml(),/<strong>当前专业的原草稿<\/strong>/);
});
test('successful withdrawal keeps retained original rich input as a copy while the confirmed plan becomes editable',async()=>{
  let confirmed;const h=harness(()=>({data:{withdrawn:true,plan:confirmed}})),saved=retainedNext(h);h.sandbox.confirm=()=>true;
  confirmed=plan({id:'admin-next',plan_month:'2026-11-01',items:[{source_id:'admin',name:'确认版恢复编辑事项'}]});h.S.monthlyPlans=[confirmed];
  h.options.saveFormDraft=()=>h.api.saveDraft();h.api.configure(h.options);assert.equal(await h.api.withdrawNext(),true);
  assert.equal(h.S.monthlyUnmatchedItems[0].name,'重要下月原稿');assert.equal(h.S.monthlyUnmatchedItems[0]._rich.name.ops[0].attributes.bold,true);
  assert.match(h.api.plannerHtml(),/确认版恢复编辑事项/);assert.match(h.api.toolbarHtml(),/<strong>重要下月原稿<\/strong>/);assert.ok(h.storage.has(saved.key));
});
test('only a successful response matching the submitted fixed content and rich formatting may clear the private draft',async()=>{
  const mismatched=harness(()=>({data:plan({plan_month:'2026-11-01',items:[{source_id:'different',name:'不是本次提交内容'}]})})),saved=retainedNext(mismatched);
  assert.equal(await mismatched.api.confirmNext(),true);assert.equal(mismatched.storage.get(saved.key),saved.raw);
  const ordered=harness((url,body)=>({data:plan({plan_month:body.month+'-01',items:body.items.map(item=>({due:item.due,name:item.name,mod:item.mod,source_id:item.source_id})),rich_text:body.rich_text})}));retainedNext(ordered);
  assert.equal(await ordered.api.confirmNext(),true);assert.equal(ordered.storage.size,0,'JSON object key ordering cannot prevent a matching own confirmation cleanup');
});
test('a successful own confirmation never clears a different same-account draft saved by another tab during the request',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>{finish=resolve;})),saved=retainedNext(h),pending=h.api.confirmNext(),body=h.calls[0].body;
  const newer=JSON.parse(saved.raw);newer.items[0].name='另一个标签新保存的稿';newer.items[0]._rich.name={ops:[{insert:'另一个标签新保存的稿',attributes:{bold:true,color:'#d81e06'}}]};newer.ts='2026-10-30T12:00:00Z';
  const newerRaw=JSON.stringify(newer);h.storage.set(saved.key,newerRaw);finish({data:plan({plan_month:body.month+'-01',items:clone(body.items),rich_text:body.rich_text})});
  assert.equal(await pending,true);assert.equal(h.storage.get(saved.key),newerRaw);assert.match(h.api.toolbarHtml(),/<strong>另一个标签新保存的稿<\/strong>/);assert.equal(h.api.saveDraft(),true);assert.equal(h.storage.get(saved.key),newerRaw);
});

test('month follows the selected week Monday, including weeks across a year boundary', () => {
  const h = harness();
  h.S.pmPeriod = '2027-01-01';
  assert.equal(h.api.month(), '2026-12');
  assert.match(h.api.toolbarHtml(), /准备下月 2027-01/);
  h.S.pmPeriod = '2027-01-04';
  assert.equal(h.api.month(), '2027-01');
  h.api.configure({ ...h.options, weekWindow: () => ({ start: '2028-12-25', end: '2028-12-31' }) });
  assert.equal(h.api.month(), '2028-12');
  assert.match(h.api.toolbarHtml(), /准备下月 2029-01/);
});

test('next month drafts survive navigation and render but cannot alter the current week or another project or line', () => {
  const h = harness();
  h.S.bizItems = [{ source_id: 'weekly-item', name: '本周事项', prog: '本周进展', blocker: '本周卡点' }];
  const before = clone(h.S.bizItems);
  fillNext(h); assert.match(h.api.plannerHtml(), /下月独立事项/);
  h.api.select('current'); h.api.select('next'); h.api.configure(h.options);
  assert.match(h.api.plannerHtml(), /下月独立事项/);
  h.S.pmProject = 'p2'; h.api.configure(h.options); h.api.select('next');
  assert.doesNotMatch(h.api.plannerHtml(), /下月独立事项/);
  h.api.edit(0, 'name', '项目二草稿');
  h.S.pmProject = 'p1'; h.api.configure(h.options);
  assert.match(h.api.plannerHtml(), /下月独立事项/);
  h.S.profile.biz_line = '*'; h.S.pmLine = '开发'; h.api.configure(h.options); h.api.select('next');
  assert.doesNotMatch(h.api.plannerHtml(), /下月独立事项|项目二草稿/);
  h.S.pmLine = '机电工程'; h.api.configure(h.options);
  assert.match(h.api.plannerHtml(), /下月独立事项/);
  assert.deepEqual(clone(h.S.bizItems), before);
});

test('capturing existing next inputs preserves edits, and stale DOM cannot seed another scope or session', () => {
  const h = harness(); fillNext(h);
  h.elements.monthly_next_name_0 = { value: '输入中的独立草稿' };
  h.api.capture(); assert.match(h.api.plannerHtml(), /输入中的独立草稿/);
  h.S.pmProject = 'p2'; h.api.configure(h.options); h.api.select('next');
  assert.doesNotMatch(h.api.plannerHtml(), /输入中的独立草稿/);
  h.S.pmProject = 'p1'; h.api.configure(h.options);
  assert.match(h.api.plannerHtml(), /输入中的独立草稿/);
  h.S.session = {}; h.api.configure(h.options); h.api.select('next');
  assert.doesNotMatch(h.api.plannerHtml(), /输入中的独立草稿/);
  h.api.edit(0, 'name', '新会话草稿');
  h.S.uid = 'new-owner'; h.api.configure(h.options); h.api.select('next');
  assert.doesNotMatch(h.api.plannerHtml(), /新会话草稿/);
});

test('confirming next month publishes only its fixed columns without writing or switching the weekly report', async () => {
  const h = harness();
  h.S.bizItems = [{ source_id: 'current', mod: '本周', name: '本周事项', prog: '进展', blocker: '卡点' }];
  const before = clone({ items: h.S.bizItems, period: h.S.pmPeriod });
  fillNext(h);
  assert.equal(await h.api.confirmNext(), true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { url: '/api/monthly-plans/confirm', body: {
    project_id: 'p1', line: '机电工程', month: '2026-11',
    items: [{ source_id: 'generated-1', mod: '下月模块', name: '下月独立事项', due: '2026-11-25' }],
    rich_text: { v: 1, fields: {} } } });
  assert.deepEqual(clone({ items: h.S.bizItems, period: h.S.pmPeriod }), before);
  assert.equal(h.api.locked(), false);
  assert.match(h.api.plannerHtml(), /已确认，固定列不可修改/);
  assert.doesNotMatch(h.api.plannerHtml(), /monthly_next_name_|确认下月计划/);
});

test('confirming this month preserves name formatting and weekly feedback, then blocks another confirmation', async () => {
  const h = harness();
  h.S.bizItems = [{ mod: '模块', name: '富文本事项', due: '2026-10-30', prog: '进展', blocker: '卡点',
    _rich: { name: { ops: [{ insert: '富文本事项', attributes: { bold: true } }] }, prog: { ops: [{ insert: '进展', attributes: { bold: true } }] } } }];
  assert.equal(await h.api.confirmCurrent(), true);
  const body = h.calls[0].body;
  assert.equal(body.month, '2026-10');
  assert.deepEqual(body.rich_text, { v: 1, fields: { 'items.0.name': { ops: [{ insert: '富文本事项', attributes: { bold: true } }] } } });
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['due', 'mod', 'name', 'source_id']);
  assert.equal(h.S.bizItems[0].prog, '进展'); assert.equal(h.S.bizItems[0].blocker, '卡点');
  assert.equal(h.S.bizItems[0]._rich.name.ops[0].attributes.bold, true);
  assert.equal(await h.api.confirmCurrent(), false); assert.equal(h.calls.length, 1);
});

test('duplicate clicks are blocked, a failed confirmation keeps the draft, and render never retries a request', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; })); fillNext(h);
  const pending = h.api.confirmNext();
  assert.equal(await h.api.confirmNext(), false);
  assert.equal(h.calls.length, 1);
  assert.match(h.api.plannerHtml(), /确认中…/);
  finish({ data: null, error: { message: '月计划已由另一填报人确认，请刷新核对。' } });
  assert.equal(await pending, false);
  assert.match(h.api.plannerHtml(), /下月独立事项/);
  assert.match(h.messages[0][0], /另一填报人/);
  h.api.toolbarHtml(); h.api.plannerHtml(); h.api.previousHtml();
  assert.equal(h.calls.length, 1);
});

test('late confirmation responses do not mutate another project, line, week, account or session', async () => {
  for (const change of [S => { S.pmProject = 'p2'; }, S => { S.pmLine = '开发'; }, S => { S.pmPeriod = '2026-10-26'; },
    S => { S.uid = 'new-owner'; }, S => { S.session = {}; }]) {
    let finish;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    h.S.bizItems = [{ source_id: 'item', name: '待确认事项' }];
    const pending = h.api.confirmCurrent();
    change(h.S); h.api.configure(h.options);
    finish({ data: plan(), error: null });
    assert.equal(await pending, false);
    assert.deepEqual(clone(h.S.monthlyPlans), []);
    assert.equal(h.S.bizItems[0].name, '待确认事项');
    assert.deepEqual(h.messages, []);
  }
});

test('previous confirmed plan uses reviewed completion state and the latest matching weekly feedback, never progress wording', () => {
  const h = harness();
  const previous = plan({ id: 'sept-plan', plan_month: '2026-09-01', confirmed_by: 'original-owner', items: [
    { source_id: 'approved', mod: '模块', name: '有效事项', due: '2026-09-20' },
    { source_id: 'pending', name: '申请事项', due: '2026-09-21' },
    { source_id: 'none', name: '未申请事项', due: '2026-09-22' },
    { source_id: 'changed', name: '来源变更事项', due: '2026-09-23' }] });
  h.S.monthlyPlans = [previous];
  h.S.reports = [
    report('old', '2026-09-07', { source_id: 'none', name: '未申请事项', prog: '旧反馈', blocker: '旧卡点' }, { updated_at: '2026-10-20', biz: {
      monthly_plan_id: 'sept-plan', items: [{ source_id: 'none', name: '未申请事项', prog: '旧反馈', blocker: '旧卡点' }] } }),
    report('new', '2026-09-21', null, { biz: { monthly_plan_id: 'sept-plan', items: [
      { source_id: 'none', name: '未申请事项', prog: '已完成，文字不能销项', blocker: '最近卡点' }] } }),
    report('wrong', '2026-10-12', null, { biz: { monthly_plan_id: 'another-plan', items: [
      { source_id: 'none', name: '未申请事项', prog: '错误计划的进展' }] } })];
  const key = item => 'monthly:p1:sept-plan:' + item;
  h.completionRows.set(key('approved') + ':original-owner', { status: 'approved', effective_status: 'approved', completion_date: '2026-09-19', completion_category: 'on_time' });
  h.completionRows.set(key('pending') + ':original-owner', { status: 'pending', effective_status: 'pending' });
  h.completionRows.set(key('changed') + ':original-owner', { status: 'approved', effective_status: 'source_changed', source_changed: true });
  const html = h.api.previousHtml();
  assert.match(html, /2026-09 上月计划完成情况/);
  assert.equal((html.match(/已审核完成/g) || []).length, 1);
  assert.match(html, /实际完成：2026-09-19 · 按时完成/);
  assert.match(html, /申报中/); assert.match(html, /原确认人的审核状态当前不可读/); assert.match(html, /来源变化，待核对/);
  assert.doesNotMatch(html, /未申报/);
  assert.match(html, /已完成，文字不能销项/); assert.match(html, /最近卡点/);
  assert.doesNotMatch(html, /旧反馈|旧卡点|错误计划的进展/);
  assert.ok(h.completionCalls.every(call => call.owner === 'original-owner'));
  assert.ok(h.actionCalls.every(call => call.owner_id === 'original-owner' && call.readOnly === true));
  assert.equal(h.actionCalls.some(call => call.key === key('none')), false, 'unreadable original-owner requests must not have an unusable action');
});

test('previous month follows the selected preparation month and historical fallback keeps original source identities', () => {
  const h = harness();
  h.S.reports = [
    report('oct-a', '2026-10-05', { source_id: 'legacy-a', name: '同名事项', prog: '已完成' }),
    report('oct-b', '2026-10-12', { source_id: 'legacy-b', name: '同名事项', prog: '推进中', blocker: '待审批' }),
    report('nov', '2026-11-02', { source_id: 'nov', name: '不应出现的十一月事项' }),
    report('other-line', '2026-10-12', { source_id: 'other', name: '其他模块事项' }, { line: '开发' }),
    report('other-project', '2026-10-12', { source_id: 'other', name: '其他项目事项' }, { project_id: 'p2' })];
  h.api.select('next');
  const key = 'plan:p1:oct-b:items:legacy-b';
  h.completionRows.set(key + ':owner', { status: 'approved', effective_status: 'approved' });
  const html = h.api.previousHtml();
  assert.match(html, /2026-10 上月计划完成情况/);
  assert.match(html, /历史周报汇总，未单独确认月计划/);
  assert.equal((html.match(/同名事项/g) || []).length, 2);
  assert.match(html, /plan:p1:oct-a:items:legacy-a/); assert.match(html, /plan:p1:oct-b:items:legacy-b/);
  assert.equal((html.match(/已审核完成/g) || []).length, 1);
  assert.match(html, /实际完成：未记录 · 无法判定/);
  assert.match(html, /未申报/);
  assert.doesNotMatch(html, /不应出现|其他模块|其他项目/);
  assert.equal(h.calls.length, 0);
});

test('incomplete and unauthorized confirmation attempts cannot publish or silently drop partially entered rows', async () => {
  const h = harness(); h.S.bizItems = [{ mod: '仅写模块' }];
  assert.equal(await h.api.confirmCurrent(), false); assert.equal(h.calls.length, 0);
  assert.match(h.messages[0][0], /第1项的事项/);
  h.S.bizItems = [{ name: '可确认事项' }]; h.S.profile.biz_line = '开发';
  assert.equal(await h.api.confirmCurrent(), false); assert.equal(h.calls.length, 0);
  h.S.profile.biz_line = '机电工程'; h.S.profile.role = 'ops';
  assert.equal(await h.api.confirmCurrent(), false); assert.equal(h.calls.length, 0);
  h.S.projects[0].project_type = 'res';
  assert.equal(h.api.toolbarHtml(), ''); assert.equal(h.api.previousHtml(), '');
});

test('already confirmed conflicts reload the immutable plan instead of leaving an editable or repeatedly posted draft', async () => {
  const h = harness(() => ({ data: null, error: { code: 'monthly_plan_confirmed', message: '该月已经确认' } }));
  let reads = 0, readable = false;
  h.options.loadData = async (keys, force) => {
    reads++; assert.deepEqual(clone(keys), ['monthlyPlans', 'completions']); assert.equal(force, true);
    if (readable) h.S.monthlyPlans = [plan()];
    return readable;
  };
  h.api.configure(h.options);
  h.S.bizItems = [{ source_id: 'fixed-item', name: '本地未确认输入', prog: '本周反馈' }];
  assert.equal(await h.api.confirmCurrent(), false);
  assert.equal(h.api.locked(), true); assert.equal(h.api.needsRefresh(), true);
  assert.equal(h.S.bizItems[0].name, '本地未确认输入');
  assert.match(h.api.toolbarHtml(), /重新读取本月确认版/);
  assert.equal(await h.api.confirmCurrent(), false);
  assert.equal(h.calls.length, 1); assert.equal(reads, 2);
  readable = true;
  assert.equal(await h.api.confirmCurrent(), true);
  assert.equal(h.calls.length, 1); assert.equal(reads, 3);
  assert.equal(h.api.needsRefresh(), false);
  assert.equal(h.S.bizItems[0].name, '固定事项'); assert.equal(h.S.bizItems[0].prog, '本周反馈');
});

test('successful confirmation reloads dependent data while retaining its authoritative baseline if refresh fails', async () => {
  const h = harness();
  let reads = 0;
  h.options.loadData = async (keys, force) => { reads++; assert.deepEqual(clone(keys), ['monthlyPlans', 'completions']); assert.equal(force, true); throw new Error('匿名刷新故障'); };
  h.api.configure(h.options); h.S.bizItems = [{ source_id: 'fixed-item', name: '当前确认事项', prog: '当周进展' }];
  assert.equal(await h.api.confirmCurrent(), true);
  assert.equal(reads, 1); assert.equal(h.api.locked(), true); assert.equal(h.S.bizItems[0].prog, '当周进展');
  assert.match(h.messages[0][0], /已确认/);
});

test('feedback typed while confirmation or dependent refresh is pending survives the final render', async () => {
  let finishConfirm, finishRefresh, currentInput = '最初进展';
  const h = harness(() => new Promise(resolve => { finishConfirm = resolve; }));
  h.S.bizItems = [{ source_id: 'fixed-item', name: '事项', prog: currentInput }];
  h.options.flush = () => { h.S.bizItems[0].prog = currentInput; };
  h.options.loadData = () => new Promise(resolve => { finishRefresh = resolve; });
  h.api.configure(h.options);
  const pending = h.api.confirmCurrent();
  currentInput = '确认请求期间输入';
  finishConfirm({ data: plan(), error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.S.bizItems[0].prog, '确认请求期间输入');
  currentInput = '刷新期间继续输入';
  finishRefresh(true);
  assert.equal(await pending, true);
  assert.equal(h.S.bizItems[0].prog, '刷新期间继续输入');
});

test('a later confirmed plan cannot replace an existing unbound weekly snapshot or bind its resubmission', () => {
  const h = harness();
  h.S.pmReport = report('legacy-report', '2026-10-12', { source_id: 'legacy-item', mod: '旧模块', name: '原周报事项', due: '2026-10-20', prog: '原进展' });
  h.S.pmReport.rich_text = { v: 1, fields: { 'biz.items.0.name': { ops: [{ insert: '原周报事项', attributes: { bold: true } }] } } };
  const original = clone(h.S.pmReport);
  h.S.monthlyPlans = [plan()];
  h.S.bizItems = [{ source_id: 'legacy-item', mod: '草稿改模块', name: '草稿改事项', due: '2030-01-01', prog: '本次反馈', blocker: '本次卡点' }];
  h.api.prepare();
  assert.equal(h.api.locked(), true);
  assert.deepEqual(clone(h.api.metadata()), {});
  assert.equal(h.S.bizItems[0].mod, '旧模块'); assert.equal(h.S.bizItems[0].name, '原周报事项'); assert.equal(h.S.bizItems[0].due, '2026-10-20');
  assert.equal(h.S.bizItems[0].prog, '本次反馈'); assert.equal(h.S.bizItems[0].blocker, '本次卡点');
  assert.equal(h.S.bizItems[0]._rich.name.ops[0].attributes.bold, true);
  assert.match(h.api.toolbarHtml(), /既有周报快照，计划列保持原样/);
  assert.match(h.api.actionHtml(h.S.bizItems[0]), /plan:p1:legacy-report:items:legacy-item/);
  assert.deepEqual(clone(h.S.pmReport), original);
  h.S.pmReport = null; h.S.pmPeriod = '2026-10-26'; h.S.bizItems = [];
  h.api.prepare();
  assert.equal(h.S.bizItems[0].name, '固定事项');
  assert.deepEqual(clone(h.api.metadata()), { monthly_plan_id: 'confirmed-plan', monthly_plan_month: '2026-10' });
});

test('confirming the edited current plan leaves its already submitted historical report unbound and unchanged', async () => {
  const h = harness();
  h.S.pmReport = report('legacy-report', '2026-10-12', { source_id: 'legacy-item', mod: '旧模块', name: '原周报事项', due: '2026-10-20', prog: '原进展' });
  h.S.bizItems = [{ source_id: 'legacy-item', mod: '新模块', name: '待确认月度事项', due: '2026-10-30', prog: '本周新反馈', blocker: '本周卡点' }];
  const original = clone(h.S.pmReport);
  assert.equal(await h.api.confirmCurrent(), true);
  assert.equal(h.S.monthlyPlans[0].items[0].name, '待确认月度事项');
  assert.equal(h.S.bizItems[0].name, '原周报事项');
  assert.equal(h.S.bizItems[0].prog, '本周新反馈');
  assert.deepEqual(clone(h.api.metadata()), {});
  assert.deepEqual(clone(h.S.pmReport), original);
});

test('unmatched original draft rows and formatting remain visible and deduplicated after baseline application', () => {
  const h = harness(); h.S.monthlyPlans = [plan()];
  const unmatched = { source_id: 'orphan', mod: '旧草稿模块', name: '未匹配事项', due: '2026-10-22', prog: '不能丢的进展', blocker: '不能丢的卡点',
    _rich: { name: { ops: [{ insert: '未匹配事项', attributes: { bold: true } }] } } };
  h.S.bizItems = [clone(unmatched), { source_id: 'fixed-item', name: '原固定项', prog: '已匹配反馈' }, {}];
  h.api.prepare(); assert.equal(h.S.monthlyUnmatchedItems.length, 1);
  assert.deepEqual(clone(h.S.monthlyUnmatchedItems[0]), unmatched);
  assert.equal(h.S.bizItems[0].prog, '已匹配反馈');
  assert.match(h.api.toolbarHtml(), /未匹配的原草稿，已保留供核对/);
  assert.match(h.api.toolbarHtml(), /<strong>未匹配事项<\/strong>/);
  assert.match(h.api.toolbarHtml(), /不能丢的进展|不能丢的卡点/);
  h.S.bizItems.push(clone(unmatched)); h.api.apply(); h.api.apply();
  assert.equal(h.S.monthlyUnmatchedItems.length, 1);
});

test('saved next-month drafts survive a fresh module and remain isolated by account, project, line and target month', () => {
  const storage = new Map(), first = harness(undefined, storage);
  fillNext(first, '刷新后应恢复的下月事项');
  assert.equal(first.api.saveDraft(), true);
  assert.equal(storage.size, 1);
  const second = harness(undefined, storage);
  second.api.select('next');
  assert.match(second.api.plannerHtml(), /刷新后应恢复的下月事项/);
  second.S.pmProject = 'p2'; second.api.configure(second.options); second.api.select('next');
  assert.doesNotMatch(second.api.plannerHtml(), /刷新后应恢复的下月事项/);
  second.S.pmProject = 'p1'; second.S.profile.biz_line = '*'; second.S.pmLine = '开发'; second.api.configure(second.options); second.api.select('next');
  assert.doesNotMatch(second.api.plannerHtml(), /刷新后应恢复的下月事项/);
  second.S.pmLine = '机电工程'; second.S.pmPeriod = '2026-11-02'; second.api.configure(second.options); second.api.select('next');
  assert.doesNotMatch(second.api.plannerHtml(), /刷新后应恢复的下月事项/);
  const other = harness(undefined, storage); other.S.uid = 'another-owner'; other.api.configure(other.options); other.api.select('next');
  assert.doesNotMatch(other.api.plannerHtml(), /刷新后应恢复的下月事项/);
  const relogged = harness(undefined, storage); relogged.S.session = {}; relogged.api.configure(relogged.options); relogged.api.select('next');
  assert.match(relogged.api.plannerHtml(), /刷新后应恢复的下月事项/);
});

test('failed confirmation keeps the saved next draft, while successful confirmation deletes it from storage', async () => {
  const storage = new Map(), failure = harness(() => ({ error: { message: '匿名保存故障' } }), storage);
  fillNext(failure, '失败后保留事项'); assert.equal(failure.api.saveDraft(), true);
  assert.equal(await failure.api.confirmNext(), false);
  const reloaded = harness(undefined, storage); reloaded.api.select('next');
  assert.match(reloaded.api.plannerHtml(), /失败后保留事项/);
  assert.equal(await reloaded.api.confirmNext(), true);
  assert.equal(storage.size, 0);
  assert.equal(reloaded.api.saveDraft(), true);
  assert.equal(storage.size, 0);
});

test('storage failures return a clear save failure and never report a persisted draft or overwrite unreadable original data', () => {
  const h = harness(); fillNext(h);
  h.sandbox.localStorage.setItem = () => { throw new Error('匿名存储不可用'); };
  assert.equal(h.api.saveDraft(), false); assert.match(h.api.draftError(), /匿名存储不可用/);
  assert.match(h.api.plannerHtml(), /下月独立事项/);
  const bad = harness();
  bad.sandbox.localStorage.getItem = () => { throw new Error('读取被阻止'); };
  bad.api.select('next');
  assert.match(bad.api.plannerHtml(), /下月本机草稿读取失败/);
  bad.api.edit(0, 'name', '仅在当前页面的新输入');
  assert.equal(bad.api.saveDraft(), false);
  assert.match(bad.api.draftError(), /读取失败/);
  assert.equal(bad.storage.size, 0);
});

test('saving with no next draft is a no-op and does not create an empty persisted plan', () => {
  const h = harness();
  assert.equal(h.api.saveDraft(), true);
  assert.equal(h.storage.size, 0);
  assert.deepEqual(h.calls, []);
});

function monthlyAI(h, month='2026-10') {
  h.S.profile.status='approved'; h.options.saveFormDraft=()=>true;h.api.configure(h.options);
  return {context:{monthly_plans:h.api.aiContext()},candidate:{month,items:[{mod:'景观 / 一标段',name:'原始基准点移交、基层标高复核完成',due:'2026-11-15',progress:'9月30日启动',sources:['匿名景观.xlsx · 景观!D3']}]}};
}
test('reading AI month capabilities does not create empty stored drafts; scoped monthly additions stay outside weekly feedback',()=>{
  const h=harness();monthlyAI(h);assert.equal(h.api.saveDraft(),true);assert.equal(h.storage.size,0);
  vm.runInContext(fs.readFileSync(new URL('../web/report-scopes.js',import.meta.url),'utf8'),h.sandbox);
  h.S.projects[0].project_type='res';h.S.profile.discipline='工程';h.S.pmLine='工程';h.S.pmReportScope={id:'scope',anchor_project_id:'p1',project_ids:['p1'],reporting_mode:'professional'};
  h.S.bizItems=[{mod:'旧反馈',name:'本周保留文字',due:'',prog:'已填进展'}];const week=clone(h.S.bizItems),f=monthlyAI(h),result=h.api.aiApply(f.context,f.candidate);
  assert.deepEqual(clone(h.S.bizItems),week);assert.match(h.api.plannerHtml(),/原始基准点移交/);assert.equal(h.calls.length,0);
  h.api.aiUndo(result.transaction);assert.deepEqual(clone(h.S.bizItems),week);assert.equal(h.storage.size,0);
});
test('AI new month plans append to the unconfirmed local form, preserve original rich rows and can undo without confirming',()=>{
  const h=harness();h.S.bizItems=[{mod:'原模块',name:'本人原事项',due:'2026-10-30',prog:'原进展',_rich:{name:{ops:[{insert:'本人原事项',attributes:{bold:true}}]}}}];
  const before=clone(h.S.bizItems),f=monthlyAI(h),result=h.api.aiApply(f.context,f.candidate);
  assert.equal(result.count,1);assert.match(result.message,/尚未确认月计划或提交周报/);assert.deepEqual(clone(h.S.bizItems[0]),before[0]);
  assert.equal(h.S.bizItems[1].due,'2026-11-15','cross-month original deadline is preserved');assert.equal(h.S.bizItems[1].prog,'9月30日启动');assert.deepEqual(h.calls,[]);
  h.api.aiUndo(result.transaction);assert.deepEqual(clone(h.S.bizItems),before);assert.deepEqual(h.calls,[]);
});
test('AI next month proposal uses the existing separate month draft and preserves the current week',()=>{
  const h=harness();h.S.bizItems=[{name:'当前周输入',mod:'原模块',due:'',prog:'本人进展'}];const before=clone(h.S.bizItems),f=monthlyAI(h,'2026-11');
  const result=h.api.aiApply(f.context,f.candidate);assert.deepEqual(clone(h.S.bizItems),before);assert.match(h.api.plannerHtml(),/原始基准点移交/);
  const stored=Array.from(h.storage.entries()).find(([key])=>key.startsWith('zh_monthly_plan_draft_v1_'));assert.ok(stored);assert.equal(JSON.parse(stored[1]).items.filter(row=>row.name).length,1);
  assert.deepEqual(h.calls,[]);h.api.aiUndo(result.transaction);assert.equal(h.storage.size,0);assert.deepEqual(clone(h.S.bizItems),before);
});
test('AI new month suggestions reject changed rows, another tab, confirmed plans, other months and invalid dates before any write',()=>{
  const mutations=[h=>h.S.bizItems.push({mod:'手填',name:'新增原文',due:''}),h=>h.S.monthlyPlans.push(plan()),h=>h.S.pmProject='p2',h=>h.S.profile.status='pending'];
  for(const change of mutations){const h=harness(),f=monthlyAI(h);change(h);const before=clone(h.S.bizItems);assert.throws(()=>h.api.aiApply(f.context,f.candidate));assert.deepEqual(clone(h.S.bizItems),before);assert.deepEqual(h.calls,[]);}
  const h=harness(),f=monthlyAI(h,'2026-11'),key=Array.from(h.api.aiContext()).find(p=>p.month==='2026-11');assert.ok(key);
  const another=JSON.stringify({v:1,scope:['owner','p1','机电工程','2026-11'],items:[{mod:'另窗',name:'其他窗口输入',due:''}]});
  h.storage.set('zh_monthly_plan_draft_v1_'+encodeURIComponent(JSON.stringify(['owner','p1','机电工程','2026-11'])),another);assert.throws(()=>h.api.aiApply(f.context,f.candidate),/已修改/);assert.equal(Array.from(h.storage.values())[0],another);
  for(const candidate of [{month:'2026-12',items:f.candidate.items},{month:'2026-11',items:[{...f.candidate.items[0],due:'2026-02-30'}]}]){
    const t=harness(),request=monthlyAI(t,'2026-11');assert.throws(()=>t.api.aiApply(request.context,candidate));assert.equal(t.storage.size,0);
  }
});
test('AI month drafts roll back failed storage, avoid duplicate additions and refuse undo after later edits or confirmation',()=>{
  const h=harness(),f=monthlyAI(h);h.options.saveFormDraft=()=>false;h.api.configure(h.options);assert.throws(()=>h.api.aiApply(f.context,f.candidate),/保存失败/);assert.deepEqual(clone(h.S.bizItems),[]);
  const next=harness(),request=monthlyAI(next,'2026-11'),set=next.sandbox.localStorage.setItem;next.sandbox.localStorage.setItem=()=>{throw new Error('full');};
  assert.throws(()=>next.api.aiApply(request.context,request.candidate),/保存失败/);assert.equal(next.storage.size,0);next.sandbox.localStorage.setItem=set;
  const result=next.api.aiApply({monthly_plans:next.api.aiContext()},request.candidate);const again=next.api.aiApply({monthly_plans:next.api.aiContext()},request.candidate);assert.equal(again.count,0);
  next.api.edit(0,'name','后来手改');next.api.plannerHtml();next.api.edit(0,'name','后来手改');assert.throws(()=>next.api.aiUndo(result.transaction),/后续修改/);
  const locked=harness(),action=monthlyAI(locked),done=locked.api.aiApply(action.context,action.candidate);locked.S.monthlyPlans.push(plan());assert.throws(()=>locked.api.aiUndo(done.transaction),/已确认/);
});
