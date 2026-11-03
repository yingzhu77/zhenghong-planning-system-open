import { createHash } from 'node:crypto';
import { withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { authorizePlanningAIScope } from './planning-ai-scope.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scopeFields = ['project_id','line','period','report_scope_id'];
const columns = 'revision,updated_at::text AS updated_at';
const emptyConversation = () => ({messages:[],revision:0,updated_at:null});
const emptyPreference = () => ({content:'',revision:0,updated_at:null});
function input(value, extra=[]) {
  if (!object(value) || Object.keys(value).some(key => !scopeFields.concat(extra).includes(key))) throw new HttpError(400,'AI记忆请求不正确','ai_memory_invalid');
  for(const key of ['project_id','line','period']) {
    const limit=key==='project_id'?200:100;
    if(typeof value[key]!=='string' || !value[key].trim() || value[key].length>limit || value[key].includes('\u0000')) throw new HttpError(400,'请选择有效的填报项目、专业和周期','ai_memory_invalid');
  }
  if(value.report_scope_id!==undefined && (typeof value.report_scope_id!=='string' || value.report_scope_id.length>200 || value.report_scope_id.includes('\u0000'))) throw new HttpError(400,'AI记忆填报范围不正确','ai_memory_invalid');
  return value;
}
function sensitive(value) {
  if(/sk-[A-Za-z0-9_-]{16,160}|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(value)) throw new HttpError(400,'记忆内容包含疑似密钥，请移除后再保存','ai_memory_sensitive');
}
function revision(value) {
  if(!Number.isSafeInteger(value) || value<0 || value>=2147483647) throw new HttpError(400,'请重新读取AI记忆版本','ai_memory_invalid');
  return value;
}
async function context(client,user,request,requireWeek=true) {
  const access=await authorizePlanningAIScope(client,user,request);
  if(requireWeek && !access.selected_week)throw new HttpError(400,'对话续接需要有效的填报周期，原填报内容不受影响','ai_memory_invalid');
  const members=[...new Set(access.scope_project_ids.length?access.scope_project_ids:[request.project_id])].sort();
  const reportScope=access.report_scope_id || '';
  const key=createHash('sha256').update(JSON.stringify([reportScope,members])).digest('hex');
  return {user:user.id,pid:request.project_id,line:request.line,week:access.selected_week,members,reportScope,key};
}
function values(scope, conversation) {
  const out=[scope.user,scope.pid,scope.line,scope.key];if(conversation)out.push(scope.week);return out;
}
function where(conversation) {return 'owner_id=$1 AND project_id=$2 AND line=$3 AND scope_key=$4'+(conversation?' AND period_start=$5':'');}
async function read(client,scope,conversation) {
  const table=conversation?'planning_ai_conversations':'planning_ai_preferences',body=conversation?'messages':'content';
  return (await client.query('SELECT '+body+','+columns+' FROM app_private.'+table+' WHERE '+where(conversation),values(scope,conversation))).rows[0] || (conversation?emptyConversation():emptyPreference());
}
export async function loadPlanningAIMemory(pool,user,request) {
  input(request);
  return withIdentity(pool,user.id,async client=>{
    const scope=await context(client,user,request);
    return {conversation:await read(client,scope,true),preference:await read(client,scope,false)};
  });
}
export async function loadPlanningAIWritingPreference(pool,user,request) {
  input(request);
  return withIdentity(pool,user.id,async client=>read(client,await context(client,user,request,false),false));
}
async function save(pool,user,request,body,conversation) {
  const expected=revision(request.expected_revision);
  return withIdentity(pool,user.id,async client=>{
    let scope=await context(client,user,request,conversation);
    const identity=JSON.stringify([scope.key,scope.week]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['planning-ai-memory:'+JSON.stringify([scope.user,scope.pid,scope.line,scope.key,conversation?scope.week:'preference'])]);
    // A browser may have waited while its project or profession was revoked.
    scope=await context(client,user,request,conversation);
    if(JSON.stringify([scope.key,scope.week])!==identity)throw new HttpError(409,'填报范围已变化，请重新读取AI记忆','ai_memory_changed');
    const old=await read(client,scope,conversation);
    const field=conversation?'messages':'content';
    // Retry of an acknowledged save is safe; a different body may not replace a
    // later version, including a deletion marker, without reading that version.
    if(old.revision!==expected) {
      if(old.revision===expected+1 && JSON.stringify(old[field])===JSON.stringify(body))return old;
      throw new HttpError(409,'AI记忆已在其他窗口更新，请重新读取后再保存','ai_memory_changed');
    }
    const table='app_private.'+(conversation?'planning_ai_conversations':'planning_ai_preferences');
    if(!old.revision) {
      const params=[scope.user,scope.pid,scope.line,scope.reportScope,scope.members,scope.key];
      if(conversation)params.push(scope.week);
      params.push(conversation?JSON.stringify(body):body);
      const named='owner_id,project_id,line,report_scope_id,scope_project_ids,scope_key,'+(conversation?'period_start,':'')+field;
      return (await client.query('INSERT INTO '+table+'('+named+') VALUES('+params.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING '+field+','+columns,params)).rows[0];
    }
    const params=values(scope,conversation);params.push(conversation?JSON.stringify(body):body);const slot=params.length;params.push(expected);
    const result=(await client.query('UPDATE '+table+' SET '+field+'=$'+slot+',revision=revision+1 WHERE '+where(conversation)+' AND revision=$'+params.length+' RETURNING '+field+','+columns,params)).rows[0];
    if(!result)throw new HttpError(409,'AI记忆已变化，请重新读取后再保存','ai_memory_changed');
    return result;
  });
}
export async function savePlanningAIConversation(pool,user,request) {
  input(request,['expected_revision','messages']);
  if(!Array.isArray(request.messages) || request.messages.length>50)throw new HttpError(400,'最多保存最近50条对话，请先整理对话记录','ai_memory_invalid');
  const messages=request.messages.map(message=>{
    if(!object(message) || Object.keys(message).some(key=>!['role','content'].includes(key)) || !['user','assistant'].includes(message.role)
      || typeof message.content!=='string' || !message.content.trim() || message.content.length>12000 || message.content.includes('\u0000'))throw new HttpError(400,'对话记忆只能保存用户和助手的文字','ai_memory_invalid');
    sensitive(message.content);return {role:message.role,content:message.content};
  });
  if(JSON.stringify(messages).length>110000)throw new HttpError(400,'对话记录过长，请分段保留','ai_memory_invalid');
  return save(pool,user,request,messages,true);
}
export async function savePlanningAIPreference(pool,user,request) {
  input(request,['expected_revision','content']);
  if(typeof request.content!=='string' || request.content.length>1500 || request.content.includes('\u0000'))throw new HttpError(400,'个人写法记忆不可超过1500字','ai_memory_invalid');
  sensitive(request.content);return save(pool,user,request,request.content.trim(),false);
}
