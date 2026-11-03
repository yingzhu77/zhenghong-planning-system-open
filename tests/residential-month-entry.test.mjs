import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {confirmMonthlyPlan,listMonthlyPlans,withdrawMonthlyPlan} from '../server/monthly-plans.mjs';
import {executeDatabase,withIdentity,reportWeekStart} from '../server/database.mjs';
import {loadPlanningAIFacts,assertPlanningAIFactAccess} from '../server/planning-ai-data.mjs';

const scopeId='scope-monthly-professional-tests',pids=['scope-plan-a','scope-plan-b','scope-plan-c'],outside='scope-plan-outside';
const actors={engineer:{id:'scope-plan-engineer'},designer:{id:'scope-plan-designer'},peer:{id:'scope-plan-engineer-peer'},partial:{id:'scope-plan-partial'},ops:{id:'scope-plan-operator'},cost:{id:'scope-plan-cost'}};
const bold=text=>({ops:[{insert:text,attributes:{bold:true}}]});
const plain=value=>JSON.parse(JSON.stringify(value));
const addDays=(value,days)=>new Date(Date.parse(value+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
function shiftMonth(value,delta){const date=new Date(value+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+delta);return date.toISOString().slice(0,7);}
const forbidden=error=>error.status===403;
const inUse=error=>error.status===409&&error.code==='monthly_plan_in_use';

async function seedScope(admin,pool,{users=actors,week=reportWeekStart(new Date(Date.now()+8*3600000).toISOString().slice(0,10))}={}){
  const month=week.slice(0,7),nextMonth=shiftMonth(month,1);
  for(const [index,pid] of [...pids,outside].entries())await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES($1,$2,'res',$3)",[pid,'匿名统一住宅'+index,index]);
  for(const [kind,discipline] of [['engineer','工程'],['designer','设计'],['peer','工程'],['partial','工程'],['cost','成本'],['ops',null]]){
    const values=[users[kind].id,'匿名'+kind,kind==='ops'?'ops':'pm',discipline,pids[0]];
    const existing=(await admin.query('SELECT user_id FROM public.profiles WHERE user_id=$1',[values[0]])).rows[0];
    if(existing)await admin.query("UPDATE public.profiles SET name=$2,role=$3,status='approved',discipline=$4,project_id=$5,biz_line=NULL WHERE user_id=$1",values);
    else await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline,project_id) VALUES($1,$2,$3,'approved',$4,$5)",values);
    if(kind!=='ops')for(const pid of kind==='partial'?pids.slice(0,2):pids)await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,$2,'pm') ON CONFLICT DO NOTHING",[users[kind].id,pid]);
  }
  await admin.query("INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week) VALUES($1,'匿名专业月计划统一范围',$2,$3,$4)",[scopeId,pids[0],pids,addDays(week,-7)]);
  const legacy=(await admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,rich_text,history) VALUES($1,$2,'综合',$3,'匿名原综合作者',$4,$5,$6) RETURNING *",
    [pids[0],addDays(week,-14),users.engineer.id,JSON.stringify({items:[{source_id:'old-unified-source',project_id:pids[1],mod:'原模块',name:'原综合历史事项',prog:'历史完整原文'}]}),JSON.stringify({v:1,fields:{'biz.items.0.prog':bold('历史完整原文')}}),JSON.stringify([{at:addDays(week,-15)+'T00:00:00Z',by:users.engineer.id,data:{biz:{items:[{name:'更早历史内容'}]}}}])])).rows[0];
  const request=(line='工程',extra={})=>({project_id:pids[0],line,month:nextMonth,report_scope_id:scopeId,
    items:[{source_id:'shared-professional-source',mod:line,name:'匿名'+line+'下月计划',due:nextMonth+'-20'}],...extra});
  return {admin,pool,users,week,month,nextMonth,legacy,request};
}
async function fixture(t){const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);return {...await seedScope(admin,pool),db};}
const withdrawal=plan=>({project_id:plan.project_id,line:plan.line,month:String(plan.plan_month).slice(0,7),report_scope_id:plan.report_scope_id,expected_plan_id:plan.id});
async function snapshots(admin){return (await admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id,user_id) FROM public.project_members m)) state")).rows[0].state;}

test('unified residential scope confirms separate professional plans with authoritative members and no fabricated weekly reports',async t=>{
  const f=await fixture(t),before=await snapshots(f.admin);
  const engineering=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程'));
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计'));
  for(const [plan,line,owner] of [[engineering,'工程',f.users.engineer.id],[design,'设计',f.users.designer.id]]){
    assert.equal(plan.project_id,pids[0]);assert.equal(plan.line,line);assert.equal(plan.confirmed_by,owner);assert.equal(plan.report_scope_id,scopeId);assert.deepEqual(plan.scope_project_ids,pids);
  }
  assert.equal(engineering.items[0].source_id,design.items[0].source_id,'professional plans may keep the same original source id in distinct plans');
  assert.equal(Object.hasOwn(engineering.items[0],'project_id'),false,'an unspecified subproject must not be invented from the anchor');
  const plans=await listMonthlyPlans(f.pool,f.users.ops,{project_id:pids[0],report_scope_id:scopeId,month:f.nextMonth});
  assert.deepEqual(plans.map(plan=>plan.id).sort(),[engineering.id,design.id].sort());
  const original=(await f.admin.query('SELECT to_jsonb(p) data FROM public.monthly_plans p WHERE id=$1',[engineering.id])).rows[0].data;
  const peerPlan=await confirmMonthlyPlan(f.pool,f.users.peer,f.request('工程'));
  assert.notEqual(peerPlan.id,engineering.id);assert.equal(peerPlan.confirmed_by,f.users.peer.id);
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(p) data FROM public.monthly_plans p WHERE id=$1',[engineering.id])).rows[0].data,original,'same-profession personal confirmation must not rewrite the original owner plan');
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程')),error=>error.status===409&&error.code==='monthly_plan_confirmed');
  await assert.rejects(withdrawMonthlyPlan(f.pool,f.users.peer,withdrawal(engineering)),forbidden);
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.engineer,f.request('设计')),forbidden);
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.ops,f.request('成本')),forbidden);
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.partial,f.request('工程',{month:shiftMonth(f.nextMonth,1)})),forbidden);
  const forged=f.request('成本',{scope_project_ids:[pids[0],outside]});await assert.rejects(confirmMonthlyPlan(f.pool,f.users.cost,forged),error=>error.status===400);
  const noScope=f.request('成本');delete noScope.report_scope_id;await assert.rejects(confirmMonthlyPlan(f.pool,f.users.cost,noScope),forbidden);
  assert.deepEqual(await snapshots(f.admin),before,'monthly confirmation must preserve report rows, original history, profiles and memberships');
});

test('scope professional withdrawal keeps original ownership and exact archive while another profession and old reports remain intact',async t=>{
  const f=await fixture(t),engineering=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程'));
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计'));
  const original=(await f.admin.query('SELECT to_jsonb(p) data FROM public.monthly_plans p WHERE id=$1',[engineering.id])).rows[0].data,before=await snapshots(f.admin);
  for(const actor of [f.users.peer,f.users.designer,f.users.ops,f.users.partial])await assert.rejects(withdrawMonthlyPlan(f.pool,actor,withdrawal(engineering)),forbidden);
  const result=await withdrawMonthlyPlan(f.pool,f.users.engineer,withdrawal(engineering));assert.equal(result.withdrawn,true);assert.deepEqual(result.plan.items,engineering.items);
  const archive=(await f.admin.query('SELECT * FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[engineering.id])).rows[0];assert.deepEqual(archive.snapshot,original);assert.equal(archive.withdrawn_by,f.users.engineer.id);
  const replacement=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{items:[{...engineering.items[0],name:'修正后的本人专业下月计划'}]}));assert.notEqual(replacement.id,engineering.id);
  await assert.rejects(withdrawMonthlyPlan(f.pool,f.users.engineer,withdrawal(engineering)),error=>error.status===409&&error.code==='monthly_plan_changed');
  assert.equal((await listMonthlyPlans(f.pool,f.users.ops,{project_id:pids[0],report_scope_id:scopeId,line:'设计',month:f.nextMonth}))[0].id,design.id);
  assert.deepEqual(await snapshots(f.admin),before);
  await assert.rejects(withIdentity(f.pool,f.users.engineer.id,c=>c.query('DELETE FROM public.monthly_plans WHERE id=$1',[replacement.id])),error=>error.code==='42501');
});

test('stored scope members continue protecting old professional plans after grants and configured scope definitions change',async t=>{
  const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程'));
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[f.users.engineer.id,pids[2]]);
  await assert.rejects(listMonthlyPlans(f.pool,f.users.engineer,{project_id:pids[0],report_scope_id:scopeId}),forbidden);
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{month:shiftMonth(f.nextMonth,1)})),forbidden);
  await assert.rejects(withdrawMonthlyPlan(f.pool,f.users.engineer,withdrawal(plan)),forbidden);
  await f.admin.query('UPDATE app_private.report_scopes SET project_ids=$2 WHERE id=$1',[scopeId,pids.slice(0,2)]);
  let visible;
  try{visible=await listMonthlyPlans(f.pool,f.users.engineer,{project_id:pids[0],report_scope_id:scopeId});}
  catch(error){assert.equal(error.status,403);visible=[];}
  assert.equal(visible.some(row=>row.id===plan.id),false,'dropping a configured child must not bypass the saved member snapshot');
  assert.deepEqual((await f.admin.query('SELECT scope_project_ids FROM public.monthly_plans WHERE id=$1',[plan.id])).rows[0].scope_project_ids,pids);
});

test('scope month items keep explicit child identity and rich text while outside children and forged scopes are rejected',async t=>{
  const f=await fixture(t),item={source_id:'child-source',project_id:pids[1],mod:'工程',name:'匿名二期明确计划',due:f.nextMonth+'-20'};
  const plan=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{items:[item],rich_text:{v:1,fields:{'items.0.name':bold(item.name)}}}));
  assert.deepEqual(plan.items,[item]);assert.deepEqual(plan.rich_text.fields['items.0.name'],bold(item.name));
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{items:[{...item,project_id:outside}]})),error=>[400,403].includes(error.status));
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{report_scope_id:'unconfigured-scope'})),forbidden);
  await assert.rejects(confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{project_id:pids[1]})),forbidden);
  const before=await snapshots(f.admin);await f.db.exec(await readFile(new URL('../db/029-scoped-residential-monthly-plans.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../db/029-scoped-residential-monthly-plans.sql',import.meta.url),'utf8'));
  assert.deepEqual(await snapshots(f.admin),before);
  assert.deepEqual((await f.admin.query('SELECT items,rich_text,report_scope_id,scope_project_ids FROM public.monthly_plans WHERE id=$1',[plan.id])).rows[0],{items:[item],rich_text:plan.rich_text,report_scope_id:scopeId,scope_project_ids:pids});
});

function aggregate(plans,progress='本期已完成核对'){
  const items=[],fields={};
  for(const plan of plans)for(const [index,item] of plan.items.entries()){
    const rowIndex=items.length;items.push({...item,monthly_plan_id:plan.id,prog:progress,blocker:''});
    for(const field of ['mod','name']){const doc=plan.rich_text?.fields?.['items.'+index+'.'+field];if(doc)fields['biz.items.'+rowIndex+'.'+field]=doc;}
  }
  return {biz:{monthly_plan_ids:plans.map(plan=>plan.id),items},...(Object.keys(fields).length?{rich_text:{v:1,fields}}:{})};
}
const submit=(f,values)=>executeDatabase(f.pool,f.users.engineer,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:pids[0],period:f.week,line:'综合',report_scope_id:scopeId,...values}});

test('one comprehensive weekly report uses compound professional plan sources, freezes its original plan set and blocks current or historical withdrawals',async t=>{
  const f=await fixture(t),engineering=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{month:f.month,rich_text:{v:1,fields:{'items.0.name':bold('匿名工程下月计划')}}}));
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{month:f.month})),original=aggregate([engineering,design]);
  const saved=(await submit(f,original))[0];assert.equal(saved.line,'综合');assert.equal(saved.report_scope_id,scopeId);assert.deepEqual(saved.scope_project_ids,pids);
  assert.deepEqual(saved.biz.monthly_plan_ids.sort(),[engineering.id,design.id].sort());assert.equal(saved.biz.items.length,2);assert.equal(saved.biz.items[0].source_id,saved.biz.items[1].source_id);
  const firstSnapshot=(await f.admin.query('SELECT to_jsonb(r) data FROM public.reports r WHERE id=$1',[saved.id])).rows[0].data;
  for(const altered of [
    {...original,biz:{...original.biz,items:original.biz.items.map((row,index)=>index?row:{...row,name:'篡改他人确认事项'})},rich_text:{v:1,fields:{...original.rich_text.fields,'biz.items.0.name':bold('篡改他人确认事项')}}},
    {...original,biz:{...original.biz,items:original.biz.items.map((row,index)=>({...row,monthly_plan_id:original.biz.items[1-index].monthly_plan_id}))}},
    {...original,biz:{...original.biz,monthly_plan_ids:[engineering.id],items:original.biz.items.slice(0,1)}}
  ])await assert.rejects(submit(f,altered),error=>error.status===409&&error.code==='monthly_plan_locked');
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(r) data FROM public.reports r WHERE id=$1',[saved.id])).rows[0].data,firstSnapshot);
  await confirmMonthlyPlan(f.pool,f.users.cost,f.request('成本',{month:f.month}));
  const updated=(await submit(f,aggregate([engineering,design],'本月完成情况已更新')))[0];assert.equal(updated.id,saved.id);assert.equal(updated.biz.items.length,2);assert.equal(updated.history.length,1);
  assert.deepEqual(updated.biz.monthly_plan_ids.sort(),[engineering.id,design.id].sort(),'a later confirmation must not expand the saved report plan set');
  for(const plan of [engineering,design])await assert.rejects(withdrawMonthlyPlan(f.pool,plan.line==='工程'?f.users.engineer:f.users.designer,withdrawal(plan)),inUse);
  const future=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程'));
  await f.admin.query('UPDATE public.reports SET history=history || $2::jsonb WHERE id=$1',[saved.id,JSON.stringify([{at:new Date().toISOString(),by:f.users.engineer.id,data:{biz:{monthly_plan_ids:[future.id],items:[]}}}])]);
  await assert.rejects(withdrawMonthlyPlan(f.pool,f.users.engineer,withdrawal(future)),inUse);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0].n,1);
  assert.equal((await f.admin.query("SELECT count(*)::int n FROM public.reports WHERE line<>'综合'")).rows[0].n,0);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals')).rows[0].n,0);
});

test('a comprehensive report saved without month references retains its original snapshot when professional month plans are added',async t=>{
  const f=await fixture(t),saved=(await submit(f,{biz:{items:[{source_id:'retained-old-scope-item',project_id:pids[1],mod:'原综合类别',name:'旧综合本月工作',prog:'原综合反馈'}]}}))[0];
  await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{month:f.month}));await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{month:f.month}));
  const updated=(await submit(f,{biz:{...saved.biz,items:saved.biz.items.map(row=>({...row,prog:'保留旧固定列更新本期进展'}))}}))[0];
  assert.equal(updated.id,saved.id);assert.equal(updated.author_id,f.users.engineer.id);assert.equal(updated.line,'综合');assert.equal(updated.report_scope_id,scopeId);
  assert.equal(updated.biz.monthly_plan_ids,undefined);assert.equal(updated.biz.items[0].name,'旧综合本月工作');assert.equal(updated.biz.items[0].project_id,pids[1]);assert.equal(updated.history.length,1);
  assert.deepEqual(updated.history[0].data.biz,saved.biz);
});

test('personal AI facts resolve only the owner professional scope plan and recheck every saved member before returning',async t=>{
  const f=await fixture(t),own=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程'));
  await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计'));
  const facts=await loadPlanningAIFacts(f.pool,f.users.engineer,{project_id:pids[0],line:'综合',period:f.week,report_scope_id:scopeId,scope_project_ids:pids},
    {kind:'summary',scope:'current',start:'',end:'',keyword:own.items[0].name,project_name:'',limit:10});
  assert.equal(facts.summary.total,1);assert.equal(facts.items.length,1);assert.equal(facts.items[0].source_key,'monthly:'+pids[0]+':'+own.id+':shared-professional-source');
  assert.doesNotMatch(JSON.stringify(facts),/匿名设计下月计划/);await assertPlanningAIFactAccess(f.pool,f.users.engineer,facts);
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[f.users.engineer.id,pids[2]]);
  await assert.rejects(assertPlanningAIFactAccess(f.pool,f.users.engineer,facts),error=>error.status===403&&error.code==='ai_scope_forbidden');
});

async function scopeRuntime(t){
  const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());
  const admin=testPool(runtime.db,null),users={...actors,engineer:{id:'ai-local-acceptance-user'}};
  const f=await seedScope(admin,runtime.pool,{users,week:runtime.scope.week});
  for(const [kind,user] of Object.entries(users))if(kind!=='engineer')await admin.query(
    'INSERT INTO app_private.auth_users(user_id,email,password_hash,must_change_password) SELECT $1,$2,password_hash,false FROM app_private.auth_users WHERE user_id=$3',
    [user.id,kind+'@scope-month.example.invalid',users.engineer.id]);
  return {...f,runtime};
}
async function browserFixture(t,f){
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const errors=[],writes=[];
  async function login(kind='engineer'){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    context.on('request',request=>{if(!request.url().endsWith('/api/db'))return;let body;try{body=request.postDataJSON();}catch{}if(body?.operation&&body.operation!=='select')writes.push({kind,table:body.table,operation:body.operation});});
    await page.goto(f.runtime.url);await page.locator('#email').fill(kind==='engineer'?f.runtime.account.email:kind+'@scope-month.example.invalid');
    await page.locator('#password').fill(f.runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(({project,period})=>App.fillProject(project,period),{project:pids[2],period:f.week});
    return page;
  }
  return {browser,login,errors,writes};
}
const monthButton=(page,month)=>page.getByRole('button',{name:'本月 '+month,exact:true});
const nextButton=(page,month)=>page.getByRole('button',{name:'准备下月 '+month,exact:true});
const editor=(page,id)=>page.locator('[data-rich-editor-for="'+id+'"] .ql-editor');
const monthCard=(page,month,line)=>page.locator('.monthly-next-plan[data-plan-month="'+month+'"][data-plan-line="'+line+'"][data-plan-scope="'+scopeId+'"]');
const progressFor=(page,name)=>page.locator('.report3-monthly-table tbody tr').filter({hasText:name}).locator('[data-rich-editor-for^="bi_pg_"] .ql-editor');
async function typeBold(target,text){
  await target.fill(text);
  if((await target.locator('strong').allTextContents()).join('')!==text){await target.press('Control+A');await target.press('Control+B');}
  await expect(target.locator('strong')).toHaveText(text);
}
async function confirmOwnNext(page,f,line,name){
  await nextButton(page,f.nextMonth).click();await expect(monthCard(page,f.nextMonth,line)).toBeVisible();
  await editor(page,'monthly_next_mod_0').fill(line);await typeBold(editor(page,'monthly_next_name_0'),name);await page.locator('#monthly_next_due_0').fill(f.nextMonth+'-20');
  await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();
}

test('real unified month-end forms isolate professional month drafts and retain compound rich weekly feedback through confirm, withdrawal and the single comprehensive submission',async t=>{
  const f=await scopeRuntime(t),engineeringName='匿名工程本月确认事项',designName='匿名设计本月确认事项';
  const engineering=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{month:f.month,items:[{source_id:'same-source',mod:'工程',name:engineeringName,due:f.week}],rich_text:{v:1,fields:{'items.0.name':bold(engineeringName)}}}));
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{month:f.month,items:[{source_id:'same-source',mod:'设计',name:designName,due:f.week}]}));
  const originalReports=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state;
  const h=await browserFixture(t,f),page=await h.login();
  await expect(page.locator('.monthly-plan-toolbar')).toContainText('本月 '+f.month);
  await expect(monthButton(page,f.month)).toHaveAttribute('aria-pressed','true');await expect(nextButton(page,f.nextMonth)).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('.report3-monthly-table tbody tr')).toHaveCount(2);await expect(page.locator('.report3-monthly-table')).toContainText(engineeringName);await expect(page.locator('.report3-monthly-table')).toContainText(designName);
  await typeBold(progressFor(page,engineeringName),'工程自己的本月完成情况');await typeBold(progressFor(page,designName),'设计自己的本月完成情况');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  await confirmOwnNext(page,f,'工程','工程独立下月计划');await expect(nextButton(page,f.nextMonth)).toHaveAttribute('aria-pressed','true');
  await expect(progressFor(page,engineeringName)).toContainText('工程自己的本月完成情况');await expect(progressFor(page,designName)).toContainText('设计自己的本月完成情况');
  await monthButton(page,f.month).click();await expect(monthCard(page,f.nextMonth,'工程')).toHaveCount(0);
  await page.reload();await expect(progressFor(page,engineeringName).locator('strong')).toContainText('工程自己的本月完成情况');await expect(progressFor(page,designName).locator('strong')).toContainText('设计自己的本月完成情况');
  await nextButton(page,f.nextMonth).click();await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText('工程独立下月计划');
  const other=await h.login('designer');await nextButton(other,f.nextMonth).click();await expect(editor(other,'monthly_next_name_0')).toBeEmpty();
  await expect(other.locator('.report3-monthly-table')).not.toContainText('工程自己的本月完成情况');await expect(other.locator('.monthly-next-plan')).not.toContainText('工程独立下月计划');
  await confirmOwnNext(other,f,'设计','设计独立下月计划');await other.getByRole('button',{name:'确认下月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'设计',f.nextMonth+'-01'])).rows[0].n).toBe(1);
  await page.getByRole('button',{name:'确认下月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.nextMonth+'-01'])).rows[0].n).toBe(1);
  const first=(await f.admin.query('SELECT * FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.nextMonth+'-01'])).rows[0];
  assert.deepEqual(first.scope_project_ids,pids);assert.equal(first.confirmed_by,f.users.engineer.id);assert.equal(first.items[0].name,'工程独立下月计划');assert.equal(first.rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
  const rejected=await page.request.post(f.runtime.url+'/api/monthly-plans/confirm',{headers:{Origin:f.runtime.url},data:f.request('设计',{month:shiftMonth(f.nextMonth,1)})});assert.equal(rejected.status(),403);
  page.once('dialog',dialog=>dialog.accept());await monthCard(page,f.nextMonth,'工程').getByRole('button',{name:'撤回确认并修改',exact:true}).click();
  await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText('工程独立下月计划');
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[first.id])).rows[0].n,1);
  await editor(page,'monthly_next_name_0').fill('工程修改后的下月计划');await page.getByRole('button',{name:'确认下月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT items->0->>\'name\' value FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.nextMonth+'-01'])).rows[0]?.value).toBe('工程修改后的下月计划');
  const replacement=(await f.admin.query('SELECT id FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.nextMonth+'-01'])).rows[0];assert.notEqual(replacement.id,first.id);
  await monthButton(page,f.month).click();await expect(progressFor(page,engineeringName).locator('strong')).toContainText('工程自己的本月完成情况');await expect(progressFor(page,designName).locator('strong')).toContainText('设计自己的本月完成情况');
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state,originalReports);assert.deepEqual(h.writes,[],'plan editing and confirmation must not write a weekly report');
  await page.getByRole('button',{name:'提交本期直报',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0].n).toBe(1);
  const submitted=(await f.admin.query('SELECT * FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0];assert.equal(submitted.author_id,f.users.engineer.id);assert.equal(submitted.line,'综合');assert.deepEqual(submitted.scope_project_ids,pids);
  assert.deepEqual(submitted.biz.monthly_plan_ids.sort(),[engineering.id,design.id].sort());
  for(const [plan,text] of [[engineering,'工程自己的本月完成情况'],[design,'设计自己的本月完成情况']]){
    const index=submitted.biz.items.findIndex(row=>row.monthly_plan_id===plan.id&&row.source_id==='same-source');assert.ok(index>=0);assert.equal(submitted.biz.items[index].prog,text);assert.equal(submitted.rich_text.fields['biz.items.'+index+'.prog'].ops[0].attributes.bold,true);
  }
  assert.deepEqual(h.writes,[{kind:'engineer',table:'reports',operation:'upsert'}]);
  const retained=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r WHERE id<>$1',[submitted.id])).rows[0].state;assert.deepEqual(retained,originalReports);
  await other.reload();await expect(other.getByRole('button',{name:'由原填报人更新',exact:true})).toBeDisabled();await nextButton(other,f.nextMonth).click();await expect(monthCard(other,f.nextMonth,'设计')).toContainText('设计独立下月计划');
  await page.evaluate(({project,period})=>App.fillProject(project,period),{project:pids[2],period:f.week});
  await page.setViewportSize({width:390,height:844});await nextButton(page,f.nextMonth).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const artifacts=process.env.RES_MONTH_ENTRY_ARTIFACT_DIR||path.join(os.tmpdir(),'planning-residential-month-entry');await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'scope-next-month-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await monthButton(page,f.month).click();await page.screenshot({path:path.join(artifacts,'scope-current-month.png'),fullPage:true});
  assert.deepEqual(h.errors,[]);
});

test('the scope current-month editor confirms only the caller professional draft and preserves a different professional weekly row',async t=>{
  const f=await scopeRuntime(t),designName='先确认的设计本月计划';
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{month:f.month,items:[{source_id:'design-current',mod:'设计',name:designName,due:f.week}]}));
  const reportsBefore=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state;
  const h=await browserFixture(t,f),page=await h.login();await expect(monthCard(page,f.month,'工程')).toBeVisible();
  await progressFor(page,designName).fill('设计行保留自己的本周反馈');await editor(page,'monthly_next_mod_0').fill('工程');await typeBold(editor(page,'monthly_next_name_0'),'工程本月独立确认事项');await page.locator('#monthly_next_due_0').fill(f.month+'-20');
  await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();await nextButton(page,f.nextMonth).click();await expect(editor(page,'monthly_next_name_0')).toBeEmpty();await editor(page,'monthly_next_name_0').fill('工程另一个月草稿');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  await monthButton(page,f.month).click();await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText('工程本月独立确认事项');
  await monthCard(page,f.month,'工程').getByRole('button',{name:'确认本月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.month+'-01'])).rows[0].n).toBe(1);
  const own=(await f.admin.query('SELECT * FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.month+'-01'])).rows[0];assert.equal(own.items.length,1);assert.equal(own.items[0].name,'工程本月独立确认事项');assert.equal(own.rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
  assert.deepEqual((await f.admin.query('SELECT items FROM public.monthly_plans WHERE id=$1',[design.id])).rows[0].items,design.items);
  await expect(page.locator('.report3-monthly-table tbody tr')).toHaveCount(2);await expect(progressFor(page,designName)).toContainText('设计行保留自己的本周反馈');
  await nextButton(page,f.nextMonth).click();await expect(editor(page,'monthly_next_name_0')).toContainText('工程另一个月草稿');
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state,reportsBefore);assert.deepEqual(h.writes,[]);assert.deepEqual(h.errors,[]);
});

test('an older unreferenced comprehensive form shows the owner current professional plan separately and reopens it without replacing the old weekly snapshot',async t=>{
  const f=await scopeRuntime(t),legacyName='原综合当前工作',professionalName='工程本月独立确认内容';
  const current=(await submit(f,{biz:{items:[{source_id:'original-scope-current',project_id:pids[1],mod:'旧综合类别',name:legacyName,prog:'服务器原综合本周反馈'}]},rich_text:{v:1,fields:{'biz.items.0.name':bold(legacyName),'biz.items.0.prog':bold('服务器原综合本周反馈')}}}))[0];
  const plan=await confirmMonthlyPlan(f.pool,f.users.engineer,f.request('工程',{month:f.month,items:[{source_id:'current-child-source',project_id:pids[1],mod:'工程',name:professionalName,due:f.week}],rich_text:{v:1,fields:{'items.0.name':bold(professionalName)}}}));
  await confirmMonthlyPlan(f.pool,f.users.designer,f.request('设计',{month:f.month}));
  const reportsBefore=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state;
  const h=await browserFixture(t,f),page=await h.login(),card=monthCard(page,f.month,'工程');
  await expect(page.locator('.report3-monthly-table tbody tr')).toHaveCount(1);await expect(page.locator('.report3-monthly-table')).toContainText(legacyName);
  await expect(page.locator('.report3-monthly-table')).not.toContainText(professionalName);await expect(card).toContainText(professionalName);await expect(card.locator('input,textarea,[contenteditable]')).toHaveCount(0);
  await typeBold(progressFor(page,legacyName),'旧综合自己的本周富文本草稿');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();await expect(progressFor(page,legacyName).locator('strong')).toContainText('旧综合自己的本周富文本草稿');
  page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'撤回确认并修改',exact:true}).click();
  await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText(professionalName);await expect(progressFor(page,legacyName).locator('strong')).toContainText('旧综合自己的本周富文本草稿');
  await editor(page,'monthly_next_name_0').fill('工程本月修改后确认内容');await card.getByRole('button',{name:'确认本月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query('SELECT items->0->>\'name\' value FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.month+'-01'])).rows[0]?.value).toBe('工程本月修改后确认内容');
  const replacement=(await f.admin.query('SELECT * FROM public.monthly_plans WHERE report_scope_id=$1 AND line=$2 AND plan_month=$3',[scopeId,'工程',f.month+'-01'])).rows[0];assert.notEqual(replacement.id,plan.id);assert.equal(replacement.items[0].project_id,pids[1]);
  await expect(card).toContainText('工程本月修改后确认内容');await expect(page.locator('.report3-monthly-table')).toContainText(legacyName);await expect(page.locator('.report3-monthly-table')).not.toContainText('工程本月修改后确认内容');
  await page.reload();await expect(progressFor(page,legacyName).locator('strong')).toContainText('旧综合自己的本周富文本草稿');await expect(monthCard(page,f.month,'工程')).toContainText('工程本月修改后确认内容');
  const server=(await f.admin.query('SELECT * FROM public.reports WHERE id=$1',[current.id])).rows[0];assert.equal(server.biz.monthly_plan_ids,undefined);
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state,reportsBefore);assert.deepEqual(h.writes,[]);assert.deepEqual(h.errors,[]);
});
