(function(global){
  'use strict';
  var id=location.hash.slice(1),parent=global.opener,uid='',active=null,serial=0,abort=null,parentReady=false,loaded=false,authBusy=false;
  var screen=document.getElementById('meeting-screen'),status=document.getElementById('meeting-display-status');
  var profession=document.getElementById('meeting-profession'),professions=[],shownProfessions=[];
  function professionOptions(values){professions=Array.isArray(values)?Array.from(new Set(values.filter(function(value){return typeof value==='string' && value && value.length<=200;}))).slice(0,100):[];profession.replaceChildren();[''].concat(professions).forEach(function(value){var option=document.createElement('option');option.value=value;option.textContent=value==='__unassigned__'?'未归专业':value || '全部专业';profession.appendChild(option);});profession.value=active && active.line || '';profession.disabled=!loaded || !active || active.kind==='arrangement' || !professions.length;}
  function send(type,extra){if(parent && !parent.closed)parent.postMessage(Object.assign({app:'planning-meeting-v1',id:id,type:type},extra || {}),location.origin);}
  function clear(message){serial++;if(abort)abort.abort();abort=null;loaded=false;profession.disabled=true;screen.replaceChildren();var node=document.createElement('div');node.className='meeting-wait';node.textContent=message;screen.appendChild(node);status.textContent=message;}
  async function show(value,sequence){
    var token=++serial;if(abort)abort.abort();abort=new AbortController();loaded=false;
    profession.disabled=true;
    status.textContent='正在读取所选内容…';
    try{
      var selection=MeetingView.target(value),model=await MeetingView.read(uid,selection,abort.signal);
      if(token!==serial)return;
      active=selection;screen.innerHTML=MeetingView.html(model);screen.scrollTop=0;loaded=true;
      shownProfessions=professions.slice();
      professionOptions(professions);
      status.textContent='已展示 · '+model.readAt;
      send('displayed',{sequence:sequence,target:selection,title:model.projects.map(function(p){return p.name;}).join('、')});
    }catch(error){if(token===serial && error.name!=='AbortError'){clear(error.message || '读取失败，请从管理员窗口重试。');send('failed',{sequence:sequence,message:error.message || '读取失败'});}}
  }
  global.addEventListener('message',function(event){
    var packet=event.data;
    if(event.origin!==location.origin || event.source!==parent || !packet || packet.app!=='planning-meeting-v1' || packet.id!==id)return;
    if(packet.type==='end'){clear('会议投影已结束。');parentReady=false;active=null;uid='';return;}
    if(packet.type==='heartbeat'){if(!uid || packet.uid!==uid)return;parentReady=true;return;}
    if(packet.type==='show'){
      if(typeof packet.uid!=='string' || !packet.uid || !Number.isSafeInteger(packet.sequence))return;
      if(uid && packet.uid!==uid){clear('登录身份已变化，请重新开启会议投影。');return;}
      uid=packet.uid;parentReady=true;professionOptions(packet.professions);show(packet.target,packet.sequence);
    }else if(packet.type==='freeze'){
      serial++;if(abort)abort.abort();abort=null;loaded=!!active;professionOptions(shownProfessions);status.textContent='已暂停跟随 · 保持当前内容';
    }else if(packet.type==='scroll' && loaded && ['next','previous','top'].includes(packet.direction)){
      var behavior=global.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
      if(packet.direction==='top')screen.scrollTo({top:0,behavior:behavior});else screen.scrollBy({top:(packet.direction==='next'?1:-1)*screen.clientHeight*.8,behavior:behavior});
    }else if(packet.type==='following' && parentReady)status.textContent=packet.following?'跟随管理员选择':'已暂停跟随 · 保持当前内容';
  });
  async function check(){
    var owns=false;try{owns=parent && !parent.closed && parent.location.origin===location.origin && parent.MeetingController && parent.MeetingController.owns(id);}catch(error){}
    if(!owns){clear('管理员连接已断开，内容已收起。');parentReady=false;active=null;uid='';return;}
    if(!active || authBusy)return;
    authBusy=true;var generation=serial,checked=active;
    try{await MeetingView.authorize(uid,checked);}catch(error){if(generation===serial && checked===active){clear(error.message || '授权检查失败，内容已收起。');send('failed',{message:error.message || '授权检查失败'});}}finally{authBusy=false;}
  }
  document.getElementById('meeting-fullscreen').onclick=async function(){try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch(error){status.textContent='请使用浏览器全屏功能或最大化窗口。';}};
  profession.onchange=function(){if(!loaded || !active || active.kind==='arrangement')return;profession.disabled=true;status.textContent='已暂停跟随 · 正在读取所选专业…';send('profession',{line:profession.value});};
  var font=22;function resize(amount){font=Math.max(16,Math.min(34,font+amount));document.documentElement.style.setProperty('--meeting-font',font+'px');}
  document.getElementById('meeting-font-less').onclick=function(){resize(-2);};document.getElementById('meeting-font-more').onclick=function(){resize(2);};
  global.addEventListener('focus',check);document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});
  global.addEventListener('beforeunload',function(){send('closed');});
  if(!/^[a-f0-9-]{36}$/i.test(id) || !parent){clear('请在计划总览点击“开启会议投影”。');return;}
  var attempts=0,handshake=setInterval(function(){if(parentReady || ++attempts>=10){clearInterval(handshake);if(!parentReady)clear('未能连接管理员窗口，请重新开启会议投影。');}else send('ready');},3000);
  send('ready');setInterval(check,5000);
})(window);
