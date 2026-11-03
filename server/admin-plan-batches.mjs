import {withIdentity} from './database.mjs';
import {assertAdminPlanOperator} from './admin-monthly-plans.mjs';
import {monthlyPlanMonth} from './monthly-plans.mjs';
import {HttpError} from './errors.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function shape(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'保存批次请求格式不正确','invalid_admin_batch');}
function identifier(value){return typeof value==='string'&&value.trim()&&value.length<=200&&!value.includes('\0');}
export async function listAdminPlanBatches(pool,user,request){
 shape(request,['project_id','report_scope_id','month','page']);const month=monthlyPlanMonth(request.month);
 const page=request.page===undefined?0:Number(request.page);
 if(!identifier(request.project_id)||request.report_scope_id!=null&&!identifier(request.report_scope_id)||!Number.isSafeInteger(page)||page<0||page>100000)throw new HttpError(400,'请选择有效的项目、月份和批次页码','invalid_admin_batch');
 await assertAdminPlanOperator(pool,user);
 return withIdentity(pool,user.id,async client=>(await client.query('SELECT app_private.list_admin_monthly_batches($1,$2,$3::date,$4::int) AS result',[request.project_id,request.report_scope_id??null,month,page])).rows[0].result);
}
export async function withdrawAdminPlanBatch(pool,user,request){
 shape(request,['actor_id','operation_id']);
 if(!identifier(request.actor_id)||typeof request.operation_id!=='string'||!uuid.test(request.operation_id))throw new HttpError(400,'请重新读取后选择需要撤回的保存批次','invalid_admin_batch');
 await assertAdminPlanOperator(pool,user);
 return withIdentity(pool,user.id,async client=>{
  try{return (await client.query('SELECT app_private.withdraw_admin_monthly_batch($1,$2::uuid) AS result',[request.actor_id,request.operation_id.toLowerCase()])).rows[0].result;}
  catch(error){
   if(error.code==='42501')throw new HttpError(403,'当前账号或目标提报人的项目、专业授权不完整，整批未撤回','admin_batch_forbidden');
   if(error.code==='P0002')throw new HttpError(404,'保存批次不存在，请重新读取','admin_batch_not_found');
   if(['23514','23505'].includes(error.code))throw new HttpError(409,error.code==='23514'?error.message:'该批次版本已变化，整批未撤回，请重新读取','admin_batch_changed');
   throw error;
  }
 });
}
