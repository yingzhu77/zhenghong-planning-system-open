import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const web=new URL('../web/',import.meta.url),period='2026-10-26';
const engineeringId='20000000-0000-4000-8000-000000000001',designId='20000000-0000-4000-8000-000000000002';
const projects=[{id:'a',name:'匿名一期',project_type:'res'},{id:'b',name:'匿名二期',project_type:'res'}];
const scope={id:'anonymous-month-scope',name:'匿名统一范围',anchor_project_id:'a',project_ids:['a','b'],effective_week:'2026-10-19'};
const plain=value=>JSON.parse(JSON.stringify(value));
class FixedDate extends Date {
  constructor(...args){super(...(args.length?args:['2026-10-29T04:00:00Z']));}
  static now(){return Date.parse('2026-10-29T04:00:00Z');}
}
function plans(){return [
  {id:engineeringId,project_id:'a',report_scope_id:scope.id,scope_project_ids:['a','b'],line:'工程',plan_month:'2026-10-01',confirmed_by:'engineer',confirmed_name:'匿名工程人',
    items:[{project_id:'b',source_id:'shared-row',mod:'砌筑工程',name:'工程确认事项',due:'2026-10-31'}],rich_text:{}},
  {id:designId,project_id:'a',report_scope_id:scope.id,scope_project_ids:['a','b'],line:'设计',plan_month:'2026-10-01',confirmed_by:'designer',confirmed_name:'匿名设计人',
    items:[{source_id:'shared-row',mod:'外立面',name:'设计确认事项',due:'2026-10-31'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:'设计确认事项',attributes:{bold:true}}]}}}}
];}
function report(ids=[engineeringId,designId]){
  const rows=plans().filter(plan=>ids.includes(plan.id)).map(plan=>({...plan.items[0],monthly_plan_id:plan.id,prog:plan.line+'当周原进展'}));
  const fields={};rows.forEach((row,index)=>{if(row.monthly_plan_id===designId)fields['biz.items.'+index+'.prog']={ops:[{insert:'设计当周原进展',attributes:{bold:true}}]};});
  return {id:10,project_id:'a',report_scope_id:scope.id,scope_project_ids:['a','b'],line:'综合',author_id:'weekly-author',author_name:'原综合填报人',
    period,submitted_at:'2026-10-27T04:00:00Z',biz:{monthly_plan_ids:ids,items:rows},rich_text:{v:1,fields}};
}
function harness({line='',historical=false,reportingMode}={}){
  const h={console,Date:FixedDate};h.window=h;vm.createContext(h);
  for(const name of ['planning-windows.js','report-scopes.js','rich-text.js','monthly-plans.js','admin-plan-overview.js','meeting-view.js'])vm.runInContext(readFileSync(new URL(name,web),'utf8'),h,{filename:name});
  const S={uid:'operator',session:{},view:'pres',profile:{role:'ops',status:'approved'},projects:plain(projects),reportScopes:[plain(scope)],monthlyPlans:plans(),members:[],
    overviewUI:{open:{},discipline:line},drawings:[],reportAttachments:[]};
  if(reportingMode)S.reportScopes[0].reporting_mode=reportingMode;
  h.MonthlyPlans.configure({S,esc:h.MeetingView.esc});
  const calls=[],empty=()=>'<table><tbody><tr><td class="overview-cell-empty">暂无</td></tr></tbody></table>';
  h.AdminPlanOverview.configure({S,esc:h.MeetingView.esc,disciplines:['工程','设计'],currentPeriod:()=>period,isHistorical:()=>historical,
    residentialGroups:()=>({'工程':[],'设计':[]}),nodeHtml:empty,coordHtml:empty,otherHtml:empty,notesHtml:()=>'',legacyHtml:()=>'',
    planHtml(rows,pid,_line,_commercial,context){
      calls.push(plain({rows,pid,context}));
      const options=context && !Array.isArray(context)?context:{projectIds:[pid],line:S.overviewUI.discipline};
      const combined=h.MonthlyPlans.projectReports({plans:S.monthlyPlans,reports:rows,scope_id:options.scope_id,projectIds:options.projectIds,line:options.line,month:'2026-10',includeUnsubmitted:!historical});
      return '<table><tbody>'+combined.flatMap(row=>(row.biz.items || []).map(item=>'<tr><td>'+h.ZHRichText.field(item,'name',item.name)+'</td><td>'
        +h.MeetingView.esc(item.project_id || (row.report_scope_id?'统一范围 · 未明确子项目':row.project_id))+'</td><td>'
        +(row._monthly_preview?'月计划已确认，本周尚未提交':h.MeetingView.esc(item.prog || '未填写'))+'</td></tr>')).join('')+'</tbody></table>';
    },reportHistoryButton:()=>'',foldAttrs:()=>'',foldHint:()=>'',projectDetailButton:()=>'',drawingHtml:()=>'',filesHtml:()=>''});
  return {h,S,calls,overview(rows=[]){return h.AdminPlanOverview.residential({name:scope.name,report_scope_id:scope.id,projects:S.projects},rows,true);}};
}
function model({line='',rows=[],selectedProjects=projects,selectedPeriod=period}={}){
  return {target:{kind:'report',type:'res',projectIds:selectedProjects.map(project=>project.id),period:selectedPeriod,line,section:'plans'},projects:plain(selectedProjects),reports:rows,plans:plans(),nodes:[],drawings:[],attachments:[],readAt:'12:00:00'};
}

test('unified overview passes exact scope and selected discipline for professional previews without creating a submitted report',()=>{
  const {h,S,calls,overview}=harness(),before=plain(S.monthlyPlans),html=overview();
  assert.deepEqual(calls[0].context,{scope_id:scope.id,projectIds:['a','b'],line:''});
  assert.match(html,/工程确认事项/);assert.match(html,/<strong>设计确认事项<\/strong>/);
  assert.match(html,/统一范围 · 未明确子项目/);assert.match(html,/本期 0 份已提交填报/);
  assert.deepEqual(plain(S.monthlyPlans),before);
  S.overviewUI.discipline='设计';
  const design=overview();assert.match(design,/设计确认事项/);assert.doesNotMatch(design,/工程确认事项/);
  assert.equal(calls.at(-1).context.line,'设计');
});

test('one original comprehensive report and a later unreferenced discipline plan stay distinct and immutable',()=>{
  const {S,overview}=harness(),row=report([engineeringId]),before=plain(row),html=overview([row]);
  assert.match(html,/本期 1 份已提交填报/);assert.equal((html.match(/data-report-id="10"/g)||[]).length,1);
  assert.equal((html.match(/工程确认事项/g)||[]).length,1);assert.equal((html.match(/设计确认事项/g)||[]).length,1);
  assert.match(html,/工程当周原进展/);assert.match(html,/月计划已确认，本周尚未提交/);
  assert.deepEqual(plain(row),before);assert.equal(S.monthlyPlans.length,2);
});

test('legacy comprehensive snapshots do not suppress professional previews or gain month references',()=>{
  const {overview}=harness(),row=report([]);
  row.biz={items:[{source_id:'shared-row',mod:'工程',name:'旧综合原事项',prog:'旧综合原进展'}]};
  const before=plain(row),html=overview([row]);
  assert.match(html,/本期 1 份已提交填报/);assert.equal((html.match(/旧综合原事项/g)||[]).length,1);
  assert.equal((html.match(/工程确认事项/g)||[]).length,1);assert.equal((html.match(/设计确认事项/g)||[]).length,1);
  assert.deepEqual(plain(row),before);assert.equal(row.biz.monthly_plan_ids,undefined);
});

test('an incomplete overview project set does not expose a stale scoped professional plan',()=>{
  const {S,overview}=harness();S.projects=S.projects.slice(0,1);
  const before=plain(S.monthlyPlans),html=overview();
  assert.doesNotMatch(html,/工程确认事项|设计确认事项/);assert.deepEqual(plain(S.monthlyPlans),before);
});

test('projection shows all scoped professional plans once while incomplete or historical selections do not gain previews',()=>{
  const {h}=harness(),input=model(),before=plain(input),html=h.MeetingView.html(input);
  assert.match(html,/0 份所选周期已提交报告，另有 2 份已确认月计划/);
  assert.equal((html.match(/工程确认事项/g)||[]).length,1);assert.equal((html.match(/设计确认事项/g)||[]).length,1);
  assert.match(html,/<caption>匿名二期/);assert.match(html,/<caption>统一范围 · 未明确子项目/);
  assert.deepEqual(plain(input),before);
  const partial=h.MeetingView.html(model({selectedProjects:projects.slice(0,1)}));
  assert.doesNotMatch(partial,/工程确认事项|设计确认事项|另有 2 份/);
  const historical=h.MeetingView.html(model({selectedPeriod:'2026-10-19'}));
  assert.doesNotMatch(historical,/工程确认事项|设计确认事项|已确认月计划待填/);
});

test('selected discipline keeps original submitted author and mapped plan profession without duplicating covered refs',()=>{
  const {h}=harness(),row=report(),before=plain(row);
  h.ZHRichText.attach(row);
  const filtered=h.MonthlyPlans.residentialReports([row],'设计',[],plans());
  assert.equal(filtered.length,1);assert.equal(filtered[0].biz.items.length,1);assert.equal(filtered[0].biz.items[0].monthly_plan_id,designId);
  const html=h.MeetingView.html(model({line:'设计',rows:filtered}));
  assert.match(html,/1 份所选周期已提交报告/);assert.doesNotMatch(html,/另有 \d+ 份已确认月计划|工程确认事项/);
  assert.match(html,/原综合填报人 · 设计/);assert.match(html,/<strong>设计当周原进展<\/strong>/);
  assert.equal(row.biz.monthly_plan_ids.length,2);assert.deepEqual(plain(row.biz),before.biz);
});

test('readonly projection loading uses complete plan membership and explicit plan metadata for discipline filtering',async()=>{
  const {h}=harness(),source=report(),original=plain(source),requests=[];
  h.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({url,body});let data;
    if(url==='/api/auth/session')data={session:{user:{id:'operator'}}};
    else if(url==='/api/db'){
      assert.equal(body.operation,'select');
      const pid=body.filters.find(filter=>filter.column==='project_id' || filter.column==='id')?.value;
      data=body.table==='profiles'?[{user_id:'operator',role:'ops',status:'approved'}]:body.table==='projects'?projects.filter(project=>project.id===pid)
        :body.table==='reports'&&pid==='a'?[source]:[];
    } else if(url==='/api/monthly-plans/list')data=body.project_id==='a'?plans():[];
    else if(/^\/api\/monthly-summaries\?month=\d{4}-\d{2}$/.test(url)){assert.equal(body,null);data=[];}
    else if(url==='/api/project-people/list')data=[];
    else throw new Error('unexpected_projection_request');
    return {ok:true,json:async()=>({data:plain(data),error:null})};
  };
  const selected={kind:'report',type:'res',projectIds:['a','b'],period,line:'设计',section:'plans'};
  const loaded=await h.MeetingView.read('operator',selected,new AbortController().signal);
  assert.equal(loaded.reports.length,1);assert.equal(loaded.reports[0].biz.items.length,1);assert.equal(loaded.reports[0].biz.items[0].monthly_plan_id,designId);
  assert.equal(loaded.plans.length,2);assert.match(h.MeetingView.html(loaded),/设计当周原进展/);
  assert.deepEqual(source,original);assert.ok(requests.every(request=>request.url==='/api/auth/session'||request.url==='/api/db'||/\/list$/.test(request.url)||/^\/api\/monthly-summaries\?month=\d{4}-\d{2}$/.test(request.url)&&request.body===null));
  const partial=await h.MeetingView.read('operator',{...selected,projectIds:['a']},new AbortController().signal);
  assert.equal(partial.plans.length,0);assert.equal(partial.reports.length,0);
});

test('a confirmed own professional plan stays visible when the saved comprehensive report does not reference it',()=>{
  const {h,S}=harness();
  Object.assign(S,{uid:'engineer',profile:{role:'pm',status:'approved',discipline:'工程'},pmProject:'a',pmLine:'综合',pmPeriod:period,pmReportScope:plain(scope)});
  const plansBefore=plain(S.monthlyPlans);
  S.pmReport=report([]);S.pmReport.biz={items:[{source_id:'legacy-own',mod:'原类别',name:'原综合计划',prog:'保留的原反馈'}]};
  S.bizItems=plain(S.pmReport.biz.items);
  const legacyBefore=plain(S.pmReport),legacyHtml=h.MonthlyPlans.plannerHtml();
  assert.match(legacyHtml,/本月专业计划 · 工程/);assert.match(legacyHtml,/工程确认事项/);assert.match(legacyHtml,/已确认，固定列不可修改/);
  assert.doesNotMatch(legacyHtml,/<textarea|MonthlyPlans\.confirmCurrent/);
  assert.equal(h.MonthlyPlans.apply(),false);assert.deepEqual(plain(S.pmReport),legacyBefore);assert.deepEqual(S.bizItems,legacyBefore.biz.items);

  S.pmReport=report([designId]);S.bizItems=plain(S.pmReport.biz.items);
  const savedBefore=plain(S.pmReport);
  assert.match(h.MonthlyPlans.plannerHtml(),/工程确认事项/);
  assert.match(h.MonthlyPlans.toolbarHtml(),/后确认的专业计划不会改写该期报告/);
  assert.equal(h.MonthlyPlans.apply(),true);assert.equal(S.bizItems.length,1);assert.equal(S.bizItems[0].monthly_plan_id,designId);
  assert.deepEqual(plain(S.pmReport),savedBefore);

  S.pmReport=report();assert.equal(h.MonthlyPlans.plannerHtml(),'','a report already displaying the own plan must not duplicate it');
  S.pmReport=null;assert.equal(h.MonthlyPlans.plannerHtml(),'','an unsaved report already aggregates the confirmed own plan');
  assert.deepEqual(plain(S.monthlyPlans),plansBefore);
});

test('one merged project overview retains every independently submitted profession and original author',()=>{
  const {overview,calls}=harness({reportingMode:'professional'});
  const engineer=report([engineeringId]),designer=report([designId]);
  Object.assign(engineer,{id:51,line:'工程',author_id:'engineer',author_name:'工程原作者'});
  Object.assign(designer,{id:52,line:'设计',author_id:'designer',author_name:'设计原作者'});
  const before=plain([engineer,designer]),html=overview([engineer,designer]);
  assert.match(html,/匿名统一范围 · 各专业填报/);
  assert.match(html,/工程 · 工程原作者/);assert.match(html,/设计 · 设计原作者/);
  assert.equal((html.match(/data-report-id="51"/g)||[]).length,1);
  assert.equal((html.match(/data-report-id="52"/g)||[]).length,1);
  assert.match(html,/本期 2 份已提交填报/);assert.equal(calls[0].rows.length,2);
  assert.equal((html.match(/工程确认事项/g)||[]).length,1);
  assert.equal((html.match(/设计确认事项/g)||[]).length,1);
  assert.doesNotMatch(html,/共用一份综合报告/);assert.deepEqual(plain([engineer,designer]),before);
});

test('merged professional overview keeps legacy child reports available in a separate history reference',()=>{
  const {overview}=harness({reportingMode:'professional'}),old={id:60,project_id:'b',line:'综合',author_id:'old',author_name:'原地块作者',period,
    submitted_at:'2026-10-27T00:00:00Z',biz:{items:[{mod:'原事项',name:'原地块已提交内容'}]}};
  const before=plain(old),html=overview([old]);
  assert.match(html,/原分期报告 · 历史参考/);assert.match(html,/原地块已提交内容/);
  assert.match(html,/原地块作者/);assert.deepEqual(plain(old),before);
});

test('projection title uses the authenticated project group while retaining actual source identity',()=>{
  const {h}=harness(),input=model();input.projects.forEach(project=>{project.display_group='匿名统一范围';});
  const html=h.MeetingView.html(input);
  assert.match(html,/<h1>匿名统一范围<\/h1>/);assert.doesNotMatch(html,/<h1>匿名一期、匿名二期/);
  assert.match(html,/<caption>匿名二期/);
  input.projects[1].display_group='其他项目';
  assert.match(h.MeetingView.html(input),/<h1>匿名一期、匿名二期<\/h1>/);
});
