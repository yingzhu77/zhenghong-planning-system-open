import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {createUser} from '../scripts/create-user.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {managementRead,withManagementRead} from '../server/management-read.mjs';
import {confirmMonthlyPlan} from '../server/monthly-plans.mjs';
import {createCoordinationTask} from '../server/coordination-tasks.mjs';
import {listProjectPeople} from '../server/reporter-tasks.mjs';

const pm={id:'demo-pm-com'},ops={id:'demo-ops'},viewer={id:'anonymous-scoped-viewer'};
const denied=error=>error.status===403;
async function fixture(t){
 const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
 const accounts=await seedDemo(admin);
 await createUser(admin,{userId:viewer.id,email:'project.viewer@example.invalid',name:'匿名协作单位',role:'viewer',viewerScope:'projects',projects:['demo-com'],password:'anonymous-pass'});
 return {db,admin,pool,accounts};
}

test('037 preserves legacy viewer scope and data, and is idempotent',async t=>{
 const db=await initializedDatabase({through:36});t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
 await seedDemo(admin);
 await admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES('legacy-viewer','legacy@example.invalid','anonymous-not-for-login')");
 await admin.query("INSERT INTO public.profiles(user_id,name,role,status,management_viewer) VALUES('legacy-viewer','匿名旧查看人','viewer','approved',false)");
 const before=(await admin.query('SELECT id,name,project_type,reporting_professions FROM public.projects ORDER BY id')).rows;
 assert.equal((await managementRead(pool,{id:'legacy-viewer'},{view:'projects'})).projects.length,2);
 const migration=await readFile(new URL('../db/037-project-scoped-viewers.sql',import.meta.url),'utf8');
 await db.exec('RESET ROLE');await db.exec(migration);await db.exec(migration);
 assert.deepEqual((await admin.query('SELECT id,name,project_type,reporting_professions FROM public.projects ORDER BY id')).rows,before);
 const legacy=await managementRead(pool,{id:'legacy-viewer'},{view:'projects'});
 assert.equal(legacy.read_scope,'all');assert.equal(legacy.projects.length,2);
 assert.equal((await admin.query("SELECT viewer_scope FROM public.profiles WHERE user_id='legacy-viewer'")).rows[0].viewer_scope,'all');
});

test('restricted viewer reads assigned plans, linked weekly progress and archive, while writes and other projects are refused',async t=>{
 const f=await fixture(t),line='土建工程（东地块）';
 const plan=await confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',items:[{source_id:'a',mod:'匿名模块',name:'匿名确认事项',due:'2026-11-30'}]});
 await executeDatabase(f.pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line,author_id',values:{project_id:'demo-com',period:'2026-11-02',line,
  biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-11',items:plan.items.map(row=>({...row,prog:'匿名已保存周进展',blocker:''}))}}});
 const data=await managementRead(f.pool,viewer,{view:'plans',month:'2026-11'});
 assert.equal(data.read_scope,'projects');assert.deepEqual(data.projects.map(p=>p.id),['demo-com']);assert.equal(data.rows.length,1);
 assert.equal(data.rows[0].id,plan.id);assert.equal(data.rows[0].items[0].name,'匿名确认事项');
 assert.equal(data.rows[0].reports.length,1);assert.equal(data.rows[0].reports[0].biz.items[0].prog,'匿名已保存周进展');
 assert.equal((await managementRead(f.pool,viewer,{view:'archive',project_id:'demo-com'})).project_id,'demo-com');
 for(const view of ['plans','archive','coordination','completions','meetings'])
  await assert.rejects(managementRead(f.pool,viewer,{view,project_id:'demo-res',...(view==='plans'?{month:'2026-11'}:{})}),denied);
 assert.deepEqual(await executeDatabase(f.pool,viewer,{table:'projects',columns:'id'}),[]);
 await assert.rejects(executeDatabase(f.pool,viewer,{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_scope:'all'}}),denied);
 await assert.rejects(confirmMonthlyPlan(f.pool,viewer,{project_id:'demo-com',line,month:'2026-12',items:plan.items}),denied);
 await assert.rejects(withManagementRead(f.pool,viewer,c=>c.query("INSERT INTO public.project_master(project_id,fields) VALUES('demo-com','{}')")),e=>e.code==='42501');
 assert.equal((await withManagementRead(f.pool,viewer,c=>c.query("UPDATE public.profiles SET role='ops' WHERE user_id=$1 RETURNING user_id",[viewer.id]))).rows.length,0);
 await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1',[viewer.id]);
 assert.equal((await managementRead(f.pool,viewer,{view:'plans',month:'2026-11'})).rows.length,0);
});

test('restricted viewers are selectable coordination recipients only in their assigned project and remain read-only',async t=>{
 const f=await fixture(t);
 let people=await listProjectPeople(f.pool,pm,{project_id:'demo-com'});
 assert.ok(people.some(p=>p.user_id===viewer.id && p.role==='viewer'));
 assert.ok(!(await listProjectPeople(f.pool,ops,{project_id:'demo-res'})).some(p=>p.user_id===viewer.id));
 const row=await createCoordinationTask(f.pool,pm,{id:randomUUID(),project_id:'demo-com',owner_id:viewer.id,what:'匿名待协调事项',due:'2026-11-30'});
 assert.equal(row.owner_name,'匿名协作单位');
 const records=await managementRead(f.pool,viewer,{view:'coordination',project_id:'demo-com'});
 assert.ok(records.rows.some(r=>r.what==='匿名待协调事项'));
 await assert.rejects(createCoordinationTask(f.pool,viewer,{id:randomUUID(),project_id:'demo-com',owner_id:pm.id,what:'禁止发起',due:''}),denied);
 await f.admin.query('UPDATE app_private.auth_users SET disabled=true WHERE user_id=$1',[viewer.id]);
 people=await listProjectPeople(f.pool,pm,{project_id:'demo-com'});assert.ok(!people.some(p=>p.user_id===viewer.id));
 await assert.rejects(createCoordinationTask(f.pool,pm,{id:randomUUID(),project_id:'demo-com',owner_id:viewer.id,what:'禁止停用对象',due:''}),e=>e.status===400);
});

test('plan pagination is bound to month, and project grants cannot expose partial merged scopes',async t=>{
 const f=await fixture(t),other={id:'anonymous-cost'};
 await createUser(f.admin,{userId:other.id,email:'cost@example.invalid',name:'匿名成本',role:'pm',projects:['demo-com'],line:'成本',password:'anonymous-pass'});
 for(const [user,line] of [[pm,'土建工程（东地块）'],[other,'成本']])await confirmMonthlyPlan(f.pool,user,{project_id:'demo-com',line,month:'2026-11',items:[{source_id:'a',mod:'测试',name:'匿名计划',due:'2026-11-30'}]});
 const first=await managementRead(f.pool,viewer,{view:'plans',month:'2026-11',limit:1});
 assert.equal(first.rows.length,1);assert.equal(first.has_more,true);
 const second=await managementRead(f.pool,viewer,{view:'plans',month:'2026-11',limit:1,cursor:first.next_cursor});
 assert.equal(second.rows.length,1);assert.notEqual(first.rows[0].id,second.rows[0].id);assert.equal(second.has_more,false);
 await assert.rejects(managementRead(f.pool,viewer,{view:'plans',month:'2026-12',cursor:first.next_cursor}),e=>e.status===400);
 await assert.rejects(managementRead(f.pool,viewer,{view:'archive',month:'2026-11'}),e=>e.status===400);
 await f.admin.query("INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week) VALUES('anonymous-mixed-scope','匿名合并范围','demo-com',ARRAY['demo-com','demo-res'],'2026-10-26')");
 await f.admin.query("INSERT INTO public.monthly_plan_summaries(id,project_id,report_scope_id,scope_project_ids,line,owner_id,owner_name,plan_month,items,updated_by) VALUES($1,'demo-com','anonymous-mixed-scope',ARRAY['demo-com','demo-res'],'匿名专业','demo-pm-com','匿名提报人','2026-11-01','[]','demo-ops')",[randomUUID()]);
 assert.equal((await withManagementRead(f.pool,viewer,c=>c.query('SELECT id FROM public.monthly_plan_summaries'))).rows.length,0);
 await executeDatabase(f.pool,ops,{table:'project_members',operation:'insert',values:{user_id:viewer.id,project_id:'demo-res',role_in_project:'viewer'}});
 assert.equal((await withManagementRead(f.pool,viewer,c=>c.query('SELECT id FROM public.monthly_plan_summaries'))).rows.length,1);
});

test('actual login, read-only plan navigation and selecting a scoped viewer as coordination recipient work in desktop and narrow Edge',{timeout:90000},async t=>{
 const {createApp}=await import('../server/app.mjs');
 const {chromium,expect}=await import('@playwright/test');
 const {mkdir,mkdtemp,rm}=await import('node:fs/promises');
 const os=await import('node:os'),path=await import('node:path');
 const f=await fixture(t),line='土建工程（东地块）',plan=await confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',items:[{source_id:'browser-a',mod:'匿名模块',name:'匿名浏览器确认计划',due:'2026-11-30'}]});
 await executeDatabase(f.pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line,author_id',values:{project_id:'demo-com',period:'2026-11-02',line,
  biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-11',items:plan.items.map(item=>({...item,prog:'匿名浏览器周进展',blocker:''}))}}});
 await f.admin.query("DELETE FROM public.reports WHERE project_id='demo-com' AND author_id=$1 AND period<>'2026-11-02'",[pm.id]);
 const dir=await mkdtemp(path.join(os.tmpdir(),'scoped-viewers-browser-'));
 const app=createApp({pool:f.pool,config:{authCodeSecret:randomUUID()+randomUUID(),readOnly:false,publicOrigin:'',cookieSecure:false,sessionHours:1,uploadDir:dir,
  mailer:{configured:false,async sendCode(){throw new Error('isolated test never sends mail');}}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
 const artifacts=path.resolve('.local/project-scoped-viewers-20261110');await mkdir(artifacts,{recursive:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#email').fill('project.viewer@example.invalid');await page.locator('#password').fill('anonymous-pass');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'月计划与周进展',exact:true})).toBeVisible();
  await page.getByLabel('只读计划月份').fill('2026-11');await page.getByLabel('只读计划月份').dispatchEvent('change');
  await expect(page.locator('.management-reader')).toContainText('匿名浏览器确认计划');
  await page.getByText('已提交周进展（1）',{exact:true}).click();await expect(page.locator('.management-reader')).toContainText('匿名浏览器周进展');
  await expect(page.getByLabel('只读查看项目').locator('option[value="demo-res"]')).toHaveCount(0);
  await expect(page.locator('main textarea,main input[type=file],main [contenteditable=true]')).toHaveCount(0);
  await page.locator('main').screenshot({path:path.join(artifacts,'scoped-plans-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('main').screenshot({path:path.join(artifacts,'scoped-plans-narrow.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
  const headers={Origin:url};
  assert.equal((await page.request.post(url+'/api/management-read',{headers,data:{view:'plans',project_id:'demo-res',month:'2026-11'}})).status(),403);
  assert.equal((await page.request.post(url+'/api/db',{headers,data:{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_scope:'all'}}})).status(),403);
  const pmContext=await browser.newContext({viewport:{width:1440,height:1000}}),author=await pmContext.newPage();author.on('pageerror',e=>errors.push(e.message));
  const account=f.accounts.find(row=>row.id===pm.id);
  await author.goto(url);await author.locator('#email').fill(account.email);await author.locator('#password').fill(account.password);await author.getByRole('button',{name:'登录',exact:true}).click();
  await expect(author.locator('.planning-mainnav')).toBeVisible();
  await expect(author.getByRole('button',{name:'工作台',exact:true})).toHaveCount(0);
  await expect(author.locator('.reporter-overview-content')).toBeVisible();
  await expect(author.getByText('即时协调',{exact:true})).toHaveCount(0);
  const peopleResponse=await author.request.post(url+'/api/project-people/list',{headers,data:{project_id:'demo-com'}});
  assert.equal(peopleResponse.status(),200);assert.ok((await peopleResponse.json()).data.some(p=>p.user_id===viewer.id));
  const text='匿名浏览器跨部门协调事项';
  const retired=await author.request.post(url+'/api/coordination-tasks/create',{headers,
    data:{id:randomUUID(),project_id:'demo-com',owner_id:viewer.id,what:text}});
  assert.equal(retired.status(),410);
  assert.equal((await retired.json()).error.code,'coordination_create_retired');
  assert.equal((await f.admin.query('SELECT 1 FROM public.coordination_tasks WHERE what=$1',[text])).rows.length,0);
  const owner=author.locator('#co_who_0');
  await expect(owner.locator('option[value="'+viewer.id+'"]')).toHaveCount(1);
  await owner.selectOption(viewer.id);
  await author.locator('[data-rich-editor-for="co_what_0"] .ql-editor').fill(text);
  const before=await page.request.post(url+'/api/management-read',{headers,data:{view:'coordination',project_id:'demo-com'}});
  assert.ok(!(await before.json()).data.rows.some(item=>item.what===text));
  const [submitted]=await Promise.all([
    author.waitForResponse(response=>response.url().endsWith('/api/db') && response.request().postDataJSON()?.operation==='upsert'),
    author.getByRole('button',{name:/^(提交本模块直报|重新提交（土建工程（东地块））)$/}).click()
  ]);
  assert.equal(submitted.status(),200,JSON.stringify((await submitted.json()).error));
  const [row]=(await f.admin.query("SELECT coord_items FROM public.reports WHERE project_id='demo-com' AND coord_items @> $1::jsonb",[JSON.stringify([{what:text}])])).rows;
  assert.equal(row.coord_items.find(item=>item.what===text).who_id,viewer.id);
  await author.locator('main').screenshot({path:path.join(artifacts,'scoped-coordination-recipient.png')});
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'事项管理',exact:true}).click();await page.getByRole('button',{name:'协调需求（只读）',exact:true}).click();
  await expect(page.locator('.management-reader')).toContainText('匿名浏览器跨部门协调事项');
  assert.deepEqual(errors,[]);
 }catch(error){
  const {writeFile}=await import('node:fs/promises');
  for(const [index,c] of browser.contexts().entries())for(const p of c.pages()){
   await writeFile(path.join(artifacts,'failure-'+index+'.txt'),await p.locator('body').innerText());
   await writeFile(path.join(artifacts,'failure-layout-'+index+'.json'),JSON.stringify(await p.evaluate(()=>Array.from(document.querySelectorAll('body,main,.management-reader,.management-reader-record,.management-reader-plan-scroll,table,tbody,tr,td')).map(el=>{
    const rect=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,cls:el.className,left:rect.left,right:rect.right,width:rect.width,minWidth:s.minWidth,display:s.display,overflow:s.overflow,client:el.clientWidth,scroll:el.scrollWidth};
   })),null,2));
   await p.screenshot({path:path.join(artifacts,'failure-'+index+'.png'),fullPage:true});
  }
  throw error;
 }finally{await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await rm(dir,{recursive:true,force:true});}
});
