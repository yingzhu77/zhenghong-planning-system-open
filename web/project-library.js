(function(global){
 'use strict';
 var cfg,S,uid,session,epoch=0,activePid=null,states=new Map();
 function configure(options){
  if(uid!==options.S.uid||session!==options.S.session){states.clear();activePid=null;epoch++;}
  cfg=options;S=options.S;uid=S.uid;session=S.session;
 }
 function esc(value){return cfg.esc(value==null?'':value);}
 function readOnly(){return !!(cfg.readOnly&&cfg.readOnly());}
 function canUpload(s){return !readOnly()&&s.can_upload!==false;}
 function arg(value){return esc(JSON.stringify(String(value)));}
 function state(pid){if(!states.has(pid))states.set(pid,{loaded:false,loading:false,busy:false,items:[],categories:[],configured:false,unlocked:false,can_manage:false,q:'',category:'',history:false,title:'',uploadCategory:'其他',newVersion:null,file:null,error:'',notice:''});return states.get(pid);}
 function current(){if(!activePid||cfg.projectId&&cfg.projectId()!==activePid)return null;return {pid:activePid,s:state(activePid)};}
 function token(pid){return {pid:pid,epoch:epoch,uid:uid,session:session,readOnly:readOnly()};}
 function here(t){return t.epoch===epoch&&t.uid===S.uid&&t.session===S.session&&t.readOnly===readOnly()&&activePid===t.pid&&(!cfg.projectId||cfg.projectId()===t.pid);}
 function result(response){if(!response||response.error)throw new Error(response&&response.error&&response.error.message||'共享资料请求失败');return response.data;}
 async function reload(){
  var c=current();if(!c||c.s.loading||c.s.busy)return;
  var t=token(c.pid),s=c.s;s.loading=true;s.error='';
  try{
   var data=result(await cfg.request('/api/project-library/list',{project_id:c.pid,q:s.q,category:s.category,include_withdrawn:s.history}));
   if(!here(t))return;
   s.items=data.items||[];s.categories=data.categories||s.items.map(function(x){return x.category;});s.configured=!!data.configured;s.unlocked=!!data.unlocked;s.can_manage=!!data.can_manage;s.can_upload=data.can_upload!==false;s.loaded=true;
  }catch(error){if(here(t)){s.loaded=true;s.error=error.message;}}
  finally{if(here(t)){s.loading=false;cfg.render();}else s.loading=false;}
 }
 function edit(field,value){var c=current();if(!c||c.s.busy||['q','category','title','uploadCategory','history'].indexOf(field)<0||(['title','uploadCategory'].includes(field)&&!canUpload(c.s)))return;c.s[field]=value;}
 function pickFile(input){var c=current();if(!c||c.s.busy||!canUpload(c.s))return;var f=input.files&&input.files[0];c.s.file=f||null;if(f&&!c.s.title)c.s.title=f.name.replace(/\.[^.]+$/,'');}
 function humanSize(bytes){return bytes>=1048576?(bytes/1048576).toFixed(2)+' MiB':Math.ceil(bytes/1024)+' KiB';}
 function html(pid){
  if(activePid!==pid){
   if(activePid&&states.has(activePid))states.get(activePid).file=null;
   activePid=pid;state(pid).file=null;
  }
  var s=state(pid),disabled=s.busy?' disabled':'',categories=Array.from(new Set(s.categories.concat(s.category?[s.category]:[]))).sort();
  var suggestions=Array.from(new Set(categories.concat(['项目图纸','计划资料','会议资料','项目报告','其他'])));
  if(!s.loaded&&!s.loading&&!s.busy)Promise.resolve().then(function(){if(activePid===pid)return reload();});
  var rows=s.items.map(function(row){
   var withdrawn=!!row.withdrawn_at,blocked=!s.unlocked||withdrawn||s.busy;
   return '<tr><td data-label="资料"><b>'+esc(row.title)+'</b><div class="muted">'+esc(row.name)+' · v'+esc(row.version)+'</div>'+(withdrawn?'<span class="badge">已撤回，历史保留</span>':'')+'</td>'
    +'<td data-label="分类">'+esc(row.category)+'</td><td data-label="文件">'+esc(row.mime==='application/pdf'?'PDF':row.mime==='image/png'?'PNG':'JPEG')+'<div class="muted">'+humanSize(row.size)+'</div></td>'
    +'<td data-label="上传">'+esc(row.uploaded_name)+'<div class="muted">'+esc(String(row.created_at||'').replace('T',' ').slice(0,19))+'</div></td>'
    +'<td data-label="操作"><div class="library-row-actions"><button type="button" class="btn ghost sm" onclick="ProjectLibrary.open('+arg(row.id)+',true,false)"'+(blocked?' disabled':'')+'>水印预览</button>'
    +'<button type="button" class="btn ghost sm" onclick="ProjectLibrary.open('+arg(row.id)+',false,false)"'+(blocked?' disabled':'')+'>水印下载</button>'
    +(!readOnly()&&s.can_manage?'<button type="button" class="btn ghost sm" onclick="ProjectLibrary.open('+arg(row.id)+',false,true)"'+disabled+'>下载原件</button>':'')
    +(!withdrawn&&canUpload(s)?'<button type="button" class="btn ghost sm" onclick="ProjectLibrary.version('+arg(row.id)+')"'+disabled+'>上传新版本</button>':'')
    +(!readOnly()&&row.can_withdraw?'<button type="button" class="btn ghost sm" onclick="ProjectLibrary.withdraw('+arg(row.id)+')"'+disabled+'>撤回</button>':'')+'</div></td></tr>';
  }).join('');
  return '<section class="card project-library"><div class="cardhd"><h3>资料共享</h3><button type="button" class="btn ghost sm" onclick="ProjectLibrary.reload()"'+(s.busy||s.loading?' disabled':'')+'>刷新资料</button></div>'
   +'<p class="library-guide">按资料名称或分类查找本项目文件。'+(readOnly()?'只读查看：验证独立项目下载口令后可水印预览与下载。':'上传时可选已有分类，也可自行填写，留空归入“其他”。')+'</p>'
   +'<p class="muted">一期支持PDF、PNG、JPEG，单件不超过8 MiB，PDF最多200页、静态图片最多30MP。这里只管理新共享资料，原项目图纸、周报附件及外链保持原有入口。</p>'
   +(s.error?'<p class="notice err" role="alert">'+esc(s.error)+'</p>':'')+(s.notice?'<p class="notice" role="status">'+esc(s.notice)+'</p>':'')
   +'<div class="library-password-panel">'+(s.unlocked?'<span class="badge green">本次登录已验证项目口令</span><span class="muted">更换口令或服务重启后需重新验证。</span>'
    :s.configured?'<label>项目下载口令<input type="password" id="library_unlock_password" autocomplete="off" aria-label="项目下载口令"'+disabled+'></label><button type="button" class="btn" onclick="ProjectLibrary.unlock()"'+disabled+'>验证后预览／下载</button>'
     :'<span class="muted">管理员尚未设置本项目下载口令；设置口令后开放水印预览与下载。</span>')+'</div>'
   +(!readOnly()&&s.can_manage?'<details class="library-password-admin"><summary>管理项目下载口令</summary><p class="muted">使用独立项目口令，8至128个字符并含字母和数字。更换后所有已验证访问立即失效，不改变登录密码。</p><label>新项目口令<input type="password" id="library_manage_password" autocomplete="new-password"'+disabled+'></label><button type="button" class="btn" onclick="ProjectLibrary.setPassword()"'+disabled+'>保存新口令</button></details>':'')
   +(canUpload(s)?'<div class="library-upload"><h4>'+(s.newVersion?'上传新版本（原版本保留）':'上传项目资料')+'</h4><div class="library-upload-fields">'
   +'<label>资料名称<input id="library_title" value="'+esc(s.title)+'" maxlength="200" oninput="ProjectLibrary.edit(\'title\',this.value)"'+disabled+'></label>'
   +'<label>分类（可选）<input value="'+esc(s.uploadCategory)+'" list="library-category-suggestions" maxlength="80" oninput="ProjectLibrary.edit(\'uploadCategory\',this.value)"'+disabled+'></label>'
   +'<datalist id="library-category-suggestions">'+suggestions.map(function(x){return '<option value="'+esc(x)+'"></option>';}).join('')+'</datalist>'
   +'<label>文件<input type="file" id="library_file" accept=".pdf,.png,.jpg,.jpeg" onchange="ProjectLibrary.pickFile(this)"'+disabled+'></label>'
   +'<button type="button" class="btn primary" onclick="ProjectLibrary.upload()"'+disabled+'>'+(s.busy?'处理中…':'上传资料')+'</button>'
   +(s.newVersion?'<button type="button" class="btn ghost" onclick="ProjectLibrary.cancelVersion()"'+disabled+'>改为新建资料</button>':'')+'</div>'+(s.file?'<p class="muted">已选择：'+esc(s.file.name)+'（尚未上传）</p>':'')+'</div>':'')
   +'<div class="library-filters"><label>查找名称<input value="'+esc(s.q)+'" oninput="ProjectLibrary.edit(\'q\',this.value)" maxlength="200"'+disabled+'></label>'
   +'<label>分类<select onchange="ProjectLibrary.edit(\'category\',this.value);ProjectLibrary.reload()"'+disabled+'><option value="">全部分类</option>'+categories.map(function(x){return '<option value="'+esc(x)+'"'+(x===s.category?' selected':'')+'>'+esc(x)+'</option>';}).join('')+'</select></label>'
   +'<label class="library-history"><input type="checkbox"'+(s.history?' checked':'')+' onchange="ProjectLibrary.edit(\'history\',this.checked);ProjectLibrary.reload()"'+disabled+'>包括已撤回历史</label><button type="button" class="btn ghost" onclick="ProjectLibrary.reload()"'+disabled+'>查找</button></div>'
   +(s.loading?'<p class="muted" role="status">正在读取共享资料…</p>':'')
   +'<div class="tablewrap"><table class="library-table"><thead><tr><th>资料及版本</th><th>分类</th><th>格式／大小</th><th>上传人／时间</th><th>操作</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5" class="empty">'+(s.loading?'读取中…':'暂无符合条件的共享资料。')+'</td></tr>')+'</tbody></table></div></section>';
 }
 async function write(operation,body){
  if(operation!=='unlock'&&readOnly())return false;
  var c=current();if(!c||c.s.busy)return false;var t=token(c.pid),s=c.s;s.busy=true;s.error='';s.notice='';cfg.render();
  try{result(await cfg.request('/api/project-library/'+operation,body));if(!here(t))return false;s.busy=false;await reload();return true;}
  catch(error){if(here(t)){s.error=error.message;cfg.toast(error.message,'err');}return false;}
  finally{if(here(t)){s.busy=false;cfg.render();}else s.busy=false;}
 }
 async function unlock(){var c=current(),input=global.document.getElementById('library_unlock_password');if(!c||!input)return;var password=input.value;input.value='';await write('unlock',{project_id:c.pid,password:password});}
 async function setPassword(){var c=current(),input=global.document.getElementById('library_manage_password');if(!c||!input||readOnly()||!c.s.can_manage)return;var password=input.value;input.value='';if(await write('password',{project_id:c.pid,password:password}))cfg.toast('项目下载口令已更新');}
 async function upload(){
  var c=current();if(!c||c.s.busy||!canUpload(c.s))return;var s=c.s,t=token(c.pid),file=s.file;
  if(!file)return cfg.toast('请选择PDF、PNG或JPEG文件','err');
  if(file.size>8*1024*1024)return cfg.toast('单件资料不能超过8 MiB','err');
  var title=global.document.getElementById('library_title');if(title)s.title=title.value;
  s.busy=true;s.error='';cfg.render();
  try{
   var params=new URLSearchParams({project_id:c.pid,filename:file.name,title:s.title||file.name,category:s.uploadCategory||'其他'});if(s.newVersion)params.set('new_version_of',s.newVersion);
   var response=await global.fetch('/api/project-library/upload?'+params.toString(),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream'},body:file});
   var data=await response.json();if(!response.ok&&!data.error)data.error={message:'资料上传失败（'+response.status+'）'};result(data);
   if(!here(t))return;s.file=null;s.title='';s.newVersion=null;s.busy=false;cfg.toast('资料已上传，旧版本保持');await reload();
  }catch(error){if(here(t)){s.error=error.message||'上传失败，原输入保留';cfg.toast(s.error,'err');}}
  finally{if(here(t)){s.busy=false;cfg.render();}else s.busy=false;}
 }
 function version(id){var c=current();if(!c||c.s.busy||!canUpload(c.s))return;var row=c.s.items.filter(function(x){return x.id===id;})[0];if(!row)return;c.s.newVersion=id;c.s.title=row.title;c.s.uploadCategory=row.category;c.s.file=null;cfg.render();}
 function cancelVersion(){var c=current();if(!c||c.s.busy||!canUpload(c.s))return;c.s.newVersion=null;c.s.file=null;cfg.render();}
 async function withdraw(id){var c=current();if(!c||readOnly()||!c.s.items.some(function(row){return row.id===id&&row.can_withdraw;}))return;if(!global.confirm('撤回后普通成员不能再预览或下载，历史版本仍保留。确认撤回？'))return;await write('withdraw',{id:id});}
 async function open(id,inline,original){
  var c=current();if(!c||c.s.busy||original&&(readOnly()||!c.s.can_manage))return;var row=c.s.items.filter(function(x){return x.id===id;})[0];if(!row)return;
  var t=token(c.pid),popup=inline?global.open('about:blank','_blank'):null;
  try{
   var response=await global.fetch('/api/project-library/'+encodeURIComponent(id)+(original?'?original=1':inline?'?inline=1':''),{credentials:'same-origin'});
   if(!response.ok){var failure=await response.json(),error=new Error(failure.error&&failure.error.message||'资料读取失败');error.code=failure.error&&failure.error.code;throw error;}
   var blob=await response.blob();if(!here(t)){if(popup)popup.close();return;}
   var url=URL.createObjectURL(blob);
   if(inline&&popup){popup.opener=null;popup.location.href=url;}
   else{var link=global.document.createElement('a');link.href=url;link.download=original?row.name:row.name.replace(/(\.[^.]+)$/,'_水印$1');link.click();}
   global.setTimeout(function(){URL.revokeObjectURL(url);},60000);
  }catch(error){if(popup)popup.close();if(here(t)){if(error.code==='library_locked')c.s.unlocked=false;c.s.error=error.message;cfg.toast(error.message,'err');cfg.render();}}
 }
 global.ProjectLibrary={configure:configure,html:html,reload:reload,edit:edit,pickFile:pickFile,unlock:unlock,setPassword:setPassword,upload:upload,version:version,cancelVersion:cancelVersion,withdraw:withdraw,open:open};
})(window);
