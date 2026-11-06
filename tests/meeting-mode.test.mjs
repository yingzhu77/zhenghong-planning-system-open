import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {testPool} from './helpers/pglite-pool.mjs';
import {executeDatabase} from '../server/database.mjs';
import {confirmMonthlyPlan} from '../server/monthly-plans.mjs';
import {webAssets} from '../server/web-assets.mjs';

const web=new URL('../web/',import.meta.url),artifacts=process.env.MEETING_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-meeting');

function controllerFixture(){
  let mounted=true,serial=0,timerId=0,html='';const intervals=new Map(),timeouts=new Map(),listeners=new Map(),controls=new Map(),notices=[];
  const host={replaceChildren(){html='';},querySelector(selector){
    if(!html.includes(selector.slice(1,-1)))return null;
    if(!controls.has(selector))controls.set(selector,{});return controls.get(selector);
  },querySelectorAll(){return [];}};
  Object.defineProperty(host,'innerHTML',{get:()=>html,set:value=>{html=value;}});
  const context={allowed:true,uid:'anonymous-ops',identity:'anonymous-ops|1',target:{kind:'report',type:'res',projectIds:['p1'],period:'2026-11-02',line:'',section:'all'},projects:[{id:'p1',project_type:'res'}],projectProfessions:[{project_id:'p1',lines:['工程']}]};
  const env={location:{origin:'https://meeting.example.test'},document:{getElementById:()=>mounted?host:null},
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`},
    setInterval:fn=>{const id=++timerId;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),
    setTimeout:fn=>{const id=++timerId;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),
    MeetingView:{sections:{all:'完整周报',monthly:'月度会议（总结＋计划）',plans:'当月计划'},esc:value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;'),target:value=>{
      const next=JSON.parse(JSON.stringify(value));
      if(next.section==='monthly'){
        next.summaryMonth=next.summaryMonth || '2026-10';
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(next.summaryMonth))throw Error('invalid month');
      }else delete next.summaryMonth;
      return next;
    }}
  };env.window=env;vm.runInNewContext(readFileSync(new URL('meeting-controller.js',web),'utf8'),env);
  env.MeetingController.configure({getContext:()=>context,displayUrl:'/meeting-display.html',notify:(...args)=>notices.push(args)});
  function child(){return {closed:false,messages:[],focus(){},close(){this.closed=true;},postMessage(packet,origin){this.messages.push({packet:JSON.parse(JSON.stringify(packet)),origin});}};}
  function emit(child,type,extra={}){for(const listener of listeners.get('message') || [])listener({origin:env.location.origin,source:child,data:{app:'planning-meeting-v1',id:String(child.location).split('#')[1],type,...extra}});}
  return {api:env.MeetingController,context,child,emit,intervals,timeouts,listeners,notices,host,controls,get html(){return html;},mount(value){mounted=value;},poll(){for(const fn of [...intervals.values()])fn();},nextTask(){const jobs=[...timeouts.values()];timeouts.clear();jobs.forEach(fn=>fn());}};
}

test('closing the projection clears its toolbar and session, removes timers/listeners and permits a fresh window',()=>{
  const f=controllerFixture(),first=f.child();f.api.start(first);f.emit(first,'ready');
  assert.match(f.html,/会议投影控制台/);assert.equal(f.intervals.size,1);assert.equal(f.listeners.get('message').size,1);
  const previous=String(first.location);first.closed=true;f.emit(first,'closed');
  assert.equal(f.html,'');assert.equal(f.api.active(),false);assert.equal(f.intervals.size,0);assert.equal(f.listeners.get('message').size,0);
  assert.equal(f.api.savedAction({meeting_kind:'requirement'}),'');
  const second=f.child();f.api.start(second);assert.notEqual(String(second.location),previous);
  f.emit(first,'failed',{message:'stale failure'});assert.doesNotMatch(f.html,/stale failure/);
  f.controls.get('[data-meeting-stop]').onclick();assert.equal(second.closed,true);assert.equal(f.html,'');assert.equal(f.intervals.size,0);
});

test('beforeunload from a child reload does not end the projection session',()=>{
  const f=controllerFixture(),child=f.child();f.api.start(child);f.emit(child,'ready');
  const session=String(child.location),firstShows=child.messages.filter(row=>row.packet.type==='show').length;
  f.emit(child,'closed');f.nextTask();assert.equal(f.api.active(),true);assert.equal(f.intervals.size,1);assert.equal(String(child.location),session);
  f.emit(child,'ready');assert.equal(child.messages.filter(row=>row.packet.type==='show').length,firstShows+1);
  assert.match(f.html,/会议投影控制台/);f.api.stop(true);
});

test('commercial mode changes during popup reload follow the latest selection while paused windows keep their chosen view',()=>{
  const f=controllerFixture(),child=f.child();f.context.target.type='com';f.api.start(child);f.emit(child,'ready');
  const lastShow=()=>child.messages.filter(row=>row.packet.type==='show').at(-1).packet;
  const setMode=value=>f.controls.get('[data-meeting-mode]').onchange({target:{value}});
  assert.equal(lastShow().target.section,'all');
  f.emit(child,'displayed',{sequence:lastShow().sequence});f.emit(child,'closed');setMode('monthly');
  assert.equal(lastShow().target.section,'all');
  f.emit(child,'ready');assert.equal(lastShow().target.section,'monthly');
  f.emit(child,'displayed',{sequence:lastShow().sequence});f.controls.get('[data-meeting-toggle]').onclick();
  f.emit(child,'closed');setMode('weekly');f.emit(child,'ready');assert.equal(lastShow().target.section,'monthly');
  f.controls.get('[data-meeting-toggle]').onclick();assert.equal(lastShow().target.section,'all');
  f.api.stop(true);
});

test('closing while the admin is on another page still clears state before returning to the overview',()=>{
  const f=controllerFixture(),child=f.child();f.api.start(child);
  const target=f.context.target;f.mount(false);f.context.target=null;f.api.refresh();assert.equal(f.api.active(),true);
  child.closed=true;f.poll();assert.equal(f.api.active(),false);assert.equal(f.intervals.size,0);assert.equal(f.listeners.get('message').size,0);
  f.mount(true);f.context.target=target;f.api.refresh();assert.equal(f.html,'');
});

test('monthly controls keep the explicitly selected summary month through profession changes and refreshes',()=>{
  const f=controllerFixture(),child=f.child();f.api.start(child);f.emit(child,'ready');
  assert.match(f.html,/总结月份/);assert.match(f.html,/月度计划会/);assert.doesNotMatch(f.html,/周例会|data-meeting-section|meeting-control-preview|meeting-control-hint/);
  const shows=()=>child.messages.filter(row=>row.packet.type==='show').map(row=>row.packet);
  assert.equal(shows().at(-1).target.summaryMonth,'2026-10');
  f.controls.get('[data-meeting-month]').onchange({target:{value:'2026-09'}});assert.equal(shows().at(-1).target.summaryMonth,'2026-09');
  f.emit(child,'displayed',{sequence:shows().at(-1).sequence,title:'匿名项目'});f.emit(child,'profession',{line:'工程'});
  assert.equal(shows().at(-1).target.summaryMonth,'2026-09');assert.equal(shows().at(-1).target.line,'工程');
  f.context.target.period='2026-12-07';f.api.refresh();assert.equal(shows().at(-1).target.summaryMonth,'2026-09');
  f.emit(child,'closed');f.nextTask();f.emit(child,'ready');assert.equal(shows().at(-1).target.summaryMonth,'2026-09');
  f.controls.get('[data-meeting-month]').onchange({target:{value:'bad-month'}});assert.equal(f.notices.length,1);assert.equal(shows().at(-1).target.summaryMonth,'2026-09');
  f.api.stop(true);
});
test('projection selectors reject invalid payloads and display escapes source text without exposing editable fields',()=>{
  const context={console};context.window=context;vm.createContext(context);
  for(const file of ['planning-windows.js','rich-text.js','monthly-summaries.js','meeting-view.js'])vm.runInContext(readFileSync(new URL(file,web),'utf8'),context);
  const api=context.MeetingView,valid={type:'res',projectIds:['res-a'],period:'2026-10-26',line:'',section:'plans'};
  for(const selection of [{...valid,projectIds:[]},{...valid,projectIds:['res-a','res-a']},{...valid,period:'invalid'},{...valid,section:'constructor'},
    {...valid,kind:'arrangement',taskId:'wrong'},{...valid,projectIds:['res-a','res-b'],kind:'arrangement',taskId:'dce39b3f-7145-4b6f-983b-055c0492d6b2'}])assert.throws(()=>api.target(selection));
  const model={target:api.target(valid),projects:[{id:'res-a',name:'项目<script>'}],readAt:'10:00',reports:[{project_id:'res-a',line:'综合',author_name:'人员<iframe>',biz:{items:[{name:'事项<script>',mod:'模块',prog:'进展<img onerror=x>'}]}}],nodes:[],drawings:[],attachments:[]};
  const html=api.html(model);assert.match(html,/事项&lt;script&gt;/);assert.doesNotMatch(html,/<script|<iframe|<input|<textarea|contenteditable/);
  assert.equal((html.match(/data-projection-section=/g)||[]).length,1);assert.match(html,/data-projection-section="plans"/);
  assert.equal((html.match(/<th scope="col">/g)||[]).length,4);assert.doesNotMatch(html,/<th[^>]*>实际项目／填报人/);
  model.projects.push({id:'res-b',name:'二期'});model.reports[0].report_scope_id='group';model.reports[0].scope_project_ids=['res-a','res-b'];
  model.reports[0].biz.items=[{project_id:'res-b',name:'原二期事项'},{name:'没有实际项目的原事项'}];
  const grouped=api.html(model);assert.match(grouped,/二期<small>/);assert.match(grouped,/统一范围 · 未明确子项目/);
});

test('monthly projection keeps narrative columns left aligned, compact long rows and once-per-group source captions across display sizes',async t=>{
  const context={console};context.window=context;vm.createContext(context);
  for(const file of ['planning-windows.js','rich-text.js','monthly-summaries.js','meeting-view.js'])vm.runInContext(readFileSync(new URL(file,web),'utf8'),context);
  const items=Array.from({length:12},(_,i)=>({mod:i%2?'移交事项':'砌筑工程',name:i%2?'屋面移交：示例一号楼与二号楼分批交接，确认施工界面和设备进场条件':'地下室设备房移交：生活水泵房、消防水泵房依计划完成并核对验收资料',due:'2026-10-31',prog:i%3?'按计划推进，已完成施工界面核对，待联合验收':'本周已完成现场核查，剩余事项按原计划推进',...(i===2?{blocker:'等待验收资料'}:{})}));
  const report={project_id:'com-a',line:'土建工程',author_name:'示例填报人甲',biz:{items},rich_text:{v:1,fields:{'biz.items.0.prog':{ops:[{insert:items[0].prog,attributes:{bold:true,color:'#d81e06'}}]}}}};
  context.ZHRichText.attach(report);
  const model={target:context.MeetingView.target({type:'com',projectIds:['com-a'],period:'2026-10-26',line:'土建工程',section:'plans'}),projects:[{id:'com-a',name:'示例商业项目'}],readAt:'10:00:00',reports:[report],nodes:[],drawings:[],attachments:[]};
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<!doctype html><html lang="zh-CN"><style>'+readFileSync(new URL('meeting-mode.css',web),'utf8')+'</style><body class="meeting-display"><div class="meeting-display-tools"><b>会议投影</b><span>跟随管理员选择</span></div><main>'+context.MeetingView.html(model)+'</main></body></html>');
  const table=page.locator('.meeting-plan-table');await expect(table.locator('th')).toHaveText(['模块','事项','完成时间','当周进展']);
  await expect(table.locator('caption')).toHaveText('示例商业项目示例填报人甲 · 土建工程');
  await expect(table.locator('tbody tr')).toHaveCount(12);await expect(table.locator('tbody td')).toHaveCount(48);
  await expect(table.locator('.rt-red strong,strong.rt-red')).toHaveText(items[0].prog);await expect(table).toContainText('遇到卡点：等待验收资料');
  mkdirSync(artifacts,{recursive:true});
  for(const viewport of [{width:1920,height:1080},{width:1440,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
    if(viewport.width>700){
      assert.equal(await table.locator('th,td').evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).textAlign==='left' && getComputedStyle(cell).verticalAlign==='top')),true);
      const bounds=await table.locator('th').evaluateAll(cells=>cells.map(cell=>cell.getBoundingClientRect().width));
      assert.ok(bounds[1]>bounds[0] && bounds[3]>bounds[2]);
      const head=await table.locator('thead').boundingBox();assert.ok(head.y<250,'compact heading leaves space for the report');
      const rows=await table.locator('tbody tr').evaluateAll(rows=>rows.slice(0,6).map(row=>row.getBoundingClientRect().bottom));assert.ok(rows[5]<viewport.height,'six long rows are visible without scrolling');
    }else{
      const caption=await table.locator('caption').boundingBox();assert.ok(caption.width>250 && caption.height<80,'mobile source caption stays horizontal');
      assert.equal(await table.locator('td[data-label="事项"],td[data-label="当周进展"]').evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).textAlign==='left')),true);
    }
    await page.screenshot({path:path.join(artifacts,'display-four-columns-'+viewport.width+'.png')});
  }
  model.target.type='res';model.target.line='';model.target.projectIds.push('res-b');model.projects.push({id:'res-b',name:'示例住宅二期'});
  model.reports=[{...report,report_scope_id:'unified',biz:{items:[{...items[0],project_id:'res-b'},{...items[1]}]}},{...report,author_name:'示例填报人乙',biz:{items:[items[2]]}}];
  await page.locator('main').evaluate((main,html)=>main.innerHTML=html,context.MeetingView.html(model));
  await expect(page.locator('.meeting-plan-table')).toHaveCount(3);
  await expect(page.locator('caption')).toHaveText(['示例住宅二期示例填报人甲 · 土建工程','统一范围 · 未明确子项目示例填报人甲 · 土建工程','示例商业项目示例填报人乙 · 土建工程']);
  await expect(page.locator('tbody tr')).toHaveCount(3);assert.deepEqual(errors,[]);
});
test('standalone projection shell resolves every script and stylesheet to reviewed versioned assets',()=>{
  const assets=webAssets(path.resolve('web')),entry=[...assets.responses].find(([,r])=>r.name==='meeting-display.html');
  assert.ok(entry);const html=entry[1].body.toString();
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){assert.ok(match[1].startsWith('/assets/'));assert.ok(assets.responses.has(match[1]));}
  assert.doesNotMatch(html,/app\.js|login-boot\.js|contenteditable|password/i);
});
test('projection media accepts only the registered project excerpt and never falls back to a foreign excerpt source',()=>{
  const context={console};context.window=context;vm.createContext(context);
  for(const file of ['planning-windows.js','rich-text.js','meeting-view.js'])vm.runInContext(readFileSync(new URL(file,web),'utf8'),context);
  const url='/api/scheme-previews/p1/'+'a'.repeat(64)+'.webp';
  const model={target:context.MeetingView.target({type:'com',projectIds:['p1'],period:'2026-11-02',line:'',section:'media'}),projects:[{id:'p1',name:'匿名项目'}],reports:[],nodes:[],attachments:[],drawings:[
    {project_id:'p1',kind:'项目总图',name:'总图关键区域.webp',url,path:''},
    {project_id:'p1',kind:'项目总图',name:'跨项目不显示',url:url.replace('/p1/','/p2/'),path:'drawings/p1/original.pdf'}
  ]};
  const html=context.MeetingView.html(model);assert.ok(html.includes('src="'+url+'"'));assert.doesNotMatch(html,/original\.pdf|跨项目不显示|href="[^"]*scheme-previews/);
});
async function fixture(t){
  const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());
  const admin=testPool(runtime.db,null),root='ai-local-acceptance-user',owner='meeting-owner',leader='meeting-leader';
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('meeting-a','示例住宅甲','res'),('meeting-b','示例住宅乙','res')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,'示例工程负责人','pm','approved','meeting-a','工程'),($2,'示例提出领导','president','approved',NULL,NULL)",[owner,leader]);
  await admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,'meeting-owner@example.invalid','disposable-directory-only'),($2,'meeting-leader@example.invalid','disposable-directory-only')",[owner,leader]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'meeting-a','pm'),($1,'meeting-b','pm')",[owner]);
  for(const pid of ['meeting-a','meeting-b'])await executeDatabase(runtime.pool,{id:owner},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:pid,period:runtime.scope.period,line:'综合',
    biz:{form_version:2,nodes:[],items:[{source_id:'meeting-item',mod:'工程',name:pid==='meeting-a'?'甲项目已提交事项':'乙项目已提交事项',due:runtime.scope.week,prog:'原进展需要保留'}],handover:[]},
    rich_text:{v:1,fields:{'biz.items.0.prog':{ops:[{insert:'原进展需要保留',attributes:{bold:true,color:'#d81e06'}}]}}}}});
  for(const [pid,name] of [['meeting-a','甲项目已确认事项'],['meeting-b','乙项目已确认事项']]){
    await confirmMonthlyPlan(runtime.pool,{id:owner},{project_id:pid,line:'工程',month:runtime.scope.month,
      items:[{source_id:'meeting-plan-item',mod:'工程',name,due:runtime.scope.week}],
      rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:name,attributes:{bold:true,color:'#d81e06'}}]}}}});
  }
  await admin.query("UPDATE public.profiles SET role='ops' WHERE user_id=$1",[root]);
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const browserContext=await browser.newContext({viewport:{width:1560,height:1050}}),page=await browserContext.newPage(),errors=[],writes=[];
  function observe(p){p.on('pageerror',e=>errors.push(e.stack || e.message));p.on('request',request=>{
    if(!request.url().startsWith(runtime.url+'/api/'))return;
    const body=request.postDataJSON();
    if(request.url().endsWith('/api/db') && body?.operation && body.operation!=='select')writes.push({url:request.url(),body});
    if(/\/(?:save|replace|confirm|request|review|upload|chat)$/.test(request.url()))writes.push({url:request.url(),body});
  });}
  browserContext.on('page',observe);observe(page);
  await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#overviewFilter')).toBeVisible();
  await page.locator('#overviewFilter').selectOption('示例住宅甲');
  return {runtime,admin,root,owner,leader,page,browserContext,errors,writes};
}
test('two real windows follow selectors, pause safely, preserve rich drafts and display only explicitly selected saved arrangements',async t=>{
  const f=await fixture(t),{page,admin}=f;
  const reportsBefore=(await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS snapshot FROM public.reports r')).rows[0].snapshot;
  const tasksBefore=(await admin.query('SELECT count(*)::int n FROM public.reporter_tasks')).rows[0].n;
  const opening=page.waitForEvent('popup');await page.getByRole('button',{name:'开启会议投影',exact:true}).click();const display=await opening;
  const mode=page.getByLabel('会议模式');
  await expect(mode).toBeDisabled();await expect(mode.locator('option')).toHaveCount(1);await expect(mode).toHaveValue('monthly');
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await expect(display.locator('#meeting-screen')).not.toContainText('甲项目已提交事项');
  await expect(page.locator('.meeting-control')).toContainText('跟随中');
  await expect(display.locator('input,textarea,select:not(#meeting-profession),[contenteditable]')).toHaveCount(0);
  await expect(display.getByRole('combobox',{name:'投影专业'})).toBeEnabled();
  await expect(display.locator('.rt-red strong,strong.rt-red')).toContainText('甲项目已确认事项');
  const group=page.locator('[data-project-group="示例住宅甲"]');
  await group.getByRole('button',{name:'新增工作安排',exact:true}).click();const draft=group.locator('.overview-meeting-draft');
  await draft.getByRole('combobox',{name:'工作安排提出领导'}).selectOption(f.leader);
  await draft.getByRole('combobox',{name:'工作安排专业',exact:true}).selectOption('工程');
  await draft.getByRole('combobox',{name:'工作安排责任人'}).selectOption(f.owner);
  await draft.locator('.ql-editor').fill('尚未保存的领导要求：核对施工界面');
  await draft.locator('.ql-editor').press('Control+A');await draft.locator('.ql-editor').press('Control+B');
  await expect(draft.locator('.ql-editor strong')).toContainText('尚未保存的领导要求');
  await draft.getByRole('textbox',{name:'工作安排完成时间'}).fill(f.runtime.scope.week);
  const untouched=await display.locator('#meeting-screen').innerHTML();
  await page.locator('[data-meeting-toggle]').click();await page.locator('#overviewFilter').selectOption('示例住宅乙');
  await expect(page.locator('[data-project-group="示例住宅乙"]')).toContainText('乙项目已提交事项');
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  assert.equal(await display.locator('#meeting-screen').innerHTML(),untouched);
  await page.locator('[data-meeting-toggle]').click();await expect(display.locator('#meeting-screen')).toContainText('乙项目已确认事项');
  await page.locator('[data-meeting-toggle]').click();await page.locator('#overviewFilter').selectOption('示例住宅甲');
  await expect(draft.locator('.ql-editor')).toContainText('尚未保存的领导要求');
  await expect(draft.locator('.ql-editor strong')).toContainText('尚未保存的领导要求');
  await page.locator('[data-meeting-show]').click();await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  const beforeSave=await display.locator('#meeting-screen').innerHTML();
  await draft.getByRole('button',{name:'保存安排',exact:true}).click();await expect(draft).toHaveCount(0);
  await expect(page.locator('.meeting-recent')).toContainText('刚保存，未自动展示');
  assert.equal(await display.locator('#meeting-screen').innerHTML(),beforeSave);
  await expect(display.locator('#meeting-screen')).not.toContainText('尚未保存的领导要求');
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.reporter_tasks')).rows[0].n,tasksBefore+1);
  await page.getByRole('button',{name:'展示这条安排',exact:true}).click();
  await expect(display.locator('.meeting-arrangement')).toContainText('尚未保存的领导要求：核对施工界面');
  await expect(display.locator('.meeting-arrangement')).toContainText('示例工程负责人');
  await expect(display.locator('.meeting-arrangement strong')).toContainText('尚未保存的领导要求');
  await expect(page.locator('.meeting-control')).toContainText('已暂停跟随');
  mkdirSync(artifacts,{recursive:true});await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:path.join(artifacts,'controller-desktop.png')});await display.screenshot({path:path.join(artifacts,'display-saved-arrangement.png')});
  await page.locator('[data-meeting-show]').click();await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  const beforeFont=await display.locator('.meeting-plan-table td[data-label="事项"]').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  await display.locator('#meeting-font-more').click();assert.equal(await display.evaluate(()=>document.documentElement.style.getPropertyValue('--meeting-font')),'24px');
  assert.ok(await display.locator('.meeting-plan-table td[data-label="事项"]').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize))>beforeFont);
  await display.locator('#meeting-font-less').click();assert.equal(await display.locator('.meeting-plan-table td[data-label="事项"]').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),beforeFont);
  await display.screenshot({path:path.join(artifacts,'display-report.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'controller-mobile.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
  await page.setViewportSize({width:1560,height:1050});
  // Role and project rights change in the disposable database while the original UI still has its old list.
  await admin.query("UPDATE public.profiles SET role='pzo',project_id='meeting-a' WHERE user_id=$1",[f.root]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'meeting-a','pzo')",[f.root]);
  await page.locator('#overviewFilter').selectOption('示例住宅乙');await page.locator('[data-meeting-show]').click();
  await expect(display.locator('#meeting-screen')).toContainText('项目读取权限或类型已变化');
  await expect(display.locator('#meeting-screen')).not.toContainText('乙项目已确认事项');
  await admin.query("UPDATE public.profiles SET role='pm' WHERE user_id=$1",[f.root]);
  await page.locator('[data-meeting-show]').click();await expect(display.locator('#meeting-screen')).toContainText('当前身份无权使用会议投影');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(display.locator('#meeting-screen')).toContainText('会议投影已结束');
  assert.deepEqual(f.errors,[]);
  assert.equal(f.writes.filter(write=>write.url.endsWith('/api/reporter-tasks/save')).length,1);
  assert.deepEqual((await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS snapshot FROM public.reports r')).rows[0].snapshot,reportsBefore);
  assert.equal(f.writes.length,1);
});

test('commercial and historical selection follow, failed reads retry and delayed responses cannot replace a newer screen',async t=>{
  const f=await fixture(t),{page}=f;
  const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'开启会议投影',exact:true}).click();const display=await popup;
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  const unchanged=await display.locator('#meeting-screen').innerHTML();
  await display.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window,data:{app:'planning-meeting-v1',id:location.hash.slice(1),type:'end'}})));
  await display.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:'https://foreign.invalid',source:opener,data:{app:'planning-meeting-v1',id:location.hash.slice(1),type:'end'}})));
  assert.equal(await display.locator('#meeting-screen').innerHTML(),unchanged);
  await page.evaluate(()=>App.view('presCom'));await page.locator('#overviewFilter').selectOption(f.runtime.scope.line);
  await expect(page.getByLabel('会议模式')).toHaveValue('weekly');
  await expect(display.locator('#meeting-screen')).toContainText('机房设备安装');
  await expect(display.locator('.meeting-topic')).toContainText('机电工程');
  const old=new Date(f.runtime.scope.week+'T12:00:00Z');old.setUTCDate(old.getUTCDate()-7);const previous=old.toISOString().slice(0,10);
  await page.locator('#overviewPeriod').selectOption(previous);await expect(display.locator('#meeting-screen')).toContainText('设备安装完成50%');
  await expect(display.locator('#meeting-screen')).not.toContainText('保留的原进展');
  await page.locator('[data-meeting-section]').selectOption('plans');await expect(display.locator('[data-projection-section]')).toHaveCount(1);
  await expect(display.locator('[data-projection-section="plans"]')).toBeVisible();
  await page.locator('#overviewPeriod').selectOption(f.runtime.scope.week);await page.evaluate(()=>App.view('pres'));
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  let fail=true;
  await display.route('**/api/db',async route=>{
    const body=route.request().postDataJSON();
    if(fail && body.table==='reports'){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'隔离读取失败'},data:null})});}
    return route.continue();
  });
  await page.locator('[data-meeting-reload]').click();await expect(display.locator('#meeting-screen')).toContainText('隔离读取失败');
  await expect(display.locator('#meeting-screen')).not.toContainText('甲项目已确认事项');
  await page.locator('[data-meeting-reload]').click();await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await display.unroute('**/api/db');
  let release,entered;const delayed=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  await display.route('**/api/db',async route=>{
    const body=route.request().postDataJSON();
    if(body.table==='reports' && body.filters?.[0]?.value==='meeting-b'){entered();await gate;try{await route.continue();}catch{}}
    else await route.continue();
  });
  await page.locator('#overviewFilter').selectOption('示例住宅乙');await delayed;
  await page.locator('[data-meeting-toggle]').click();await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  release();await display.unroute('**/api/db');await expect(display.locator('#meeting-screen')).not.toContainText('乙项目已确认事项');
  await page.locator('#overviewFilter').selectOption('示例住宅甲');await page.locator('[data-meeting-toggle]').click();
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  let releaseAgain,enteredAgain;const delayedAgain=new Promise(resolve=>enteredAgain=resolve),gateAgain=new Promise(resolve=>releaseAgain=resolve);
  await display.route('**/api/db',async route=>{
    const body=route.request().postDataJSON();
    if(body.table==='reports' && body.filters?.[0]?.value==='meeting-b'){enteredAgain();await gateAgain;try{await route.continue();}catch{}}
    else await route.continue();
  });
  await page.locator('#overviewFilter').selectOption('示例住宅乙');await delayedAgain;
  await page.locator('#overviewFilter').selectOption('示例住宅甲');await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  releaseAgain();await display.unroute('**/api/db');await expect(display.locator('#meeting-screen')).not.toContainText('乙项目已确认事项');
  await display.reload();await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await page.reload();await expect(display.locator('#meeting-screen')).toContainText(/投影已结束|管理员连接已断开/);
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.errors,[]);
});

test('blocked popups and closed windows preserve the original arrangement draft and allow reopening',async t=>{
  const f=await fixture(t),{page}=f,group=page.locator('[data-project-group="示例住宅甲"]');
  await group.getByRole('button',{name:'新增工作安排',exact:true}).click();const draft=group.locator('.overview-meeting-draft');
  await draft.locator('.ql-editor').fill('弹窗受限时必须保留的草稿');
  await page.evaluate(()=>{window.originalMeetingOpen=window.open;window.open=()=>null;});
  await page.getByRole('button',{name:'开启会议投影',exact:true}).click();await expect(page.locator('#toast')).toContainText('允许此网站弹出窗口');
  await expect(draft.locator('.ql-editor')).toContainText('弹窗受限时必须保留的草稿');
  await page.evaluate(()=>window.open=window.originalMeetingOpen);
  const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'开启会议投影',exact:true}).click();const display=await popup;
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await page.evaluate(()=>App.view('projectPlanStats'));await expect(page.locator('.meeting-control')).toHaveCount(0);
  await expect(display.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await display.close();await page.evaluate(()=>App.view('pres'));await expect(page.locator('#overviewFilter')).toBeVisible();
  await expect(page.locator('.meeting-control')).toHaveCount(0);assert.equal(await page.evaluate(()=>MeetingController.active()),false);
  const again=page.waitForEvent('popup');await page.getByRole('button',{name:'开启会议投影',exact:true}).click();const second=await again;
  await expect(second.locator('#meeting-screen')).toContainText('甲项目已确认事项');
  await expect(draft.locator('.ql-editor')).toContainText('弹窗受限时必须保留的草稿');
  await page.locator('[data-meeting-stop]').click();await expect.poll(()=>second.isClosed()).toBe(true);await expect(page.locator('.meeting-control')).toHaveCount(0);
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.errors,[]);
});
