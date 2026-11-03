import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {PDFDocument,PDFArray,PDFRawStream,decodePDFRawStream,degrees} from 'pdf-lib';
import {watermarkLibraryFile} from '../server/library-watermark.mjs';
import vm from 'node:vm';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {listProjectLibrary,setLibraryPassword,unlockProjectLibrary,uploadProjectDocument,withdrawProjectDocument,loadProjectDocument} from '../server/project-library.mjs';

const ops={id:'demo-ops'},pm={id:'demo-pm-com'},outside={id:'demo-pm-res'},session='a'.repeat(64),otherSession='b'.repeat(64),pid='demo-com';
const status=n=>error=>error.status===n;
async function fixture(t){
 const db=await initializedDatabase(),admin=testPool(db,null),pool=testPool(db),dir=await mkdtemp(path.join(os.tmpdir(),'project-library-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});await db.close();});
 await seedDemo(admin);await db.exec(await readFile(new URL('../db/020-project-library.sql',import.meta.url),'utf8'));
 return {db,admin,pool,dir};
}
test('project library minimal flow preserves originals and versions, scopes passwords per session and blocks unauthorized files',async t=>{
 const f=await fixture(t),image=await sharp({create:{width:800,height:400,channels:3,background:'#f1f1f1'}}).png().toBuffer();
 await setLibraryPassword(f.pool,ops,{project_id:pid,password:'Project123!'});
 const row=await uploadProjectDocument(f.pool,pm,f.dir,{project_id:pid,filename:'资料.png',category:'图纸',title:'测试图纸'},image);
 assert.equal(row.version,1);assert.equal(row.uploaded_by,pm.id);assert.equal('storage_key' in row,false);
 await assert.rejects(listProjectLibrary(f.pool,outside,{project_id:pid},session),status(403));
 assert.equal((await listProjectLibrary(f.pool,pm,{project_id:pid,q:'图纸'},session)).items.length,1);
 await assert.rejects(loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session}),status(403));
 await assert.rejects(unlockProjectLibrary(f.pool,pm,{project_id:pid,password:'Wrong123!'},session),status(403));
 await unlockProjectLibrary(f.pool,pm,{project_id:pid,password:'Project123!'},session);
 assert.equal((await listProjectLibrary(f.pool,pm,{project_id:pid},session)).unlocked,true);
 assert.equal((await listProjectLibrary(f.pool,pm,{project_id:pid},otherSession)).unlocked,false);
 await assert.rejects(loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session,original:true}),status(403));
 const marked=await loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session,inline:true});
 assert.equal(marked.type,'image/png');assert.notDeepEqual(marked.buffer,image);assert.equal((await sharp(marked.buffer).metadata()).width,800);
 const original=await loadProjectDocument(f.pool,ops,f.dir,row.id,{sessionKey:session,original:true});assert.deepEqual(original.buffer,image);
 const next=await uploadProjectDocument(f.pool,pm,f.dir,{project_id:pid,filename:'资料.png',new_version_of:row.id},image);
 assert.equal(next.version,2);assert.equal(next.document_id,row.id);
 assert.deepEqual((await loadProjectDocument(f.pool,ops,f.dir,row.id,{original:true})).buffer,image);
 await setLibraryPassword(f.pool,ops,{project_id:pid,password:'Project456!'});
 await assert.rejects(loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session}),status(403));
 await unlockProjectLibrary(f.pool,pm,{project_id:pid,password:'Project456!'},session);
 await withdrawProjectDocument(f.pool,pm,{id:row.id});
 await assert.rejects(loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session}),status(410));
 assert.equal((await listProjectLibrary(f.pool,pm,{project_id:pid},session)).items.length,1);
 assert.equal((await listProjectLibrary(f.pool,pm,{project_id:pid,include_withdrawn:true},session)).items.length,2);
 assert.equal((await f.admin.query("SELECT count(*)::integer AS n FROM public.project_library_events WHERE action='preview'")).rows[0].n,1);
});
test('a readable PDF receives embedded Chinese watermarks while malformed and unsupported content is rejected',async t=>{
 const f=await fixture(t),pdf=await PDFDocument.create();pdf.addPage([600,800]);const body=Buffer.from(await pdf.save());
 await setLibraryPassword(f.pool,ops,{project_id:pid,password:'Project123!'});
 const row=await uploadProjectDocument(f.pool,pm,f.dir,{project_id:pid,filename:'资料.pdf'},body);
 await unlockProjectLibrary(f.pool,pm,{project_id:pid,password:'Project123!'},session);
 const marked=await loadProjectDocument(f.pool,pm,f.dir,row.id,{sessionKey:session});
 assert.equal((await PDFDocument.load(marked.buffer)).getPageCount(),1);assert.notDeepEqual(marked.buffer,body);
 await assert.rejects(uploadProjectDocument(f.pool,pm,f.dir,{project_id:pid,filename:'伪造.pdf'},Buffer.from('%PDF-invalid')),status(400));
 await assert.rejects(uploadProjectDocument(f.pool,pm,f.dir,{project_id:pid,filename:'压缩包.zip'},Buffer.from('PK123')),status(400));
 await assert.rejects(uploadProjectDocument(f.pool,outside,f.dir,{project_id:pid,filename:'越权.pdf'},body),status(403));
});
test('PDF watermarks remain inside real cropped, offset, rotated and tiny visible pages',async()=>{
 const source=await PDFDocument.create();
 const cases=[{size:[600,800],crop:[0,0,100,100],rotation:0},{size:[600,800],crop:[250,300,100,100],rotation:90},
  {size:[20,10],crop:[0,0,20,10],rotation:270},{size:[600,800],crop:[10,20,2,3],rotation:180}];
 for(const item of cases){const page=source.addPage(item.size);page.setCropBox(...item.crop);page.setRotation(degrees(item.rotation));}
 const marked=await watermarkLibraryFile(Buffer.from(await source.save()),'application/pdf','匿名项目 · 中文下载人 · 2026/10/22 10:00:00');
 const document=await PDFDocument.load(marked);
 document.getPages().forEach((page,index)=>{
  const contents=page.node.Contents(),streams=contents instanceof PDFArray?Array.from({length:contents.size()},(_,i)=>contents.lookup(i,PDFRawStream)):[document.context.lookup(contents,PDFRawStream)];
  const text=streams.map(stream=>Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
  const number='([-+]?(?:\\d*\\.)?\\d+(?:[eE][-+]?\\d+)?)';
  const transforms=Array.from(text.matchAll(new RegExp(Array(6).fill(number).join('\\s+')+'\\s+Tm','g')));
  assert.ok(transforms.length>0,'the cropped page must contain actual text operators');
  const [x,y,width,height]=cases[index].crop;
  for(const transform of transforms){
   const tx=Number(transform[5]),ty=Number(transform[6]);
   assert.ok(tx>=x&&tx<x+width&&ty>=y&&ty<y+height,'text baseline must be inside visible crop: '+JSON.stringify({index,tx,ty,crop:cases[index].crop}));
  }
 });
});
test('library UI ignores late project reads and clears file selections across projects and sessions',async()=>{
 const code=await readFile(new URL('../web/project-library.js',import.meta.url),'utf8'),pending=[],requests=[];
 const S={uid:'anonymous',session:{}},sandbox={Map,Set,Promise,URLSearchParams,document:{getElementById:()=>({value:'never-persist-this'})},setTimeout:()=>0};
 sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(code,sandbox);
 let selected='p1',renders=0;
 const cfg={S,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),projectId:()=>selected,render:()=>renders++,toast(){},request:(url,body)=>{requests.push({url,body});return new Promise(resolve=>pending.push(resolve));}};
 const api=sandbox.ProjectLibrary;api.configure(cfg);api.html('p1');await Promise.resolve();
 api.pickFile({files:[{name:'project-one.pdf',size:20}]});assert.match(api.html('p1'),/project-one\.pdf/);
 selected='p2';await api.unlock();assert.equal(requests.length,1,'stale password DOM cannot issue a request in the new project');
 api.html('p2');await Promise.resolve();
 pending[0]({data:{items:[{id:'one',title:'旧项目不得串入',name:'one.pdf',mime:'application/pdf',size:20,version:1}],configured:true}});await Promise.resolve();await Promise.resolve();
 assert.doesNotMatch(api.html('p2'),/旧项目不得串入|project-one\.pdf/);
 pending[1]({data:{items:[],configured:true,unlocked:false}});await Promise.resolve();await Promise.resolve();
 assert.match(api.html('p2'),/项目下载口令/);
 assert.equal(renders,1,'only the active project read renders');
 S.uid='new-user';S.session={};api.configure(cfg);assert.doesNotMatch(api.html('p2'),/project-one\.pdf|旧项目不得串入/);
});
