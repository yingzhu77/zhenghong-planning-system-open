import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const web=new URL('../web/',import.meta.url),source=await readFile(new URL('admin-plans.js',web),'utf8');
const target=(id='pm-a')=>({project_id:'anonymous-project',report_scope_id:null,project_name:'匿名住宅',project_type:'res',line:'工程',owner_id:id,owner_name:id==='pm-a'?'匿名甲':'匿名乙'});
const plan=(extra={})=>({id:'existing-plan',project_id:'anonymous-project',report_scope_id:null,line:'工程',owner_id:'pm-a',confirmed_by:'pm-a',plan_month:'2026-11-01',items:[{source_id:'original-item',mod:'主体',name:'原计划',due:'2026-11-20'}],editable:true,...extra});
function fixture({plans=[],importRows=[]}={}){
  const calls=[],notices=[],events={},S={uid:'admin',session:{},profile:{role:'ops',status:'approved'},view:'adminPlans',monthlyPlans:[]};
  const catalog={targets:[target(),target('pm-b')],plans},window={document:{getElementById:()=>null},crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789abc'},confirm:()=>true,addEventListener:(name,fn)=>events[name]=fn};
  window.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,json:async()=>({data:url.includes('/import?')?{rows:importRows,targets:catalog.targets,plans:catalog.plans,warnings:[]}:{...catalog}})};};window.window=window;
  vm.runInNewContext(source,{window,Map,Set,Date,Number,console});
  const options={S,esc:value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),render:()=>{},toast:(message)=>notices.push(message),refresh:async()=>true,
    request:async(url,body)=>{calls.push({url,body});const saved=body.plans.map((row,index)=>({...row,id:'saved-'+index,confirmed_by:row.owner_id,plan_month:row.month+'-01',editable:true}));catalog.plans=saved;return {data:{plans:saved}};}};
  window.AdminPlans.configure(options);
  return {ui:window.AdminPlans,S,window,catalog,calls,notices,events,options};
}
async function selectPerson(f,id='pm-a'){
  await f.ui.select('mode','manual');await f.ui.select('project',JSON.stringify(['anonymous-project','']));await f.ui.select('line','工程');await f.ui.select('owner',id);
}
function aiFixture({rows,questions=[],regions=[],canConfirm=true,handler}={}){
  const f=fixture(),designer={...target('pm-c'),line:'设计',owner_name:'匿名设计'};f.catalog.targets.push(designer);f.window.AbortController=AbortController;
  let snapshot={conversation_id:'anonymous-ai-conversation',revision:1,reply:'已识别整项目两个专业的月计划，尚未写入。',questions,unverified_regions:regions,complete:true,busy:false,coverage:[],unprocessed_rows:[],
    rows:rows || [{id:'ai-row-1',mod:'工程',name:'整项目工程事项',due:'2026-11-25',line:'工程',owner_id:'pm-a',source:{sheet:'工程计划',cell:'H9'},source_refs:[{sheet:'工程计划',cell:'H9'}],warnings:[]},
      {id:'ai-row-2',mod:'设计',name:'整项目设计事项',due:'2026-11-28',line:'设计',owner_id:'pm-c',source:{sheet:'设计计划',cell:'F7'},source_refs:[{sheet:'设计计划',cell:'F7'}],warnings:[]}],targets:f.catalog.targets,plans:f.catalog.plans,can_confirm:canConfirm,source:{name:'anonymous-all-project.xlsx'}};
  f.window.fetch=async(url,options={})=>{
    f.calls.push({url,options,json:typeof options.body==='string'?JSON.parse(options.body):null});
    if(url.startsWith('/api/admin-plans/context'))return {ok:true,json:async()=>({data:f.catalog})};
    const data=handler?await handler(url,options,snapshot):snapshot;return {ok:!data.error,json:async()=>data.error?data:{data}};
  };
  f.options.request=async(url,body)=>{f.calls.push({url,body});assert.equal(url,'/api/admin-plans/ai/confirm');const saved=body.modes.map((mode,index)=>({id:'ai-saved-'+index,project_id:'anonymous-project',line:mode.line,owner_id:mode.owner_id,confirmed_by:mode.owner_id,plan_month:'2026-11-01',editable:true,items:snapshot.rows.filter(row=>row.owner_id===mode.owner_id && row.line===mode.line)}));f.catalog.plans=saved;return {data:{...snapshot,confirmed:true,result:{plans:saved}}};};f.ui.configure(f.options);
  return {...f,get snapshot(){return snapshot;},setSnapshot(next){snapshot=next;}};
}
async function selectAIProject(f){await f.ui.load({type:'res',month:'2026-11',mode:'ai'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));}
const anonymousFile={name:'anonymous-all-project.xlsx',size:1024};

test('保存批次撤回核对完整月份范围，失败保留编辑，成功移除计划但不丢本窗口未保存输入',async()=>{
 const f=fixture({plans:[plan()]}),oldFetch=f.window.fetch;
 let withdrawn=false,fail=true,confirmation='';const record={actor_id:'admin',actor_name:'匿名管理员',operation_id:'12345678-1234-4234-8234-123456789abc',created_at:'2026-11-02T00:00:00Z',can_withdraw:true,withdrawn:false,blockers:[],records:[{kind:'plan',project_id:'anonymous-project',month:'2026-11',line:'工程',owner_name:'匿名甲',items:1},{kind:'summary',project_id:'anonymous-project',month:'2026-10',line:'工程',owner_name:'匿名甲',items:1}]};
 f.window.confirm=message=>{confirmation=message;return true;};
 f.window.fetch=async(url,options)=>url.includes('/batches?')?{ok:true,json:async()=>({data:{batches:[{...record,withdrawn,can_withdraw:!withdrawn,blockers:withdrawn?['本批次已撤回']:[]}],has_more:false}})}:oldFetch(url,options);
 f.options.request=async(url,body)=>{f.calls.push({url,body});if(fail)return {error:{message:'该批次已有引用，整批未撤回'}};withdrawn=true;f.catalog.plans=[];return {data:{withdrawn:true,removed_plan_ids:['existing-plan'],removed_summary_ids:[],plans:[],summaries:[]}};};
 await f.ui.load({type:'res',month:'2026-11',mode:'saved'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));f.ui.openSaved('plan','existing-plan');f.ui.edit(0,'name','撤回时也要保留的编辑');
 await selectPerson(f);f.ui.edit(0,'name','手工代填也要保留的草稿');
 await f.ui.select('mode','history');assert.match(f.ui.pageHtml(),/2026-10/);assert.match(f.ui.pageHtml(),/2026-11/);assert.equal(await f.ui.withdrawBatch(0),false);assert.match(confirmation,/2026-10/);assert.match(confirmation,/2026-11/);assert.match(f.ui.pageHtml(),/整批未撤回/);
 await f.ui.select('mode','saved');assert.match(f.ui.pageHtml(),/撤回时也要保留的编辑/);await f.ui.select('mode','history');fail=false;assert.equal(await f.ui.withdrawBatch(0),true);assert.match(f.ui.pageHtml(),/本批次已撤回/);assert.equal(await f.ui.withdrawBatch(0),false);
 const writes=f.calls.filter(call=>call.url.endsWith('/withdraw-batch'));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.deepEqual(Object.keys(writes[1].body).sort(),['actor_id','operation_id']);
 await f.ui.select('mode','saved');assert.match(f.ui.pageHtml(),/撤回时也要保留的编辑/);assert.equal(await f.ui.save(),false);
 await selectPerson(f);assert.match(f.ui.pageHtml(),/手工代填也要保留的草稿/);assert.equal(await f.ui.save(),false);
});

test('未选择项目仍可选Excel，文件随首次项目选择保留，只有明确读取才请求预览',async()=>{
  const f=fixture();await f.ui.load({type:'res',month:'2026-11'});
  let html=f.ui.pageHtml();assert.doesNotMatch(html,/<input id="admin-plan-file"[^>]* disabled/);assert.match(html,/请先在上方选择项目/);
  assert.equal(await f.ui.upload({files:[anonymousFile]}),true);assert.match(f.ui.pageHtml(),/anonymous-all-project.xlsx/);assert.equal(f.calls.filter(call=>call.url.includes('/import?')).length,0);
  await f.ui.select('project',JSON.stringify(['anonymous-project','']));assert.match(f.ui.pageHtml(),/anonymous-all-project.xlsx/);assert.equal(f.calls.filter(call=>call.url.includes('/import?')).length,0);
  await f.ui.startExcel();assert.equal(f.calls.filter(call=>call.url.includes('/import?')).length,1);
  await f.ui.select('month','2026-12');assert.doesNotMatch(f.ui.pageHtml(),/anonymous-all-project.xlsx/);
  await f.ui.select('month','2026-11');assert.match(f.ui.pageHtml(),/anonymous-all-project.xlsx/);
  f.S.uid='other-admin';f.ui.configure(f.options);assert.doesNotMatch(f.ui.pageHtml(),/anonymous-all-project.xlsx/);
});

test('AI也可先选择文件再选择项目，仍须明确开始识别，直接导入文件不串入AI',async()=>{
  const f=aiFixture();await f.ui.load({type:'res',month:'2026-11'});await f.ui.upload({files:[anonymousFile]});
  await f.ui.select('mode','ai');assert.doesNotMatch(f.ui.pageHtml(),/<b>anonymous-all-project.xlsx<\/b>/);
  await f.ui.upload({files:[{...anonymousFile,name:'chosen-before-project.xlsx'}]});assert.equal(f.calls.filter(call=>call.url.includes('/ai/upload')).length,0);
  await f.ui.select('project',JSON.stringify(['anonymous-project','']));assert.match(f.ui.pageHtml(),/chosen-before-project.xlsx/);
  await f.ui.startAI();assert.equal(f.calls.filter(call=>call.url.includes('/ai/upload')).length,1);
});

test('已保存计划入口保留原source_id与富文本，编辑分页和切换范围不丢输入，保存沿用旧版本校验',async()=>{
  const rows=Array.from({length:23},(_,i)=>({source_id:'original-'+i,mod:'工程',name:'原计划'+i,due:'2026-11-20'}));
  const f=fixture({plans:[plan({items:rows})]});
  vm.runInNewContext(await readFile(new URL('rich-text.js',web),'utf8'),{window:f.window});
  f.options.richCopy=f.window.ZHRichText.copy;f.options.richCollect=row=>f.window.ZHRichText.collect(JSON.parse(JSON.stringify(row)));f.ui.configure(f.options);
  await f.ui.load({type:'res',month:'2026-11',mode:'saved'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));
  assert.match(f.ui.pageHtml(),/修改月计划/);assert.equal(f.ui.openSaved('plan','existing-plan'),true);f.ui.pageHtml();
  f.ui.edit(0,'name','修改后计划');f.ui.binding('admin_plan_name_0').set({ops:[{insert:'修改后计划',attributes:{bold:true}}]});
  f.ui.page('saved',1);assert.match(f.ui.pageHtml(),/原计划22/);f.ui.edit(22,'due','2026-11-28');
  await f.ui.select('month','2026-12');assert.doesNotMatch(f.ui.pageHtml(),/修改后计划/);await f.ui.select('month','2026-11');f.ui.page('saved',-1);assert.match(f.ui.pageHtml(),/修改后计划/);
  assert.equal(await f.ui.save(),true);const body=f.calls.find(call=>call.url.endsWith('/save')).body;
  assert.equal(body.plans.length,1);assert.equal(body.plans[0].expected_plan_id,'existing-plan');assert.equal(body.plans[0].items.length,23);assert.equal(body.plans[0].items[0].source_id,'original-0');assert.equal(body.plans[0].items[22].due,'2026-11-28');assert.equal(body.plans[0].rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
});

test('已有引用或撤权后计划只读，独立汇总仍可修改，汇总只写summary并保留来源',async()=>{
  const f=fixture({plans:[plan({editable:false,lock_reason:'已有历史周报引用，不能修改'})]});
  f.catalog.summaries=[{...target(),id:'summary-old',month:'2026-11',items:[{source_id:'summary-original',mod:'主体',name:'原汇总事项',due:'2026-12-05',progress:'原完成情况'}]}];
  f.options.request=async(url,body)=>{f.calls.push({url,body:structuredClone(body)});f.catalog.summaries=body.summaries.map(row=>({...row,id:'summary-new'}));return {data:{plans:[],summaries:f.catalog.summaries}};};
  await f.ui.load({type:'res',month:'2026-11',mode:'saved'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));
  f.ui.openSaved('plan','existing-plan');assert.match(f.ui.pageHtml(),/已有历史周报引用/);f.ui.edit(0,'name','不应生效');assert.equal(await f.ui.save(),false);assert.equal(f.calls.some(call=>call.url.endsWith('/save')),false);
  f.ui.openSaved('summary','summary-old');assert.match(f.ui.pageHtml(),/原完成情况/);assert.doesNotMatch(f.ui.pageHtml(),/<textarea data-rich id="admin_plan_name/);
  f.ui.edit(0,'progress','核对后的月度完成情况');assert.equal(await f.ui.save(),true);const body=f.calls.find(call=>call.url.endsWith('/save')).body;
  assert.equal(body.plans.length,0);assert.equal(body.summaries[0].expected_summary_id,'summary-old');assert.equal(body.summaries[0].items[0].source_id,'summary-original');assert.equal(body.summaries[0].items[0].due,'2026-12-05');assert.equal(body.summaries[0].items[0].progress,'核对后的月度完成情况');
  f.catalog.targets=[];await f.ui.reload();assert.equal(await f.ui.save(),false);assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,1);
});

test('已保存内容修改失败可原样重试，刷新并发版本时保留输入及副本，不覆盖新记录',async()=>{
  const f=fixture({plans:[plan()]});let requests=0;
  f.options.request=async(url,body)=>{f.calls.push({url,body:structuredClone(body)});requests++;return {error:{message:requests===1?'网络结果未知':'服务器记录已经更新'}};};
  await f.ui.load({type:'res',month:'2026-11',mode:'saved'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));f.ui.openSaved('plan','existing-plan');f.ui.edit(0,'name','必须保留的修改');
  assert.equal(await f.ui.save(),false);assert.match(f.ui.pageHtml(),/必须保留的修改/);assert.equal(await f.ui.save(),false);
  const saves=f.calls.filter(call=>call.url.endsWith('/save'));assert.deepEqual(saves[0].body,saves[1].body);
  f.catalog.plans=[plan({id:'concurrent-plan',items:[{source_id:'new-source',mod:'工程',name:'另一窗口最新计划',due:''}]})];await f.ui.reload();
  assert.match(f.ui.pageHtml(),/版本已变化/);assert.match(f.ui.pageHtml(),/必须保留的修改/);assert.equal(await f.ui.save(),false);assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,2);
  assert.equal(await f.ui.savedLatest(),true);const html=f.ui.pageHtml();assert.match(html,/另一窗口最新计划/);assert.match(html,/载入前的未保存输入副本/);assert.match(html,/必须保留的修改/);
  let warned=false;f.events.beforeunload({preventDefault(){warned=true;}});assert.equal(warned,true,'the recovery copy also needs an unsaved-input warning');
  f.S.uid='another-admin';f.ui.configure(f.options);assert.doesNotMatch(f.ui.pageHtml(),/必须保留的修改|另一窗口最新计划/);
});

test('已保存内容修改的迟到回执不能进入切换后的账号，丢失记录也不能重建覆盖',async()=>{
  const f=fixture({plans:[plan()]});await f.ui.load({type:'res',month:'2026-11',mode:'saved'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));f.ui.openSaved('plan','existing-plan');f.ui.edit(0,'name','旧账号尚未保存的修改');
  f.catalog.plans=[];await f.ui.reload();assert.equal(await f.ui.save(),false);assert.match(f.ui.pageHtml(),/旧账号尚未保存的修改/);assert.equal(f.calls.some(call=>call.url.endsWith('/save')),false);
  f.catalog.plans=[plan()];await f.ui.reload();let resolveSave;f.options.request=()=>new Promise(resolve=>{resolveSave=resolve;});
  const saving=f.ui.save();f.S.uid='new-admin';f.ui.configure(f.options);resolveSave({data:{plans:[plan({id:'late-response',items:[{source_id:'original-item',mod:'工程',name:'旧账号迟到回执',due:''}]})]}});
  assert.equal(await saving,false);assert.doesNotMatch(f.ui.pageHtml(),/旧账号尚未保存的修改|旧账号迟到回执/);assert.equal(f.S.monthlyPlans.length,0);assert.equal(f.notices.length,0);
});
async function identify(f,file=anonymousFile){await f.ui.upload({files:[file]});return f.ui.startAI();}

test('良安田空专业目录只在对应深圳范围显示，选择不编制计划或借用已有提报人',async()=>{
  const f=fixture({plans:[plan()]}),scope='shenzhen-shangmugu-residential',project=JSON.stringify(['szzz',scope]);
  f.catalog.targets.push({...target(),project_id:'szzz',report_scope_id:scope,project_name:'匿名合并项目'});
  f.catalog.project_professions=[{project_id:'szzz',report_scope_id:scope,line:'良安田项目',assigned:false},
    {project_id:'szzz',report_scope_id:'another-scope',line:'不可串入的专业',assigned:false}];
  const original=JSON.stringify({targets:f.catalog.targets,plans:f.catalog.plans});
  await f.ui.load({type:'res',month:'2026-11'});await f.ui.select('project',project);
  let html=f.ui.pageHtml();assert.match(html,/良安田项目（未分配提报人）/);assert.match(html,/0 项计划/);assert.doesNotMatch(html,/不可串入的专业/);
  f.ui.filterPreview('line','良安田项目');assert.match(f.ui.pageHtml(),/aria-pressed="true"[^>]*onclick="AdminPlans.filterPreview/);
  await f.ui.select('mode','manual');await f.ui.select('line','良安田项目');await f.ui.reload();
  html=f.ui.pageHtml();assert.match(html,/暂不能编制或保存该专业计划/);assert.doesNotMatch(html,/id="admin_plan_name_/);assert.equal(await f.ui.save(),false);
  assert.equal(JSON.stringify({targets:f.catalog.targets,plans:f.catalog.plans}),original);assert.equal(f.calls.some(call=>/\/save$|\/confirm$/.test(call.url)),false);
  await f.ui.select('project',JSON.stringify(['anonymous-project','']));assert.doesNotMatch(f.ui.pageHtml(),/良安田项目|不可串入的专业/);
});

test('良安田目录刷新保留已上传事项与原归属，新专业无提报人仅展示并阻止保存',async()=>{
  const rows=[{id:'old-row',mod:'原分类',name:'原已上传事项',due:'2026-11-20',line:'工程',owner_id:'pm-a',warnings:[]},
    {id:'unassigned-row',mod:'设计分类',name:'新专业原表事项',due:'2026-11-28',line:'良安田项目',owner_id:null,line_hint:'良安田项目',warnings:[]}];
  const f=fixture({importRows:rows}),scope='shenzhen-shangmugu-residential';
  f.catalog.targets=[{...target(),project_id:'szzz',report_scope_id:scope,project_name:'匿名合并项目'}];
  await f.ui.load({type:'res',month:'2026-11'});await f.ui.select('project',JSON.stringify(['szzz',scope]));await f.ui.upload({files:[anonymousFile]});
  const sourceBefore=JSON.stringify(rows),targetsBefore=JSON.stringify(f.catalog.targets),firstSelect=()=>f.ui.pageHtml().match(/<select aria-label="第1项专业及提报人"[^>]*>([\s\S]*?)<\/select>/)[1];
  const oldAssignment=firstSelect().match(/<option[^>]* selected[^>]*>[^<]*<\/option>/)[0];
  f.catalog.project_professions=[{project_id:'szzz',report_scope_id:scope,line:'良安田项目',assigned:false}];await f.ui.reload();
  let html=f.ui.pageHtml();assert.match(html,/良安田项目（未分配提报人）/);assert.match(html,/原已上传事项/);assert.match(html,/新专业原表事项/);assert.match(html,/value="2026-11-28"/);assert.equal(firstSelect().match(/<option[^>]* selected[^>]*>[^<]*<\/option>/)[0],oldAssignment);
  const newSelect=html.match(/<select aria-label="第2项专业及提报人"[^>]*>([\s\S]*?)<\/select>/)[1];assert.match(newSelect,/<option[^>]* disabled selected>良安田项目（未分配提报人）<\/option>/);assert.doesNotMatch(newSelect,/<option[^>]* selected>工程/);
  f.ui.filterPreview('line','良安田项目');assert.match(f.ui.pageHtml(),/显示 1 \/ 2 项/);assert.equal(await f.ui.save(),false);f.ui.filterPreview('line','');
  assert.equal(JSON.stringify(rows),sourceBefore);assert.equal(JSON.stringify(f.catalog.targets),targetsBefore);assert.equal(f.calls.filter(call=>call.url.includes('/import?')).length,1);assert.equal(f.calls.some(call=>/\/save$|\/confirm$/.test(call.url)),false);
});

test('管理员Excel两入口允许300MB，超限保留预览并阻止发送',async()=>{
  const limit=300*1024*1024;
  const direct=fixture();await direct.ui.load({type:'res',month:'2026-11'});
  await direct.ui.select('project',JSON.stringify(['anonymous-project','']));
  const file={name:'anonymous-large.xlsx',size:limit};
  await direct.ui.upload({files:[file]});
  assert.equal(direct.calls.filter(call=>call.url.includes('/import?')).length,1);
  assert.equal(direct.calls.find(call=>call.url.includes('/import?')).options.body,file);
  await direct.ui.upload({files:[{...file,size:limit+1}]});
  assert.equal(direct.calls.filter(call=>call.url.includes('/import?')).length,1);
  assert.match(direct.ui.pageHtml(),/不能超过 300 MB/);
  assert.equal(direct.calls.some(call=>/\/save$|\/confirm$/.test(call.url)),false);
  const ai=aiFixture();await selectAIProject(ai);
  await ai.ui.upload({files:[file]});assert.match(ai.ui.pageHtml(),/最大 300 MB/);
  assert.equal(await ai.ui.startAI(),true);
  assert.equal(ai.calls.filter(call=>call.url.includes('/ai/upload?')).length,1);
  await ai.ui.upload({files:[{...file,size:limit+1}]});
  assert.match(ai.ui.pageHtml(),/不能超过 300 MB/);
  assert.equal(ai.calls.filter(call=>call.url.includes('/ai/upload?')).length,1);
});

test('AI remains an optional whole-project workflow and only explicit confirmation can save all matched professions at once',async()=>{
  const f=aiFixture();await selectAIProject(f);let html=f.ui.pageHtml();assert.match(html,/AI 整项目批量导入/);assert.doesNotMatch(html,/id="admin-plan-line"|id="admin-plan-owner"/);
  await f.ui.upload({files:[anonymousFile]});assert.equal(f.calls.some(row=>row.url.includes('/upload?')),false,'selecting a file does not call AI');assert.match(f.ui.pageHtml(),/id="admin-plan-ai-start"/);await f.ui.startAI();assert.equal(f.calls.filter(row=>/\/save$|\/confirm$/.test(row.url)).length,0);html=f.ui.pageHtml();assert.match(html,/整项目工程事项/);assert.match(html,/整项目设计事项/);assert.match(html,/所有专业合并预览/);
  assert.equal((html.match(/id="admin_plan_name_/g) || []).length,0,'AI preview stays readonly until advanced correction is opened');
  assert.equal(await f.ui.save(),true);const saved=f.calls.find(row=>row.url==='/api/admin-plans/ai/confirm').body;
  assert.equal(saved.expected_revision,1);assert.equal(saved.conversation_id,'anonymous-ai-conversation');assert.equal(saved.modes.length,2);assert.deepEqual(JSON.parse(JSON.stringify(saved.modes.map(row=>row.line))),['工程','设计']);assert.equal(saved.rows,undefined);assert.equal(saved.plans,undefined);
  assert.equal(f.S.uid,'admin');assert.equal(f.S.monthlyPlans.length,2);
});

test('administrator dialogue resolves an ambiguous mapping and preserves the previous full preview without writing plans',async()=>{
  const f=aiFixture({rows:[{id:'ai-row-1',mod:'工程',name:'待确认负责人事项',due:'2026-11-25',line:'工程',owner_id:null,source:{sheet:'计划',cell:'H9'},warnings:[]}],questions:['工程事项由谁提报？'],canConfirm:false,
    handler:async(url,options,snapshot)=>url.endsWith('/chat')?{...snapshot,revision:2,reply:'已按你的要求调整为匿名乙，请核对预览。',questions:[],can_confirm:true,rows:snapshot.rows.map(row=>({...row,owner_id:'pm-b'}))}:snapshot});
  await selectAIProject(f);await identify(f);assert.equal(await f.ui.save(),false);f.ui.aiInput('工程由匿名乙提报');assert.equal(await f.ui.sendAI(),true);
  const chat=f.calls.find(row=>row.url.endsWith('/chat')).json;assert.equal(chat.expected_revision,1);assert.equal(chat.messages[0].content,'工程由匿名乙提报');
  const html=f.ui.pageHtml();assert.match(html,/匿名乙/);assert.match(html,/保留的原预览副本/);assert.match(html,/&quot;target_key&quot;: &quot;&quot;/);assert.equal(f.calls.filter(row=>/\/confirm$|\/save$/.test(row.url)).length,0);
});

test('clear profession aliases are explained and an uncertain AI profession needs an explicit button before assignment',async()=>{
  const row={id:'unknown-source',mod:'专项计划',name:'匿名设计工作',line:null,owner_id:null,line_hint:'方案统筹',source:{sheet:'方案统筹',row:3},warnings:[],profession_suggestion:{line:'设计',owner_id:'pm-c',reason:'根据事项内容建议，请确认。',requires_confirmation:true}};
  const f=aiFixture({rows:[row],canConfirm:false,handler:async(url,options,snapshot)=>{
    if(!url.endsWith('/revise'))return snapshot;
    const body=JSON.parse(options.body);return {...snapshot,revision:2,can_confirm:true,rows:snapshot.rows.map(original=>({...original,...body.changes[0],profession_suggestion:null,profession_mapping:{source_label:'方案统筹',line:'设计',basis:'manual',requires_confirmation:false}}))};
  }});
  await selectAIProject(f);await identify(f);assert.match(f.ui.pageHtml(),/确认归为设计 · 匿名设计/);assert.equal(f.calls.some(call=>call.url.endsWith('/revise')),false);assert.equal(await f.ui.save(),false);
  assert.equal(await f.ui.confirmProfession(0),true);const request=f.calls.find(call=>call.url.endsWith('/revise')).json;
  assert.deepEqual(request.changes,[{id:'unknown-source',line:'设计',owner_id:'pm-c'}]);assert.equal(request.expected_revision,1);assert.doesNotMatch(f.ui.pageHtml(),/AI 建议归为/);assert.equal(f.calls.some(call=>call.url.endsWith('/confirm')),false);
  const alias=aiFixture({rows:[{...row,line:'工程',owner_id:'pm-a',profession_suggestion:null,profession_mapping:{source_label:'工程部',line:'工程',basis:'alias',requires_confirmation:false}}]});await selectAIProject(alias);await identify(alias);assert.match(alias.ui.pageHtml(),/已按专业别名对应：工程部 → 工程/);
});

test('profession suggestion with multiple reporters confirms only its line and never picks the first person',async()=>{
  const f=aiFixture({rows:[{id:'unknown',name:'待确认事项',line:null,owner_id:null,line_hint:'施工协调',warnings:[],profession_suggestion:{line:'工程',reason:'请核对',requires_confirmation:true}}],canConfirm:false});await selectAIProject(f);await identify(f);
  assert.match(f.ui.pageHtml(),/确认归为工程，再选择提报人/);await f.ui.confirmProfession(0);const request=f.calls.find(call=>call.url.endsWith('/revise')).json;assert.deepEqual(request.changes,[{id:'unknown',line:'工程',owner_id:null}]);assert.equal(f.calls.some(call=>call.url.endsWith('/confirm')),false);
});

test('unknown worksheet month requires an explicit region confirmation and cannot be satisfied by AI suggestions alone',async()=>{
  const f=aiFixture({regions:[{id:'region-1',sheet:'未标月份计划',bounds:'A4:H18',month:'2026-11'}],questions:['请核对未标月份范围'],canConfirm:false,
    handler:async(url,options,snapshot)=>url.endsWith('/revise')?{...snapshot,revision:2,can_confirm:true,unverified_regions:[],questions:[],reply:'已记录你确认的月份范围。'}:snapshot});
  await selectAIProject(f);await identify(f);assert.match(f.ui.pageHtml(),/确认 未标月份计划 A4:H18 为 2026-11 月计划/);assert.equal(await f.ui.save(),false);
  f.ui.selectRegion('region-1',true);assert.equal(await f.ui.reviseAI(true),true);const correction=f.calls.find(row=>row.url.endsWith('/revise')).json;
  assert.deepEqual(correction.region_confirmations,[{region_id:'region-1',month:'2026-11'}]);assert.deepEqual(correction.changes,[]);assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('advanced AI correction is staged until revise persists the exact candidate revision before final import',async()=>{
  const f=aiFixture({handler:async(url,options,snapshot)=>{if(!url.endsWith('/revise'))return snapshot;const body=JSON.parse(options.body);return {...snapshot,revision:2,reply:'手动纠正已应用到预览。',rows:snapshot.rows.map(row=>({...row,...body.changes.find(change=>change.id===row.id)}))};}});
  await selectAIProject(f);await identify(f);f.ui.toggleAdvanced();f.ui.setMapping(0,JSON.stringify(['anonymous-project','','工程','pm-b']));f.ui.edit(0,'name','管理员明确修正的事项');
  assert.equal(await f.ui.save(),false);f.ui.aiInput('继续核对');assert.equal(await f.ui.sendAI(),false);assert.equal(await f.ui.reviseAI(false),true);
  const patch=f.calls.find(row=>row.url.endsWith('/revise')).json;assert.equal(patch.expected_revision,1);assert.equal(patch.changes[0].id,'ai-row-1');assert.equal(patch.changes[0].owner_id,'pm-b');assert.equal(patch.changes[0].name,'管理员明确修正的事项');
  assert.match(f.ui.pageHtml(),/管理员明确修正的事项/);assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('switching a month or account cancels AI and ignores late upload output without crossing preview scope',async()=>{
  for(const change of ['month','account']){
    let finish;const f=aiFixture({handler:async(url,options,snapshot)=>url.includes('/upload?')?new Promise(resolve=>{finish=()=>resolve({...snapshot,reply:'迟到的旧范围秘密',rows:snapshot.rows.map(row=>({...row,name:'迟到旧范围事项'}))});}):snapshot});
    await selectAIProject(f);await f.ui.upload({files:[anonymousFile]});const upload=f.ui.startAI();const sent=f.calls.find(row=>row.url.includes('/upload?'));
    if(change==='month')await f.ui.select('month','2026-12');else{f.S.uid='second-admin';f.S.session={};f.ui.configure(f.options);}
    assert.equal(sent.options.signal.aborted,true);finish();assert.equal(await upload,false);assert.doesNotMatch(f.ui.pageHtml(),/迟到旧范围事项|迟到的旧范围秘密/);
    assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
  }
});

test('AI, rule preview and manual drafts remain separately recoverable when changing workflow or an AI request fails',async()=>{
  const f=aiFixture({handler:async()=>({error:{message:'匿名 AI 不可用'}})});await selectAIProject(f);await selectPerson(f);f.ui.edit(0,'name','原手工未保存输入');await f.ui.select('mode','excel');
  const old=f.window.fetch;f.window.fetch=async(url,options)=>url.includes('/import?')?{ok:true,json:async()=>({data:{rows:[{name:'原规则预览事项',mod:'工程',line:'工程',owner_id:'pm-a',due:'2026-11-25'}],targets:f.catalog.targets,plans:[]}})}:old(url,options);
  await f.ui.upload({files:[anonymousFile]});await f.ui.select('mode','ai');assert.equal(await identify(f),false);await f.ui.select('mode','excel');assert.match(f.ui.pageHtml(),/原规则预览事项/);
  await f.ui.select('mode','manual');await f.ui.select('line','工程');await f.ui.select('owner','pm-a');assert.match(f.ui.pageHtml(),/原手工未保存输入/);
});

test('pending source rows and parser warnings remain visible and incomplete extraction cannot confirm even if a response claims ready',async()=>{
  const f=aiFixture({handler:async(url,options,snapshot)=>url.endsWith('/chat')?{...snapshot,revision:2,complete:true,can_confirm:true,unprocessed_rows:[],coverage:[{region_id:'r1',sheet:'计划',required_rows:[9,10],handled_rows:[9,10],pending_rows:[]}],reply:'已继续核对遗漏源行。'}:snapshot});
  f.setSnapshot({...f.snapshot,complete:false,can_confirm:true,coverage:[{region_id:'r1',sheet:'计划',required_rows:[9,10],handled_rows:[9],pending_rows:[10]}],unprocessed_rows:[{id:'pending-10',source:{sheet:'计划',row:10},cells:[{id:'cell-10',cell:'H10',text:'<script>不能遗漏的源行</script>'}]}],warnings:[{code:'formula_error',message:'公式错误行未作为计划导入',source:{sheet:'计划',cell:'G11'}}]});
  await selectAIProject(f);await identify(f);assert.match(f.ui.pageHtml(),/已处理 1 \/ 2 行源内容/);assert.match(f.ui.pageHtml(),/&lt;script&gt;不能遗漏的源行&lt;\/script&gt;/);assert.match(f.ui.pageHtml(),/公式错误行未作为计划导入/);assert.equal(await f.ui.save(),false);
  assert.equal(await f.ui.continueAI(),true);assert.match(f.ui.pageHtml(),/已处理 2 \/ 2 行源内容/);assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('cancelled dialogue requires an explicit session sync and a confirmed receipt is shown as saved without another write',async()=>{
  let finish;const f=aiFixture({handler:async(url,options,snapshot)=>{
    if(url.endsWith('/chat')){f.setSnapshot({...snapshot,revision:2,reply:'服务器已整理但响应被取消。'});return new Promise(resolve=>{finish=()=>resolve(f.snapshot);});}
    return snapshot;
  }});
  await selectAIProject(f);await identify(f);f.ui.aiInput('核对负责人');const pending=f.ui.sendAI();f.ui.cancelAI();finish();assert.equal(await pending,false);assert.equal(await f.ui.save(),false);
  const saved=[{...plan(),id:'canonical-saved-ai-plan'}];f.setSnapshot({...f.snapshot,confirmed:true,can_confirm:false,result:{plans:saved},reply:'本轮已保存，不会重复导入。'});
  assert.equal(await f.ui.syncAI(),true);const sync=f.calls.find(row=>row.url.endsWith('/session'));assert.equal(sync.options.method,'POST');assert.equal(sync.json.conversation_id,'anonymous-ai-conversation');
  assert.match(f.ui.pageHtml(),/本次已导入 1 份月计划/);assert.equal(f.S.monthlyPlans[0].id,'canonical-saved-ai-plan');assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('a successful replacement upload closes only the replaced AI session while keeping its old preview readable',async()=>{
  let uploaded=0;const f=aiFixture({handler:async(url,options,snapshot)=>url.endsWith('/close')?{closed:true}:url.includes('/upload?')?{...snapshot,conversation_id:'ai-session-'+(++uploaded),reply:'新文件识别预览 '+uploaded}:snapshot});
  await selectAIProject(f);await identify(f);assert.equal(f.calls.some(row=>row.url.endsWith('/close')),false);
  await identify(f,{...anonymousFile,name:'second-anonymous.xlsx'});const close=f.calls.find(row=>row.url.endsWith('/close'));assert.equal(close.json.conversation_id,'ai-session-1');assert.match(f.ui.pageHtml(),/保留的原预览副本/);
  assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('selected AI files survive failed requests and cancellation, retry only on explicit start, and stay scoped to month and account',async()=>{
  let attempts=0;const f=aiFixture({handler:async(url,options,snapshot)=>url.includes('/upload?')&&++attempts===1?{error:{message:'连接暂时失败，尚未生成预览'}}:snapshot});
  await selectAIProject(f);await f.ui.upload({files:[anonymousFile]});assert.equal(attempts,0);assert.equal(await f.ui.startAI(),false);assert.match(f.ui.pageHtml(),/重试识别所选文件/);
  assert.equal(await f.ui.startAI(),true);const uploads=f.calls.filter(row=>row.url.includes('/upload?'));assert.equal(uploads.length,2);assert.equal(uploads[0].options.body,anonymousFile);assert.equal(uploads[1].options.body,anonymousFile);
  await f.ui.select('month','2026-12');assert.doesNotMatch(f.ui.pageHtml(),/已保留所选文件/);await f.ui.select('month','2026-11');assert.match(f.ui.pageHtml(),/已保留所选文件/);
  f.S.uid='different-admin';f.S.session={};f.ui.configure(f.options);await selectAIProject(f);assert.doesNotMatch(f.ui.pageHtml(),/已保留所选文件/);assert.equal(await f.ui.startAI(),false);assert.equal(uploads.length,2);
});

test('provider failure keeps parsed rows and retries the existing AI session without reupload or clearing a pending message',async()=>{
  const f=aiFixture({handler:async(url,options,snapshot)=>url.endsWith('/chat')?{...snapshot,revision:1,ai_status:'ready',ai_error:null,complete:true,can_confirm:true}:snapshot});
  f.setSnapshot({...f.snapshot,revision:0,ai_status:'needs_retry',ai_error:{code:'ai_timeout',message:'AI 暂未完成，原表预览已保留。'},complete:false,can_confirm:false});
  await selectAIProject(f);await identify(f);f.ui.aiInput('用户尚未发送的补充原文');assert.match(f.ui.pageHtml(),/原表已读取，AI 整理暂未完成/);assert.match(f.ui.pageHtml(),/整项目工程事项/);assert.equal(await f.ui.save(),false);
  assert.equal(await f.ui.retryAI(),true);assert.equal(f.calls.filter(row=>row.url.includes('/upload?')).length,1);const chat=f.calls.find(row=>row.url.endsWith('/chat'));assert.equal(chat.json.conversation_id,'anonymous-ai-conversation');assert.equal(chat.json.expected_revision,0);assert.match(f.ui.pageHtml(),/用户尚未发送的补充原文/);assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('ambiguous profession cards require an explicit system reporter choice and keep original work owners only as source references',async()=>{
  const rows=[{id:'eng-1',mod:'工程',name:'工程一',line:'工程',owner_id:null,reporter_hint:'原负责人甲',source:{sheet:'工程',row:8},warnings:[],exclusion_reason:'工程专业有多位授权提报人，请明确选择'},
    {id:'eng-2',mod:'工程',name:'工程二',line:'工程',owner_id:null,reporter_hint:'原负责人乙',source:{sheet:'工程',row:9},warnings:[]},
    {id:'design-1',mod:'设计',name:'设计一',line:'设计',owner_id:'pm-c',source:{sheet:'设计',row:5},warnings:[]}];
  const f=aiFixture({rows,canConfirm:false,questions:[{text:'工程由谁填报？',row_ids:['eng-1','eng-2']}],handler:async(url,options,snapshot)=>{
    if(!url.endsWith('/revise'))return snapshot;const changes=JSON.parse(options.body).changes;return {...snapshot,revision:2,can_confirm:true,questions:[],rows:snapshot.rows.map(row=>({...row,...changes.find(change=>change.id===row.id)}))};}});
  await selectAIProject(f);await identify(f);let html=f.ui.pageHtml();assert.equal((html.match(/class="admin-plan-assignment-card"/g)||[]).length,1);assert.match(html,/本专业有 2 位已授权提报人，请明确选择/);assert.match(html,/原表工作责任人（参考）：原负责人甲/);assert.doesNotMatch(html.match(/<article class="admin-plan-assignment-card">[\s\S]*?<\/article>/)[0],/原负责人甲|原负责人乙/);assert.equal(f.calls.some(row=>row.url.endsWith('/revise')),false);assert.equal((html.match(/id="admin_plan_name_/g)||[]).length,0);
  assert.equal(await f.ui.applyAssignment(0),false);f.ui.chooseAssignment(0,JSON.stringify(['anonymous-project','','工程','pm-a']));assert.equal(await f.ui.applyAssignment(0),true);const changes=f.calls.find(row=>row.url.endsWith('/revise')).json.changes;assert.deepEqual(JSON.parse(JSON.stringify(changes.map(row=>row.id))),['eng-1','eng-2']);assert.ok(changes.every(row=>row.owner_id==='pm-a'&&row.line==='工程'));assert.match(f.ui.pageHtml(),/识别说明：工程专业有多位授权提报人，请明确选择/);assert.doesNotMatch(f.ui.pageHtml(),/排除原因：工程专业有多位授权提报人/);assert.equal(f.calls.some(row=>row.url.endsWith('/confirm')),false);
});

test('profession and pending filters keep all thirty AI candidates and paginate only the view, while confirmation saves every profession',async()=>{
  const lines=['工程','设计','成本','招采','客服'],targets=lines.map((line,index)=>({...target('person-'+index),line,owner_name:'匿名'+line})),rows=lines.flatMap((line,index)=>Array.from({length:6},(_,at)=>({id:line+'-'+at,mod:line,name:line+'原始事项'+at,due:'2026-11-28',line,owner_id:targets[index].owner_id,match_basis:'project_line_unique',reporter_hint:at?'原表不同工作责任人':'',source:{sheet:line,row:at+3},warnings:[]})));
  const f=aiFixture({rows});f.catalog.targets.splice(0,f.catalog.targets.length,...targets);await selectAIProject(f);await identify(f);let html=f.ui.pageHtml();assert.match(html,/5 个专业 · 30 项计划/);assert.match(html,/已分配 30 项 · 待确认 0 项/);assert.match(html,/按项目和专业匹配提报人/);assert.doesNotMatch(html,/原表未填负责人，按专业建议，请核对|class="admin-plan-assignment-card"/);assert.match(html,/原表工作责任人（参考）：原表不同工作责任人/);assert.equal((html.match(/class="admin-plan-source-details"/g)||[]).length,20);assert.doesNotMatch(html,/<details class="admin-plan-source-details"[^>]*open/);
  f.ui.page('excel',1);assert.match(f.ui.pageHtml(),/客服原始事项5/);f.ui.filterPreview('line','成本');html=f.ui.pageHtml();assert.match(html,/显示 6 \/ 30 项/);assert.equal((html.match(/class="admin-plan-source-details"/g)||[]).length,6);f.ui.filterPreview('pending',true);assert.match(f.ui.pageHtml(),/当前筛选下没有事项，完整预览仍保留/);
  assert.equal(await f.ui.save(),true);assert.equal(f.calls.find(row=>row.url.endsWith('/confirm')).body.modes.length,5);assert.equal(f.S.monthlyPlans.reduce((sum,plan)=>sum+plan.items.length,0),30);
});

test('missing or unknown professions cannot fall back to reporters in another profession on assignment cards',async()=>{
  for(const line of ['工程','']){
    const f=aiFixture({rows:[{id:'no-target',mod:'计划事项',name:'授权归属待核对',line,owner_id:null,source:{sheet:'本月计划',row:3},warnings:[]}],canConfirm:false});f.catalog.targets.splice(0,2);await selectAIProject(f);await identify(f);let html=f.ui.pageHtml(),card=html.match(/<article class="admin-plan-assignment-card">[\s\S]*?<\/article>/)[0];
    assert.match(card,/本专业暂无已授权提报人/);assert.match(card,/展开手动纠正/);assert.doesNotMatch(card,/匿名设计|设计 ·/);assert.match(card,/<select[^>]* disabled>/);
    f.ui.chooseAssignment(0,JSON.stringify(['anonymous-project','','设计','pm-c']));assert.equal(await f.ui.applyAssignment(0),false);assert.equal(f.calls.some(call=>call.url.endsWith('/revise')),false);assert.equal(await f.ui.save(),false);
    f.ui.toggleAdvanced();html=f.ui.pageHtml();assert.match(html,/第1项专业及提报人/);assert.match(html,/设计 · 匿名设计/,'changing the profession remains an explicit advanced correction');
  }
});

test('three explicit professional assignments retain questions until a separate AI review, and filtered confirmation still saves all thirty rows',async()=>{
  const lines=['工程','开发报建','成本','招采','客服'],counts=[5,6,6,6,7],targets=lines.map((line,i)=>({...target('owner-'+i),line,owner_name:'匿名'+line}));
  const rows=lines.flatMap((line,i)=>Array.from({length:counts[i]},(_,at)=>({id:'review-'+i+'-'+at,mod:line,name:'匿名'+line+'事项'+at,due:'2026-11-28',line,owner_id:(i===0&&at>0||i===2&&at>0||i===3)?null:targets[i].owner_id,reporter_hint:i===4?'':'匿名原表负责人',source:{sheet:line,row:at+3},warnings:[]})));
  const questions=[0,2,3].map(i=>({id:'assign-'+i,text:'请确认匿名'+lines[i]+'提报人',row_ids:rows.filter(r=>r.line===lines[i]&&!r.owner_id).map(r=>r.id)}));let f;
  f=aiFixture({rows,questions,canConfirm:false,handler:async(url,options,snapshot)=>{
    let next=snapshot;
    if(url.endsWith('/revise')){const changes=JSON.parse(options.body).changes;next={...snapshot,revision:snapshot.revision+1,rows:snapshot.rows.map(row=>{const patch=changes.find(c=>c.id===row.id);return patch?{...row,...patch,manual_fields:['owner_id','line']}:row;})};}
    if(url.endsWith('/chat')){const message=JSON.parse(options.body).messages[0].content;assert.match(message,/明确确认以下分配/);assert.match(message,/工程 4 项/);assert.match(message,/成本 5 项/);assert.match(message,/招采 6 项/);assert.doesNotMatch(message,/开发报建 6 项|客服 7 项/,'only actual manual choices are described as confirmed');next={...snapshot,revision:snapshot.revision+1,can_confirm:true,questions:[],reply:'已保留人工确认分配，等待最后核对与确认。'};}
    f.setSnapshot(next);return next;
  }});f.catalog.targets.splice(0,f.catalog.targets.length,...targets,...[0,2,3].map(i=>({...targets[i],owner_id:'peer-'+i,owner_name:'匿名同专业备选'+i})));
  await selectAIProject(f);await identify(f);assert.equal((f.ui.pageHtml().match(/class="admin-plan-assignment-card"/g)||[]).length,3);assert.doesNotMatch(f.ui.pageHtml(),/id="admin-plan-ai-review"/);
  for(const i of [0,2,3]){f.ui.chooseAssignment(0,JSON.stringify(['anonymous-project','',lines[i],targets[i].owner_id]));assert.equal(await f.ui.applyAssignment(0),true);}
  assert.equal(f.snapshot.questions.length,3,'mapping alone cannot clear unrelated model questions');assert.equal(await f.ui.save(),false);assert.match(f.ui.pageHtml(),/id="admin-plan-ai-review"/);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/chat')).length,0);assert.equal(await f.ui.reviewAssignments(),true);assert.equal(f.snapshot.questions.length,0);assert.equal(f.calls.filter(c=>c.url.endsWith('/chat')).length,1);
  f.ui.filterPreview('line','成本');assert.match(f.ui.pageHtml(),/显示 6 \/ 30 项/);assert.equal(f.calls.some(c=>c.url.endsWith('/confirm')),false);assert.equal(await f.ui.save(),true);
  assert.equal(f.calls.find(c=>c.url.endsWith('/confirm')).body.modes.length,5);assert.equal(f.S.monthlyPlans.reduce((n,p)=>n+p.items.length,0),30);
});

test('AI import blockers show referenced and append-or-replace conflicts before the final button is pressed',async()=>{
  const f=aiFixture();f.catalog.plans.push(plan());await selectAIProject(f);await identify(f);let html=f.ui.pageHtml();assert.match(html,/工程 · 匿名甲：请选择追加或替换/);assert.match(html,/onclick="AdminPlans.save\(\)" disabled/);
  f.ui.choice(JSON.stringify(['anonymous-project','','工程','pm-a']),'append');assert.doesNotMatch(f.ui.pageHtml(),/工程 · 匿名甲：请选择追加或替换/);
  f.catalog.plans[0].editable=false;f.catalog.plans[0].lock_reason='已被周报引用';assert.match(f.ui.pageHtml(),/工程 · 匿名甲：已被周报引用/);assert.match(f.ui.pageHtml(),/onclick="AdminPlans.save\(\)" disabled/);
});

test('elapsed AI feedback updates a text node without rerendering or losing input and is stopped on cancellation',async()=>{
  let finish,tick,stopped=0,renders=0;const f=aiFixture({handler:async(url,options,snapshot)=>url.includes('/upload?')?new Promise(resolve=>{finish=()=>resolve(snapshot);}):snapshot});
  f.window.setInterval=callback=>{tick=callback;return 7;};f.window.clearInterval=id=>{assert.equal(id,7);stopped++;};f.options.render=()=>{renders++;};f.ui.configure(f.options);await selectAIProject(f);await f.ui.upload({files:[anonymousFile]});const pending=f.ui.startAI(),before=renders,node={textContent:''};f.window.document.getElementById=id=>id==='admin-plan-ai-elapsed'?node:null;tick();assert.match(node.textContent,/秒|分/);assert.equal(renders,before);f.ui.cancelAI();assert.equal(stopped,1);finish();assert.equal(await pending,false);assert.match(f.ui.pageHtml(),/已保留所选文件/);
});

test('admin manual draft is isolated by actual recipient, preserves edits on navigation, and saves the reporter canonical owner',async()=>{
  const f=fixture();await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);f.ui.edit(0,'name','甲的未提交计划');
  await f.ui.select('owner','pm-b');f.ui.edit(0,'name','乙的未提交计划');await f.ui.select('owner','pm-a');
  assert.match(f.ui.pageHtml(),/甲的未提交计划/);assert.doesNotMatch(f.ui.pageHtml(),/乙的未提交计划/);
  let prevented=false;f.events.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  assert.equal(await f.ui.save(),true);
  const saved=f.calls.find(row=>row.url==='/api/admin-plans/save').body;
  assert.equal(saved.plans[0].owner_id,'pm-a');assert.equal(saved.plans[0].expected_plan_id,null);assert.equal(saved.plans[0].items[0].name,'甲的未提交计划');
  assert.equal(f.S.uid,'admin');assert.equal(f.S.profile.role,'ops');assert.equal(f.S.monthlyPlans[0].owner_id,'pm-a');
});

test('Excel upload only previews; ambiguous owner stays unassigned and existing plans require explicit append or replace',async()=>{
  const f=fixture({plans:[plan()],importRows:[{mod:'工程',name:'新增事项',due:'2026-11-25',standard:'达到验收标准',reporter_hint:'重名负责人',line_hint:'工程',owner_id:null,line:null,source:{sheet:'11月计划',row:9,cell:'G9'},warnings:[]}]});
  await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);await f.ui.select('mode','excel');
  await f.ui.upload({files:[{name:'anonymous.xlsx',size:100}]});
  assert.equal(f.calls.filter(row=>row.url==='/api/admin-plans/save').length,0);assert.match(f.ui.pageHtml(),/仅预览，尚未写入任何计划/);assert.match(f.ui.pageHtml(),/待分配 1 项/);
  assert.equal(await f.ui.save(),false);
  f.ui.setMapping(0,JSON.stringify(['anonymous-project','','工程','pm-a']));assert.equal(await f.ui.save(),false);
  f.ui.choice(JSON.stringify(['anonymous-project','','工程','pm-a']),'append');assert.equal(await f.ui.save(),true);
  const saved=f.calls.find(row=>row.url==='/api/admin-plans/save').body;
  assert.equal(saved.plans[0].expected_plan_id,'existing-plan');assert.equal(saved.plans[0].items.length,2);
  assert.equal(saved.plans[0].items[1].name,'新增事项\n完成标准：达到验收标准');
});

test('default whole-project Excel import previews and saves every profession without an AI request',async()=>{
  const f=fixture({importRows:[
    {mod:'主体',name:'匿名工程月计划',due:'2026-11-25',line:'工程',owner_id:'pm-a',source:{sheet:'工程部',row:3},warnings:[]},
    {mod:'方案',name:'匿名设计月计划',due:'',line:'设计',owner_id:'pm-c',source:{sheet:'设计部',row:4},warnings:[]}
  ]});
  f.catalog.targets.splice(0,f.catalog.targets.length,target(),{...target('pm-c'),line:'设计',owner_name:'匿名设计'});
  await f.ui.load({type:'res',month:'2026-11'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));
  let html=f.ui.pageHtml();assert.match(html,/aria-pressed="true"[^>]*>Excel 直接导入/);assert.doesNotMatch(html,/id="admin-plan-line"|id="admin-plan-owner"|id="admin-plan-ai-start"/);
  await f.ui.upload({files:[anonymousFile]});assert.equal(f.calls.filter(call=>call.url.startsWith('/api/admin-plans/import?')).length,1);
  html=f.ui.pageHtml();assert.match(html,/2 个专业 · 2 项计划/);assert.match(html,/匿名工程月计划/);assert.match(html,/匿名设计月计划/);assert.match(html,/已分配 2 项 · 待确认 0 项/);
  assert.equal(f.calls.some(call=>/\/save$|\/confirm$/.test(call.url)),false,'upload is a preview until final confirmation');
  f.ui.filterPreview('line','设计');assert.match(f.ui.pageHtml(),/显示 1 \/ 2 项/);assert.equal(await f.ui.save(),true);
  const saved=f.calls.find(call=>call.url==='/api/admin-plans/save').body;assert.equal(saved.plans.length,2);assert.equal(saved.plans.reduce((count,row)=>count+row.items.length,0),2,'view filters never restrict the final import');
  assert.equal(saved.plans.find(row=>row.line==='设计').items[0].due,'','a source without a single due date remains allowed');
  assert.equal(f.calls.some(call=>call.url.includes('/ai/')),false,'the complete direct-import workflow does not depend on AI');
});

test('one Excel profession confirmation updates all suggestions locally, preserves manual edits and leaves multiple reporters unassigned',async()=>{
  const suggestion=(id,source,line)=>({id,mod:'专项',name:id+'原事项',due:'2026-11-25',line:null,owner_id:null,line_hint:source,source:{sheet:source,row:3},warnings:[],profession_suggestion:{line,reason:'根据表内范围建议，请核对。',requires_confirmation:true}});
  const f=fixture({importRows:[suggestion('manual','人工另选专业','设计'),suggestion('design','方案统筹','设计'),suggestion('cost','合约','成本'),suggestion('engineering','施工统筹','工程')]});
  f.catalog.targets.push({...target('pm-c'),line:'设计',owner_name:'匿名设计'},{...target('pm-d'),line:'成本',owner_name:'匿名成本'});
  await f.ui.load({type:'res',month:'2026-11'});await f.ui.select('project',JSON.stringify(['anonymous-project','']));await f.ui.upload({files:[anonymousFile]});
  f.ui.setMapping(0,JSON.stringify(['anonymous-project','','工程','pm-b']));f.ui.edit(0,'name','管理员保留的原文修订');f.ui.edit(0,'due','2026-11-29');
  assert.match(f.ui.pageHtml(),/确认以上 3 组专业建议（3 项）/);const before=f.calls.length;assert.equal(await f.ui.confirmAllProfessions(),true);assert.equal(f.calls.length,before,'confirming profession suggestions only changes the browser preview');
  let html=f.ui.pageHtml();assert.doesNotMatch(html,/确认以上 .*组专业建议/);assert.match(html,/管理员保留的原文修订/);assert.match(html,/已分配 3 项 · 待确认 1 项/);assert.equal(await f.ui.save(),false,'the engineering row still needs an explicit choice among two reporters');
  assert.equal(f.calls.some(call=>/\/save$|\/confirm$|\/revise$/.test(call.url)),false);
  f.ui.filterPreview('line','工程');html=f.ui.pageHtml();assert.match(html,/显示 2 \/ 4 项/);assert.match(html,/value="2026-11-29"/);const unassigned=html.match(/<select aria-label="第4项专业及提报人"[^>]*>([\s\S]*?)<\/select>/)[1];assert.match(unassigned,/^<option value="">/);assert.doesNotMatch(unassigned,/ selected/,'neither of the two engineering reporters is selected by the bulk confirmation');
  f.ui.setMapping(3,JSON.stringify(['anonymous-project','','工程','pm-a']));assert.equal(await f.ui.save(),true);
  const saved=f.calls.find(call=>call.url==='/api/admin-plans/save').body;assert.equal(saved.plans.length,4);
  const manual=saved.plans.find(row=>row.owner_id==='pm-b');assert.equal(manual.line,'工程');assert.equal(manual.items[0].name,'管理员保留的原文修订');assert.equal(manual.items[0].due,'2026-11-29');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.plans.filter(row=>row.line!=='工程').map(row=>[row.line,row.owner_id]))),[['设计','pm-c'],['成本','pm-d']]);assert.equal(f.calls.some(call=>call.url.includes('/ai/')),false);
});

test('large import previews page rich editors, preserve selections when changing project, and save every selected row',async()=>{
  const rows=Array.from({length:45},(_,index)=>({mod:'工程',name:'匿名事项'+index,due:'2026-11-25',owner_id:'pm-a',line:'工程',reporter_hint:'匿名甲',line_hint:'工程',source:{sheet:'计划',row:index+2},warnings:[]}));
  const f=fixture({importRows:rows});await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);await f.ui.select('mode','excel');await f.ui.upload({files:[{name:'anonymous.xlsx',size:100}]});
  assert.equal((f.ui.pageHtml().match(/id="admin_plan_name_/g) || []).length,20);f.ui.edit(0,'name','修改后的首项');f.ui.page('excel',1);
  assert.match(f.ui.pageHtml(),/第 2 \/ 3 页/);assert.match(f.ui.pageHtml(),/匿名事项20/);f.ui.edit(20,'name','第二页已修改');
  await f.ui.select('project','');await f.ui.select('project',JSON.stringify(['anonymous-project','']));f.ui.page('excel',-1);assert.match(f.ui.pageHtml(),/修改后的首项/);
  assert.equal(await f.ui.save(),true);const saved=f.calls.find(row=>row.url==='/api/admin-plans/save').body.plans[0];assert.equal(saved.items.length,45);assert.equal(saved.items[20].name,'第二页已修改');
});

test('advanced rule import groups by profession regardless of original work-owner names and maps the complete profession together',async()=>{
  const rows=['原表责任人甲','原表责任人乙',''].map((reporter_hint,index)=>({mod:'土建',name:'同专业原始计划'+index,line:'工程',line_hint:'工程',owner_id:null,reporter_hint,source:{sheet:'工程月计划',row:index+3},warnings:[]}));
  const f=fixture({importRows:rows});await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);await f.ui.select('mode','excel');await f.ui.upload({files:[anonymousFile]});let html=f.ui.pageHtml();assert.equal((html.match(/aria-label="工程批量归属"/g)||[]).length,1);assert.doesNotMatch(html,/原表责任人甲批量归属|原表责任人乙批量归属|按 Excel 负责人/);assert.match(html,/原表工作责任人（参考）：原表责任人甲/);
  f.ui.mapGroup(0,JSON.stringify(['anonymous-project','','工程','pm-a']));assert.equal(await f.ui.save(),true);const payload=f.calls.find(call=>call.url==='/api/admin-plans/save').body;assert.equal(payload.plans.length,1);assert.equal(payload.plans[0].owner_id,'pm-a');assert.equal(payload.plans[0].items.length,3);assert.deepEqual(JSON.parse(JSON.stringify(payload.plans[0].items.map(item=>item.name))),rows.map(row=>row.name));
});

test('referenced plans are read only and role loss or late context cannot reveal or save another account draft',async()=>{
  const f=fixture({plans:[plan({editable:false,lock_reason:'已被周报引用'})]});await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);
  assert.match(f.ui.pageHtml(),/已被周报引用/);f.ui.edit(0,'name','伪造修改');assert.equal(await f.ui.save(),false);assert.equal(f.calls.some(row=>row.url.endsWith('/save')),false);
  f.S.profile={role:'president',status:'approved'};assert.match(f.ui.pageHtml(),/没有管理员计划维护权限/);assert.equal(await f.ui.save(),false);
  f.S.uid='other';f.S.session={};f.S.profile={role:'ops',status:'approved'};f.ui.configure({S:f.S,esc:String,render:()=>{},toast:()=>{}});
  assert.doesNotMatch(f.ui.pageHtml(),/原计划/);
});

test('refreshing a changed server plan preserves dirty admin input until explicitly loading the new version',async()=>{
  const f=fixture({plans:[plan()]});await f.ui.load({type:'res',month:'2026-11'});await selectPerson(f);f.ui.edit(0,'name','管理员尚未保存的输入');
  f.catalog.plans=[plan({id:'new-server-version',items:[{source_id:'server-item',mod:'主体',name:'本人更新后的计划',due:'2026-11-28'}]})];
  await f.ui.reload();assert.match(f.ui.pageHtml(),/服务器计划版本已变化/);assert.match(f.ui.pageHtml(),/管理员尚未保存的输入/);assert.equal(await f.ui.save(),false);
  f.ui.latest();assert.match(f.ui.pageHtml(),/本人更新后的计划/);assert.match(f.ui.pageHtml(),/修改前的未保存输入/);assert.match(f.ui.pageHtml(),/管理员尚未保存的输入/);
});

test('PM preparation selects the actual author for commercial, individual residential and professional merged reports',async()=>{
  const app=(await readFile(new URL('app.js',web),'utf8')).replace('window.App = App;','window.App = App; window.audit={S,preparePM,planningNavItems};').replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/,'');
  for(const kind of ['com','res','scope']){
    const root={innerHTML:'',querySelectorAll:()=>[]},storage={getItem:()=>null,setItem(){},removeItem(){}},window={WorkBuddyCloud:{createWorkBuddyCloud:()=>({database:{}})},localStorage:storage};
    const context={window,document:{getElementById:id=>id==='root'?root:null,querySelector:()=>null,addEventListener(){},removeEventListener(){}},localStorage:storage,setTimeout:()=>1,clearTimeout(){},Date,Map,Set,console};window.document=context.document;
    vm.runInNewContext(await readFile(new URL('planning-windows.js',web),'utf8'),context);vm.runInNewContext(await readFile(new URL('report-scopes.js',web),'utf8'),context);vm.runInNewContext(app,context);
    const S=window.audit.S,line=kind==='com'?'机电工程':'工程',base={project_id:'p',period:'2026-11-02',line,biz:{items:[]}};
    if(kind==='scope')Object.assign(base,{report_scope_id:'scope',scope_project_ids:['p']});
    Object.assign(S,{uid:'pm-a',session:{},profile:{role:'pm',status:'approved',discipline:'工程',biz_line:'机电工程'},pmProject:'p',pmPeriod:'2026-11-02',projects:[{id:'p',name:'匿名项目',project_type:kind==='com'?'com':'res'}],pms:[{project_id:'p',user_id:'pm-a'}],reports:[{...base,id:'peer-first',author_id:'pm-b'},{...base,id:'own-second',author_id:'pm-a'}],reportScopes:kind==='scope'?[{id:'scope',name:'合并匿名项目',anchor_project_id:'p',project_ids:['p'],reporting_mode:'professional'}]:[]});
    await window.audit.preparePM();assert.equal(S.pmReport.id,'own-second',kind);assert.equal(S.pmLegacyReportConflict,null,kind);
    for(const role of ['ops','president','pzo','viewer','pm']){S.profile.role=role;assert.equal(window.audit.planningNavItems().filter(item=>item.k==='adminPlans').length,role==='ops'?1:0,role);}
  }
});

test('personal plan lookup and replaced plan versions preserve old draft progress until explicit review',async()=>{
  const storage=new Map(),S={uid:'pm-a',session:{},profile:{role:'pm',biz_line:'机电工程'},pmProject:'p',pmLine:'机电工程',pmPeriod:'2026-11-02',projects:[{id:'p',project_type:'com'}],bizItems:[{source_id:'item',mod:'机电',name:'旧事项',due:'2026-11-25',prog:'旧草稿反馈'}],monthlyPlans:[
    {id:'peer',project_id:'p',line:'机电工程',owner_id:'pm-b',confirmed_by:'pm-b',plan_month:'2026-11-01',items:[{source_id:'peer-item',name:'同专业别人计划'}]},
    {id:'own',project_id:'p',line:'机电工程',owner_id:'pm-a',confirmed_by:'admin',plan_month:'2026-11-01',items:[{source_id:'item',mod:'机电',name:'旧事项',due:'2026-11-25'}]}
  ]};
  const window={document:{getElementById:()=>null},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};window.window=window;
  const context={window,Map,Set,Date};vm.runInNewContext(await readFile(new URL('planning-windows.js',web),'utf8'),context);vm.runInNewContext(await readFile(new URL('monthly-plans.js',web),'utf8'),context);
  window.MonthlyPlans.configure({S,esc:String,render:()=>{},toast:()=>{}});assert.equal(window.MonthlyPlans.current().id,'own');window.MonthlyPlans.apply();
  S.monthlyPlans[1]={...S.monthlyPlans[1],id:'own-revised',items:[{source_id:'item',mod:'机电',name:'修正后的事项',due:'2026-11-25'}]};
  assert.equal(window.MonthlyPlans.apply(),false);assert.equal(S.bizItems[0].name,'旧事项');window.MonthlyPlans.acceptUpdated();
  assert.equal(S.bizItems[0].name,'修正后的事项');assert.equal(S.bizItems[0].prog,'');assert.equal(S.monthlyUnmatchedItems[0].name,'旧事项');assert.equal(S.monthlyUnmatchedItems[0].prog,'旧草稿反馈');
});

test('real admin page renders rich manual fields and explicit Excel mapping controls without browser errors',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true}),out=path.join(os.tmpdir(),'planning-admin-plans-ui');
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<div id="root" class="planning-shell manager-shell"></div>');
    for(const name of ['vendor/quill/quill.core.css','styles.css','planning-ui.css','selection-format.css','admin-plans.css'])await page.addStyleTag({content:await readFile(new URL(name,web),'utf8')});
    for(const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js','admin-plans.js'])await page.addScriptTag({content:await readFile(new URL(name,web),'utf8')});
    await page.evaluate(async({targets,plans})=>{
      window.S={uid:'admin',session:{},view:'adminPlans',profile:{role:'ops',status:'approved'},monthlyPlans:[]};window.calls=[];
      window.fetch=async(url,options)=>({ok:true,json:async()=>({data:url.includes('/import?')?{targets,plans,rows:[{mod:'土建',name:'匿名Excel事项',due:'2026-11-20',line_hint:'工程',reporter_hint:'同名待确认',source:{sheet:'月计划',cell:'H8'},warnings:[]}],warnings:[]}:{targets,plans}})});
      const rich=window.ZHRichText,render=()=>{document.getElementById('root').innerHTML=window.AdminPlans.pageHtml();window.ZHRichEditor.mount(document.getElementById('root'),window.AdminPlans.binding);};
      window.AdminPlans.configure({S:window.S,esc:value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),render,toast:()=>{},flush:()=>window.ZHRichEditor.flush(),richCopy:rich.copy,richCollect:row=>rich.collect(JSON.parse(JSON.stringify(row))),request:async(url,body)=>{window.calls.push({url,body});return {data:{plans:[]}};}});
      await window.AdminPlans.load({type:'res',month:'2026-11',mode:'ai'});render();
    },{targets:[target(),target('pm-b')],plans:[plan()]});
    await page.getByRole('button',{name:'手工代填',exact:true}).click();await page.locator('#admin-plan-project').selectOption(JSON.stringify(['anonymous-project','']));await page.locator('#admin-plan-line').selectOption('工程');await page.locator('#admin-plan-owner').selectOption('pm-a');
    await expect(page.locator('[data-rich-editor-for="admin_plan_name_0"] .ql-editor')).toContainText('原计划');
    await page.getByRole('button',{name:'Excel 直接导入',exact:true}).click();await page.locator('#admin-plan-file').setInputFiles({name:'anonymous.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('anonymous mock parser bytes')});
    await expect(page.getByRole('status')).toContainText('尚未写入任何计划');await expect(page.getByRole('button',{name:'确认保存所选计划'})).toBeDisabled();
    await page.getByRole('combobox',{name:'第1项专业及提报人'}).selectOption(JSON.stringify(['anonymous-project','','工程','pm-a']));
    await page.getByRole('combobox',{name:'匿名甲已有计划处理'}).selectOption('append');
    await expect(page.getByRole('button',{name:'确认保存所选计划'})).toBeEnabled();assert.deepEqual(await page.evaluate(()=>window.calls),[]);
    await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,'admin-import-preview.png'),fullPage:true});assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('AI whole-project page renders upload, source coverage and dialogue together with only project and month before upload',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true}),out=path.join(os.tmpdir(),'planning-admin-plans-ai-ui');
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1120}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setContent('<div id="root" class="planning-shell manager-shell" style="padding:104px 20px 20px"></div>');
    for(const name of ['vendor/quill/quill.core.css','styles.css','planning-ui.css','selection-format.css','planning-ai.css','admin-plans.css'])await page.addStyleTag({content:await readFile(new URL(name,web),'utf8')});
    for(const name of ['vendor/quill/quill.js','rich-text.js','rich-editor.js','admin-plans.js'])await page.addScriptTag({content:await readFile(new URL(name,web),'utf8')});
    await page.evaluate(async({targets})=>{
      window.S={uid:'admin',session:{},view:'adminPlans',profile:{role:'ops',status:'approved'},monthlyPlans:[]};window.businessCalls=[];
      let state={conversation_id:'browser-ai-conversation',revision:1,reply:'已识别工程与设计计划。工程负责人需要你确认，另外还有一行源内容尚未处理。',complete:false,can_confirm:false,busy:false,
        questions:[{text:'工程专业由哪位提报人负责？'},{text:'请核对未标注月份范围是否属于11月。'}],unverified_regions:[{id:'browser-region',sheet:'未标月计划',bounds:{start_row:4,end_row:18,start_col:1,end_col:8},month:'2026-11'}],
        coverage:[{region_id:'r',sheet:'月计划',required_rows:[9,10,11],handled_rows:[9,11],pending_rows:[10]}],unprocessed_rows:[{id:'r:10',source:{sheet:'月计划',row:10},cells:[{id:'sheet!H10',cell:'H10',text:'补充设备安装验收计划'}]}],
        rows:[{id:'browser-row-1',mod:'工程',name:'项目主体结构月度施工计划',name_doc:{ops:[{insert:'项目主体结构月度施工计划',attributes:{bold:true}}]},due:'2026-11-25',line:'工程',owner_id:null,source:{sheet:'月计划',row:9,cell:'H9'},source_refs:['sheet!H9','sheet!I9'],warnings:[]},
          {id:'browser-row-2',mod:'设计',name:'施工图设计成果确认',due:'2026-11-28',line:'设计',owner_id:'pm-c',source:{sheet:'设计计划',row:7,cell:'F7'},source_refs:['design!F7'],warnings:[]}],targets,plans:[],source:{name:'匿名整项目11月计划.xlsx'},warnings:[{code:'formula_error',message:'原表公式错误行未作为计划导入，请核对原表',source:{sheet:'月计划',cell:'K12'}}]};
      window.fetch=async(url,options={})=>{
        if(url.startsWith('/api/admin-plans/context'))return {ok:true,json:async()=>({data:{targets,plans:[]}})};
        if(url.endsWith('/revise'))state={...state,revision:state.revision+1,unverified_regions:[],reply:'已记录你确认的11月份范围，归属与未处理行仍需澄清。'};
        if(url.endsWith('/chat'))state={...state,revision:state.revision+1,complete:true,can_confirm:true,questions:[],unprocessed_rows:[],coverage:[{region_id:'r',sheet:'月计划',required_rows:[9,10,11],handled_rows:[9,10,11],pending_rows:[]}],reply:'已将工程事项分给匿名甲，并补齐第10行。请核对所有专业预览后一次确认导入。',rows:[{...state.rows[0],owner_id:'pm-a'},state.rows[1],{id:'browser-row-3',mod:'设备安装',name:'补充设备安装验收计划',due:'2026-11-29',line:'工程',owner_id:'pm-a',source:{sheet:'月计划',row:10,cell:'H10'},source_refs:['sheet!H10'],warnings:[]}]};
        return {ok:true,json:async()=>({data:state})};
      };
      const rich=window.ZHRichText,render=()=>{document.getElementById('root').innerHTML=window.AdminPlans.pageHtml();window.ZHRichEditor.mount(document.getElementById('root'),window.AdminPlans.binding);};
      window.AdminPlans.configure({S:window.S,esc:value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),render,toast:()=>{},flush:()=>window.ZHRichEditor.flush(),richCopy:rich.copy,richItem:rich.field,richCollect:row=>rich.collect(JSON.parse(JSON.stringify(row))),request:async(url,body)=>{window.businessCalls.push({url,body});throw new Error('没有点击最终确认前不得写入');}});
      await window.AdminPlans.load({type:'res',month:'2026-11',mode:'ai'});render();
    },{targets:[target(),target('pm-b'),{...target('pm-c'),line:'设计',owner_name:'匿名设计'}]});
    await expect(page.locator('#admin-plan-line')).toHaveCount(0);await expect(page.locator('#admin-plan-owner')).toHaveCount(0);
    await expect(page.locator('.admin-plan-empty')).toContainText('尚未生成导入预览');
    const geometry=await page.evaluate(()=>{const header=document.querySelector('.admin-plans-page>.card').getBoundingClientRect(),panel=document.querySelector('.admin-plan-ai-panel').getBoundingClientRect();return {header:{top:header.top,right:header.right},panel:{top:panel.top,left:panel.left}};});
    assert.ok(Math.abs(geometry.header.top-geometry.panel.top)<2,'assistant aligns with the top controls');assert.ok(geometry.panel.left>geometry.header.right,'controls leave room for the assistant');
    await page.locator('#admin-plan-project').selectOption(JSON.stringify(['anonymous-project','']));
    await page.locator('#admin-plan-file').setInputFiles({name:'anonymous-all-project.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('anonymous mock provider input')});
    await page.locator('#admin-plan-ai-start').click();
    await expect(page.locator('.admin-plan-ai-coverage')).toContainText('已处理 2 / 3 行源内容');await expect(page.getByRole('log')).toContainText('工程负责人需要你确认');await expect(page.getByRole('button',{name:'一次确认导入全部计划'})).toBeDisabled();
    await mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,'ai-whole-project-pending-desktop.png'),fullPage:true});
    await page.locator('#admin-plan-ai-regions > summary').click();await page.getByRole('checkbox',{name:'确认 未标月计划 第 4–18 行（A–H 列） 为 2026-11 月计划'}).check();await page.getByRole('button',{name:'确认所选月份范围',exact:true}).click();
    await page.locator('#admin-plan-ai-input').fill('工程由匿名甲提报，请补齐第10行的设备安装事项');await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect(page.getByRole('button',{name:'一次确认导入全部计划'})).toBeEnabled();await expect(page.locator('.admin-plan-ai-coverage')).toContainText('已处理 3 / 3 行源内容');assert.deepEqual(await page.evaluate(()=>window.businessCalls),[]);
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'一次确认导入全部计划'}).click();assert.deepEqual(await page.evaluate(()=>window.businessCalls),[]);
    await page.screenshot({path:path.join(out,'ai-whole-project-ready-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'ai-whole-project-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
