import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {testPool} from './helpers/pglite-pool.mjs';

const source=await readFile(new URL('../web/planning-ai.js',import.meta.url),'utf8');
const memorySource=await readFile(new URL('../web/planning-ai-memory.js',import.meta.url),'utf8');
const css=await readFile(new URL('../web/planning-ai.css',import.meta.url),'utf8');
const artifacts=process.env.PLANNING_AI_MEMORY_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-ai-memory-ui');

async function fixture(browser,viewport={width:1440,height:1000}){
 const page=await browser.newPage({viewport});await page.route('**/*',route=>route.abort('blockedbyclient'));
 await page.setContent('<button id="entry">AI 帮我整理</button><textarea id="original">保留的本人填报草稿</textarea>');
 await page.addStyleTag({content:css});await page.addScriptTag({content:memorySource});await page.addScriptTag({content:source});
 await page.evaluate(()=>{
  window.ctx={key:'user-a/project-a/module-a/2026-10-26',identityKey:'user-a/session-a',canEdit:true,project_id:'project-a',line:'机电工程',period:'2026-10-26',projectName:'匿名项目A',lineLabel:'机电工程',periodLabel:'第44周（10.26—11.01）',items:[{id:'monthly:a',title:'匿名设备安装',progress:'保留的本人填报草稿'}]};
  window.authUser='user-a';window.memoryMode='ok';window.memoryCalls=[];window.modelCalls=[];window.applies=[];window.undos=[];window.notes=[];window.memoryStore={conversations:{},preferences:{}};window.pendingMemory=[];
  const copy=value=>JSON.parse(JSON.stringify(value));
  const keys=body=>({conversation:JSON.stringify([authUser,body.project_id,body.line,body.report_scope_id || '',body.period]),preference:JSON.stringify([authUser,body.project_id,body.line,body.report_scope_id || ''])});
  window.currentMemory=()=>{const key=keys(ctx);return {conversation:memoryStore.conversations[key.conversation] || {messages:[],revision:0,updated_at:null},preference:memoryStore.preferences[key.preference] || {content:'',revision:0,updated_at:null}};};
  window.seedMemory=(messages,content='')=>{const key=keys(ctx);memoryStore.conversations[key.conversation]={messages:copy(messages),revision:messages.length?1:0,updated_at:null};memoryStore.preferences[key.preference]={content,revision:content?1:0,updated_at:null};};
  window.memoryRequest=async(action,body,context,signal)=>{
   memoryCalls.push({action,body:copy(body),identity:context.identityKey});
   const key=keys(body);
   if(action==='load'){
    if(memoryMode==='fail-load')throw new Error('记忆读取暂时失败');
    if(memoryMode==='forbidden-load')throw Object.assign(new Error('当前填报范围已失去访问权限'),{code:'ai_scope_forbidden',status:403});
    const result=copy({conversation:memoryStore.conversations[key.conversation] || {messages:[],revision:0,updated_at:null},preference:memoryStore.preferences[key.preference] || {content:'',revision:0,updated_at:null}});
    if(memoryMode==='pending-load'){memoryMode='ok';return new Promise(resolve=>pendingMemory.push({resolve:()=>resolve(result)}));}
    return result;
   }
   if(memoryMode==='fail-save')throw new Error('记忆保存暂时失败');
   const table=action==='conversation'?memoryStore.conversations:memoryStore.preferences,index=key[action],old=table[index] || {revision:0};
   if(body.expected_revision!==old.revision || memoryMode==='conflict-save')throw Object.assign(new Error('AI记忆已变化，请重新读取后再保存'),{code:'ai_memory_changed',status:409});
   const result={...(action==='conversation'?{messages:copy(body.messages)}:{content:body.content}),revision:old.revision+1,updated_at:'2026-10-28T02:00:00Z'};
   table[index]=result;
   if(memoryMode==='pending-save'){memoryMode='ok';return new Promise(resolve=>pendingMemory.push({resolve:()=>resolve(copy(result))}));}
   return copy(result);
  };
  window.boot=()=>{
   PlanningAI.configure({getContext:()=>ctx,memoryRequest,notify:message=>notes.push(message),request:async packet=>{
    modelCalls.push(copy({context:packet.context,messages:packet.messages}));return {reply:'已整理，原有填报文字保留。',draft:{items:[{id:'monthly:a',progress:'匿名设备已就位，等待检查。',sources:['用户输入']}]}};
   },onApply:async packet=>{applies.push(copy(packet));document.querySelector('#original').value+='；'+packet.draft.items[0].progress;return {message:'已保存到本机草稿，未提交。',receipt_id:'anonymous-receipt'};},onUndo:async packet=>{undos.push(packet);return {message:'已撤销本次保存，未提交。'};}});
  };
  window.changeScope=change=>{ctx={...ctx,...change};ctx.key=JSON.stringify([ctx.identityKey,ctx.project_id,ctx.line,ctx.period,ctx.report_scope_id || '']);PlanningAI.refresh();PlanningAI.open();};
  boot();document.querySelector('#entry').onclick=()=>PlanningAI.open();
 });
 return page;
}
async function open(page){await page.locator('#entry').click();await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在读取');}
async function manage(page){await page.getByRole('button',{name:'对话与记忆',exact:true}).click();await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toBeEnabled();}
async function send(page,text){await page.locator('.planning-ai-input').fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.planning-ai-message.is-assistant').last()).toContainText('已整理');await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在保存');}

test('a fresh chat client resumes text only and requires a new current-context proposal before another draft write',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await open(page);await send(page,'设备已就位，请保留原文');
  await page.getByRole('button',{name:'确认保存到本周草稿',exact:true}).click();await expect(page.locator('.planning-ai-receipt')).toContainText('已保存');
  await expect.poll(()=>page.evaluate(()=>currentMemory().conversation.messages.length)).toBe(2);
  const original=await page.locator('#original').inputValue();
  await page.evaluate(()=>{PlanningAI.reset();boot();PlanningAI.open();});
  await expect(page.locator('.planning-ai-message')).toHaveCount(2);await expect(page.locator('.planning-ai-log')).toContainText('当时的整理建议');
  await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'撤销这次保存',exact:true})).toHaveCount(0);
  assert.equal(await page.evaluate(()=>applies.length),1);assert.equal(await page.evaluate(()=>modelCalls.length),1);assert.equal(await page.locator('#original').inputValue(),original);
  await send(page,'继续整理当前事项');assert.equal(await page.evaluate(()=>modelCalls[1].messages[0].content),'设备已就位，请保留原文');
  await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(1);assert.equal(await page.locator('#original').inputValue(),original);
 }finally{await browser.close();}
});

test('explicit writing preferences can be viewed edited deleted and inherited only by the same account project and profession',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await page.evaluate(()=>seedMemory([{role:'user',content:'仅本周的历史对话'}]));await open(page);await manage(page);
  await page.getByRole('textbox',{name:'个人写法偏好',exact:true}).fill('语言简洁，按完成情况、卡点、下步安排组织。');await page.getByRole('button',{name:'保存写法',exact:true}).click();await expect(page.locator('.planning-ai-memory-status')).toContainText('个人写法已保存');
  await page.getByRole('textbox',{name:'个人写法偏好',exact:true}).fill('保留专业用语，先结果后卡点。');await page.getByRole('button',{name:'保存写法',exact:true}).click();await expect.poll(()=>page.evaluate(()=>currentMemory().preference.content)).toBe('保留专业用语，先结果后卡点。');
  await page.getByRole('button',{name:'返回对话',exact:true}).click();await page.evaluate(()=>changeScope({period:'2026-11-02'}));await expect(page.locator('.planning-ai-message')).toHaveCount(0);await manage(page);await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('保留专业用语，先结果后卡点。');
  for(const change of [{project_id:'project-b'},{project_id:'project-a',line:'精装工程'},{line:'机电工程',identityKey:'user-b/session-b'}]){
   await page.evaluate(change=>{if(change.identityKey)authUser='user-b';changeScope(change);},change);await manage(page);await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'删除写法',exact:true})).toBeDisabled();
  }
  await page.evaluate(()=>{authUser='user-a';changeScope({identityKey:'user-a/session-new',project_id:'project-a',line:'机电工程',period:'2026-10-26'});});await manage(page);
  await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('保留专业用语，先结果后卡点。');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除写法',exact:true}).click();await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('');
  assert.equal(await page.evaluate(()=>currentMemory().preference.revision),3);assert.equal(await page.locator('#original').inputValue(),'保留的本人填报草稿');assert.equal(await page.evaluate(()=>applies.length),0);
 }finally{await browser.close();}
});

test('editing and removing history and starting a new conversation preserve original drafts inputs and attachments',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await page.evaluate(()=>seedMemory([{role:'user',content:'需要修正的历史文字'},{role:'assistant',content:'此前的历史回复'}]));await open(page);await manage(page);
  await page.locator('.planning-ai-memory-history summary').click();await page.getByRole('button',{name:'修改记录',exact:true}).first().click();await page.getByRole('textbox',{name:'第1条对话记录',exact:true}).fill('已修改的历史文字');await page.getByRole('button',{name:'保存对话修改',exact:true}).click();await expect.poll(()=>page.evaluate(()=>currentMemory().conversation.messages[0].content)).toBe('已修改的历史文字');
  await page.locator('.planning-ai-memory-history summary').click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除记录',exact:true}).last().click();await expect.poll(()=>page.evaluate(()=>currentMemory().conversation.messages.length)).toBe(1);
  await page.getByRole('button',{name:'返回对话',exact:true}).click();await page.locator('.planning-ai-input').fill('尚未发送的用户文字');await page.locator('.planning-ai-picker').setInputFiles({name:'匿名材料.pdf',mimeType:'application/pdf',buffer:Buffer.from('anonymous')});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'新对话',exact:true}).click();await expect(page.locator('.planning-ai-message')).toHaveCount(0);await expect(page.locator('.planning-ai-input')).toHaveValue('尚未发送的用户文字');await expect(page.locator('.planning-ai-selected')).toContainText('匿名材料.pdf');
  assert.equal(await page.evaluate(()=>currentMemory().conversation.messages.length),0);assert.equal(await page.locator('#original').inputValue(),'保留的本人填报草稿');
  await page.evaluate(()=>{PlanningAI.reset();boot();PlanningAI.open();});await expect(page.locator('.planning-ai-message')).toHaveCount(0);assert.equal(await page.evaluate(()=>applies.length),0);
 }finally{await browser.close();}
});

test('failed and conflicting memory writes keep local edits and queued older saves cannot resurrect a cleared conversation',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await open(page);await page.evaluate(()=>memoryMode='fail-save');await send(page,'网络失败时保留当前对话');await expect(page.locator('.planning-ai-memory-status')).toContainText('记忆保存暂时失败');await expect(page.locator('.planning-ai-log')).toContainText('网络失败时保留当前对话');
  await page.evaluate(()=>memoryMode='ok');await page.getByRole('button',{name:'重试保存对话',exact:true}).click();await expect.poll(()=>page.evaluate(()=>currentMemory().conversation.messages.length)).toBe(2);
  await manage(page);await page.getByRole('textbox',{name:'个人写法偏好',exact:true}).fill('不会因冲突丢失的写法');await page.evaluate(()=>memoryMode='conflict-save');await page.getByRole('button',{name:'保存写法',exact:true}).click();await expect(page.locator('.planning-ai-memory-status')).toContainText('AI记忆已变化');await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('不会因冲突丢失的写法');
  await page.evaluate(()=>memoryMode='ok');await page.getByRole('button',{name:'保存写法',exact:true}).click();await expect.poll(()=>page.evaluate(()=>currentMemory().preference.content)).toBe('不会因冲突丢失的写法');
  await page.getByRole('button',{name:'返回对话',exact:true}).click();await page.evaluate(()=>memoryMode='pending-save');await page.locator('.planning-ai-input').fill('清空之前正在保存的这轮对话');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.planning-ai-message.is-assistant')).toHaveCount(2);await expect.poll(()=>page.evaluate(()=>pendingMemory.length)).toBe(1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'新对话',exact:true}).click();await page.evaluate(()=>pendingMemory.shift().resolve());await expect.poll(()=>page.evaluate(()=>currentMemory().conversation.messages.length)).toBe(0);await expect(page.locator('.planning-ai-message')).toHaveCount(0);
  const saves=await page.evaluate(()=>memoryCalls.filter(call=>call.action==='conversation').slice(-3).map(call=>({expected:call.body.expected_revision,messages:call.body.messages.length})));assert.equal(saves.length,3);assert.equal(saves[1].expected,saves[0].expected+1);assert.equal(saves[2].expected,saves[1].expected+1);assert.equal(saves[2].messages,0);
  await page.evaluate(()=>{PlanningAI.reset();boot();PlanningAI.open();});await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在读取');await expect(page.locator('.planning-ai-message')).toHaveCount(0);
  assert.equal(await page.locator('#original').inputValue(),'保留的本人填报草稿');
 }finally{await browser.close();}
});

test('late memory results never cross project or account boundaries and explicit revocation hides previously loaded memory',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser);await page.evaluate(()=>{seedMemory([{role:'assistant',content:'项目A私有历史文字'}],'项目A私有写法');memoryMode='pending-load';});await page.locator('#entry').click();await expect.poll(()=>page.evaluate(()=>pendingMemory.length)).toBe(1);
  await page.evaluate(()=>changeScope({project_id:'project-b',projectName:'匿名项目B'}));await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在读取');await page.evaluate(()=>pendingMemory.shift().resolve());await expect(page.locator('.planning-ai-log')).not.toContainText('项目A私有历史文字');
  await page.evaluate(()=>{memoryMode='pending-load';changeScope({project_id:'project-c'});});await expect.poll(()=>page.evaluate(()=>pendingMemory.length)).toBe(1);await page.evaluate(()=>{authUser='user-b';changeScope({identityKey:'user-b/session-b'});pendingMemory.shift().resolve();});await expect(page.locator('.planning-ai-message')).toHaveCount(0);
  await page.evaluate(()=>{authUser='user-a';changeScope({identityKey:'user-a/session-new',project_id:'project-a'});});await expect(page.locator('.planning-ai-log')).toContainText('项目A私有历史文字');await manage(page);await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('项目A私有写法');
  await page.evaluate(()=>memoryMode='forbidden-load');await page.getByRole('button',{name:'重新读取记忆',exact:true}).click();await expect(page.locator('.planning-ai-memory-status')).toContainText('失去访问权限');await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('');await page.getByRole('button',{name:'返回对话',exact:true}).click();await expect(page.locator('.planning-ai-log')).not.toContainText('项目A私有历史文字');assert.equal(await page.evaluate(()=>applies.length),0);
 }finally{await browser.close();}
});

test('memory text remains escaped and the management panel fits a phone without horizontal overflow',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await fixture(browser,{width:390,height:844});await page.evaluate(()=>seedMemory([{role:'user',content:'<img src=x onerror="window.unsafe=true">'},{role:'assistant',content:'<script>window.unsafe=true</script>'}],'简洁表达'.repeat(70)));await open(page);await manage(page);await page.locator('.planning-ai-memory-history summary').click();
  await expect(page.locator('.planning-ai-memory-history')).toContainText('<script>');assert.equal(await page.locator('.planning-ai-memory-panel img,.planning-ai-memory-panel script').count(),0);assert.equal(await page.evaluate(()=>!!window.unsafe),false);
  const metrics=await page.getByRole('dialog').evaluate(dialog=>{const r=dialog.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:dialog.scrollWidth>dialog.clientWidth};});assert.ok(metrics.left>=0 && metrics.right<=metrics.width+1);assert.equal(metrics.overflow,false);
  await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'mobile-memory-panel.png')});
 }finally{await browser.close();}
});

test('actual authenticated HTTP and browser reload resume server text and writing preferences while business reports remain byte-identical',async()=>{
 const runtime=await startPlanningAiLocal({mode:'local-acceptance'}),browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const admin=testPool(runtime.db,null),snapshot=async()=>(await admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'completions',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.completion_requests c),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY project_id,user_id) FROM public.project_members m)) value")).rows[0].value;
  const before=await snapshot(),page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  let providerRequests=0;await page.route('**/api/planning-ai/chat',async route=>{providerRequests++;const body=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{reply:'匿名服务端续聊回复。',draft:{items:[{id:body.items[0].id,progress:'匿名建议进展，需确认后才写入。',sources:['用户输入']}]}},error:null})});});
  async function login(){await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));await page.getByRole('button',{name:'AI 填报助手',exact:true}).click();await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在读取');}
  await login();await page.locator('.planning-ai-input').fill('下次继续这段匿名现场整理');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.planning-ai-log')).toContainText('匿名服务端续聊回复。');await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在保存');
  await manage(page);await page.getByRole('textbox',{name:'个人写法偏好',exact:true}).fill('表达简洁，保留专业术语。');await page.getByRole('button',{name:'保存写法',exact:true}).click();await expect(page.locator('.planning-ai-memory-status')).toContainText('个人写法已保存');
  await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.evaluate(()=>App.view('form'));await page.getByRole('button',{name:'AI 填报助手',exact:true}).click();await expect(page.locator('.planning-ai-log')).toContainText('下次继续这段匿名现场整理');await expect(page.locator('.planning-ai-log')).toContainText('匿名服务端续聊回复。');await expect(page.getByRole('button',{name:'确认保存到本周草稿',exact:true})).toHaveCount(0);assert.equal(providerRequests,1);
  await manage(page);await expect(page.getByRole('textbox',{name:'个人写法偏好',exact:true})).toHaveValue('表达简洁，保留专业术语。');await page.getByRole('button',{name:'收起 AI 填报助手',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).click();await login();await expect(page.locator('.planning-ai-log')).toContainText('下次继续这段匿名现场整理');assert.equal(providerRequests,1);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(errors,[]);await mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'actual-http-restored-chat.png')});
 }finally{await browser.close();await runtime.close();}
});
