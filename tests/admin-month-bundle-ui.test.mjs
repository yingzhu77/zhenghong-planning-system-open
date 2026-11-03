import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source=await fs.readFile(new URL('../web/admin-plans.js',import.meta.url),'utf8');
function fixture({lockedNext=false,unknown=false,fail=false}={}){
 const calls=[],notices=[],S={uid:'anonymous-ops',session:{},profile:{role:'ops',status:'approved'},view:'adminPlans',monthlyPlans:[]};
 const target={project_id:'anonymous',project_type:'res',report_scope_id:null,project_name:'匿名项目',line:'工程',owner_id:'anonymous-pm',owner_name:'匿名提报人'};
 const original={id:'00000000-0000-4000-8000-000000000001',project_id:'anonymous',line:'工程',owner_id:target.owner_id,confirmed_by:target.owner_id,plan_month:'2026-10-01',items:[{source_id:'old',mod:'原模块',name:'原周报引用计划',due:''}],editable:false,lock_reason:'已有周报引用'};
 const locked={...original,id:'00000000-0000-4000-8000-000000000002',plan_month:'2026-11-01'};
 S.monthlyPlans=[structuredClone(original)];
 let sends=0;
 const catalog=month=>({targets:[target],plans:month==='2026-10'?[original]:lockedNext?[locked]:[],summaries:[]});
 const row=(month,index)=>({id:'sheet:r'+index,month,mod:'原分类',name:month+'原工作内容',standard:'按原标准完成',due:month==='2026-10'?'2026-11-05':'2026-11-30',progress:month==='2026-10'?'已完成4处，其余待安排':'原表下月文字，仅作参考',line:'工程',line_hint:'工程',owner_id:target.owner_id,source:{sheet:'工程',row:index},source_refs:{name_cells:['s0!B'+index],progress_cells:['s0!G'+index]},warnings:[]});
 const batch={month:'2026-10',next_month:'2026-11',months:['2026-10','2026-11'],source:{name:'匿名月度会.xlsx'},unassigned_regions:unknown?[{id:'unmarked',sheet:'无月份标题'}]:[],batches:['2026-10','2026-11'].map((month,index)=>({...catalog(month),month,rows:[row(month,index+3)],warnings:[]}))};
 const window={document:{getElementById:()=>null},AbortController,crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},confirm:()=>true,addEventListener:()=>{}};
 window.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,json:async()=>({data:url.includes('/import?')?batch:catalog(new URL(url,'http://fixture.invalid').searchParams.get('month'))})};};window.window=window;
 vm.runInNewContext(source,{window,Map,Set,Date,Number,console});
 const cfg={S,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),render:()=>{},toast:message=>notices.push(message),refresh:async()=>true,request:async(url,body)=>{calls.push({url,body:structuredClone(body)});sends++;if(fail&&sends===1)return {error:{message:'网络结果未确认，原预览保留'}};return {data:{plans:body.plans.map((value,index)=>({...value,id:'saved-plan-'+index,plan_month:value.month+'-01',confirmed_by:value.owner_id})),summaries:body.summaries.map((value,index)=>({...value,id:'saved-summary-'+index}))}};}};
 window.AdminPlans.configure(cfg);
 return {ui:window.AdminPlans,calls,S,batch,original,target,notices};
}
async function upload(f){await f.ui.load({type:'res',month:'2026-10',mode:'excel'});await f.ui.select('project',JSON.stringify(['anonymous','']));await f.ui.upload({files:[{name:'匿名11月计划.xlsx',size:1000}]});}

test('one Excel upload previews both body months, retains source progress, and saves October summary plus November plan atomically',async()=>{
 const f=fixture();await upload(f);assert.equal(f.calls.filter(call=>call.url.includes('/import?')).length,1);assert.match(f.calls.find(call=>call.url.includes('/import?')).url,/include_next=1/);
 let html=f.ui.pageHtml();assert.match(html,/2026-10 · 本月计划及完成情况/);assert.match(html,/2026-11 · 下月工作计划/);assert.match(html,/已完成4处，其余待安排/);assert.match(html,/原表完成情况/);assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,0);
 await f.ui.batchMonth('2026-11');f.ui.edit(0,'name','本人核对后的11月事项');f.ui.edit(0,'progress','核对后的原表下月进展');await f.ui.batchMonth('2026-10');html=f.ui.pageHtml();assert.match(html,/2026-11-05/,'cross-month deadline must remain in October source section');assert.match(html,/已完成4处，其余待安排/);
 assert.equal(await f.ui.save(),true);const payload=f.calls.find(call=>call.url.endsWith('/save')).body;
 assert.equal(payload.plans.length,1);assert.equal(payload.plans[0].month,'2026-11');assert.equal(payload.plans[0].items[0].name,'本人核对后的11月事项');assert.equal(payload.plans[0].items[0].progress,undefined);
 assert.equal(payload.summaries.length,1);assert.equal(payload.summaries[0].month,'2026-10');assert.equal(payload.summaries[0].items[0].progress,'已完成4处，其余待安排');assert.equal(payload.summaries[0].items[0].due,'2026-11-05');assert.match(payload.summaries[0].items[0].name,/完成标准：按原标准完成/);
 assert.deepEqual(f.S.monthlyPlans.find(plan=>plan.plan_month==='2026-10-01'),f.original);assert.equal(f.S.monthlyPlans.filter(plan=>plan.plan_month==='2026-11-01').length,1);
 assert.equal(await f.ui.save(),false,'a saved bundle cannot be confirmed twice');assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,1);assert.match(f.ui.pageHtml(),/已保存 1 份月计划、1 份月度完成情况/);
});

test('a referenced November plan blocks fixed changes but does not block independently storing October results',async()=>{
 const f=fixture({lockedNext:true});await upload(f);assert.equal(await f.ui.save(),false);assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,0);assert.match(f.ui.pageHtml(),/原计划已被引用/);
 f.ui.batchOption('2026-11','plans',false);assert.equal(await f.ui.save(),true);const body=f.calls.find(call=>call.url.endsWith('/save')).body;assert.equal(body.plans.length,0);assert.equal(body.summaries.length,1);assert.equal(body.summaries[0].month,'2026-10');assert.deepEqual(f.S.monthlyPlans,[f.original]);
});

test('failed combined save preserves both months and retries the identical operation while an unmapped month cannot silently enter',async()=>{
 const f=fixture({fail:true,unknown:true});await upload(f);assert.equal(await f.ui.save(),false);assert.match(f.ui.pageHtml(),/未标明月份/);assert.equal(f.calls.filter(call=>call.url.endsWith('/save')).length,0);
 f.ui.batchUnknown(true);assert.equal(await f.ui.save(),false);assert.match(f.ui.pageHtml(),/网络结果未确认/);await f.ui.batchMonth('2026-11');assert.match(f.ui.pageHtml(),/2026-11原工作内容/);await f.ui.batchMonth('2026-10');assert.match(f.ui.pageHtml(),/已完成4处/);assert.equal(await f.ui.save(),true);
 const saves=f.calls.filter(call=>call.url.endsWith('/save'));assert.equal(saves.length,2);assert.deepEqual(saves[0].body,saves[1].body);
});

test('single-month mode stays available and changing identity discards other accounts month previews',async()=>{
 const f=fixture();await upload(f);f.ui.batchRange('single');assert.doesNotMatch(f.ui.pageHtml(),/按正文月份分别核对/);f.ui.batchRange('pair');assert.match(f.ui.pageHtml(),/按正文月份分别核对/);
 f.S.uid='another-admin';f.ui.configure({S:f.S,esc:value=>String(value??''),render:()=>{}});assert.doesNotMatch(f.ui.pageHtml(),/2026-10原工作内容|已完成4处/);
});

test('source actual completion date is saved beside the monthly narrative without replacing the planned deadline or creating an approval',async()=>{
 const f=fixture();f.batch.batches[0].rows[0].actual_due='2026-10-29';await upload(f);assert.match(f.ui.pageHtml(),/原表实际完成时间：2026-10-29/);assert.equal(await f.ui.save(),true);
 const item=f.calls.find(call=>call.url.endsWith('/save')).body.summaries[0].items[0];assert.equal(item.due,'2026-11-05');assert.equal(item.progress,'已完成4处，其余待安排\n原表实际完成时间：2026-10-29');assert.equal(item.status,undefined);
});
