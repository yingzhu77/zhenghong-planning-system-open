import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import {chromium, expect} from '@playwright/test';
import {initializedDatabase, testPool} from './helpers/pglite-pool.mjs';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {executeDatabase, withIdentity} from '../server/database.mjs';
import {confirmMonthlyPlan, listMonthlyPlans, withdrawMonthlyPlan} from '../server/monthly-plans.mjs';
import {previewCompletion, requestCompletion, reviewCompletion, withdrawCompletion} from '../server/completions.mjs';
import {readOnlyGate} from '../server/read-only.mjs';

const pm={id:'demo-pm-com'}, ops={id:'demo-ops'}, line='土建工程（东地块）';
const item={source_id:'withdraw-original-item',mod:'匿名测试模块',name:'误确认后应能修正的下月事项',due:'2026-11-20'};
const rich={v:1,fields:{'items.0.mod':{ops:[{insert:item.mod,attributes:{bold:true}}]},'items.0.name':{ops:[{insert:item.name,attributes:{bold:true,color:'#d81e06'}}]}}};
const confirmation=extra=>({project_id:'demo-com',line,month:'2026-11',items:[item],rich_text:rich,...extra});
const withdrawal=plan=>({project_id:plan.project_id,line:plan.line,month:String(plan.plan_month).slice(0,7),expected_plan_id:plan.id});
const errorCode=code=>error=>error.code===code;
async function fixture(t){
 const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null);await seedDemo(admin);return {db,admin,pool:testPool(db)};
}
async function state(admin){
 return (await admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.monthly_plans t),'archives',(SELECT jsonb_agg(to_jsonb(t) ORDER BY plan_id) FROM app_private.monthly_plan_withdrawals t),'reports',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.reports t),'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.profiles t),'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,user_id) FROM public.project_members t),'auth',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM app_private.auth_users t),'requests',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.completion_requests t)) value")).rows[0].value;
}
async function rawRequest(pool,plan,{sourceKey='monthly:'+plan.project_id+':'+plan.id+':'+item.source_id,snapshot={monthly_plan_id:plan.id}}={}){
 return withIdentity(pool,pm.id,client=>client.query('INSERT INTO public.completion_requests(id,source_key,source_version,project_id,kind,source_id,title,what,due,source_snapshot,owner_id,owner_name,completion_date,completion_note) VALUES($1,$2,$3,$4,\'plan\',$5,\'匿名月计划\',$6,$7,$8,$9,\'\',\'2026-11-20\',\'匿名完成证据\')',[randomUUID(),sourceKey,'a'.repeat(64),plan.project_id,item.source_id,item.name,item.due,JSON.stringify(snapshot),pm.id]));
}

test('owner withdraws an unused confirmation into exact private history, then reconfirms without changing other business rows',async t=>{
 const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,pm,confirmation());
 const original=(await f.admin.query('SELECT to_jsonb(p) value FROM public.monthly_plans p WHERE id=$1',[plan.id])).rows[0].value;
 const before=await state(f.admin),result=await withdrawMonthlyPlan(f.pool,pm,withdrawal(plan));
 assert.equal(result.withdrawn,true);assert.equal(result.plan.id,plan.id);assert.deepEqual(result.plan.items,plan.items);assert.deepEqual(result.plan.rich_text,rich);
 assert.deepEqual(await listMonthlyPlans(f.pool,pm,{project_id:plan.project_id,line,month:'2026-11'}),[]);
 const archived=(await f.admin.query('SELECT * FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[plan.id])).rows[0];
 assert.deepEqual(archived.snapshot,original);assert.equal(archived.withdrawn_by,pm.id);assert.ok(archived.withdrawn_at);assert.ok(archived.withdrawal_txid);
 const retried=await withdrawMonthlyPlan(f.pool,pm,withdrawal(plan));assert.equal(retried.withdrawn,true);assert.deepEqual(retried.plan,original);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[plan.id])).rows[0].n,1);
 const after=await state(f.admin);for(const key of ['reports','profiles','members','auth','requests'])assert.deepEqual(after[key],before[key],key+' unchanged');
 const replacement=await confirmMonthlyPlan(f.pool,pm,confirmation({items:[{...item,name:'修正后的下月事项'}],rich_text:{}}));
 assert.notEqual(replacement.id,plan.id);assert.equal(replacement.items[0].name,'修正后的下月事项');
 await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(plan)),errorCode('monthly_plan_changed'));
 assert.equal((await listMonthlyPlans(f.pool,pm,{project_id:plan.project_id,line}))[0].id,replacement.id);
 assert.deepEqual((await f.admin.query('SELECT snapshot FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[plan.id])).rows[0].snapshot,original);
});

test('withdrawal requires the original approved assigned professional and rechecks revoked project and module access',async t=>{
 const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,pm,confirmation());
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES('withdraw-peer','匿名同专业人员','pm','approved','demo-com',$1)",[line]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES('withdraw-peer','demo-com','pm')");
 for(const actor of [ops,{id:'demo-president'},{id:'demo-pzo'},{id:'demo-pm-res'},{id:'withdraw-peer'}])await assert.rejects(withdrawMonthlyPlan(f.pool,actor,withdrawal(plan)),error=>error.status===403);
 await f.admin.query("UPDATE public.profiles SET status='pending' WHERE user_id=$1",[pm.id]);
 await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(plan)),error=>error.status===403);
 await f.admin.query("UPDATE public.profiles SET status='approved',biz_line='成本' WHERE user_id=$1",[pm.id]);
 await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(plan)),error=>error.status===403);
 await f.admin.query('UPDATE public.profiles SET biz_line=$2,project_id=NULL WHERE user_id=$1',[pm.id,line]);
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);
 await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(plan)),error=>error.status===403);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans WHERE id=$1',[plan.id])).rows[0].n,1);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals')).rows[0].n,0);
});

test('residential independent professions can withdraw only their own confirmation and leave other professional plans intact',async t=>{
 const f=await fixture(t),engineer={id:'withdraw-res-engineer'},designer={id:'withdraw-res-designer'};
 await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('withdraw-res','匿名住宅撤回项目','res')");
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,'匿名工程人员','pm','approved','withdraw-res','工程'),($2,'匿名设计人员','pm','approved','withdraw-res','设计')",[engineer.id,designer.id]);
 for(const actor of [engineer,designer])await f.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'withdraw-res','pm')",[actor.id]);
 const first=await confirmMonthlyPlan(f.pool,engineer,confirmation({project_id:'withdraw-res',line:'工程'}));
 const other=await confirmMonthlyPlan(f.pool,designer,confirmation({project_id:'withdraw-res',line:'设计',rich_text:{}}));
 await assert.rejects(withdrawMonthlyPlan(f.pool,designer,withdrawal(first)),error=>error.status===403);
 await withdrawMonthlyPlan(f.pool,engineer,withdrawal(first));
 const plans=await listMonthlyPlans(f.pool,ops,{project_id:'withdraw-res'});assert.equal(plans.length,1);assert.equal(plans[0].id,other.id);
});

test('current and history-only weekly references prevent withdrawal and preserve the confirmation and original report',async t=>{
 const f=await fixture(t),first=await confirmMonthlyPlan(f.pool,pm,confirmation());
 const report=(await executeDatabase(f.pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'demo-com',line,period:'2026-11-02',biz:{monthly_plan_id:first.id,monthly_plan_month:'2026-11',items:[{...item,prog:'原进展'}]},rich_text:{v:1,fields:Object.fromEntries(Object.entries(rich.fields).map(([key,doc])=>['biz.'+key,doc]))}}}))[0];
 let before=await state(f.admin);await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(first)),errorCode('monthly_plan_in_use'));assert.deepEqual(await state(f.admin),before);
 const second=await confirmMonthlyPlan(f.pool,pm,confirmation({month:'2026-12'}));
 await f.admin.query('UPDATE public.reports SET history=$2 WHERE id=$1',[report.id,JSON.stringify([{at:'2026-10-28T00:00:00Z',by:pm.id,data:{biz:{monthly_plan_id:second.id,items:[item]}}}])]);
 before=await state(f.admin);await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(second)),errorCode('monthly_plan_in_use'));assert.deepEqual(await state(f.admin),before);
});

test('completion and extension histories of every status keep their monthly source immutable',async t=>{
 const f=await fixture(t);
 const variants=[['pending','completion'],['approved','completion'],['rejected','completion'],['withdrawn','completion'],['reopened','completion'],['pending','extension'],['approved','extension']];
 for(let index=0;index<variants.length;index++){
  const [status,type]=variants[index],month='2027-'+String(index+1).padStart(2,'0');
  const plan=await confirmMonthlyPlan(f.pool,pm,confirmation({month})),key='monthly:demo-com:'+plan.id+':'+item.source_id;
  const preview=await previewCompletion(f.pool,pm,{source_key:key});
  let request=await requestCompletion(f.pool,pm,{source_key:key,source_version:preview.source_version,request_type:type,completion_note:'匿名完成或延期说明',...(type==='extension'?{requested_due:'2026-12-01'}:{completion_date:'2026-11-20'})});
  if(status==='approved' || status==='reopened')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'approve'});
  if(status==='reopened')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'reopen',note:'匿名重开原因'});
  if(status==='rejected')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'reject',note:'匿名退回原因'});
  if(status==='withdrawn')request=await withdrawCompletion(f.pool,pm,{id:request.id,expected_revision:request.revision});
  assert.equal(request.status,status);const before=await state(f.admin);
  await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(plan)),errorCode('monthly_plan_in_use'));assert.deepEqual(await state(f.admin),before,status+' '+type);
 }
});

test('snapshot-only historical references block withdrawal, and withdrawn plan IDs cannot create dangling completion requests',async t=>{
 const f=await fixture(t),snapshotPlan=await confirmMonthlyPlan(f.pool,pm,confirmation());
 await rawRequest(f.pool,snapshotPlan,{sourceKey:'legacy-snapshot:'+randomUUID()});
 await assert.rejects(withdrawMonthlyPlan(f.pool,pm,withdrawal(snapshotPlan)),errorCode('monthly_plan_in_use'));
 const unused=await confirmMonthlyPlan(f.pool,pm,confirmation({month:'2026-12'}));await withdrawMonthlyPlan(f.pool,pm,withdrawal(unused));
 await assert.rejects(rawRequest(f.pool,unused),error=>error.code==='23514' && error.message.startsWith('月度计划'));
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.completion_requests')).rows[0].n,1);
});

test('invalid requests, direct table writes and private audit access cannot bypass the controlled withdrawal',async t=>{
 const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,pm,confirmation());
 for(const request of [null,{}, {...withdrawal(plan),month:'2026-13'},{...withdrawal(plan),expected_plan_id:'not-a-uuid'},{...withdrawal(plan),actor_id:pm.id}])await assert.rejects(withdrawMonthlyPlan(f.pool,pm,request),error=>error.status===400);
 for(const sql of ["UPDATE public.monthly_plans SET items='[]' WHERE id=$1",'DELETE FROM public.monthly_plans WHERE id=$1','SELECT snapshot FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1'])await assert.rejects(withIdentity(f.pool,pm.id,client=>client.query(sql,[plan.id])),error=>error.code==='42501');
 await assert.rejects(withIdentity(f.admin,pm.id,client=>client.query('DELETE FROM public.monthly_plans WHERE id=$1',[plan.id])),error=>error.code==='42501');
 const permissions=(await f.admin.query("SELECT has_table_privilege('app_runtime','public.monthly_plans','UPDATE') can_update,has_table_privilege('app_runtime','public.monthly_plans','DELETE') can_delete,has_table_privilege('app_runtime','app_private.monthly_plan_withdrawals','SELECT') can_read_history")).rows[0];
 assert.deepEqual(permissions,{can_update:false,can_delete:false,can_read_history:false});
});

test('027 can be reapplied without rewriting business rows, private withdrawal evidence, accounts or grants',async t=>{
 const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,pm,confirmation());await withdrawMonthlyPlan(f.pool,pm,withdrawal(plan));
 await confirmMonthlyPlan(f.pool,pm,confirmation({items:[{...item,name:'重新确认后的保留事项'}],rich_text:{}}));
 const before=await state(f.admin),sql=await readFile(new URL('../db/027-monthly-plan-withdrawal.sql',import.meta.url),'utf8');
 await f.db.exec(sql);await f.db.exec(sql);assert.deepEqual(await state(f.admin),before);
 assert.equal((await f.admin.query("SELECT has_table_privilege('app_runtime','public.monthly_plans','DELETE') value")).rows[0].value,false);
});

test('a frozen instance rejects the new withdrawal endpoint before any business handler runs',async t=>{
 const app=express();let reached=false;app.use('/api',readOnlyGate({readOnly:true}));app.post('/api/monthly-plans/withdraw',(_req,res)=>{reached=true;res.json({});});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/monthly-plans/withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,403);assert.equal((await response.json()).error.code,'INSTANCE_READ_ONLY');assert.equal(reached,false);
});

test('actual HTTP and browser let the author cancel withdrawal, reopen the next-month draft with rich text, edit and reconfirm safely',async t=>{
 const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());
 const admin=testPool(runtime.db,null),user={id:'ai-local-acceptance-user'},date=new Date(runtime.scope.month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);const next=date.toISOString().slice(0,7);
 const plan=await confirmMonthlyPlan(runtime.pool,user,{project_id:runtime.scope.project_id,line:runtime.scope.line,month:next,items:[{...item,due:next+'-20'}],rich_text:rich});
 const reportsBefore=(await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value;
 let response=await fetch(runtime.url+'/api/monthly-plans/withdraw',{method:'POST',headers:{Origin:runtime.url,'Content-Type':'application/json'},body:JSON.stringify(withdrawal(plan))});assert.equal(response.status,401);
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));await page.evaluate(()=>MonthlyPlans.select('next'));
 const panel=page.locator('.monthly-next-plan');await expect(panel).toContainText(item.name);
 const withdraw=panel.getByRole('button',{name:'撤回确认并修改',exact:true});await expect(withdraw).toBeVisible();
 page.once('dialog',dialog=>dialog.dismiss());await withdraw.click();assert.equal((await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line:plan.line,month:next}))[0].id,plan.id);
 response=await page.request.post(runtime.url+'/api/monthly-plans/withdraw',{headers:{Origin:runtime.url},data:{...withdrawal(plan),expected_plan_id:'00000000-0000-4000-8000-000000000000'}});assert.equal(response.status(),409);assert.equal((await response.json()).error.code,'monthly_plan_changed');
 page.once('dialog',dialog=>dialog.accept());await withdraw.click();
 const editor=panel.locator('[data-rich-editor-for="monthly_next_name_0"] .ql-editor');await expect(editor).toContainText(item.name);await expect(editor.locator('strong')).toContainText(item.name);await expect(panel.locator('#monthly_next_due_0')).toHaveValue(next+'-20');
 assert.equal((await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line:plan.line,month:next})).length,0);
 await editor.fill('修改后重新确认的下月事项');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));await page.evaluate(()=>MonthlyPlans.select('next'));await expect(editor).toContainText('修改后重新确认的下月事项');
 await panel.getByRole('button',{name:'确认下月计划',exact:true}).click();await expect(panel).toContainText('已确认');await expect(panel).toContainText('修改后重新确认的下月事项');
 const active=(await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line:plan.line,month:next}))[0];assert.notEqual(active.id,plan.id);assert.equal(active.items[0].source_id,item.source_id);assert.equal(active.items[0].name,'修改后重新确认的下月事项');
 assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[plan.id])).rows[0].n,1);assert.deepEqual((await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value,reportsBefore);assert.deepEqual(errors,[]);
 const artifacts=process.env.MONTHLY_WITHDRAW_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-monthly-withdrawal');await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'next-month-reconfirmed.png'),fullPage:true});
});

test('a lost withdrawal response can be retried idempotently and current-month rich feedback survives a reload',async t=>{
 const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());const admin=testPool(runtime.db,null),user={id:'ai-local-acceptance-user'};
 await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES('withdraw-ui-current','匿名当月恢复验证','res',0)");
 await admin.query("UPDATE public.profiles SET project_id='withdraw-ui-current',discipline='工程',biz_line=NULL WHERE user_id=$1",[user.id]);
 await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'withdraw-ui-current','pm')",[user.id]);
 const plan=await confirmMonthlyPlan(runtime.pool,user,{project_id:'withdraw-ui-current',line:'工程',month:runtime.scope.month,items:[{...item,due:runtime.scope.week}],rich_text:rich});
 const before=(await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value;
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));
 const toolbar=page.locator('.monthly-plan-toolbar'),feedback=page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor');await expect(page.locator('.report3-monthly-table')).toContainText(item.name);
 await feedback.fill('响应丢失时必须保留的当月未提交反馈');await feedback.press('Control+A');await feedback.press('Control+B');
 let committed=false;
 await page.route('**/api/monthly-plans/withdraw',async route=>{
  const response=await route.fetch();committed=response.status()===200 && (await response.json()).data?.withdrawn===true;await route.abort('failed');
 });
 page.once('dialog',dialog=>dialog.accept());await toolbar.getByRole('button',{name:'撤回确认并修改',exact:true}).click();
 await expect(page.locator('body')).toContainText('撤回结果暂未确认');assert.equal(committed,true);assert.equal((await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line:plan.line,month:runtime.scope.month})).length,0);
 await page.unroute('**/api/monthly-plans/withdraw');page.once('dialog',dialog=>dialog.accept());await toolbar.getByRole('button',{name:'撤回确认并修改',exact:true}).click();
 await expect(toolbar.getByRole('button',{name:'确认本月计划',exact:true})).toBeVisible();
 assert.equal((await admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[plan.id])).rows[0].n,1);
 await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));
 await expect(feedback.locator('strong')).toContainText('响应丢失时必须保留的当月未提交反馈');await expect(page.locator('.report3-monthly-table')).toContainText(item.name);
 await toolbar.getByRole('button',{name:'确认本月计划',exact:true}).click();await expect(toolbar).toContainText('月计划已确认');
 const replacement=(await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line:plan.line,month:runtime.scope.month}))[0];assert.notEqual(replacement.id,plan.id);assert.equal(replacement.items[0].source_id,item.source_id);
 assert.deepEqual((await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value,before);assert.deepEqual(errors,[]);
});

test('a committed next-month withdrawal with a lost HTTP response keeps its new rich recovery draft across reload',async t=>{
 const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());const admin=testPool(runtime.db,null),user={id:'ai-local-acceptance-user'};
 await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES('withdraw-ui-next-lost','匿名下月丢响应验证','com',0)");
 await admin.query("UPDATE public.profiles SET project_id='withdraw-ui-next-lost',biz_line='机电工程' WHERE user_id=$1",[user.id]);
 await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'withdraw-ui-next-lost','pm')",[user.id]);
 const date=new Date(runtime.scope.month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);const next=date.toISOString().slice(0,7),line='机电工程';
 const plan=await confirmMonthlyPlan(runtime.pool,user,{project_id:'withdraw-ui-next-lost',line,month:next,items:[{...item,due:next+'-20'}],rich_text:rich});
 const before=(await admin.query('SELECT count(*)::int n FROM public.reports')).rows[0].n;
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();
 await page.evaluate(({pid,week})=>App.fillProject(pid,week),{pid:plan.project_id,week:runtime.scope.week});const toolbar=page.locator('.monthly-plan-toolbar');await toolbar.getByRole('button',{name:'准备下月 '+next,exact:true}).click();
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('zh_monthly_plan_draft_v1_')).length),0);
 let committed=false;await page.route('**/api/monthly-plans/withdraw',async route=>{const response=await route.fetch();committed=response.status()===200 && (await response.json()).data?.withdrawn===true;await route.abort('failed');});
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'撤回确认并修改',exact:true}).click();await expect(page.locator('body')).toContainText('撤回结果暂未确认');assert.equal(committed,true);
 assert.equal((await listMonthlyPlans(runtime.pool,user,{project_id:plan.project_id,line,month:next})).length,0);
 const recovered=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('zh_monthly_plan_draft_v1_')).map(key=>JSON.parse(localStorage.getItem(key))));assert.equal(recovered.length,1);assert.equal(recovered[0].items[0].name,item.name);
 await page.unroute('**/api/monthly-plans/withdraw');await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(({pid,week})=>App.fillProject(pid,week),{pid:plan.project_id,week:runtime.scope.week});await toolbar.getByRole('button',{name:'准备下月 '+next,exact:true}).click();
 await expect(page.locator('[data-rich-editor-for="monthly_next_name_0"] strong')).toContainText(item.name);await expect(page.getByRole('button',{name:'确认下月计划',exact:true})).toBeVisible();
 assert.equal((await admin.query('SELECT count(*)::int n FROM public.reports')).rows[0].n,before);assert.deepEqual(errors,[]);
});
