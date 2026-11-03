import { withIdentity, getProfile,reportWeekStart } from './database.mjs';
import { resolveCompletionSource, preloadCompletionDeadlines,completionOwnerMatches,reportCoordinationSourceKey } from './completion-sources.mjs';
import { businessModulesForProfile, withBusinessModuleGrants } from './commercial-modules.mjs';
import { HttpError } from './errors.mjs';

const DAY=86400000, MAX=1000;
const array=value=>Array.isArray(value)?value:[];
const day=value=>typeof value==='string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function planningAIToday(now=new Date()){return new Date(new Date(now).getTime()+8*3600000).toISOString().slice(0,10);}
// Recognizable read requests always re-read current records, even if the model
// tries to answer from its earlier prose. This is a bounded read, never a write.
export function planningAIReadIntent(message,period,now=new Date()){
  if(!/(查|汇总|分析|总结|哪些|多少|几项|几条)/.test(message) || /(不要|不需要)(查|汇总|分析)|替换成|改为|补充为/.test(message))return null;
  const kind=/历史|上周|第\s*\d+\s*周|周报/.test(message)?'history':/逾期|到期/.test(message)?'overdue':/事项|待办|任务/.test(message)?'summary':null;
  if(!kind)return null;
  const query={kind,scope:/(所有|全部|各个|各)获?授权?项目|所有项目|全部项目/.test(message)?'mine':'current',start:'',end:'',keyword:'',project_name:'',limit:10};
  const dates=message.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if(dates.length){query.start=dates[0];query.end=dates[1] || dates[0];}
  else if(kind==='history'){
    let week=reportWeekStart(period,now);
    if(/上周/.test(message) && week)week=new Date(Date.parse(week+'T00:00:00Z')-7*DAY).toISOString().slice(0,10);
    else if(/第\s*\d+\s*周/.test(message))week=reportWeekStart(message,now);
    else if(!/本周/.test(message))week='';
    if(week)query.start=query.end=week;
  }
  return validatePlanningAILookup(query);
}
export function validatePlanningAILookup(value){
  if(value===undefined)return {kind:'none',scope:'current',start:'',end:'',keyword:'',project_name:'',limit:10};
  const names=['kind','scope','start','end','keyword','project_name','limit'];
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==names.length || names.some(key=>!Object.hasOwn(value,key))
    || !['none','summary','history','overdue'].includes(value.kind) || !['current','mine'].includes(value.scope)
    || ['start','end','keyword','project_name'].some(key=>typeof value[key]!=='string' || value[key].length>200 || /[\u0000-\u001f]/.test(value[key]))
    || value.start && !day(value.start) || value.end && !day(value.end) || value.start && value.end && value.start>value.end
    || !Number.isInteger(value.limit) || value.limit<1 || value.limit>30)throw new HttpError(502,'AI查询条件不完整，请明确项目、日期或关键词后重试','ai_lookup_invalid');
  return value;
}
function bounded(rows,label){if(rows.length>MAX)throw new HttpError(422,label+'超过1000条，请限定项目、日期或关键词后查询','ai_lookup_too_large');return rows;}
function reportView(row){
  return {id:String(row.id),project_id:row.project_id,period:row.period,week:row.week,line:row.line,
    submitted_at:row.submitted_at,change:row.change_text || '',risk:row.dev_text || '',impact:row.impact || '',projection:row.projection || '',
    items:array(row.biz?.items).map(item=>({name:item.name,progress:item.prog || '',due:item.due || '',blocker:item.blocker || ''})),
    nodes:array(row.biz?.nodes).length?row.biz.nodes:array(row.node_items),coordination:array(row.coord_items),
    followups:array(row.biz?.followups),next:array(row.next_items),history_versions:row.history_versions || 0};
}

const permissionKey=(project,line)=>JSON.stringify([project,line]);
async function writableLines(client,user,projects){
  const candidates=projects.flatMap(project=>project.lines.map(line=>({project:project.id,line})));
  if(!candidates.length)return new Set();
  // Keep the existing authority function for each pair, but avoid one database
  // round trip per project/module. This set lives only inside this transaction;
  // the response-time check below always reads the current authority again.
  const rows=(await client.query('SELECT candidate.project_id,candidate.line,app_private.can_write_report(candidate.project_id,candidate.line,$3) AS allowed FROM unnest($1::text[],$2::text[]) AS candidate(project_id,line)',
    [candidates.map(row=>row.project),candidates.map(row=>row.line),user.id])).rows;
  return new Set(rows.filter(row=>row.allowed).map(row=>permissionKey(row.project_id,row.line)));
}

// Only server-owned records under the caller's existing RLS identity are used
// for counts and deadlines. Client draft text never becomes an approved fact.
export async function loadPlanningAIFacts(pool,user,input,request,{now=new Date()}={}){
  const query=validatePlanningAILookup(request),today=planningAIToday(now);
  return withIdentity(pool,user.id,async client=>{
    const profile=await getProfile(client,user.id);
    if(profile?.status!=='approved' || profile.role!=='pm')throw new HttpError(403,'仅可查询本人获授权事项','ai_scope_forbidden');
    const visible=(await client.query('SELECT id,name,project_type FROM public.projects ORDER BY id')).rows;
    const businessProfile=visible.some(project=>project.id==='hf')?(await withBusinessModuleGrants(client,[profile],'hf'))[0]:profile;
    const scopes=visible.map(project=>({...project,lines:(project.project_type==='com'?businessModulesForProfile(businessProfile,project.id):['综合',profile.discipline]).filter(Boolean)}));
    const permissions=await writableLines(client,user,scopes),projects=[];let anchorAllowed=false;
    for(const project of scopes){
      const allowed=project.lines.filter(line=>permissions.has(permissionKey(project.id,line)));
      if(project.id===input.project_id && allowed.includes(input.line))anchorAllowed=true;
      if(allowed.length && (query.scope==='mine' || project.id===input.project_id || array(input.scope_project_ids).includes(project.id))
        && (!query.project_name || project.name.includes(query.project_name)))projects.push({...project,lines:query.scope==='current' && project.project_type==='com'?allowed.filter(line=>line===input.line):allowed});
    }
    if(!anchorAllowed)throw new HttpError(403,'当前填报范围已失去访问权限，请重新选择项目模块','ai_scope_forbidden');
    const selected=projects.filter(project=>project.lines.length),ids=selected.map(project=>project.id),byId=new Map(selected.map(project=>[project.id,project]));
    const base={kind:query.kind,as_of:today,scope:query.scope==='mine'?'本人当前获授权项目':'当前填报项目与模块',query,
      projects:selected.map(project=>({id:project.id,name:project.name,lines:project.lines})),
      basis:'已确认计划、已保存且本人承办的事项及本人已提交周报；本机未提交文字不计入统计。完成按有效审核，延期按已批准日期。',sources:[]};
    const allowedReport=row=>byId.has(row.project_id) && byId.get(row.project_id).lines.includes(row.line || '综合')
      && (!row.report_scope_id || array(row.scope_project_ids).every(id=>visible.some(project=>project.id===id)));
    const values=[user.id,ids],filters=['author_id=$1','project_id=ANY($2::text[])'];
    if(query.kind==='history'){
      if(query.start){values.push(query.start);filters.push('app_private.report_week_start(period,submitted_at)>=$'+values.length+'::date');}
      if(query.end){values.push(query.end);filters.push('app_private.report_week_start(period,submitted_at)<=$'+values.length+'::date');}
      if(query.keyword){values.push(query.keyword);filters.push("strpos(lower(concat_ws(' ',period,change_text,dev_text,biz::text)),lower($"+values.length+'))>0');}
    }
    const reports=bounded((await client.query('SELECT id,project_id,author_id,period,line,submitted_at,report_scope_id,scope_project_ids,change_text,dev_text,impact,projection,biz,node_items,coord_items,next_items,COALESCE(jsonb_array_length(history),0) AS history_versions,app_private.report_week_start(period,submitted_at)::text AS week FROM public.reports WHERE '+filters.join(' AND ')+' ORDER BY app_private.report_week_start(period,submitted_at) DESC NULLS LAST,submitted_at DESC,id DESC LIMIT 1001',values)).rows,'本人周报').filter(allowedReport);
    if(query.kind==='history'){
      const rows=reports.slice(0,query.limit).map(reportView);
      rows.forEach((row,index)=>{row.project_name=byId.get(row.project_id).name;row.source='周报'+(index+1)+' · '+row.project_name+' · '+row.period+' · '+row.line;});
      const result={...base,total:reports.length,shown:rows.length,has_more:reports.length>rows.length,reports:rows,sources:rows.map(row=>row.source)};
      if(JSON.stringify(result).length>160000)throw new HttpError(422,'周报正文较多，请缩小日期范围或每次只查1至3份','ai_lookup_too_large');
      return result;
    }
    const plans=bounded((await client.query('SELECT * FROM public.monthly_plans WHERE confirmed_by=$1 AND project_id=ANY($2::text[]) ORDER BY plan_month DESC,id LIMIT 1001',[user.id,ids])).rows,'本人月计划');
    const meetings=bounded((await client.query('SELECT * FROM public.reporter_tasks WHERE owner_id=$1 AND project_id=ANY($2::text[]) LIMIT 1001',[user.id,ids])).rows,'本人会议事项');
    const coords=bounded((await client.query('SELECT * FROM public.coordination_tasks WHERE owner_id=$1 AND project_id=ANY($2::text[]) LIMIT 1001',[user.id,ids])).rows,'本人协调事项');
    const nodes=profile.discipline?bounded((await client.query('SELECT * FROM public.milestones WHERE project_id=ANY($1::text[]) AND line=$2 LIMIT 1001',[ids,profile.discipline])).rows,'本人专业节点'):[];
    const candidates=new Map(),monthlyScopes=[],add=(key,progress='',extra={})=>{if(!candidates.has(key))candidates.set(key,{key,progress,...extra});};
    for(const plan of plans){
      // Unified weekly reports remain comprehensive. Their professional monthly
      // plans use the plan's own RLS and author, not a new weekly write right.
      const ownedScopedPlan=!!plan.report_scope_id && plan.line===profile.discipline && byId.has(plan.project_id)
        && array(plan.scope_project_ids).length>1 && plan.scope_project_ids.every(id=>visible.some(project=>project.id===id));
      if(ownedScopedPlan)monthlyScopes.push({id:plan.id,line:plan.line,project_ids:plan.scope_project_ids});
      if(ownedScopedPlan || byId.get(plan.project_id)?.lines.includes(plan.line))for(const item of array(plan.items))if(item.source_id)add('monthly:'+plan.project_id+':'+plan.id+':'+item.source_id,'',{period:String(plan.plan_month).slice(0,10)});
    }
    for(const task of meetings)add('meeting:'+task.project_id+':'+task.id,task.progress || '');
    for(const task of coords)add('coord:'+task.project_id+':'+task.id);
    for(const node of nodes)add('milestone:'+node.project_id+':'+node.id,node.note || '');
    let unlinked=0;
    for(const report of reports){
      for(const group of ['items','nodes'])for(const item of array(report.biz?.[group])){
        const baseline=group==='nodes' && nodes.find(node=>node.project_id===report.project_id && (item.milestone_id!=null?String(node.id)===String(item.milestone_id):!item.source_id && node.name===item.name));
        if(baseline){const key='milestone:'+report.project_id+':'+baseline.id;if(!candidates.get(key).feedbackSet)Object.assign(candidates.get(key),{progress:item.prog || '',feedbackSet:true,period:report.period});}
        else if(group==='items' && (report.biz?.monthly_plan_id || array(report.biz?.monthly_plan_ids).includes(item.monthly_plan_id)) && item.source_id){const key='monthly:'+report.project_id+':'+(report.biz.monthly_plan_id || item.monthly_plan_id)+':'+item.source_id;if(candidates.has(key) && !candidates.get(key).feedbackSet)Object.assign(candidates.get(key),{progress:[item.prog,item.blocker && '遇到卡点：'+item.blocker].filter(Boolean).join('\n'),feedbackSet:true,period:report.period});}
        else if(item.source_id)add('plan:'+report.project_id+':'+report.id+':'+group+':'+item.source_id,item.prog || '',{period:report.period});
        else if(item.name)unlinked++;
      }
      for(const item of array(report.biz?.followups))if(candidates.has(item.source_key) && !candidates.get(item.source_key).feedbackSet)Object.assign(candidates.get(item.source_key),{progress:item.progress || '',feedbackSet:true,period:report.period});
    }
    // Incoming coordination from historic reports follows the same exact
    // recipient/source resolver as the existing workbench, never name guessing.
    const incoming=bounded((await client.query("SELECT id,project_id,author_id,line,coord_items,biz->'handover' AS handover FROM public.reports WHERE project_id=ANY($1::text[]) AND (jsonb_array_length(COALESCE(coord_items,'[]'::jsonb))>0 OR jsonb_array_length(COALESCE(biz->'handover','[]'::jsonb))>0) LIMIT 1001",[ids])).rows,'项目协调来源');
    for(const report of incoming)for(const group of ['coord','handover'])for(const item of array(group==='coord'?report.coord_items:report.handover)){
      if(!item?.what)continue;
      const target=group==='coord'?item.who:item.to,named=group==='coord' && Object.hasOwn(item,'who_id');
      const mine=named?item.who_id===user.id:completionOwnerMatches(target,businessProfile,report.project_id) || completionOwnerMatches(item.what,businessProfile,report.project_id);
      const ownHandover=group==='handover' && report.author_id===user.id && byId.get(report.project_id).lines.includes(report.line);
      if(mine || ownHandover)add(reportCoordinationSourceKey(report,group,item));
    }
    if(candidates.size>MAX)throw new HttpError(422,'本人事项超过1000项，请限定项目后查询','ai_lookup_too_large');
    const approvals=bounded((await client.query('SELECT * FROM public.completion_requests WHERE owner_id=$1 AND project_id=ANY($2::text[]) ORDER BY created_at DESC,id DESC LIMIT 1001',[user.id,ids])).rows,'本人事项审核记录');
    const cache=new Map();await preloadCompletionDeadlines(client,approvals,cache);
    const rows=[];let unavailable=0;
    for(const entry of candidates.values()){
      let source;
      try{source=await resolveCompletionSource(client,user,entry.key,{forOwnerId:user.id,cache});}
      catch(error){if(error instanceof HttpError && [400,403,404].includes(error.status)){unavailable++;continue;}throw error;}
      const requests=approvals.filter(row=>row.source_key===entry.key),completed=requests.find(row=>row.request_type==='completion' && row.status==='approved' && row.source_version===source.source_version);
      const legacyDone=source.milestone_done && !requests.some(row=>row.request_type==='completion' && ['approved','reopened'].includes(row.status));
      const done=!!completed || !!legacyDone,due=source.effective_due || '',valid=day(due),days=valid && !done?Math.max(0,Math.round((Date.parse(today)-Date.parse(due))/DAY)):0;
      rows.push({source_key:entry.key,project_id:source.project_id,project_name:byId.get(source.project_id).name,kind:source.kind,
        title:source.title,what:source.what,progress:entry.progress,period:entry.period || '',original_due:source.original_due || '',effective_due:due,
        completed:done,completion_date:completed?.completion_date || '',extension_approved:!!source.extension_id,overdue:days>0,overdue_days:days,
        due_in_days:valid?Math.round((Date.parse(due)-Date.parse(today))/DAY):null,
        status:done?'已完成（有效审核或原节点完成记录）':requests.some(row=>row.status==='pending')?'待审核':'未完成'});
    }
    const matched=rows.filter(row=>(!query.keyword || (row.what+' '+row.progress).includes(query.keyword)) && (!query.start || row.effective_due>=query.start) && (!query.end || !!row.effective_due && row.effective_due<=query.end));
    matched.sort((a,b)=>b.overdue_days-a.overdue_days || String(a.effective_due || '9999').localeCompare(b.effective_due || '9999') || a.source_key.localeCompare(b.source_key));
    const summary={total:matched.length,completed:matched.filter(row=>row.completed).length,overdue:matched.filter(row=>row.overdue).length,
      pending_review:matched.filter(row=>row.status==='待审核').length,missing_deadline:matched.filter(row=>!day(row.effective_due)).length,
      due_next7:matched.filter(row=>!row.completed && row.due_in_days!==null && row.due_in_days>=0 && row.due_in_days<=7).length,
      extension_approved:matched.filter(row=>row.extension_approved).length};
    const display=(query.kind==='overdue'?matched.filter(row=>row.overdue):matched),items=display.slice(0,query.limit);
    items.forEach((row,index)=>{row.source='事项'+(index+1)+' · '+row.project_name+' · '+row.title+' · '+row.what.slice(0,70);});
    return {...base,...(monthlyScopes.length?{monthly_scopes:monthlyScopes}:{}),summary,total:display.length,shown:items.length,has_more:display.length>items.length,unavailable,unlinked_legacy:unlinked,items,sources:items.map(row=>row.source)};
  });
}

export async function assertPlanningAIFactAccess(pool,user,records){
  return withIdentity(pool,user.id,async client=>{
    const profile=await getProfile(client,user.id);
    if(profile?.status!=='approved' || profile.role!=='pm')throw new HttpError(403,'本人查询权限已变化，请重新查询','ai_scope_forbidden');
    const permissions=await writableLines(client,user,records.projects);
    for(const project of records.projects)for(const line of project.lines){
      if(!permissions.has(permissionKey(project.id,line)))throw new HttpError(403,'本人项目范围已变化，查询结果未返回，请重新查询','ai_scope_forbidden');
    }
    const monthlyScopes=array(records.monthly_scopes);
    if(monthlyScopes.length){
      const current=(await client.query('SELECT id,line,scope_project_ids FROM public.monthly_plans WHERE id=ANY($1::uuid[]) AND confirmed_by=$2 AND report_scope_id IS NOT NULL',[monthlyScopes.map(plan=>plan.id),user.id])).rows;
      const byPlan=new Map(current.map(plan=>[plan.id,plan]));
      for(const plan of monthlyScopes){
        const row=byPlan.get(plan.id);
        if(!row || row.line!==profile.discipline || row.line!==plan.line || JSON.stringify(row.scope_project_ids)!==JSON.stringify(plan.project_ids))
          throw new HttpError(403,'本人专业月计划范围已变化，查询结果未返回，请重新查询','ai_scope_forbidden');
      }
    }
  });
}
