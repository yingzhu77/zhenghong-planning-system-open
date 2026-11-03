/* Owner-scoped text continuity. Restored history never carries draft actions. */
(function(global){
  'use strict';
  var cfg,controllers=new Set();
  function configure(options){cfg=options;}
  function enabled(){return !!(cfg && cfg.request);}
  function valid(state){var now=cfg && cfg.context();return !!(now && now.canEdit && state.memory && now.identityKey===state.memory.context.identityKey);}
  function paint(state){if(valid(state))cfg.paint(state);}
  function denied(state,error){
    if(error.status!==403 && !['ai_scope_forbidden','monthly_plan_forbidden','residential_discipline_forbidden','commercial_module_forbidden'].includes(error.code))return false;
    state.messages=[];state.memory.preference={content:'',revision:0};state.memory.preferenceDraft=null;
    state.memory.historyDraft=null;state.memory.failedSnapshot=null;state.memory.loaded=false;
    if(state.operation)state.operation.controller.abort();
    return true;
  }
  function scope(context){return {project_id:context.project_id,line:context.line,period:context.period,report_scope_id:context.report_scope_id};}
  function initialize(state,context){
    if(state.memory)return state.memory;
    state.memory={context:Object.assign({},context),loaded:false,loading:false,revision:0,preference:{content:'',revision:0},preferenceDraft:null,
      panel:false,editIndex:-1,historyDraft:null,error:'',conflict:false,pending:0,tail:Promise.resolve(),notice:'',failedSnapshot:null};
    return state.memory;
  }
  async function request(state,action,body){
    if(!valid(state))throw new Error('登录或填报范围已变化，请重新打开。');
    var controller=new AbortController();controllers.add(controller);
    var timer=global.setTimeout(function(){controller.abort();},20000);
    try{return await cfg.request(action,Object.assign(scope(state.memory.context),body),state.memory.context,controller.signal);}
    finally{global.clearTimeout(timer);controllers.delete(controller);}
  }
  function textMessages(state){
    return state.messages.map(function(message){
      var content=message.content;
      if(message.role==='assistant' && message.draft && message.draft.items && message.draft.items.length){
        content+='\n当时的整理建议（历史文字，需按当前事项重新核对）：';
        message.draft.items.forEach(function(item,index){
          var source=message.context && (message.context.items || []).find(function(row){return row.id===item.id;});
          content+='\n'+(index+1)+'. '+(source && source.title || '当时事项')+'：'+(item.operation==='remove'?'建议移除当时的一段AI补充':item.progress || '');
        });
        if(message.applied)content+='\n当时已确认保存到本机草稿，正式提交需另行操作。';
        if(message.undone)content+='\n当时已撤销这次草稿保存。';
      }
      var monthly=message.draft && message.draft.monthly_plan;
      if(message.role==='assistant' && monthly && monthly.items && monthly.items.length){
        content+='\n当时的 '+monthly.month+' 月计划建议（仅历史文字，需重新整理并确认）：';
        monthly.items.forEach(function(item,index){content+='\n'+(index+1)+'. '+(item.mod?item.mod+' · ':'')+item.name+(item.due?'；完成时间：'+item.due:'')+(item.progress?'；进展：'+item.progress:'');});
        if(message.applied)content+='\n当时已加入本机月计划草稿，月计划确认及正式提交需另行操作。';
        if(message.undone)content+='\n当时已撤销这次月计划新增。';
      }
      return {role:message.role,content:content};
    });
  }
  function restored(messages){return (messages || []).map(function(message){return {role:message.role,content:message.content,restored:true};});}
  function enqueue(state,work){
    var memory=state.memory;
    var next=memory.tail.catch(function(){}).then(function(){if(!valid(state))throw new Error('登录已变化，请重新打开。');return work();});
    memory.tail=next;return next;
  }
  function load(state,context,force){
    if(!enabled())return Promise.resolve(true);
    var memory=initialize(state,context);
    if(memory.loading || memory.loaded && !force)return memory.loadingPromise || Promise.resolve(true);
    memory.loading=true;memory.error='';paint(state);
    memory.loadingPromise=enqueue(state,async function(){
      try{
        var result=await request(state,'load',{});if(!valid(state))return false;
        state.messages=restored(result.conversation.messages);memory.revision=result.conversation.revision;
        memory.preference=result.preference;memory.preferenceDraft=result.preference.content;memory.loaded=true;memory.conflict=false;memory.failedSnapshot=null;
        memory.historyDraft=null;memory.editIndex=-1;memory.notice=state.messages.length?'已续接上次对话。历史建议请重新整理后保存。':'';
        return true;
      }catch(error){if(valid(state)){denied(state,error);memory.error=error.message || '对话与记忆读取失败，请重试。';memory.loaded=false;}return false;}
      finally{memory.loading=false;paint(state);}
    });
    return memory.loadingPromise;
  }
  function ready(state){return !enabled() || !!(state.memory && state.memory.loaded && !state.memory.loading && !state.memory.conflict);}
  async function saveConversation(state,messages,replace){
    var memory=state.memory;
    memory.pending++;paint(state);
    try{
      return await enqueue(state,async function(){
        if(!memory.loaded || memory.conflict)throw new Error('请先重新读取服务器记录，当前内容仍保留在页面。');
        var result=await request(state,'conversation',{expected_revision:memory.revision,messages:messages});
        if(!valid(state))return false;
        memory.revision=result.revision;memory.error='';memory.failedSnapshot=null;
        if(replace){state.messages=restored(result.messages);memory.historyDraft=null;memory.editIndex=-1;}
        return true;
      });
    }catch(error){
      if(valid(state)){var forbidden=denied(state,error);memory.error=error.message || '对话暂未保存，当前内容已保留，请重试。';memory.conflict=error.code==='ai_memory_changed' || memory.conflict;if(!forbidden)memory.failedSnapshot=messages;}
      return false;
    }finally{memory.pending--;paint(state);}
  }
  function persist(state){
    if(!enabled() || !state.memory || !state.memory.loaded)return Promise.resolve(true);
    return saveConversation(state,textMessages(state),false);
  }
  async function clear(state){
    if(!enabled())return true;
    if(!ready(state))return false;
    if(!global.confirm('清除当前项目、专业和周期的已保存对话并开始新对话？个人写法、输入、附件和填报草稿保留。'))return false;
    return saveConversation(state,[],true);
  }
  function toggle(state){var memory=state.memory;memory.panel=!memory.panel;paint(state);}
  function node(tag,cls,text){var result=global.document.createElement(tag);if(cls)result.className=cls;if(text!==undefined)result.textContent=text;return result;}
  function button(text,action,disabled){var result=node('button','planning-ai-text-button',text);result.type='button';result.disabled=!!disabled;result.addEventListener('click',action);return result;}
  function reload(state){
    var memory=state.memory;
    if(memory.pending || memory.loading)return;
    if((memory.failedSnapshot || memory.historyDraft || memory.preferenceDraft!==memory.preference.content)
      && !global.confirm('重新读取服务器记录将替换当前对话和未保存的记忆修改，填报草稿保留。是否继续？'))return;
    load(state,memory.context,true);
  }
  function status(state){
    if(!enabled() || !state.memory)return null;
    var memory=state.memory,box=node('div','planning-ai-memory-status');box.setAttribute('role','status');
    if(memory.loading)box.appendChild(node('span','','正在读取对话与个人写法…'));
    else if(memory.error){
      box.classList.add('has-error');box.appendChild(node('span','',memory.error));
      if(memory.failedSnapshot && !memory.conflict)box.appendChild(button('重试保存对话',function(){saveConversation(state,memory.failedSnapshot,false);},memory.pending));
      box.appendChild(button('重新读取记忆',function(){reload(state);},memory.pending));
    }else box.appendChild(node('span','',memory.pending?'正在保存对话…':memory.notice || (memory.preference.content?'已启用本项目本专业的个人写法':'已按账号、项目和专业保存对话')));
    return box;
  }
  async function savePreference(state,remove){
    var memory=state.memory;if(memory.loading || memory.preferenceBusy || !memory.loaded)return;
    if(remove && !global.confirm('删除当前项目、专业的个人写法记忆？对话和填报草稿保留。'))return;
    memory.preferenceBusy=true;memory.error='';paint(state);
    try{
      var value=remove?'':memory.preferenceDraft;
      var result=await request(state,'preference',{expected_revision:memory.preference.revision,content:value});
      if(!valid(state))return;
      memory.preference=result;memory.preferenceDraft=result.content;memory.notice=remove?'个人写法已删除。':'个人写法已保存，后续整理会参考这份写法。';
    }catch(error){if(valid(state)){denied(state,error);memory.error=error.message || '个人写法保存失败，输入已保留。';}}
    finally{memory.preferenceBusy=false;paint(state);}
  }
  function editHistory(state,index){
    var memory=state.memory;if(!memory.historyDraft)memory.historyDraft=textMessages(state);
    memory.editIndex=index;paint(state);
  }
  async function removeHistory(state,index){
    if(!global.confirm('删除这条已保存的对话记录？不会修改已保存的填报草稿。'))return;
    var rows=(state.memory.historyDraft || textMessages(state)).slice();rows.splice(index,1);
    if(await saveConversation(state,rows,true)){state.memory.notice='对话记录已删除，填报草稿保留。';paint(state);}
  }
  function panel(state){
    var memory=state.memory,box=node('section','planning-ai-memory-panel');box.setAttribute('aria-label','对话与记忆');
    box.appendChild(node('h3','','个人写法'));
    box.appendChild(node('p','planning-ai-note','仅在当前账号、项目和专业使用，后续周期可继续沿用。请只记录表达方式和格式要求；进度、日期及审核结果按当前业务记录核对。'));
    var label=node('label','','个人写法偏好'),input=node('textarea','planning-ai-memory-preference');input.id='planning-ai-memory-preference';label.htmlFor=input.id;input.setAttribute('aria-label','个人写法偏好');
    input.rows=4;input.maxLength=1500;input.placeholder='例如：语言简洁，按完成情况、遇到卡点、下步安排组织，保留原专业用词。';input.value=memory.preferenceDraft || '';input.disabled=!memory.loaded || memory.preferenceBusy;
    input.addEventListener('input',function(){memory.preferenceDraft=input.value;});box.appendChild(label);box.appendChild(input);
    var actions=node('div','planning-ai-actions');actions.appendChild(button('保存写法',function(){savePreference(state,false);},!memory.loaded || memory.preferenceBusy));actions.appendChild(button('删除写法',function(){savePreference(state,true);},!memory.loaded || memory.preferenceBusy || !memory.preference.content));box.appendChild(actions);
    var history=node('details','planning-ai-memory-history');history.appendChild(node('summary','','查看、修改或删除对话记录（'+state.messages.length+'条）'));
    history.appendChild(node('p','planning-ai-note','仅保存文字对话。恢复的历史建议需重新整理后才能填入；修改或删除记录不会修改已保存的填报草稿，附件需重新上传。'));
    var rows=memory.historyDraft || textMessages(state);
    rows.forEach(function(message,index){
      var card=node('article','planning-ai-memory-entry');card.appendChild(node('b','',message.role==='user'?'我的第'+(index+1)+'条记录':'AI 第'+(index+1)+'条记录'));
      if(memory.editIndex===index){
        var editor=node('textarea','planning-ai-memory-message');editor.rows=4;editor.maxLength=12000;editor.value=message.content;editor.setAttribute('aria-label','第'+(index+1)+'条对话记录');editor.addEventListener('input',function(){memory.historyDraft[index].content=editor.value;});card.appendChild(editor);history.open=true;
      }else card.appendChild(node('p','',message.content));
      var tools=node('div','planning-ai-actions');tools.appendChild(button('修改记录',function(){editHistory(state,index);},memory.pending));tools.appendChild(button('删除记录',function(){removeHistory(state,index);},memory.pending));card.appendChild(tools);history.appendChild(card);
    });
    if(memory.historyDraft)history.appendChild(button('保存对话修改',async function(){
      if(await saveConversation(state,memory.historyDraft.map(function(row){return {role:row.role,content:row.content};}),true)){memory.notice='对话修改已保存，填报草稿保留。';paint(state);}
    },memory.pending));
    box.appendChild(history);var feedback=status(state);if(feedback)box.appendChild(feedback);
    if(!memory.error)box.appendChild(button('重新读取记忆',function(){reload(state);},memory.pending || memory.loading));return box;
  }
  function reset(){controllers.forEach(function(controller){controller.abort();});controllers.clear();}
  global.PlanningAIMemory={configure:configure,enabled:enabled,load:load,ready:ready,persist:persist,clear:clear,toggle:toggle,status:status,panel:panel,reset:reset};
})(window);
