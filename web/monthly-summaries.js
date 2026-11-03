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
  function contentColumns(items){
    function width(value){return Array.from(String(value || '').replace(/\s+/g,' ')).reduce(function(total,char){return total+(/[^\x00-\xff]/.test(char)?1:.5);},0);}
    var sizes=[width('模块'),1,width('完成时间')*2,1];
    (items || []).forEach(function(item){sizes[0]=Math.max(sizes[0],width(item.mod));sizes[1]=Math.max(sizes[1],width(item.name));sizes[2]=Math.max(sizes[2],width(item.due || '未设置')*2);sizes[3]=Math.max(sizes[3],width(item.progress || '未填写'));});
    var moduleEm=2*Math.sqrt(sizes[0])+1,dateCh=sizes[2]+2,nameWeight=Math.log2(1+sizes[1]),progressWeight=Math.log2(1+sizes[3]),share=nameWeight/(nameWeight+progressWeight);
    function narrativeWidth(part){return 'calc('+(100*part).toFixed(3)+'cqw - '+(moduleEm*part).toFixed(3)+'em - '+(dateCh*part).toFixed(3)+'ch)';}
    return '<colgroup><col style="width:'+moduleEm.toFixed(3)+'em"><col style="width:'+narrativeWidth(share)+'"><col style="width:'+dateCh.toFixed(3)+'ch"><col style="width:'+narrativeWidth(1-share)+'"></colgroup>';
  }
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
        return '<tr data-summary-source-id="'+esc(item.source_id)+'">'+[item.mod,item.name,item.due || '未设置',item.progress || '未填写'].map(function(value,index){return '<td data-label="'+['模块','事项','完成时间','月度完成情况'][index]+'">'+(index===1 || index===3?narrative(value):esc(value))+'</td>';}).join('')+'</tr>';
      }).join('')+'</tbody></table></div>';
    }).join('')+'</div>';
  }
  global.MonthlySummaries={select:select,html:html,narrative:narrative};
})(window);
