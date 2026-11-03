import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {listReportScopes} from '../server/report-scopes.mjs';
import {confirmMonthlyPlan,withdrawMonthlyPlan} from '../server/monthly-plans.mjs';
import {loadPlanningAIFacts,assertPlanningAIFactAccess} from '../server/planning-ai-data.mjs';
import {loadPlanningAIMemory,savePlanningAIPreference} from '../server/planning-ai-memory.mjs';
import {uploadReportAttachment,loadReportAttachment} from '../server/report-attachments.mjs';

const zh={id:'zhenghongxu-residential',name:'正弘序',anchor:'zhx1',members:['zhx1','zhx2','klq']};
const xy={id:'xinyang-residential',name:'信阳',anchor:'xy7',members:['xy7','xy8']};
const week='2026-10-12',month='2026-10';
const people={engineer:{id:'merged-engineer'},designer:{id:'merged-designer'},peer:{id:'merged-engineer-peer'},partial:{id:'merged-partial'},ops:{id:'merged-ops'}};
const bold=text=>({ops:[{insert:text,attributes:{bold:true}}]});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const denied=error=>error.status===403;
const locked=error=>error.status===409&&error.code==='monthly_plan_locked';
async function seed(admin,users=people){
  for(const [order,pid] of [...zh.members,...xy.members,'merged-outside'].entries())await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES($1,$2,'res',$3)",[pid,'匿名原项目'+pid,order]);
  for(const [kind,line] of [['engineer','工程'],['designer','设计'],['peer','工程'],['partial','工程'],['ops',null]]){
    const user=users[kind];
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,$2,$3,'approved',$4,$5) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,role=excluded.role,status='approved',project_id=excluded.project_id,discipline=excluded.discipline,biz_line=NULL",
      [user.id,'匿名'+kind,kind==='ops'?'ops':'pm',kind==='designer'?'xy8':'klq',line]);
    if(kind!=='ops')for(const pid of kind==='partial'?['zhx1','zhx2','xy7']:[...zh.members,...xy.members])await admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,pid]);
  }
}
async function fixture(t,through=31){
  const db=await initializedDatabase({through});t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);await seed(admin);return {db,admin,pool,users:people};
}
function confirmation(scope,line,targetMonth=month,extra={}){return {project_id:scope.anchor,report_scope_id:scope.id,line,month:targetMonth,
  items:[{source_id:'shared-original-id',mod:line,name:'匿名'+line+'专业计划',due:targetMonth+'-28'}],...extra};}
function progress(plan,text='本人专业本期进展'){
  return {monthly_plan_ids:[plan.id],items:plan.items.map(item=>({...item,monthly_plan_id:plan.id,prog:text,blocker:''}))};
}
function submit(f,user,scope,line,biz={monthly_plan_ids:[],items:[]},period=week,extra={}){
  return executeDatabase(f.pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:scope.anchor,report_scope_id:scope.id,period,line,biz,...extra}});
}
const withdraw=plan=>({project_id:plan.project_id,report_scope_id:plan.report_scope_id,line:plan.line,month:String(plan.plan_month).slice(0,7),expected_plan_id:plan.id});
async function business(admin){return (await admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.reports t),'plans',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.monthly_plans t),'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.profiles t),'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id,project_id) FROM public.project_members t),'attachments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.report_attachments t)) state")).rows[0].state;}

test('030 enables merged professional scopes without rewriting any existing report, plan, author, profile, member or history',async t=>{
  const f=await fixture(t,29),plan=await confirmMonthlyPlan(f.pool,people.engineer,confirmation(zh,'工程'));
  await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,history,report_scope_id,scope_project_ids,scope_week) VALUES($1,$2,'综合',$3,'匿名原作者',$4,$5,$6,$7,$8::date)",
    [zh.anchor,'2026-10-19',people.engineer.id,JSON.stringify(progress(plan,'原综合进展')),JSON.stringify([{at:'2026-10-20T00:00:00Z',by:people.engineer.id,data:{biz:{items:[{name:'原历史正文'}]}}}]),zh.id,zh.members,'2026-10-19']);
  await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,biz) VALUES('xy8',$1,'成本',$2,$3)",[week,people.designer.id,JSON.stringify({items:[{name:'原分期快照'}]})]);
  const before=await business(f.admin),migration=await readFile(new URL('../db/030-merged-professional-reporting.sql',import.meta.url),'utf8');
  await f.db.exec(migration);await f.db.exec(migration);assert.deepEqual(await business(f.admin),before);
  const modes=(await f.admin.query('SELECT id,reporting_mode FROM app_private.report_scopes ORDER BY id')).rows;
  for(const scope of [zh,xy])assert.equal(modes.find(row=>row.id===scope.id)?.reporting_mode,'professional');
  const grants=(await f.admin.query("SELECT has_table_privilege('app_runtime','app_private.report_scopes','UPDATE') scope_update,has_table_privilege('app_runtime','public.monthly_plans','DELETE') plan_delete")).rows[0];
  assert.deepEqual(grants,{scope_update:false,plan_delete:false});
});

test('merged reporting is available in week 42 for both three-member and two-member scopes without enlarging partial project access',async t=>{
  const f=await fixture(t);
  for(const scope of [zh,xy])await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,biz) VALUES($1,$2,'综合',$3,'{}')",[scope.members.at(-1),week,people.engineer.id]);
  for(const user of [people.engineer,people.designer,people.ops]){
    const scopes=await listReportScopes(f.pool,user,{period:week});
    for(const scope of [zh,xy]){const row=scopes.find(item=>item.id===scope.id);assert.ok(row);assert.equal(row.reporting_mode,'professional');assert.equal(row.active_for_period,true);assert.deepEqual(row.project_ids,scope.members);}
  }
  assert.deepEqual(await listReportScopes(f.pool,people.partial,{period:week}),[]);
  await assert.rejects(submit(f,people.partial,zh,'工程'),denied);
  await assert.rejects(submit(f,people.partial,xy,'工程'),denied);
});

test('each individual submits their professional report under the single merged identity while author, line, member and child identities stay protected',async t=>{
  const f=await fixture(t);
  for(const scope of [zh,xy]){
    const engineering=(await submit(f,people.engineer,scope,'工程'))[0],design=(await submit(f,people.designer,scope,'设计'))[0];
    assert.notEqual(engineering.id,design.id);
    for(const [row,line,user] of [[engineering,'工程',people.engineer],[design,'设计',people.designer]]){
      assert.equal(row.project_id,scope.anchor);assert.equal(row.report_scope_id,scope.id);assert.equal(row.line,line);assert.equal(row.author_id,user.id);assert.deepEqual(row.scope_project_ids,scope.members);
    }
    await assert.rejects(submit(f,people.engineer,scope,'设计'),denied);
    const peer=(await submit(f,people.peer,scope,'工程'))[0];
    assert.notEqual(peer.id,engineering.id);assert.equal(peer.author_id,people.peer.id);
    assert.equal((await f.admin.query('SELECT author_id FROM public.reports WHERE id=$1',[engineering.id])).rows[0].author_id,people.engineer.id);
    await assert.rejects(submit(f,people.engineer,scope,'综合'),error=>[400,403,409].includes(error.status));
    await assert.rejects(submit(f,people.engineer,scope,'工程',undefined,week,{scope_project_ids:[scope.anchor]}),error=>error.status===400);
    await assert.rejects(submit(f,people.engineer,scope,'工程',undefined,week,{project_id:scope.members[1]}),denied);
    const update=(await submit(f,people.engineer,scope,'工程',{monthly_plan_ids:[],items:[{source_id:'own-extra',project_id:scope.members[1],mod:'工程',name:'本人独立事项',prog:'自己的进展'}]}))[0];
    assert.equal(update.id,engineering.id);assert.equal(update.history.length,1);assert.equal(update.author_id,people.engineer.id);
    await assert.rejects(submit(f,people.engineer,scope,'工程',{...update.biz,items:[{...update.biz.items[0],project_id:'merged-outside'}]}),error=>[400,403].includes(error.status));
  }
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id IS NOT NULL')).rows[0].n,6);
});

test('a professional report references only its own confirmed plan and retains fixed text, rich format and withdrawal/history protection',async t=>{
  const f=await fixture(t),engineering=await confirmMonthlyPlan(f.pool,people.engineer,confirmation(zh,'工程',month,{rich_text:{v:1,fields:{'items.0.name':bold('匿名工程专业计划')}}}));
  const design=await confirmMonthlyPlan(f.pool,people.designer,confirmation(zh,'设计'));
  const own=progress(engineering),rich_text={v:1,fields:{'biz.items.0.name':bold(engineering.items[0].name),'biz.items.0.prog':bold(own.items[0].prog)}};
  const saved=(await submit(f,people.engineer,zh,'工程',own,week,{rich_text}))[0];assert.deepEqual(saved.biz.monthly_plan_ids,[engineering.id]);assert.equal(saved.biz.items.length,1);
  await submit(f,people.designer,zh,'设计',progress(design,'独立设计进展'));
  await assert.rejects(submit(f,people.engineer,zh,'工程',progress(design)),locked);
  await assert.rejects(submit(f,people.engineer,zh,'工程',{monthly_plan_ids:[engineering.id,design.id],items:[...progress(engineering).items,...progress(design).items]}),locked);
  await assert.rejects(submit(f,people.engineer,zh,'工程',{...own,items:[{...own.items[0],name:'偷偷改固定事项'}]}),locked);
  await assert.rejects(submit(f,people.engineer,zh,'工程',own,week,{rich_text:{v:1,fields:{'biz.items.0.name':{ops:[{insert:engineering.items[0].name}]}}}}),locked);
  await assert.rejects(withdrawMonthlyPlan(f.pool,people.engineer,withdraw(engineering)),error=>error.status===409&&error.code==='monthly_plan_in_use');
  const updated=(await submit(f,people.engineer,zh,'工程',progress(engineering,'本专业更新进展'),week,{rich_text:{v:1,fields:{'biz.items.0.name':bold(engineering.items[0].name)}}}))[0];
  assert.equal(updated.id,saved.id);assert.equal(updated.history[0].data.rich_text.fields['biz.items.0.prog'].ops[0].attributes.bold,true);
  assert.equal((await f.admin.query('SELECT biz FROM public.reports WHERE report_scope_id=$1 AND line=$2',[zh.id,'设计'])).rows[0].biz.items[0].prog,'独立设计进展');
});

test('legacy same-anchor professional collisions return a conflict instead of adopting or reauthoring the old record',async t=>{
  const f=await fixture(t);
  const legacy=(await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,history) VALUES($1,$2,'工程',$3,'原作者',$4,$5) RETURNING *",[zh.anchor,week,people.engineer.id,JSON.stringify({items:[{source_id:'original-old',name:'旧锚点专业事项',prog:'旧反馈'}]}),JSON.stringify([{at:'2026-10-13T00:00:00Z',data:{biz:{items:[{name:'更早内容'}]}}}])])).rows[0];
  const before=(await f.admin.query('SELECT to_jsonb(r) original FROM public.reports r WHERE id=$1',[legacy.id])).rows[0].original;
  await assert.rejects(submit(f,people.engineer,zh,'工程'),error=>error.status===409);
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(r) original FROM public.reports r WHERE id=$1',[legacy.id])).rows[0].original,before);
  const originalComposite=(await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,report_scope_id,scope_project_ids,scope_week,biz) VALUES($1,$2,'综合',$3,$4,$5,$6,'{}') RETURNING *",[zh.anchor,'2026-10-19',people.engineer.id,zh.id,zh.members,'2026-10-19'])).rows[0];
  const originalId=originalComposite.id;
  const updated=await executeDatabase(f.pool,people.engineer,{table:'reports',operation:'update',filters:[{column:'id',value:originalId}],values:{change_text:'原作者保留历史综合入口'}});
  assert.equal(updated[0].id,originalId);assert.equal(updated[0].author_id,people.engineer.id);assert.equal(updated[0].line,'综合');assert.equal(updated[0].history.length,1);
});

test('professional AI facts and memory remain personal and recheck every original member before returning',async t=>{
  const f=await fixture(t),own=await confirmMonthlyPlan(f.pool,people.engineer,confirmation(zh,'工程'));
  await confirmMonthlyPlan(f.pool,people.designer,confirmation(zh,'设计'));
  const input={project_id:zh.anchor,report_scope_id:zh.id,line:'工程',period:week,scope_project_ids:zh.members};
  const facts=await loadPlanningAIFacts(f.pool,people.engineer,input,{kind:'summary',scope:'current',start:'',end:'',keyword:own.items[0].name,project_name:'',limit:10});
  assert.equal(facts.summary.total,1);assert.equal(facts.items[0].what,own.items[0].name);assert.doesNotMatch(JSON.stringify(facts),/匿名设计专业计划/);await assertPlanningAIFactAccess(f.pool,people.engineer,facts);
  const memory={project_id:zh.anchor,report_scope_id:zh.id,line:'工程',period:week};
  await savePlanningAIPreference(f.pool,people.engineer,{...memory,expected_revision:0,content:'按本人工程专业写法整理。'});
  assert.equal((await loadPlanningAIMemory(f.pool,people.engineer,memory)).preference.content,'按本人工程专业写法整理。');
  assert.equal((await loadPlanningAIMemory(f.pool,people.designer,{...memory,line:'设计'})).preference.content,'');
  await assert.rejects(loadPlanningAIMemory(f.pool,people.engineer,{...memory,line:'设计'}),denied);
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[people.engineer.id,zh.members[2]]);
  await assert.rejects(assertPlanningAIFactAccess(f.pool,people.engineer,facts),denied);await assert.rejects(loadPlanningAIMemory(f.pool,people.engineer,memory),denied);
  assert.deepEqual((await withIdentity(f.pool,people.engineer.id,client=>client.query('SELECT id FROM public.monthly_plans WHERE id=$1',[own.id]))).rows,[]);
});

test('attachments preserve professional identity and saved history while other lines and lost group access cannot reuse them',async t=>{
  const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'merged-professional-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input={project_id:zh.anchor,report_scope_id:zh.id,line:'工程',period:week,filename:'匿名工程凭证.png'};
  const attachment=await uploadReportAttachment(f.pool,people.engineer,dir,input,png);
  assert.equal(attachment.line,'工程');assert.equal(attachment.report_scope_id,zh.id);assert.deepEqual(attachment.scope_project_ids,zh.members);
  await assert.rejects(submit(f,people.designer,zh,'设计',{monthly_plan_ids:[],items:[],attachments:[attachment.id]}),denied);
  const saved=(await submit(f,people.engineer,zh,'工程',{monthly_plan_ids:[],items:[],attachments:[attachment.id]}))[0];
  const peerAttachment=await uploadReportAttachment(f.pool,people.peer,dir,input,png);
  assert.notEqual(peerAttachment.id,attachment.id);
  await assert.rejects(submit(f,people.peer,zh,'工程',{monthly_plan_ids:[],items:[],attachments:[attachment.id]}),denied);
  await submit(f,people.engineer,zh,'工程',{monthly_plan_ids:[],items:[],attachments:[]});
  assert.deepEqual((await loadReportAttachment(f.pool,people.designer,dir,attachment.id)).buffer,png);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.report_attachment_links WHERE report_id=$1',[saved.id])).rows[0].n,1);
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[people.engineer.id,zh.members[2]]);
  await assert.rejects(loadReportAttachment(f.pool,people.engineer,dir,attachment.id),error=>error.status===404);
});

async function browserRuntime(t){
  const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());const admin=testPool(runtime.db,null),users={...people,engineer:{id:'ai-local-acceptance-user'}};
  await seed(admin,users);
  for(const kind of ['designer','peer','partial','ops'])await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,must_change_password) SELECT $1,$2,password_hash,false FROM app_private.auth_users WHERE user_id=$3',[users[kind].id,kind+'@merged-professional.example.invalid',users.engineer.id]);
  return {runtime,admin,pool:runtime.pool,users,db:runtime.db};
}
const editor=(page,id)=>page.locator('[data-rich-editor-for="'+id+'"] .ql-editor');
const progressEditor=(page,name)=>page.locator('.report3-monthly-table tbody tr').filter({hasText:name}).locator('[data-rich-editor-for^="bi_pg_"] .ql-editor');
async function strong(target,text){await target.fill(text);if((await target.locator('strong').allTextContents()).join('')!==text){await target.press('Control+A');await target.press('Control+B');}await expect(target.locator('strong')).toHaveText(text);}
async function browser(t,f){
  const instance=await chromium.launch({channel:'msedge',headless:true});t.after(()=>instance.close());const errors=[],writes=[];
  async function login(kind='engineer'){
    const context=await instance.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));context.on('request',request=>{if(!request.url().endsWith('/api/db'))return;let body;try{body=request.postDataJSON();}catch{}if(body?.operation&&body.operation!=='select')writes.push({kind,table:body.table,operation:body.operation});});
    await page.goto(f.runtime.url);await page.locator('#email').fill(kind==='engineer'?f.runtime.account.email:kind+'@merged-professional.example.invalid');await page.locator('#password').fill(f.runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();return page;
  }
  return {instance,login,errors,writes};
}
async function open(page,scope,period=week){await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(({pid,period})=>App.fillProject(pid,period),{pid:scope.members.at(-1),period});await expect(page.locator('.monthly-plan-toolbar')).toBeVisible();}
async function options(page){return page.locator('#planProject option').evaluateAll(rows=>rows.map(row=>({value:row.value,text:row.textContent})));}

test('real week-42 forms show one merged option per project and two accounts submit only their own professional plan and rich draft',async t=>{
  const f=await browserRuntime(t),h=await browser(t,f),engineering=await confirmMonthlyPlan(f.pool,f.users.engineer,confirmation(zh,'工程'));
  const design=await confirmMonthlyPlan(f.pool,f.users.designer,confirmation(zh,'设计'));
  const page=await h.login(),other=await h.login('designer');await open(page,zh);await open(other,zh);
  for(const target of [page,other]){
    const choices=await options(target);assert.equal(choices.filter(item=>item.text==='正弘序').length,1);assert.equal(choices.filter(item=>item.text==='信阳').length,1);
    assert.equal(choices.some(item=>['zhx2','klq','xy8'].includes(item.value)),false);
    await expect(target.locator('.report3-monthly-table tbody tr')).toHaveCount(1);
  }
  await expect(page.locator('.report3-monthly-table')).toContainText(engineering.items[0].name);await expect(page.locator('.report3-monthly-table')).not.toContainText(design.items[0].name);
  await expect(other.locator('.report3-monthly-table')).toContainText(design.items[0].name);await expect(other.locator('.report3-monthly-table')).not.toContainText(engineering.items[0].name);
  await strong(progressEditor(page,engineering.items[0].name),'工程第42周自己的富文本草稿');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  await strong(progressEditor(other,design.items[0].name),'设计第42周自己的富文本草稿');await other.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  // Re-select the historical week after reload; preserving the selected page
  // period is not part of draft persistence. The week-42 draft must recover.
  await page.reload();await other.reload();await open(page,zh);await open(other,zh);await expect(progressEditor(page,engineering.items[0].name).locator('strong')).toContainText('工程第42周自己的富文本草稿');await expect(progressEditor(other,design.items[0].name).locator('strong')).toContainText('设计第42周自己的富文本草稿');
  await page.getByRole('button',{name:'提交本期直报',exact:true}).click();await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[zh.id])).rows[0].n).toBe(1);
  await other.getByRole('button',{name:'提交本期直报',exact:true}).click();await expect.poll(async()=>(await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[zh.id])).rows[0].n).toBe(2);
  const rows=(await f.admin.query('SELECT * FROM public.reports WHERE report_scope_id=$1 ORDER BY line',[zh.id])).rows;
  for(const [line,user,plan,text] of [['工程',f.users.engineer,engineering,'工程第42周自己的富文本草稿'],['设计',f.users.designer,design,'设计第42周自己的富文本草稿']]){
    const row=rows.find(item=>item.line===line);assert.equal(row.author_id,user.id);assert.deepEqual(row.biz.monthly_plan_ids,[plan.id]);assert.equal(row.biz.items[0].prog,text);assert.equal(row.rich_text.fields['biz.items.0.prog'].ops[0].attributes.bold,true);
  }
  await open(page,zh);await page.getByRole('button',{name:'查看其他专业填报',exact:true}).click();const reference=page.getByRole('dialog',{name:'查看其他专业填报'});
  await expect(reference).toContainText('设计第42周自己的富文本草稿');await expect(reference.locator('input,textarea,[contenteditable="true"]')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(reference).toHaveCount(0);await expect(progressEditor(page,engineering.items[0].name)).toContainText('工程第42周自己的富文本草稿');
  const peer=await h.login('peer');await open(peer,zh);await expect(peer.getByRole('button',{name:'提交本期直报',exact:true})).toBeEnabled();
  await expect(peer.locator('.report3-monthly-table')).not.toContainText(engineering.items[0].name);
  const snapshot=(await f.admin.query('SELECT to_jsonb(r) value FROM public.reports r WHERE report_scope_id=$1 AND line=$2',[zh.id,'工程'])).rows[0].value;
  const rejected=await peer.request.post(f.runtime.url+'/api/db',{headers:{Origin:f.runtime.url},data:{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:zh.anchor,report_scope_id:zh.id,period:week,line:'工程',biz:progress(engineering,'试图覆盖他人正文')}}});
  assert.equal(rejected.status(),409);assert.deepEqual((await f.admin.query('SELECT to_jsonb(r) value FROM public.reports r WHERE report_scope_id=$1 AND line=$2',[zh.id,'工程'])).rows[0].value,snapshot);
  await open(page,xy);const choices=await options(page);assert.equal(choices.filter(item=>item.text==='信阳').length,1);assert.equal(choices.some(item=>item.value==='xy8'),false);
  await expect(page.getByRole('button',{name:'提交本期直报',exact:true})).toBeEnabled();
  const artifacts=process.env.MERGED_PROFESSIONAL_ARTIFACT_DIR||path.join(os.tmpdir(),'planning-merged-professional');await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'merged-xinyang-week42.png'),fullPage:true});
  await open(page,zh);await page.screenshot({path:path.join(artifacts,'merged-zhenghongxu-week42.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(artifacts,'merged-professional-mobile.png'),fullPage:true});
  assert.deepEqual(h.writes,[{kind:'engineer',table:'reports',operation:'upsert'},{kind:'designer',table:'reports',operation:'upsert'}]);assert.deepEqual(h.errors,[]);
});

test('real merged professional month switching preserves new drafts and every old child or comprehensive draft byte-for-byte',async t=>{
  const f=await browserRuntime(t),h=await browser(t,f),page=await h.login();await open(page,zh);
  const oldEntries={['zh_draft_'+f.users.engineer.id+'_zhx2_42']:JSON.stringify({ts:1,bizItems:[{source_id:'old-draft-child',name:'原二期草稿',prog:'原二期未提交正文'}]}),
    ['zh_draft_'+f.users.engineer.id+'_zhx1_42']:JSON.stringify({ts:1,bizItems:[{source_id:'old-draft-anchor',name:'原一期草稿',prog:'原一期未提交正文'}]}),
    ['zh_scope_draft_'+f.users.engineer.id+'_'+zh.id+'_'+week]:JSON.stringify({ts:2,bizItems:[{name:'原综合草稿',prog:'原综合未提交正文'}]})};
  await page.evaluate(entries=>{for(const [key,value] of Object.entries(entries))localStorage.setItem(key,value);},oldEntries);await page.reload();await open(page,zh);
  await page.locator('details.notice').filter({has:page.locator('button[onclick*="showLegacyScopeDraft"]')}).locator('summary').click();
  for(const [key,text] of Object.entries(oldEntries).map(([key,value])=>[key,JSON.parse(value).bizItems[0].prog])){
    await page.locator('button[onclick*="showLegacyScopeDraft"]').filter({hasText:key.includes('zh_scope_draft_')?'原综合':key.includes('_zhx1_')?'匿名原项目zhx1':'匿名原项目zhx2'}).click();
    const modal=page.locator('#zh_modal');await expect(modal).toContainText(text);await expect(modal.locator('textarea')).toHaveAttribute('readonly','');await expect(modal.locator('[contenteditable="true"]')).toHaveCount(0);await modal.locator('[data-close]').click();
  }
  await expect(page.locator('.report3-monthly-table')).not.toContainText('原综合未提交正文');await expect(page.locator('.report3-monthly-table')).not.toContainText('原二期未提交正文');
  await page.getByRole('button',{name:'准备下月 2026-11',exact:true}).click();await editor(page,'monthly_next_mod_0').fill('工程');await strong(editor(page,'monthly_next_name_0'),'工程独立11月计划草稿');await page.locator('#monthly_next_due_0').fill('2026-11-20');await page.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  await page.reload();await open(page,zh);await page.getByRole('button',{name:'准备下月 2026-11',exact:true}).click();await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText('工程独立11月计划草稿');
  const reportsBefore=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value;
  await page.getByRole('button',{name:'确认下月计划',exact:true}).click();
  await expect.poll(async()=>(await f.admin.query("SELECT count(*)::int n FROM public.monthly_plans WHERE report_scope_id=$1 AND line='工程' AND plan_month='2026-11-01'",[zh.id])).rows[0].n).toBe(1);
  const confirmed=(await f.admin.query("SELECT * FROM public.monthly_plans WHERE report_scope_id=$1 AND line='工程' AND plan_month='2026-11-01'",[zh.id])).rows[0];
  assert.equal(confirmed.confirmed_by,f.users.engineer.id);assert.equal(confirmed.items[0].name,'工程独立11月计划草稿');assert.equal(confirmed.rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'撤回确认并修改',exact:true}).click();await expect(editor(page,'monthly_next_name_0').locator('strong')).toContainText('工程独立11月计划草稿');
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[confirmed.id])).rows[0].n,1);
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) value FROM public.reports r')).rows[0].value,reportsBefore);
  const after=await page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),Object.keys(oldEntries));assert.deepEqual(after,oldEntries);
  const keys=await page.evaluate(()=>Object.keys(localStorage));assert.ok(keys.some(key=>key.includes(encodeURIComponent('工程'))&&key.includes(zh.id)),'new professional draft identity includes its line and merged scope');
  assert.deepEqual(h.writes,[]);assert.deepEqual(h.errors,[]);
});
