import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const web = new URL('../web/', import.meta.url);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scope = {id:'res-scope',name:'统一住宅',anchor_project_id:'p1',project_ids:['p1','p2','p3'],effective_week:'2026-10-19',period_week:'2026-10-19',active_for_period:true,blocked_by_legacy:false,blocked_weeks:[]};
const projects = ['p1','p2','p3'].map((id,i) => ({id,name:'实际项目'+i,active:true,project_type:'res',sort_order:i,display_group:i === 1 ? '不同展示名称' : '原展示组'}));
function harness() {
  const sandbox = {}; sandbox.window = sandbox; vm.createContext(sandbox);
  for (const name of ['planning-windows.js','report-scopes.js','admin-plan-overview.js']) vm.runInContext(readFileSync(new URL(name, web),'utf8'), sandbox);
  return sandbox;
}
function plain(value) {return JSON.parse(JSON.stringify(value));}
test('统一填报入口只出现一次并保留锚点真实元数据，全部成员原授权缺一不可', () => {
  const h = harness(), before = structuredClone(projects);
  const result = plain(h.ReportScopes.projects(projects,[scope],'2026-10-19',null,[]));
  assert.equal(result.length,1); assert.equal(result[0].id,'p1'); assert.equal(result[0].name,'统一住宅');
  assert.equal(result[0].project_type,'res'); assert.equal(result[0].active,true);
  assert.deepEqual(result[0].scope_project_ids,['p1','p2','p3']);
  assert.equal(h.ReportScopes.forProject([scope],'p2','2026-10-19',null,projects.slice(0,2),[]),null);
  assert.deepEqual(projects,before);
});
test('生效前保留普通入口，同周任一旧报告或服务端阻塞周使整周保留旧入口', () => {
  const h = harness();
  assert.equal(h.ReportScopes.forProject([scope],'p1','2026-10-12',null,projects,[]),null);
  const old = {id:1,project_id:'p3',period:'2026-10-19',submitted_at:'2026-10-20T00:00:00Z'};
  assert.equal(h.ReportScopes.forProject([scope],'p1','2026-10-19',null,projects,[old]),null);
  assert.equal(h.ReportScopes.projects(projects,[scope],'2026-10-19',null,[old]).length,3);
  assert.equal(h.ReportScopes.forProject([{...scope,blocked_weeks:['2026-10-26']}],'p2','2026-10-26',null,projects,[]),null);
  assert.equal(h.ReportScopes.forProject([scope],'p2','2026-10-26',null,projects,[old]).id,scope.id);
});
test('组报告按范围与规范周期查找，历史保留成员原报及原来源，不按名字拼接', () => {
  const h = harness(), reports = [{id:1,project_id:'p1',period:'2026-10-12',author_id:'original',biz:{nodes:[{source_id:'old-node'}]}},
    {id:2,project_id:'p1',period:'2026-10-19',report_scope_id:scope.id,scope_project_ids:scope.project_ids,biz:{items:[{source_id:'group-item'}]}},
    {id:3,project_id:'p3',period:'2026-10-05'}, {id:4,project_id:'other',period:'2026-10-19',name:scope.name}];
  const before = structuredClone(reports);
  assert.equal(h.ReportScopes.findReport(reports,scope,'第43周（10.19-10.25）').id,2);
  assert.deepEqual(plain(h.ReportScopes.history(reports,scope,'p1')).map(r=>r.id),[1,2,3]);
  assert.equal(h.ReportScopes.matchesProject(reports[1],'p3'),true);
  assert.equal(h.ReportScopes.matchesProject(reports[0],'p3'),false);
  assert.deepEqual(reports,before);
});
test('组草稿按稳定范围及完整周标识隔离，旧三地块草稿含过期和损坏稿只读保留', () => {
  const h = harness(), entries = new Map([
    ['zh_draft_user_p1_43',JSON.stringify({ts:1,bizItems:[{source_id:'old1',name:'原草稿'}]})],
    ['zh_draft_user_p2_43','{broken'],['zh_draft_user_p3_43',JSON.stringify({ts:2,richFields:{original:'keep'}})]
  ]), before = [...entries.entries()], storage = {getItem:key=>entries.get(key)??null,removeItem(){throw Error('不可删除');},setItem(){throw Error('不可写');}};
  const a = h.ReportScopes.draftKey('user',scope,'2026-10-19');
  assert.equal(a,h.ReportScopes.draftKey('user',scope,'第43周（10.19-10.25）','2026-10-22'));
  assert.notEqual(a,h.ReportScopes.draftKey('user',scope,'2027-10-25'));
  const drafts = plain(h.ReportScopes.legacyDrafts(storage,'user',scope,'2026-10-19',43));
  assert.equal(drafts.length,3); assert.equal(drafts[0].draft.bizItems[0].source_id,'old1'); assert.ok(drafts[1].error);
  assert.deepEqual([...entries.entries()],before);
});

test('专业合并入口仅只读列出本人本专业成员项目的本月下月旧月草稿，原富文本与raw不变且不混入新scope草稿', () => {
  const h=harness();vm.runInContext(readFileSync(new URL('rich-text.js',web),'utf8'),h);
  const selected={...scope,reporting_mode:'professional',project_ids:['p1','p2']}, uid='month-draft-owner',line='工程';
  const key=identity=>'zh_monthly_plan_draft_v1_'+encodeURIComponent(JSON.stringify(identity)),entries=new Map(),reads=[];
  for(const pid of selected.project_ids)for(const month of ['2026-10','2026-11']) {
    const title='原'+pid+'-'+month+'月事项',module='原模块';
    const identity=[uid,pid,line,month];
    entries.set(key(identity),JSON.stringify({v:1,scope:identity,ts:'2026-10-29T10:00:00Z',items:[{mod:module,name:title,due:month+'-28',
      _rich:{mod:{ops:[{insert:module,attributes:{color:'#d81e06'}}]},name:{ops:[{insert:title,attributes:{bold:true}}]}}}]}));
  }
  for(const identity of [[uid,'p1','设计','2026-11'],['another-account','p1',line,'2026-11'],[uid,'outside',line,'2026-11'],
    [uid,'p1',line,'2026-12'],[uid,'p1',line,'2026-11',selected.id,JSON.stringify(['p1','p2'])]])
    entries.set(key(identity),JSON.stringify({v:1,scope:identity,items:[{mod:'不应读取',name:'不可混入的新scope或其他范围草稿',due:''}]}));
  const before=[...entries.entries()],storage={getItem:k=>{reads.push(k);return entries.get(k)??null;},setItem(){throw Error('只读不得写入');},removeItem(){throw Error('只读不得删除');}};
  const rows=plain(h.ReportScopes.legacyDrafts(storage,uid,selected,'2026-10-12',42,line));
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(row=>[row.project_id,row.plan_month,row.line]),[['p1','2026-10',line],['p1','2026-11',line],['p2','2026-10',line],['p2','2026-11',line]]);
  for(const row of rows) {
    assert.equal(row.raw,entries.get(row.key));assert.equal(row.draft.bizItems[0]._rich.name.ops[0].attributes.bold,true);
    const html=h.ReportScopes.legacyDraftHtml(row,{esc,richItem:h.ZHRichText.field,projectName:'原项目-'+row.project_id+' · '+row.plan_month+' '+row.line+' 月计划'});
    assert.match(html,new RegExp('原项目-'+row.project_id+' · '+row.plan_month+' 工程 月计划'));
    assert.match(html,/<span class="rt-red">原模块<\/span>/);assert.match(html,/<strong>原p[12]-2026-(10|11)月事项<\/strong>/);
    assert.match(html,new RegExp(row.plan_month+' 原月计划事项'));assert.match(html,/<textarea readonly/);
    assert.doesNotMatch(html,/oninput=|contenteditable|MonthlyPlans\.edit|不可混入/);
  }
  const monthlyReads=reads.filter(k=>k.startsWith('zh_monthly_plan_draft_v1_'));
  assert.deepEqual(monthlyReads,rows.map(row=>row.key));assert.equal(monthlyReads.length,4,'不遍历storage或读取其他账号／专业／月份的新key');
  assert.deepEqual([...entries.entries()],before);
});
test('管理汇总按稳定范围合组，不受三个项目不同展示名称影响', () => {
  const h = harness(), groups = plain(h.ReportScopes.groupProjects(projects,[scope],'2026-10-19',null,[]));
  assert.equal(groups.length,1); assert.equal(groups[0].report_scope_id,scope.id); assert.equal(groups[0].projects.length,3);
});
test('旧稿核对展示原富文本和业务表格，保留原始备份与原附件授权入口且不迁移数据', () => {
  const h = harness(); vm.runInContext(readFileSync(new URL('rich-text.js', web),'utf8'),h);
  const draft = {ts:1,bizNodes:[{project_id:'p2',milestone_id:17,source_id:'original-node',name:'原节点',plan:'2026-10-22',prog:''}],
    bizItems:[{source_id:'original-item',name:'原事项',prog:'红色进展',blocker:'原卡点',_rich:{prog:{ops:[{insert:'红色进展',attributes:{bold:true,color:'#d81e06'}}]}}}],
    change:'变化说明',richFields:{change_text:{ops:[{insert:'变化说明',attributes:{bold:true}}]}},
    followupRows:[{source_key:'meeting:p2:original',title:'会议要求',what:'原会议正文',progress:'原会议反馈'}],
    attachmentIds:['10000000-0000-4000-8000-000000000001','javascript:alert(1)'],next:['下周事项']};
  const row = {project_id:'p2',ts:1,draft,raw:JSON.stringify(draft)}, before = JSON.stringify(row);
  const html = h.ReportScopes.legacyDraftHtml(row,{esc,richItem:h.ZHRichText.field,projectName:'原实际项目'});
  assert.match(html,/原实际项目 · 本机草稿（未提交，只读核对）/); assert.match(html,/<span class="rt-red"><strong>红色进展<\/strong><\/span>/);
  assert.match(html,/<strong>变化说明<\/strong>/); assert.match(html,/原节点/); assert.match(html,/原会议反馈/); assert.match(html,/下周事项/);
  assert.match(html,/href="\/api\/report-attachments\/10000000-0000-4000-8000-000000000001"/);
  assert.doesNotMatch(html,/href="javascript:|data-rich|onclick=/);
  assert.match(html,/<textarea readonly/); assert.match(html,/original-item/); assert.equal(JSON.stringify(row),before);
});
test('损坏及不完整旧稿仍可核对原始备份，文本不能注入HTML或附件地址', () => {
  const h = harness(), raw = '</textarea><script>alert(1)</script>';
  const bad = h.ReportScopes.legacyDraftHtml({project_id:'p2',draft:null,raw},{esc});
  assert.match(bad,/原稿格式无法识别/); assert.doesNotMatch(bad,/<script>/); assert.match(bad,/&lt;script&gt;/);
  assert.doesNotThrow(()=>h.ReportScopes.legacyDraftHtml({project_id:'p2',draft:{next:'损坏的列表'},raw:'{}'},{esc}));
});
function configure(h, S) {
  const calls = [];
  const table = kind => rows => '<table data-kind="'+kind+'"><tbody>'+rows.map(r=>'<tr><td>'+esc(r.biz?.items?.[0]?.name || '')+'</td></tr>').join('')+'</tbody></table>';
  h.AdminPlanOverview.configure({S,esc,disciplines:['工程'],currentPeriod:()=> '2026-10-19',
    residentialGroups:(pid,rows)=>({'工程':rows}),nodeHtml:(rows,pid,line,commercial,members)=>{calls.push({rows,pid,line,commercial,members});return '<p data-baseline-members="'+esc((members||[pid]).join(','))+'">原项目基准</p>';},
    planHtml:table('plans'),coordHtml:table('coord'),otherHtml:table('other'),notesHtml:()=>'',legacyHtml:()=>'',unassignedHtml:()=>'',
    reportHistoryButton:r=>'<button data-history="'+esc(r.id)+'">历史</button>',foldAttrs:()=> ' open',foldHint:()=>'',projectDetailButton:pid=>'<button data-project="'+pid+'">详情</button>',drawingHtml:()=>'',filesHtml:rows=>rows.length?'<p data-files="'+rows.map(r=>r.id).join(',')+'">原附件</p>':''});
  return calls;
}
const attachment = '10000000-0000-4000-8000-000000000001';
function state() {return {uid:'user',session:{},view:'pres',profile:{role:'ops'},overviewUI:{open:{}},projects:structuredClone(projects),reportScopes:[structuredClone(scope)],drawings:[],reportAttachments:[{id:attachment,project_id:'p2',report_scope_id:scope.id,name:'原项目图片.png',inline:true,mime:'image/png'}]};}
function report() {return {id:9,project_id:'p1',report_scope_id:scope.id,scope_project_ids:['p1','p2','p3'],author_name:'原作者',period:'2026-10-19',history:[{id:'old-version'}],biz:{items:[{source_id:'item-original',name:'统一报告正文'}],attachments:[attachment]}};}
test('管理端只显示一次完整组报，各部分与附件不复制到三个项目，基准接入保留全部原项目', () => {
  const h = harness(), S = state(), row = report(), before = structuredClone(row), calls = configure(h,S);
  h.OverviewMeetings = {residentialHtml:projects=>projects.map(project=>'<p data-original-meeting-project="'+esc(project.id)+'">原项目会议</p>').join('')};
  const html = h.AdminPlanOverview.residential({name:scope.name,report_scope_id:scope.id,projects:S.projects},[row],true);
  assert.equal((html.match(/data-report-id="9"/g)||[]).length,1); assert.equal((html.match(/data-kind="plans"/g)||[]).length,1);
  assert.equal((html.match(/data-files="9"/g)||[]).length,1); assert.match(html,/本期 1 份已提交填报/); assert.match(html,/data-report-scope-id="res-scope"/);
  assert.equal(calls.length,1); assert.deepEqual(plain(calls[0].members),['p1','p2','p3']); assert.equal(calls[0].rows[0],row);
  for (const pid of ['p1','p2','p3']) assert.match(html,new RegExp('data-original-meeting-project="'+pid+'"'));
  assert.deepEqual(row,before);
});
test('部分项目原授权不能显示组报告正文或组图片，原项目入口仍在', () => {
  const h = harness(), S = state(); S.projects = S.projects.slice(0,2); configure(h,S);
  const html = h.AdminPlanOverview.residential({name:'部分项目',projects:S.projects},[report()],true);
  assert.doesNotMatch(html,/统一报告正文|data-report-id="9"|data-report-scope-id="res-scope"/); assert.match(html,/data-project="p1"/);
  assert.equal(h.AdminPlanOverview.pictures(S.projects,[report()]).length,0);
});
test('组图片保留真实附件项目与范围，旧附件或另一范围同ID不能被组报告冒用', () => {
  const h = harness(), S = state(); configure(h,S);
  const images = plain(h.AdminPlanOverview.pictures(S.projects,[report()]));
  assert.equal(images.length,1); assert.equal(images[0].projectId,'p2'); assert.equal(images[0].url,'/api/report-attachments/'+attachment);
  S.reportAttachments[0].report_scope_id = null;
  assert.equal(h.AdminPlanOverview.pictures(S.projects,[report()]).length,0);
});
