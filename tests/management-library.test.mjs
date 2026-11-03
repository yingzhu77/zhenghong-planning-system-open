import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {createUser} from '../scripts/create-user.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {withManagementRead} from '../server/management-read.mjs';
import {createApp} from '../server/app.mjs';
import {loadFile,saveUpload} from '../server/files.mjs';
import {listProjectLibrary,setLibraryPassword,unlockProjectLibrary,uploadProjectDocument,withdrawProjectDocument,loadProjectDocument} from '../server/project-library.mjs';

const ops={id:'demo-ops'},reporter={id:'demo-pm-res'},plain={id:'ordinary-member'},viewer={id:'all-project-viewer'};
const denied=error=>[403,404].includes(error.status),session='d'.repeat(64),otherSession='e'.repeat(64);
const password='Library123!';
async function fixture(t){
 const db=await initializedDatabase({through:23}),admin=testPool(db,null),pool=testPool(db);
 const dir=await mkdtemp(path.join(os.tmpdir(),'management-library-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});await db.close();});
 await db.exec(await readFile(new URL('../db/024-management-viewers.sql',import.meta.url),'utf8'));
 await seedDemo(admin);
 await createUser(admin,{userId:viewer.id,email:'all.project.viewer@example.invalid',name:'匿名只读人员',role:'viewer',password:'682941'});
 await createUser(admin,{userId:plain.id,email:'ordinary.member@example.invalid',name:'匿名项目人员',role:'pm',projects:['demo-res'],discipline:'工程',password:'682941'});
 await admin.query('UPDATE public.profiles SET management_viewer=true WHERE user_id=$1',[reporter.id]);
 const image=await sharp({create:{width:400,height:200,channels:3,background:'#f1f1f1'}}).png().toBuffer();
 const docs={};
 for(const pid of ['demo-res','demo-com']){
  await setLibraryPassword(pool,ops,{project_id:pid,password});
  docs[pid]=await uploadProjectDocument(pool,pid==='demo-res'?plain:{id:'demo-pm-com'},dir,{project_id:pid,filename:pid+'.png',title:'匿名项目资料'},image);
 }
 return {db,admin,pool,dir,image,docs};
}
function multipart(relative,bytes){
 const boundary='management-isolated-test';
 return {contentType:'multipart/form-data; boundary='+boundary,body:Buffer.concat([
  Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="path"\r\n\r\n'+relative+'\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="anonymous.png"\r\nContent-Type: image/png\r\n\r\n'),
  bytes,Buffer.from('\r\n--'+boundary+'--\r\n')])};
}

test('viewer lists and unlocks both projects, receives watermarked files and keeps session/password/withdrawal checks',async t=>{
 const f=await fixture(t);
 for(const pid of ['demo-res','demo-com']){
  const listed=await listProjectLibrary(f.pool,viewer,{project_id:pid},session);
  assert.equal(listed.items.length,1);assert.equal(listed.can_upload,false);assert.equal(listed.can_manage,false);
  assert.equal(listed.items[0].can_withdraw,false);assert.equal(listed.unlocked,false);
  await assert.rejects(loadProjectDocument(f.pool,viewer,f.dir,f.docs[pid].id,{sessionKey:session}),error=>error.status===403);
  await assert.rejects(unlockProjectLibrary(f.pool,viewer,{project_id:pid,password:'Wrong123!'},session),error=>error.status===403);
  await unlockProjectLibrary(f.pool,viewer,{project_id:pid,password},session);
  assert.equal((await listProjectLibrary(f.pool,viewer,{project_id:pid},session)).unlocked,true);
  assert.equal((await listProjectLibrary(f.pool,viewer,{project_id:pid},otherSession)).unlocked,false);
  const marked=await loadProjectDocument(f.pool,viewer,f.dir,f.docs[pid].id,{sessionKey:session,inline:true});
  assert.equal(marked.inline,true);assert.equal(marked.type,'image/png');assert.notDeepEqual(marked.buffer,f.image);
  if(pid==='demo-com')assert.equal((await loadProjectDocument(f.pool,viewer,f.dir,f.docs[pid].id,{sessionKey:session})).inline,false);
  await assert.rejects(loadProjectDocument(f.pool,viewer,f.dir,f.docs[pid].id,{sessionKey:session,original:true}),denied);
 }
 const events=(await f.admin.query('SELECT action FROM public.project_library_events WHERE actor_id=$1 ORDER BY action',[viewer.id])).rows;
 assert.deepEqual(events.map(row=>row.action),['download','preview','preview']);
 await setLibraryPassword(f.pool,ops,{project_id:'demo-com',password:'Changed456!'});
 await assert.rejects(loadProjectDocument(f.pool,viewer,f.dir,f.docs['demo-com'].id,{sessionKey:session}),error=>error.status===403);
 await unlockProjectLibrary(f.pool,viewer,{project_id:'demo-com',password:'Changed456!'},session);
 await withdrawProjectDocument(f.pool,{id:'demo-pm-com'},{id:f.docs['demo-com'].id});
 await assert.rejects(loadProjectDocument(f.pool,viewer,f.dir,f.docs['demo-com'].id,{sessionKey:session}),error=>error.status===410);
});

test('management read grants no cross-project file writes while the existing member retains upload/withdraw rights',async t=>{
 const f=await fixture(t),beforeFiles=await readdir(path.join(f.dir,'project-library'));
 for(const user of [viewer,reporter]){
  const read=await listProjectLibrary(f.pool,user,{project_id:'demo-com'},session);
  assert.equal(read.can_upload,false);assert.equal(read.items[0].can_withdraw,false);
  await assert.rejects(uploadProjectDocument(f.pool,user,f.dir,{project_id:'demo-com',filename:'rejected.png'},f.image),denied);
  await assert.rejects(withdrawProjectDocument(f.pool,user,{id:f.docs['demo-com'].id}),denied);
  await assert.rejects(setLibraryPassword(f.pool,user,{project_id:'demo-com',password:'Other123!'}),denied);
  await assert.rejects(loadProjectDocument(f.pool,user,f.dir,f.docs['demo-com'].id,{sessionKey:session,original:true}),denied);
  const upload=multipart('drawings/demo-com/rejected.png',f.image);
  await assert.rejects(saveUpload(f.pool,user,f.dir,upload.body,upload.contentType),denied);
 }
 assert.deepEqual(await readdir(path.join(f.dir,'project-library')),beforeFiles,'rejected uploads must not leave files');
 await assert.rejects(readdir(path.join(f.dir,'drawings')),error=>error.code==='ENOENT');
 assert.equal((await listProjectLibrary(f.pool,reporter,{project_id:'demo-res'},session)).can_upload,true);
 const own=await uploadProjectDocument(f.pool,reporter,f.dir,{project_id:'demo-res',filename:'own.png'},f.image);
 await withdrawProjectDocument(f.pool,reporter,{id:own.id});
 assert.equal((await f.admin.query('SELECT withdrawn_by FROM public.project_library_documents WHERE id=$1',[own.id])).rows[0].withdrawn_by,reporter.id);
 await assert.rejects(listProjectLibrary(f.pool,plain,{project_id:'demo-com'},session),denied);
 const oldOriginal=await loadProjectDocument(f.pool,ops,f.dir,f.docs['demo-com'].id,{original:true});
 assert.deepEqual(oldOriginal.buffer,f.image);
 for(const user of [viewer,reporter]){
  const ordinary=await executeDatabase(f.pool,user,{table:'projects',operation:'select',columns:'id'});
  assert.deepEqual(ordinary.map(row=>row.id),user===viewer?[]:['demo-res'],'management GUC must not leak into ordinary workbench reads');
 }
});

test('management drawing GET crosses scopes, blocks unknown paths and does not widen drawing uploads',async t=>{
 const f=await fixture(t),relative='drawings/demo-com/anonymous.png';
 await mkdir(path.join(f.dir,'drawings','demo-com'),{recursive:true});await writeFile(path.join(f.dir,...relative.split('/')),f.image);
 await f.admin.query("INSERT INTO public.project_drawings(project_id,kind,name,path) VALUES('demo-com','design','匿名图纸',$1)",[relative]);
 for(const user of [viewer,reporter])assert.deepEqual((await loadFile(f.pool,user,f.dir,relative)).buffer,f.image);
 await assert.rejects(loadFile(f.pool,plain,f.dir,relative),denied);
 await assert.rejects(loadFile(f.pool,viewer,f.dir,'drawings/demo-com/missing.png'),denied);
 await f.admin.query('UPDATE app_private.auth_users SET must_change_password=false WHERE user_id=$1',[viewer.id]);
 const app=createApp({pool:f.pool,config:{uploadDir:f.dir,authCodeSecret:'isolated-management-library-secret',mailer:{configured:false}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const logged=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({email:'all.project.viewer@example.invalid',password:'682941'})});
  assert.equal(logged.status,200);const cookie=logged.headers.get('set-cookie').split(';')[0];await logged.json();
  const drawing=await fetch(base+'/api/files/'+relative,{headers:{cookie}});assert.equal(drawing.status,200);assert.deepEqual(Buffer.from(await drawing.arrayBuffer()),f.image);
  assert.equal((await fetch(base+'/api/files/'+relative)).status,401);
  const post=body=>({method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
  const listing=await fetch(base+'/api/project-library/list',post({project_id:'demo-com'}));assert.equal(listing.status,200);assert.equal((await listing.json()).data.can_upload,false);
  const unlock=await fetch(base+'/api/project-library/unlock',post({project_id:'demo-com',password}));assert.equal(unlock.status,200);await unlock.json();
  const file=await fetch(base+'/api/project-library/'+f.docs['demo-com'].id,{headers:{cookie}});assert.equal(file.status,200);assert.notDeepEqual(Buffer.from(await file.arrayBuffer()),f.image);
  const rejected=await fetch(base+'/api/project-library/upload?project_id=demo-com&filename=rejected.png',{method:'POST',headers:{cookie,origin:base,'content-type':'image/png'},body:f.image});
  assert.equal(rejected.status,403);await rejected.json();
 }finally{await new Promise(resolve=>server.close(resolve));}
 await f.admin.query("UPDATE public.profiles SET status='pending' WHERE user_id=$1",[viewer.id]);
 await assert.rejects(loadFile(f.pool,viewer,f.dir,relative),denied);
 await assert.rejects(listProjectLibrary(f.pool,viewer,{project_id:'demo-com'},session),denied);
});

test('the management read context permits only preview/download audit inserts, never library business mutations',async t=>{
 const f=await fixture(t),doc=f.docs['demo-com'];
 for(const user of [viewer,reporter]){
  const scope=await withIdentity(f.pool,user.id,async client=>(await client.query('SELECT app_private.management_read_enabled() AS enabled')).rows[0]);
  assert.equal(scope.enabled,false,'a missing management GUC is false, including for capable identities');
  await assert.rejects(withIdentity(f.pool,user.id,client=>client.query("SELECT * FROM app_private.library_password('demo-com')")),error=>error.code==='42501');
 }
 for(const action of ['upload','withdraw','original_download','password_changed'])
  await assert.rejects(withManagementRead(f.pool,viewer,client=>client.query('INSERT INTO public.project_library_events(id,project_id,document_id,actor_id,action) VALUES(gen_random_uuid(),$1,$2,$3,$4)',['demo-com',doc.id,viewer.id,action])),error=>error.code==='42501');
 const update=await withManagementRead(f.pool,viewer,client=>client.query('UPDATE public.project_library_documents SET withdrawn_at=now(),withdrawn_by=$2 WHERE id=$1 RETURNING id',[doc.id,viewer.id]));
 assert.deepEqual(update.rows,[],'UPDATE policy must keep the visible read-only row outside its writable set');
 await assert.rejects(withManagementRead(f.pool,viewer,client=>client.query(`WITH candidate AS (SELECT gen_random_uuid() AS id)
  INSERT INTO public.project_library_documents(id,document_id,project_id,title,name,mime,size,version,storage_key,uploaded_by,uploaded_name)
  SELECT id,id,'demo-com','匿名拒绝','rejected.png','image/png',100,1,'project-library/'||id::text||'.png',$1,'匿名只读人员' FROM candidate`,[viewer.id])),error=>error.code==='42501');
 await assert.rejects(withManagementRead(f.pool,viewer,client=>client.query('INSERT INTO public.project_library_events(id,project_id,document_id,actor_id,action) VALUES(gen_random_uuid(),$1,$2,$3,$4)',['demo-res',doc.id,viewer.id,'preview'])),error=>error.code==='42501');
 const before=(await f.admin.query('SELECT withdrawn_at FROM public.project_library_documents WHERE id=$1',[doc.id])).rows[0];
 assert.equal(before.withdrawn_at,null);
});

test('createUser supports explicit viewer capability without changing existing historical profiles',async t=>{
 const f=await fixture(t);
 const viewerProfile=(await f.admin.query('SELECT * FROM public.profiles WHERE user_id=$1',[viewer.id])).rows[0];
 assert.equal(viewerProfile.role,'viewer');assert.equal(viewerProfile.management_viewer,true);assert.equal(viewerProfile.project_id,null);
 assert.equal((await f.admin.query('SELECT count(*)::integer AS n FROM public.project_members WHERE user_id=$1',[viewer.id])).rows[0].n,0);
 for(const value of ['true',1,null])await assert.rejects(createUser({connect(){throw new Error('must not connect');}},{email:'invalid.flag@example.invalid',name:'匿名账号',role:'viewer',password:'682941',managementViewer:value}),/布尔/);
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline,management_viewer) VALUES('existing-history','保留历史','pm','approved','demo-res','工程',true)");
 const old=(await f.admin.query("SELECT * FROM public.profiles WHERE user_id='existing-history'")).rows[0];
 const options={userId:'existing-history',email:'existing.history@example.invalid',name:'不应覆盖',role:'viewer',password:'682941'};
 await assert.rejects(createUser(f.admin,{...options,managementViewer:false}),/保留原角色/);
 assert.equal((await f.admin.query("SELECT count(*)::integer AS n FROM app_private.auth_users WHERE user_id='existing-history'")).rows[0].n,0);
 const result=await createUser(f.admin,options);assert.equal(result.existingProfilePreserved,true);assert.equal(result.role,'pm');
 assert.deepEqual((await f.admin.query("SELECT * FROM public.profiles WHERE user_id='existing-history'")).rows[0],old);
 const created=await createUser(f.admin,{userId:'new-capable-pm',email:'new.capable@example.invalid',name:'匿名新增提报人',role:'pm',projects:['demo-res'],discipline:'工程',managementViewer:true,password:'682941'});
 assert.equal(created.role,'pm');
 assert.equal((await f.admin.query('SELECT management_viewer FROM public.profiles WHERE user_id=$1',[created.userId])).rows[0].management_viewer,true);
 const flags=await withIdentity(f.pool,created.userId,async client=>(await client.query("SELECT app_private.can_read_project('demo-com') AS cross_project")).rows[0]);
 assert.equal(flags.cross_project,false);
});
