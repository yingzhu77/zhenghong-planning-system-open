import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {chromium,expect} from '@playwright/test';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {confirmMonthlyPlan,listMonthlyPlans} from '../server/monthly-plans.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {previewCompletion,requestCompletion,reviewCompletion} from '../server/completions.mjs';
import {loadPlanningAIFacts} from '../server/planning-ai-data.mjs';

const engineering={id:'res-engineer'},design={id:'res-designer'},ops={id:'res-operator'};
const item={source_id:'res-source-one',mod:'工程',name:'匿名工程十月计划',due:'2026-10-31'};
const artifacts=process.env.RES_MONTHLY_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-residential-monthly');

test('residential professional views preserve saved ownership, mixed items, rich text and original records',async()=>{
 const context={window:{}};vm.runInNewContext(await readFile(new URL('../web/rich-text.js',import.meta.url),'utf8'),context);vm.runInNewContext(await readFile(new URL('../web/monthly-plans.js',import.meta.url),'utf8'),context);
 const model=context.window.MonthlyPlans,people=[{user_id:'p1',discipline:'工程'}];
 const reports=[{id:1,line:'设计',author_id:'p1',biz:{items:[{mod:'设计',name:'已保存设计归属'}]}},
  {id:2,line:'综合',report_scope_id:'scope',change_text:'未分专业的原记录',biz:{attachments:['original-file'],items:[{mod:'工程',name:'工程原文'},{mod:'设计',name:'设计原文'},{mod:'砌筑',name:'未归专业原文'}]},rich_text:{v:1,fields:{'biz.items.1.name':{ops:[{insert:'设计原文',attributes:{bold:true}}]}}}}];
 reports.forEach(context.window.ZHRichText.attach);const before=JSON.stringify(reports);
 const engineering=model.residentialReports(reports,'工程',people),design=model.residentialReports(reports,'设计',people),unassigned=model.residentialReports(reports,'__unassigned__',people);
 assert.equal(engineering.length,1);assert.equal(engineering[0].biz.items[0].name,'工程原文');assert.equal(engineering[0].change_text,'');assert.equal(engineering[0].biz.attachments.length,0);
 assert.equal(design.length,2);assert.equal(context.window.ZHRichText.field(design[1].biz.items[0],'name'),'<strong>设计原文</strong>');
 assert.equal(unassigned.length,1);assert.equal(unassigned[0].biz.items.length,1);assert.equal(unassigned[0].biz.items[0].name,'未归专业原文');assert.equal(unassigned[0].change_text,'未分专业的原记录');
 assert.equal(JSON.stringify(reports),before);assert.equal(model.residentialReports(reports,'',people).length,2);
});
async function fixture(t){
 const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
 await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('res-month','匿名住宅月计划','res'),('scope-a','匿名统一一期','res'),('scope-b','匿名统一二期','res')");
 await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES('res-engineer','匿名工程填报人','pm','approved','res-month','工程'),('res-designer','匿名设计填报人','pm','approved','res-month','设计'),('res-operator','匿名管理员','ops','approved',NULL,NULL)");
 for(const user of [engineering,design])await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'res-month','pm'),($1,'scope-a','pm'),($1,'scope-b','pm')",[user.id]);
 await admin.query("INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week) VALUES('res-test-scope','匿名统一范围','scope-a',ARRAY['scope-a','scope-b'],'2026-10-05')");
 return {db,admin,pool};
}
const confirmation=(line='工程',items=[item])=>({project_id:'res-month',line,month:'2026-10',items});
const save=(pool,user,line,plan,extra={})=>executeDatabase(pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'res-month',line,period:'2026-10-26',biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-10',items:plan.items.map(row=>({...row,prog:'本周推进记录'})),...extra}}});

test('residential disciplines confirm independently; project, discipline, approval and unified-scope guards remain enforced',async t=>{
 const f=await fixture(t),a=await confirmMonthlyPlan(f.pool,engineering,confirmation()),b=await confirmMonthlyPlan(f.pool,design,confirmation('设计',[{...item,mod:'设计',name:'匿名设计十月计划'}]));
 assert.equal(a.confirmed_by,engineering.id);assert.equal(b.confirmed_by,design.id);
 assert.equal((await listMonthlyPlans(f.pool,ops,{project_id:'res-month',month:'2026-10'})).length,2);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports')).rows[0].n,0,'confirmation creates no weekly submission');
 await assert.rejects(confirmMonthlyPlan(f.pool,engineering,confirmation('设计')),e=>e.status===403);
 await assert.rejects(confirmMonthlyPlan(f.pool,engineering,{...confirmation(),project_id:'scope-a'}),e=>e.status===403);
 await assert.rejects(confirmMonthlyPlan(f.pool,ops,confirmation()),e=>e.status===403);
 await assert.rejects(confirmMonthlyPlan(f.pool,engineering,confirmation()),e=>e.status===409);
 await assert.rejects(confirmMonthlyPlan(f.pool,engineering,confirmation('综合')),e=>e.status===400);
 await f.admin.query("UPDATE public.profiles SET status='pending' WHERE user_id=$1",[design.id]);
 await assert.rejects(listMonthlyPlans(f.pool,design,{project_id:'res-month'}),e=>e.status===403);
});

test('same project and week retain separate professional reports and immutable confirmed items, while original comprehensive reports stay editable',async t=>{
 const f=await fixture(t);
 const legacy=(await executeDatabase(f.pool,engineering,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'res-month',period:'2026-10-19',line:'综合',biz:{items:[{...item,name:'原综合报告事项',prog:'原综合进展'}]}}}))[0];
 const a=await confirmMonthlyPlan(f.pool,engineering,confirmation()),b=await confirmMonthlyPlan(f.pool,design,confirmation('设计',[{...item,mod:'设计',name:'设计事项'}]));
 const ar=(await save(f.pool,engineering,'工程',a))[0],br=(await save(f.pool,design,'设计',b))[0];assert.notEqual(ar.id,br.id);
 await assert.rejects(save(f.pool,engineering,'设计',b),e=>e.status===403);
 await assert.rejects(save(f.pool,engineering,'工程',a,{items:[{...item,name:'篡改固定事项'}]}),e=>e.code==='monthly_plan_locked' && e.status===409);
 await assert.rejects(executeDatabase(f.pool,engineering,{table:'reports',operation:'insert',values:{project_id:'res-month',period:'2026-10-12',line:'工程',biz:{items:[item]}}}),e=>e.code==='monthly_plan_locked' && e.status===409);
 const updated=(await executeDatabase(f.pool,engineering,{table:'reports',operation:'update',filters:[{column:'id',value:legacy.id}],values:{biz:{items:[{...item,name:'原综合报告事项',prog:'综合新进展'}]}}}))[0];
 assert.equal(updated.line,'综合');assert.equal(updated.biz.items[0].prog,'综合新进展');assert.equal(updated.history.length,1);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports')).rows[0].n,3);
 await assert.rejects(withIdentity(f.pool,engineering.id,c=>c.query("INSERT INTO public.reports(project_id,period,line,author_id,biz) VALUES('res-month','2026-11-02','设计',$1,'{}')",[engineering.id])),e=>e.code==='42501');
});

test('residential monthly completion and personal AI facts work before a weekly report without leaking another discipline',async t=>{
 const f=await fixture(t),a=await confirmMonthlyPlan(f.pool,engineering,confirmation());
 await confirmMonthlyPlan(f.pool,design,confirmation('设计',[{...item,mod:'设计',name:'另一专业的月计划'}]));
 const key='monthly:res-month:'+a.id+':'+item.source_id,preview=await previewCompletion(f.pool,engineering,{source_key:key});
 assert.equal(preview.what,item.name);await assert.rejects(previewCompletion(f.pool,design,{source_key:key}),e=>[403,404].includes(e.status));
 const request=await requestCompletion(f.pool,engineering,{source_key:key,source_version:preview.source_version,completion_date:'2026-10-30',completion_note:'匿名验收记录'});
 await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'approve'});
 const facts=await loadPlanningAIFacts(f.pool,engineering,{project_id:'res-month',line:'工程',scope_project_ids:[]},{kind:'summary',scope:'current',start:'',end:'',keyword:'',project_name:'',limit:10},{now:new Date('2026-10-27T04:00:00Z')});
 assert.ok(facts.items.some(row=>row.what===item.name));assert.ok(!JSON.stringify(facts).includes('另一专业的月计划'));
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports')).rows[0].n,0);
});

test('026 is repeatable and preserves existing business rows, accounts and comprehensive report history',async t=>{
 const f=await fixture(t);await confirmMonthlyPlan(f.pool,engineering,confirmation());
 const snapshot=async()=>(await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.monthly_plans t),'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.profiles t),'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,user_id) FROM public.project_members t)) state")).rows[0].state;
 const before=await snapshot();await f.db.exec(await readFile(new URL('../db/026-residential-monthly-plans.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);
 await assert.rejects(withIdentity(f.pool,engineering.id,c=>c.query('UPDATE public.monthly_plans SET items=items')),e=>e.code==='42501');
});

test('real residential forms, professional drafts, overview and linked projection use confirmed plans without inventing weekly submissions',async t=>{
 const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());
 const admin=testPool(runtime.db,null),user={id:'ai-local-acceptance-user'},designer={id:'res-ui-designer'},manager={id:'res-ui-manager'};
 await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES('res-ui','匿名住宅专业计划','res',0)");
 await admin.query("UPDATE public.profiles SET project_id='res-ui',discipline='工程',biz_line=NULL WHERE user_id=$1",[user.id]);
 await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,'匿名设计负责人','pm','approved','res-ui','设计'),($2,'匿名会议管理员','ops','approved',NULL,NULL)",[designer.id,manager.id]);
 for(const [id,email] of [[designer.id,'designer@example.invalid'],[manager.id,'manager@example.invalid']])await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) SELECT $1,$2,password_hash FROM app_private.auth_users WHERE user_id=$3',[id,email,user.id]);
 for(const id of [user.id,designer.id])await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'res-ui','pm')",[id]);
 const engineeringPlan=await confirmMonthlyPlan(runtime.pool,user,{project_id:'res-ui',line:'工程',month:runtime.scope.month,items:[{...item,due:runtime.scope.week}]});
 await confirmMonthlyPlan(runtime.pool,designer,{project_id:'res-ui',line:'设计',month:runtime.scope.month,items:[{...item,name:'匿名独立设计计划',mod:'设计',due:''}]});
 for(const [discipline,name] of [['工程','匿名工程核心节点'],['设计','匿名设计核心节点'],[null,'匿名未分配核心节点']])await admin.query("INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,is_key,discipline) VALUES('res-ui',$1,$2,$2,true,$3)",[name,runtime.scope.week,discipline]);
 const reportsBefore=(await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state;
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());await mkdir(artifacts,{recursive:true});
 const errors=[],pages=[];
 async function login(email){const page=await browser.newPage({viewport:{width:1560,height:1050}});pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.goto(runtime.url);await page.locator('#email').fill(email);await page.locator('#password').fill(runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();return page;}
 const engineeringPage=await login(runtime.account.email);await engineeringPage.evaluate(()=>App.view('form'));
 await expect(engineeringPage.locator('.report3-monthly-table')).toContainText(item.name);await expect(engineeringPage.locator('.report3-monthly-table')).not.toContainText('匿名独立设计计划');
 await expect(engineeringPage.getByRole('button',{name:'＋ 增加事项',exact:true})).toHaveCount(0);
 await expect(engineeringPage.locator('.monthly-plan-toolbar')).toContainText('月计划已确认');
 const editor=engineeringPage.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor');await editor.fill('工程专属草稿不泄露');await editor.press('Control+A');await editor.press('Control+B');await engineeringPage.getByRole('button',{name:'保存本机草稿',exact:true}).click();
 await engineeringPage.screenshot({path:path.join(artifacts,'engineering-form.png'),fullPage:true});await engineeringPage.reload();await expect(engineeringPage.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('工程专属草稿不泄露');
 const designerPage=await login('designer@example.invalid');await designerPage.evaluate(()=>App.view('form'));await expect(designerPage.locator('.report3-monthly-table')).toContainText('匿名独立设计计划');await expect(designerPage.locator('.report3-monthly-table')).not.toContainText(item.name);await expect(designerPage.locator('body')).not.toContainText('工程专属草稿不泄露');
 const managerPage=await login('manager@example.invalid');await managerPage.locator('#overviewFilter').selectOption('匿名住宅专业计划');const group=managerPage.locator('[data-project-group="匿名住宅专业计划"]');
 await expect(group.locator('.overview-monthly-plans')).toContainText(item.name);await expect(group.locator('.overview-monthly-plans')).toContainText('匿名独立设计计划');await expect(group.locator('.overview-monthly-plans')).toContainText('月计划已确认，本周尚未提交');await expect(group).not.toContainText('工程专属草稿不泄露');
 const opening=managerPage.waitForEvent('popup');await managerPage.getByRole('button',{name:'开启会议投影',exact:true}).click();const display=await opening;display.on('pageerror',e=>errors.push(e.message));await expect(display.locator('#meeting-screen')).toContainText(item.name);await expect(display.locator('#meeting-screen')).toContainText('匿名独立设计计划');await expect(display.locator('#meeting-screen')).toContainText('0 份所选周期已提交报告');await expect(display.locator('#meeting-screen')).toContainText('已确认月计划 · 本周尚未提交');
 await managerPage.locator('#overviewDiscipline').selectOption('工程');await expect(group.locator('.overview-monthly-plans tbody tr')).toHaveCount(1);await expect(group).not.toContainText('匿名独立设计计划');await expect(group.locator('.overview-core-nodes')).toContainText('匿名工程核心节点');await expect(group.locator('.overview-core-nodes')).not.toContainText('匿名未分配核心节点');await expect(display.locator('#meeting-screen')).toContainText(item.name);await expect(display.locator('#meeting-screen')).not.toContainText('匿名独立设计计划');await expect(display.locator('#meeting-screen')).not.toContainText('匿名未分配核心节点');
 await managerPage.getByRole('button',{name:'新增工作安排',exact:true}).click();await expect(managerPage.getByRole('combobox',{name:'工作安排专业',exact:true})).toHaveValue('工程');await managerPage.locator('[data-rich-editor-for^="overview_meeting_what_"] .ql-editor').fill('切换专业保留未保存安排');
 await managerPage.getByRole('button',{name:'暂停跟随',exact:true}).click();await managerPage.locator('#overviewDiscipline').selectOption('设计');await expect(group.locator('.overview-monthly-plans')).toContainText('匿名独立设计计划');await expect(group.locator('.overview-monthly-plans')).not.toContainText(item.name);await expect(managerPage.locator('[data-rich-editor-for^="overview_meeting_what_"] .ql-editor')).toContainText('切换专业保留未保存安排');await expect(display.locator('#meeting-screen')).toContainText(item.name);await expect(display.locator('#meeting-screen')).not.toContainText('匿名独立设计计划');
 await managerPage.getByRole('button',{name:'展示当前选择',exact:true}).click();await expect(display.locator('#meeting-screen')).toContainText('匿名独立设计计划');await expect(display.locator('#meeting-screen')).not.toContainText(item.name);await expect(display.locator('#meeting-screen')).not.toContainText('切换专业保留未保存安排');
 await managerPage.locator('#overviewDiscipline').selectOption('__unassigned__');await expect(group.locator('.overview-monthly-plans')).toContainText('暂无当月计划');await expect(group.locator('.overview-core-nodes')).toContainText('匿名未分配核心节点');await expect(group.locator('.overview-core-nodes')).not.toContainText('匿名工程核心节点');
 await managerPage.getByRole('button',{name:'恢复跟随',exact:true}).click();await expect(display.locator('#meeting-screen')).toContainText('匿名未分配核心节点');await expect(display.locator('#meeting-screen')).not.toContainText('匿名工程核心节点');
 await managerPage.locator('#overviewDiscipline').selectOption('');await expect(group.locator('.overview-monthly-plans tbody tr')).toHaveCount(2);await expect(display.locator('.meeting-plan-table tbody tr')).toHaveCount(2);
 await managerPage.locator('#overviewDiscipline').selectOption('设计');await managerPage.locator('#overviewFilter').selectOption('');await expect(managerPage.locator('#overviewDiscipline')).toHaveValue('');await managerPage.locator('#overviewFilter').selectOption('匿名住宅专业计划');
 await managerPage.setViewportSize({width:390,height:844});assert.equal(await managerPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await managerPage.setViewportSize({width:1560,height:1050});
 await managerPage.screenshot({path:path.join(artifacts,'residential-overview.png'),fullPage:true});await display.screenshot({path:path.join(artifacts,'residential-projection.png'),fullPage:true});
 assert.deepEqual((await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) state FROM public.reports r')).rows[0].state,reportsBefore);
 await engineeringPage.getByRole('button',{name:'提交本期直报',exact:true}).click();
 await expect.poll(async()=>(await admin.query("SELECT count(*)::int n FROM public.reports WHERE project_id='res-ui' AND line='工程'")).rows[0].n).toBe(1);
 await designerPage.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor').fill('设计独立反馈');await designerPage.getByRole('button',{name:'提交本期直报',exact:true}).click();
 await expect.poll(async()=>(await admin.query("SELECT count(*)::int n FROM public.reports WHERE project_id='res-ui'")).rows[0].n).toBe(2);
 const saved=(await admin.query("SELECT line,author_id,biz FROM public.reports WHERE project_id='res-ui' ORDER BY line")).rows;
 assert.deepEqual(saved.map(row=>row.line).sort(),['工程','设计'].sort());assert.equal(saved.find(row=>row.line==='工程').biz.items[0].prog,'工程专属草稿不泄露');
 assert.equal(engineeringPlan.confirmed_by,user.id);assert.deepEqual(errors,[]);
});
