import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const web = new URL('../web/',import.meta.url);
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const projects = [{id:'p1',name:'住宅一期',project_type:'res'},{id:'p2',name:'住宅二期',project_type:'res'},{id:'forbidden',name:'无权项目',project_type:'res'}];
const directory = {p1:[{user_id:'e1',role:'pm',name:'工程甲',discipline:'工程'},{user_id:'e2',role:'pm',name:'工程乙',discipline:'工程'},{user_id:'d1',role:'pm',name:'设计甲',discipline:'设计'},{user_id:'leader',role:'president',name:'总裁'}],
  p2:[{user_id:'p2e',role:'pm',name:'二期工程',discipline:'工程'},{user_id:'leader',role:'president',name:'总裁'}]};
function fixture({role='ops',request}={}) {
  const sandbox = {document:{getElementById:id=>elements[id]||null}}, calls=[], messages=[], elements={}; sandbox.window=sandbox; vm.createContext(sandbox);
  for(const name of ['rich-text.js','overview-meetings.js','admin-plan-overview.js']) vm.runInContext(readFileSync(new URL(name,web),'utf8'),sandbox);
  const S={uid:role==='ops'?'operator':role==='pm'?'e1':'leader',session:{},profile:{role,name:'当前身份'},overviewUI:{open:{},discipline:''},projects:structuredClone(projects.slice(0,2)),reporterTasks:[],leaderNotes:[]};
  const cfg={S,esc,disciplines:['工程','设计','成本'],richCopy:(...args)=>sandbox.ZHRichText.copy(...args),richItem:(...args)=>sandbox.ZHRichText.field(...args),richCollect:row=>sandbox.ZHRichText.collect(row),
    render(){},toast:(...args)=>messages.push(args),loadPeople:async pid=>({data:structuredClone(directory[pid]||[])}),request:async(url,body)=>{calls.push({url,body});return request?request(url,body):{data:{...body,id:body.id||'new-original-task',proposer_role:'president',proposer_name:'总裁',revision:body.expected_revision?body.expected_revision+1:1}};}};
  sandbox.OverviewMeetings.configure(cfg);
  async function ready(){sandbox.OverviewMeetings.residentialHtml(projects);await new Promise(resolve=>setImmediate(resolve));}
  function html(){return sandbox.OverviewMeetings.residentialHtml(projects);}
  function scopeIndex(){return Number(/OverviewMeetings.add\((\d+)\)/.exec(html())[1]);}
  return {sandbox,api:sandbox.OverviewMeetings,S,cfg,calls,messages,elements,ready,html,scopeIndex};
}
function fill(h,number,{project='p2',discipline='工程',owner='p2e',due='2026-11-01'}={}) {
  h.api.change(number,'project_id',project); h.api.change(number,'discipline',discipline);h.api.change(number,'owner_id',owner);
  h.api.change(number,'proposer_id','leader');h.api.change(number,'what','明确安排内容');h.api.change(number,'due',due);
}
test('住宅统一区只列原权限的requirement，旧无日期及未明确专业记录仍能阅读且不改基准',async()=>{
  const h=fixture();h.S.reporterTasks=[{id:'old',project_id:'p1',meeting_kind:'requirement',proposer_id:'leader',what:'原安排',owner_id:'retired',owner_name:'原责任人',due:null,revision:4},
    {id:'special',project_id:'p1',meeting_kind:'special',what:'专项决议不得混入'}, {id:'foreign',project_id:'forbidden',meeting_kind:'requirement',what:'无权内容'}];
  h.S.milestones=[{id:17,project_id:'p1',discipline:'',plan_date:'2026-10-22'}];const before=structuredClone(h.S);await h.ready();const html=h.html();
  assert.match(html,/领导工作安排/);assert.match(html,/未明确专业/);assert.match(html,/未设置（原记录）/);assert.match(html,/原安排/);
  assert.doesNotMatch(html,/无权内容|专项决议不得混入|待分配专业的基准节点/);assert.deepEqual(h.S,before);assert.equal(h.calls.length,0);
});
test('统一范围新建不默认锚点，真实项目专业责任人完成日期逐项核对，保存仍一条原会议来源',async()=>{
  const h=fixture();await h.ready();const n=h.api.add(h.scopeIndex());await h.api.save(n);assert.match(h.messages.at(-1)[0],/选择原实际项目/);
  h.api.change(n,'what','先输入的内容');h.api.change(n,'due','2026-11-01');
  h.api.change(n,'project_id','p2');assert.match(h.html(),/先输入的内容/);assert.match(h.html(),/value="2026-11-01"/);
  h.api.change(n,'project_id','forbidden');await h.api.save(n);assert.equal(h.calls.length,0);
  fill(h,n,{discipline:'成本',owner:'p2e'});assert.match(h.html(),/该专业暂无本项目有效责任人/);await h.api.save(n);assert.equal(h.calls.length,0);
  fill(h,n,{owner:'e1'});await h.api.save(n);assert.match(h.messages.at(-1)[0],/所选专业/);assert.equal(h.calls.length,0);
  fill(h,n,{due:''});await h.api.save(n);assert.match(h.messages.at(-1)[0],/完成时间/);assert.equal(h.calls.length,0);
  fill(h,n);h.api.binding('overview_meeting_what_'+n).set({ops:[{insert:'明确安排内容',attributes:{bold:true,color:'#d81e06'}}]});
  await h.api.save(n);await h.api.save(n);assert.equal(h.calls.length,1);const {url,body}=h.calls[0];
  assert.equal(url,'/api/reporter-tasks/save');assert.equal(body.project_id,'p2');assert.equal(body.owner_id,'p2e');assert.equal(body.proposer_id,'leader');
  assert.equal(body.meeting_kind,'requirement');assert.equal(body.due,'2026-11-01');assert.equal(body.discipline,undefined);
  assert.equal(body.rich_text.fields.what.ops[0].attributes.bold,true);assert.equal(h.S.reporterTasks.length,1);
});
test('同专业多人必须明确选一人，切实际项目清除旧责任人与提出领导但保留内容和日期',async()=>{
  const h=fixture();await h.ready();const n=h.api.add(h.scopeIndex());fill(h,n,{project:'p1',owner:''});await h.api.save(n);assert.equal(h.calls.length,0);
  const options=h.html();assert.match(options,/工程甲/);assert.match(options,/工程乙/);assert.doesNotMatch(options,/<option value="d1"/);
  h.api.change(n,'owner_id','e2');h.api.change(n,'project_id','p2');
  assert.match(h.html(),/明确安排内容/);assert.match(h.html(),/value="2026-11-01"/);await h.api.save(n);assert.match(h.messages.at(-1)[0],/具体专业/);
  h.api.change(n,'discipline','工程');h.api.change(n,'owner_id','p2e');await h.api.save(n);assert.match(h.messages.at(-1)[0],/实际提出/);assert.equal(h.calls.length,0);
});
test('总裁项目总仅以本人提出要求，非本人记录只读，PM没有维护入口',async()=>{
  for(const role of ['president','pzo']){const h=fixture({role});await h.ready();h.S.reporterTasks=[{id:'others',project_id:'p2',meeting_kind:'requirement',proposer_id:'other',what:'他人安排',owner_id:'p2e'}];
    assert.match(h.html(),/只读/);assert.equal(h.api.editResidential(h.scopeIndex(),0),undefined);
    const n=h.api.add(h.scopeIndex());fill(h,n);h.api.change(n,'proposer_id','forged');await h.api.save(n);assert.equal(h.calls[0].body.proposer_id,'leader');}
  const pm=fixture({role:'pm'});await pm.ready();assert.equal(pm.html(),'');assert.equal(pm.calls.length,0);
});
test('维护沿原ID和revision，旧无日期可保留；并发失败保留内容且重复点击只发送一次',async()=>{
  let release;const h=fixture({request:async()=>new Promise(resolve=>{release=resolve;})});h.S.reporterTasks=[{id:'original',project_id:'p2',meeting_kind:'requirement',proposer_id:'leader',proposer_name:'总裁',what:'旧安排',owner_id:'p2e',progress:'原反馈',status:'in_progress',due:null,revision:7}];await h.ready();
  const n=h.api.editResidential(h.scopeIndex(),0);h.api.change(n,'what','修改的安排');const pending=h.api.save(n);await h.api.save(n);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].body.id,'original');assert.equal(h.calls[0].body.expected_revision,7);assert.equal(h.calls[0].body.due,'');assert.equal(h.calls[0].body.progress,'原反馈');
  release({error:{code:'revision_conflict'}});await pending;assert.match(h.html(),/修改的安排/);assert.match(h.html(),/其他页面更新/);assert.equal(h.S.reporterTasks[0].what,'旧安排');
});
test('新住宅接入只渲染一个统一区，原按专业重复编辑与未分配基准区取消，报告来源保持',async()=>{
  const h=fixture();await h.ready();const reports=[{id:1,project_id:'p1',items:['旧事项']}],before=structuredClone(reports);let shared=0;
  h.api.residentialHtml=()=>{shared++;return '<section data-shared-arrangement>领导工作安排</section>';};
  h.api.legacyHtml=()=>{throw new Error('管理总览不得再渲染已移除的原领导责任人核对区');};
  const table=()=>'<table><tbody><tr><td class="overview-cell-empty">暂无</td></tr></tbody></table>';
  h.sandbox.AdminPlanOverview.configure({S:h.S,esc,disciplines:['工程'],currentPeriod:()=> '2026-10-19',residentialGroups:()=>({'工程':[]}),nodeHtml:table,planHtml:table,coordHtml:table,otherHtml:table,
    notesHtml:()=>'',legacyHtml:()=>'',unassignedHtml:()=>'<p>原未分配节点</p>',reportHistoryButton:()=>'',foldAttrs:()=>'',foldHint:()=>'',projectDetailButton:()=>'',drawingHtml:()=>'',filesHtml:()=>''});
  const html=h.sandbox.AdminPlanOverview.residential({name:'住宅组',projects:h.S.projects},reports,true);assert.equal(shared,1);assert.equal((html.match(/data-shared-arrangement/g)||[]).length,1);
  assert.doesNotMatch(html,/待分配专业的基准节点|原未分配节点|data-section="meetings"/);assert.deepEqual(reports,before);
});
test('人员读取失败与零有效责任人分别可识别，失败状态不伪造候选',async()=>{
  const h=fixture();h.cfg.loadPeople=async()=>({error:{message:'模拟读取失败'}});await h.ready();assert.match(h.html(),/模拟读取失败/);assert.match(h.html(),/重读项目人员/);
  const n=h.api.add(h.scopeIndex());fill(h,n);await h.api.save(n);assert.equal(h.calls.length,0);
  const empty=fixture();empty.cfg.loadPeople=async()=>({data:[]});await empty.ready();const e=empty.api.add(empty.scopeIndex());empty.api.change(e,'project_id','p2');empty.api.change(e,'discipline','工程');
  assert.match(empty.html(),/该专业暂无本项目有效责任人/);assert.doesNotMatch(empty.html(),/模拟读取失败/);
});
