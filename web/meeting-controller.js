/* One controller owns one projection window. Draft text is never sent between windows. */
(function(global){
  'use strict';
  var cfg,child=null,id='',identity='',uid='',following=true,section='all',observed='',lastSent=null,lastShown=null,lastAutomatic=false,sequence=0,connected=false,pending=false,error='',saved=[],timer=null;
  function context(){return cfg && cfg.getContext();}
  function valid(){var now=context();return !!(child && now && now.allowed && identity===now.identity && uid===now.uid);}
  function active(){return valid() && !child.closed;}
  function send(type,extra){if(child && !child.closed)child.postMessage(Object.assign({app:'planning-meeting-v1',id:id,type:type},extra || {}),location.origin);}
  function esc(value){return global.MeetingView.esc(value);}
  function selection(){var now=context();if(!now || !now.target)return null;return global.MeetingView.target(Object.assign({},now.target,{section:section}));}
  function professionOptions(value){
    var now=context(),lines=[];
    (now && now.projectProfessions || []).filter(function(project){return value.projectIds.includes(project.project_id);}).forEach(function(project){
      (project.lines || []).forEach(function(line){if(typeof line==='string' && line && !lines.includes(line))lines.push(line);});
    });return lines;
  }
  function show(value,automatic){
    if(!valid())return stop();
    if(child.closed){error='投影窗口已关闭，请重新开启。';connected=false;mount();return;}
    lastSent=global.MeetingView.target(value);lastAutomatic=!!automatic;pending=true;error='';sequence++;
    send('show',{uid:uid,target:lastSent,sequence:sequence,professions:professionOptions(lastSent)});mount();
  }
  function start(windowRef){
    if(active()){if(windowRef && windowRef!==child)windowRef.close();child.focus();return;}
    stop();var now=context();
    if(!now || !now.allowed || !now.target){if(windowRef)windowRef.close();return cfg.notify('请先打开本人有权查看的计划总览。','err');}
    child=windowRef;id=crypto.randomUUID();identity=now.identity;uid=now.uid;following=true;section='all';observed='';lastSent=null;lastShown=null;saved=[];error='';pending=true;connected=false;
    global.addEventListener('message',receive);
    child.location=cfg.displayUrl+'#'+id;
    timer=setInterval(function(){
      if(!valid())return stop();
      if(child.closed){connected=false;pending=false;mount();return;}
      send('heartbeat',{uid:uid});
    },3000);
    mount();refresh();
  }
  function stop(){
    send('end');if(timer)clearInterval(timer);timer=null;global.removeEventListener('message',receive);
    child=null;id='';identity='';uid='';connected=false;pending=false;error='';lastSent=null;lastShown=null;saved=[];observed='';mount();
  }
  function receive(event){
    var packet=event.data;
    if(event.origin!==location.origin || event.source!==child || !packet || packet.app!=='planning-meeting-v1' || packet.id!==id)return;
    if(!valid())return stop();
    if(packet.type==='ready'){
      connected=true;send('heartbeat',{uid:uid});var next=lastSent || selection();if(next)show(next);
    }else if(packet.type==='displayed' && packet.sequence===sequence){
      connected=true;pending=false;error='';lastShown={target:lastSent,title:String(packet.title || '').slice(0,500)};
      send('following',{following:following});mount();
    }else if(packet.type==='failed' && (packet.sequence===undefined || packet.sequence===sequence)){
      pending=false;error=String(packet.message || '投影读取失败，请重试。').slice(0,500);mount();
    }else if(packet.type==='profession'){
      var base=lastShown && lastShown.target || lastSent,now=context();
      if(!base || base.kind==='arrangement' || typeof packet.line!=='string' || packet.line && !professionOptions(base).includes(packet.line))return;
      var projects=base.projectIds.filter(function(pid){return !packet.line || (now.projectProfessions || []).some(function(project){return project.project_id===pid && (project.lines || []).includes(packet.line);});});
      if(!projects.length)return;following=false;show(Object.assign({},base,{projectIds:projects,line:packet.line}));send('following',{following:false});
    }else if(packet.type==='closed'){connected=false;pending=false;mount();}
  }
  function refresh(){
    if(child && !valid())return stop();
    if(!active())return mount();
    var value=selection(),signature=value && JSON.stringify(value);
    if(signature && signature!==observed){observed=signature;if(following && connected)show(value,true);}
    mount();
  }
  function toggle(){
    if(!active())return;
    following=!following;
    if(!following && pending && lastAutomatic && lastShown){sequence++;lastSent=lastShown.target;pending=false;send('freeze');}
    send('following',{following:following});
    if(following){var value=selection();if(value)show(value,true);}
    mount();
  }
  function showSaved(taskId,pid){
    if(!active())return cfg.notify('请先开启会议投影。','err');
    var now=context(),base=now && now.target,project=(now && now.projects || []).find(function(p){return p.id===pid;});
    if(!project || !base)return cfg.notify('原项目已不可读取，请重新选择。','err');
    following=false;
    show({kind:'arrangement',type:project.project_type==='com'?'com':'res',projectIds:[pid],taskId:taskId,period:base.period,line:'',section:'all'});
  }
  function onSaved(task){
    if(!active() || !task || task.meeting_kind!=='requirement')return;
    saved=saved.filter(function(row){return row.id!==task.id;});saved.unshift({id:task.id,project_id:task.project_id,title:task.title || '领导工作安排'});saved=saved.slice(0,5);mount();
  }
  function savedAction(task){
    return active() && task && task.meeting_kind==='requirement'?'<button type="button" class="btn ghost sm" onclick="'+esc('MeetingController.showSaved('+JSON.stringify(task.id)+','+JSON.stringify(task.project_id)+')')+'">展示到大屏</button>':'';
  }
  function mount(){
    var host=document.getElementById('meeting-controller-mount');if(!host)return;
    if(!child){host.replaceChildren();return;}
    var closed=child.closed,shown=lastShown,now=context(),label=shown?shown.title+' · '+(shown.target.kind==='arrangement'?'已保存工作安排':MeetingView.sections[shown.target.section]):'尚未展示';
    var html='<section class="meeting-control" aria-label="会议投影控制"><div class="meeting-control-heading"><b>会议投影控制台</b><span role="status">'+esc(closed?'投影窗口已关闭':error?'读取失败':pending?'正在读取…':connected?following?'跟随中':'已暂停跟随':'等待投影窗口连接')+'</span></div>'
      +'<div class="meeting-control-preview"><b>大屏：</b>'+esc(label)+(shown?' · '+esc(shown.target.period):'')+'</div>'
      +'<p class="meeting-control-hint">录入和保存安排不会更新大屏；保存后可单独选择展示。'+(!following?' 当前项目切换不影响大屏。':'')+'</p>'
      +(error?'<p class="meeting-control-error" role="alert">'+esc(error)+'</p>':'')
      +'<div class="meeting-control-actions"><button type="button" data-meeting-toggle'+(closed?' disabled':'')+'>'+esc(following?'暂停跟随':'恢复跟随')+'</button>'
      +'<label>投影内容<select aria-label="投影内容" data-meeting-section>'+Object.keys(MeetingView.sections).map(function(key){return '<option value="'+key+'"'+(section===key?' selected':'')+'>'+esc(MeetingView.sections[key])+'</option>';}).join('')+'</select></label>'
      +'<button type="button" data-meeting-show'+(closed || !now || !now.target?' disabled':'')+'>展示当前选择</button>'
      +'<button type="button" data-meeting-reload'+(closed || !lastSent?' disabled':'')+'>刷新大屏</button><button type="button" data-meeting-previous'+(closed?' disabled':'')+'>上一屏</button><button type="button" data-meeting-next'+(closed?' disabled':'')+'>下一屏</button>'
      +'<button type="button" data-meeting-focus'+(closed?' disabled':'')+'>定位投影窗口</button><button type="button" data-meeting-stop>结束投影</button></div>'
      +(saved.length?'<div class="meeting-recent"><b>刚保存，未自动展示</b>'+saved.map(function(row,index){return '<div><span>'+esc(row.title)+'</span><button type="button" data-meeting-saved="'+index+'">展示这条安排</button></div>';}).join('')+'</div>':'')+'</section>';
    // Only the toolbar is replaced; business form DOM and rich editor selection remain intact.
    host.innerHTML=html;
    host.querySelector('[data-meeting-toggle]').onclick=toggle;
    host.querySelector('[data-meeting-section]').onchange=function(event){section=event.target.value;refresh();};
    host.querySelector('[data-meeting-show]').onclick=function(){var value=selection();if(value)show(value);};
    host.querySelector('[data-meeting-reload]').onclick=function(){if(lastSent)show(lastSent);};
    host.querySelector('[data-meeting-previous]').onclick=function(){send('scroll',{direction:'previous'});};
    host.querySelector('[data-meeting-next]').onclick=function(){send('scroll',{direction:'next'});};
    host.querySelector('[data-meeting-focus]').onclick=function(){if(active())child.focus();};
    host.querySelector('[data-meeting-stop]').onclick=stop;
    host.querySelectorAll('[data-meeting-saved]').forEach(function(button){button.onclick=function(){var row=saved[Number(button.dataset.meetingSaved)];if(row)showSaved(row.id,row.project_id);};});
  }
  global.addEventListener('beforeunload',function(){send('end');});
  global.MeetingController={configure:function(options){cfg=options;refresh();},start:start,stop:stop,refresh:refresh,active:active,owns:function(sessionId){return active() && id===sessionId;},savedAction:savedAction,onSaved:onSaved,showSaved:showSaved};
})(window);
