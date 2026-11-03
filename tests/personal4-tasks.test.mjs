import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
const web=new URL('../web/',import.meta.url);
const source=readFileSync(new URL('reporter-tasks.js',web),'utf8');
const richSource=readFileSync(new URL('rich-text.js',web),'utf8');
const windowsSource=readFileSync(new URL('planning-windows.js',web),'utf8');
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plain=value=>JSON.parse(JSON.stringify(value));
const delta=text=>({ops:[{insert:text,attributes:{bold:true,color:'#d81e06'}}]});
function fixture(){
 const elements={},actions=[],requests=[],S={uid:'owner',session:{},profile:{role:'pm',name:'匿名本人'},pmProject:'p1',pmPeriod:'2026-10-19',pmLine:'综合',reports:[],leaderNotes:[],reporterTasks:[],followupRows:[]};
 class Now extends Date{constructor(...args){super(...(args.length?args:['2026-10-22T01:00:00Z']));}}
 const context={Date:Now,document:{getElementById:id=>elements[id]||null},CompletionReview:{approved:()=>false,effectiveDue:(_key,due)=>due,actionHtml:(key)=>{actions.push(key);return '<button class="btn completion-action">完成／延期申报</button>';}}};context.window=context;vm.createContext(context);
 [richSource,windowsSource,source].forEach(code=>vm.runInContext(code,context));
 const rt=context.ZHRichText,api=context.ReporterTasks;
 const config={S,esc,currentPeriod:()=> '2026-10-19',weekNo:()=>43,richCopy:rt.copy,richItem:rt.field,richCollect:rt.collect,render(){},flush(){},toast(){},saveDraft(){},openFeedback:key=>requests.push({feedback:key}),request:async(url,body)=>{requests.push({url,body});return {data:{}};}};
 api.configure(config);return {S,api,rt,elements,actions,requests,context,config};
}
function task(extra={}){return {id:'old-task',project_id:'p1',owner_id:'owner',owner_name:'匿名本人',meeting_kind:'legacy',title:'原会议要求',what:'按原要求继续办理',due:'2026-10-30',progress:'来源中的旧进展',status:'in_progress',revision:4,created_at:'2026-10-19T01:00:00Z',updated_at:'2026-10-22T01:00:00Z',...extra};}
function row(extra={}){return {source_key:'meeting:p1:old-task',source_type:'meeting',source_id:'old-task',source_revision:4,title:'原会议事项（待分类） · 原会议要求',what:'按原要求继续办理',due:'2026-10-30',progress:'本期草稿进展',status:'in_progress',source_period:'2026-10-19',source_author:'匿名本人',...extra};}

test('the form uses unified categories without changing source keys, classifications or saved snapshots',()=>{
 const h=fixture();h.S.reporterTasks=[task()];h.S.followupRows=[row()];h.S.pmReport={period:'2026-10-19',submitted_at:'2026-10-20T01:00:00Z',biz:{followups:[row({progress:'原报告保存进展'})]}};
 const before=JSON.stringify({tasks:h.S.reporterTasks,report:h.S.pmReport,followups:h.S.followupRows});
 const overview=h.api.workbenchHtml('p1'),form=h.api.formHtml();
 assert.match(overview,/历史会议待办/);assert.match(overview,/此前分派给你的会议事项/);assert.doesNotMatch(overview,/原会议事项（待分类）|ReporterTasks\.edit/);
 assert.match(form,/四、待处理事项清单/);assert.match(form,/会议事项要求/);assert.doesNotMatch(form,/历史会议待办|原会议事项（待分类）/);
 assert.equal(JSON.stringify({tasks:h.S.reporterTasks,report:h.S.pmReport,followups:h.S.followupRows}),before);
 assert.equal(h.api.sourceItems()[0].title,'原会议事项（待分类） · 原会议要求');
 assert.equal(h.api.sourceItems()[0].source_key,'meeting:p1:old-task');
 h.S.profile.role='ops';assert.match(h.api.renderAdmin(),/原会议事项（待分类）/,'operator classification control keeps its existing value');
});

test('workbench and form share rolling pending sources while preserving saved feedback and unassigned boundaries',()=>{
 const h=fixture();
 h.S.reporterTasks=[task()];
 h.S.leaderNotes=[{id:'assigned',project_id:'p1',owner_id:'owner',kind:'ceo_brief',what:'领导安排内容',author_name:'示例领导',period:'2026-10-19'},
   {id:'unassigned',project_id:'p1',kind:'ceo_brief',what:'未分派记录',period:'2026-10-19'},
   {id:'private',project_id:'private',owner_id:'owner',what:'未授权记录',period:'2026-10-19'}];
 h.S.reports=[{id:20,project_id:'p1',author_id:'other',author_name:'示例专业人员',period:'2026-10-12',submitted_at:'2026-10-13T00:00:00Z',
   coord_items:[{source_id:'need',who_id:'owner',who:'匿名本人',what:'上周尚未完成的协调需求',by:'2026-10-30'}]}];
 const previous=row({progress:'保存过的反馈',_rich:{progress:delta('保存过的反馈')}});
 h.S.pmReport={period:'2026-10-19',submitted_at:'2026-10-20T00:00:00Z',biz:{followups:[previous]}};
 const original=JSON.stringify(h.S.pmReport);h.api.prepare();
 const overview=h.api.pendingHtml('p1'),form=h.api.formHtml();
 const keys=(html,attribute)=>[...html.matchAll(new RegExp(attribute+'="([^"]+)"','g'))].map(match=>match[1]).sort();
 assert.deepEqual(keys(overview,'data-meeting-key'),keys(form,'data-followup-key'));
 for(const category of ['会议事项要求','他人协调我的事项']){assert.ok(overview.includes(category));assert.ok(form.includes(category));}
 assert.doesNotMatch(overview,/领导安排内容|未分派记录|未授权记录|项目总安排|总裁交代/);
 assert.match(form,/上周尚未完成的协调需求/);assert.doesNotMatch(form,/未分派记录|未授权记录|历史会议待办/);
 assert.equal(h.S.followupRows.filter(item=>item.source_key===previous.source_key).length,1);
 assert.equal(h.S.followupRows.find(item=>item.source_key===previous.source_key).progress,'保存过的反馈');
 assert.deepEqual(plain(h.rt.doc(h.S.followupRows.find(item=>item.source_key===previous.source_key),'progress')),delta('保存过的反馈'));
 assert.equal(JSON.stringify(h.S.pmReport),original);assert.deepEqual(h.requests,[]);
 h.context.CompletionReview.approved=key=>key==='meeting:p1:old-task';
 assert.doesNotMatch(h.api.pendingHtml('p1'),/data-meeting-key="meeting:p1:old-task"/);
});

test('compact followup table retains original row indices, input names, conflict choices, formatting and approval identity',()=>{
 const h=fixture();h.S.followupRows=[row({source_key:'leader:p1:old-leader',source_type:'leader',what:'保留但不展示的原领导反馈'}),row(),row({source_key:'coord:p1:coord-id',source_id:'coord-id',source_type:'coord',title:'他人协调',what:'保留协调原事项',meeting_conflict:true,source_updated:true,source_missing:true})];
 const html=h.api.formHtml();
 assert.match(html,/<table class="reporter-followup-table"/);assert.doesNotMatch(html,/<article class="reporter-followup"/);
 assert.equal((html.match(/<th>/g)||[]).length,5);assert.match(html,/data-followup-key="coord:p1:coord-id" data-followup-index="2"/);
 for(const id of ['followup_status_1','followup_progress_1','followup_status_2','followup_progress_2'])assert.ok(html.includes('id="'+id+'"'));
 assert.doesNotMatch(html,/followup_progress_0|保留但不展示的原领导反馈/);
 assert.match(html,/ReporterTasks\.resolveMeeting\(2,false\)/);assert.match(html,/ReporterTasks\.resolveMeeting\(2,true\)/);
 assert.match(html,/来源已更新或已移除/);assert.deepEqual(h.actions,['meeting:p1:old-task','coord:p1:coord-id']);
 h.elements.followup_progress_2={value:'保留第二行格式'};h.elements.followup_status_2={value:'in_progress'};h.api.binding('followup_progress_2').set(delta('保留第二行格式'));
 const saved=h.api.rows();assert.equal(saved[2].source_key,'coord:p1:coord-id');assert.equal(saved[2].progress,'保留第二行格式');assert.deepEqual(plain(h.rt.doc(saved[2],'progress')),delta('保留第二行格式'));
 assert.equal(saved[1].progress,'本期草稿进展');assert.equal(saved[0].what,'保留但不展示的原领导反馈');assert.equal(h.requests.length,0);
});

test('personal overview reads current draft feedback including explicit blanks and never backfills a historical period from live progress',()=>{
 const h=fixture();h.S.reporterTasks=[task()];h.S.followupRows=[row()];
 let html=h.api.workbenchHtml('p1');assert.match(html,/本期草稿进展/);assert.doesNotMatch(html,/来源中的旧进展/);assert.match(html,/填写本期反馈/);assert.doesNotMatch(html,/更新进展<\/button>/);
 h.S.followupRows[0].progress='';html=h.api.workbenchHtml('p1');assert.match(html,/本期未填写/);assert.doesNotMatch(html,/来源中的旧进展/);
 h.S.pmPeriod='2026-10-12';h.S.pmReport={period:'2026-10-12',submitted_at:'2026-10-13T01:00:00Z',biz:{followups:[]}};h.S.followupRows=[];
 html=h.api.workbenchHtml('p1');assert.match(html,/本期未填写/);assert.doesNotMatch(html,/来源中的旧进展/);
 h.api.openFeedback('meeting:p1:old-task');assert.deepEqual(h.requests,[{feedback:'meeting:p1:old-task'}]);
 h.S.leaderNotes=[{id:'leader-id',project_id:'p1',owner_id:'owner',kind:'ceo_brief',what:'原领导事项',period:'2026-10-12',submitted_at:'2026-10-13T01:00:00Z'}];
 const leader=h.api.requirementsHtml('p1');assert.match(leader,/原领导事项/);assert.match(leader,/本期未填写/);assert.doesNotMatch(leader,/colspan="6"/);
});

test('shared feedback lookup keeps current live fallback, explicit empty feedback and historical snapshots consistent',()=>{
 const h=fixture(),live=task(),key='meeting:p1:old-task';h.S.reporterTasks=[live];
 const initial=JSON.stringify(h.S);assert.equal(h.api.feedbackFor(key,live),live);assert.equal(JSON.stringify(h.S),initial,'current fallback reads without changing source records');
 h.S.followupRows=[row({progress:'',status:'open'})];
 const blank=JSON.stringify(h.S);assert.equal(h.api.feedbackFor(key,live),h.S.followupRows[0]);assert.equal(h.api.feedbackFor(key,live).progress,'');assert.equal(JSON.stringify(h.S),blank,'explicit blank stays authoritative');
 h.S.pmPeriod='2026-10-12';h.S.pmReport={period:'2026-10-12',submitted_at:'2026-10-13T01:00:00Z',biz:{followups:[]}};
 assert.equal(h.api.feedbackFor(key,live).progress,'','saved historical blanks never use live progress');
 h.S.followupRows[0].progress='历史周期已保存反馈';assert.equal(h.api.feedbackFor(key,live).progress,'历史周期已保存反馈');
 h.S.followupRows=[];const history=JSON.stringify(h.S);assert.deepEqual(plain(h.api.feedbackFor(key,live)),{progress:'',status:'open'});assert.equal(JSON.stringify(h.S),history,'historical lookup never backfills or alters records');
});

test('the compact sync table and overview render readable desktop/mobile controls with original draft bindings',async()=>{
 const artifacts=process.env.PERSONAL4_TASKS_ARTIFACT_DIR||path.join(os.tmpdir(),'personal4-tasks-artifacts');mkdirSync(artifacts,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://personal4-tasks.test/');
  for(const name of ['styles.css','planning-ui.css','reporter-workbench.css','reporter-tasks.css'])await page.addStyleTag({content:readFileSync(new URL(name,web),'utf8')});
  await page.addScriptTag({content:richSource});await page.addScriptTag({content:windowsSource});await page.addScriptTag({content:source});
  await page.evaluate(()=>{
   window.personal4State={uid:'owner',session:{},profile:{role:'pm',name:'匿名本人'},pmProject:'p1',pmPeriod:'2026-10-19',pmLine:'综合',reports:[],leaderNotes:[],reporterTasks:[],followupRows:[]};
   const S=window.personal4State;S.reporterTasks=[{id:'history',project_id:'p1',owner_id:'owner',meeting_kind:'legacy',title:'匿名原会议要求',what:'此前分派的事项仍按原要求办理',due:'2026-10-30',status:'in_progress',progress:'不可覆盖本期草稿的来源文字',revision:2,created_at:'2026-10-19T01:00:00Z'}];
   S.followupRows=[{source_key:'meeting:p1:history',source_type:'meeting',source_id:'history',source_revision:2,title:'原会议事项（待分类） · 匿名原会议要求',what:'此前分派的事项仍按原要求办理',due:'2026-10-30',status:'in_progress',progress:'本期原有草稿进展',source_period:'2026-10-19',source_author:'匿名本人'},
    {source_key:'coord:p1:coord',source_type:'coord',source_id:'coord',title:'他人协调',what:'实际提出人的协调要求继续使用原编号',due:'2026-10-31',status:'open',progress:'另一项原有进展',source_period:'2026-10-19',source_author:'匿名提出人'}];
   window.fixtureActions=[];window.CompletionReview={approved:()=>false,effectiveDue:(_key,due)=>due,actionHtml:key=>'<button class="btn" onclick="fixtureActions.push('+JSON.stringify(key).replaceAll('"','&quot;')+')">完成／延期申报</button>'};
   const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   window.renderTasks=()=>document.getElementById('root').innerHTML='<div class="planning-shell"><main>'+ReporterTasks.formHtml()+'</main></div>';
   ReporterTasks.configure({S,esc,currentPeriod:()=> '2026-10-19',weekNo:()=>43,richCopy:ZHRichText.copy,richItem:ZHRichText.field,richCollect:ZHRichText.collect,render:window.renderTasks,flush(){},toast(){},saveDraft(){},openFeedback:key=>{window.focusedKey=key;window.renderTasks();document.querySelector('[data-followup-key="'+key+'"] textarea').focus();}});renderTasks();
  });
  const first=page.locator('.reporter-followup-table tbody tr').first();
  await expect(first).toHaveAttribute('data-followup-key','meeting:p1:history');await expect(first.locator('textarea')).toHaveValue('本期原有草稿进展');
  await first.locator('textarea').fill('浏览器输入后草稿保留');await first.locator('select').selectOption('completed');await first.getByRole('button',{name:'完成／延期申报',exact:true}).click();
  const capture=await page.evaluate(()=>{ReporterTasks.capture();return {rows:ReporterTasks.rows(),actions:fixtureActions};});assert.equal(capture.rows[0].source_key,'meeting:p1:history');assert.equal(capture.rows[0].progress,'浏览器输入后草稿保留');assert.equal(capture.rows[0].status,'completed');assert.deepEqual(capture.actions,['meeting:p1:history']);
  assert.ok(await first.evaluate(row=>row.getBoundingClientRect().height<220),'two-line feedback no longer occupies a full large card');
  await page.screenshot({path:path.join(artifacts,'sync-table-desktop.png'),fullPage:true});
  await page.evaluate(()=>document.getElementById('root').innerHTML='<div class="planning-shell"><main>'+ReporterTasks.requirementsHtml('p1')+ReporterTasks.workbenchHtml('p1')+'</main></div>');
  await expect(page.locator('.reporter-legacy-meetings')).toContainText('浏览器输入后草稿保留');await expect(page.locator('.reporter-legacy-meetings')).not.toContainText('不可覆盖本期草稿的来源文字');
  await page.screenshot({path:path.join(artifacts,'overview-desktop.png'),fullPage:true});
  await page.locator('.reporter-legacy-meetings').getByRole('button',{name:'填写本期反馈',exact:true}).click();await expect(page.locator('#followup_progress_0')).toBeFocused();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(artifacts,'sync-table-mobile.png'),fullPage:true});
  await expect(page.locator('#followup_progress_0')).toHaveValue('浏览器输入后草稿保留');assert.deepEqual(errors,[]);
  writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({desktop:true,mobile:true,compactTable:true,currentDraftProgress:true,approvalSourcePreserved:true,focusOriginalRow:true,browserErrors:errors,productionWrites:0},null,2));
 }finally{await browser.close();}
});
