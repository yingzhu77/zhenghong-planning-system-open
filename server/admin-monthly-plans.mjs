import {createHash} from 'node:crypto';
import {getProfile, withIdentity} from './database.mjs';
import {HttpError} from './errors.mjs';
import {BUSINESS_MODULES,businessModulesForProject} from './commercial-modules.mjs';
import {RESIDENTIAL_DISCIPLINES} from './report-lines.mjs';
import {MONTHLY_PLAN_COLUMNS, monthlyPlanMonth, monthlyPlanFormat, normalizeMonthlyPlanItems} from './monthly-plans.mjs';
import {planProfession,suggestPlanProfession} from './plan-professions.mjs';
import {normalizeMonthlyPlanSummary,queryMonthlyPlanSummaries} from './monthly-plan-summaries.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lines = [...new Set([...BUSINESS_MODULES,...RESIDENTIAL_DISCIPLINES])];
function shape(value, allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new HttpError(400,'管理员月计划请求格式不正确','invalid_admin_monthly_plan');
}
function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length>200 || value.includes('\0')) throw new HttpError(400,label+'不正确','invalid_admin_monthly_plan');
  return value;
}
async function operator(client,user) {
  const profile=await getProfile(client,user.id);
  if (profile?.role!=='ops' || profile.status!=='approved') throw new HttpError(403,'仅管理员可代编和导入月计划','admin_monthly_plan_forbidden');
  return profile;
}
export async function assertAdminPlanOperator(pool,user) {
  return withIdentity(pool,user.id,client=>operator(client,user));
}
const targetKey=p=>JSON.stringify([p.project_id,p.report_scope_id||null,p.line,p.owner_id]);
async function context(client,user,{project_type,month}) {
  await operator(client,user);
  const planMonth=monthlyPlanMonth(month);
  const targets=(await client.query(`SELECT j.id AS project_id,s.id AS report_scope_id,COALESCE(s.name,j.name) AS project_name,
    j.project_type,l.line,p.user_id AS owner_id,p.name AS owner_name
    FROM public.profiles p JOIN public.project_members m ON m.user_id=p.user_id
    JOIN public.projects j ON j.id=m.project_id
    LEFT JOIN app_private.report_scopes s ON s.anchor_project_id=j.id
    CROSS JOIN LATERAL unnest(CASE WHEN j.project_type='com' THEN CASE WHEN p.biz_line='*' THEN $1::text[] ELSE ARRAY[p.biz_line]||ARRAY(SELECT g.line FROM public.commercial_module_grants g WHERE g.user_id=p.user_id AND g.project_id=j.id AND g.line IS DISTINCT FROM p.biz_line) END ELSE ARRAY[p.discipline] END) l(line)
    WHERE p.status='approved' AND p.role='pm' AND ($2::text IS NULL OR j.project_type=$2)
      AND (s.id IS NULL OR $3::date>=date_trunc('month',s.effective_week)::date)
      AND app_private.can_assign_monthly_plan(p.user_id,j.id,l.line,s.id)
    ORDER BY j.sort_order,j.id,l.line,p.name,p.user_id`,[BUSINESS_MODULES,project_type??null,planMonth])).rows
    .filter(target=>target.project_type!=='com'||businessModulesForProject(target.project_id).includes(target.line));
  const valid=new Set(targets.map(targetKey));
  const plans=(await client.query(`SELECT ${MONTHLY_PLAN_COLUMNS.split(',').map(c=>c==='confirmed_by AS owner_id'?'p.confirmed_by AS owner_id':c==='plan_month::text AS plan_month'?'p.plan_month::text AS plan_month':'p.'+c).join(',')},st.in_use
    FROM public.monthly_plans p JOIN public.projects j ON j.id=p.project_id
    JOIN app_private.admin_monthly_plan_states($1::date,$2::text) st ON st.plan_id=p.id
    WHERE p.plan_month=$1 AND ($2::text IS NULL OR j.project_type=$2) ORDER BY p.project_id,p.line,p.confirmed_by`,[planMonth,project_type??null])).rows.map(p=>{
      const editable=!p.in_use && valid.has(targetKey(p));
    return {...p,editable,lock_reason:p.in_use?'已有周报或完成／延期申报引用，不能修改':editable?'':'提报人当前项目或专业授权不完整，不能代编'};
    });
  const summaries=await queryMonthlyPlanSummaries(client,{month,project_type});
  const project_professions=targets.some(t=>t.project_id==='szzz'&&t.report_scope_id==='shenzhen-shangmugu-residential')
    ?[{project_id:'szzz',report_scope_id:'shenzhen-shangmugu-residential',line:'良安田项目',assigned:targets.some(t=>t.project_id==='szzz'&&t.report_scope_id==='shenzhen-shangmugu-residential'&&t.line==='良安田项目')}]:[];
  return {targets,plans,summaries,project_professions};
}
export async function getAdminPlanContext(pool,user,request={}) {
  shape(request,['project_type','month']);
  if (request.project_type!==undefined && !['res','com'].includes(request.project_type)) throw new HttpError(400,'项目类型不正确','invalid_admin_monthly_plan');
  monthlyPlanMonth(request.month);
  return withIdentity(pool,user.id,client=>context(client,user,request));
}

export function adminPlanLineHint(row,projectId,type) {
  const source=planProfession(row.source?.sheet,type,projectId);
  return source?.line==='良安田项目'?row.source.sheet:row.line_hint;
}
export function matchAdminPlanTarget(targets,lineHint,projectId=targets[0]?.project_id) {
  const type=targets[0]?.project_type,profession=planProfession(lineHint,type,projectId);
  const line=profession&&(type!=='com'||businessModulesForProject(targets[0]?.project_id).includes(profession.line))?profession.line:null;
  const candidates=line?targets.filter(t=>t.line===line):targets;
  // Workbook work-responsible names describe the work, not platform accounts.
  // Only the selected project's actual professional grants identify a reporter.
  const chosen=line&&candidates.length===1?candidates[0]:null;
  return {line,owner_id:chosen?.owner_id??null,candidate_targets:candidates,
    match_status:chosen?'matched':line&&candidates.length>1?'ambiguous':'unmatched',
    match_basis:chosen?'project_line_unique':'',
    profession_mapping:profession?{source_label:String(lineHint??''),line,basis:profession.basis,requires_confirmation:false}:null};
}
export async function previewAdminPlanRows(pool,user,request) {
  shape(request,['project_id','report_scope_id','month','rows']);
  identifier(request.project_id,'项目');monthlyPlanMonth(request.month);
  if (request.report_scope_id!=null) identifier(request.report_scope_id,'统一填报范围');
  if (!Array.isArray(request.rows) || request.rows.length>2000 || request.rows.some(row=>!object(row))) throw new HttpError(400,'导入预览须为最多2000行的列表','invalid_admin_monthly_plan');
  return withIdentity(pool,user.id,async client=>{
    const all=await context(client,user,{month:request.month});
    const targets=all.targets.filter(t=>t.project_id===request.project_id && (t.report_scope_id||null)===(request.report_scope_id||null));
    if (!targets.length) throw new HttpError(403,'该项目没有可代编的提报人或缺少合并范围授权','admin_monthly_plan_forbidden');
    const rows=request.rows.map(row=>{
      // Parser provenance is preserved in this ephemeral preview only. Saving
      // accepts the normal monthly-plan fields, never workbook formulas/code.
      const match=matchAdminPlanTarget(targets,adminPlanLineHint(row,request.project_id,targets[0]?.project_type),request.project_id);
      const hint=!match.line&&suggestPlanProfession(row,targets[0]?.project_type),suggestion=hint&&matchAdminPlanTarget(targets,hint.line);
      const warnings=Array.isArray(row.warnings)?row.warnings.map(w=>object(w)&&w.code==='reporter_missing'
        ?{...w,message:'原表工作责任人为空，仅供参考；系统提报人按项目和专业匹配'}:w):[];
      if(!match.line)warnings.push('原表专业尚未明确，请确认专业及获授权的提报人');
      else if(match.match_status==='ambiguous')warnings.push('该项目同专业有多名获授权提报人，请明确指定');
      else if(!match.owner_id)warnings.push('该项目此专业暂无获授权提报人，请核对专业或账号授权');
      return {...row,...match,profession_suggestion:suggestion?.line?{line:suggestion.line,owner_id:suggestion.owner_id,reason:hint.reason,requires_confirmation:true}:null,warnings};
    });
    return {month:request.month,targets,plans:all.plans.filter(p=>p.project_id===request.project_id && (p.report_scope_id||null)===(request.report_scope_id||null)),summaries:all.summaries.filter(p=>p.project_id===request.project_id && (p.report_scope_id||null)===(request.report_scope_id||null)),project_professions:all.project_professions.filter(p=>p.project_id===request.project_id&&(p.report_scope_id||null)===(request.report_scope_id||null)),rows};
  });
}

function normalizePlan(value,operation,index) {
  shape(value,['project_id','report_scope_id','line','owner_id','month','items','rich_text','expected_plan_id']);
  identifier(value.project_id,'项目');identifier(value.owner_id,'提报人');monthlyPlanMonth(value.month);
  if (!lines.includes(value.line)) throw new HttpError(400,'请选择有效的专业或模块','invalid_admin_monthly_plan');
  if (value.report_scope_id!=null) identifier(value.report_scope_id,'统一填报范围');
  if (!Object.hasOwn(value,'expected_plan_id') || value.expected_plan_id!==null && (typeof value.expected_plan_id!=='string' || !uuid.test(value.expected_plan_id))) throw new HttpError(400,'请重新读取月计划后保存','invalid_admin_monthly_plan');
  if (!Array.isArray(value.items)) throw new HttpError(400,'月计划须为事项列表','invalid_admin_monthly_plan');
  const sourceItems=value.items.map((item,at)=>object(item)&&item.source_id===undefined?{...item,source_id:'admin_'+createHash('sha256').update(JSON.stringify([operation,index,at])).digest('hex').slice(0,48)}:item);
  const items=normalizeMonthlyPlanItems(sourceItems,value.report_scope_id);
  return {project_id:value.project_id,report_scope_id:value.report_scope_id??null,line:value.line,owner_id:value.owner_id,month:value.month,items,
    rich_text:monthlyPlanFormat(value.rich_text,items),expected_plan_id:value.expected_plan_id?.toLowerCase()??null};
}
export async function saveAdminMonthlyPlans(pool,user,request) {
  shape(request,['operation_id','plans','summaries']);
  const withSummaries=Object.hasOwn(request,'summaries');
  if (typeof request.operation_id!=='string' || !uuid.test(request.operation_id) || !Array.isArray(request.plans) || request.plans.length>100 || !withSummaries&&request.plans.length<1 || withSummaries&&(!Array.isArray(request.summaries)||request.summaries.length>100||!request.summaries.length&&!request.plans.length)) throw new HttpError(400,'请选择需要保存的月计划或月度汇总，每类最多100份','invalid_admin_monthly_plan');
  const operation=request.operation_id.toLowerCase(),plans=request.plans.map((p,i)=>normalizePlan(p,operation,i));
  const summaries=withSummaries?request.summaries.map((s,i)=>normalizeMonthlyPlanSummary(s,operation,i)):[];
  if (new Set(plans.map(p=>JSON.stringify([targetKey(p),p.month]))).size!==plans.length) throw new HttpError(400,'同一提报人同月专业计划不能重复提交','invalid_admin_monthly_plan');
  if (new Set(summaries.map(p=>JSON.stringify([targetKey(p),p.month]))).size!==summaries.length) throw new HttpError(400,'同一提报人同月专业汇总不能重复提交','invalid_monthly_summary');
  return withIdentity(pool,user.id,async client=>{
    await operator(client,user);
    try { return (await client.query(withSummaries?'SELECT app_private.save_admin_monthly_plan_bundle($1,$2::jsonb,$3::jsonb) AS result':'SELECT app_private.save_admin_monthly_plans($1,$2::jsonb) AS result',withSummaries?[operation,JSON.stringify(plans),JSON.stringify(summaries)]:[operation,JSON.stringify(plans)])).rows[0].result; }
    catch(error) {
      if (error.code==='42501') throw new HttpError(403,'目标提报人当前没有此项目或专业的完整授权','admin_monthly_plan_forbidden');
      if (error.code==='P0002' && error.detail==='monthly_summary_changed') throw new HttpError(409,'月度汇总已被其他管理员更新，请重新读取后保存','monthly_summary_changed');
      if (error.code==='P0002' || error.code==='23505') throw new HttpError(409,'月计划已被本人或其他管理员更新，请刷新后确认','monthly_plan_changed');
      if (error.code==='23514' && error.detail==='monthly_plan_in_use') throw new HttpError(409,error.message,'monthly_plan_in_use');
      if (error.code==='23514' && error.detail==='monthly_plan_operation_withdrawn') throw new HttpError(409,error.message,'monthly_plan_operation_withdrawn');
      if (error.code==='23514' && error.detail==='monthly_plan_operation_conflict') throw new HttpError(409,error.message,'monthly_plan_operation_conflict');
      if (error.code==='23514' && error.detail==='monthly_summary_operation_conflict') throw new HttpError(409,error.message,'monthly_summary_operation_conflict');
      if (['22023','22007','22008','22P02','23514'].includes(error.code)) throw new HttpError(400,'月计划内容、日期、范围或事项数量不正确','invalid_admin_monthly_plan');
      throw error;
    }
  });
}
