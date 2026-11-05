/* Read-only monthly completion summaries remain separate from weekly reports and approvals. */
(function(global){
  'use strict';
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function plainLines(value){return String(value).split('\n').map(function(line){return line.trim().replace(/ +/g,' ');}).filter(Boolean).map(esc).join('<br>');}
  // Workbook spaces are layout, not table columns. Recognize explicit list
  // markers only outside parentheses; dates, decimals and building numbers
  // retain their original text. This never changes the stored source.
  function narrative(value){
    var text=String(value==null?'':value).replace(/\r\n?/g,'\n').replace(/[\t\u00a0\u3000]/g,' '),markers=[],pattern=/(?:[1-9]\d{0,2}(?:、|[．.](?!\d))|[（(][1-9]\d{0,2}[）)])/g,match,cursor=0,depth=0;
    while((match=pattern.exec(text))){
      while(cursor<match.index){var c=text[cursor++];if(c==='(' || c==='（')depth++;else if(c===')' || c==='）')depth=Math.max(0,depth-1);}
      if(!depth && (!match.index || /[\s；;。:：，,]/.test(text[match.index-1])))markers.push({at:match.index,end:pattern.lastIndex,label:match[0]});
    }
    if(!markers.length)return '<div class="monthly-summary-narrative">'+plainLines(text)+'</div>';
    var result=plainLines(text.slice(0,markers[0].at));
    markers.forEach(function(marker,index){var body=text.slice(marker.end,index+1<markers.length?markers[index+1].at:text.length).trim(),parts=body.split(/\n(?=(?:完成标准|原表(?:计划|实际)?完成时间)[：:])/);
      result+='<div class="monthly-summary-line"><span class="monthly-summary-number">'+esc(marker.label)+'</span><span class="monthly-summary-body">'+plainLines(parts.shift())+'</span></div>';
      parts.forEach(function(note){result+='<div class="monthly-summary-note">'+plainLines(note)+'</div>';});
    });
    return '<div class="monthly-summary-narrative">'+result+'</div>';
  }
  function columnWidths(items,options){
    options=options || {};
    function width(value){return Array.from(String(value || '').replace(/\s+/g,' ')).reduce(function(total,char){return total+(/[^\x00-\xff]/.test(char)?1:.5);},0);}
    function progress(value){return /^(?:未填写|未提交|本周未提交|本周尚未提交|暂无进展|[—-])$/.test(String(value || '').trim())?'':value;}
    var sizes=[width('模块'),1,width('完成时间')*2,1],sourceSize=2;
    (items || []).forEach(function(item){sizes[0]=Math.max(sizes[0],width(item.mod));sizes[1]=Math.max(sizes[1],width(item.name));sizes[2]=Math.max(sizes[2],width(item.due || '未设置')*2);sizes[3]=Math.max(sizes[3],width(progress(item.progress)));sourceSize=Math.max(sourceSize,width(item.source));});
    var date={value:sizes[2]+3,unit:'ch'},prefix=[];
    if(options.sequence)prefix.push({value:4,unit:'ch',cap:5});
    if(options.source)prefix.push({value:2*Math.sqrt(sourceSize)+1,unit:'em',cap:18});
    function fixed(spec,part){var value=(spec.value*part).toFixed(3)+spec.unit;return spec.cap?'min('+value+', '+(spec.cap*part).toFixed(3)+'cqw)':value;}
    var nameWeight=Math.log2(1+sizes[1]),progressWeight=Math.log2(1+sizes[3]),share=nameWeight/(nameWeight+progressWeight);
    var moduleWeight=Math.log2(1+sizes[0]),moduleShare=moduleWeight/(moduleWeight+nameWeight+progressWeight),metadata=prefix.concat([date]);
    function available(part){return 'calc('+(100*part).toFixed(3)+'cqw'+metadata.map(function(spec){return ' - '+fixed(spec,part);}).join('')+')';}
    function moduleWidth(part){return 'min('+((sizes[0]+1.5)*part).toFixed(3)+'em, '+available(moduleShare*part)+')';}
    function narrativeWidth(part){return 'calc('+available(part)+' - '+moduleWidth(part)+')';}
    return prefix.map(function(spec){return fixed(spec,1);}).concat([moduleWidth(1),narrativeWidth(share),fixed(date,1),narrativeWidth(1-share)]);
  }
  function contentColumns(items,options){return '<colgroup>'+columnWidths(items,options).map(function(value){return '<col style="width:'+value+'">';}).join('')+'</colgroup>';}
  // These notices explain source wording, rather than deciding completion or approval.
  function attention(item,options){
    options=options || {};var progress=String(item.progress || item.prog || ''),blocker=String(item.blocker || ''),reasons=[];
    var clauses=progress.split(/[。；;\n，,]/).map(function(text){return text.trim();}).filter(Boolean);
    var risk=/(?:未|尚未|暂未)(?:全部|整体|按期)?(?:完成|到位|就位|到货|进场)|延期|延误|滞后|受阻|阻碍|卡点|存在(?:风险|问题)|等待(?:移交|材料|审批|验收)|待(?:解决|协调|移交)/;
    function active(text){return text.replace(/(?:无|暂无|没有|不存在|未(?:发生|出现|发现)?|无需)(?:任何|明显|新增)?(?:延期|延误|滞后|受阻|阻碍|卡点|风险|问题)/g,'').replace(/(?:延期|延误|滞后|受阻|阻碍|卡点|风险|问题)(?:问题)?(?:已|已经|均已|全部已|全部)(?:全部)?(?:解决|消除|解除|排除|闭环)/g,'').replace(/已(?:解决|消除|解除|排除)(?:全部|相关)?(?:延期|延误|滞后|受阻|阻碍|卡点|风险|问题)/g,'');}
    clauses.forEach(function(text){if(risk.test(active(text)) && !reasons.includes(text))reasons.push(text);});
    var blockerText=blocker.trim(),blockerActive=active(blockerText);
    if(blockerText && !/^(?:无|暂无|已解决|已消除)$/.test(blockerText) && (risk.test(blockerActive) || blockerActive===blockerText))reasons.push('卡点：'+blockerText);
    var due=String(item.due || ''),reference=String(options.referenceDate || '');
    var complete=/(?:已|全部|整体|均|全部已)完成|^完成[。！!\s]*$|完成100%|100%完成|已验收|已移交/.test(progress) && !/(?:未|尚未|暂未)(?:全部|整体)?完成|部分完成/.test(progress);
    var partial=/完成\s*(\d+(?:\.\d+)?)\s*%/.exec(progress),pending=partial && Number(partial[1])<100 || /正在|推进中|施工中|安装中|待验收|待复核/.test(progress);
    if(partial && Number(partial[1])<100)complete=false;
    function date(value){return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;}
    if(date(due) && date(reference) && due<reference && progress.trim() && !complete && (reasons.length || pending))reasons.push('计划完成日 '+due+' 已过，原文仍有待办');
    return reasons;
  }
  function attentionHtml(item,options){var reasons=attention(item,options),basis=reasons.join('；'),overdue=reasons.some(function(reason){return reason.startsWith('计划完成日 ');});return reasons.length?'<aside class="meeting-attention" title="依据：'+esc(basis)+'" aria-label="需关注，依据：'+esc(basis)+'"><b>需关注</b><span> · '+(overdue?'计划日已过':'存在待解决事项')+'</span></aside>':'';}
  function select(rows,options){
    options=options || {};var ids=(options.projectIds || []).map(String),month=options.month,line=options.line || '';
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''))return [];
    return (rows || []).filter(function(row){
      if(!row || row.month!==month || !ids.includes(String(row.project_id)) || line && row.line!==line)return false;
      if(options.scopeId && row.report_scope_id!==options.scopeId)return false;
      if(row.report_scope_id){var members=row.scope_project_ids;return Array.isArray(members) && members.length>0 && members.includes(row.project_id) && members.every(function(pid){return ids.includes(String(pid));});}
      return !options.scopeId;
    });
  }
  function html(rows,options){
    options=options || {};var projects=options.projects || [];
    function projectName(pid){var project=projects.find(function(value){return String(value.id)===String(pid);});return project?project.name:pid;}
    var selected=select(rows,options);
    if(!selected.length)return '<p class="muted meeting-empty">所选月份和专业暂无月度汇总。</p>';
    return '<div class="monthly-summary-groups">'+selected.map(function(summary){
      var scope=summary.report_scope_id?(summary.scope_project_ids || []).map(projectName).join('、'):projectName(summary.project_id);
      var caption=esc(scope)+' · '+esc(summary.month)+' · '+esc(summary.line)+' · '+esc(summary.owner_name || '未记录提报人');
      return '<div class="tablewrap meeting-table-scroll monthly-summary-group" data-monthly-summary-id="'+esc(summary.id)+'"><table class="monthly-summary-table '+(options.projection?'meeting-plan-table':'overview-plan-table')+'"><caption>'+caption+'</caption>'+contentColumns(summary.items)+'<thead><tr>'+['模块','事项','完成时间','月度完成情况'].map(function(label){return '<th scope="col">'+label+'</th>';}).join('')+'</tr></thead><tbody>'+(summary.items || []).map(function(item){
        return '<tr data-summary-source-id="'+esc(item.source_id)+'">'+[item.mod,item.name,item.due || '未设置',item.progress || '未填写'].map(function(value,index){return '<td data-label="'+['模块','事项','完成时间','月度完成情况'][index]+'">'+(index===1 || index===3?narrative(value):esc(value))+(index===3 && options.projection?attentionHtml(item,options):'')+'</td>';}).join('')+'</tr>';
      }).join('')+'</tbody></table></div>';
    }).join('')+'</div>';
  }
  global.MonthlySummaries={select:select,html:html,narrative:narrative,columnWidths:columnWidths,contentColumns:contentColumns,attention:attention,attentionHtml:attentionHtml};
})(window);
