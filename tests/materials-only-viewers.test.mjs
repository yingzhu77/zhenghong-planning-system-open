import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {createUser} from '../scripts/create-user.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {managementRead,withManagementRead} from '../server/management-read.mjs';
import {listProjectPeople} from '../server/reporter-tasks.mjs';
import {confirmMonthlyPlan} from '../server/monthly-plans.mjs';
import {listProjectLibrary,setLibraryPassword,unlockProjectLibrary,uploadProjectDocument,loadProjectDocument} from '../server/project-library.mjs';
import {loadFile} from '../server/files.mjs';

const viewer={id:'materials-viewer'},ops={id:'demo-ops'},pm={id:'demo-pm-com'};
const denied=e=>[403,404].includes(e.status),password='anonymous-password';
async function fixture(t){
 const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
 await seedDemo(admin);
 await createUser(admin,{userId:viewer.id,email:'materials@example.invalid',name:'匿名资料查看人',role:'viewer',viewerAccess:'materials',viewerScope:'projects',projects:['demo-com'],password});
 return {db,admin,pool};
}

test('040 preserves all existing profiles and business rows, defaults to full access, and is repeatable',async t=>{
 const db=await initializedDatabase({through:39});t.after(()=>db.close());const admin=testPool(db,null);await seedDemo(admin);
 await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('legacy-viewer','原查看人','viewer','approved')");
 const before=(await admin.query('SELECT to_jsonb(p) AS data FROM public.profiles p ORDER BY user_id')).rows;
 const business=(await admin.query('SELECT to_jsonb(p) AS data FROM public.projects p ORDER BY id')).rows;
 const sql=await readFile(new URL('../db/040-materials-only-viewers.sql',import.meta.url),'utf8');
 await db.exec(sql);await db.exec(sql);
 assert.deepEqual((await admin.query("SELECT to_jsonb(p)-'viewer_access' AS data FROM public.profiles p ORDER BY user_id")).rows,before);
 assert.deepEqual((await admin.query('SELECT to_jsonb(p) AS data FROM public.projects p ORDER BY id')).rows,business);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.profiles WHERE viewer_access<>'full'")).rows[0].n,0);
 assert.equal((await managementRead(testPool(db),{id:'legacy-viewer'},{view:'projects'})).projects.length,2);
});

test('materials viewers read only assigned archives; API and RLS deny plans even with the management context',async t=>{
 const f=await fixture(t);
 await confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line:'土建工程（东地块）',month:'2026-11',items:[{source_id:'a',mod:'匿名',name:'不可见计划',due:'2026-11-30'}]});
 const archive=await managementRead(f.pool,viewer,{view:'archive'});
 assert.deepEqual(archive.projects.map(p=>p.id),['demo-com']);assert.deepEqual(archive.archive.milestones,[]);
 for(const view of ['plans','coordination','completions','meetings'])await assert.rejects(managementRead(f.pool,viewer,{view}),denied);
 await assert.rejects(managementRead(f.pool,viewer,{view:'archive',project_id:'demo-res'}),denied);
 for(const table of ['monthly_plans','reports','milestones','coordination_tasks','completion_requests','reporter_tasks','project_members']){
  assert.equal((await withManagementRead(f.pool,viewer,c=>c.query('SELECT * FROM public.'+table))).rows.length,0,table);
 }
 assert.equal((await withIdentity(f.pool,viewer.id,async c=>{
  await c.query("SELECT set_config('app.management_read','on',true)");return c.query('SELECT * FROM public.monthly_plans');
 })).rows.length,0);
 assert.deepEqual(await executeDatabase(f.pool,viewer,{table:'projects',columns:'id'}),[]);
 await assert.rejects(executeDatabase(f.pool,viewer,{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_access:'full'}}),denied);
 await assert.rejects(withManagementRead(f.pool,viewer,c=>c.query("INSERT INTO public.project_master(project_id,fields) VALUES('demo-com','{}')")),e=>e.code==='42501');
 assert.ok(!(await listProjectPeople(f.pool,pm,{project_id:'demo-com'})).some(p=>p.user_id===viewer.id));
 await executeDatabase(f.pool,ops,{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_scope:'all'}});
 assert.equal((await managementRead(f.pool,viewer,{view:'projects'})).projects.length,2);
 await assert.rejects(managementRead(f.pool,viewer,{view:'plans'}),denied);
 await executeDatabase(f.pool,ops,{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_access:'full'}});
 assert.equal((await managementRead(f.pool,viewer,{view:'plans',month:'2026-11'})).rows.length,1);
 await executeDatabase(f.pool,ops,{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_access:'materials',viewer_scope:'projects'}});
 await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1',[viewer.id]);
 assert.equal((await managementRead(f.pool,viewer,{view:'projects'})).projects.length,0);
});

test('materials downloads retain password, watermark, audit, project and original-file protection',async t=>{
 const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'materials-only-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=await sharp({create:{width:300,height:150,channels:3,background:'#eee'}}).png().toBuffer(),session='a'.repeat(64);
 await setLibraryPassword(f.pool,ops,{project_id:'demo-com',password:'Library123!'});
 const doc=await uploadProjectDocument(f.pool,pm,dir,{project_id:'demo-com',filename:'anonymous.png',title:'匿名资料'},bytes);
 const list=await listProjectLibrary(f.pool,viewer,{project_id:'demo-com'},session);
 assert.equal(list.items.length,1);assert.equal(list.can_upload,false);assert.equal(list.can_manage,false);
 await assert.rejects(loadProjectDocument(f.pool,viewer,dir,doc.id,{sessionKey:session}),denied);
 await unlockProjectLibrary(f.pool,viewer,{project_id:'demo-com',password:'Library123!'},session);
 const file=await loadProjectDocument(f.pool,viewer,dir,doc.id,{sessionKey:session});assert.notDeepEqual(file.buffer,bytes);
 assert.deepEqual((await f.admin.query('SELECT action FROM public.project_library_events WHERE actor_id=$1',[viewer.id])).rows,[{action:'download'}]);
 await assert.rejects(loadProjectDocument(f.pool,viewer,dir,doc.id,{sessionKey:session,original:true}),denied);
 await assert.rejects(uploadProjectDocument(f.pool,viewer,dir,{project_id:'demo-com',filename:'rejected.png'},bytes),denied);
 await assert.rejects(setLibraryPassword(f.pool,viewer,{project_id:'demo-com',password:'Changed123!'}),denied);
 await assert.rejects(listProjectLibrary(f.pool,viewer,{project_id:'demo-res'},session),denied);
 const relative='drawings/demo-com/anonymous.png';await mkdir(path.join(dir,'drawings','demo-com'),{recursive:true});await writeFile(path.join(dir,relative),bytes);
 await f.admin.query("INSERT INTO public.project_drawings(project_id,kind,name,path) VALUES('demo-com','design','匿名图纸',$1)",[relative]);
 assert.deepEqual((await loadFile(f.pool,viewer,dir,relative)).buffer,bytes);
 await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1',[viewer.id]);
 await assert.rejects(loadFile(f.pool,viewer,dir,relative),denied);
 await assert.rejects(loadProjectDocument(f.pool,viewer,dir,doc.id,{sessionKey:session}),denied);
});

test('actual Edge login opens materials only and desktop and narrow layouts remain usable',{timeout:90000},async t=>{
 const f=await fixture(t),{createApp}=await import('../server/app.mjs'),{chromium,expect}=await import('@playwright/test');
 const dir=await mkdtemp(path.join(os.tmpdir(),'materials-browser-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=createApp({pool:f.pool,config:{authCodeSecret:randomUUID()+randomUUID(),readOnly:false,publicOrigin:'',cookieSecure:false,sessionHours:1,uploadDir:dir,mailer:{configured:false}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
 const artifacts=path.resolve('.local/materials-only-viewers');await mkdir(artifacts,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#email').fill('materials@example.invalid');await page.locator('#password').fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.management-reader')).toBeVisible();
  await expect(page.locator('.planning-mainnav')).toContainText('项目资料');
  await expect(page.locator('.planning-mainnav')).not.toContainText('计划总览');
  await expect(page.locator('.planning-mainnav')).not.toContainText('事项管理');
  await page.getByRole('button',{name:'项目资料',exact:true}).click();
  await expect(page.getByRole('button',{name:'项目档案（只读）',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'项目档案（只读）',exact:true}).click();
  await expect(page.locator('main textarea, main input[type=file], main [contenteditable=true]')).toHaveCount(0);
  await page.locator('main').screenshot({path:path.join(artifacts,'materials-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('main').screenshot({path:path.join(artifacts,'materials-narrow.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
  for(const view of ['plans','coordination','meetings','completions'])assert.equal((await page.request.post(url+'/api/management-read',{headers:{Origin:url},data:{view}})).status(),403);
  await page.getByRole('button',{name:'项目资料',exact:true}).click();
  await page.getByRole('button',{name:'资料共享（只读）',exact:true}).click();await expect(page.locator('main')).toContainText('资料共享');
  assert.equal((await page.request.post(url+'/api/db',{headers:{Origin:url},data:{table:'profiles',operation:'update',filters:[{column:'user_id',value:viewer.id}],values:{viewer_access:'full'}}})).status(),403);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>{server.close(r);server.closeAllConnections?.();});}
});
