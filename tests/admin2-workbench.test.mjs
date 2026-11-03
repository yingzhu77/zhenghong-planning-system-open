import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const web=new URL('../web/',import.meta.url);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function task(project,id,kind='requirement') {return {id,project_id:project,owner_id:'pm',owner_name:'匿名PM',meeting_kind:kind,proposer_id:'old-leader',proposer_role:'president',proposer_name:'原提出领导',title:id,what:'原事项-'+id,due:'2026-11-01',status:'in_progress',progress:'原进展-'+id,revision:8};}
function appHarness() {
  const elements={root:{innerHTML:''},toast:{style:{}}},storage=new Map();
  const sandbox={console,setTimeout:()=>0,clearTimeout(){},addEventListener(){},removeEventListener(){},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},removeEventListener(){},body:{appendChild(){}}},WorkBuddyCloud:{createWorkBuddyCloud:()=>({auth:{},database:{from(){throw Error('isolated UI test must not access a database');}}})},CompletionReview:{configure(){},approved:()=>false,actionHtml:key=>'<button data-claim="'+key+'">原完成延期申报</button>',effectiveDue:(_key,due)=>due,snapshotsHtml:()=>'',renderQueue:()=>'',overlayHtml:()=>''}};
  sandbox.window=sandbox;vm.createContext(sandbox);
  for(const name of ['rich-text.js','planning-windows.js','report-scopes.js','reporter-tasks.js'])vm.runInContext(readFileSync(new URL(name,web),'utf8'),sandbox);
  const source=readFileSync(new URL('app.js',web),'utf8'),boundary=source.indexOf('  (async function boot() {');assert.ok(boundary>0);
  vm.runInContext(source.slice(0,boundary)+'\nwindow.audit={S,preparePM,configureReporter,currentPeriod,viewPMCenter,criticalWorkItems};\n})();',sandbox);
  const h=sandbox.audit,S=h.S,period=h.currentPeriod(),week=sandbox.PlanningWindows.periodStart(period),ids=['zhx1','zhx2','klq'];
  Object.assign(S,{uid:'pm',session:{},profile:{user_id:'pm',name:'匿名PM',role:'pm',status:'approved',project_id:'zhx1'},projects:ids.map(id=>({id,name:'原实际项目-'+id,project_type:'res',active:true})),reportScopes:[{id:'zhenghongxu-residential',name:'正弘序',anchor_project_id:'zhx1',project_ids:ids,effective_week:'2026-10-19',period_week:week,active_for_period:true,blocked_weeks:[]}],pms:ids.map(id=>({user_id:'pm',project_id:id})),pmProject:'zhx1',pmPeriod:period,view:'center',reports:[],milestones:[],leaderNotes:[],reporterTasks:[],followupRows:[]});
  return {...h,sandbox,week};
}
test('实际个人工作台读取住宅全组安排并沿每个真实项目申报，显式空反馈不回填实时进展',async()=>{
  const h=appHarness(),S=h.S;
  S.reporterTasks=[task('zhx1','anchor'),task('zhx2','phase2'),task('klq','kela'),task('zhx2','special','special'),task('klq','legacy','legacy'),{...task('outside','foreign')},{...task('zhx2','other-owner'),owner_id:'someone-else'}].map(row=>({...row,created_at:h.week+'T00:00:00Z'}));
  S.leaderNotes=[{id:'original-note',project_id:'klq',owner_id:'pm',kind:'ceo_brief',what:'原可乐领导要求',period:S.pmPeriod,created_at:h.week+'T00:00:00Z'},
    {id:'unassigned-note',project_id:'zhx2',kind:'pzo_note',what:'原二期待核对领导要求',period:S.pmPeriod}];
  const before=JSON.stringify({tasks:S.reporterTasks,notes:S.leaderNotes});await h.preparePM();
  S.followupRows=S.followupRows.map(row=>row.source_key==='meeting:zhx2:phase2'?{...row,progress:''}:row);
  const requirements=h.sandbox.ReporterTasks.requirementsHtml('zhx1'),center=h.viewPMCenter();
  for(const [project,id] of [['zhx1','anchor'],['zhx2','phase2'],['klq','kela']]){
    assert.match(requirements,new RegExp('data-meeting-key="meeting:'+project+':'+id+'"'));
    assert.match(requirements,new RegExp('data-claim="meeting:'+project+':'+id+'"'));assert.match(center,new RegExp('原事项-'+id));
  }
  assert.match(requirements,/data-claim="leader:klq:original-note"/);assert.doesNotMatch(requirements,/leader:zhx1:original-note/);
  assert.match(requirements,/实际项目：原实际项目-zhx2/);assert.match(requirements,/原二期待核对领导要求/);
  assert.doesNotMatch(requirements,/原事项-foreign|原事项-other-owner|原进展-phase2/);
  assert.match(center,/meeting:zhx2:special/);assert.match(center,/meeting:klq:legacy/);
  const keys=Array.from(h.criticalWorkItems('zhx1'),row=>row.source_key);assert.ok(keys.includes('meeting:zhx2:phase2'));assert.ok(keys.includes('meeting:klq:kela'));
  assert.equal(JSON.stringify({tasks:S.reporterTasks,notes:S.leaderNotes}),before,'读取组任务不得重绑原项目或修改原记录');
});
test('非组与商业工作台仍单项目，单看某成员项目不扩到整组',async()=>{
  const h=appHarness(),S=h.S;S.reporterTasks=[task('zhx1','one'),task('zhx2','two')].map(row=>({...row,created_at:h.week+'T00:00:00Z'}));await h.preparePM();
  assert.doesNotMatch(h.sandbox.ReporterTasks.requirementsHtml('zhx2'),/原事项-one/);
  S.pmScopeId=null;S.pmReportScope=null;h.configureReporter();assert.doesNotMatch(h.sandbox.ReporterTasks.requirementsHtml('zhx1'),/原事项-two/);
  S.pmScopeId='unexpected';S.pmReportScope={id:'unexpected',project_ids:['zhx1','zhx2']};S.projects[0].project_type='com';h.configureReporter();
  assert.doesNotMatch(h.sandbox.ReporterTasks.requirementsHtml('zhx1'),/原事项-two/);
});
function editorHarness() {
  const elements={},calls=[],messages=[],S={uid:'ops',session:{},profile:{role:'ops'},projects:[{id:'zhx2',name:'二期'}],meetingAdminProject:'zhx2',meetingAdminKind:'requirement',pmProject:'zhx2',pmPeriod:'2026-10-19',reporterTasks:[task('zhx2','original-task')],followupRows:[]};
  const sandbox={document:{getElementById:id=>elements[id]||null}};sandbox.window=sandbox;vm.createContext(sandbox);
  for(const name of ['rich-text.js','planning-windows.js','reporter-tasks.js'])vm.runInContext(readFileSync(new URL(name,web),'utf8'),sandbox);
  const options={S,esc,richCopy:(...args)=>sandbox.ZHRichText.copy(...args),richItem:(...args)=>sandbox.ZHRichText.field(...args),richCollect:row=>sandbox.ZHRichText.collect(row),weekNo:()=>43,currentPeriod:()=> '2026-10-19',render(){},toast:(...args)=>messages.push(args),loadPeople:async()=>({data:[{user_id:'pm',role:'pm',name:'匿名PM',discipline:'工程'},{user_id:'active-leader',role:'pzo',name:'现任提出领导'}]}),reloadTasks:async()=>{},request:async(url,body)=>{calls.push({url,body});return{data:{...S.reporterTasks.find(row=>row.id===body.id),...body,id:body.id||'new-task',revision:body.expected_revision?body.expected_revision+1:1}};}};
  sandbox.ReporterTasks.configure(options);return {S,sandbox,api:sandbox.ReporterTasks,options,elements,calls,messages};
}
test('独立会议维护保留停用的原提出领导，原ID版本进展与富文本保持',async()=>{
  const h=editorHarness();h.S.reporterTasks[0].rich_text={v:1,fields:{what:{ops:[{insert:'原事项-original-task',attributes:{bold:true,color:'#d81e06'}}]}}};
  await h.api.edit(0);const html=h.api.renderAdmin();assert.match(html,/<option value="old-leader" selected>/);assert.match(html,/原提出领导（原提出人）/);
  h.elements.meeting_proposer={value:'old-leader'};h.elements.meeting_due={value:'2026-11-03'};await h.api.save();
  assert.equal(h.calls.length,1);const {body}=h.calls[0];assert.equal(body.proposer_id,'old-leader');assert.equal(body.project_id,'zhx2');assert.equal(body.owner_id,'pm');assert.equal(body.id,'original-task');assert.equal(body.expected_revision,8);assert.equal(body.progress,'原进展-original-task');assert.equal(body.due,'2026-11-03');
  assert.equal(body.rich_text.fields.what.ops[0].attributes.bold,true);
});
test('新建或更换提出领导仍必须原有效名单，取消及账号切换不能继承旧提出人豁免',async()=>{
  const h=editorHarness();await h.api.edit(0);h.elements.meeting_proposer={value:'another-inactive'};await h.api.save();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1)[0],/实际提出要求/);
  h.elements.meeting_proposer.value='active-leader';await h.api.save();assert.equal(h.calls[0].body.proposer_id,'active-leader');
  h.elements.meeting_proposer.value='old-leader';await h.api.edit();Object.assign(h.elements,{meeting_owner:{value:'pm'},meeting_title:{value:'新事项'},meeting_what:{value:'新事项内容'}});await h.api.save();assert.equal(h.calls.length,1,'新建不能使用原记录的停用提出人');
  h.api.cancel();h.S.session={};h.api.configure(h.options);await h.api.edit();await h.api.save();assert.equal(h.calls.length,1,'新会话不能继承旧提出人豁免');
});
