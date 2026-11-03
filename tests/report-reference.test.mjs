import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {testPool} from './helpers/pglite-pool.mjs';
import {executeDatabase} from '../server/database.mjs';

const web = new URL('../web/', import.meta.url);
const artifacts = process.env.REPORT_REFERENCE_ARTIFACT_DIR || path.join(os.tmpdir(), 'planning-report-reference');
async function fixture(browser, viewport = {width:1440,height:1000}) {
  const page = await browser.newPage({viewport});
  await page.setContent('<button id="entry">查看其他专业填报</button><textarea id="draft">本人的未提交草稿</textarea>');
  await page.addStyleTag({content:readFileSync(new URL('report-reference.css',web),'utf8')});
  for (const name of ['planning-windows.js','report-scopes.js','report-reference.js']) await page.addScriptTag({content:readFileSync(new URL(name,web),'utf8')});
  await page.evaluate(() => {
    window.ctx = {key:'user/session/project/module/week/form',uid:'me',canRead:true,projectIds:['p'],readableProjects:[{id:'p'},{id:'q'}],projectName:'示例项目',period:'2026-10-26',reference:'2026-10-27'};
    window.saved = [
      {id:1,project_id:'p',author_id:'peer',author_name:'示例成本填报人',line:'成本',period:'第44周（10.26–11.01）',submitted_at:'2026-10-27T00:00:00Z',content:'同项目的已提交结果'},
      {id:2,project_id:'p',author_id:'second',author_name:'示例招采填报人',line:'招采',period:'2026-10-26',submitted_at:'2026-10-27T00:00:00Z',content:'招采提交结果'},
      {id:3,project_id:'p',author_id:'peer',author_name:'示例成本填报人',line:'成本',period:'2026-10-19',submitted_at:'2026-10-20T00:00:00Z',content:'上周已提交结果'},
      {id:4,project_id:'q',author_id:'peer',line:'成本',period:'2026-10-26',submitted_at:'2026-10-27T00:00:00Z',content:'其他项目结果'},
      {id:5,project_id:'p',author_id:'me',line:'机电',period:'2026-10-26',submitted_at:'2026-10-27T00:00:00Z',content:'本人结果'},
      {id:6,project_id:'p',author_id:'peer',line:'开发',period:'2026-10-26',content:'未提交结果'},
      {id:7,project_id:'p',report_scope_id:'combined',scope_project_ids:['p','private'],author_id:'peer',line:'综合',period:'2026-10-26',submitted_at:'2026-10-27T00:00:00Z',content:'包含未授权成员的整组报告'}
    ];
    window.mode = 'ok'; window.requests = 0;
    window.configure = () => ReportReference.configure({getContext:()=>ctx,projectName:id=>id,
      loadReports:async()=>{requests++;if(mode==='fail')throw new Error('连接中断，请重试。');if(mode==='pending')return new Promise(resolve=>window.resolvePending=resolve);return {rows:saved,truncated:false};},
      snapshotHtml:report=>{report.decorated=true;return '<p>'+report.content+'</p>';}});
    configure(); document.querySelector('#entry').onclick = () => ReportReference.open();
  });
  return page;
}

test('reference filters submitted peers and project scopes, normalizes periods and leaves the draft intact', async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await fixture(browser);
    await page.locator('#entry').click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await expect(dialog.locator('[name="report"] option')).toHaveCount(2);
    await expect(dialog.locator('[name="period"] option')).toHaveCount(2);
    await expect(dialog).toContainText('同项目的已提交结果');
    await dialog.locator('[name="report"]').selectOption('2'); await expect(dialog).toContainText('招采提交结果');
    await dialog.locator('[name="period"]').selectOption('2026-10-19'); await expect(dialog).toContainText('上周已提交结果');
    await dialog.getByRole('button',{name:'刷新结果'}).click(); await expect(dialog).toContainText('上周已提交结果');
    assert.equal(await page.evaluate(()=>saved.some(row=>row.decorated)),false);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.locator('#entry')).toBeFocused();
    await expect(page.locator('#draft')).toHaveValue('本人的未提交草稿');
    assert.equal(await page.evaluate(()=>requests),2);
  } finally { await browser.close(); }
});

test('read failures allow retry, empty periods stay explicit and late replies cannot replace a reopened dialog', async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.evaluate(()=>mode='fail');await page.locator('#entry').click();
    await expect(page.getByRole('alert')).toContainText('连接中断');
    await page.evaluate(()=>{mode='ok';saved=[];});await page.getByRole('button',{name:'刷新结果'}).click();
    await expect(page.getByRole('dialog')).toContainText('所选周期暂无其他人的已提交填报');
    await page.getByRole('button',{name:'返回填报'}).click();
    await page.evaluate(()=>mode='pending');await page.locator('#entry').click();
    await expect(page.getByRole('dialog')).toContainText('正在读取');
    await page.getByRole('button',{name:'返回填报'}).click();
    await page.evaluate(()=>mode='ok');await page.locator('#entry').click();
    await page.evaluate(()=>resolvePending({rows:[{id:90,project_id:'p',author_id:'peer',period:'2026-10-26',submitted_at:'2026-10-27',content:'迟到结果'}]}));
    await expect(page.getByRole('dialog')).not.toContainText('迟到结果');
    await expect(page.getByRole('dialog')).toContainText('所选周期暂无其他人的已提交填报');
  } finally {await browser.close();}
});

test('account or scope changes close and discard the reference while retaining original body scroll styles',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser);await page.evaluate(()=>document.body.style.overflow='auto');
    await page.locator('#entry').click();await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(()=>{ctx.key='new-account';ReportReference.refresh();});await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>document.body.style.overflow),'auto');
    await page.evaluate(()=>{ctx.canRead=false;ReportReference.open();});await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(()=>{ctx.canRead=true;ctx.uid='peer';});await page.locator('#entry').click();
    await expect(page.getByRole('dialog')).not.toContainText('同项目的已提交结果');
  } finally {await browser.close();}
});

test('phone reference fits portrait and landscape, traps focus and returns to the form',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await fixture(browser,{width:390,height:844});await page.locator('#entry').click();
    const dialog=page.getByRole('dialog');await expect(dialog).toContainText('同项目的已提交结果');
    for(const viewport of [{width:390,height:844},{width:844,height:390}]) {
      await page.setViewportSize(viewport);
      const box=await dialog.boundingBox();assert.ok(box.x>=0 && box.y>=0 && box.width<=viewport.width && box.height<=viewport.height);
      for(let i=0;i<7;i++) {await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),true);}
      assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    }
    await page.getByRole('button',{name:'返回填报'}).click();await expect(page.locator('#draft')).toHaveValue('本人的未提交草稿');
  } finally {await browser.close();}
});

test('real anonymous HTTP and Edge preserve rich form and AI drafts, enforce project reads and make no business writes',async t=>{
  const runtime=await startPlanningAiLocal({mode:'local-acceptance'});t.after(()=>runtime.close());
  const admin=testPool(runtime.db,null), peer={id:'reference-peer'};
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'示例成本填报人','pm','approved',$2,'成本')",[peer.id,runtime.scope.project_id]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,$2,'pm')",[peer.id,runtime.scope.project_id]);
  await executeDatabase(runtime.pool,peer,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:runtime.scope.project_id,line:'成本',period:runtime.scope.period,
    biz:{form_version:2,nodes:[],items:[{source_id:'peer-item',mod:'成本',name:'样板成本复核',due:runtime.scope.week,prog:'已完成核对，等待设计确认。',blocker:'需设计提供清单'}],handover:[]},
    coord_items:[{source_id:'peer-coord',who_id:'ai-local-acceptance-user',who:'匿名机电填报人',what:'请复核机电清单',by:runtime.scope.week}],
    rich_text:{v:1,fields:{'biz.items.0.prog':{ops:[{insert:'已完成核对',attributes:{bold:true,color:'#d81e06'}},{insert:'，等待设计确认。'}]}}}}});
  await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,author_name,owner_id,owner_name) VALUES($1,$2,'ceo_brief','核对设备到货计划','示例领导','ai-local-acceptance-user','匿名机电填报人')",[runtime.scope.project_id,runtime.scope.period]);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('reference-private','隔离的其他项目','com')");
  await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'reference-private','pm')",[peer.id]);
  await executeDatabase(runtime.pool,peer,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'reference-private',line:'成本',period:runtime.scope.period,
    biz:{form_version:2,nodes:[],items:[{source_id:'private-item',name:'未授权项目的真实隔离样本',prog:'不得泄露'}],handover:[]}}});
  const before=(await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS snapshot FROM public.reports r')).rows[0].snapshot;
  const unauth=await fetch(runtime.url+'/api/db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({table:'reports'})});assert.equal(unauth.status,401);
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
    if(!request.url().startsWith(runtime.url+'/api/'))return;
    const body=request.postDataJSON();
    if(request.url().endsWith('/api/db') && body?.operation && body.operation!=='select')writes.push(body);
    if(/\/(?:confirm|request|review|upload|chat)$/.test(request.url()))writes.push(request.url());
  });
  await page.goto(runtime.url);await page.locator('#email').fill(runtime.account.email);await page.locator('#password').fill(runtime.account.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'查看其他专业填报',exact:true})).toBeVisible();
  await page.evaluate(()=>App.view('center'));
  await expect(page.locator('.reporter-pending')).toContainText('请复核机电清单');
  const pendingKeys=await page.locator('.reporter-pending [data-meeting-key]').evaluateAll(nodes=>nodes.map(node=>node.dataset.meetingKey).sort());
  await page.getByRole('button',{name:'本期填报',exact:true}).click();
  await expect(page.locator('.reporter-followups h3')).toHaveText('四、待处理事项清单');
  for(const category of ['会议事项要求','他人协调我的事项'])await expect(page.locator('.reporter-followups')).toContainText(category);
  await expect(page.locator('.reporter-pending,.reporter-followups')).not.toContainText('核对设备到货计划');
  assert.deepEqual(await page.locator('.reporter-followups [data-followup-key]').evaluateAll(nodes=>nodes.map(node=>node.dataset.followupKey).sort()),pendingKeys);
  await expect(page.locator('.reporter-followups')).not.toContainText('历史会议待办');
  const followup=page.locator('.reporter-followups [data-followup-key^="meeting:"]');
  await followup.locator('.ql-editor').fill('本期待办反馈，继续保留在草稿。');
  const input=page.locator('#bi_pg_0');await expect(input).toHaveValue(/保留的原进展/);
  const editor=page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor');await expect(editor).toBeVisible();
  await editor.press('End');await editor.press('Control+End');await editor.press('Enter');await page.keyboard.insertText('本人新输入，尚未提交。');
  await page.evaluate(()=>{
    const input=document.querySelector('#bi_pg_0');input.dataset.referenceOriginal='retained';window.referenceInput=input;
  });
  await page.getByRole('button',{name:'查看其他专业填报',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'查看其他专业填报'});await expect(dialog).toContainText('样板成本复核');
  await expect(dialog.locator('.report-reference-table')).toContainText('需设计提供清单');
  await expect(dialog.locator('.report-reference-table strong .rt-red, .report-reference-table .rt-red strong, .report-reference-table strong.rt-red')).toHaveCount(1);
  const draft=await input.inputValue();assert.match(draft,/本人新输入/);
  assert.equal(await page.evaluate(()=>referenceInput===document.querySelector('#bi_pg_0')),true);
  await expect(dialog.locator('[name="report"] option')).toHaveCount(1);
  mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'desktop-reference.png')});
  await page.getByRole('button',{name:'刷新结果',exact:true}).click();await expect(dialog).toContainText('样板成本复核');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'mobile-reference.png')});
  assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(input).toHaveValue(draft);
  await expect(followup.locator('textarea')).toHaveValue('本期待办反馈，继续保留在草稿。');
  await expect(page.locator('[data-rich-editor-for="bi_pg_0"] strong')).toContainText('保留的原进展');
  // The same existing database route must still enforce RLS for a tampered project.
  const denied=await page.evaluate(async()=>{
    const r=await fetch('/api/db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({table:'reports',filters:[{column:'project_id',value:'reference-private'}]})});return r.json();
  });assert.deepEqual(denied.data,[]);
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'AI 填报助手',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'AI 填报助手'})).toBeVisible();
  await page.locator('.planning-ai-input').fill('保留这段尚未发送的 AI 输入');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'查看其他专业填报',exact:true}).click();
  await expect(dialog).toContainText('样板成本复核');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'AI 填报助手',exact:true}).click();await expect(page.locator('.planning-ai-input')).toHaveValue('保留这段尚未发送的 AI 输入');
  await page.keyboard.press('Escape');await page.reload();await page.getByRole('button',{name:'本期填报',exact:true}).click();
  await expect(page.locator('#bi_pg_0')).toHaveValue(draft);
  await expect(page.locator('.reporter-followups [data-followup-key^="meeting:"] textarea')).toHaveValue('本期待办反馈，继续保留在草稿。');
  await page.locator('.reporter-followups').screenshot({path:path.join(artifacts,'desktop-unified-followups.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.reporter-followups').screenshot({path:path.join(artifacts,'mobile-unified-followups.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  assert.deepEqual((await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS snapshot FROM public.reports r')).rows[0].snapshot,before);
});
