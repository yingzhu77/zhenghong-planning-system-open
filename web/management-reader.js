/* All-project management reading uses a separate API and never seeds personal reporting state. */
(function(global){
  'use strict';
  var cfg,S,uid,session,activeRoute='',generation=0,catalog=[],pages=new Map();
  var VIEWS={managementCoord:'coordination',managementCompletion:'completions',managementMeetings:'meetings',managementArchive:'archive',managementLibrary:'projects'};
  var TITLES={managementCoord:'协调需求',managementCompletion:'完成与延期记录',managementMeetings:'会议事项',managementArchive:'全项目档案',managementLibrary:'全项目资料共享'};
  var STATUS={pending:'待审核',approved:'已通过',rejected:'已退回',reopened:'已重新打开',open:'待处理',in_progress:'推进中',completed:'本人反馈完成',done:'已完成',closed:'已关闭',cancelled:'已取消'};
  var SOURCE={independent_coordination:'独立协调',report_coord:'报告协调需求',report_handover:'工作面移交'};
  var MEETING={requirement:'会议要求事项',special:'专项会议决议事项',legacy:'原会议事项（待分类）'};
  function reset(){generation++;catalog=[];pages.clear();activeRoute='';}
  function configure(options){
    if(uid!==options.S.uid || session!==options.S.session)reset();
    cfg=options;S=options.S;uid=S.uid;session=S.session;
    if(activeRoute!==S.view){generation++;activeRoute=S.view;pages.forEach(function(p){p.revision++;p.busy=false;p.pending=null;});}
  }
  function allowed(){return !!(cfg && cfg.canRead && cfg.canRead());}
  function esc(v){return cfg.esc(v==null?'':v);}
  function page(route){if(!pages.has(route))pages.set(route,{project:'',tab:'plan',data:null,busy:false,pending:null,error:'',revision:0});return pages.get(route);}
  function projectId(route){return page(route).project || null;}
  function projects(){return catalog.slice();}
  function selectionRequired(route){return route==='managementArchive' || route==='managementLibrary';}
  async function load(route,options){
    options=options || {};
    if(!allowed() || !VIEWS[route] || S.view!==route)return false;
    var p=page(route),more=!!options.more;
    if(more && (!p.data || !p.data.has_more || !p.data.next_cursor))return false;
    if(p.busy)return p.pending;
    if(p.data && !options.force && !more)return true;
    var version=++p.revision,epoch=generation,identity=uid,login=session,selected=p.project;
    var request={view:VIEWS[route],limit:100};
    if(selected)request.project_id=selected;
    if(more)request.cursor=p.data.next_cursor;
    function live(){return generation===epoch && uid===identity && S.uid===identity && session===login && S.session===login && S.view===route && allowed() && p.revision===version && p.project===selected;}
    p.busy=true;p.error='';
    p.pending=(async function(){
      try{
        var result=await cfg.request('/api/management-read',request);
        if(!live())return false;
        if(!result || result.error)throw new Error(result && result.error && result.error.message || '只读资料读取失败，请重试。');
        var data=result.data;
        if(!data || !Array.isArray(data.projects) || !Array.isArray(data.rows))throw new Error('只读资料返回不完整，请刷新重试。');
        catalog=data.projects;
        if(selected && !catalog.some(function(project){return project.id===selected;}))throw new Error('所选项目已不在可查看范围内，请重新选择项目。');
        if(selectionRequired(route) && !selected)p.project=data.project_id || (catalog[0] && catalog[0].id) || '';
        p.data=Object.assign({},data,{rows:more?p.data.rows.concat(data.rows):data.rows});
        return true;
      }catch(error){if(live())p.error=error.message || '只读资料读取失败，请重试。';return false;}
      finally{if(p.revision===version){p.busy=false;p.pending=null;}}
    })();
    return p.pending;
  }
  async function project(value){
    var route=S.view;if(!allowed() || !VIEWS[route])return;
    if(value && !catalog.some(function(p){return p.id===value;}))return;
    if(!value && selectionRequired(route))return;
    var p=page(route);p.project=value;p.revision++;p.busy=false;p.pending=null;p.data=null;p.error='';
    var pending=load(route);cfg.render();await pending;if(S.view===route && allowed())cfg.render();
  }
  async function refresh(){if(!allowed() || !VIEWS[S.view])return;var route=S.view,pending=load(route,{force:true});cfg.render();await pending;if(S.view===route && allowed())cfg.render();}
  async function more(){if(!allowed() || !VIEWS[S.view])return;var route=S.view;var promise=load(route,{more:true});cfg.render();await promise;if(S.view===route && allowed())cfg.render();}
  function archiveTab(value){if(!allowed() || S.view!=='managementArchive' || !['plan','basic','planning','products','areas','units','standards'].includes(value))return;page(S.view).tab=value;cfg.render();}
  function rich(row,key,fallback){return cfg.richItem(row,key,fallback || '—');}
  function text(value){return value===null || value===undefined || value===''?'—':esc(value);}
  function timestamp(value){
    if(!value)return '';
    var parsed=new Date(value);if(!Number.isFinite(parsed.getTime()))return String(value);
    return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(parsed).replace(/\//g,'-');
  }
  function date(value){return text(timestamp(value));}
  function projectName(row){return row.project_name || ((catalog.filter(function(p){return p.id===row.project_id;})[0] || {}).name) || '未指定项目';}
  function meta(label,value){return '<div><dt>'+esc(label)+'</dt><dd>'+text(value)+'</dd></div>';}
  function richBlock(label,row,key){return '<section class="management-reader-text"><h4>'+esc(label)+'</h4><div>'+rich(row,key)+'</div></section>';}
  function history(rows){
    if(!Array.isArray(rows) || !rows.length)return '';
    return '<details class="management-reader-history"><summary>历史记录（'+rows.length+'）</summary>'+rows.map(function(entry){
      var row=entry.data && typeof entry.data==='object'?entry.data:entry;
      return '<article><b>'+text(STATUS[row.status] || '已保存记录')+'</b><span class="muted"> '+date(entry.at || row.created_at || row.reviewed_at || row.updated_at)+' · '+text(row.actor_name || row.reviewer_name || row.author_name || row.owner_name)+'</span>'
        +'<dl class="management-reader-meta">'+meta('原完成时间',row.due)+meta('原申报日期',row.completion_date)+meta('原申请延期至',row.requested_due)+'</dl>'
        +(row.what?richBlock('历史事项内容',row,'what'):'')+(row.note?richBlock('记录说明',row,'note'):'')+(row.review_note?richBlock('审核说明',row,'review_note'):'')+(row.completion_note?richBlock('申请说明',row,'completion_note'):'')+(row.progress?richBlock('进展',row,'progress'):'')+'</article>';
    }).join('')+'</details>';
  }
  function record(row,route){
    var completion=route==='managementCompletion',meeting=route==='managementMeetings',snapshot=completion?(row.source_snapshot || {}):row;
    var title=completion?(snapshot.title || snapshot.name || snapshot.what || row.title || row.what):row.title || row.what || row.name;
    var body='<article class="card management-reader-record"><div class="cardhd"><h3>'+text(title || '未命名事项')+'</h3><span class="chip">'+esc(projectName(row))+'</span></div>';
    if(completion){
      body+='<p class="management-reader-basis">申报时快照与已保存审核记录</p><dl class="management-reader-meta">'
        +meta('申请类型',row.request_type==='extension'?'延期申请':'完成申报')+meta('保存状态',STATUS[row.status] || row.status)
        +meta('申请人',row.requester_name || row.owner_name || row.author_name)+meta('提交时间（北京时间）',timestamp(row.submitted_at || row.created_at))
        +meta('申请完成日期',row.completion_date)+meta('申请延期至',row.requested_due)+meta('审核人',row.reviewer_name)+meta('审核时间（北京时间）',timestamp(row.reviewed_at))+'</dl>';
      var sourceField=snapshot.what?'what':snapshot.name?'name':snapshot.title?'title':null;
      if(sourceField)body+=richBlock('申报时事项内容',snapshot,sourceField);
      body+=richBlock(row.request_type==='extension'?'延期原因':'完成说明',row,'completion_note');
      if(row.review_note)body+=richBlock('已保存审核说明',row,'review_note');
    }else{
      body+='<dl class="management-reader-meta">'+meta('承办人',row.owner_name || row.assignee_name)+meta('提出人',row.proposer_name || row.author_name)
        +meta('完成时间',row.due)+meta(meeting?'会议类型':'来源',meeting?(MEETING[row.meeting_kind] || MEETING.legacy):(SOURCE[row.source_type] || '协调需求'))
        +meta(meeting?'状态':'报告周期',meeting?(STATUS[row.status] || row.status):row.period)+'</dl>';
      if(row.what)body+=richBlock('事项内容',row,'what');
      if(meeting)body+=richBlock('办理进展',row,'progress');
      else if(row.progress)body+=richBlock('办理进展',row,'progress');
    }
    return body+history(row.history || row.events || row.review_history)+'</article>';
  }
  function toolbar(route,p){
    return '<section class="card management-reader-toolbar"><div><h2>'+esc(TITLES[route])+'</h2><p class="muted">全部项目 · 只读查看</p></div><div class="management-reader-controls">'+(route==='managementArchive'?'':'<label>项目<select aria-label="只读查看项目" onchange="ManagementReader.project(this.value)">'
      +(!selectionRequired(route)?'<option value="">全部项目</option>':'')+catalog.map(function(row){return '<option value="'+esc(row.id)+'"'+(p.project===row.id?' selected':'')+'>'+esc(row.name)+(row.project_type==='com'?'（商业）':'（住宅）')+'</option>';}).join('')+'</select></label>'
      )+'<button class="btn ghost sm" type="button" onclick="ManagementReader.refresh()"'+(p.busy?' disabled':'')+'>刷新只读资料</button></div></section>';
  }
  function archive(p){
    if(!global.ZHReporterArchive)return '<div class="card empty">档案组件尚未加载，请刷新重试。</div>';
    var data=p.data.archive || {},pid=p.project,master=(data.project_master || []).filter(function(row){return row.project_id===pid;})[0];
    return global.ZHReporterArchive.render({projects:catalog,pid:pid,tab:p.tab,fields:master && master.fields || {},
      phases:(data.project_phases || []).filter(function(row){return row.project_id===pid;}),drawings:(data.project_drawings || []).filter(function(row){return row.project_id===pid;}),
      milestones:(data.milestones || []).filter(function(row){return row.project_id===pid;}),helpers:cfg.archiveHelpers})
      .replace(/App\.masterPick\(this\.value\)/g,'ManagementReader.project(this.value)').replace(/App\.reporterArchiveTab\(/g,'ManagementReader.archiveTab(');
  }
  function html(route){
    if(!allowed() || !VIEWS[route] || S.view!==route)return '<div class="card empty">没有管理查看权限。</div>';
    var p=page(route),body=toolbar(route,p);
    if(p.error)body+='<div class="notice err" role="alert">'+esc(p.error)+'</div>';
    if(p.busy)body+='<p class="muted" role="status">正在读取只读资料…</p>';
    if(p.data){
      if(route==='managementArchive')body+=p.project?archive(p):'<div class="card empty">没有可查看的项目。</div>';
      else if(route==='managementLibrary')body+=p.project && global.ProjectLibrary?global.ProjectLibrary.html(p.project):'<div class="card empty">没有可查看的项目资料。</div>';
      else body+=(route==='managementCoord'?'<p class="management-reader-basis">报告来源展示当前周的协调需求与工作面移交；独立协调展示已保存记录。未明确归属项目的记录仍标注“未指定项目”，并按报告候选项目范围参与筛选。</p>':route==='managementCompletion'?'<p class="management-reader-basis">以下为申报时事项快照和已保存的审核状态、说明及历史记录。</p>':'')
        +(p.data.rows.length?p.data.rows.map(function(row){return record(row,route);}).join(''):'<div class="card empty">当前范围暂无已保存记录。</div>')
        +(p.data.has_more?'<div class="management-reader-more"><button class="btn" type="button" onclick="ManagementReader.more()"'+(p.busy?' disabled':'')+'>加载更多记录</button></div>':'');
    }else if(!p.busy && !p.error)body+='<div class="card empty">尚未读取资料，请刷新。</div>';
    return '<div class="management-reader" data-management-view="'+esc(VIEWS[route])+'">'+body+'</div>';
  }
  global.ManagementReader={configure:configure,reset:reset,load:load,html:html,project:project,projectId:projectId,projects:projects,refresh:refresh,more:more,archiveTab:archiveTab};
})(window);
