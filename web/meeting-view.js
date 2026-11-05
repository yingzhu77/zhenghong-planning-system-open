/* Projection reads use the existing authenticated APIs; window messages contain selectors only. */
(function(global){
  'use strict';
  var sections={monthly:'月度会议（总结＋计划）',all:'完整周报',nodes:'核心节点',plans:'当月计划',summaries:'月度完成情况',coord:'需要协调',followups:'待办反馈',media:'总图与附件'};
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function shiftMonth(month,amount){var parts=month.split('-').map(Number),index=parts[0]*12+parts[1]-1+amount;return String(Math.floor(index/12)).padStart(4,'0')+'-'+String(index%12+1).padStart(2,'0');}
  function months(selection){var start=global.PlanningWindows.periodStart(selection.period).slice(0,7),summary=selection.section==='monthly'?(selection.summaryMonth || shiftMonth(start,-1)):start;return {summary:summary,plan:shiftMonth(summary,1)};}
  function monthLabel(month){return month.slice(0,4)+'年'+Number(month.slice(5))+'月';}
  function target(value){
    if(!value || typeof value!=='object' || !Array.isArray(value.projectIds) || !value.projectIds.length || value.projectIds.length>30
      || value.projectIds.some(function(id){return typeof id!=='string' || !id || id.length>200;}) || new Set(value.projectIds).size!==value.projectIds.length
      || !['res','com'].includes(value.type) || typeof value.period!=='string' || !global.PlanningWindows.periodStart(value.period)
      || typeof value.line!=='string' || value.line.length>200 || !Object.hasOwn(sections,value.section)
      || value.kind!==undefined && value.kind!=='report' && value.kind!=='arrangement'
      || value.kind==='arrangement' && (value.projectIds.length!==1 || !/^[a-f0-9-]{36}$/i.test(value.taskId || ''))
      || value.section==='monthly' && value.summaryMonth!==undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.summaryMonth))throw new Error('投影选择无效，请重新选择。');
    return {kind:value.kind || 'report',type:value.type,projectIds:value.projectIds.slice(),period:value.period,line:value.line,section:value.section,
      ...(value.section==='monthly'?{summaryMonth:value.summaryMonth || shiftMonth(global.PlanningWindows.periodStart(value.period).slice(0,7),-1)}:{}),
      ...(value.kind==='arrangement'?{taskId:value.taskId}:{})};
  }
  async function request(url,body,signal){
    var response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal:signal,
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    var result=await response.json();
    if(!response.ok || result.error)throw new Error(result.error && result.error.message || '投影读取失败，请检查登录和网络。');
    return result.data;
  }
  function select(table,pid,columns,signal){return request('/api/db',{table:table,operation:'select',columns:columns,filters:[{column:'project_id',value:pid}],limit:5000},signal);}
  function selectedPlans(plans,projectIds){
    return (plans || []).filter(function(plan){
      return projectIds.includes(plan.project_id) && (!plan.report_scope_id
        || Array.isArray(plan.scope_project_ids) && plan.scope_project_ids.includes(plan.project_id)
          && plan.scope_project_ids.every(function(pid){return projectIds.includes(pid);}));
    });
  }
  async function authorize(uid,selection,signal){
    var data=await request('/api/auth/session',undefined,signal),user=data && data.session && data.session.user;
    if(!user || user.id!==uid || user.must_change_password)throw new Error('登录身份已变化，请从管理员窗口重新开启投影。');
    var profiles=await request('/api/db',{table:'profiles',operation:'select',columns:'user_id,name,role,status',filters:[{column:'user_id',value:uid}]},signal);
    if(!profiles[0] || profiles[0].status!=='approved' || !['ops','president','pzo'].includes(profiles[0].role))throw new Error('当前身份无权使用会议投影。');
    var found=await Promise.all(selection.projectIds.map(function(pid){return request('/api/db',{table:'projects',operation:'select',columns:'id,name,project_type,display_group',filters:[{column:'id',value:pid}]},signal);}));
    var projects=found.map(function(rows){return rows[0];});
    if(projects.some(function(project){return !project || (project.project_type==='com'?'com':'res')!==selection.type;}))throw new Error('项目读取权限或类型已变化，请重新选择。');
    return projects;
  }
  async function read(uid,value,signal){
    var selection=target(value),projects=await authorize(uid,selection,signal);
    if(selection.kind==='arrangement'){
      var tasks=await request('/api/reporter-tasks/list',{project_id:projects[0].id,id:selection.taskId},signal),task=tasks.filter(function(row){return row.id===selection.taskId;})[0];
      if(!task || task.project_id!==projects[0].id || task.meeting_kind!=='requirement')throw new Error('该工作安排已不可读取，请核对保存结果。');
      global.ZHRichText.attach(task);await authorize(uid,selection,signal);
      return {target:selection,projects:projects,task:task,readAt:new Date().toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})};
    }
    var summaryMonth=months(selection).summary;
    var summaryRead=request('/api/monthly-summaries?month='+encodeURIComponent(summaryMonth),undefined,signal).then(function(rows){
      if(!Array.isArray(rows) || rows.some(function(row){return !row || row.month!==summaryMonth || !Array.isArray(row.items);}))throw new Error('月度汇总返回范围不完整，请重新读取。');
      return {rows:rows};
    }).catch(function(error){return {rows:[],error:error.message || '月度汇总读取失败，请重新读取。'};});
    var bundles=await Promise.all(projects.map(async function(project){
      var values=await Promise.all([
        select('reports',project.id,'id,project_id,period,line,author_id,author_name,submitted_at,updated_at,biz,coord_items,coord,change_text,dev_text,projection,impact,speed_items,effect_items,next_items,rich_text,report_scope_id,scope_project_ids',signal),
        select('milestones',project.id,'id,project_id,name,plan_date,forecast_date,is_key,discipline,biz_line,done,sort_order,rich_text',signal),
        select('project_drawings',project.id,'id,project_id,kind,name,path,url',signal),
        request('/api/monthly-plans/list',{project_id:project.id},signal),
        selection.type==='res' && selection.line?request('/api/project-people/list',{project_id:project.id},signal):[]
      ]);
      if(values.some(function(rows){return rows.length>=5000;}))throw new Error('记录较多，请按项目缩小投影范围后重试。');
      return {reports:values[0],nodes:values[1],drawings:values[2],plans:values[3],people:values[4]};
    }));
    var known=projects.map(function(project){return project.id;}),reports=bundles.flatMap(function(b){return b.reports;}).filter(function(report){
      return report.submitted_at && (selection.type==='res' || !selection.line || report.line===selection.line)
        && global.PlanningWindows.samePeriod(report.period,selection.period,report.submitted_at)
        && (!report.report_scope_id || (report.scope_project_ids || []).every(function(pid){return known.includes(pid);}));
    });
    var plans=selectedPlans(bundles.flatMap(function(bundle){return bundle.plans;}),known);
    reports.forEach(function(report){global.ZHRichText.attach(report);});
    if(selection.type==='res' && selection.line){
      if(!global.MonthlyPlans)throw new Error('专业展示组件读取失败，请重新打开投影。');
      reports=global.MonthlyPlans.residentialReports(reports,selection.line,bundles.flatMap(function(bundle){return bundle.people;}),plans);
    }
    var attachments=[];
    await Promise.all(reports.filter(function(report){return report.biz && Array.isArray(report.biz.attachments) && report.biz.attachments.length;}).map(async function(report){
      var files=await request('/api/report-attachments/list',{project_id:report.project_id,period:report.period,line:report.line,...(report.report_scope_id?{report_scope_id:report.report_scope_id}:{})},signal);
      files.filter(function(file){return report.biz.attachments.includes(file.id);}).forEach(function(file){if(!attachments.some(function(old){return old.id===file.id;}))attachments.push(file);});
    }));
    var summaries=await summaryRead;
    await authorize(uid,selection,signal);
    return {target:selection,projects:projects,reports:reports,plans:plans,monthlySummaries:summaries.rows,monthlySummaryError:summaries.error || '',nodes:bundles.flatMap(function(b){return b.nodes;}),drawings:bundles.flatMap(function(b){return b.drawings;}),attachments:attachments,readAt:new Date().toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})};
  }
  function rich(row,key,fallback){return global.ZHRichText.field(row,key,fallback || '');}
  function projectName(model,pid){var project=model.projects.find(function(p){return p.id===pid;});return project?project.name:pid;}
  function table(labels,rows,source,items){return rows.length?'<div class="meeting-table-scroll"><table'+(source?' class="meeting-plan-table"><caption>'+source+'</caption>':'>')+(items && global.MonthlySummaries?global.MonthlySummaries.contentColumns(items):'')+'<thead><tr>'+labels.map(function(label){return '<th scope="col">'+esc(label)+'</th>';}).join('')+'</tr></thead><tbody>'+rows.map(function(row){return '<tr>'+row.map(function(cell,i){return '<td data-label="'+esc(labels[i])+'">'+cell+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table></div>':'<p class="meeting-empty">所选范围暂无记录。</p>';}
  function section(key,title,content,selection){return selection.section!=='all' && selection.section!==key?'':'<section class="meeting-section" data-projection-section="'+key+'"><h2>'+esc(title)+'</h2>'+content+'</section>';}
  function fileLink(id,name){return '<a href="/api/report-attachments/'+id+'" target="_blank" rel="noopener noreferrer">'+esc(name)+'</a>';}
  function html(model){
    var selection=model.target,groupNames=[...new Set(model.projects.map(function(project){return String(project.display_group || '').trim();}))];
    var title=selection.kind!=='arrangement' && groupNames.length===1 && groupNames[0]?groupNames[0]:model.projects.map(function(project){return project.name;}).join('、');
    var planReports=model.reports || [],selectedStart=global.PlanningWindows.periodStart(selection.period),selectedMonths=months(selection),monthly=selection.section==='monthly';
    if(!monthly && !model.task && model.plans && model.plans.length){
      if(!global.MonthlyPlans)throw new Error('月计划展示组件读取失败，请重新打开投影。');
      var available=selectedPlans(model.plans,selection.projectIds),common={projectIds:selection.projectIds,line:selection.line,month:selectedStart.slice(0,7),
        includeUnsubmitted:selectedStart===global.PlanningWindows.periodStart(global.PlanningWindows.todayShanghai())};
      planReports=global.MonthlyPlans.projectReports(Object.assign({},common,{plans:available.filter(function(plan){return !plan.report_scope_id;}),reports:planReports}));
      var scopeIds=[...new Set(available.map(function(plan){return plan.report_scope_id;}).filter(Boolean))],seen=new Set();
      scopeIds.forEach(function(scopeId){
        var rows=global.MonthlyPlans.projectReports(Object.assign({},common,{scope_id:scopeId,
          plans:available.filter(function(plan){return plan.report_scope_id===scopeId;}),reports:(model.reports || []).filter(function(report){return report.report_scope_id===scopeId;})}));
        rows.filter(function(report){return report._monthly_preview;}).forEach(function(report){
          var key=scopeId+':'+(report.biz && report.biz.monthly_plan_id);
          if(!seen.has(key)){seen.add(key);planReports.push(report);}
        });
      });
    }
    var pendingPlans=planReports.filter(function(report){return report._monthly_preview;}).length;
    var summaryRows=global.MonthlySummaries?global.MonthlySummaries.select(model.monthlySummaries || [],{projectIds:selection.projectIds,month:selectedMonths.summary,line:selection.line}):[];
    var head='<header class="meeting-topic"><span class="meeting-eyebrow">'+esc(selection.kind==='arrangement'?'已保存工作安排':monthly?'月度会议':summaryRows.length?(model.reports.length?'周报与月度汇总':'月度完成情况'):pendingPlans?(model.reports.length?'周报与月计划':'已确认月计划'):'已提交周报')+'</span><h1>'+esc(title)+'</h1><p>'+(model.task?'保存时间：'+esc(model.task.updated_at?new Date(model.task.updated_at).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'未记录'):esc(monthly?monthLabel(selectedMonths.summary)+'总结 · '+monthLabel(selectedMonths.plan)+'计划':selection.period)+(selection.line?' · '+esc(selection.line==='__unassigned__'?'未归专业':selection.line):''))+'</p></header>';
    if(model.task){var task=model.task;return head+'<section class="meeting-section meeting-arrangement"><h2>'+esc(task.title || '领导工作安排')+'</h2><div class="meeting-arrangement-body">'+rich(task,'what')+'</div><dl><dt>提出领导</dt><dd>'+esc(task.proposer_name || '未记录')+'</dd><dt>责任人</dt><dd>'+esc(task.owner_name || '未记录')+'</dd><dt>完成时间</dt><dd>'+esc(task.due || '未设置')+'</dd></dl><p class="meeting-saved">已保存到系统，按原待办流程办理</p></section>';}
    var window=global.PlanningWindows.windowFor(global.PlanningWindows.periodStart(selection.period),'month'),nodes=[];
    model.projects.forEach(function(project){global.PlanningWindows.scopedMilestones(model.nodes,{projectId:project.id,commercial:selection.type==='com',bizLine:selection.line,discipline:selection.line,allScopes:!selection.line,keyOnly:false,includeUnassigned:!selection.line || selection.line==='__unassigned__',window:window}).forEach(function(node){
      nodes.push([esc(project.name)+'<small>'+esc(node.biz_line || node.discipline || '未分配')+'</small>',rich(node,'name'),esc(node.plan_date || '未设置'),esc(node.forecast_date || node.plan_date || '未设置')]);
    });});
    var plans=[],coords=[],followups=[],legacy=[],issues=[];
    planReports.forEach(function(report){
      function sourceFor(row){
        var line=report.line || '综合',refs=Array.isArray(report.biz && report.biz.monthly_plan_ids)?report.biz.monthly_plan_ids:[];
        var plan=row && row.monthly_plan_id && refs.includes(row.monthly_plan_id) && (model.plans || []).find(function(entry){
          return entry.id===row.monthly_plan_id && entry.report_scope_id===report.report_scope_id;
        });
        if(plan)line=plan.line;
        return esc(row && row.project_id?projectName(model,row.project_id):report.report_scope_id?'统一范围 · 未明确子项目':projectName(model,report.project_id))+'<small>'+esc(report.author_name || '未记录填报人')+' · '+esc(line)+'</small>';
      }
      var source=sourceFor(null),biz=report.biz || {};
      ['items','handover','followups'].forEach(function(key){if(Object.hasOwn(biz,key) && !Array.isArray(biz[key]))issues.push('部分已保存事项格式异常，请在原报告核对。');});
      var planGroups=[];
      (Array.isArray(biz.items)?biz.items:[]).forEach(function(row){
        var source=sourceFor(row)+(report._monthly_preview?'<small>已确认月计划 · 本周尚未提交</small>':''),group=planGroups[planGroups.length-1];
        if(!group || group.source!==source){group={source:source,rows:[],items:[]};planGroups.push(group);}
        group.items.push({mod:row.mod,name:row.name,due:row.due,progress:row.prog});
        group.rows.push([rich(row,'mod'),rich(row,'name'),esc(row.due || '未设置'),rich(row,'prog','未填写')+(row.blocker?'<p>遇到卡点：'+rich(row,'blocker')+'</p>':'')+(global.MonthlySummaries?global.MonthlySummaries.attentionHtml(row,{referenceDate:selectedStart}):'')]);
      });
      planGroups.forEach(function(group){plans.push(table(['模块','事项','完成时间','当周进展'],group.rows,group.source,group.items));});
      (Array.isArray(report.coord_items)?report.coord_items:[]).forEach(function(row){coords.push([sourceFor(row),esc(row.who || '未指定'),rich(row,'what'),esc(row.by || '未设置')]);});
      if((!Array.isArray(report.coord_items) || !report.coord_items.length) && report.coord && report.coord!=='无')coords.push([source,'未指定',rich(report,'coord'),'未设置']);
      (Array.isArray(biz.handover)?biz.handover:[]).forEach(function(row){coords.push([sourceFor(row),'移交给 '+esc(row.to || '未指定'),rich(row,'what'),esc(row.due || '未设置')]);});
      (Array.isArray(biz.followups)?biz.followups:[]).forEach(function(row){followups.push([sourceFor(row),esc(row.source_type==='leader'?'领导安排事项':row.source_type==='meeting'?'会议要求事项':'待回事宜'),rich(row,'what'),esc(row.due || '未设置')+(row.effective_due && row.effective_due!==row.due?'<small>执行期限 '+esc(row.effective_due)+'</small>':''),rich(row,'progress','未填写')+'<small>'+esc({open:'待处理',in_progress:'推进中',completed:'本人反馈完成（以审核为准）'}[row.status] || '未记录状态')+'</small>']);});
      var extra=['change_text','dev_text','projection','impact'].filter(function(key){return report[key];}).map(function(key){return '<p><b>'+esc({change_text:'本周实质变化',dev_text:'风险说明',projection:'影响与对策',impact:'影响'}[key])+'：</b>'+rich(report,key)+'</p>';}).join('');
      [['speed_items','提速对策','gain'],['effect_items','效果保障','target']].forEach(function(spec){var items=report[spec[0]];if(Array.isArray(items) && items.length)extra+='<h3>'+spec[1]+'</h3>'+items.map(function(row){return '<p>'+rich(row,'act')+' · '+rich(row,spec[2])+'</p>';}).join('');});
      if(Array.isArray(report.next_items) && report.next_items.length)extra+='<h3>下周必须完成</h3>'+report.next_items.map(function(text,index){return '<p>'+rich(report,'next_items.'+index,text)+'</p>';}).join('');
      if(extra)legacy.push('<details class="meeting-legacy"><summary>既有补充记录 · '+source+'</summary>'+extra+'</details>');
    });
    var media=model.drawings.filter(function(d){return String(d.kind || '').startsWith('项目总图');}).map(function(d){
      var url=/^https?:\/\//i.test(d.url || '')?d.url:/^drawings\/[A-Za-z0-9_./-]+$/.test(d.path || '') && !d.path.split('/').includes('..')?'/api/files/'+d.path:'';
      if(!url)return '';
      return '<figure><figcaption>'+esc(projectName(model,d.project_id)+' · '+(d.name || '项目总图'))+'</figcaption>'
        +(/\.(?:png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url)?'<img src="'+esc(url)+'" alt="'+esc(d.name || '项目总图')+'">':'<a target="_blank" rel="noopener noreferrer" href="'+esc(url)+'">打开总图资料</a>')+'</figure>';
    }).join('')+model.attachments.map(function(file){if(!/^[a-f0-9-]{36}$/i.test(file.id))return '';return '<figure><figcaption>'+fileLink(file.id,file.name || '报告附件')+'</figcaption>'+(file.inline && /^image\//.test(file.mime || '')?'<img src="/api/report-attachments/'+file.id+'" alt="'+esc(file.name)+'" loading="lazy">':'')+'</figure>';}).join('');
    var summaryContent=model.monthlySummaryError?'<p class="meeting-data-issue" role="alert">月度汇总读取失败：'+esc(model.monthlySummaryError)+'</p>'
      : global.MonthlySummaries?global.MonthlySummaries.html(model.monthlySummaries || [],{projectIds:selection.projectIds,projects:model.projects,month:selectedMonths.summary,line:selection.line,projection:true,referenceDate:selectedMonths.plan+'-01'})
      : (model.monthlySummaries || []).length?'<p class="meeting-data-issue" role="alert">月度汇总组件读取失败，请重新打开投影。</p>':'';
    if(monthly){
      var planIds=new Set(),confirmed=selectedPlans(model.plans || [],selection.projectIds).filter(function(plan){if(plan.id && planIds.has(plan.id))return false;if(plan.id)planIds.add(plan.id);return String(plan.plan_month || '').slice(0,7)===selectedMonths.plan && (!selection.line || plan.line===selection.line);}),monthlyPlans=[];
      confirmed.forEach(function(plan){
        var names=plan.report_scope_id?plan.scope_project_ids.map(function(pid){return projectName(model,pid);}).join('、'):projectName(model,plan.project_id);
        var items=Array.isArray(plan.items)?plan.items:[],groups=[];
        items.forEach(function(item,index){
          var source=esc(item.project_id?projectName(model,item.project_id):names)+'<small>'+esc(plan.owner_name || plan.confirmed_name || '未记录提报人')+' · '+esc(plan.line || '综合')+' · 已确认</small>',group=groups[groups.length-1];
          if(!group || group.source!==source){group={source:source,rows:[],items:[]};groups.push(group);}
          group.items.push({mod:item.mod,name:item.name,due:item.due,progress:item.prog});
          group.rows.push([rich(plan,'items.'+index+'.mod',item.mod),rich(plan,'items.'+index+'.name',item.name),esc(item.due || '未设置'),(item.prog?rich(plan,'items.'+index+'.prog'):'<span title="尚未填报进展" aria-label="尚未填报进展">—</span>')+(global.MonthlySummaries?global.MonthlySummaries.attentionHtml(item,{referenceDate:selectedMonths.plan+'-01'}):'')]);
        });
        groups.forEach(function(group){monthlyPlans.push(table(['模块','事项','完成时间','进展'],group.rows,group.source,group.items));});
      });
      return head+'<div class="meeting-month-grid"><section class="meeting-section" data-projection-section="monthly-summary"><h2>'+esc(monthLabel(selectedMonths.summary))+'工作总结</h2>'+summaryContent+'</section><section class="meeting-section" data-projection-section="monthly-plans"><h2>'+esc(monthLabel(selectedMonths.plan))+'工作计划</h2>'+(monthlyPlans.join('') || '<p class="meeting-empty">所选月份和专业暂无已确认月计划。</p>')+'</section></div>';
    }
    var hasSummaries=model.monthlySummaryError || summaryRows.length;
    var body=(nodes.length || selection.section!=='all'?section('nodes','一、核心节点',table(['实际项目／专业','节点','原计划完成日','预计完成日'],nodes),selection):'')
      +(plans.length || selection.section!=='all'?section('plans','二、当月计划',plans.join('') || '<p class="meeting-empty">所选范围暂无记录。</p>',selection):'')
      +(hasSummaries || selection.section==='summaries'?section('summaries','本月计划完成情况（月度汇总）',summaryContent,selection):'')
      +(coords.length || selection.section!=='all'?section('coord','三、需要协调',table(['来源','协调对象','事项','最晚时间'],coords),selection):'')
      +(followups.length || legacy.length || selection.section!=='all'?section('followups','四、待办反馈',(followups.length || !legacy.length?table(['来源','类别','事项','完成时间','反馈'],followups):'')+legacy.join(''),selection):'')
      +(media || selection.section!=='all'?section('media','项目总图与附件',media || '<p class="meeting-empty">所选范围暂无总图或报告附件。</p>',selection):'');
    return head+(issues.length?'<p class="meeting-data-issue" role="alert">'+esc(issues[0])+'</p>':'')+(body || '<p class="meeting-empty">所选范围暂无可展示内容。</p>');
  }
  global.MeetingView={sections:sections,target:target,authorize:authorize,read:read,html:html,esc:esc};
})(window);
