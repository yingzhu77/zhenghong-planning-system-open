/* Administrator entry uses the reporter's canonical month plan, never their browser draft. */
(function (global) {
  'use strict';
  var cfg, S, uid, session, epoch = 0, revision = 0, catalog = {targets:[],plans:[]}, ready = false, pending = null;
  var type = 'res', month = '', project = '', line = '', owner = '', mode = 'excel', error = '', busy = false;
  var drafts = new Map(), importDrafts = new Map(), imported = null, importChoices = new Map(), editorContext = null, operation = null;
  var manualPage = 0, previewPage = 0, pageSize = 20;
  var aiStates = new Map(), aiOperation = null, advanced = false;
  var batchBase = '', batchMode = 'pair', monthBatches = new Map();
  var excelFiles = new Map(), savedDrafts = new Map(), savedSelections = new Map();
  var batchHistory = new Map();
  function configure(options) {
    if (uid !== options.S.uid || session !== options.S.session) {
      cancelAI('',true);aiStates.clear();
      uid = options.S.uid; session = options.S.session; epoch++; revision++;
      catalog = {targets:[],plans:[]}; ready = false; pending = null; drafts.clear(); importDrafts.clear(); imported = null; importChoices.clear();
      type = 'res'; month = ''; project = ''; line = ''; owner = ''; mode = 'excel'; error = ''; busy = false; editorContext = null; operation = null;advanced=false;
      manualPage=0;previewPage=0;batchBase='';batchMode='pair';monthBatches.clear();
      excelFiles.clear();savedDrafts.clear();savedSelections.clear();
      batchHistory.clear();
    }
    cfg = options; S = options.S;
    if(aiOperation && S.view!=='adminPlans')cancelAI('已离开导入页面，本次整理已取消，原预览保留。',true);
  }
  function allowed() { return !!(S && S.uid && S.profile && S.profile.role === 'ops' && S.profile.status === 'approved'); }
  function esc(value) { return cfg.esc(value == null ? '' : value); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function uuid() { return global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.floor(Math.random()*16);return (c==='x'?r:r&3|8).toString(16);}); }
  function targetKey(target) { return JSON.stringify([target.project_id,target.report_scope_id || '',target.line,target.owner_id]); }
  function projectKey(target) { return JSON.stringify([target.project_id,target.report_scope_id || '']); }
  function currentTargets() { return catalog.targets.filter(function(target){return projectKey(target) === project;}); }
  function unassignedProfessions() { return (catalog.project_professions || []).filter(function(entry){return projectKey(entry)===project && entry.assigned===false && typeof entry.line==='string' && entry.line && !currentTargets().some(function(target){return target.line===entry.line;});}); }
  function professionLabel(value) { return value+(unassignedProfessions().some(function(entry){return entry.line===value;})?'（未分配提报人）':''); }
  function professionLines() { return Array.from(new Set(currentTargets().map(function(target){return target.line;}).concat(unassignedProfessions().map(function(entry){return entry.line;})))); }
  function currentTarget() { return currentTargets().find(function(target){return target.line === line && target.owner_id === owner;}) || null; }
  function samePlan(plan,target) { return plan.project_id === target.project_id && (plan.report_scope_id || '') === (target.report_scope_id || '') && plan.line === target.line && (plan.owner_id || plan.confirmed_by) === target.owner_id && String(plan.plan_month).slice(0,7) === (target.month || String(target.plan_month || '').slice(0,7) || month); }
  function existing(target) { return (catalog.plans || []).find(function(plan){return samePlan(plan,target);}) || null; }
  function draftKey(target) { return JSON.stringify([month,targetKey(target)]); }
  function itemFromPlan(plan,item,index) {
    var row = copy(item);
    if(cfg.richCopy)cfg.richCopy(plan,row,{mod:'items.'+index+'.mod',name:'items.'+index+'.name'});
    return row;
  }
  function draft(target) {
    var key = draftKey(target);
    if(!drafts.has(key)) {
      var plan = existing(target);
      drafts.set(key,{items:plan?(plan.items || []).map(function(item,index){return itemFromPlan(plan,item,index);}):[{mod:'',name:'',due:''}],expected:plan?plan.id:null,dirty:false});
    }
    var entry=drafts.get(key),current=existing(target),currentId=current?current.id:null;
    if(!entry.dirty && entry.expected!==currentId){entry.items=current?(current.items || []).map(function(item,index){return itemFromPlan(current,item,index);}):[{mod:'',name:'',due:''}];entry.expected=currentId;}
    return entry;
  }
  function selectedEntry() { var target=currentTarget();return target?draft(target):null; }
  function editable(target) { var plan=existing(target);return !busy && (!plan || plan.editable === true); }
  function check(result,label) { if(!result || result.error)throw new Error(result && result.error && result.error.message || label);return result.data; }
  async function response(result,label) { var value=await result.json();if(!result.ok && !value.error)value.error={message:label+'（HTTP '+result.status+'）'};return check(value,label); }
  function flush() { if(cfg.flush)cfg.flush();capture(); }
  function contextKey() { return JSON.stringify([epoch,type,month,project,line,owner,mode]); }
  function baseImportKey() { return JSON.stringify([type,month,project]); }
  function excelFileKey() { return JSON.stringify([type,batchMode==='pair'?batchBase || month:month,project]); }
  function importKey() { return JSON.stringify([type,month,project,mode]); }
  function stashImport() { if(mode!=='manual' && imported)importDrafts.set(importKey(),{preview:imported,choices:importChoices,catalog:copy(catalog)}); }
  function restoreImport() { var saved=importDrafts.get(importKey());imported=saved?saved.preview:null;importChoices=saved?saved.choices:new Map(); }
  function nextMonth(value) { if(!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value || ''))return '';var date=new Date(value+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);return date.toISOString().slice(0,7); }
  function batchKey() { return JSON.stringify([type,project,batchBase || month]); }
  function currentBatch() { return mode==='excel' && batchMode==='pair'?monthBatches.get(batchKey()):null; }
  function forBatchMonth(value,fn) {
    var before={month:month,catalog:catalog,imported:imported,choices:importChoices};
    try{month=value;var saved=importDrafts.get(importKey());if(!saved)return fn(null);catalog=saved.catalog;imported=saved.preview;importChoices=saved.choices;return fn(saved);}
    finally{month=before.month;catalog=before.catalog;imported=before.imported;importChoices=before.choices;}
  }
  function batchOption(value,field,checked) { if(!allowed() || busy)return;var batch=currentBatch();if(!batch || !batch.options[value] || !['plans','summary'].includes(field))return;flush();batch.options[value][field]=!!checked;operation=null;render(); }
  async function batchMonth(value) {
    var batch=currentBatch();if(!allowed() || busy || !batch || !batch.months.includes(value))return;flush();stashImport();month=value;ready=false;editorContext=null;previewPage=0;error='';var loaded=await load(null,true);restoreImport();render();return loaded;
  }
  function batchRange(value) { if(!allowed() || busy || !['pair','single'].includes(value))return;flush();stashImport();batchMode=value;if(value==='single')batchBase=month;operation=null;render(); }
  function aiState() {
    var key=baseImportKey();if(!aiStates.has(key))aiStates.set(key,{messages:[],input:'',error:'',conversation_id:'',revision:0,can_confirm:false,complete:false,serverBusy:false,coverage:[],unprocessed_rows:[],pendingPage:0,questions:[],unverified_regions:[],regions:new Set(),history:[],manualDirty:false,selectedFile:null,uploadFailed:false,ai_status:'',ai_error:null,filterLine:'',onlyPending:false,assignmentChoices:new Map()});
    return aiStates.get(key);
  }
  function cancelAI(message,silent) {
    if(aiOperation){aiOperation.controller.abort();stopClock(aiOperation);aiOperation.state.error=message || '已取消本次整理，当前预览与输入已保留。';if(aiOperation.kind!=='upload'){aiOperation.state.requiresSync=true;aiOperation.state.can_confirm=false;}aiOperation=null;busy=false;}
    if(!silent)render();
  }
  function render() {
    if(!allowed() || S.view!=='adminPlans')return;
    var old=global.document && global.document.getElementById('admin-plan-ai-log'),scroll=old?old.scrollTop:0,activeInput=global.document && global.document.activeElement && global.document.activeElement.id==='admin-plan-ai-input';
    cfg.render();
    var log=global.document && global.document.getElementById('admin-plan-ai-log');if(log){log.scrollTop=aiState().toBottom?log.scrollHeight:scroll;aiState().toBottom=false;}
    if(activeInput){var input=global.document.getElementById('admin-plan-ai-input');if(input && input.focus)input.focus({preventScroll:true});}
    updateClock();
  }
  function elapsedLabel() { var seconds=aiOperation?Math.max(0,Math.floor((Date.now()-aiOperation.startedAt)/1000)):0;return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒'; }
  function updateClock() { if(!aiOperation || !global.document)return;var timer=global.document.getElementById('admin-plan-ai-elapsed');if(timer)timer.textContent=elapsedLabel(); }
  function stopClock(op) { if(op && op.timer && global.clearInterval){global.clearInterval(op.timer);op.timer=null;} }
  function normalizeSelection(seed) {
    if(seed && seed.project_id) {
      var matched=catalog.targets.find(function(target){return target.project_id===seed.project_id;});
      project=matched?projectKey(matched):'';
    }
    if(!catalog.targets.some(function(target){return projectKey(target)===project;}))project='';
    if(seed && typeof seed.line==='string')line=seed.line;
    if(professionLines().indexOf(line)<0)line='';
    if(!currentTargets().some(function(target){return target.line===line && target.owner_id===owner;}))owner='';
  }
  async function load(seed,force) {
    if(!allowed())return false;
    flush();
    if(seed) {
      cancelAI('范围已切换，本次整理已取消，原预览保留。',true);
      stashImport();
      var nextType=seed.type==='com'?'com':'res',nextMonth=/^\d{4}-(0[1-9]|1[0-2])$/.test(seed.month || '')?seed.month:month;
      if(type!==nextType || month!==nextMonth){ready=false;imported=null;importChoices=new Map();}
      type=nextType;month=nextMonth;project='';line='';owner='';
      batchBase=month;
      if(['ai','manual','excel','saved','history'].includes(seed.mode))mode=seed.mode;
    }
    if(!month)month=global.PlanningWindows?global.PlanningWindows.todayShanghai().slice(0,7):new Date().toISOString().slice(0,7);
    if(!batchBase)batchBase=month;
    if(ready && !force){normalizeSelection(seed);if(seed)restoreImport();return true;}
    if(pending && !force)return pending;
    var generation=epoch,requestRevision=++revision,active=cfg,requestedType=type,requestedMonth=month;
    function live(){return generation===epoch && requestRevision===revision && allowed() && type===requestedType && month===requestedMonth;}
    error='';
    var task=(async function(){
      try {
        var result=await global.fetch('/api/admin-plans/context?project_type='+encodeURIComponent(type)+'&month='+encodeURIComponent(month),{credentials:'same-origin'});
        var data=await response(result,'计划归属读取失败，请重试');
        if(!live())return false;
        if(!data || !Array.isArray(data.targets) || !Array.isArray(data.plans))throw new Error('计划归属读取结果不完整，请重试');
        catalog=data;ready=true;normalizeSelection(seed);if(seed)restoreImport();return true;
      } catch(cause){if(live())error=cause.message || '计划归属读取失败，请重试';return false;}
      finally{if(live()){pending=null;if(active===cfg)render();}}
    })();
    pending=task;return task;
  }
  function capture() {
    if(!allowed() || !global.document || !editorContext || editorContext.key!==contextKey())return;
    var rows=editorContext.rows;
    rows.forEach(function(row,index){['mod','name','due','progress'].forEach(function(field){
      var input=global.document.getElementById('admin_plan_'+field+'_'+index);
      if(input && row[field]!==input.value){row[field]=String(input.value || '');if(editorContext.entry)editorContext.entry.dirty=true;else markAIChange(row,[field]);}
    });});
  }
  function binding(id) {
    var match=/^admin_plan_(mod|name)_(\d+)$/.exec(id),context=editorContext;
    if(!match || !context || context.key!==contextKey() || !allowed() || busy)return null;
    var field=match[1],row=context.rows[Number(match[2])];
    if(!row || mode==='manual' && !editable(currentTarget()) || mode==='saved' && savedLock(savedEntry()))return null;
    return {get:function(){return global.ZHRichText && global.ZHRichText.doc(row,field);},set:function(doc){
      if(context!==editorContext || context.key!==contextKey() || !allowed() || busy || mode==='manual' && !editable(currentTarget()) || mode==='saved' && savedLock(savedEntry()))return;
      row[field]=global.ZHRichText.text(doc);row._rich=row._rich || {};row._rich[field]=doc;if(context.entry)context.entry.dirty=true;else markAIChange(row,[field]);
    }};
  }
  async function select(field,value) {
    if(!allowed() || busy && !aiOperation)return;
    if(aiOperation)cancelAI('范围已切换，本次整理已取消，原预览与输入保留。',true);
    flush();error='';operation=null;
    var waitingState=field==='project' && !project && mode==='ai'?aiState():null;
    var waitingFile=field==='project' && !project?(mode==='excel'?excelFiles.get(excelFileKey()):waitingState && waitingState.selectedFile):null,waitingKey=excelFileKey();
    manualPage=0;
    if(['type','month','project','mode'].includes(field))stashImport();
    if(field==='type'){type=value==='com'?'com':'res';project='';line='';owner='';imported=null;ready=false;await load(null,true);}
    else if(field==='month'){
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value || ''))return;
      month=value;batchBase=value;imported=null;ready=false;await load(null,true);
    }
    else if(field==='project'){project=value;line='';owner='';imported=null;importChoices=new Map();}
    else if(field==='line'){line=value;owner='';}
    else if(field==='owner')owner=value;
    else if(field==='mode')mode=['manual','excel','saved','history'].includes(value)?value:'ai';
    if(waitingFile && project){if(mode==='excel'){excelFiles.delete(waitingKey);excelFiles.set(excelFileKey(),waitingFile);}else{waitingState.selectedFile=null;aiState().selectedFile=waitingFile;}}
    if(['type','month','project','mode'].includes(field) && mode!=='manual')restoreImport();
    editorContext=null;render();
    if(mode==='history')await loadBatches();
  }
  function edit(index,field,value) {
    if(!allowed() || busy || !['mod','name','due','progress'].includes(field) || field==='progress' && mode!=='excel' && !(mode==='saved' && savedEntry() && savedEntry().kind==='summary'))return;
    var entry=mode==='saved'?savedEntry():null,rows=mode==='saved'?entry && entry.items:mode!=='manual' && imported?imported.rows:selectedEntry() && selectedEntry().items;
    if(mode==='saved' && savedLock(entry))return;
    if(mode==='manual' && !editable(currentTarget()))return;
    if(rows && rows[index]){rows[index][field]=String(value || '');if(entry)entry.dirty=true;else if(mode==='manual')selectedEntry().dirty=true;else markAIChange(rows[index],[field]);operation=null;}
  }
  function markAIChange(row,fields) { if(mode!=='ai')return;aiState().manualDirty=true;row._changes=row._changes || {};fields.forEach(function(field){row._changes[field]=true;}); }
  function add() { var target=currentTarget();if(!target || !editable(target))return;flush();draft(target).items.push({mod:'',name:'',due:''});draft(target).dirty=true;manualPage=Math.floor((draft(target).items.length-1)/pageSize);render(); }
  function remove(index) { var target=currentTarget();if(!target || !editable(target))return;flush();draft(target).items.splice(index,1);draft(target).dirty=true;operation=null;render(); }
  function latest() {
    var target=currentTarget();if(!target || busy)return;flush();var entry=draft(target),plan=existing(target);
    entry.recovery=copy(entry.items);entry.items=plan?(plan.items || []).map(function(item,index){return itemFromPlan(plan,item,index);}):[{mod:'',name:'',due:''}];
    entry.expected=plan?plan.id:null;entry.dirty=false;operation=null;render();
  }
  function setMapping(index,value) {
    if(!allowed() || busy || !imported || !imported.rows[index])return;
    flush();var target=currentTargets().find(function(row){return targetKey(row)===value;});
    imported.rows[index].target_key=target?value:'';if(mode==='excel')imported.rows[index].profession_suggestion=null;markAIChange(imported.rows[index],['owner_id','line']);operation=null;render();
  }
  function hintKey(row) { return row.assigned_line || row.line_hint || '未识别专业'; }
  function mapGroup(index,value) {
    if(!allowed() || busy || !imported)return;
    flush();var hints=hintGroups(),group=hints[index],target=currentTargets().find(function(row){return targetKey(row)===value;});
    if(!group || !target)return;
    imported.rows.forEach(function(row){if(hintKey(row)===group.key){row.target_key=value;if(mode==='excel')row.profession_suggestion=null;markAIChange(row,['owner_id','line']);}});operation=null;render();
  }
  function include(index,value) { if(!allowed() || busy || !imported || !imported.rows[index])return;flush();imported.rows[index].included=!!value;markAIChange(imported.rows[index],['included']);operation=null;render(); }
  function choice(key,value) { if(!allowed() || busy)return;flush();if(['append','replace'].includes(value))importChoices.set(key,value);else importChoices.delete(key);operation=null;render(); }
  function nameWithStandard(row) {
    var name=String(row.name || ''),standard=String(row.standard || '').trim(),doc=row.name_doc;
    if(standard && !name.includes('\n完成标准：'+standard)){name+='\n完成标准：'+standard;if(doc && Array.isArray(doc.ops))doc={ops:doc.ops.concat([{insert:'\n完成标准：'+standard}])};}
    if(row.due_note && !name.includes('\n原表完成时间：'+row.due_note)){name+='\n原表完成时间：'+row.due_note;if(doc && Array.isArray(doc.ops))doc={ops:doc.ops.concat([{insert:'\n原表完成时间：'+row.due_note}])};}
    var result={mod:row.mod || '',name:name,due:row.due || '',_rich:{}};
    if(row.mod_doc)result._rich.mod=row.mod_doc;
    if(doc)result._rich.name=doc;
    return result;
  }
  function adoptPreview(data,fileName) {
    var scope=currentTargets()[0];if(!scope || !data || !Array.isArray(data.rows))throw new Error('导入预览结果不完整，请重试');
    if(Array.isArray(data.targets))catalog.targets=catalog.targets.filter(function(target){return projectKey(target)!==project;}).concat(data.targets);
    if(Array.isArray(data.project_professions))catalog.project_professions=(catalog.project_professions || []).filter(function(entry){return projectKey(entry)!==project;}).concat(data.project_professions.filter(function(entry){return projectKey(entry)===project;}));
    if(Array.isArray(data.plans))catalog.plans=catalog.plans.filter(function(plan){return !sameProject(plan,scope);}).concat(data.plans);
    imported={file_name:fileName,warnings:data.warnings || [],sheets:data.sheets || [],rows:data.rows.map(function(row){
      var mapped=nameWithStandard(row),target=row.owner_id && row.line && currentTargets().find(function(entry){return entry.owner_id===row.owner_id && entry.line===row.line;});
      var refs=Array.isArray(row.source_refs)?row.source_refs:Object.values(row.source_refs || {}).flat().filter(Boolean);
      var progress=String(row.progress || ''),actualDate=row.actual_due || row.actual_due_note;if(actualDate)progress+=(progress?'\n':'')+'原表实际完成时间：'+actualDate;
      return Object.assign(mapped,{progress:progress,id:row.id || '',region_id:row.region_id || '',source:row.source || refs[0] || {},source_refs:refs,reporter_hint:row.reporter_hint || '',line_hint:row.line_hint || row.line || '',assigned_line:row.line || '',match_basis:row.match_basis || '',profession_mapping:row.profession_mapping || null,profession_suggestion:row.profession_suggestion || null,warnings:row.warnings || [],target_key:target?targetKey(target):'',included:row.included!==false,exclusion_reason:row.exclusion_reason || '',manual_fields:row.manual_fields || []});
    })};importDrafts.delete(importKey());operation=null;previewPage=0;
    if(Array.isArray(data.summaries))catalog.summaries=data.summaries;
  }
  function adoptMonthBundle(data,fileName) {
    var active=month,initial=copy(catalog),batch={months:data.batches.map(function(value){return value.month;}),options:{},file_name:fileName,unassigned:data.unassigned_regions || [],saved:false};
    for(var parsed of data.batches){month=parsed.month;catalog=copy(initial);adoptPreview(parsed,fileName);importChoices=new Map();stashImport();batch.options[month]={plans:month!==batchBase && !!parsed.rows.length,summary:month===batchBase && !!parsed.rows.length};}
    month=active;monthBatches.set(batchKey(),batch);var saved=importDrafts.get(importKey());catalog=saved?saved.catalog:initial;restoreImport();
  }
  function archivePreview(state,label) {
    if(imported){state.history.unshift({label:label,preview:copy(imported)});state.history=state.history.slice(0,4);}
  }
  function adoptAI(data,state,label) {
    if(!data || typeof data.conversation_id!=='string' || !Number.isInteger(data.revision) || !Array.isArray(data.rows))throw new Error('AI 返回的预览不完整，当前输入已保留，请重试。');
    archivePreview(state,label || '更新前的导入预览');
    var fileName=data.source && (data.source.name || data.source.file_name) || imported && imported.file_name || state.file_name || '整项目月计划';
    adoptPreview(data,fileName);state.file_name=fileName;state.conversation_id=data.conversation_id;state.revision=data.revision;
    state.complete=data.complete===true;state.serverBusy=data.busy===true;state.coverage=Array.isArray(data.coverage)?data.coverage:[];state.unprocessed_rows=Array.isArray(data.unprocessed_rows)?data.unprocessed_rows:[];state.pendingPage=0;
    state.can_confirm=data.can_confirm===true && state.complete && !state.serverBusy && !state.unprocessed_rows.length;state.questions=Array.isArray(data.questions)?data.questions:[];state.unverified_regions=Array.isArray(data.unverified_regions)?data.unverified_regions:[];
    state.regions.clear();state.manualDirty=false;state.requiresSync=false;state.error='';state.saved=data.confirmed===true;state.savedCount=state.saved && data.result && Array.isArray(data.result.plans)?data.result.plans.length:0;state.toBottom=true;
    state.ai_status=data.ai_status || 'ready';state.ai_error=data.ai_error || null;state.withdrawn=false;
    if(state.saved && data.result && Array.isArray(data.result.plans)){mergeSaved(data.result.plans);state.savedOperation=data.result.operation_id;}
    if(data.reply)state.messages.push({role:'assistant',content:String(data.reply)});
    state.messages=state.messages.slice(-40);
  }
  async function aiRun(kind,makeRequest,label) {
    if(!allowed() || busy || mode!=='ai' || !project)return false;
    flush();var state=aiState(),op={state:state,controller:new global.AbortController(),epoch:epoch,key:contextKey(),baseKey:baseImportKey(),kind:kind,startedAt:Date.now()};
    aiOperation=op;busy=true;state.error='';error='';state.toBottom=true;render();
    if(global.setInterval)op.timer=global.setInterval(updateClock,1000);
    function live(){return aiOperation===op && op.epoch===epoch && op.key===contextKey() && allowed() && S.view==='adminPlans' && aiStates.get(op.baseKey)===state;}
    try{
      var result=await makeRequest(op.controller.signal),data=await response(result,'AI 整理失败，请重试');
      if(!live() || op.controller.signal.aborted)return false;
      adoptAI(data,state,label);if(kind==='upload'){importChoices=new Map();state.uploadFailed=false;}return true;
    }catch(cause){if(live()){state.error=op.controller.signal.aborted?'本次整理已取消，当前预览与输入保留。':cause.message || 'AI 整理失败，当前预览与输入保留。';if(kind!=='upload'){state.requiresSync=true;state.can_confirm=false;}else state.uploadFailed=true;}return false;}
    finally{stopClock(op);if(aiOperation===op){aiOperation=null;busy=false;render();}}
  }
  function aiJSON(path,body,signal) { return global.fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal}); }
  async function uploadAI(file) {
    var scope=currentTargets()[0],state=aiState(),previous=state.conversation_id,generation=epoch,key=contextKey();if(!scope)return false;
    state.messages.push({role:'user',content:'请识别整份 Excel 的 '+month+' 月计划，按所有专业和已授权提报人分配。',file_name:file.name});state.file_name=file.name;
    var query='project_id='+encodeURIComponent(scope.project_id)+'&month='+encodeURIComponent(month)+'&name='+encodeURIComponent(file.name)+(scope.report_scope_id?'&report_scope_id='+encodeURIComponent(scope.report_scope_id):'');
    var ok=await aiRun('upload',function(signal){return global.fetch('/api/admin-plans/ai/upload?'+query,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},body:file,signal:signal});},'上传新文件前的原预览');
    if(ok && generation===epoch && key===contextKey()){
      if(previous && previous!==state.conversation_id){try{await response(await aiJSON('/api/admin-plans/ai/close',{conversation_id:previous}),'旧 AI 对话暂未结束');}catch(cause){if(generation===epoch && key===contextKey()){state.error='新预览已生成，旧 AI 对话暂未结束；原预览副本仍保留。';render();}}}
      if(generation===epoch && key===contextKey())cfg.toast(state.ai_status==='needs_retry'?'已保留原表解析预览，AI 整理暂未完成，可继续重试。':'AI 已生成整项目预览，尚未写入任何计划。',state.ai_status==='needs_retry'?'warn':'success');
    }return ok;
  }
  async function startAI() {
    if(!allowed() || busy || mode!=='ai' || !project)return false;var state=aiState();
    if(!state.selectedFile){state.error='请先选择 .xlsx 文件，再开始识别。';render();return false;}
    if(imported && !state.saved && !global.confirm('重新识别所选文件？当前预览与手动纠正会保留为只读副本。'))return false;
    return uploadAI(state.selectedFile);
  }
  async function sendAI(suggestion) {
    if(!allowed() || busy || mode!=='ai')return false;flush();var state=aiState(),text=typeof suggestion==='string'?suggestion:state.input.trim();
    if(!text)return false;
    if(!state.conversation_id){state.error='请先选择项目和月份，上传整份 Excel 后再继续澄清。';render();return false;}
    if(state.saved){state.error='本次导入已完成，请上传新文件开始下一次识别。';render();return false;}
    if(state.requiresSync){state.error='上次整理结果尚未同步，请先点击“重读 AI 预览”；当前输入会保留。';render();return false;}
    if(state.serverBusy){state.error='上次整理仍在处理中，请稍后重新读取 AI 预览。';render();return false;}
    if(state.manualDirty){state.error='手动纠正尚未应用，请先应用纠正，当前输入会保留。';render();return false;}
    if(text.length>6000){state.error='本次补充请控制在 6000 字以内。';render();return false;}
    state.messages.push({role:'user',content:text});
    var ok=await aiRun('chat',function(signal){return aiJSON('/api/admin-plans/ai/chat',{conversation_id:state.conversation_id,expected_revision:state.revision,messages:[{role:'user',content:text}]},signal);},'本轮对话修改前的原预览');
    if(ok && typeof suggestion!=='string' && state.input.trim()===text){state.input='';render();}return ok;
  }
  function aiInput(value) { if(allowed())aiState().input=String(value || ''); }
  function aiKey(event) { if(event.key==='Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing){event.preventDefault();sendAI();} }
  function toggleAdvanced() { if(busy)return;flush();advanced=!advanced;render(); }
  function selectRegion(id,value) { if(!allowed() || busy)return;var state=aiState();if(!state.unverified_regions.some(function(region){return region.id===id;}))return;state.regionOpen=true;if(value)state.regions.add(id);else state.regions.delete(id);render(); }
  function revisions() {
    return (imported && imported.rows || []).filter(function(row){return row._changes && Object.keys(row._changes).length;}).map(function(row){var target=targetForRow(row),change={id:row.id};
      Object.keys(row._changes).forEach(function(field){if(field==='owner_id')change.owner_id=target?target.owner_id:null;else if(field==='line')change.line=target?target.line:row.assigned_line || null;else change[field]=row[field] || (field==='included'?false:'');
        if(global.ZHRichText && ['mod','name'].includes(field))change[field+'_doc']=global.ZHRichText.doc(row,field);});return change;});
  }
  async function reviseAI(regionsOnly) {
    if(!allowed() || busy || !imported || mode!=='ai')return false;flush();var state=aiState();
    if(!state.conversation_id)return false;
    if(state.saved || state.requiresSync){state.error=state.saved?'本次导入已完成，请上传新文件开始下一次识别。':'请先重新读取 AI 预览，当前手动纠正会保留为副本。';render();return false;}
    if(state.serverBusy){state.error='上次整理仍在处理中，请稍后重新读取 AI 预览。';render();return false;}
    if(regionsOnly && state.manualDirty){state.error='请先应用手动纠正，或点击“应用手动纠正”同时提交已勾选的月份范围。';render();return false;}
    var regions=state.unverified_regions.filter(function(region){return state.regions.has(region.id);}).map(function(region){return {region_id:region.id,month:month};});
    if(regionsOnly && !regions.length){state.error='请先勾选已经核对过的月份范围。';render();return false;}
    return aiRun('revise',function(signal){return aiJSON('/api/admin-plans/ai/revise',{conversation_id:state.conversation_id,expected_revision:state.revision,changes:regionsOnly?[]:revisions(),region_confirmations:regions},signal);},'手动纠正前的原预览');
  }
  async function syncAI() {
    if(!allowed() || busy || mode!=='ai')return false;var state=aiState();if(!state.conversation_id)return false;
    if(state.manualDirty && !global.confirm('重新读取 AI 预览？当前手动纠正会保留为只读副本。'))return false;
    return aiRun('sync',function(signal){return aiJSON('/api/admin-plans/ai/session',{conversation_id:state.conversation_id},signal);},'重新读取前的本机预览');
  }
  function continueAI() { if(!allowed() || busy)return;aiState().coverageOpen=true;aiState().input='请继续逐行核对尚未处理的源行：属于目标月份的计划请识别并匹配提报人；标题、说明等请明确说明排除原因。不要省略。';return sendAI(); }
  function pendingPage(delta) { if(!allowed() || busy)return;flush();var state=aiState();state.coverageOpen=true;state.pendingPage=Math.max(0,Math.min(Math.max(0,Math.ceil(state.unprocessed_rows.length/pageSize)-1),state.pendingPage+delta));render(); }
  async function upload(input) {
    if(!allowed() || busy)return;
    var file=input && input.files && input.files[0],scope=currentTargets()[0];
    if(!file)return;
    if(!/\.xlsx$/i.test(file.name || '')){error='请选择 .xlsx 格式的 Excel 文件。';render();return;}
    if(file.size>300*1024*1024){error='Excel 文件不能超过 300 MB。';render();return;}
    flush();
    if(mode==='excel')excelFiles.set(excelFileKey(),file);
    else if(mode==='ai')aiState().selectedFile=file;
    else return;
    if(!scope){error=project?'该项目目前没有可导入的已授权提报人，请重新选择项目。':'';render();return true;}
    if(mode==='ai'){flush();aiState().selectedFile=file;aiState().uploadFailed=false;aiState().error='';error='';render();return true;}
    if(imported && !global.confirm('当前 Excel 预览尚未保存，是否用新文件替换本次预览？原预览会保留为只读副本。'))return;
    flush();var generation=epoch,key=contextKey();busy=true;error='';render();
    try {
      var query='project_id='+encodeURIComponent(scope.project_id)+'&month='+encodeURIComponent(batchMode==='pair'?(batchBase || month):month)+(scope.report_scope_id?'&report_scope_id='+encodeURIComponent(scope.report_scope_id):'')+(batchMode==='pair'?'&include_next=1':'');
      var result=await global.fetch('/api/admin-plans/import?'+query,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},body:file});
      var data=await response(result,'Excel 解析失败，请检查文件后重试');
      if(generation!==epoch || key!==contextKey() || !allowed())return;
      if(Array.isArray(data.batches))adoptMonthBundle(data,file.name);else{monthBatches.delete(batchKey());adoptPreview(data,file.name);importChoices=new Map();}
      cfg.toast('Excel 已生成预览，尚未写入计划。','success');
    }catch(cause){if(generation===epoch && key===contextKey())error=cause.message || 'Excel 解析失败，请重试';}
    finally{if(generation===epoch){busy=false;render();}}
  }
  function startExcel() { if(!allowed() || busy || mode!=='excel')return false;var file=excelFiles.get(excelFileKey());return file?upload({files:[file]}):false; }
  function sameProject(plan,target) { return plan.project_id===target.project_id && (plan.report_scope_id || '')===(target.report_scope_id || '') && String(plan.plan_month).slice(0,7)===month; }
  function targetForRow(row) { return currentTargets().find(function(target){return targetKey(target)===row.target_key;}) || null; }
  function rowIssue(row) {
    if(!row.included)return '';
    if(!targetForRow(row))return '请选择专业和提报人';
    if(!String(row.name || '').trim())return '事项内容不能为空';
    if(row.due){var date=new Date(row.due+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(row.due) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==row.due)return '完成时间无效';}
    return '';
  }
  function importGroups() {
    var groups=new Map();
    (imported && imported.rows || []).filter(function(row){return row.included;}).forEach(function(row){var target=targetForRow(row);if(!target)return;var key=targetKey(target);if(!groups.has(key))groups.set(key,{key:key,target:target,rows:[]});groups.get(key).rows.push(row);});
    return Array.from(groups.values());
  }
  function hintGroups() {
    var groups=new Map();(imported && imported.rows || []).forEach(function(row){var key=hintKey(row);if(!groups.has(key))groups.set(key,{key:key,label:key,rows:[]});groups.get(key).rows.push(row);});return Array.from(groups.values());
  }
  function rowLine(row) { var target=targetForRow(row);return target?target.line:row.assigned_line || row.line_hint || '待确认专业'; }
  function professionGroups() {
    var groups=new Map();(imported && imported.rows || []).forEach(function(row){var name=rowLine(row);if(!groups.has(name))groups.set(name,{line:name,rows:[]});groups.get(name).rows.push(row);});unassignedProfessions().forEach(function(entry){if(!groups.has(entry.line))groups.set(entry.line,{line:entry.line,rows:[]});});return Array.from(groups.values());
  }
  function assignmentGroups() {
    return professionGroups().map(function(group){return {key:group.line,line:group.line,rows:group.rows.filter(function(row){return row.included && !targetForRow(row);})};}).filter(function(group){return group.rows.length;});
  }
  function assignmentTargets(group) { return currentTargets().filter(function(target){return target.line===group.line;}); }
  function professionSuggestions() {
    var groups=new Map();(imported && imported.rows || []).filter(function(row){return row.included && row.profession_suggestion && row.profession_suggestion.requires_confirmation;}).forEach(function(row){
      var proposal=row.profession_suggestion,source=row.profession_mapping && row.profession_mapping.source_label || row.line_hint || '原表未明确专业',key=JSON.stringify([source,proposal.line]);
      if(!groups.has(key))groups.set(key,{source:source,line:proposal.line,reason:proposal.reason || '',rows:[]});groups.get(key).rows.push(row);
    });return Array.from(groups.values());
  }
  async function confirmProfession(index) {
    return confirmProfessions([professionSuggestions()[index]].filter(Boolean));
  }
  async function confirmAllProfessions(){return confirmProfessions(professionSuggestions());}
  async function confirmProfessions(groups) {
    if(!allowed() || busy || !['ai','excel'].includes(mode) || !groups.length)return false;flush();var state=aiState();
    if(mode==='excel'){
      var patches=[];
      for(var group of groups){var candidates=currentTargets().filter(function(target){return target.line===group.line;});if(!candidates.length){error='建议专业没有已授权提报人，请核对专业。';render();return false;}
        group.rows.forEach(function(row){patches.push({row:row,line:group.line,target:candidates.length===1?candidates[0]:null});});}
      patches.forEach(function(patch){patch.row.target_key=patch.target?targetKey(patch.target):'';patch.row.assigned_line=patch.line;patch.row.profession_suggestion=null;patch.row.profession_mapping={source_label:patch.row.line_hint,line:patch.line,basis:'manual',requires_confirmation:false};});operation=null;render();return true;
    }
    if(state.manualDirty || state.requiresSync || state.serverBusy || state.saved){state.error='请先应用已有手动纠正或重新读取 AI 预览，再确认专业。';render();return false;}
    var changes=[];
    for(var group of groups){var targets=currentTargets().filter(function(target){return target.line===group.line;});if(!targets.length){state.error='该专业没有当前项目已授权的填报人，请先核对专业或账号授权。';render();return false;}
      group.rows.forEach(function(row){changes.push({id:row.id,line:group.line,owner_id:targets.length===1?targets[0].owner_id:null});});}
    return aiRun('revise',function(signal){return aiJSON('/api/admin-plans/ai/revise',{conversation_id:state.conversation_id,expected_revision:state.revision,changes:changes},signal);},'专业确认前的原预览');
  }
  function chooseAssignment(index,value) { if(!allowed() || busy)return;var group=assignmentGroups()[index];if(group)aiState().assignmentChoices.set(group.key,value);render(); }
  async function applyAssignment(index) {
    if(!allowed() || busy || mode!=='ai')return false;flush();var state=aiState(),group=assignmentGroups()[index];if(!group)return false;
    if(state.manualDirty || state.requiresSync || state.serverBusy || state.saved){state.error=state.manualDirty?'请先应用已有手动纠正，再确认整组分配。':state.requiresSync?'请先重读 AI 预览，再确认整组分配。':'当前预览暂不能调整，请重新读取后核对。';render();return false;}
    var candidates=assignmentTargets(group),selection=state.assignmentChoices.get(group.key),target=candidates.find(function(entry){return targetKey(entry)===selection;});
    if(!target){state.error=candidates.length?'请先为 '+group.line+' 选择已授权的提报人。':'本专业暂无已授权提报人，请在高级手动纠正中明确核对专业，或先完善本专业账号授权。';render();return false;}
    var changes=group.rows.map(function(row){return {id:row.id,line:target.line,owner_id:target.owner_id};});
    var ok=await aiRun('revise',function(signal){return aiJSON('/api/admin-plans/ai/revise',{conversation_id:state.conversation_id,expected_revision:state.revision,changes:changes},signal);},'整组分配前的原预览');
    if(ok)state.assignmentChoices.delete(group.key);return ok;
  }
  function confirmedAssignmentGroups() {
    return importGroups().map(function(group){return {target:group.target,rows:group.rows.filter(function(row){return row.manual_fields.includes('owner_id') || row.manual_fields.includes('line');})};}).filter(function(group){return group.rows.length;});
  }
  function reviewAssignments() {
    if(!allowed() || busy || mode!=='ai' || assignmentGroups().length)return false;
    var groups=confirmedAssignmentGroups();if(!groups.length)return false;
    return sendAI('我已在页面明确确认以下分配：'+groups.map(function(group){return group.target.line+' '+group.rows.length+' 项由 '+group.target.owner_name+' 提报';}).join('；')+'。请保持这些人工分配，并核对剩余问题，只消除确已解决的问题。保留原事项、标准、日期、来源和权限。本次只更新预览，不保存或导入。');
  }
  function rowNeedsReview(row) {
    if(!row.included)return false;if(rowIssue(row))return true;if(mode!=='ai')return false;var state=aiState();
    return state.questions.some(function(question){return question && Array.isArray(question.row_ids) && question.row_ids.includes(row.id);}) || state.unverified_regions.some(function(region){return region.id===row.region_id;});
  }
  function filteredRows() {
    var state=aiState();return (imported && imported.rows || []).map(function(row,index){return {row:row,index:index};}).filter(function(entry){return (!state.filterLine || rowLine(entry.row)===state.filterLine) && (!state.onlyPending || rowNeedsReview(entry.row));});
  }
  function filterPreview(field,value) { if(!allowed() || busy)return;flush();if(field==='line')aiState().filterLine=String(value || '');if(field==='pending')aiState().onlyPending=!!value;previewPage=0;render(); }
  function focusSection(id) { var node=global.document && global.document.getElementById(id);if(node && node.tagName==='DETAILS')node.open=true;if(node && node.scrollIntoView)node.scrollIntoView({block:'center'});if(node && node.focus)node.focus({preventScroll:true}); }
  function blockers() {
    if(mode!=='ai' || !imported)return [];var state=aiState(),items=[],unassigned=assignmentGroups().reduce(function(n,group){return n+group.rows.length;},0),groups=importGroups();
    function add(text,id){items.push({text:text,id:id});}
    if(state.requiresSync)add('上次请求结果待同步，请先重读 AI 预览。','admin-plan-ai-heading');
    if(state.serverBusy)add('服务器仍在整理，请稍后重读预览。','admin-plan-ai-heading');
    if(state.ai_status==='needs_retry')add('原表已读取，AI 整理未完成，请继续重试。','admin-plan-ai-retry');
    if(unassigned)add(unassigned+' 项待确认提报人，请按专业整组分配。','admin-plan-assignments');
    if(state.unverified_regions.length)add(state.unverified_regions.length+' 个工作表范围待确认计划月份。','admin-plan-ai-regions');
    if(state.unprocessed_rows.length || !state.complete && state.ai_status!=='needs_retry')add(state.unprocessed_rows.length?'尚有 '+state.unprocessed_rows.length+' 行源内容未核对。':'本次识别尚未完成，请继续核对。','admin-plan-ai-coverage');
    if(state.questions.length && !unassigned)add('还有 '+state.questions.length+' 个识别问题待澄清。','admin-plan-ai-heading');
    if(state.manualDirty)add('手动纠正尚未应用，请先应用纠正。','admin-plan-manual-apply');
    var invalid=imported.rows.filter(function(row){return targetForRow(row) && rowIssue(row);}).length;if(invalid)add(invalid+' 项内容或日期需要修正。','admin-plan-preview');
    groups.forEach(function(group){var plan=existing(group.target);if(plan && plan.editable!==true)add(group.target.line+' · '+group.target.owner_name+'：'+(plan.lock_reason || '已有计划被引用，不允许修改。'),'admin-plan-save-range');else if(plan && !importChoices.has(group.key))add(group.target.line+' · '+group.target.owner_name+'：请选择追加或替换。','admin-plan-save-range');});
    if(!imported.rows.some(function(row){return row.included;}))add('请至少选择一项有效计划。','admin-plan-preview');
    if(!items.length && !state.can_confirm && !state.saved)add('当前预览尚未就绪，请重读 AI 预览核对。','admin-plan-ai-heading');return items;
  }
  function planPayload(target,items,expected) {
    var value={project_id:target.project_id,line:target.line,owner_id:target.owner_id,month:month,expected_plan_id:expected,items:items.map(function(row){var item={mod:String(row.mod || '').trim(),name:String(row.name || '').trim(),due:row.due || ''};if(row.source_id)item.source_id=row.source_id;if(row.project_id)item.project_id=row.project_id;return cfg.richCopy?cfg.richCopy(row,item):item;})};
    if(target.report_scope_id)value.report_scope_id=target.report_scope_id;
    return cfg.richCollect?cfg.richCollect(value):value;
  }
  function mergeSaved(plans) { plans.forEach(function(plan){S.monthlyPlans=(S.monthlyPlans || []).filter(function(row){return !samePlan(row,{project_id:plan.project_id,report_scope_id:plan.report_scope_id,line:plan.line,owner_id:plan.owner_id || plan.confirmed_by,month:String(plan.plan_month || plan.month).slice(0,7)});}).concat([plan]);drafts.delete(draftKey(plan));}); }
  async function confirmAI() {
    if(!allowed() || busy || mode!=='ai')return false;flush();var state=aiState();
    if(!state.conversation_id || !imported){state.error='请先上传整份 Excel 生成 AI 预览。';render();return false;}
    if(state.saved){state.error='本次计划已导入，无需重复确认。';render();return false;}
    if(state.manualDirty){state.error='请先应用手动纠正，再确认导入。';render();return false;}
    if(!state.can_confirm || state.unverified_regions.length || imported.rows.some(function(row){return !!rowIssue(row);})){state.error='还有待确认的识别问题，请在对话中澄清或核对月份范围后再导入。';render();return false;}
    var groups=importGroups(),modes=[],count=0;
    if(!groups.length){state.error='没有已选择的有效事项，请先核对预览。';render();return false;}
    for(var i=0;i<groups.length;i++){
      var group=groups[i],plan=existing(group.target);
      if(plan && plan.editable!==true){state.error=group.target.owner_name+' · '+group.target.line+'：'+(plan.lock_reason || '已有计划被引用，不允许修改。');render();return false;}
      if(plan && !importChoices.has(group.key)){state.error='请明确已有计划采用追加还是替换，再确认导入。';render();return false;}
      modes.push({line:group.target.line,owner_id:group.target.owner_id,mode:plan?importChoices.get(group.key):'append',expected_plan_id:plan?plan.id:null});count+=group.rows.length;
    }
    if(!global.confirm('确认一次导入 '+new Set(groups.map(function(group){return group.target.line;})).size+' 个专业、'+groups.length+' 份提报人月计划、'+count+' 项事项？\n这些计划将直接显示给对应提报人；本操作不会提交周报。'))return false;
    var fingerprint=JSON.stringify([state.conversation_id,state.revision,modes]);if(!operation || operation.fingerprint!==fingerprint)operation={id:uuid(),fingerprint:fingerprint};
    var generation=epoch,key=contextKey(),active=cfg,payload={conversation_id:state.conversation_id,expected_revision:state.revision,operation_id:operation.id,modes:modes};busy=true;state.error='';render();
    try{
      var data=check(await active.request('/api/admin-plans/ai/confirm',payload),'AI 导入保存失败，请重试');
      if(generation!==epoch || key!==contextKey() || !allowed())return false;
      var receipt=data && data.result;if(!receipt || !Array.isArray(receipt.plans))throw new Error('保存结果尚未确认，请保留当前预览并重新读取。');
      mergeSaved(receipt.plans);state.savedOperation=receipt.operation_id;
      importDrafts.delete(importKey());imported=null;importChoices=new Map();operation=null;state.can_confirm=false;state.saved=true;state.toBottom=true;
      state.savedCount=receipt.plans.length;state.messages.push({role:'assistant',content:'已保存 '+receipt.plans.length+' 份月计划、'+count+' 项事项，对应提报人可直接读取。'});ready=false;await load(null,true);
      if(active.refresh && !await active.refresh())cfg.toast('计划已导入，汇总刷新失败，请稍后刷新数据。','warn');else cfg.toast('整项目月计划已导入，与提报人填报同步。','success');return true;
    }catch(cause){if(generation===epoch && key===contextKey())state.error=cause.message || '保存结果尚未确认，当前预览保留，请重试。';return false;}
    finally{if(generation===epoch){busy=false;editorContext=null;render();}}
  }
  async function save() {
    if(!allowed() || busy)return false;
    if(mode==='saved')return saveSaved();
    if(mode==='ai')return confirmAI();
    if(mode==='excel' && currentBatch())return saveMonthBundle();
    flush();error='';var plans=[],count=0;
    if(mode==='manual'){
      var target=currentTarget();if(!target || !editable(target)){error='请先选择可编辑的单个提报人计划。';render();return false;}
      var entry=draft(target),rows=entry.items.filter(function(row){return String(row.name || '').trim() || String(row.mod || '').trim() || row.due;});
      if(entry.expected!==(existing(target)?existing(target).id:null)){error='服务器月计划已有变化，当前输入已保留。请先重新读取，并核对最新计划。';render();return false;}
      if(!rows.length || rows.some(function(row){return !String(row.name || '').trim();})){error='请填写至少一项计划，每项都需要事项内容。';render();return false;}
      plans.push(planPayload(target,rows,entry.expected));count=rows.length;
    }else{
      if(!imported || !imported.rows.some(function(row){return row.included;})){error='请先生成预览并选择需要保存的事项。';render();return false;}
      if(imported.rows.some(function(row){return !!rowIssue(row);})){error='请先修正预览中标出的内容，并为每项明确分配专业和提报人。';render();return false;}
      var groups=importGroups();
      for(var i=0;i<groups.length;i++){
        var group=groups[i],plan=existing(group.target),items=group.rows;
        if(plan && plan.editable!==true){error=group.target.owner_name+' · '+group.target.line+'：'+(plan.lock_reason || '已有计划被引用，不允许修改。');render();return false;}
        if(plan && !importChoices.has(group.key)){error='请明确已有计划采用追加还是替换，再保存。';render();return false;}
        if(plan && importChoices.get(group.key)==='append')items=(plan.items || []).map(function(row,index){return itemFromPlan(plan,row,index);}).concat(items);
        plans.push(planPayload(group.target,items,plan?plan.id:null));count+=group.rows.length;
      }
    }
    if(!global.confirm('确认保存到 '+plans.length+' 份提报人月计划（'+count+' 项'+(mode==='excel'?'导入事项':'事项')+'）？\n保存后将直接显示在相应提报人的计划填报中，不会提交周报。'))return false;
    var fingerprint=JSON.stringify(plans);if(!operation || operation.fingerprint!==fingerprint)operation={id:uuid(),fingerprint:fingerprint};
    var generation=epoch,key=contextKey(),active=cfg,payload={operation_id:operation.id,plans:plans};busy=true;render();
    try {
      var data=check(await active.request('/api/admin-plans/save',payload),'计划保存失败，请重试');
      if(generation!==epoch || key!==contextKey() || !allowed())return false;
      if(!data || !Array.isArray(data.plans))throw new Error('保存结果尚未确认，请保留当前内容并重试。');
      data.plans.forEach(function(plan){S.monthlyPlans=(S.monthlyPlans || []).filter(function(row){return !samePlan(row,{project_id:plan.project_id,report_scope_id:plan.report_scope_id,line:plan.line,owner_id:plan.owner_id || plan.confirmed_by,month:String(plan.plan_month || plan.month).slice(0,7)});}).concat([plan]);});
      plans.forEach(function(plan){drafts.delete(draftKey(plan));});
      if(mode!=='manual'){importDrafts.delete(importKey());imported=null;importChoices=new Map();excelFiles.delete(excelFileKey());}operation=null;ready=false;
      await load(null,true);
      if(active.refresh && !await active.refresh())cfg.toast('计划已保存，汇总刷新失败，请稍后刷新数据。','warn');
      else cfg.toast('月计划已保存，与提报人填报同步。','success');
      return true;
    }catch(cause){if(generation===epoch && key===contextKey())error=cause.message || '计划保存失败；当前内容已保留，请重试。';return false;}
    finally{if(generation===epoch){busy=false;editorContext=null;render();}}
  }
  function monthBundlePayload() {
    var batch=currentBatch(),plans=[],summaries=[],total=0;
    if(!batch || batch.saved)throw new Error('请重新上传需要保存的月份文件。');
    if(batch.unassigned.length && !batch.excludeUnknown)throw new Error('还有未标明月份的来源范围，请先核对并明确本次排除，或使用AI辅助核对。');
    for(var value of batch.months){var choice=batch.options[value];if(!choice.plans && !choice.summary)continue;
      forBatchMonth(value,function(saved){
        if(!saved)throw new Error(value+' 尚未生成预览。');
        var rows=imported.rows.filter(function(row){return row.included;});if(!rows.length)throw new Error(value+' 没有已选事项，请取消该月份保存选项。');
        if(rows.some(function(row){return !!rowIssue(row);}))throw new Error(value+' 仍有事项内容、专业或提报人待确认。');
        var groups=importGroups();total+=rows.length;
        groups.forEach(function(group){
          if(choice.plans){var plan=existing(group.target),items=group.rows;
            if(plan && plan.editable!==true)throw new Error(value+' · '+group.target.line+' 的原计划已被引用；请取消该月“写入月计划”，可独立保存完成情况。');
            if(plan && !importChoices.has(group.key))throw new Error(value+' · '+group.target.line+'：请选择追加或替换未引用计划。');
            if(plan && importChoices.get(group.key)==='append')items=(plan.items || []).map(function(item,index){return itemFromPlan(plan,item,index);}).concat(items);
            plans.push(planPayload(group.target,items,plan?plan.id:null));
          }
          if(choice.summary){var prior=(catalog.summaries || []).find(function(row){return row.project_id===group.target.project_id && (row.report_scope_id || '')===(group.target.report_scope_id || '') && row.line===group.target.line && row.owner_id===group.target.owner_id && String(row.month).slice(0,7)===value;});
            var snapshot={project_id:group.target.project_id,line:group.target.line,owner_id:group.target.owner_id,month:value,expected_summary_id:prior?prior.id:null,items:group.rows.map(function(row,index){return {source_id:'import_'+String(row.id || index).replace(/[^A-Za-z0-9_-]/g,'_')+'_'+index,mod:String(row.mod || ''),name:String(row.name || ''),due:row.due || '',progress:String(row.progress || '')};})};
            if(group.target.report_scope_id)snapshot.report_scope_id=group.target.report_scope_id;summaries.push(snapshot);
          }
        });
      });
    }
    if(!plans.length && !summaries.length)throw new Error('请至少选择一项“写入月计划”或“保存月度完成情况”。');
    return {plans:plans,summaries:summaries,items:total};
  }
  async function saveMonthBundle() {
    flush();stashImport();error='';var batch=currentBatch(),contents;
    try{contents=monthBundlePayload();}catch(cause){error=cause.message;render();return false;}
    var description=batch.months.map(function(value){var option=batch.options[value];return value+'：'+[option.plans?'月计划':'',option.summary?'月度完成情况':''].filter(Boolean).join('、');}).filter(function(value){return !value.endsWith('：');}).join('\n');
    if(!global.confirm('确认保存以下月份内容？\n'+description+'\n共 '+contents.plans.length+' 份月计划、'+contents.summaries.length+' 份月度汇总。完成情况为原表月度记录，不会生成周报或自动完成审核。'))return false;
    var fingerprint=JSON.stringify([contents.plans,contents.summaries]);if(!operation || operation.fingerprint!==fingerprint)operation={id:uuid(),fingerprint:fingerprint};
    var payload={operation_id:operation.id,plans:contents.plans,summaries:contents.summaries},generation=epoch,key=contextKey(),active=cfg;busy=true;render();
    try{var result=check(await active.request('/api/admin-plans/save',payload),'月份内容保存失败，请重试');
      if(generation!==epoch || key!==contextKey() || !allowed())return false;
      if(!result || !Array.isArray(result.plans) || !Array.isArray(result.summaries))throw new Error('服务器保存结果尚未确认，当前预览保留，请重新读取后核对。');
      mergeSaved(result.plans);batch.saved=true;batch.savedOperation=result.operation_id;batch.receipt={plans:result.plans.length,summaries:result.summaries.length};excelFiles.delete(excelFileKey());
      batch.months.forEach(function(value){forBatchMonth(value,function(saved){if(saved){saved.preview.saved=true;var state=aiState();if(!state.conversation_id)state.selectedFile=null;}});});operation=null;ready=false;await load(null,true);restoreImport();
      if(active.refresh && !await active.refresh())cfg.toast('内容已保存，汇总刷新失败，请稍后刷新数据。','warn');else cfg.toast('月计划及月度完成情况已保存，周报和审核状态保持。','success');return true;
    }catch(cause){if(generation===epoch && key===contextKey())error=cause.message || '保存结果尚未确认，当前预览保留。';return false;}
    finally{if(generation===epoch){busy=false;editorContext=null;render();}}
  }
  function batchUnknown(checked) { if(!allowed() || busy)return;var batch=currentBatch();if(batch){batch.excludeUnknown=!!checked;operation=null;render();} }
  function monthBundleHtml() {
    var batch=currentBatch();if(!batch)return '';
    return '<section class="admin-month-bundle" aria-label="本月与下月导入"><h3>按正文月份分别核对</h3><p class="muted">月份来自表内标题；文件名和完成日期不决定事项归属。下月的原表进展仅作参考，不自动当作已完成。</p><div class="admin-month-cards">'+batch.months.map(function(value,index){var saved=importDrafts.get(JSON.stringify([type,value,project,'excel'])),rows=saved?saved.preview.rows:[],option=batch.options[value],completed=rows.filter(function(row){return String(row.progress || '').trim();}).length;return '<article class="admin-month-card'+(month===value?' is-current':'')+'"><button type="button" class="admin-month-open" aria-pressed="'+(month===value)+'" onclick="AdminPlans.batchMonth('+esc(JSON.stringify(value))+')"'+(busy?' disabled':'')+'><b>'+esc(value)+' · '+(index===0?'本月计划及完成情况':'下月工作计划')+'</b><span>'+rows.length+' 项计划 · '+completed+' 项含原表进展</span></button><label><input type="checkbox" aria-label="'+value+'写入月计划" onchange="AdminPlans.batchOption('+esc(JSON.stringify(value))+',\'plans\',this.checked)"'+(option.plans?' checked':'')+(busy || batch.saved || !rows.length?' disabled':'')+'>写入各提报人的月计划</label><label><input type="checkbox" aria-label="'+value+'保存月度完成情况" onchange="AdminPlans.batchOption('+esc(JSON.stringify(value))+',\'summary\',this.checked)"'+(option.summary?' checked':'')+(busy || batch.saved || !rows.length?' disabled':'')+'>保存独立月度完成情况</label><small>'+(index===0?'默认只保存汇总；需要补建本月计划时可勾选。':'默认编制下月计划；原表进展需要入库时另勾选汇总。')+'</small></article>';}).join('')+'</div>'
      +(batch.unassigned.length?'<div class="notice warn"><b>'+batch.unassigned.length+' 个来源区段未明确月份</b><p>它们没有自动并入本月或下月，可转AI辅助核对，或明确排除后先导入已识别内容。</p><label><input type="checkbox" onchange="AdminPlans.batchUnknown(this.checked)"'+(batch.excludeUnknown?' checked':'')+(busy || batch.saved?' disabled':'')+'>本次只导入已识别的两个月，排除上述未标月区段</label></div>':'')
      +(batch.withdrawn?'<p class="notice" role="status">本批次已撤回，原预览保留供核对；请重新上传文件开始新导入。</p>':batch.saved?'<p class="notice" role="status">已保存 '+batch.receipt.plans+' 份月计划、'+batch.receipt.summaries+' 份月度完成情况。</p>':'<p class="notice">当前查看 '+esc(month)+'；勾选保存的月份会在最后一步一起提交。保存月度完成情况不会改写每周填报或完成审核。</p>')+'</section>';
  }
  function historyState() { var key=baseImportKey();if(!batchHistory.has(key))batchHistory.set(key,{rows:[],page:0,loaded:false,loading:false,error:'',hasMore:false,revision:0});return batchHistory.get(key); }
  async function loadBatches(pageNumber) {
    if(!allowed() || !project)return false;
    var scope=currentTargets()[0];if(!scope)return false;
    flush();var state=historyState(),generation=epoch,key=baseImportKey(),ticket=++state.revision,requestedPage=pageNumber===undefined?state.page:Math.max(0,pageNumber);
    state.loading=true;state.error='';render();
    function live(){return generation===epoch && key===baseImportKey() && allowed() && batchHistory.get(key)===state && state.revision===ticket;}
    try{
      var query='project_id='+encodeURIComponent(scope.project_id)+'&month='+encodeURIComponent(month)+'&page='+requestedPage+(scope.report_scope_id?'&report_scope_id='+encodeURIComponent(scope.report_scope_id):'');
      var data=await response(await global.fetch('/api/admin-plans/batches?'+query,{credentials:'same-origin'}),'保存批次读取失败，请重试');
      if(!live())return false;
      if(!data || !Array.isArray(data.batches))throw new Error('保存批次读取结果不完整，请重新读取。');
      state.rows=data.batches;state.page=requestedPage;state.hasMore=data.has_more===true;state.loaded=true;return true;
    }catch(cause){if(live())state.error=cause.message || '保存批次读取失败，请重试。';return false;}
    finally{if(generation===epoch && batchHistory.get(key)===state && state.revision===ticket){state.loading=false;render();}}
  }
  function batchDescription(row) {
    var grouped=new Map();(row.records || []).forEach(function(record){var key=JSON.stringify([record.project_id,record.month]);if(!grouped.has(key))grouped.set(key,{project:record.project_name || (catalog.targets.find(function(target){return target.project_id===record.project_id;}) || {}).project_name || '项目',month:record.month,plans:0,summaries:0});var group=grouped.get(key);if(record.kind==='plan')group.plans++;else group.summaries++;});
    return Array.from(grouped.values()).map(function(group){return group.project+' · '+group.month+'：'+group.plans+' 份月计划、'+group.summaries+' 份月度汇总';}).join('\n');
  }
  async function withdrawBatch(index) {
    if(!allowed() || busy || mode!=='history')return false;
    var state=historyState(),row=state.rows[index];if(state.loading || !row || !row.can_withdraw || row.withdrawn)return false;flush();
    if(!global.confirm('确认撤回以下整个保存批次？\n'+batchDescription(row)+'\n本次新建内容将撤销；追加或替换的内容恢复到本批次保存前，并使用新版本。任何一部分已修改或被引用，整批均不会撤回。未保存编辑保留供核对。'))return false;
    var generation=epoch,key=contextKey(),active=cfg;busy=true;error='';render();
    try{
      var data=check(await active.request('/api/admin-plans/withdraw-batch',{actor_id:row.actor_id,operation_id:row.operation_id}),'撤回结果尚未确认，请保留当前内容并重新读取');
      if(generation!==epoch || key!==contextKey() || !allowed())return false;
      if(!data || data.withdrawn!==true || !Array.isArray(data.removed_plan_ids) || !Array.isArray(data.plans))throw new Error('撤回结果尚未确认，请重新读取保存批次；当前输入保留。');
      S.monthlyPlans=(S.monthlyPlans || []).filter(function(plan){return !data.removed_plan_ids.includes(plan.id);});
      if(row.actor_id===uid){monthBatches.forEach(function(batch){if(batch.savedOperation===row.operation_id)batch.withdrawn=true;});aiStates.forEach(function(state){if(state.savedOperation===row.operation_id)state.withdrawn=true;});}
      ready=false;var loaded=await load(null,true),historyLoaded=await loadBatches(),refreshed=!active.refresh || await active.refresh();
      cfg.toast(loaded && historyLoaded && refreshed?'整批已撤回，新建内容已撤销，替换前的内容已恢复；原记录保留在审计中。':'整批撤回已确认，最新数据读取失败；请稍后重新读取，当前输入保留。',loaded && historyLoaded && refreshed?'success':'warn');return true;
    }catch(cause){if(generation===epoch && key===contextKey()){error=cause.message || '撤回结果尚未确认；当前输入保留，请重新读取后核对。';}return false;}
    finally{if(generation===epoch){busy=false;editorContext=null;render();}}
  }
  function historyHtml() {
    if(!project)return '<div class="admin-plan-empty">请先选择项目和月份，查看保存记录并撤回整批导入。</div>';
    var state=historyState();
    return '<section class="admin-plan-batches" aria-label="保存批次与撤回"><div class="admin-plans-heading"><h3>导入 / 保存记录与撤回</h3><button type="button" class="btn ghost" onclick="AdminPlans.loadBatches()"'+(busy || state.loading?' disabled':'')+'>'+(state.loading?'读取中…':'重新读取保存批次')+'</button></div><p class="muted">按所选项目和月份查找记录；同一次保存的其他月份、专业和汇总也会一起撤回。新建内容撤销，追加或替换的内容恢复到保存前；当前或历史周报、完成／延期申报引用，以及后续修改都会阻止整批撤回。</p>'
      +(state.error?'<p class="notice err" role="alert">'+esc(state.error)+'</p>':'')
      +(!state.loaded?'<p class="admin-plan-empty">'+(state.loading?'正在读取保存记录…':'点击“重新读取保存批次”查看记录。')+'</p>':!state.rows.length?'<p class="admin-plan-empty">该项目在所选月份没有管理员保存批次。</p>':state.rows.map(function(row,index){var date=new Date(row.created_at);return '<article class="admin-plan-batch" data-operation-id="'+esc(row.operation_id)+'"><div class="admin-plans-heading"><b>'+esc(Number.isNaN(date.getTime())?row.created_at:date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))+' · '+esc(row.actor_name || '管理员')+'</b><button type="button" class="btn ghost admin-plan-withdraw" onclick="AdminPlans.withdrawBatch('+index+')"'+(busy || state.loading || !row.can_withdraw || row.withdrawn?' disabled':'')+'>'+(row.withdrawn?'本批次已撤回':'撤回整批')+'</button></div><p class="admin-plan-batch-range">'+esc(batchDescription(row))+'</p>'+(row.blockers && row.blockers.length?'<p class="admin-plan-error">'+row.blockers.map(esc).join('<br>')+'</p>':'<p class="muted">可撤回；点击后还会再次核对最新版本及引用。</p>')+'<details><summary>查看完整撤回范围（'+(row.records || []).length+' 份内容）</summary>'+(row.records || []).map(function(record){return '<p>'+esc(record.month)+' · '+esc(record.line)+' · '+esc(record.owner_name)+' · '+(record.kind==='plan'?'月计划':'月度汇总')+' · '+record.items+' 项</p>';}).join('')+'</details></article>';}).join(''))
      +'<div class="admin-plan-savebar"><button type="button" class="btn ghost" onclick="AdminPlans.loadBatches('+(state.page-1)+')"'+(busy || state.loading || state.page===0?' disabled':'')+'>上一页记录</button><span>第 '+(state.page+1)+' 页</span><button type="button" class="btn ghost" onclick="AdminPlans.loadBatches('+(state.page+1)+')"'+(busy || state.loading || !state.hasMore?' disabled':'')+'>下一页记录</button></div></section>';
  }
  function savedRecords(kind) {
    return (kind==='plan'?catalog.plans || []:catalog.summaries || []).filter(function(record){return projectKey(record)===project && String(record.plan_month || record.month).slice(0,7)===month;});
  }
  function savedEntry() { return savedDrafts.get(savedSelections.get(baseImportKey())) || null; }
  function savedCurrent(entry) { return entry?savedRecords(entry.kind).find(function(record){return targetKey(record)===targetKey(entry.target);}):null; }
  function savedLock(entry) {
    if(!entry)return '请先选择需要修改的已保存内容。';
    if(!currentTargets().some(function(target){return targetKey(target)===targetKey(entry.target);}))return '提报人当前项目或专业授权不完整，不能修改。';
    var record=savedCurrent(entry);if(!record)return '该记录已发生变化，请重新读取后核对；当前输入保留。';
    return entry.kind==='plan' && record.editable!==true?record.lock_reason || '已有周报或完成／延期申报引用，不能修改。':'';
  }
  function savedItems(kind,record) { return (record.items || []).map(function(item,index){return kind==='plan'?itemFromPlan(record,item,index):copy(item);}); }
  function openSaved(kind,id) {
    if(!allowed() || busy || mode!=='saved' || !['plan','summary'].includes(kind))return false;
    flush();var record=savedRecords(kind).find(function(value){return value.id===id;});if(!record)return false;
    var key=JSON.stringify([baseImportKey(),kind,targetKey(record)]),entry=savedDrafts.get(key);
    if(!entry || !entry.dirty && entry.expected!==record.id){entry={kind:kind,target:copy(record),expected:record.id,items:savedItems(kind,record),dirty:false};savedDrafts.set(key,entry);}
    savedSelections.set(baseImportKey(),key);manualPage=0;operation=null;error='';render();focusSection('admin-plan-saved-editor');return true;
  }
  function savedAdd() { var entry=savedEntry();if(!allowed() || busy || savedLock(entry))return;flush();entry.items.push({mod:'',name:'',due:'',...(entry.kind==='summary'?{progress:''}:{})});entry.dirty=true;operation=null;manualPage=Math.floor((entry.items.length-1)/pageSize);render(); }
  function savedRemove(index) { var entry=savedEntry();if(!allowed() || busy || savedLock(entry) || !entry.items[index])return;flush();entry.items.splice(index,1);entry.dirty=true;operation=null;render(); }
  async function savedLatest() {
    if(!allowed() || busy || mode!=='saved')return false;flush();var entry=savedEntry(),key=contextKey();if(!entry)return false;
    if(!await load(null,true) || key!==contextKey())return false;
    var record=savedCurrent(entry);if(!record){error='原记录已不存在，当前输入保留供核对。';render();return false;}
    entry.recovery=copy(entry.items);entry.items=savedItems(entry.kind,record);entry.expected=record.id;entry.dirty=false;operation=null;error='';render();return true;
  }
  async function saveSaved() {
    flush();var entry=savedEntry(),lock=savedLock(entry);if(lock){error=lock;render();return false;}
    if(entry.expected!==savedCurrent(entry).id){error='服务器记录已有变化，当前输入已保留。请载入最新内容并核对后保存。';render();return false;}
    var summary=entry.kind==='summary',rows=entry.items.filter(function(row){return String(row.name || '').trim() || String(row.mod || '').trim() || row.due || summary && String(row.progress || '').trim();});
    if(!summary && !rows.length || rows.some(function(row){return !String(row.name || '').trim();})){error=summary?'每项月度汇总都需要事项内容。':'月计划至少保留一项，每项都需要事项内容。';render();return false;}
    var value,payload={plans:[]};
    if(summary){value={project_id:entry.target.project_id,report_scope_id:entry.target.report_scope_id || null,line:entry.target.line,owner_id:entry.target.owner_id,month:month,expected_summary_id:entry.expected,items:rows.map(function(row){var item={mod:String(row.mod || ''),name:String(row.name || ''),due:row.due || '',progress:String(row.progress || '')};if(row.source_id)item.source_id=row.source_id;return item;})};payload.summaries=[value];}
    else{value=planPayload(entry.target,rows,entry.expected);payload.plans=[value];}
    if(!global.confirm('确认修改 '+month+' · '+entry.target.line+' · '+(entry.target.owner_name || entry.target.confirmed_name || entry.target.owner_id)+' 的'+(summary?'月度完成汇总':'月计划')+'？\n原版本留档，本操作不会提交周报或执行完成审核。'))return false;
    var fingerprint=JSON.stringify(payload);if(!operation || operation.fingerprint!==fingerprint)operation={id:uuid(),fingerprint:fingerprint};payload.operation_id=operation.id;
    var generation=epoch,key=contextKey(),active=cfg;busy=true;error='';render();
    try{
      var data=check(await active.request('/api/admin-plans/save',payload),'修改保存失败，请重试');
      if(generation!==epoch || key!==contextKey() || !allowed())return false;
      var records=data && (summary?data.summaries:data.plans);if(!Array.isArray(records) || records.length!==1)throw new Error('保存结果尚未确认，当前输入保留，请重试。');
      var record=records[0];entry.expected=record.id;entry.items=savedItems(entry.kind,record);entry.dirty=false;operation=null;
      if(summary)catalog.summaries=(catalog.summaries || []).filter(function(row){return targetKey(row)!==targetKey(entry.target) || row.month!==month;}).concat(records);
      else{mergeSaved(records);catalog.plans=(catalog.plans || []).filter(function(row){return !samePlan(row,{...entry.target,month:month});}).concat(records);}
      ready=false;var loaded=await load(null,true),refreshed=!active.refresh || await active.refresh();
      cfg.toast(loaded && refreshed?'修改已保存，原版本已留档。':'修改已保存，最新数据读取失败，请稍后重新读取。',loaded && refreshed?'success':'warn');return true;
    }catch(cause){if(generation===epoch && key===contextKey())error=cause.message || '修改保存结果尚未确认，当前输入保留，请重试。';return false;}
    finally{if(generation===epoch){busy=false;editorContext=null;render();}}
  }
  function savedHtml() {
    if(!project)return '<div class="admin-plan-empty">请先选择项目和月份，查看已保存的月计划及月度完成汇总。</div>';
    var records=['plan','summary'].flatMap(function(kind){return savedRecords(kind).map(function(record){return {kind:kind,record:record};});}),entry=savedEntry();
    var html='<section class="admin-plan-maintenance" aria-label="已保存内容"><h3>'+esc(month)+' 已保存内容</h3><p class="muted">按专业和提报人修改，无需重新上传Excel。月计划被周报或完成／延期申报引用后锁定；独立月度汇总可单独修改。切换后未保存输入仍在此窗口保留。</p>';
    html+=records.length?'<div class="admin-plan-scroll"><table class="admin-plan-records"><thead><tr><th>内容</th><th>专业 / 提报人</th><th>事项数</th><th>状态</th><th>操作</th></tr></thead><tbody>'+records.map(function(value){var record=value.record,kind=value.kind,label=kind==='plan'?'月计划':'月度完成汇总',locked=!!savedLock({kind:kind,target:record});return '<tr><td>'+label+'</td><td>'+esc(record.line)+' · '+esc(record.owner_name || record.confirmed_name || record.owner_id)+'</td><td>'+(record.items || []).length+'</td><td>'+esc(savedLock({kind:kind,target:record}) || '可修改，原版本留档')+'</td><td><button type="button" class="btn ghost sm" onclick="AdminPlans.openSaved('+esc(JSON.stringify(kind))+','+esc(JSON.stringify(record.id))+')" aria-label="'+(locked?'查看':'修改')+label+'：'+esc(record.line)+' · '+esc(record.owner_name || record.confirmed_name || record.owner_id)+'"'+(busy?' disabled':'')+'>'+(locked?'查看':'修改')+label+'</button></td></tr>';}).join('')+'</tbody></table></div>':'<p class="admin-plan-empty">该项目在所选月份还没有已保存内容。</p>';
    if(!entry)return html+'</section>';
    var summary=entry.kind==='summary',lock=savedLock(entry),locked=busy || !!lock,record=savedCurrent(entry),changed=!record || record.id!==entry.expected;
    manualPage=Math.min(manualPage,Math.max(0,Math.ceil(entry.items.length/pageSize)-1));editorContext={key:contextKey(),rows:entry.items,entry:locked?null:entry};
    html+='<section id="admin-plan-saved-editor" tabindex="-1"><h3>'+esc(month)+' · '+esc(entry.target.line)+' · '+esc(entry.target.owner_name || entry.target.confirmed_name || entry.target.owner_id)+' · '+(summary?'修改月度完成汇总':'修改月计划')+'</h3>'+(lock?'<p class="admin-plan-locked">'+esc(lock)+'</p>':'');
    if(changed)html+='<p class="notice warn" role="alert">服务器记录版本已变化，当前输入保留，请核对后再保存。<button type="button" class="btn ghost sm" onclick="AdminPlans.savedLatest()"'+(busy?' disabled':'')+'>载入最新内容，保留原输入副本</button></p>';
    if(entry.recovery)html+='<details class="notice"><summary>载入前的未保存输入副本</summary>'+entry.recovery.map(function(row){return '<p>'+esc(row.mod)+' · '+esc(row.due)+'</p><div>'+(cfg.richItem && !summary?cfg.richItem(row,'name',row.name):esc(row.name))+'</div><p>'+esc(row.progress || '')+'</p>';}).join('')+'</details>';
    html+='<div class="admin-plan-scroll"><table class="admin-plan-grid admin-plan-manual'+(summary?' has-progress':'')+'"><thead><tr><th>模块或工作类别</th><th>事项</th><th>计划完成时间</th>'+(summary?'<th>月度完成情况</th>':'')+'<th>操作</th></tr></thead><tbody>'+entry.items.slice(manualPage*pageSize,(manualPage+1)*pageSize).map(function(row,at){var index=manualPage*pageSize+at;return '<tr>'+inputRow(row,index,locked,summary)+(summary?'<td><textarea id="admin_plan_progress_'+index+'" aria-label="第'+(index+1)+'项月度完成情况" maxlength="10000" oninput="AdminPlans.edit('+index+',\'progress\',this.value)"'+(locked?' disabled':'')+'>'+esc(row.progress || '')+'</textarea></td>':'')+'<td><button type="button" class="btn ghost sm" onclick="AdminPlans.savedRemove('+index+')"'+(locked?' disabled':'')+'>删除</button></td></tr>';}).join('')+'</tbody></table></div>'+pager('saved',entry.items.length,manualPage)+'<div class="admin-plan-savebar"><button type="button" class="btn ghost" onclick="AdminPlans.savedAdd()"'+(locked?' disabled':'')+'>＋ 增加事项</button><button type="button" class="btn primary" onclick="AdminPlans.save()"'+(locked || changed?' disabled':'')+'>'+(busy?'保存中…':summary?'保存汇总修改':'保存计划修改')+'</button></div></section>';
    return html+'</section>';
  }
  function options(values,selected,empty,label) { return '<option value="">'+esc(empty)+'</option>'+values.map(function(row){var value=typeof row==='string'?row:row.value,text=typeof row==='string'?row:row.label;return '<option value="'+esc(value)+'"'+(selected===value?' selected':'')+'>'+esc(label?label(row):text)+'</option>';}).join(''); }
  function targetOptions(selected,assignedLine) { return options(currentTargets().map(function(target){return {value:targetKey(target),label:target.line+' · '+target.owner_name};}),selected,'请选择专业 / 提报人')+unassignedProfessions().map(function(entry){return '<option value="'+esc(JSON.stringify(['unassigned-profession',project,entry.line]))+'" disabled'+(!selected && assignedLine===entry.line?' selected':'')+'>'+esc(professionLabel(entry.line))+'</option>';}).join(''); }
  function inputRow(row,index,locked,plain) {
    var disabled=locked?' disabled':'',rich=plain?'':' data-rich';
    return '<td><textarea'+rich+' id="admin_plan_mod_'+index+'" aria-label="第'+(index+1)+'项模块" oninput="AdminPlans.edit('+index+',\'mod\',this.value)"'+disabled+'>'+esc(row.mod)+'</textarea></td>'
      +'<td><textarea'+rich+' id="admin_plan_name_'+index+'" aria-label="第'+(index+1)+'项事项" oninput="AdminPlans.edit('+index+',\'name\',this.value)"'+disabled+'>'+esc(row.name)+'</textarea></td>'
      +'<td><input type="date" id="admin_plan_due_'+index+'" aria-label="第'+(index+1)+'项完成时间" value="'+esc(row.due)+'" oninput="AdminPlans.edit('+index+',\'due\',this.value)"'+disabled+'></td>';
  }
  function page(kind,delta) {
    if(!allowed() || busy)return;flush();
    var total=kind==='saved'?savedEntry() && savedEntry().items.length || 0:kind==='manual'?selectedEntry() && selectedEntry().items.length || 0:filteredRows().length;
    var current=kind==='manual' || kind==='saved'?manualPage:previewPage,next=Math.max(0,Math.min(Math.max(0,Math.ceil(total/pageSize)-1),current+delta));
    if(kind==='manual' || kind==='saved')manualPage=next;else previewPage=next;render();
  }
  function pager(kind,total,current) { return total>pageSize?'<div class="admin-plan-savebar"><span class="muted">共 '+total+' 项，第 '+(current+1)+' / '+Math.ceil(total/pageSize)+' 页；切页保留当前输入</span><div class="actions"><button type="button" class="btn ghost sm" onclick="AdminPlans.page(\''+kind+'\',-1)"'+(busy || current===0?' disabled':'')+'>上一页</button><button type="button" class="btn ghost sm" onclick="AdminPlans.page(\''+kind+'\',1)"'+(busy || (current+1)*pageSize>=total?' disabled':'')+'>下一页</button></div></div>':''; }
  function manualHtml() {
    var target=currentTarget();if(!target)return '<div class="admin-plan-empty">'+(unassignedProfessions().some(function(entry){return entry.line===line;})?esc(professionLabel(line))+'，暂不能编制或保存该专业计划；原有计划和预览保持。':'请依次选择项目、专业和提报人。')+'</div>';
    var entry=draft(target),plan=existing(target),locked=!editable(target),rows=plan && locked?(plan.items || []).map(function(item,index){return itemFromPlan(plan,item,index);}):entry.items;
    manualPage=Math.min(manualPage,Math.max(0,Math.ceil(rows.length/pageSize)-1));
    editorContext={key:contextKey(),rows:rows,entry:locked?null:entry};
    return (entry.expected!==(plan?plan.id:null)?'<p class="notice warn" role="alert">服务器计划版本已变化，当前输入已保留。<button type="button" class="btn ghost sm" onclick="AdminPlans.latest()"'+(busy?' disabled':'')+'>载入最新计划，保留原输入副本</button></p>':'')
      +(entry.recovery?'<details class="notice"><summary>修改前的未保存输入，保留供复制核对</summary>'+entry.recovery.map(function(row){return '<p><b>'+esc(row.mod || '')+'</b> · '+esc(row.due || '未设日期')+'</p><div>'+(cfg.richItem?cfg.richItem(row,'name',row.name):esc(row.name))+'</div>';}).join('')+'</details>':'')
      +(plan?'<p class="'+(locked?'admin-plan-locked':'notice')+'">'+(locked?esc(plan.lock_reason || '此月计划已被周报或申报引用，不允许修改。'):'已有 '+(plan.items || []).length+' 项计划，可编辑后保存；原版本留档。')+'</p>':'<p class="muted">为 '+esc(target.owner_name)+' 编制 '+esc(month)+' 月计划。保存后本人可直接填写每周进展。</p>')
      +'<div class="admin-plan-scroll"><table class="admin-plan-grid admin-plan-manual"><thead><tr><th>模块或工作类别</th><th>事项</th><th>完成时间</th><th>操作</th></tr></thead><tbody>'+rows.slice(manualPage*pageSize,(manualPage+1)*pageSize).map(function(row,at){var index=manualPage*pageSize+at;return '<tr>'+inputRow(row,index,locked)+'<td><button type="button" class="btn ghost sm" onclick="AdminPlans.remove('+index+')"'+(locked?' disabled':'')+'>删除</button></td></tr>';}).join('')+'</tbody></table></div>'+pager('manual',rows.length,manualPage)
      +'<div class="admin-plan-savebar"><button type="button" class="btn ghost" onclick="AdminPlans.add()"'+(locked?' disabled':'')+'>＋ 增加事项</button><button type="button" class="btn primary" onclick="AdminPlans.save()"'+(locked?' disabled':'')+'>'+(busy?'保存中…':'保存'+(plan?'修改':'月计划'))+'</button></div>';
  }
  function summaryHtml() {
    if(!imported)return '';var groups=professionGroups(),included=imported.rows.filter(function(row){return row.included;}),mapped=included.filter(function(row){return !!targetForRow(row);}).length;
    return '<section class="admin-plan-summary" aria-label="专业汇总"><div class="admin-plan-preview-heading"><h3>'+groups.length+' 个专业 · '+imported.rows.length+' 项计划</h3><span>已分配 '+mapped+' 项 · 待确认 '+(included.length-mapped)+' 项</span></div><div class="admin-plan-summary-grid">'+groups.map(function(group){var chosen=group.rows.filter(function(row){return row.included;}),owners=Array.from(new Set(chosen.map(function(row){var target=targetForRow(row);return target?target.owner_name:'';}).filter(Boolean))),pending=chosen.filter(function(row){return !targetForRow(row);}).length;return '<button type="button" class="admin-plan-summary-card'+(pending?' has-pending':'')+'" onclick="AdminPlans.filterPreview(\'line\','+esc(JSON.stringify(group.line))+')"'+(busy?' disabled':'')+'><b>'+esc(professionLabel(group.line))+' <span>'+group.rows.length+' 项</span></b><span>'+esc(owners.join('、') || '提报人待确认')+(pending?' · 待分配 '+pending+' 项':'')+'</span>'+(!pending && owners.length?'<small>按项目和专业匹配提报人</small>':'')+'</button>';}).join('')+'</div></section>';
  }
  function assignmentsHtml() {
    var state=aiState(),groups=assignmentGroups();if(!groups.length || state.saved)return '';
    return '<section id="admin-plan-assignments" class="admin-plan-assignments" tabindex="-1"><h3>确认提报人 <span>'+groups.length+' 个专业</span></h3><p class="muted">同专业有多位提报人、未找到授权提报人或专业尚未明确时，需要在这里确认。原表工作责任人仅供来源参考。</p><div class="admin-plan-assignment-grid">'+groups.map(function(group,index){var candidates=assignmentTargets(group),selection=state.assignmentChoices.get(group.key) || '',selected=candidates.find(function(target){return targetKey(target)===selection;}),reason=candidates.length>1?'本专业有 '+candidates.length+' 位已授权提报人，请明确选择。':candidates.length?'专业归属尚未确认，请核对后选择。':'本专业暂无已授权提报人。请点击“展开手动纠正”明确核对专业，或先完善本专业账号授权。';return '<article class="admin-plan-assignment-card"><b>'+esc(group.line)+' · '+group.rows.length+' 项</b><p>'+esc(reason)+'</p><label>分配给<select aria-label="'+esc(group.line)+'整组提报人" onchange="AdminPlans.chooseAssignment('+index+',this.value)"'+(busy || !candidates.length?' disabled':'')+'>'+options(candidates.map(function(target){return {value:targetKey(target),label:target.line+' · '+target.owner_name};}),selection,candidates.length?'请选择系统提报人':'本专业暂无可分配提报人')+'</select></label><button type="button" class="btn" onclick="AdminPlans.applyAssignment('+index+')"'+(busy || !selected || state.requiresSync || state.serverBusy || state.manualDirty?' disabled':'')+'>'+(selected?'确认分配给 '+esc(selected.owner_name)+'（'+group.rows.length+' 项）':'选择后应用至这 '+group.rows.length+' 项')+'</button></article>';}).join('')+'</div></section>';
  }
  function professionMappingsHtml() {
    var aliases=new Map();(imported.rows || []).forEach(function(row){var mapping=row.profession_mapping;if(mapping && mapping.basis==='alias')aliases.set(mapping.source_label+' → '+mapping.line,true);});
    var state=mode==='ai'?aiState():{},suggestions=professionSuggestions();
    return (aliases.size?'<p class="notice">已按专业别名对应：'+Array.from(aliases.keys()).map(esc).join('；')+'。可在手动纠正中核对。</p>':'')
      +(suggestions.length && !state.saved?'<section class="admin-plan-assignments" aria-label="确认专业名称"><h3>确认专业名称</h3><p class="muted">以下名称尚未明确对应系统专业。确认只更新预览，最后确认导入才保存。</p><button type="button" class="btn primary" onclick="AdminPlans.confirmAllProfessions()"'+(busy?' disabled':'')+'>确认以上 '+suggestions.length+' 组专业建议（'+suggestions.reduce(function(n,g){return n+g.rows.length;},0)+' 项）</button><div class="admin-plan-assignment-grid">'+suggestions.map(function(group,index){var candidates=currentTargets().filter(function(target){return target.line===group.line;});return '<article class="admin-plan-profession-card"><b>'+esc(group.source)+' · '+group.rows.length+' 项</b><p>建议归为：'+esc(group.line)+'</p><p class="muted">'+esc(group.reason)+'</p><button type="button" class="btn" onclick="AdminPlans.confirmProfession('+index+')"'+(busy || !candidates.length || state.requiresSync || state.serverBusy || state.manualDirty?' disabled':'')+'>确认归为'+esc(group.line)+(candidates.length===1?' · '+esc(candidates[0].owner_name):'，再选择提报人')+'</button><button type="button" class="btn ghost" onclick="AdminPlans.toggleAdvanced()"'+(busy?' disabled':'')+'>选择其他专业</button></article>';}).join('')+'</div></section>':'');
  }
  function blockersHtml() {
    var items=blockers();return items.length?'<div class="notice warn admin-plan-blockers" role="status"><b>导入前还需处理</b><ul>'+items.map(function(item){return '<li><button type="button" class="admin-plan-link" onclick="AdminPlans.focusSection('+esc(JSON.stringify(item.id))+')">'+esc(item.text)+'</button></li>';}).join('')+'</ul></div>':'';
  }
  function unassignedDirectoryHtml() {
    var entries=unassignedProfessions();if(!entries.length)return '';
    return '<section class="admin-plan-summary" aria-label="项目待分配专业"><h3>项目专业</h3><div class="admin-plan-summary-grid">'+entries.map(function(entry){return '<button type="button" class="admin-plan-summary-card has-pending" aria-pressed="'+(aiState().filterLine===entry.line)+'" onclick="AdminPlans.filterPreview(\'line\','+esc(JSON.stringify(entry.line))+')"><b>'+esc(professionLabel(entry.line))+'</b><span>0 项计划</span></button>';}).join('')+'</div><p class="muted">尚未分配系统提报人，目录选择仅用于查看，不改变已有计划或预览。</p></section>';
  }
  function previewHtml() {
    if(!imported)return unassignedDirectoryHtml()+'<div class="admin-plan-empty">'+(mode==='ai'?'<b>尚未生成导入预览</b><p>选择项目和月份，上传 Excel 后点击“开始识别”，这里会显示表内各专业事项。这不表示 Excel 内容为空。</p>':'上传 Excel 后先生成预览，确认归属与内容后才会写入。')+'</div>';
    var isAI=mode==='ai',state=aiState(),batch=currentBatch(),editing=(!isAI || advanced && !state.saved) && !(batch && batch.saved);
    var unresolved=imported.rows.filter(function(row){return row.included && !targetForRow(row);}).length,selected=imported.rows.filter(function(row){return row.included;}).length,groups=importGroups(),hints=hintGroups();
    var planBlocked=groups.some(function(group){var plan=existing(group.target);return plan && (plan.editable!==true || !importChoices.has(group.key));});
    var visible=filteredRows();previewPage=Math.min(previewPage,Math.max(0,Math.ceil(visible.length/pageSize)-1));
    editorContext={key:contextKey(),rows:imported.rows};
    return '<p class="notice" role="status">'+(batch && batch.saved?'本次月份内容已保存，可核对保存时的预览。':isAI && state.saved?'本次已导入 '+state.savedCount+' 份月计划，可核对已保存内容。':'仅预览，尚未写入任何计划。')+esc(imported.file_name)+' · '+imported.rows.length+' 项 · 已选择 '+selected+' 项 · 待分配 '+unresolved+' 项</p>'
      +summaryHtml()+professionMappingsHtml()+(isAI?assignmentsHtml()+assignmentReviewHtml()+aiRecoveryHtml()+aiCoverageHtml()+aiRegionsHtml():'')
      +(imported.warnings.length?'<details class="admin-plan-file-notes"><summary>'+(isAI?'未导入源行与识别提示':'文件识别提示')+' '+imported.warnings.length+' 条</summary><ul>'+imported.warnings.map(function(warning){var ref=warning.source;return '<li>'+esc(warning.message || warning)+(ref?'（'+esc([ref.sheet,ref.cell || ref.row].filter(Boolean).join(' · '))+'）':'')+'</li>';}).join('')+'</ul></details>':'')
      +(isAI?'<div class="admin-plan-preview-heading"><h3>所有专业合并预览</h3><button type="button" class="btn ghost sm" onclick="AdminPlans.toggleAdvanced()" aria-expanded="'+advanced+'"'+(busy || state.saved?' disabled':'')+'>'+(advanced?'收起手动纠正':'展开手动纠正')+'</button></div>':'')
      +(isAI && state.manualDirty?'<p id="admin-plan-manual-apply" class="notice warn" tabindex="-1">手动纠正尚未应用，原 AI 预览仍保留。<button type="button" class="btn" onclick="AdminPlans.reviseAI(false)"'+(busy?' disabled':'')+'>应用手动纠正</button></p>':'')
      +(editing?'<h3>按专业批量分配</h3><div class="admin-plan-map">'+hints.map(function(group,index){var keys=Array.from(new Set(group.rows.map(function(row){return row.target_key;})));return '<article><label>'+esc(group.label)+' · '+group.rows.length+' 项<select aria-label="'+esc(group.label)+'批量归属" onchange="AdminPlans.mapGroup('+index+',this.value)"'+(busy?' disabled':'')+'>'+targetOptions(keys.length===1?keys[0]:'')+'</select></label></article>';}).join('')+'</div>':'')
      +('<div class="admin-plan-preview-filters"><label>查看专业<select id="admin-plan-filter-line" onchange="AdminPlans.filterPreview(\'line\',this.value)"'+(busy?' disabled':'')+'>'+options(professionGroups().map(function(group){return {value:group.line,label:professionLabel(group.line)};}),state.filterLine,'全部专业')+'</select></label><label class="admin-plan-pending-filter"><input id="admin-plan-filter-pending" type="checkbox" onchange="AdminPlans.filterPreview(\'pending\',this.checked)"'+(state.onlyPending?' checked':'')+(busy?' disabled':'')+'>只看待确认</label><span class="muted">显示 '+visible.length+' / '+imported.rows.length+' 项；筛选不改变导入范围</span></div>')
      +'<div id="admin-plan-preview" class="admin-plan-scroll" tabindex="-1"><table class="admin-plan-grid admin-plan-preview'+(!editing?' is-readonly':'')+'"><thead><tr><th>导入</th><th>来源 / 说明</th><th>专业 / 提报人</th><th>模块</th><th>事项</th><th>完成时间</th>'+(batch?'<th>原表完成情况 / 月度反馈</th>':'')+'<th>待核对</th></tr></thead><tbody>'+visible.slice(previewPage*pageSize,(previewPage+1)*pageSize).map(function(entry){var row=entry.row,index=entry.index,issue=rowIssue(row),target=targetForRow(row);return '<tr'+(!row.included?' class="admin-plan-excluded"':'')+'><td><input type="checkbox" aria-label="导入第'+(index+1)+'项"'+(row.included?' checked':'')+(busy || !editing?' disabled':'')+' onchange="AdminPlans.include('+index+',this.checked)"></td><td class="admin-plan-source">'+sourceHtml(row)+'</td><td>'+(editing?'<select aria-label="第'+(index+1)+'项专业及提报人" onchange="AdminPlans.setMapping('+index+',this.value)"'+(busy?' disabled':'')+'>'+targetOptions(row.target_key,row.assigned_line)+'</select>':target?esc(target.line)+'<br><b>'+esc(target.owner_name)+'</b>':'<span class="admin-plan-error">'+esc(rowLine(row))+'<br>待确认提报人</span>')+'</td>'+(editing?inputRow(row,index,busy):'<td>'+richRow(row,'mod')+'</td><td>'+richRow(row,'name')+'</td><td>'+esc(row.due || '未设日期')+'</td>')+(batch?'<td>'+(editing?'<textarea aria-label="第'+(index+1)+'项月度完成情况" oninput="AdminPlans.edit('+index+',\'progress\',this.value)"'+(busy?' disabled':'')+'>'+esc(row.progress || '')+'</textarea>':esc(row.progress || '原表未填写'))+'</td>':'')+'<td><div class="admin-plan-row-issue">'+esc(issue)+'</div></td></tr>';}).join('')+'</tbody></table>'+(visible.length?'':'<p class="admin-plan-empty">当前筛选下没有事项，完整预览仍保留。</p>')+'</div>'+pager('excel',visible.length,previewPage)
      +(groups.length && !(isAI && state.saved)?'<section id="admin-plan-save-range" tabindex="-1"><h3>保存范围</h3><div class="admin-plan-map">'+groups.map(function(group,index){var plan=existing(group.target);return '<article class="admin-plan-existing"><b>'+esc(group.target.line)+' · '+esc(group.target.owner_name)+' · '+group.rows.length+' 项</b>'+(plan?plan.editable!==true?'<span class="admin-plan-error">'+esc(plan.lock_reason || '已有计划已被引用，不允许修改')+'</span>':'<span>已有 '+(plan.items || []).length+' 项计划</span><label>已有计划处理<select aria-label="'+esc(group.target.owner_name)+'已有计划处理" onchange="AdminPlans.choice('+esc(JSON.stringify(group.key))+',this.value)"'+(busy?' disabled':'')+'>'+options([{value:'append',label:'保留已有事项，追加本次事项'},{value:'replace',label:'用本次事项替换未引用计划'}],importChoices.get(group.key) || '','请选择追加或替换')+'</select></label>':'<span class="muted">新建该提报人的月计划</span>')+'</article>';}).join('')+'</div></section>':'')
      +(isAI && !state.saved?blockersHtml():'')
      +'<div class="admin-plan-savebar"><span class="muted">'+(batch?'按上方月份勾选保存；月度汇总与每周填报分别保留。':isAI && state.saved?'已保存本次计划。':'将保存 '+groups.length+' 份月计划，'+selected+' 项已选事项。未勾选项不导入。')+'</span><button type="button" class="btn primary" onclick="AdminPlans.save()"'+((batch?busy || batch.saved:busy || unresolved || !selected || planBlocked || imported.rows.some(function(row){return !!rowIssue(row);}) || isAI && (state.saved || blockers().length))?' disabled':'')+'>'+(busy?'处理中…':batch?batch.saved?'本次已保存':'确认保存所选月份':isAI?state.saved?'本次已导入':'一次确认导入全部计划':'确认保存所选计划')+'</button></div>';
  }
  function richRow(row,field) { return cfg.richItem?cfg.richItem(row,field,row[field] || ''):esc(row[field] || ''); }
  function sourceHtml(row) {
    var source=row.source || {},refs=row.source_refs || [],cells=refs.filter(function(ref){return typeof ref==='string';}).map(function(ref){return ref.slice(ref.lastIndexOf('!')+1);}).filter(function(ref){return /^[A-Z]+\d+$/.test(ref);});
    var text=cells.length?[source.sheet,Array.from(new Set(cells)).join('、')].filter(Boolean).join(' · '):[source.sheet,source.cell || source.row].filter(Boolean).join(' · ');
    var summary=[source.sheet,source.row?'第 '+source.row+' 行':source.cell || cells[0]].filter(Boolean).join(' · ') || '来源详情';
    return '<details class="admin-plan-source-details"><summary>'+esc(summary)+'</summary><div>'+esc(text)+'</div><div>原表专业：'+esc(row.line_hint || '未填写')+'</div><div>原表工作责任人（参考）：'+esc(row.reporter_hint || '未填写')+'</div>'+(row.exclusion_reason?'<p>'+(row.included?'识别说明：':'排除原因：')+esc(row.exclusion_reason)+'</p>':'')+row.warnings.map(function(warning){return '<p>'+esc(warning.message || warning)+'</p>';}).join('')+(row.manual_fields.length?'<div>已按管理员明确纠正</div>':'')+'</details>';
  }
  function assignmentReviewHtml() {
    var state=aiState();if(state.saved || !state.questions.length || assignmentGroups().length || !confirmedAssignmentGroups().length)return '';
    return '<section class="notice admin-plan-assignment-review"><b>分配已应用到预览，还需复核剩余问题</b><p>点击复核，让 AI 保持你已确认的分配并核对其他问题。此操作不会导入计划。</p><button id="admin-plan-ai-review" type="button" class="btn primary" onclick="AdminPlans.reviewAssignments()"'+(busy || state.requiresSync || state.serverBusy || state.manualDirty?' disabled':'')+'>复核已确认分配</button></section>';
  }
  function questionText(question) { return typeof question==='string'?question:question.message || question.question || question.text || ''; }
  function aiRecoveryHtml() {
    var state=aiState();if(state.ai_status!=='needs_retry')return '';
    return '<section class="notice warn admin-plan-ai-recovery"><b>原表已读取，AI 整理暂未完成</b><p>'+esc(state.ai_error && state.ai_error.message || '已保留原表解析事项和当前会话，可继续整理，无需重新上传文件。')+'</p><button id="admin-plan-ai-retry" type="button" class="btn" onclick="AdminPlans.retryAI()"'+(busy || state.requiresSync || state.serverBusy || state.saved?' disabled':'')+'>重试 AI 整理，保留当前预览</button></section>';
  }
  function excelUploadHtml() {
    var file=excelFiles.get(excelFileKey());
    return '<div class="admin-plan-upload"><div class="admin-plan-file-picker"><label for="admin-plan-file"><b>选择 Excel 文件</b></label><input id="admin-plan-file" type="file" accept=".xlsx" aria-describedby="admin-plan-file-help" onchange="AdminPlans.upload(this)"'+(busy?' disabled':'')+'></div>'
      +'<div class="admin-plan-selected-file">'+(file?'<b>'+esc(file.name)+'</b><span>已保留所选文件'+(!project?'，请选择项目后读取预览':'，可重新读取预览')+'</span>':'<span>支持 .xlsx，最大 300 MB。可先选择文件，再选择项目。</span>')+'</div>'
      +(file?'<button type="button" class="btn primary" onclick="AdminPlans.startExcel()"'+(busy || !project?' disabled':'')+'>读取 Excel 预览</button>':'')
      +'<p id="admin-plan-file-help" class="'+(!project?'admin-plan-prerequisite':'muted')+'">'+(busy?'正在处理，请稍候…':!project?'请先在上方选择项目。文件可以先选，选择项目后再点击“读取 Excel 预览”。':'选取文件后自动生成预览，不调用AI；核对全部专业和事项，最终确认后才会保存。')+'</p>'
      +(!project?'<button type="button" class="admin-plan-link" onclick="AdminPlans.focusSection(\'admin-plan-project\')">前往选择项目</button>':'')+'</div>';
  }
  function aiUploadHtml() {
    var state=aiState(),file=state.selectedFile,waiting=aiOperation && aiOperation.kind==='upload';
    return '<div class="admin-plan-upload"><div class="admin-plan-file-picker"><label for="admin-plan-file"><b>选择整份项目 Excel</b></label><input id="admin-plan-file" type="file" accept=".xlsx" aria-describedby="admin-plan-ai-file-help" onchange="AdminPlans.upload(this)"'+(busy?' disabled':'')+'></div>'
      +'<div class="admin-plan-selected-file">'+(file?'<b>'+esc(file.name)+'</b><span>'+Math.max(1,Math.ceil(file.size/1024))+' KB · 已保留所选文件，可原地重试</span>':'<span>先选文件，再点击“开始识别”；选择文件不会发起请求。</span>')+'</div>'
      +'<button id="admin-plan-ai-start" type="button" class="btn primary" onclick="AdminPlans.startAI()"'+(busy || !project || !file?' disabled':'')+'>'+(waiting?'正在识别…':state.uploadFailed?'重试识别所选文件':state.conversation_id?'重新识别所选文件':'开始识别')+'</button>'
      +'<p id="admin-plan-ai-file-help" class="muted">'+(!project?'请先在上方选择项目；文件可先选择，选好项目后再开始识别。':'支持 .xlsx，最大 300 MB。识别、分配和聊天只更新预览，最终确认后才保存。')+'</p>'
      +(aiOperation?'<div class="admin-plan-working" role="status"><b>'+(waiting?'正在读取工作簿并请求 AI 整理':'正在更新当前预览')+'</b><span>已等待 <span id="admin-plan-ai-elapsed">'+elapsedLabel()+'</span>；处理时间取决于表格内容和网络，请保留此页。</span><button type="button" class="btn ghost sm" onclick="AdminPlans.cancelAI()">取消整理，保留预览</button></div>':'')+'</div>';
  }
  function aiPanelHtml() {
    var state=aiState(),scope=currentTargets()[0],label=scope?scope.project_name+' · '+month:'先选择项目和月份';
    return '<aside class="admin-plan-ai-panel" aria-labelledby="admin-plan-ai-heading"><header class="planning-ai-header"><span class="planning-ai-brand" aria-hidden="true">AI</span><div class="planning-ai-headings"><h2 id="admin-plan-ai-heading">批量导入助手</h2><p>'+esc(label)+'</p></div></header>'
      +'<div id="admin-plan-ai-log" class="planning-ai-log" role="log" aria-label="批量导入 AI 对话" aria-live="polite">'+(!state.messages.length?'<div class="admin-plan-ai-welcome"><h3>整份上传，一起确认</h3><p>我会识别各专业计划，按项目和专业匹配系统提报人。专业对应多位提报人、专业不明、日期或月份不明确时，会在这里向你确认。</p><p class="planning-ai-note">可继续说：“设计事项分给某某”“这一段是下月计划”“第 8 行填报专业需要调整”。</p></div>':'')
      +state.messages.map(function(message){return '<div class="planning-ai-message'+(message.role==='user'?' is-user':'')+'"><span class="planning-ai-avatar" aria-hidden="true">'+(message.role==='user'?'我':'AI')+'</span><div class="planning-ai-bubble"><div class="planning-ai-content">'+esc(message.content)+'</div>'+(message.file_name?'<small class="planning-ai-note">附件：'+esc(message.file_name)+'</small>':'')+'</div></div>';}).join('')
      +(aiOperation?'<p class="planning-ai-working" role="status">'+(aiOperation.kind==='upload'?'正在阅读整份 Excel、识别专业并匹配提报人…':'正在整理补充要求与更新预览…')+'</p>':'')+'</div>'
      +'<footer class="planning-ai-footer">'+(state.questions.length?'<div class="admin-plan-ai-questions"><b>需要你补充确认</b><ul>'+state.questions.map(function(question){return '<li>'+esc(questionText(question))+'</li>';}).join('')+'</ul><p>可先在左侧按专业确认分配；仍有问题时，在此补充说明并发送。</p></div>':'')
      +(state.error?'<div class="planning-ai-error" role="alert">'+esc(state.error)+'</div>':'')
      +(state.withdrawn?'<p class="planning-ai-receipt">本轮已撤回，原预览保留；上传新文件可开始新导入。</p>':state.saved?'<p class="planning-ai-receipt">本轮已保存 '+state.savedCount+' 份计划。上传新文件可开始下一次识别。</p>':'')
      +'<label class="admin-plan-ai-input-label" for="admin-plan-ai-input">继续补充要求或澄清识别问题</label><div class="planning-ai-composer"><textarea id="admin-plan-ai-input" class="planning-ai-input" rows="3" maxlength="6000" oninput="AdminPlans.aiInput(this.value)" onkeydown="AdminPlans.aiKey(event)" placeholder="例如：开发报建由张某提报，设计事项由李某提报"'+(state.saved?' disabled':'')+'>'+esc(state.input)+'</textarea>'
      +(aiOperation?'<button type="button" class="planning-ai-cancel" onclick="AdminPlans.cancelAI()">取消整理</button>':'<button type="button" class="planning-ai-primary" onclick="AdminPlans.sendAI()"'+(busy || !project || state.saved?' disabled':'')+'>发送</button>')+'</div>'
      +(state.conversation_id?'<button type="button" class="planning-ai-text-button" onclick="AdminPlans.syncAI()"'+(busy?' disabled':'')+'>重读 AI 预览</button>':'')
      +'<small class="planning-ai-note">上传、对话和手动纠正只更新预览。最后点击“一次确认导入全部计划”才保存。Ctrl+Enter 发送。</small></footer></aside>';
  }
  function aiRegionsHtml() {
    var state=aiState();if(!state.unverified_regions.length)return '';
    return '<details id="admin-plan-ai-regions" class="notice warn admin-plan-ai-regions" tabindex="-1"'+(state.regionOpen?' open':'')+'><summary>待确认 '+state.unverified_regions.length+' 个范围的计划月份</summary><p>AI 无法代你确认缺少明确月份标注的内容。仅勾选已核对属于 '+esc(month)+' 的范围。</p>'
      +state.unverified_regions.map(function(region){return '<label><input type="checkbox" onchange="AdminPlans.selectRegion('+esc(JSON.stringify(region.id))+',this.checked)"'+(state.regions.has(region.id)?' checked':'')+(busy?' disabled':'')+'>确认 '+esc(region.sheet || '工作表')+' '+esc(regionBounds(region.bounds))+' 为 '+esc(month)+' 月计划</label>';}).join('')
      +'<button type="button" class="btn" onclick="AdminPlans.reviseAI(true)"'+(busy?' disabled':'')+'>确认所选月份范围</button></details>';
  }
  function regionBounds(bounds) {
    if(typeof bounds==='string')return bounds;if(!bounds)return '';
    function column(value){if(typeof value==='string' && /^[A-Z]+$/i.test(value))return value.toUpperCase();var n=Number(value),result='';if(!Number.isInteger(n) || n<1 || n>16384)return '';while(n){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
    var cols=[column(bounds.start_col),column(bounds.end_col)].filter(Boolean).join('–');return '第 '+bounds.start_row+'–'+bounds.end_row+' 行'+(cols?'（'+cols+' 列）':'');
  }
  function aiCoverageHtml() {
    var state=aiState();if(!state.conversation_id)return '';
    var required=state.coverage.reduce(function(total,region){return total+(region.required_rows || []).length;},0),handled=state.coverage.reduce(function(total,region){return total+(region.handled_rows || []).length;},0);
    var pending=state.unprocessed_rows.length,rows=state.unprocessed_rows.slice(state.pendingPage*pageSize,(state.pendingPage+1)*pageSize);
    return '<details id="admin-plan-ai-coverage" class="notice'+(pending || !state.complete?' warn':'')+' admin-plan-ai-coverage" tabindex="-1"'+(state.coverageOpen?' open':'')+'><summary>源内容核对 · '+(required?'已处理 '+handled+' / '+required+' 行源内容':state.complete?'本次识别已完成':'本次识别尚未完成')+(pending?' · 尚有 '+pending+' 行未处理':'')+'</summary>'
      +(state.serverBusy?'<p>上次整理仍在服务器处理中，可稍后点击“重读 AI 预览”。</p>':'')
      +(pending?'<p>以下源行还没有明确识别为计划或说明，当前不能导入。请在对话中继续核对，避免遗漏。</p><button type="button" class="btn" onclick="AdminPlans.continueAI()"'+(busy || state.serverBusy?' disabled':'')+'>让 AI 继续核对未处理内容</button><div class="admin-plan-scroll"><table class="admin-plan-unprocessed"><thead><tr><th>工作表 / 行号</th><th>尚未处理的原文</th></tr></thead><tbody>'+rows.map(function(row){return '<tr><td>'+esc(row.source && row.source.sheet || '')+' · '+esc(row.source && row.source.row || row.source_row || '')+'</td><td>'+(row.cells || []).map(function(cell){return '<div><b>'+esc(cell.cell || '')+'</b> '+esc(cell.text || '')+'</div>';}).join('')+'</td></tr>';}).join('')+'</tbody></table></div>'+(pending>pageSize?'<div class="actions"><button type="button" class="btn ghost sm" onclick="AdminPlans.pendingPage(-1)"'+(busy || state.pendingPage===0?' disabled':'')+'>上一页源行</button><span>第 '+(state.pendingPage+1)+' / '+Math.ceil(pending/pageSize)+' 页</span><button type="button" class="btn ghost sm" onclick="AdminPlans.pendingPage(1)"'+(busy || (state.pendingPage+1)*pageSize>=pending?' disabled':'')+'>下一页源行</button></div>':''):'')+'</details>';
  }
  function aiHistoryHtml() {
    var state=aiState();if(!state.history.length)return '';
    return '<details class="notice admin-plan-ai-history"><summary>保留的原预览副本（'+state.history.length+' 次）</summary>'+state.history.map(function(entry){return '<details><summary>'+esc(entry.label)+' · '+entry.preview.rows.length+' 项</summary>'+entry.preview.rows.slice(0,20).map(function(row){return '<article><b>'+richRow(row,'mod')+'</b><div>'+richRow(row,'name')+'</div><small>'+esc(row.due || '未设日期')+'</small></article>';}).join('')+'<details><summary>完整原预览备份（含全部事项及格式）</summary><textarea readonly rows="5" aria-label="原导入预览备份">'+esc(JSON.stringify(entry.preview,null,2))+'</textarea></details></details>';}).join('')+'</details>';
  }
  function pageHtml() {
    if(!allowed())return '<div class="card empty">没有管理员计划维护权限。</div>';
    var unique=new Map();catalog.targets.forEach(function(target){unique.set(projectKey(target),{value:projectKey(target),label:target.project_name});});
    var lines=professionLines(),people=currentTargets().filter(function(target){return target.line===line;}).map(function(target){return {value:target.owner_id,label:target.owner_name};});
    var scopeBusy=busy && !aiOperation;
    return '<div class="admin-plans-page'+(mode==='ai'?' is-ai':'')+'"><section class="card"><div class="cardbody"><div class="admin-plans-heading"><div><h2>代填与批量导入计划</h2><p class="muted">上传整份项目月计划，自动识别各专业并匹配已授权提报人，核对预览后一次确认导入。</p></div><button type="button" class="btn ghost" onclick="AdminPlans.reload()"'+(busy?' disabled':'')+'>重新读取计划</button></div>'
      +'<div class="admin-plans-tabs admin-plan-modes" role="group" aria-label="计划导入与维护"><button type="button" class="btn'+(mode==='excel'?' primary':'')+'" aria-pressed="'+(mode==='excel')+'" onclick="AdminPlans.select(\'mode\',\'excel\')"'+(scopeBusy?' disabled':'')+'>Excel 直接导入</button><button type="button" class="btn'+(mode==='ai'?' primary':'')+'" aria-pressed="'+(mode==='ai')+'" onclick="AdminPlans.select(\'mode\',\'ai\')"'+(scopeBusy?' disabled':'')+'>AI 整项目批量导入</button><button type="button" class="btn'+(mode==='manual'?' primary':'')+'" aria-pressed="'+(mode==='manual')+'" onclick="AdminPlans.select(\'mode\',\'manual\')"'+(scopeBusy?' disabled':'')+'>手工代填</button><button type="button" class="btn'+(mode==='saved'?' primary':'')+'" aria-pressed="'+(mode==='saved')+'" onclick="AdminPlans.select(\'mode\',\'saved\')"'+(scopeBusy?' disabled':'')+'>已保存内容 / 修改</button><button type="button" class="btn'+(mode==='history'?' primary':'')+'" aria-pressed="'+(mode==='history')+'" onclick="AdminPlans.select(\'mode\',\'history\')"'+(scopeBusy?' disabled':'')+'>导入记录 / 撤回</button></div>'
      +'<div class="admin-plans-tabs" role="group" aria-label="项目类型"><button type="button" class="btn'+(type==='res'?' primary':'')+'" aria-pressed="'+(type==='res')+'" onclick="AdminPlans.select(\'type\',\'res\')"'+(scopeBusy?' disabled':'')+'>住宅计划</button><button type="button" class="btn'+(type==='com'?' primary':'')+'" aria-pressed="'+(type==='com')+'" onclick="AdminPlans.select(\'type\',\'com\')"'+(scopeBusy?' disabled':'')+'>商业计划</button></div>'
      +'<div class="admin-plan-selectors'+(mode==='manual'?'':' is-batch')+'"><label for="admin-plan-project">项目<select id="admin-plan-project" onchange="AdminPlans.select(\'project\',this.value)"'+(scopeBusy?' disabled':'')+'>'+options(Array.from(unique.values()),project,ready?'选择项目':'正在读取项目…')+'</select></label>'
      +(mode==='manual'?'<label for="admin-plan-line">'+(type==='com'?'商业模块':'住宅专业')+'<select id="admin-plan-line" onchange="AdminPlans.select(\'line\',this.value)"'+(busy || !project?' disabled':'')+'>'+options(lines.map(function(value){return {value:value,label:professionLabel(value)};}),line,'选择专业 / 模块')+'</select></label><label for="admin-plan-owner">提报人<select id="admin-plan-owner" onchange="AdminPlans.select(\'owner\',this.value)"'+(busy || !line?' disabled':'')+'>'+options(people,owner,'选择单个提报人')+'</select></label>':'')
      +'<label for="admin-plan-month">'+(mode==='excel'?'本月 / 会议汇总月':'计划月份')+'<input id="admin-plan-month" type="month" value="'+esc(mode==='excel'?batchBase || month:month)+'" onchange="AdminPlans.select(\'month\',this.value)"'+(scopeBusy?' disabled':'')+'>'+(mode==='excel'?'<small class="muted">下月 '+esc(nextMonth(batchBase || month))+' 自动分区识别</small>':'')+'</label></div>'
      +(mode==='excel'?'<fieldset class="admin-month-range"><legend>本次导入范围</legend><label><input type="radio" name="admin-month-range" value="pair" onchange="AdminPlans.batchRange(this.value)"'+(batchMode==='pair'?' checked':'')+(busy?' disabled':'')+'>本月计划及完成情况 ＋ 下月工作计划</label><label><input type="radio" name="admin-month-range" value="single" onchange="AdminPlans.batchRange(this.value)"'+(batchMode==='single'?' checked':'')+(busy?' disabled':'')+'>仅所选单月计划</label><p>按Excel正文月份标题分组；完成日期跨月的事项仍留在原标题月份。</p></fieldset>':'')
      +'<p class="muted">'+(mode==='history'?'选择保存批次，核对完整范围后撤回本次导入。':mode==='saved'?'选择项目和月份，可直接修改已保存的月计划或独立月度完成汇总。':mode==='manual'?'手工代填按单个提报人维护，与本人月计划共用同一数据。':mode==='excel'?'直接读取Excel，无需调用AI。专业简称自动匹配，少量疑点集中核对，最后一次确认导入。':'批量导入按项目和专业匹配系统提报人，无需预选个人。同专业多人、专业不明、日期或月份不明确时，可通过对话或手动纠正处理。')+'未保存内容暂存在此窗口，刷新或关闭前请先保存。</p>'
      +(error?'<p class="notice err admin-plan-status" role="alert">'+esc(error)+'</p>':'')+'</div></section>'
      +'<div class="'+(mode==='ai'?'admin-plan-ai-layout':'')+'"><section class="card"><div class="cardbody">'
      +(mode==='history'?historyHtml():mode==='saved'?savedHtml():mode==='manual'?manualHtml():(mode==='ai'?aiUploadHtml():excelUploadHtml())+monthBundleHtml()+previewHtml()+(mode==='ai'?aiHistoryHtml():''))+'</div></section>'+(mode==='ai'?aiPanelHtml():'')+'</div></div>';
  }
  global.AdminPlans={configure:configure,load:load,pageHtml:pageHtml,capture:capture,binding:binding,select:select,edit:edit,add:add,remove:remove,latest:latest,page:page,upload:upload,setMapping:setMapping,mapGroup:mapGroup,include:include,choice:choice,save:save,
    batchMonth:batchMonth,batchOption:batchOption,batchRange:batchRange,batchUnknown:batchUnknown,startExcel:startExcel,openSaved:openSaved,savedAdd:savedAdd,savedRemove:savedRemove,savedLatest:savedLatest,
    aiInput:aiInput,aiKey:aiKey,sendAI:sendAI,startAI:startAI,retryAI:function(){return sendAI('请继续整理已上传的整份本月计划，核对全部专业、事项与系统提报人，保留已确认的人工分配；原表工作责任人仅供参考。');},cancelAI:function(){cancelAI();},syncAI:syncAI,reviseAI:reviseAI,selectRegion:selectRegion,toggleAdvanced:toggleAdvanced,continueAI:continueAI,pendingPage:pendingPage,
    chooseAssignment:chooseAssignment,applyAssignment:applyAssignment,confirmProfession:confirmProfession,confirmAllProfessions:confirmAllProfessions,reviewAssignments:reviewAssignments,filterPreview:filterPreview,focusSection:focusSection,
    loadBatches:loadBatches,withdrawBatch:withdrawBatch,reload:async function(){if(busy)return;flush();var loaded=await load(null,true);if(mode==='history')await loadBatches();return loaded;}};
  if(global.addEventListener)global.addEventListener('beforeunload',function(event){
    if(allowed() && (busy || excelFiles.size || Array.from(savedDrafts.values()).some(function(entry){return entry.dirty || entry.recovery;}) || imported && !imported.saved || Array.from(importDrafts.values()).some(function(entry){return !entry.preview.saved;}) || Array.from(drafts.values()).some(function(entry){return entry.dirty || entry.recovery;}) || Array.from(aiStates.values()).some(function(state){return state.input || state.manualDirty || state.selectedFile;}))){event.preventDefault();event.returnValue='';}
  });
})(window);
