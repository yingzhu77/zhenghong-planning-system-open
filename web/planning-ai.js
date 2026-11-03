/* The assistant only proposes text. The host owns authentication and draft writes. */
(function (global) {
  'use strict';
  var cfg, dialog, active, identity, previousFocus, states = new Map();
  var LIMIT = 8 * 1024 * 1024, TOTAL = 12 * 1024 * 1024, COUNT = 4;
  var EXT = /\.(pdf|docx|xlsx|png|jpe?g|webp|gif)$/i;
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, cls, handler) {
    var node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', handler); return node;
  }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function notify(text) { if (cfg && cfg.notify) cfg.notify(text, 'err'); }
  function context() { return cfg && cfg.getContext ? cfg.getContext() : null; }
  function abort(state) {
    if (state && state.operation) { state.operation.controller.abort(); state.operation = null; state.busy = false; state.error = '范围已切换，上次整理已取消，可重新发送。'; state.retry = true; }
  }
  function sync() {
    var ctx = context();
    if (!ctx || !ctx.key || !ctx.canEdit) {
      states.forEach(abort); active = null; close(); return null;
    }
    if (identity !== ctx.identityKey) { states.forEach(abort); if(global.PlanningAIMemory)global.PlanningAIMemory.reset(); states.clear(); identity = ctx.identityKey; }
    if (active && active.key !== ctx.key) abort(active);
    if (!states.has(ctx.key)) {
      if (states.size >= 8) { var oldest = states.keys().next().value; abort(states.get(oldest)); states.delete(oldest); }
      states.set(ctx.key, {key:ctx.key, input:'', files:[], messages:[], busy:false, error:'', retry:false});
    }
    active = states.get(ctx.key); active.label = [ctx.projectName, ctx.lineLabel, ctx.periodLabel].filter(Boolean).join(' · ');
    return active;
  }
  function configure(options) {
    cfg = options;
    if(cfg.memoryRequest && !global.PlanningAIMemory)throw new Error('对话记忆组件未能加载，请刷新重试。');
    if(global.PlanningAIMemory)global.PlanningAIMemory.configure({request:cfg.memoryRequest,context:context,paint:function(state){if(state===active)paint();}});
    refresh();
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = el('dialog', 'planning-ai-dialog'); dialog.id = 'planning-ai-dialog';
    dialog.setAttribute('aria-labelledby', 'planning-ai-heading');
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('click', function (event) { if (event.target === dialog) {
      var rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    } });
    document.body.appendChild(dialog);
  }
  function open() {
    if (!sync()) return notify('请先进入本人可填写的项目、模块和填报周。');
    ensureDialog(); previousFocus = document.activeElement; paint();
    if (!dialog.open) dialog.showModal();
    if(global.PlanningAIMemory && cfg.memoryRequest)global.PlanningAIMemory.load(active,copy(context()));
    var input = dialog.querySelector('.planning-ai-input'); if (input) input.focus();
  }
  function close() {
    if (dialog && dialog.open) { dialog.close(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); }
  }
  function refresh() { var wasOpen = dialog && dialog.open; sync(); if (wasOpen && active) paint(); }
  function reset() {
    if(global.PlanningAIMemory)global.PlanningAIMemory.reset();
    states.forEach(abort); states.clear(); active = null; identity = undefined; close();
    if (dialog) { dialog.remove(); dialog = null; }
  }
  function current(state, operation) {
    var ctx = context();
    return state === active && state.operation === operation && ctx && ctx.canEdit && ctx.key === state.key && ctx.identityKey === identity;
  }
  function sizeText(size) { return size >= 1048576 ? (Math.round(size / 1048576 * 10) / 10) + ' MiB' : Math.max(1, Math.ceil(size / 1024)) + ' KiB'; }
  function latestAssistant(state) { return state.messages.filter(function (message) { return message.role === 'assistant'; }).slice(-1)[0]; }
  function monthlyCandidate(draft) {
    var plan = draft && draft.monthly_plan;
    return plan && /^\d{4}-(0[1-9]|1[0-2])$/.test(plan.month) && Array.isArray(plan.items) && plan.items.length ? plan : null;
  }
  function hasCandidate(draft) { return !!(draft && (Array.isArray(draft.items) && draft.items.length || monthlyCandidate(draft))); }
  function wireMessages(messages) {
    return messages.filter(function (message) { return message.role === 'user' || message.role === 'assistant'; }).map(function (message) {
      var content = message.role === 'assistant'
        ? JSON.stringify({reply:(message.applied?'[已保存到本机草稿，未提交] ':'')+message.content,draft:message.draft || {items:[]}}) : message.content;
      return {role:message.role,content:content};
    });
  }
  function historyError(messages) {
    if (messages.length > 20) return '本次对话已达到20条消息，请点击“新对话”后继续；附件和输入会保留。';
    if (messages.some(function (message) { return message.content.length > 12000; })) return '上一轮内容较多，请点击“新对话”后分批整理；附件和输入会保留。';
    if (JSON.stringify(messages).length > 50000) return '本次对话内容较多，请点击“新对话”后继续；附件和输入会保留。';
    return '';
  }
  async function newConversation() {
    var state = sync(); if (!state || state.busy) return;
    if(global.PlanningAIMemory && cfg.memoryRequest && !await global.PlanningAIMemory.clear(state))return;
    state.messages = []; state.error = ''; state.retry = false; paint();
    var input = dialog.querySelector('.planning-ai-input'); if (input) input.focus();
  }
  function fileCard(file, remove) {
    var node = el('div', 'planning-ai-file'), type = file.name.split('.').pop().toUpperCase();
    node.appendChild(el('span', 'planning-ai-file-icon', type));
    var info = el('div', 'planning-ai-file-info'); info.appendChild(el('b', '', file.name));
    info.appendChild(el('span', '', sizeText(file.size) + (file.uploaded ? ' · 已上传' : ''))); node.appendChild(info);
    if (remove) { var del = button('×', 'planning-ai-file-remove', remove); del.setAttribute('aria-label', '移除附件 ' + file.name); node.appendChild(del); }
    return node;
  }
  function addFiles(files) {
    var state = sync(); if (!state || state.busy) return;
    var incoming = Array.prototype.slice.call(files || []), next = state.files.slice(), issues = [];
    incoming.forEach(function (file) {
      if (!EXT.test(file.name)) return issues.push(file.name + '：请使用 PDF、docx、xlsx 或图片。');
      if (!Number.isSafeInteger(file.size) || file.size < 1) return issues.push(file.name + '：文件为空。');
      if (file.size > LIMIT) return issues.push(file.name + '：单件不能超过 8 MiB。');
      if (next.some(function (saved) { return saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified; })) return;
      if (next.length >= COUNT || next.reduce(function (n, saved) { return n + saved.size; }, file.size) > TOTAL) return issues.push(file.name + '：最多 4 件，合计不能超过 12 MiB。');
      next.push(file);
    });
    state.files = next; state.error = issues.join('\n'); paint();
  }
  async function send(retry) {
    var state = sync(); if (!state || state.busy) return;
    if(global.PlanningAIMemory && cfg.memoryRequest && !global.PlanningAIMemory.ready(state)){state.error='请先读取对话与记忆，当前输入已保留。';paint();return;}
    var text = state.input.trim(), pending = state.messages.slice();
    if(!retry){
      var command=text.replace(/[\s，。！？!?.]/g,'');
      if(/^(确认保存|确认填入|填入草稿|填入本周草稿|保存草稿|保存到草稿|保存到本周草稿|就用这个|按这个保存|填入月计划草稿|确认(?:保存|加入)(?:到)?(?:\d{4}-\d{2})?月计划草稿)$/.test(command)){
        var candidate=latestAssistant(state);
        if(!candidate || candidate.applied || !hasCandidate(candidate.draft)){state.error='当前没有待保存的修改。请先让我整理或修改内容，再确认保存。';paint();return;}
        state.input='';return apply(state,candidate);
      }
      if(/^(撤销|撤销刚才|撤销这次保存|撤销刚才的保存|撤销刚才填入|撤销上次修改)$/.test(command)){
        var saved=state.messages.filter(function(message){return message.applied && message.receiptId && !message.undone;}).slice(-1)[0];
        if(!saved){state.error='当前没有可撤销的AI保存记录。';paint();return;}state.input='';return undo(state,saved);
      }
    }
    if (!retry && !text && !state.files.length) return;
    if (!retry) {
      if (!text) text = '请按附件内容整理：月度计划提取为对应月份的月计划草稿候选，进展记录整理为当前已有事项的本周进展。月份不明确时先询问，不改已确认计划。';
      pending.push({role:'user', content:text, files:state.files.map(function (file) { return {name:file.name,size:file.size}; })});
    }
    var messages = wireMessages(pending), issue = historyError(messages);
    if (issue) { state.error = issue; state.retry = false; paint(); return; }
    state.messages = pending; if (!retry) state.input = '';
    if(global.PlanningAIMemory && cfg.memoryRequest)global.PlanningAIMemory.persist(state);
    var ctx = copy(context()), operation = {controller:new AbortController(),files:state.files.slice()};
    state.operation = operation; state.busy = true; state.error = ''; state.retry = false; paint(true);
    try {
      var response = await cfg.request({context:ctx, messages:messages, files:operation.files, signal:operation.controller.signal});
      if (!current(state, operation)) return;
      if (operation.controller.signal.aborted) throw new Error('本次整理已取消，可重新发送。');
      if (!response || typeof response.reply !== 'string' || !response.reply.trim()) throw new Error('AI 未返回可用回复，请重试。');
      var sentMessage = state.messages.filter(function (message) { return message.role === 'user'; }).slice(-1)[0];
      if (sentMessage) sentMessage.files = operation.files.map(function (file) { return {name:file.name,size:file.size,uploaded:true}; });
      state.messages.push({role:'assistant',content:response.reply,draft:response.draft,records:response.records,monthly_review:response.monthly_review,context:ctx,applied:false});
      if(global.PlanningAIMemory && cfg.memoryRequest)global.PlanningAIMemory.persist(state);
    } catch (error) {
      if (!current(state, operation)) return;
      state.error = operation.controller.signal.aborted ? '本次整理已取消，可重新发送。' : error && error.message || '整理失败，请重试。'; state.retry = true;
    } finally {
      if (current(state, operation)) { state.operation = null; state.busy = false; paint(true); }
    }
  }
  function cancel() {
    if (!active || !active.operation) return;
    // Keep the operation identity until its promise settles so cancellation is shown.
    active.operation.controller.abort();
  }
  async function apply(state, message) {
    var ctx = context();
    if (state !== active || !ctx || !ctx.canEdit || ctx.key !== state.key || ctx.identityKey !== identity || state.busy || message.applied || latestAssistant(state) !== message) return;
    state.busy = true; state.error = ''; paint();
    try {
      var result = await cfg.onApply({context:copy(message.context), draft:copy(message.draft)});
      if (state !== active || context().key !== state.key || context().identityKey !== identity) return;
      var monthly = monthlyCandidate(message.draft);
      message.applied = true; message.receiptId=result && result.receipt_id;message.receipt = result && result.message || (monthly?'已追加到'+monthly.month+'月计划草稿，尚未确认或提交。':'已保存到本周草稿，尚未提交。');
      if(global.PlanningAIMemory && cfg.memoryRequest)global.PlanningAIMemory.persist(state);
    } catch (error) { if (state === active) state.error = error && error.message || '填入失败，请重新整理后再试。'; }
    finally { state.busy = false; if (state === active) paint(); }
  }
  async function undo(state,message){
    if(state!==active || state.busy || !cfg.onUndo || message.undone)return;
    state.busy=true;state.error='';paint();
    try{var result=await cfg.onUndo({receipt_id:message.receiptId});if(state!==active)return;message.undone=true;message.receipt=result.message || '已撤销本次修改，尚未提交。';if(global.PlanningAIMemory && cfg.memoryRequest)global.PlanningAIMemory.persist(state);}
    catch(error){if(state===active)state.error=error.message || '撤销失败，请核对草稿。';}
    finally{state.busy=false;if(state===active)paint();}
  }
  function recordsNode(records){
    var node=el('section','planning-ai-records');
    node.appendChild(el('b','',records.kind==='history'?'本人历史周报':records.kind==='overdue'?'本人逾期事项':'本人事项汇总'));
    node.appendChild(el('small','planning-ai-note',records.scope+' · 截至 '+records.as_of));
    if(records.summary){var s=records.summary;node.appendChild(el('p','planning-ai-metrics','共 '+s.total+' 项 · 已完成 '+s.completed+' · 逾期 '+s.overdue+' · 未来7天到期 '+s.due_next7));}
    (records.items || []).forEach(function(item){
      var details=el('details','planning-ai-record'),heading=el('summary','',item.what);details.appendChild(heading);
      details.appendChild(el('p','',item.project_name+' · '+item.title+' · '+item.status));
      details.appendChild(el('p','',item.effective_due?'有效截止：'+item.effective_due+(item.overdue?' · 逾期 '+item.overdue_days+' 天':''):'未设置有效截止日期'));
      if(item.extension_approved)details.appendChild(el('small','planning-ai-note','原截止 '+item.original_due+'，已按批准延期日期计算'));
      details.appendChild(el('p','',item.progress || '暂无已提交进展'));details.appendChild(el('small','planning-ai-note',item.source));node.appendChild(details);
    });
    (records.reports || []).forEach(function(report){
      var details=el('details','planning-ai-record');details.appendChild(el('summary','',report.period+' · '+report.project_name+' · '+report.line));
      [['本期变化',report.change],['风险与问题',report.risk],['影响',report.impact],['预判',report.projection]].forEach(function(pair){if(pair[1])details.appendChild(el('p','',pair[0]+'：'+pair[1]));});
      (report.items || []).forEach(function(item){details.appendChild(el('p','',item.name+'：'+(item.progress || '未填写进展')+(item.blocker?'；遇到卡点：'+item.blocker:'')));});
      (report.nodes || []).forEach(function(item){details.appendChild(el('p','',(item.name || '节点')+'：'+(item.prog || item.reason || '未填写进展')));});
      (report.coordination || []).forEach(function(item){details.appendChild(el('p','', '协调：'+item.what+(item.by?' · '+item.by:'')));});
      (report.followups || []).forEach(function(item){details.appendChild(el('p','', '同步事项：'+(item.what || item.title || '')+' · '+(item.progress || '未反馈')));});
      if(report.next && report.next.length)details.appendChild(el('p','','下期安排：'+report.next.join('；')));
      details.appendChild(el('small','planning-ai-note',report.source));node.appendChild(details);
    });
    node.appendChild(el('small','planning-ai-note','匹配 '+records.total+' 条，展示 '+records.shown+' 条'+(records.has_more?'，还有未展示记录，可限定日期或关键词继续查询。':'。')));
    if(records.unavailable || records.unlinked_legacy)node.appendChild(el('small','planning-ai-note','另有 '+(records.unavailable || 0)+' 项当前不可核验、'+(records.unlinked_legacy || 0)+' 条旧记录缺少稳定来源，未计入以上数量。'));
    node.appendChild(el('small','planning-ai-note',records.basis));return node;
  }
  function messageNode(message, state) {
    var row = el('article', 'planning-ai-message is-' + message.role);
    var badge = el('span', 'planning-ai-avatar', message.role === 'assistant' ? 'AI' : '我'); badge.setAttribute('aria-hidden', 'true');
    var bubble = el('div', 'planning-ai-bubble');
    (message.files || []).forEach(function (file) { bubble.appendChild(fileCard(file)); });
    bubble.appendChild(el('div', 'planning-ai-content', message.content));
    if(message.monthly_review){var review=message.monthly_review;bubble.appendChild(el('p','planning-ai-preview-status',(review.kind==='image'?'图片识别 · 请对照原图核对':'附件计划提取')+' · '+review.proposed_rows+' 项候选'));if(review.note)bubble.appendChild(el('p','planning-ai-note',review.note));}
    if(message.records)bubble.appendChild(recordsNode(message.records));
    var items = message.draft && Array.isArray(message.draft.items) ? message.draft.items : [], monthly = monthlyCandidate(message.draft);
    if (message.role === 'assistant' && (items.length || monthly)) {
      var preview = el('div', 'planning-ai-preview');
      if(!message.applied)preview.appendChild(el('div','planning-ai-preview-status',monthly?monthly.month+'月计划预览 · 尚未加入草稿':'修改预览 · 尚未保存'));
      if(monthly){
        preview.appendChild(el('b','',monthly.month+'月计划 · '+monthly.items.length+' 项'));
        preview.appendChild(el('p','planning-ai-note','确认后追加到该月计划草稿，保留已有输入；尚未确认月计划，也未提交填报。已确认计划的固定列不能修改。'));
        monthly.items.forEach(function(item,index){
          var itemNode=el('section','planning-ai-preview-item');itemNode.appendChild(el('b','',(index+1)+'. '+item.name));
          itemNode.appendChild(el('small','planning-ai-note','模块：'+(item.mod || '未填写')+' · 完成时间：'+(item.due || '未设置，请核对')));
          itemNode.appendChild(el('p','','本期进展：'+(item.progress || '未填写')));
          if(Array.isArray(item.sources) && item.sources.length)itemNode.appendChild(el('small','','来源：'+item.sources.join('；')));
          preview.appendChild(itemNode);
        });
      }else{
      var changes=[];try{if(global.PlanningAIDraft)changes=global.PlanningAIDraft.preview(message.context,message.draft);}catch(error){preview.appendChild(el('p','planning-ai-error',error.message));}
      items.forEach(function (item, index) {
        var source = (message.context.items || []).find(function (original) { return original.id === item.id; });
        var itemNode = el('section', 'planning-ai-preview-item'); itemNode.appendChild(el('b', '', (index + 1) + '. ' + (source ? source.title : '待核对事项')));
        var operation=item.operation || 'append',change=changes[index];
        itemNode.appendChild(el('small','planning-ai-note',operation==='remove'?'删除这段AI补充，保留原文':operation==='replace'?'替换这段AI补充，保留原文':'补充到本周进展，保留原文'));
        if(operation==='remove' || operation==='replace'){
          if(change){var beforeAfter=el('details','planning-ai-change');beforeAfter.appendChild(el('summary','','查看修改前后'));beforeAfter.appendChild(el('b','','修改前'));beforeAfter.appendChild(el('p','',change.before || '（空）'));beforeAfter.appendChild(el('b','','确认保存后'));beforeAfter.appendChild(el('p','',change.after || '（空，原有文字不受影响）'));itemNode.appendChild(beforeAfter);}
        }
        itemNode.appendChild(el('p', '', operation==='remove'?'确认后移除这次AI补充的文字。':item.progress));
        if (Array.isArray(item.sources) && item.sources.length) itemNode.appendChild(el('small', '', '来源：' + item.sources.join('；')));
        preview.appendChild(itemNode);
      });
      }
      bubble.appendChild(preview);
      if (message.applied){
        bubble.appendChild(el('p', 'planning-ai-receipt', message.receipt));
        var receiptActions=el('div','planning-ai-actions');receiptActions.appendChild(button(monthly?'查看'+monthly.month+'月计划草稿':'查看本周草稿','planning-ai-text-button',function(){close();if(cfg.onViewDraft)cfg.onViewDraft(monthly?{month:monthly.month}:undefined);}));
        if(cfg.onUndo && message.receiptId && !message.undone){var back=button('撤销这次保存','planning-ai-text-button',function(){undo(state,message);});back.disabled=state.busy;receiptActions.appendChild(back);}bubble.appendChild(receiptActions);
      }
      else if (latestAssistant(state) !== message) {
        bubble.appendChild(el('small', 'planning-ai-note', '此草稿已被后续回复替代，不能再填入。'));
      } else {
        var actions = el('div', 'planning-ai-actions'), fill = button(monthly?'确认加入'+monthly.month+'月计划草稿':'确认保存到本周草稿', 'planning-ai-primary', function () { apply(state, message); });
        fill.disabled = state.busy; actions.appendChild(fill);
        var edit = button('继续修改', 'planning-ai-text-button', function () { dialog.querySelector('.planning-ai-input').focus(); }); actions.appendChild(edit); bubble.appendChild(actions);
        bubble.appendChild(el('small', 'planning-ai-note', '也可直接回复“确认保存”。保存后可查看或撤销；正式提交请在表单底部操作。'));
      }
    }
    row.appendChild(badge); row.appendChild(bubble); return row;
  }
  function paint(toBottom) {
    if (!dialog || !active) return;
    var state = active, oldLog = dialog.querySelector('.planning-ai-log'), scroll = oldLog ? oldLog.scrollTop : 0;
    var oldInput = dialog.querySelector('.planning-ai-input'), focused = document.activeElement === oldInput;
    dialog.replaceChildren();
    var header = el('header', 'planning-ai-header'), badge = el('span', 'planning-ai-brand', 'AI'); badge.setAttribute('aria-hidden', 'true'); header.appendChild(badge);
    var headings = el('div', 'planning-ai-headings'), title = el('h2', '', 'AI 填报助手'); title.id = 'planning-ai-heading'; headings.appendChild(title); headings.appendChild(el('p', '', state.label)); header.appendChild(headings);
    var fresh = button('新对话', 'planning-ai-text-button planning-ai-new', newConversation); fresh.disabled = state.busy; fresh.title = '只清除当前范围对话，保留附件、输入和表单草稿'; header.appendChild(fresh);
    if(global.PlanningAIMemory && cfg.memoryRequest){var manage=button(state.memory && state.memory.panel?'返回对话':'对话与记忆','planning-ai-text-button planning-ai-new',function(){global.PlanningAIMemory.toggle(state);});manage.disabled=state.busy || !state.memory;header.appendChild(manage);}
    var closeButton = button('×', 'planning-ai-close', close); closeButton.setAttribute('aria-label', '收起 AI 填报助手'); header.appendChild(closeButton); dialog.appendChild(header);
    if(global.PlanningAIMemory && cfg.memoryRequest && state.memory && state.memory.panel){dialog.appendChild(global.PlanningAIMemory.panel(state));return;}
    var log = el('div', 'planning-ai-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-label', 'AI 对话'); log.setAttribute('aria-live', 'polite');
    var currentContext = context();
    if(currentContext && currentContext.monthly_error){var monthlyNotice=el('p','planning-ai-error',currentContext.monthly_error);monthlyNotice.setAttribute('role','alert');log.appendChild(monthlyNotice);}
    if (!state.messages.length) {
      var welcome = el('div', 'planning-ai-welcome'); welcome.appendChild(el('h3', '', '把材料和要求发给我')); welcome.appendChild(el('p', '', '可以问我本人事项、历史周报和逾期情况，也可以上传材料整理本周进展或提取月计划。'));
      welcome.appendChild(el('p', 'planning-ai-note', '当前没有事项也可从附件整理本月或下月计划；已确认计划的固定列不能修改。先看预览，再点确认按钮或回复“确认保存”；只有成功回执才表示已写入草稿，月计划确认和正式提交仍由你操作。')); log.appendChild(welcome);
    }
    if(!(state.memory && state.memory.loading))state.messages.forEach(function (message) { log.appendChild(messageNode(message, state)); });
    if (state.busy) { var status = el('p', 'planning-ai-working', state.operation ? '正在阅读材料并整理回复…' : '正在写入草稿…'); status.setAttribute('role', 'status'); log.appendChild(status); }
    dialog.appendChild(log);
    var footer = el('footer', 'planning-ai-footer');
    var available=(currentContext && currentContext.monthly_plans || []);
    if(available.length){footer.appendChild(el('small','planning-ai-note','当前项目已就绪，可提取以下月份的月计划，无需先建立事项列表。历史附件请重新上传。'));var shortcuts=el('div','planning-ai-actions');available.forEach(function(plan){var pick=button('提取'+plan.month+'月计划','planning-ai-text-button',function(){var request='请把本次附件或图片中 '+plan.month+' 月份的工作计划完整提取到该月未确认计划草稿，保留原文和完成时间，先生成预览。';if(state.input.indexOf(request)<0)state.input=state.input.trim()?state.input+'\n'+request:request;paint();var field=dialog.querySelector('.planning-ai-input');if(field)field.focus();});pick.disabled=state.busy;shortcuts.appendChild(pick);});footer.appendChild(shortcuts);}
    if(global.PlanningAIMemory && cfg.memoryRequest){var memoryStatus=global.PlanningAIMemory.status(state);if(memoryStatus)footer.appendChild(memoryStatus);}
    if (state.error) { var error = el('div', 'planning-ai-error'); error.setAttribute('role', 'alert'); error.appendChild(el('span', '', state.error));
      if (state.retry && !state.busy) error.appendChild(button('重试', 'planning-ai-text-button', function () { send(true); })); footer.appendChild(error); }
    if (state.files.length) { var files = el('div', 'planning-ai-selected'); state.files.forEach(function (file, index) { files.appendChild(fileCard(file, state.busy ? null : function () { state.files.splice(index, 1); state.error = ''; paint(); })); }); footer.appendChild(files); }
    var form = el('form', 'planning-ai-composer'); form.addEventListener('submit', function (event) { event.preventDefault(); send(false); });
    var upload = button('', 'planning-ai-attach', function () { picker.click(); }); upload.setAttribute('aria-label', '上传附件'); upload.title = '上传附件'; upload.disabled = state.busy;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M21 11.5 11.7 20.8a6 6 0 0 1-8.5-8.5L13.5 2a4 4 0 0 1 5.7 5.7L8.8 18.1a2 2 0 0 1-2.8-2.8L15.5 6'); svg.appendChild(path); upload.appendChild(svg); form.appendChild(upload);
    var picker = el('input', 'planning-ai-picker'); picker.type = 'file'; picker.multiple = true; picker.accept = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif'; picker.hidden = true; picker.tabIndex = -1;
    picker.addEventListener('change', function () { addFiles(picker.files); picker.value = ''; }); form.appendChild(picker);
    var input = el('textarea', 'planning-ai-input'); input.rows = 2; input.maxLength = 6000; input.placeholder = '继续补充要求，或直接说想修改什么…'; input.setAttribute('aria-label', '对 AI 说些什么'); input.value = state.input;
    input.addEventListener('input', function () { state.input = input.value; });
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send(false); } }); form.appendChild(input);
    if (state.operation) form.appendChild(button('取消整理', 'planning-ai-cancel', cancel));
    else { var submit = button('发送', 'planning-ai-primary', function () { send(false); }); submit.disabled = state.busy; form.appendChild(submit); }
    footer.appendChild(form); footer.appendChild(el('small', 'planning-ai-note', '支持 PDF、Word（.docx）、Excel（.xlsx）和图片 · 最多4件，单件8 MiB，合计12 MiB · Ctrl+Enter 发送'));
    dialog.appendChild(footer); log.scrollTop = toBottom ? log.scrollHeight : scroll; if (focused) input.focus();
  }
  global.PlanningAI = {configure:configure,open:open,close:close,refresh:refresh,reset:reset};
})(window);
