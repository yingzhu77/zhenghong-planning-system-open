/* Local-only, version-checked edits with provenance for each AI insertion. */
(function(global){
  'use strict';
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function sourceIdentity(row){return row.monthly_plan_id?[row.monthly_plan_id,row.project_id || '']:[];}
  function signature(row){return JSON.stringify([row.source_id || '',row.mod || '',row.name || '',row.due || '',row.prog || '',row._rich || {},row.rich_text || null].concat(sourceIdentity(row)));}
  function fixed(row){return JSON.stringify([row.source_id || '',row.mod || '',row.name || '',row.due || '',row._rich && row._rich.mod || null,row._rich && row._rich.name || null].concat(sourceIdentity(row)));}
  function indexOf(id){return /^monthly:(0|[1-9]\d*)$/.test(id)?Number(id.slice(8)):-1;}
  function items(rows){return (rows || []).map(function(row,index){return {id:'monthly:'+index,title:String(row.name || ''),progress:String(row.prog || ''),signature:signature(row)};}).filter(function(row){return row.title.trim();});}
  function entries(rows,values){
    var ids={};
    return (Array.isArray(values)?values:[]).filter(function(entry){
      if(!entry || typeof entry.entry_id!=='string' || entry.entry_id.length>100 || ids[entry.entry_id] || typeof entry.id!=='string' || typeof entry.text!=='string' || !entry.text || entry.text.length>6000 || !Number.isSafeInteger(entry.start) || entry.start<0 || !['','\n'].includes(entry.prefix))return false;
      var row=rows[indexOf(entry.id)],value=String(row && row.prog || '');
      if(!row || fixed(row)!==entry.fixed || value.slice(entry.start,entry.start+entry.text.length)!==entry.text || value.slice(entry.start-entry.prefix.length,entry.start)!==entry.prefix)return false;
      ids[entry.entry_id]=true;return true;
    }).map(copy);
  }
  function edit(value,suggestion,entry){
    var operation=suggestion.operation || 'append',addition=suggestion.progress.trim();
    if(operation==='append'){
      if(value.trim()===addition || value.trimEnd().endsWith('\n'+addition))return null;
      var prefix=value && !value.endsWith('\n')?'\n':'';
      return {start:value.length,end:value.length,value:prefix+addition,text:addition,prefix:prefix,operation:operation};
    }
    if(!entry || value.slice(entry.start,entry.start+entry.text.length)!==entry.text || value.slice(entry.start-entry.prefix.length,entry.start)!==entry.prefix)throw new Error('这段AI补充已被手动修改，请核对原文后重新整理。');
    return {start:entry.start-(operation==='remove'?entry.prefix.length:0),end:entry.start+entry.text.length,value:operation==='remove'?'':addition,text:addition,prefix:entry.prefix,operation:operation};
  }
  function preview(context,draft){
    return (draft.items || []).map(function(suggestion){
      var row=context.items.find(function(item){return item.id===suggestion.id;});
      if(!row)throw new Error('建议事项不在当前填报范围。');
      var entry=(context.applied || []).find(function(item){return item.entry_id===suggestion.entry_id && item.id===suggestion.id;});
      var change=edit(row.progress,suggestion,entry);
      return {id:row.id,title:row.title,before:row.progress,after:change?row.progress.slice(0,change.start)+change.value+row.progress.slice(change.end):row.progress,operation:suggestion.operation || 'append'};
    });
  }
  function apply(options){
    var context=options.context,current=options.current,draft=options.draft,rows=options.rows,ledger=options.entries || [];
    if(!context || !current || !current.canEdit || context.key!==current.key || context.identityKey!==current.identityKey)throw new Error('填报范围已变化，请回到当前页面重新整理。');
    if(!draft || !Array.isArray(draft.items) || !draft.items.length || draft.items.length>80)throw new Error('没有待保存的修改，请先整理进展。');
    var seen={},patches=[],nextEntries=entries(rows,ledger),beforeEntries=copy(ledger);
    draft.items.forEach(function(suggestion){
      var operation=suggestion && (suggestion.operation || 'append');
      if(!suggestion || typeof suggestion.id!=='string' || seen[suggestion.id] || !['append','replace','remove'].includes(operation) || typeof suggestion.progress!=='string' || suggestion.progress.length>6000 || operation!=='remove' && !suggestion.progress.trim() || operation==='remove' && suggestion.progress!=='')throw new Error('修改内容不完整，请重新整理。');
      seen[suggestion.id]=true;
      var before=context.items.find(function(item){return item.id===suggestion.id;}),now=current.items.find(function(item){return item.id===suggestion.id;});
      if(!before || !now || before.signature!==now.signature)throw new Error('事项或进展已修改，请重新整理后再保存，原草稿已保留。');
      var row=rows[indexOf(suggestion.id)];
      if(!row || signature(row)!==before.signature)throw new Error('事项位置已变化，请重新整理。');
      var entry=nextEntries.find(function(item){return item.entry_id===suggestion.entry_id && item.id===suggestion.id;});
      if(operation!=='append' && (!(context.applied || []).some(function(item){return entry && item.entry_id===entry.entry_id && item.text===entry.text && item.start===entry.start;})))throw new Error('找不到这段已保存的AI补充，请明确事项后重新整理。');
      var value=String(row.prog || ''),change=edit(value,suggestion,entry);
      if(!change)return;
      var patch={prog:value.slice(0,change.start)+change.value+value.slice(change.end)},rich=options.richText;
      if(rich){var doc=rich.doc(row,'prog') || rich.legacy(value);patch._rich=Object.assign({},row._rich || {},{prog:rich.normalize({ops:rich.slice(doc,0,change.start).ops.concat(change.value?[{insert:change.value}]:[],rich.slice(doc,change.end,value.length).ops)})});}
      var difference=change.value.length-(change.end-change.start);
      nextEntries.forEach(function(other){if(other.id===suggestion.id && other!==entry && other.start>=change.end)other.start+=difference;});
      if(operation==='remove')nextEntries=nextEntries.filter(function(other){return other!==entry;});
      else if(operation==='replace')entry.text=change.text;
      else nextEntries.push({entry_id:global.crypto && global.crypto.randomUUID?global.crypto.randomUUID():'ai-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),id:suggestion.id,text:change.text,start:change.start+change.prefix.length,prefix:change.prefix,fixed:fixed(row)});
      patches.push({index:indexOf(suggestion.id),row:row,before:copy(row),patch:patch});
    });
    if(!patches.length)return {message:'内容已在草稿中，没有重复保存。',count:0};
    var transaction={key:context.key,identityKey:context.identityKey,entriesBefore:beforeEntries,rows:patches.map(function(entry){return {index:entry.index,before:entry.before};})};
    try{
      patches.forEach(function(entry){Object.assign(entry.row,entry.patch);});
      ledger.splice.apply(ledger,[0,ledger.length].concat(nextEntries));
      if(!options.save())throw new Error('本机草稿保存失败，本次修改已撤回。请复制内容后重试。');
    }catch(error){
      patches.forEach(function(entry){Object.keys(entry.row).forEach(function(key){delete entry.row[key];});Object.assign(entry.row,entry.before);});
      ledger.splice.apply(ledger,[0,ledger.length].concat(beforeEntries));throw error;
    }
    transaction.rows.forEach(function(entry){entry.after=signature(rows[entry.index]);});transaction.entriesAfter=copy(ledger);
    return {message:'已保存 '+patches.length+' 项修改到本周草稿，尚未提交。',count:patches.length,transaction:transaction};
  }
  function undo(options){
    var transaction=options.transaction,current=options.current,rows=options.rows,ledger=options.entries || [];
    if(!transaction || !current.canEdit || transaction.key!==current.key || transaction.identityKey!==current.identityKey)throw new Error('填报范围已变化，不能撤销其他范围的修改。');
    if(transaction.rows.some(function(entry){return !rows[entry.index] || signature(rows[entry.index])!==entry.after;}) || JSON.stringify(ledger)!==JSON.stringify(transaction.entriesAfter))throw new Error('草稿已有后续修改，不能直接撤销；请在对话中说明要调整哪一条。');
    var after=transaction.rows.map(function(entry){return copy(rows[entry.index]);}),afterEntries=copy(ledger);
    function setRow(index,value){var row=rows[index];Object.keys(row).forEach(function(key){delete row[key];});Object.assign(row,copy(value));}
    try{
      transaction.rows.forEach(function(entry){setRow(entry.index,entry.before);});ledger.splice.apply(ledger,[0,ledger.length].concat(copy(transaction.entriesBefore)));
      if(!options.save())throw new Error('本机保存失败，未撤销。');
    }catch(error){transaction.rows.forEach(function(entry,index){setRow(entry.index,after[index]);});ledger.splice.apply(ledger,[0,ledger.length].concat(afterEntries));throw error;}
    return {message:'已撤销这次草稿修改，未提交周报。'};
  }
  global.PlanningAIDraft={items:items,entries:entries,preview:preview,apply:apply,undo:undo};
})(typeof window==='undefined'?globalThis:window);
