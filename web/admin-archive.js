/* 管理员项目档案维护；分类与展示复用填报端，草稿只驻留当前会话内存。 */
(function (global) {
  'use strict';
  var context, identity, drafts = Object.create(null), nextRow = 0;
  var tabs = ['plan','basic','planning','products','areas','units','standards'];
  var fieldsByTab = {
    plan: [['current_version','当前项目版本']],
    basic: [['city','所在城市'],['owner_company','开发主体'],['open_date','预计首次开盘'],['handover_date','预计首批交付'],['land_cost','土地款（万元）'],['target_cost','目标总成本（万元）'],['target_price','整盘均价（元/㎡）']],
    planning: [['area','用地面积（㎡）'],['gfa','总建筑面积（㎡）'],['plot_gfa','计容建筑面积（㎡）'],['far','容积率'],['floors','楼栋 / 层数'],['parking','车位（个）']],
    products: [['mix','业态构成'],['floors','楼栋 / 层数'],['parking','车位（个）']],
    areas: [['product_area_total','产品总面积（㎡）']], units: [['unit_types_total','户型总套数']], standards: [['fitout','装修 / 交付标准']]
  };
  var phaseColumns = [['name','分期名称'],['area','用地（㎡）'],['gfa','建面（㎡）'],['units_total','总套数'],['units_launched','已推'],['units_sold','已售'],['avg_price','均价（元/㎡）'],['value','货值（万元）'],['plan_handover','计划交付']];
  function own(value,key) { return Object.prototype.hasOwnProperty.call(value,key); }
  function keyOf(pid,tab) { return JSON.stringify([pid,tab]); }
  function tabOf(ctx) { return tabs.indexOf(ctx.tab) >= 0 ? ctx.tab : 'plan'; }
  function state(ctx) {
    var key=keyOf(ctx.pid,tabOf(ctx));
    return drafts[key] || (drafts[key]={patch:{},phases:{},drawing:{kind:'项目总图',version:'预售版',name:'',url:'',file:null},busy:false,error:'',notice:''});
  }
  function reset() { context=null;identity=null;drafts=Object.create(null);nextRow=0; }
  function mergeFields(source,patch) {
    var result=Object.assign({},source || {},patch),previous=source && source.rich_text,changed=patch && patch.rich_text;
    if(previous || changed) {
      var formats=Object.assign({},previous && previous.fields || {},changed && changed.fields || {});
      if(own(patch,'fitout') && !(changed && changed.fields && own(changed.fields,'fitout')))delete formats.fitout;
      result.rich_text=Object.assign({},previous || {},changed || {},{fields:formats});
    }
    return result;
  }
  function mergedFields(ctx,draft) { return mergeFields(ctx.fields || {},draft.patch); }
  function esc(value) { return context.helpers.esc(value); }
  function number(value,integer) {
    if(typeof value !== 'string' && typeof value !== 'number')return null;
    if(typeof value==='string' && !/^\d+(?:\.\d+)?$/.test(value.trim()))return null;
    var n=Number(value);return isFinite(n) && n>=0 && (!integer || Math.floor(n)===n)?n:null;
  }
  function phaseTotal(ctx) {
    if(!(ctx.phases || []).length)return null;
    var total=0,valid=true;(ctx.phases || []).forEach(function(row){var n=number(row.units_total,true);if(n===null)valid=false;else total+=n;});return valid?total:null;
  }
  function ratioInfo(ctx,draft) {
    var fields=mergedFields(ctx,draft),units=tabOf(ctx)==='units',name=units?'unit_types':'products',column=units?'units':'area';
    var rows=Array.isArray(fields[name])?fields[name]:[],total=number(fields[units?'unit_types_total':'product_area_total'],units),sum=0,valid=rows.length>0;
    if(units && total===null)total=phaseTotal(ctx);
    rows.forEach(function(row){var n=number(row && row[column],units);if(!row || typeof row.name!=='string' || !row.name.trim() || n===null)valid=false;else sum+=n;});
    valid=valid && total!==null && total>0 && Math.abs(sum-total)<(units?0.5:0.01);
    return {rows:rows,column:column,valid:valid,total:total,sum:sum};
  }
  function updateRatios() {
    if(!context || !global.document)return;
    var draft=state(context),info=ratioInfo(context,draft),cells=document.querySelectorAll('.admin-archive [data-aa-ratio]');
    for(var i=0;i<cells.length;i++){var index=Number(cells[i].getAttribute('data-aa-ratio'));cells[i].textContent=info.valid?Math.round(number(info.rows[index][info.column],info.column==='units')/info.total*1000)/10+'%':'待核对';}
    var hint=document.getElementById('adminArchiveRatioHint');if(hint)hint.textContent=info.valid?'明细合计与总量一致，可计算占比。':'明细或分母未完整登记，或合计不一致，暂不计算占比。';
  }
  function capture() {
    if(!context || !context.editable || !global.document)return;
    var panel=document.querySelector('.admin-archive');if(!panel)return;
    var values=panel.querySelectorAll('[data-aa-field]');
    for(var i=0;i<values.length;i++)field(values[i].getAttribute('data-aa-field'),values[i].value);
  }
  function plainField(ctx,draft,name,value) {
    var source=ctx.fields || {};
    if(String(source[name] == null?'':source[name])===String(value))delete draft.patch[name];else draft.patch[name]=value;
  }
  function richDoc(ctx,draft,name) {
    var fields=mergedFields(ctx,draft),model=global.ZHRichText;
    return model.doc(fields,name) || model.legacy(fields[name]);
  }
  function richField(ctx,draft,name,doc) {
    var model=global.ZHRichText,source=ctx.fields || {},previous=model.doc(source,name) || model.legacy(source[name]);
    var changed=draft.patch.rich_text && draft.patch.rich_text.fields || {};
    if(JSON.stringify(previous)===JSON.stringify(doc) && String(source[name] == null?'':source[name])===model.text(doc))delete changed[name];else changed[name]=doc;
    if(Object.keys(changed).length)draft.patch.rich_text={v:1,fields:changed};else delete draft.patch.rich_text;
  }
  function field(name,value) {
    if(!context || !context.editable)return;var draft=state(context);if(draft.busy)return;
    var previous=name==='fitout' && global.ZHRichText ? richDoc(context,draft,name) : null;
    plainField(context,draft,name,value);
    if(previous && !global.ZHRichText.fit(previous,value))richField(context,draft,name,global.ZHRichText.normalize({ops:[{insert:String(value)}]}));
    draft.notice='';updateRatios();
  }
  function binding(id) {
    if(id!=='aa_fitout' || !context || tabOf(context)!=='standards' || !context.editable || !global.ZHRichText)return null;
    var ctx=context,draft=state(ctx),scopeIdentity=identity,model=global.ZHRichText;
    return {get:function(){return richDoc(ctx,draft,'fitout');},set:function(doc){
      if(identity!==scopeIdentity || !context || !context.editable || !ctx.editable || context.pid!==ctx.pid || tabOf(context)!=='standards' || state(context)!==draft || draft.busy)return;
      doc=model.normalize(doc);if(!doc)return;
      plainField(ctx,draft,'fitout',model.text(doc));richField(ctx,draft,'fitout',doc);draft.notice='';
    }};
  }
  function arrayRows(ctx,draft,name) {
    var source=own(draft.patch,name)?draft.patch[name]:(ctx.fields || {})[name];
    return Array.isArray(source)?source:[];
  }
  function editArray(name,index,column,value) {
    if(!context || !context.editable)return;var draft=state(context),rows=arrayRows(context,draft,name).map(function(row){return row && typeof row==='object' && !Array.isArray(row)?Object.assign({},row):row;});
    rows[index]=Object.assign({},rows[index] && typeof rows[index]==='object'?rows[index]:{});rows[index][column]=value;draft.patch[name]=rows;draft.notice='';updateRatios();
  }
  function redraw(ctx) { return Promise.resolve(ctx.onChanged && ctx.onChanged()); }
  function addArray(name) {
    if(!context || !context.editable)return;capture();var draft=state(context),rows=arrayRows(context,draft,name).slice();rows.push(name==='products'?{name:'',area:''}:{name:'',units:''});draft.patch[name]=rows;draft.notice='';redraw(context);
  }
  function removeArray(name,index) { if(!context || !context.editable)return;capture();var draft=state(context),rows=arrayRows(context,draft,name).slice();rows.splice(index,1);draft.patch[name]=rows;redraw(context); }
  function phaseKey(row) { return 'id_'+String(row.id); }
  function phaseRows(ctx,draft) {
    var rows=(ctx.phases || []).map(function(row){var key=phaseKey(row);return {key:key,row:Object.assign({},row,draft.phases[key] && draft.phases[key].patch || {})};});
    Object.keys(draft.phases).forEach(function(key){if(draft.phases[key].fresh)rows.push({key:key,row:Object.assign({},draft.phases[key].patch)});});return rows;
  }
  function phaseField(key,column,value) {
    if(!context || !context.editable)return;var draft=state(context),entry=draft.phases[key] || (draft.phases[key]={patch:{}});
    var source=(context.phases || []).filter(function(row){return phaseKey(row)===key;})[0] || {};
    if(!entry.fresh && String(source[column]==null?'':source[column])===String(value))delete entry.patch[column];else entry.patch[column]=value;
    if(!entry.fresh && !Object.keys(entry.patch).length)delete draft.phases[key];draft.notice='';
  }
  function addPhase() { if(!context || !context.editable)return;capture();var draft=state(context);draft.phases['new_'+(++nextRow)]={fresh:true,patch:{name:''}};redraw(context); }
  function drawingField(name,value) { if(!context || !context.editable)return;state(context).drawing[name]=value; }
  function drawingFile(input) { if(!context || !context.editable)return;state(context).drawing.file=input.files && input.files[0] || null; }
  function pickProject(pid) { capture();global.App.masterPick(pid); }
  function pickTab(tab) { capture();if(tabs.indexOf(tab)>=0)global.App.reporterArchiveTab(tab); }
  async function perform(operation,success) {
    var ctx=context,draft=state(ctx),scopeIdentity=identity;if(!ctx.editable || draft.busy)return;
    capture();draft.busy=true;draft.error='';draft.notice='';await redraw(ctx);
    try { await operation(ctx,draft);if(identity===scopeIdentity)draft.notice=success; }
    catch(error) { if(identity===scopeIdentity)draft.error=error && error.message || '保存失败，请重试；输入已保留。'; }
    finally { draft.busy=false;if(identity===scopeIdentity)await redraw(ctx); }
  }
  function validatePatch(patch) {
    for(var name of ['product_area_total','unit_types_total'])if(own(patch,name) && patch[name]!=='' && number(patch[name],name==='unit_types_total')===null)throw new Error(name==='unit_types_total'?'户型总套数须为非负整数。':'产品总面积须为非负数。');
    for(var entry of [['products','area'],['unit_types','units']])if(own(patch,entry[0])) {
      if(!Array.isArray(patch[entry[0]]))throw new Error('请核对明细格式。');
      patch[entry[0]].forEach(function(row,index){if(!row || typeof row.name!=='string' || !row.name.trim())throw new Error('第'+(index+1)+'行请填写名称。');if(row[entry[1]]!=='' && row[entry[1]]!=null && number(row[entry[1]],entry[1]==='units')===null)throw new Error('第'+(index+1)+'行的'+(entry[1]==='units'?'套数须为非负整数。':'面积须为非负数。'));});
    }
  }
  function saveFields() {
    return perform(async function(ctx,draft){var patch=JSON.parse(JSON.stringify(draft.patch));validatePatch(patch);if(!Object.keys(patch).length)throw new Error('当前分类没有待保存的修改。');await ctx.saveFields(patch,ctx.pid);Object.keys(patch).forEach(function(key){if(JSON.stringify(draft.patch[key])===JSON.stringify(patch[key]))delete draft.patch[key];});},'当前分类已保存。');
  }
  function savePhases() {
    return perform(async function(ctx,draft){var keys=Object.keys(draft.phases);if(!keys.length)throw new Error('分期资料没有待保存的修改。');
      for(var i=0;i<keys.length;i++) {
        var key=keys[i],entry=draft.phases[key],base=(ctx.phases || []).filter(function(row){return phaseKey(row)===key;})[0] || {},row=Object.assign({},base,entry.patch);
        if(!String(row.name || '').trim())throw new Error('请填写分期名称。');
        for(var column of ['units_total','units_launched','units_sold'])if(own(row,column)){if(row[column]==='' || row[column]==null)row[column]=null;else{var n=number(row[column],true);if(n===null)throw new Error('分期套数须为非负整数。');row[column]=n;}}
        row.project_id=ctx.pid;if(entry.fresh)row.sort_order=(ctx.phases || []).length+i;
        await ctx.savePhase(row,ctx.pid);delete draft.phases[key];
      }
    },'分期资料已保存。');
  }
  function deletePhase(key) {
    if(!context || !context.editable)return;var draft=state(context),entry=draft.phases[key];
    if(entry && entry.fresh){delete draft.phases[key];redraw(context);return;}
    var row=(context.phases || []).filter(function(item){return phaseKey(item)===key;})[0];if(!row || !global.confirm('删除该分期资料登记？'))return;
    return perform(async function(ctx,current){await ctx.deletePhase(row.id,ctx.pid);delete current.phases[key];},'分期资料已删除。');
  }
  function uploadDrawing(linkOnly) {
    return perform(async function(ctx,draft){var form=draft.drawing,payload={kind:form.kind,name:String(form.name || '').trim()};
      if(linkOnly){var url=String(form.url || '').trim();if(!/^https?:\/\//i.test(url))throw new Error('链接需以http://或https://开头。');payload.url=url;}
      else{if(!form.file)throw new Error('请选择图纸文件。');if(form.file.size>8*1024*1024)throw new Error('单份图纸不能超过8MiB。');payload.file=form.file;}
      if(!payload.name)payload.name=payload.file?payload.file.name:payload.kind+'（链接）';
      if(payload.kind==='项目总图' && form.version!=='未标注')payload.name=form.version+' · '+payload.name;
      await ctx.uploadDrawing(payload,ctx.pid);form.file=null;form.name='';form.url='';
    },linkOnly?'图纸链接已登记。':'图纸已上传。');
  }
  function deleteDrawing(id) { if(!context || !context.editable || !global.confirm('删除该图纸登记？'))return;return perform(async function(ctx){await ctx.deleteDrawing(id,ctx.pid);},'图纸登记已删除。'); }

  function render(ctx) {
    var incomingIdentity=String(ctx.identity == null?'default':ctx.identity);
    if(identity!==incomingIdentity){reset();identity=incomingIdentity;}context=ctx;
    var readonly=global.ZHReporterArchive.render(ctx);if(!ctx.editable)return readonly;
    var tab=tabOf(ctx),draft=state(ctx),fields=mergedFields(ctx,draft),disabled=draft.busy?' disabled':'';
    function input(name,label,multiline) {
      var value=fields[name]==null?'':fields[name];
      return '<label class="admin-archive-field"><span>'+esc(label)+'</span>'+(multiline?'<textarea id="aa_'+name+'" rows="5" data-rich data-shared-rich-editor aria-label="'+esc(label)+'"':'<input type="text"')+' data-aa-field="'+name+'" oninput="ZHAdminArchive.field(\''+name+'\',this.value)"'+(multiline?'>'+esc(value)+'</textarea>':' value="'+esc(value)+'">')+'</label>';
    }
    function buttons(action,label) { return '<div class="admin-archive-actions"><button type="button" class="btn primary" onclick="ZHAdminArchive.'+action+'()"'+disabled+'>'+label+'</button><span class="hint">未保存输入按项目和分类保留在当前会话。</span></div>'; }
    function arrayEditor(name,column,label) {
      var original=(ctx.fields || {})[name],rows=arrayRows(ctx,draft,name),info=ratioInfo(ctx,draft);
      if(original!=null && !Array.isArray(original) && !own(draft.patch,name))return '<p class="notice warn">现有明细格式需核对，原值保持不变；其他字段仍可维护。</p>';
      return '<div class="tablewrap"><table class="admin-archive-array"><thead><tr><th>'+label+'名称</th><th>'+(column==='units'?'套数':'面积（㎡）')+'</th><th>占比</th><th>操作</th></tr></thead><tbody>'
        +(rows.map(function(row,index){return '<tr><td><input aria-label="'+label+'名称" type="text" value="'+esc(row && row.name || '')+'" oninput="ZHAdminArchive.editArray(\''+name+'\','+index+',\'name\',this.value)"></td><td><input aria-label="'+label+(column==='units'?'套数':'面积')+'" inputmode="decimal" type="text" value="'+esc(row && row[column]!=null?row[column]:'')+'" oninput="ZHAdminArchive.editArray(\''+name+'\','+index+',\''+column+'\',this.value)"></td><td data-aa-ratio="'+index+'">'+(info.valid?Math.round(number(row[column],column==='units')/info.total*1000)/10+'%':'待核对')+'</td><td><button type="button" class="btn ghost sm" onclick="ZHAdminArchive.removeArray(\''+name+'\','+index+')">移除行</button></td></tr>';}).join('') || '<tr><td colspan="4" class="empty">尚未登记'+label+'明细。</td></tr>')+'</tbody></table></div><p class="hint" id="adminArchiveRatioHint">'+(info.valid?'明细合计与总量一致，可计算占比。':'明细或分母未完整登记，或合计不一致，暂不计算占比。')+'</p><button type="button" class="btn ghost sm" onclick="ZHAdminArchive.addArray(\''+name+'\')">＋增加'+label+'</button>';
    }
    function phaseEditor() {
      return '<details class="card admin-archive-phase-editor"><summary>维护分期与销售资料</summary><fieldset'+disabled+'><div class="tablewrap"><table><thead><tr>'+phaseColumns.map(function(column){return '<th>'+esc(column[1])+'</th>';}).join('')+'<th>操作</th></tr></thead><tbody>'
        +(phaseRows(ctx,draft).map(function(item){return '<tr>'+phaseColumns.map(function(column){var value=item.row[column[0]];return '<td><input aria-label="'+esc(column[1])+'" type="text" value="'+esc(value==null?'':value)+'" oninput="ZHAdminArchive.phaseField(\''+item.key+'\',\''+column[0]+'\',this.value)"></td>';}).join('')+'<td><button type="button" class="btn ghost sm" onclick="ZHAdminArchive.deletePhase(\''+item.key+'\')">移除</button></td></tr>';}).join('') || '<tr><td colspan="10" class="empty">暂无分期资料。</td></tr>')+'</tbody></table></div><div class="admin-archive-actions"><button type="button" class="btn ghost" onclick="ZHAdminArchive.addPhase()">＋增加分期</button><button type="button" class="btn primary" onclick="ZHAdminArchive.savePhases()">保存分期资料</button></div></fieldset></details>';
    }
    function drawingEditor() {
      var form=draft.drawing;
      return '<section class="card admin-archive-drawing-editor"><div class="cardhd"><h3>图纸维护</h3><span class="hint">沿用原项目图纸权限，支持图片与PDF，单份不超过8MiB。</span></div><fieldset'+disabled+'><div class="admin-archive-grid"><label class="admin-archive-field"><span>图纸分类</span><select onchange="ZHAdminArchive.drawingField(\'kind\',this.value)">'+['项目总图','分期图','户型图','其他'].map(function(kind){return '<option'+(kind===form.kind?' selected':'')+'>'+kind+'</option>';}).join('')+'</select></label><label class="admin-archive-field"><span>总图版本（总图分类适用）</span><select onchange="ZHAdminArchive.drawingField(\'version\',this.value)">'+['预售版','调整版','未标注'].map(function(version){return '<option'+(version===form.version?' selected':'')+'>'+version+'</option>';}).join('')+'</select></label><label class="admin-archive-field"><span>显示名称</span><input type="text" value="'+esc(form.name)+'" oninput="ZHAdminArchive.drawingField(\'name\',this.value)"></label><label class="admin-archive-field"><span>选择文件'+(form.file?'（已选：'+esc(form.file.name)+'）':'')+'</span><input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf" onchange="ZHAdminArchive.drawingFile(this)"></label></div><div class="admin-archive-actions"><button type="button" class="btn primary" onclick="ZHAdminArchive.uploadDrawing(false)">上传图纸</button></div><label class="admin-archive-field"><span>或登记图片／云盘链接</span><input type="url" value="'+esc(form.url)+'" oninput="ZHAdminArchive.drawingField(\'url\',this.value)" placeholder="https://"></label><div class="admin-archive-actions"><button type="button" class="btn ghost" onclick="ZHAdminArchive.uploadDrawing(true)">登记链接</button></div>'
        +'<div class="admin-archive-drawing-list">'+((ctx.drawings || []).map(function(row){return '<div><span><b>'+esc(row.name || '未命名图纸')+'</b><small>'+esc(row.kind || '其他')+'</small></span><button type="button" class="btn ghost sm" onclick="ZHAdminArchive.deleteDrawing(\''+esc(String(row.id))+'\')">删除登记</button></div>';}).join('') || '<p class="hint">暂无图纸登记。</p>')+'</div></fieldset></section>';
    }
    var editor='<section class="card admin-archive-editor no-print"><div class="cardhd"><h3>维护当前分类</h3><span class="hint">'+(draft.busy?'正在保存…':Object.keys(draft.patch).length?'有尚未保存的修改':'按实际资料维护')+'</span></div>'
      +(draft.error?'<p class="notice err" role="alert">'+esc(draft.error)+'</p>':'')+(draft.notice?'<p class="notice" role="status">'+esc(draft.notice)+'</p>':'')
      +'<fieldset'+disabled+'><div class="admin-archive-grid">'+fieldsByTab[tab].map(function(spec){return input(spec[0],spec[1],spec[0]==='fitout');}).join('')+'</div>'
      +(tab==='products'?arrayEditor('products','area','产品'):tab==='units'?arrayEditor('unit_types','units','户型'):'')
      +(tab==='areas'?'<p class="hint">产品面积明细在“产品构成”维护；分母按实际产品口径登记，未填或与明细不符时不计算占比。</p>':tab==='units'?'<p class="hint">未单独登记总套数时，展示端仅在分期总套数完整时采用分期合计。</p>':'')
      +buttons('saveFields','保存当前分类')+'</fieldset></section>';
    var marker='<div class="reporter-archive-content">',position=readonly.indexOf(marker);
    if(position<0)throw new Error('项目档案展示组件版本不匹配');
    var body=readonly.slice(position+marker.length,-12),prefix=readonly.slice(0,position+marker.length);
    prefix=prefix.replace('class="reporter-archive"','class="reporter-archive admin-archive"').replace('只读：由运营管理员统一维护','管理员维护：分类修改后保存')
      .replace('onchange="App.masterPick(this.value)"','onchange="ZHAdminArchive.pickProject(this.value)"')
      .replace(/onclick="App\.reporterArchiveTab\('([a-z]+)'\)"/g,function(_,key){return 'onclick="ZHAdminArchive.pickTab(\''+key+'\')"';});
    return prefix+editor+(tab==='plan'?drawingEditor()+body:'<details class="card admin-archive-saved"><summary>查看已保存资料的展示效果</summary>'+body+'</details>')
      +(tab==='basic'?phaseEditor():'')+'</div></div>';
  }
  global.ZHAdminArchive={render:render,capture:capture,reset:reset,binding:binding,mergeFields:mergeFields,field:field,editArray:editArray,addArray:addArray,removeArray:removeArray,
    pickProject:pickProject,pickTab:pickTab,saveFields:saveFields,phaseField:phaseField,addPhase:addPhase,savePhases:savePhases,deletePhase:deletePhase,
    drawingField:drawingField,drawingFile:drawingFile,uploadDrawing:uploadDrawing,deleteDrawing:deleteDrawing};
  if(global.addEventListener){var printed=[];global.addEventListener('beforeprint',function(){printed=[];document.querySelectorAll('.admin-archive-saved:not([open])').forEach(function(detail){detail.open=true;printed.push(detail);});});global.addEventListener('afterprint',function(){printed.forEach(function(detail){detail.open=false;});printed=[];});}
})(window);
