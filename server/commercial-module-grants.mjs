import {getProfile,withIdentity} from './database.mjs';
import {HttpError} from './errors.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export async function listCommercialModuleGrants(pool,user){
 return withIdentity(pool,user.id,async client=>{
  const profile=await getProfile(client,user.id);
  if(profile?.status!=='approved'||!['pm','ops'].includes(profile.role))throw new HttpError(403,'当前账号无权读取附加专业授权','commercial_module_grants_forbidden');
  return (await client.query('SELECT user_id,project_id,line FROM public.commercial_module_grants'+(profile.role==='ops'?'':' WHERE user_id=$1')+' ORDER BY project_id,line,user_id',profile.role==='ops'?[]:[user.id])).rows;
 });
}
export async function saveCommercialModuleGrant(pool,user,request){
 if(!object(request)||Object.keys(request).some(key=>!['user_id','project_id','line','enabled'].includes(key))||typeof request.user_id!=='string'||!request.user_id.trim()||request.user_id.length>200||request.user_id.includes('\0')||request.project_id!=='hf'||request.line!=='设计部'||typeof request.enabled!=='boolean')throw new HttpError(400,'请明确弘坊设计部附加授权的账号与操作','invalid_commercial_module_grant');
 return withIdentity(pool,user.id,async client=>{
  try{return (await client.query('SELECT app_private.save_commercial_module_grant($1,$2,$3,$4) result',[request.user_id,request.project_id,request.line,request.enabled])).rows[0].result;}
  catch(error){if(error.code==='42501')throw new HttpError(403,'仅管理员可为已有弘坊成员且已审核的提报人管理附加专业授权','commercial_module_grants_forbidden');if(error.code==='22023')throw new HttpError(400,error.message,'invalid_commercial_module_grant');throw error;}
 });
}
