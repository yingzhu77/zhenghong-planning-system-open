import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const web=new URL('../web/',import.meta.url),source=fs.readFileSync(new URL('app.js',web),'utf8');
const boundary=source.indexOf('  (async function boot() {');assert.ok(boundary>0);
const artifacts=process.env.MANAGEMENT_READER_ARTIFACT_DIR || path.join(os.tmpdir(),'planning-management-reader');
fs.mkdirSync(artifacts,{recursive:true});
const projects=[{id:'own',name:'匿名住宅项目',project_type:'res',display_group:'匿名组'},{id:'other',name:'匿名商业项目',project_type:'com',display_group:'匿名组'}];
const format=text=>({v:1,fields:{what:{ops:[{insert:text,attributes:{bold:true,color:'#d81e06'}}]}}});
const coord=[{id:'independent',project_id:'own',project_name:projects[0].name,title:'独立协调申请',what:'协调正文',rich_text:format('协调正文'),owner_name:'匿名承办人',author_name:'匿名提出人',due:'2026-11-01',source_type:'independent_coordination'},
  {id:'report',project_id:'other',project_name:projects[1].name,title:'报告协调事项',what:'报告协调正文',period:'第43周',source_type:'report_coord'},
  {id:'handover',project_id:null,project_name:'未指定项目',scope_project_ids:['own','other'],title:'报告移交事项',what:'未归属工作面移交',source_type:'report_handover'}];
async function fixture(role='viewer',cap=false){
  const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
  const calls=[],errors=[],behavior={hold:null,held:[],failure:false};
  page.on('pageerror',error=>errors.push(error.message));
  async function respond(route,body){
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/management-read'){
      if(behavior.failure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'隔离测试读取失败'}})});
      let data={projects,rows:[],project_id:body.project_id || '',has_more:false,next_cursor:null};
      if(body.view==='coordination'){
        const filtered=coord.filter(row=>!body.project_id || row.project_id===body.project_id || row.scope_project_ids?.includes(body.project_id));
        if(body.project_id)data.rows=filtered;
        else if(body.cursor)data.rows=filtered.slice(2);
        else {data.rows=filtered.slice(0,2);data.has_more=true;data.next_cursor='isolated-page-two';}
      }else if(body.view==='completions')data.rows=[{id:'completion',project_id:'other',project_name:projects[1].name,title:'原申请事项',what:'原申请正文',owner_name:'匿名申报人',
        source_snapshot:{title:'申报时标题',what:'申报时原文',rich_text:format('申报时原文')},completion_date:'2026-10-22',completion_note:'申报时完成说明',review_note:'原审核说明',status:'approved',request_type:'completion',reviewer_name:'匿名审核人',reviewed_at:'2026-10-23T03:00:00Z',snapshot_only:true,can_review:false,data_basis:'request_snapshot',
        history:[{at:'2026-10-22T03:00:00Z',by:'anonymous-reviewer',data:{status:'rejected',review_note:'历史审核依据',reviewer_name:'匿名审核人',requested_due:'2026-10-30'}}]}];
      else if(body.view==='meetings')data.rows=[{id:'meeting',project_id:'other',title:'例会事项',what:'会议正文',progress:'已经核对施工进展',rich_text:{v:1,fields:{progress:{ops:[{insert:'已经核对施工进展',attributes:{bold:true}}]}}},owner_name:'匿名承办人',meeting_kind:'weekly',status:'open',history:[{action:'update',note:'前次进展',created_at:'2026-10-21T01:00:00Z'}]}];
      else if(body.view==='archive'){
        data.project_id=body.project_id || 'own';
        data.archive={project_master:[{project_id:data.project_id,fields:{city:data.project_id==='other'?'商业城市':'住宅城市',fitout:'建设标准',rich_text:{v:1,fields:{fitout:{ops:[{insert:'建设标准',attributes:{bold:true}}]}}}}}],project_phases:[],project_drawings:[],milestones:[]};
      }else assert.equal(body.view,'projects');
      return route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
    }
    if(pathname==='/api/project-library/list')return route.fulfill({contentType:'application/json',body:JSON.stringify({data:{items:[{id:'file',title:'匿名资料',name:'anonymous.pdf',version:1,category:'计划资料',mime:'application/pdf',size:1024,uploaded_name:'匿名上传人',created_at:'2026-10-23T01:00:00Z',can_withdraw:true}],categories:['计划资料'],configured:true,unlocked:false,can_manage:true,can_upload:true}})});
    if(pathname==='/api/project-library/unlock')return route.fulfill({contentType:'application/json',body:JSON.stringify({data:{}})});
    if(pathname==='/api/report-scopes/list')return route.fulfill({contentType:'application/json',body:JSON.stringify({data:[]})});
    assert.fail('unexpected isolated route: '+pathname);
  }
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://management-reader.test')return route.abort('blockedbyclient');
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><div id="toast"></div></body></html>'});
    if(url.pathname==='/logo.png')return route.fulfill({contentType:'image/png',body:fs.readFileSync(new URL('logo.png',web))});
    if(!url.pathname.startsWith('/api/'))return route.fulfill({status:404,body:''});
    const body=route.request().postDataJSON();calls.push({path:url.pathname,body});
    if(behavior.hold===body.view){behavior.hold=null;behavior.held.push(()=>respond(route,body));return;}
    return respond(route,body);
  });
  await page.goto('http://management-reader.test/');
  await page.evaluate(()=>{
    window.dbReads=[];window.dbWrites=[];window.testDb={};
    window.WorkBuddyCloud={createWorkBuddyCloud:()=>({auth:{},database:{from(table){
      const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},limit(){return q;},range(){return q;},
        update(payload){window.dbWrites.push({table,payload});return q;},
        then(resolve,reject){window.dbReads.push(table);return Promise.resolve({data:window.testDb[table] || [],error:null}).then(resolve,reject);}};return q;
    }}})};
    const gate=async()=>{};window.PlanningBoot={assets:{},ensureManagementReader:gate,ensureProjectLibrary:gate,ensureReporter:gate,ensureWorkflow:gate,ensureEditor:gate};
  });
  for(const name of ['styles.css','planning-ui.css','reporter-archive.css','project-library.css','management-reader.css'])await page.addStyleTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  for(const name of ['rich-text.js','planning-windows.js','reporter-archive.js','project-library.js','management-reader.js'])await page.addScriptTag({content:fs.readFileSync(new URL(name,web),'utf8')});
  await page.addScriptTag({content:source.slice(0,boundary)+'\nwindow.managementAudit={S,App,afterLogin,showPage,renderShell,configureReporter,planningNavItems,planningGroups,pageDataKeys,myProjects,isPlanningManager,isReviewer,canReadManagement,getDataState:()=>dataState};\n})();'});
  await page.evaluate(({role,cap,projects})=>{
    const S=window.managementAudit.S,profile={user_id:'anonymous',name:'匿名查看用户',role,status:'approved',management_viewer:cap};
    Object.assign(S,{uid:'anonymous',session:{user:{id:'anonymous',profile}},profile,view:'managementCoord',pmProject:'own',pmPeriod:'2026-10-19',pmLine:'综合',reporterArchiveTab:'planning',projects:[projects[0]],pms:[{user_id:'anonymous',project_id:'own'}],reportScopes:[{id:'personal-scope'}],reports:[{id:'personal-report'}],reporterTasks:[{id:'personal-meeting'}],coordinationTasks:[{id:'personal-coord'}],completions:[{id:'personal-completion'}]});
    window.testDb={projects:[projects[0]],project_members:S.pms};
  },{role,cap,projects});
  return {browser,page,calls,errors,behavior};
}
async function goto(h,view){await h.page.evaluate(view=>window.managementAudit.App.view(view),view);}
const managementCalls=h=>h.calls.filter(call=>call.path==='/api/management-read');

test('viewer login and real navigation expose only read-only tasks and project files, including paging, filters and current-week source explanation',async()=>{
  const h=await fixture();const {page}=h;
  try{
    await page.evaluate(()=>window.managementAudit.afterLogin());
    await expect(page.locator('.management-reader')).toHaveAttribute('data-management-view','coordination');
    const state=await page.evaluate(()=>{const h=window.managementAudit;return {groups:h.planningGroups(h.planningNavItems()).map(x=>x.label),keys:h.planningNavItems().map(x=>x.k),data:h.pageDataKeys(),manager:h.isPlanningManager(),reviewer:h.isReviewer(),reads:window.dbReads};});
    assert.deepEqual(state.groups,['事项管理','项目资料']);assert.deepEqual(state.data,[]);assert.equal(state.manager,false);assert.equal(state.reviewer,false);assert.deepEqual(state.reads,[]);
    assert.deepEqual(state.keys,['managementCoord','managementCompletion','managementMeetings','managementArchive','managementLibrary']);
    await expect(page.locator('#pmPeriod')).toHaveCount(0);await expect(page.locator('textarea,input[type="file"],[contenteditable="true"]')).toHaveCount(0);
    await expect(page.locator('.rt-red strong')).toHaveText('协调正文');await expect(page.locator('.management-reader-basis').first()).toContainText('当前周');
    await page.getByRole('button',{name:'加载更多记录',exact:true}).click();await expect(page.locator('.management-reader-record')).toHaveCount(3);
    assert.equal(managementCalls(h).at(-1).body.cursor,'isolated-page-two');
    await page.getByLabel('只读查看项目').selectOption('other');await expect(page.locator('.management-reader-record')).toHaveCount(2);
    await expect(page.locator('.management-reader-basis').first()).toContainText('按报告候选项目范围参与筛选');
    await expect(page.locator('.management-reader-record').filter({hasText:'未归属工作面移交'}).locator('.chip')).toHaveText('未指定项目');
    assert.equal(managementCalls(h).at(-1).body.project_id,'other');assert.equal(managementCalls(h).at(-1).body.cursor,undefined);
    await page.getByLabel('只读查看项目').selectOption('');await expect(page.locator('.management-reader-record')).toHaveCount(2);
    const before=managementCalls(h).length;await goto(h,'form');assert.equal(managementCalls(h).length,before);assert.equal(await page.evaluate(()=>window.managementAudit.S.view),'managementCoord');
    await page.screenshot({path:path.join(artifacts,'viewer-coordination-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'viewer-coordination-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.querySelector('.management-reader').scrollWidth<=document.querySelector('.management-reader').clientWidth+1));
    assert.deepEqual(h.errors,[]);
  }finally{await h.browser.close();}
});

test('PM capability keeps personal arrays, reporting scope and own library while the independent snapshot, meeting, archive and shared-library pages have no write actions',async()=>{
  const h=await fixture('pm',true);const {page}=h;
  try{
    const before=await page.evaluate(()=>{const h=window.managementAudit,S=h.S;window.personalSnapshot=JSON.stringify([S.projects,S.pms,S.reports,S.reportScopes,S.reporterTasks,S.coordinationTasks,S.completions,S.pmProject,S.pmPeriod,S.pmLine]);return {keys:h.planningNavItems().map(x=>x.k),my:h.myProjects(),manager:h.isPlanningManager()};});
    assert.deepEqual(before.keys.slice(0,7),['center','mline','coordination','form','master','history','library']);assert.equal(before.my.length,1);assert.equal(before.manager,false);
    await page.evaluate(()=>window.managementAudit.showPage());
    await goto(h,'managementCompletion');await expect(page.locator('.management-reader')).toContainText('申报时快照与已保存审核记录');
    await expect(page.locator('.rt-red strong')).toHaveText('申报时原文');await expect(page.locator('.management-reader')).toContainText('原审核说明');
    await page.getByText('历史记录（1）',{exact:true}).click();await expect(page.locator('.management-reader-history')).toContainText('历史审核依据');
    await expect(page.locator('.management-reader')).toContainText('2026-10-23 11:00:00');
    await expect(page.locator('[onclick*="CompletionReview"],textarea')).toHaveCount(0);
    await page.screenshot({path:path.join(artifacts,'pm-readonly-completion.png'),fullPage:true});
    await goto(h,'managementMeetings');await expect(page.locator('.management-reader-text strong')).toHaveText('已经核对施工进展');
    await expect(page.locator('[onclick*="ReporterTasks"]')).toHaveCount(0);
    await page.evaluate(()=>{window.managementAudit.getDataState().reports={revision:7,ready:true,error:null};});
    await page.evaluate(()=>window.managementAudit.App.reload());
    assert.deepEqual(await page.evaluate(()=>window.managementAudit.getDataState().reports),{revision:7,ready:true,error:null});
    await goto(h,'managementArchive');await expect(page.getByRole('navigation',{name:'项目资料分类'}).getByRole('button')).toHaveCount(7);
    await expect(page.locator('.management-reader select')).toHaveCount(1);
    await page.locator('#reporterArchiveProject').selectOption('other');await page.getByRole('button',{name:'产品建设标准',exact:true}).click();
    await expect(page.locator('.reporter-archive-fields strong')).toHaveText('建设标准');
    assert.equal(await page.evaluate(()=>window.managementAudit.S.reporterArchiveTab),'planning');
    assert.equal(managementCalls(h).at(-1).body.project_id,'other');
    await page.screenshot({path:path.join(artifacts,'pm-readonly-archive.png'),fullPage:true});
    await goto(h,'managementLibrary');await expect(page.getByRole('button',{name:'水印下载',exact:true})).toBeDisabled();
    await expect(page.locator('.library-upload,.library-password-admin,[onclick*="ProjectLibrary.version"],[onclick*="ProjectLibrary.withdraw"],[onclick*="false,true"]')).toHaveCount(0);
    await page.getByLabel('只读查看项目').selectOption('other');await expect(page.locator('.library-table')).toContainText('匿名资料');
    const reads=h.calls.length;await page.evaluate(async()=>{await ProjectLibrary.upload();await ProjectLibrary.setPassword();ProjectLibrary.version('file');await ProjectLibrary.withdraw('file');await ProjectLibrary.open('file',false,true);});
    assert.equal(h.calls.length,reads);await expect(page.getByLabel('项目下载口令')).toBeVisible();
    await page.getByLabel('项目下载口令').fill('isolated-library-123');await page.getByRole('button',{name:'验证后预览／下载',exact:true}).click();
    assert.ok(h.calls.some(x=>x.path==='/api/project-library/unlock' && x.body.project_id==='other'));
    assert.equal(await page.evaluate(()=>{const S=window.managementAudit.S;return JSON.stringify([S.projects,S.pms,S.reports,S.reportScopes,S.reporterTasks,S.coordinationTasks,S.completions,S.pmProject,S.pmPeriod,S.pmLine])===window.personalSnapshot;}),true);
    await goto(h,'library');await expect(page.locator('.library-upload')).toBeVisible();
    assert.deepEqual(await page.locator('#library-project option').evaluateAll(options=>options.map(x=>x.value)),['own']);
    assert.equal(await page.evaluate(()=>window.managementAudit.S.pmProject),'own');
    assert.ok(managementCalls(h).some(x=>x.body.view==='projects'));assert.deepEqual(h.errors,[]);
  }finally{await h.browser.close();}
});

test('scope changes, new login sessions, capability removal and explicit errors cannot paint late management data or mutate personal state',async()=>{
  const h=await fixture('pm',true);const {page}=h;
  try{
    await page.evaluate(()=>window.managementAudit.showPage());
    h.behavior.hold='coordination';
    await page.evaluate(()=>{window.oldRefresh=ManagementReader.refresh();});
    await expect.poll(()=>h.behavior.held.length).toBe(1);
    await goto(h,'managementMeetings');await expect(page.locator('.management-reader')).toContainText('例会事项');
    await h.behavior.held.shift()();await page.evaluate(()=>window.oldRefresh);
    await expect(page.locator('.management-reader')).not.toContainText('协调正文');
    h.behavior.hold='archive';await page.evaluate(()=>{window.oldNavigation=window.managementAudit.App.view('managementArchive');});
    await expect.poll(()=>h.behavior.held.length).toBe(1);
    await page.evaluate(()=>{const h=window.managementAudit;h.S.uid='second-anonymous';h.S.session={user:{id:h.S.uid}};h.S.profile={role:'viewer',status:'approved'};h.S.view='managementMeetings';h.configureReporter();window.newNavigation=h.showPage();});
    await page.evaluate(()=>window.newNavigation);await h.behavior.held.shift()();await page.evaluate(()=>window.oldNavigation);
    await expect(page.locator('.management-reader')).toContainText('例会事项');
    assert.equal(await page.evaluate(()=>ManagementReader.projectId('managementArchive')),null);
    h.behavior.failure=true;await page.getByRole('button',{name:'刷新只读资料',exact:true}).click();await expect(page.getByRole('alert')).toContainText('隔离测试读取失败');
    h.behavior.failure=false;
    const before=h.calls.length;await page.evaluate(async()=>{const h=window.managementAudit;h.S.profile={role:'pm',status:'approved',management_viewer:false};h.configureReporter();await ManagementReader.project('other');await ManagementReader.refresh();});
    assert.equal(h.calls.length,before);assert.equal(await page.evaluate(()=>window.managementAudit.canReadManagement()),false);
    assert.equal(await page.evaluate(()=>window.dbWrites.length),0);assert.deepEqual(h.errors,[]);
  }finally{await h.browser.close();}
});

test('member administration labels viewers and changes only the management-read boolean while viewers cannot invoke member writes',async()=>{
  const h=await fixture('ops');const {page}=h;
  try{
    await page.evaluate(()=>{const S=window.managementAudit.S;S.view='members';window.testDb.profiles=[{user_id:'anonymous-pm',name:'匿名提报人',role:'pm',status:'approved',management_viewer:false},{user_id:'anonymous-viewer',name:'匿名查看人',role:'viewer',status:'approved'}];});
    await page.evaluate(()=>window.managementAudit.showPage());
    await expect(page.locator('select[onchange*="role"] option[value="viewer"]')).toHaveCount(2);
    await expect(page.getByLabel('全项目只读',{exact:true})).toHaveCount(1);
    await page.getByLabel('全项目只读',{exact:true}).check();
    await expect.poll(()=>page.evaluate(()=>window.dbWrites.length)).toBe(1);
    assert.deepEqual(await page.evaluate(()=>window.dbWrites[0]),{table:'profiles',payload:{management_viewer:true}});
    const current=await page.evaluate(()=>{const h=window.managementAudit;h.S.profile={role:'viewer',status:'approved'};return h.App.memberSet('anonymous-pm','management_viewer',false).then(()=>window.dbWrites.length);});
    assert.equal(current,1);assert.deepEqual(h.errors,[]);
  }finally{await h.browser.close();}
});
