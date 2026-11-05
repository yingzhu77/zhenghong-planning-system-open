/* Project-scoped scheme knowledge. Source material lives in authenticated project data. */
(function (global) {
  'use strict';
  var ctx, identity, state = {query:'', group:'', audience:'', scope:'all', view:'overview', limit:40};
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function record(v) { return !!v && typeof v==='object' && !Array.isArray(v); }
  function pageNumber(v) { var n=typeof v==='number'?v:typeof v==='string' && /^[1-9][0-9]*$/.test(v)?Number(v):NaN;return Number.isSafeInteger(n) && n>0?n:null; }
  function textFields(v,keys) { return keys.every(function(k){return v[k]==null || typeof v[k]==='string';}); }
  function valid(c) {
    return !!(record(c) && c.version===1 && record(c.source) && typeof c.source.name==='string' && textFields(c.source,['url','sha256'])
      && textFields(c,['kind','scope','edition','summary','preview']) && (c.plan_page==null || pageNumber(c.plan_page)!==null)
      && Array.isArray(c.facts) && c.facts.every(function(f){return record(f) && typeof f.label==='string'
        && (f.value==null || typeof f.value==='string' || typeof f.value==='number' && Number.isFinite(f.value))
        && textFields(f,['unit','group','scope','note','status']) && (f.page==null || pageNumber(f.page)!==null)
        && (f.audiences==null || Array.isArray(f.audiences) && f.audiences.every(function(a){return typeof a==='string';}));})
      && Array.isArray(c.pages) && c.pages.every(function(p){return record(p) && pageNumber(p.page)!==null && textFields(p,['text']);})
      && (c.page_numbers==null || Array.isArray(c.page_numbers) && c.page_numbers.every(function(n){return Number.isSafeInteger(n) && n>0;}))
      && (c.issues==null || Array.isArray(c.issues) && c.issues.every(function(i){return record(i) && textFields(i,['title','detail'])
        && (i.pages==null || Array.isArray(i.pages) && i.pages.every(function(p){return pageNumber(p)!==null;}));})));
  }
  function catalogs(c) {
    var allowed=(c.projects || []).map(function(p){return p.id;});
    return (c.catalogs || [{project_id:c.pid,name:((c.projects || []).filter(function(p){return p.id===c.pid;})[0] || {}).name,catalog:c.fields && c.fields.scheme_catalog}])
      .filter(function(p){return allowed.indexOf(p.project_id)>=0 && valid(p.catalog);});
  }
  function safePreview(url,pid) {
    return typeof url==='string' && new RegExp('^/api/scheme-previews/'+String(pid).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9]{64}\\.webp$').test(url) ? url : '';
  }
  function pageCount(c) { return Number.isSafeInteger(c.page_count) && c.page_count>=0?c.page_count:Array.isArray(c.page_numbers)?c.page_numbers.length:c.pages.length; }
  function source(p,page) {
    var n=pageNumber(page),c=p.catalog,registered=n!==null && (Array.isArray(c.page_numbers)?c.page_numbers.includes(n):n<=pageCount(c) || c.pages.some(function(p){return pageNumber(p.page)===n;}));
    return registered?'<span class="pk-source">原文第 '+n+' 页</span>':'<span class="pk-muted">来源待登记</span>';
  }
  function normalize(v) { return String(v || '').toLowerCase().replace(/总建面/g,'总建筑面积').replace(/计容建面/g,'计容建筑面积').replace(/绿化率/g,'绿地率').replace(/\s+/g,' ').trim(); }
  function matches(text,q) { var hay=normalize(text);return normalize(q).split(' ').filter(Boolean).every(function(t){return hay.indexOf(t)>=0;}); }
  function amount(f) { return esc(f.value == null || f.value===''?'未载明':f.value)+'<small>'+esc(f.unit || '')+'</small>'; }
  function tag(f) { return f.status==='review'?'<span class="pk-tag pk-warning">待核对</span>':'<span class="pk-tag">方案摘录</span>'; }
  function groups(p) { return Array.from(new Set((p.catalog.facts || []).map(function(f){return f.group;}).filter(Boolean))); }
  function rows(p,facts) {
    return '<div class="pk-table-scroll"><table class="pk-fact-table"><thead><tr><th>资料项</th><th>方案数值 / 内容</th><th>适用口径与备注</th><th>来源</th></tr></thead><tbody>'+facts.map(function(f){
      return '<tr><th scope="row">'+esc(f.label)+'</th><td class="pk-fact-value">'+amount(f)+'</td><td><span class="pk-scope">'+esc(f.scope || p.catalog.scope || '本方案')+'</span>'+(f.note?'<p>'+esc(f.note)+'</p>':'')+(f.status==='review'?tag(f):'')+'</td><td>'+source(p,f.page)+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  }
  function issueCards(p) {
    var issues=p.catalog.issues || [];
    return issues.length?issues.map(function(i){return '<article class="pk-issue"><span class="pk-tag pk-warning">待核对</span><h3>'+esc(i.title)+'</h3><p>'+esc(i.detail)+'</p><div>'+((i.pages || []).map(function(n){return source(p,n);}).join(' · '))+'</div></article>';}).join(''):'<div class="pk-empty">当前摘录尚未标注差异项。这不代表方案已经审批或完成专业复核。</div>';
  }
  function overview(p) {
    var data=p.catalog,high=data.facts.filter(function(f){return f.highlight;}).slice(0,6),preview=safePreview(data.preview,p.project_id);
    var planImage=preview?'<figure class="pk-plan-preview"><img src="'+esc(preview)+'" alt="'+esc(p.name)+'总图关键区域" loading="lazy" onerror="ZHProjectKnowledge.previewFailed(this)"><p class="pk-preview-error" data-pk-preview-error role="status" hidden>关键总图暂无法读取，请刷新重试</p></figure>':'';
    return '<div class="pk-kpis">'+high.map(function(f){return '<article><span>'+esc(f.label)+'</span><strong>'+amount(f)+'</strong><div>'+source(p,f.page)+(f.status==='review'?' <span class="pk-dot-warning">待核对</span>':'')+'</div></article>';}).join('')+'</div>'
      +'<div class="pk-overview-grid"><section class="pk-panel pk-plan"><div class="pk-panel-heading"><h2>总图关键区域</h2>'+source(p,data.plan_page)+'</div>'+(planImage || '<div class="pk-empty">关键总图待整理</div>')+'</section>'
      +'<section class="pk-panel"><div class="pk-panel-heading"><h2>项目与方案</h2><span class="pk-tag">'+esc(data.kind || '建筑方案')+'</span></div><p class="pk-summary">'+esc(data.summary || '')+'</p><dl class="pk-details"><dt>方案范围</dt><dd>'+esc(data.scope || '以原文为准')+'</dd><dt>文本版本</dt><dd>'+esc(data.edition || '原文未明确标注日期')+'</dd><dt>来源文件</dt><dd>'+esc(data.source.name)+'</dd><dt>资料覆盖</dt><dd>'+data.facts.length+' 项关键摘录'+(pageCount(data)?' · 覆盖 '+pageCount(data)+' 页索引':'')+'</dd></dl><div class="pk-notice">方案数据用于查询参考。规划条件、设计值、报建版与使用版分别保留，不自动视为最终批复。</div>'
      +(data.issues && data.issues.length?'<button type="button" class="pk-review-link" onclick="ZHProjectKnowledge.set(\'view\',\'issues\')">查看 '+data.issues.length+' 项口径差异与待核对事项 →</button>':'')+'</section></div>'
      +'<section class="pk-panel"><div class="pk-panel-heading"><h2>按工作需要查资料</h2><span class="pk-muted">分类来自本项目方案内容</span></div><div class="pk-topic-grid">'+groups(p).map(function(g){var count=data.facts.filter(function(f){return f.group===g;}).length;return '<button type="button" onclick="ZHProjectKnowledge.topic(this.dataset.topic)" data-topic="'+esc(g)+'"><b>'+esc(g)+'</b><span>'+count+' 项摘录 <i>→</i></span></button>';}).join('')+'</div></section>';
  }
  function resultHtml() {
    var list=catalogs(ctx),p=list.filter(function(x){return x.project_id===ctx.pid;})[0];
    if(!p)return '<div class="pk-empty">当前项目尚未整理方案资料，可在原档案中查看已有内容。</div>';
    var filtering=!!(state.query || state.group || state.audience);
    if(!filtering && state.view==='overview')return overview(p);
    if(!filtering && state.view==='issues')return '<div class="pk-panel"><div class="pk-panel-heading"><h2>版本、范围与待核对</h2><span class="pk-muted">保留差异，不替原文做确定性判断</span></div>'+issueCards(p)+'</div>';
    if(!filtering && state.view==='facts')return groups(p).map(function(g){return '<section class="pk-panel"><div class="pk-panel-heading"><h2>'+esc(g)+'</h2><span class="pk-muted">'+esc(p.catalog.scope)+'</span></div>'+rows(p,p.catalog.facts.filter(function(f){return f.group===g;}))+'</section>';}).join('');
    var scope=state.scope==='all'?list:[p],hits=[];
    scope.forEach(function(project){
      project.catalog.facts.forEach(function(f){if((!state.group || state.group===f.group) && (!state.audience || (f.audiences || []).indexOf(state.audience)>=0) && matches([project.name,f.label,f.value,f.unit,f.group,f.scope,f.note].join(' '),state.query))hits.push({p:project,f:f});});
      if(state.query && !state.group && !state.audience){
        if(project.catalog.summary && matches([project.name,project.catalog.summary].join(' '),state.query))hits.push({p:project,summary:project.catalog.summary});
        (project.catalog.issues || []).forEach(function(issue){if(matches([project.name,issue.title,issue.detail].join(' '),state.query))hits.push({p:project,issue:issue});});
      }
    });
    var intro='<div class="pk-results-heading"><h2>关键摘录查询</h2><span>'+hits.length+' 项结果</span></div>';
    var results=hits.slice(0,state.limit).map(function(hit){
      var f=hit.f,project=hit.p,meta='<div class="pk-result-meta"><span>'+esc(project.name)+'</span>';
      if(f)return '<article class="pk-result">'+meta+'<span>'+esc(f.group)+'</span>'+tag(f)+'</div><h3>'+esc(f.label)+'<strong>'+amount(f)+'</strong></h3><p>'+esc(f.scope || project.catalog.scope)+(f.note?' · '+esc(f.note):'')+'</p>'+source(project,f.page)+'</article>';
      var issue=hit.issue;
      return '<article class="pk-result">'+meta+'<span class="pk-tag'+(issue?' pk-warning':'')+'">'+(issue?'版本与待核对':'方案概要')+'</span></div><h3>'+esc(issue?issue.title:'方案概要')+'</h3><p>'+esc(issue?issue.detail:hit.summary)+'</p>'+(issue?(issue.pages || []).map(function(page){return source(project,page);}).join(' · '):'')+'</article>';
    }).join('');
    return intro+(results || '<div class="pk-empty">没有找到匹配的关键摘录。可调整项目范围、主题或用途筛选；未检出不表示项目没有该项内容。</div>')+(hits.length>state.limit?'<button type="button" class="pk-more" onclick="ZHProjectKnowledge.more()">显示更多结果</button>':'');
  }
  function paint() { if(!global.document)return;var target=document.getElementById('pk-content');if(target)target.innerHTML=resultHtml();document.querySelectorAll('[data-pk-view]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-pk-view')===state.view);}); }
  function previewFailed(image) { image.hidden=true;image.parentElement.querySelector('[data-pk-preview-error]').hidden=false; }
  function set(key,value) { if(['query','group','audience','scope','view'].indexOf(key)<0 || key==='view' && ['overview','facts','issues'].indexOf(value)<0)return;state[key]=String(value);state.limit=40;if(key==='view'){state.query='';state.group='';state.audience='';var q=document.getElementById('pk-query');if(q)q.value='';['group','audience'].forEach(function(k){var el=document.getElementById('pk-'+k);if(el)el.value='';});}paint(); }
  function topic(value) { state.view='facts';state.scope='current';state.group=value;var select=document.getElementById('pk-group');if(select)select.value=value;var scope=document.getElementById('pk-scope');if(scope)scope.value='current';paint(); }
  function render(context) {
    ctx=context;var next=String(context.identity || '')+'|'+context.pid;
    if(identity!==next){identity=next;state={query:'',group:'',audience:'',scope:'all',view:'overview',limit:40};}
    var list=catalogs(ctx),p=list.filter(function(x){return x.project_id===ctx.pid;})[0];if(!p)return '';
    var allGroups=Array.from(new Set(list.flatMap(function(x){return groups(x);}))),audiences=Array.from(new Set(list.flatMap(function(x){return x.catalog.facts.flatMap(function(f){return f.audiences || [];});})));
    return '<div class="project-knowledge"><div class="pk-title"><div><span class="pk-eyebrow">PROJECT KNOWLEDGE · 项目资料</span><h1>方案资料中心</h1><p>查询关键指标、方案概要与专题摘录。</p></div><button type="button" class="btn ghost" onclick="App.reporterArchiveTab(\'basic\')">'+(ctx.editable?'原有档案维护':'原有档案')+' ↗</button></div>'
      +'<div class="pk-search-panel"><label for="pk-query">检索关键摘录</label><div class="pk-search-row"><span aria-hidden="true">⌕</span><input id="pk-query" type="search" value="'+esc(state.query)+'" placeholder="搜索总建面、停车位、养老设施或户型等关键摘录" oninput="ZHProjectKnowledge.set(\'query\',this.value)"><select id="pk-scope" aria-label="检索项目范围" onchange="ZHProjectKnowledge.set(\'scope\',this.value)"><option value="all"'+(state.scope==='all'?' selected':'')+'>所有有权项目</option><option value="current"'+(state.scope==='current'?' selected':'')+'>当前项目</option></select></div><div class="pk-filters"><label>资料主题<select id="pk-group" onchange="ZHProjectKnowledge.set(\'group\',this.value)"><option value="">全部主题</option>'+allGroups.map(function(g){return '<option'+(state.group===g?' selected':'')+'>'+esc(g)+'</option>';}).join('')+'</select></label><label>工作用途<select id="pk-audience" onchange="ZHProjectKnowledge.set(\'audience\',this.value)"><option value="">全部用途</option>'+audiences.map(function(a){return '<option'+(state.audience===a?' selected':'')+'>'+esc(a)+'</option>';}).join('')+'</select></label><span>摘录保留原方案物理页码</span></div></div>'
      +'<div class="pk-layout"><aside class="pk-projects"><div class="pk-sidebar-heading">项目 / 方案范围 <span>'+list.length+'</span></div><label class="pk-mobile-project">切换项目<select onchange="App.masterPick(this.value)">'+list.map(function(x){return '<option value="'+esc(x.project_id)+'"'+(x.project_id===ctx.pid?' selected':'')+'>'+esc(x.name)+'</option>';}).join('')+'</select></label><nav aria-label="方案项目">'+list.map(function(x,index){return '<button type="button" class="'+(x.project_id===ctx.pid?'on':'')+'" data-project="'+esc(x.project_id)+'" onclick="App.masterPick(this.dataset.project)"><span class="pk-project-number">'+String(index+1).padStart(2,'0')+'</span><span><b>'+esc(x.name)+'</b><small>'+x.catalog.facts.length+' 项关键摘录</small></span>'+(x.catalog.issues && x.catalog.issues.length?'<i title="包含待核对项"></i>':'')+'</button>';}).join('')+'</nav><div class="pk-sidebar-note">按原文件与实际方案范围分别整理。同名地块、不同阶段不直接合并。</div></aside><main class="pk-main"><div class="pk-current"><div><span class="pk-eyebrow">'+esc(p.catalog.kind || '建筑方案')+'</span><h2>'+esc(p.name)+'</h2></div><span class="pk-edition">'+esc(p.catalog.edition || '日期未注明')+'</span></div><nav class="pk-view-tabs" aria-label="方案资料视图">'+[['overview','项目速览'],['facts','指标与专题'],['issues','版本与待核对']].map(function(v){return '<button type="button" data-pk-view="'+v[0]+'" class="'+(state.view===v[0]?'on':'')+'" onclick="ZHProjectKnowledge.set(\'view\',\''+v[0]+'\')">'+v[1]+(v[0]==='issues' && (p.catalog.issues || []).length?'<span>'+p.catalog.issues.length+'</span>':'')+'</button>';}).join('')+'</nav><div id="pk-content">'+resultHtml()+'</div></main></div></div>';
  }
  global.ZHProjectKnowledge={render:render,set:set,topic:topic,home:function(){global.App.reporterArchiveTab('knowledge');},more:function(){state.limit+=40;paint();},valid:valid,searchMatches:matches,safePreview:safePreview,previewFailed:previewFailed};
})(window);
