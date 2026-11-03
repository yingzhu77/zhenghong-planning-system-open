import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {withIdentity,getProfile} from './database.mjs';
import {withManagementRead} from './management-read.mjs';
import {HttpError} from './errors.mjs';
import {hashPassword,verifyPassword} from './password.mjs';
import {MAX_LIBRARY_BYTES,libraryFileType,validateLibraryFile,watermarkLibraryFile} from './library-watermark.mjs';

export {MAX_LIBRARY_BYTES};
const columns='id,document_id,project_id,category,title,name,mime,size,version,uploaded_by,uploaded_name,created_at,withdrawn_at,withdrawn_by';
const grants=new Map(),attempts=new Map();
let passwordChecks=0,watermarkJobs=0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function input(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'资料请求格式不正确');}
function text(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new HttpError(400,label+'格式不正确');return value.trim();}
function identifier(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new HttpError(400,'资料标识不正确');return value.toLowerCase();}
function grantKey(user,session,pid){if(typeof session!=='string'||!/^[a-f0-9]{64}$/.test(session))throw new HttpError(401,'会话已失效，请重新登录','library_session');return JSON.stringify([user.id,session,pid]);}
function unlocked(user,session,pid,secret){if(!secret)return false;const row=grants.get(grantKey(user,session,pid));return !!(row&&row.revision===secret.revision);}
async function project(client,user,pid,{write=false}={}){
 const profile=await getProfile(client,user.id);
 if(profile?.status!=='approved'||!['ops','president','pzo','pm','viewer'].includes(profile.role))throw new HttpError(403,'账号无权访问共享资料');
 const row=(await client.query('SELECT id,name,app_private.can_read_project(id) AS ordinary_access FROM public.projects WHERE id=$1',[pid])).rows[0];
 if(!row)throw new HttpError(403,'无权访问该项目资料');
 const canUpload=['ops','president','pzo','pm'].includes(profile.role)&&row.ordinary_access===true;
 if(write&&!canUpload)throw new HttpError(403,'无权修改该项目资料');
 return {profile,project:{id:row.id,name:row.name},canUpload};
}
async function secretFor(client,pid){return (await client.query('SELECT * FROM app_private.library_password($1)',[pid])).rows[0]||null;}
async function event(client,user,pid,documentId,action){await client.query('INSERT INTO public.project_library_events(id,project_id,document_id,actor_id,action) VALUES($1,$2,$3,$4,$5)',[randomUUID(),pid,documentId,user.id,action]);}
function absolutePath(uploadDir,row){
 if(!/^project-library\/[a-f0-9-]{36}\.(pdf|png|jpg)$/.test(row.storage_key)||!row.storage_key.startsWith('project-library/'+row.id+'.'))throw new HttpError(500,'资料存储记录不正确','library_storage');
 return path.join(uploadDir,...row.storage_key.split('/'));
}
function publicDocument(row,user,profile,canUpload=true){return {...row,can_withdraw:canUpload&&!row.withdrawn_at&&(row.uploaded_by===user.id||profile.role==='ops'),url:'/api/project-library/'+row.id};}
// Project download secrets retain their independent, established policy.
function libraryPasswordIssue(password){
 if(typeof password!=='string'||password.length<8||password.length>128)return '下载口令须为 8 至 128 个字符';
 if(!/[A-Za-z]/.test(password)||!/[0-9]/.test(password))return '下载口令须同时包含字母和数字';
 return null;
}

export async function listProjectLibrary(pool,user,request={},sessionKey){
 input(request,['project_id','q','category','include_withdrawn']);const pid=text(request.project_id,'项目');
 const keyword=request.q===undefined?'':String(request.q).trim();if(keyword.length>200)throw new HttpError(400,'查找文字过长');
 if(request.include_withdrawn!==undefined&&typeof request.include_withdrawn!=='boolean')throw new HttpError(400,'历史资料筛选不正确');
 const category=request.category===undefined||request.category===''?'':text(request.category,'分类',80);
 return withManagementRead(pool,user,async client=>{
  const {profile,canUpload}=await project(client,user,pid),secret=await secretFor(client,pid),values=[pid];
  let where='project_id=$1';
  if(!request.include_withdrawn)where+=' AND withdrawn_at IS NULL';
  const categories=(await client.query('SELECT DISTINCT category FROM public.project_library_documents WHERE '+where+' ORDER BY category',[pid])).rows.map(row=>row.category);
  if(keyword){values.push(keyword);where+=' AND (strpos(lower(title),lower($'+values.length+'))>0 OR strpos(lower(name),lower($'+values.length+'))>0)';}
  if(category){values.push(category);where+=' AND category=$'+values.length;}
  const rows=(await client.query('SELECT '+columns+' FROM public.project_library_documents WHERE '+where+' ORDER BY created_at DESC,id',[...values])).rows;
  return {items:rows.map(row=>publicDocument(row,user,profile,canUpload)),categories,configured:!!secret,unlocked:unlocked(user,sessionKey,pid,secret),
    can_manage:profile.role==='ops'&&canUpload,can_upload:canUpload,max_bytes:MAX_LIBRARY_BYTES,formats:['PDF','PNG','JPEG']};
 });
}
export async function setLibraryPassword(pool,user,request){
 input(request,['project_id','password']);const pid=text(request.project_id,'项目'),issue=libraryPasswordIssue(request.password);
 if(issue)throw new HttpError(400,issue);
 await withIdentity(pool,user.id,async client=>{const {profile}=await project(client,user,pid,{write:true});if(profile.role!=='ops')throw new HttpError(403,'仅运营管理员可设置项目下载口令');});
 if(passwordChecks>=2)throw new HttpError(429,'正在校验其他口令，请稍后重试','library_busy');
 passwordChecks++;let encoded;try{encoded=await hashPassword(request.password);}finally{passwordChecks--;}
 return withIdentity(pool,user.id,async client=>{
  const {profile}=await project(client,user,pid,{write:true});if(profile.role!=='ops')throw new HttpError(403,'仅运营管理员可设置项目下载口令');
  await client.query('SELECT app_private.set_library_password($1,$2,$3)',[pid,encoded,randomUUID()]);
  await event(client,user,pid,null,'password_changed');return {configured:true};
 });
}
export async function unlockProjectLibrary(pool,user,request,sessionKey){
 input(request,['project_id','password']);const pid=text(request.project_id,'项目'),key=grantKey(user,sessionKey,pid);
 if(typeof request.password!=='string'||request.password.length>128)throw new HttpError(400,'请输入项目下载口令');
 const now=Date.now(),previous=attempts.get(key);
 if(previous&&previous.until>now&&previous.count>=5)throw new HttpError(429,'口令尝试过多，请5分钟后再试','library_password_limit');
 const secret=await withManagementRead(pool,user,async client=>{await project(client,user,pid);return secretFor(client,pid);});
 if(!secret)throw new HttpError(409,'管理员尚未设置该项目的下载口令','library_password_missing');
 if(passwordChecks>=2)throw new HttpError(429,'正在校验其他口令，请稍后重试','library_busy');
 passwordChecks++;let correct;try{correct=await verifyPassword(request.password,secret.password_hash);}finally{passwordChecks--;}
 if(!correct){
  if(attempts.size>=1024&&!attempts.has(key))attempts.delete(attempts.keys().next().value);
  attempts.set(key,{count:previous&&previous.until>now?previous.count+1:1,until:previous&&previous.until>now?previous.until:now+300000});
  throw new HttpError(403,'项目下载口令不正确','library_password_wrong');
 }
 await withManagementRead(pool,user,async client=>{
  await project(client,user,pid);const latest=await secretFor(client,pid);
  if(latest?.revision!==secret.revision)throw new HttpError(409,'下载口令已更换，请重新验证','library_password_changed');
 });
 if(grants.size>=1024&&!grants.has(key))grants.delete(grants.keys().next().value);
 // requireUser validates the actual session on every request; the map only
 // remembers its project password proof and is invalidated by key/revision.
 grants.set(key,{revision:secret.revision});attempts.delete(key);return {unlocked:true};
}
export async function uploadProjectDocument(pool,user,uploadDir,request,body){
 input(request,['project_id','filename','title','category','new_version_of']);
 const pid=text(request.project_id,'项目'),name=text(request.filename,'文件名',255),category=text(request.category||'其他','分类',80),title=text(request.title||name,'资料名称');
 if(/[\\/]/.test(name))throw new HttpError(400,'文件名不能包含路径');
 if(!Buffer.isBuffer(body)||body.length<1)throw new HttpError(400,'请选择文件');
 if(body.length>MAX_LIBRARY_BYTES)throw new HttpError(413,'一期单件资料不能超过8MiB');
 const detected=libraryFileType(body,name),id=randomUUID();let written=false,absolute;
 try{return await withIdentity(pool,user.id,async client=>{
  const {profile}=await project(client,user,pid,{write:true});let family=id,version=1;
  if(request.new_version_of){
   const original=(await client.query('SELECT id,project_id,document_id FROM public.project_library_documents WHERE id=$1',[identifier(request.new_version_of)])).rows[0];
   if(!original||original.project_id!==pid)throw new HttpError(404,'原资料不存在或无权提交新版本');family=original.document_id;
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('project-library:'||$1,0))",[family]);
  if(family!==id)version=Number((await client.query('SELECT max(version) AS n FROM public.project_library_documents WHERE document_id=$1',[family])).rows[0].n)+1;
  if(version>9999)throw new HttpError(409,'资料版本已达上限，请新建资料');
  await validateLibraryFile(body,detected);
  const storageKey='project-library/'+id+detected.ext;absolute=path.join(uploadDir,storageKey);
  await mkdir(path.dirname(absolute),{recursive:true});await writeFile(absolute,body,{flag:'wx',mode:0o600});written=true;
  const row=(await client.query('INSERT INTO public.project_library_documents(id,document_id,project_id,category,title,name,mime,size,version,storage_key,uploaded_by,uploaded_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING '+columns,
   [id,family,pid,category,title,name,detected.type,body.length,version,storageKey,user.id,profile.name])).rows[0];
  await event(client,user,pid,id,'upload');return publicDocument(row,user,profile);
 });}catch(error){if(written){try{await unlink(absolute);}catch(cleanup){if(cleanup.code!=='ENOENT'){const failure=new HttpError(500,'资料登记失败且临时文件清理失败，请联系管理员','library_cleanup');failure.cause=error;throw failure;}}}throw error;}
}
export async function withdrawProjectDocument(pool,user,request){
 input(request,['id']);const id=identifier(request.id);
 return withIdentity(pool,user.id,async client=>{
  const row=(await client.query('SELECT '+columns+' FROM public.project_library_documents WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row)throw new HttpError(404,'资料不存在或无权访问');const {profile}=await project(client,user,row.project_id,{write:true});
  if(row.uploaded_by!==user.id&&profile.role!=='ops')throw new HttpError(403,'只能撤回本人上传的资料');
  if(row.withdrawn_at)return {id,withdrawn:true};
  await client.query('UPDATE public.project_library_documents SET withdrawn_at=now(),withdrawn_by=$2 WHERE id=$1',[id,user.id]);
  await event(client,user,row.project_id,id,'withdraw');return {id,withdrawn:true};
 });
}
export async function loadProjectDocument(pool,user,uploadDir,inputId,options={}){
 const id=identifier(inputId),original=options.original===true;
 async function permission(client){
  const row=(await client.query('SELECT '+columns+',storage_key FROM public.project_library_documents WHERE id=$1',[id])).rows[0];
  if(!row)throw new HttpError(404,'资料不存在或无权访问');
  const scope=await project(client,user,row.project_id,{write:original});
  if(original){if(scope.profile.role!=='ops')throw new HttpError(403,'仅运营管理员可下载原件');}
  else{
   if(row.withdrawn_at)throw new HttpError(410,'资料已撤回，不再提供预览或下载');
   const secret=await secretFor(client,row.project_id);
   if(!unlocked(user,options.sessionKey,row.project_id,secret))throw new HttpError(403,'请先验证本项目下载口令','library_locked');
  }
  return {...scope,row};
 }
 const withAccess=callback=>original?withIdentity(pool,user.id,callback):withManagementRead(pool,user,callback);
 const first=await withAccess(permission);let body;
 try{body=await readFile(absolutePath(uploadDir,first.row));}catch(error){if(error.code==='ENOENT')throw new HttpError(404,'资料原文件不存在');throw error;}
 if(!original){
  if(watermarkJobs>=2)throw new HttpError(429,'正在生成其他资料水印，请稍后再试','library_busy');
  const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date());
  const label=first.project.name+' · '+first.profile.name+' · '+stamp;
  watermarkJobs++;try{body=await watermarkLibraryFile(body,first.row.mime,label);}finally{watermarkJobs--;}
 }
 // Recheck project access, withdrawal and password revision after generation.
 await withAccess(async client=>{const current=await permission(client);await event(client,user,current.row.project_id,id,original?'original_download':options.inline?'preview':'download');});
 const ext=path.extname(first.row.name),name=original?first.row.name:first.row.name.slice(0,-ext.length)+'_水印'+ext;
 return {buffer:body,type:first.row.mime,name,inline:!original&&options.inline===true};
}
