import {createHash} from 'node:crypto';
import {HttpError} from './errors.mjs';
import {hasManagementRead,withManagementRead} from './management-read.mjs';
import {monthlyPlanMonth,normalizeMonthlyPlanItems} from './monthly-plans.mjs';
import {BUSINESS_MODULES} from './commercial-modules.mjs';
import {RESIDENTIAL_DISCIPLINES} from './report-lines.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lines=new Set([...BUSINESS_MODULES,...RESIDENTIAL_DISCIPLINES]);
const invalid=()=>{throw new HttpError(400,'月度汇总内容或保存标识不正确','invalid_monthly_summary');};
function label(value){if(typeof value!=='string'||!value.trim()||value.length>200||value.includes('\0'))invalid();return value;}

// This is a separate source snapshot. It carries no completion/approval status
// and never creates a weekly reporting period.
export function normalizeMonthlyPlanSummary(value,operation,index){
 if(!object(value)||Object.keys(value).some(key=>!['project_id','report_scope_id','line','owner_id','month','items','expected_summary_id'].includes(key)))invalid();
 label(value.project_id);label(value.owner_id);if(!lines.has(value.line))invalid();
 monthlyPlanMonth(value.month);if(value.report_scope_id!=null)label(value.report_scope_id);
 if(!Object.hasOwn(value,'expected_summary_id')||value.expected_summary_id!==null&&(typeof value.expected_summary_id!=='string'||!uuid.test(value.expected_summary_id)))invalid();
 if(!Array.isArray(value.items)||value.items.length>500)invalid();
 const plain=value.items.map((item,at)=>{
  if(!object(item)||Object.keys(item).some(key=>!['source_id','mod','name','due','progress'].includes(key))||typeof item.progress!=='string'||item.progress.length>10000||item.progress.includes('\0'))invalid();
  const {progress,...fixed}=item;
  return {...fixed,source_id:fixed.source_id??'summary_'+createHash('sha256').update(JSON.stringify([operation,index,at])).digest('hex').slice(0,48)};
 });
 const fixed=normalizeMonthlyPlanItems(plain,null),items=fixed.map((item,at)=>({...item,progress:value.items[at].progress}));
 if(JSON.stringify(items).length>1000000)invalid();
 return {project_id:value.project_id,report_scope_id:value.report_scope_id??null,line:value.line,owner_id:value.owner_id,month:value.month,items,expected_summary_id:value.expected_summary_id?.toLowerCase()??null};
}

export const MONTHLY_SUMMARY_SELECT='id,project_id,report_scope_id,scope_project_ids,line,owner_id,owner_name,to_char(plan_month,\'YYYY-MM\') AS month,items,updated_at,version';
export async function queryMonthlyPlanSummaries(client,{month,project_type}={}){
 const target=monthlyPlanMonth(month);
 if(project_type!==undefined&&!['res','com'].includes(project_type))invalid();
 return (await client.query('SELECT '+MONTHLY_SUMMARY_SELECT+' FROM public.monthly_plan_summaries WHERE plan_month=$1'+(project_type?' AND project_id IN(SELECT id FROM public.projects WHERE project_type=$2)':'')+' ORDER BY project_id,line,owner_id',[target,...(project_type?[project_type]:[])])).rows;
}
export async function listMonthlyPlanSummaries(pool,user,request={}){
 if(!object(request)||Object.keys(request).some(key=>key!=='month'))invalid();monthlyPlanMonth(request.month);
 return withManagementRead(pool,user,async(client,profile)=>{
  if(profile?.status!=='approved'||!['pm','ops','president','pzo'].includes(profile.role)&&!hasManagementRead(profile))throw new HttpError(403,'当前账号无权查看月度汇总','monthly_summary_forbidden');
  return queryMonthlyPlanSummaries(client,request);
 });
}
