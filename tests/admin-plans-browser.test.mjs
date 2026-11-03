import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { reportWeekStart } from '../server/database.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { makeAdminPlanWorkbook, adminPlanSheet, adminPlanTitle, adminPlanHeaders, adminPlanRow, adminPlanInline } from './helpers/admin-plan-workbook.mjs';

// Actual browser + HTTP acceptance uses only a fresh anonymous in-memory
// database. It never loads .env, visits an existing service, or invokes AI.
async function runtime(t, provider = {}) {
  const db = await initializedDatabase(), admin = testPool(db, null), pool = testPool(db);
  const accounts = await seedDemo(admin), project = 'admin-browser-residential';
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), week = reportWeekStart(today), month = week.slice(0, 7);
  await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES($1,'匿名管理员代填验收住宅','res',1)", [project]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES('demo-pm-res',$1,'pm')", [project]);
  const app = createApp({ pool, config: { authCodeSecret: randomBytes(32).toString('hex'), readOnly: false,
    publicOrigin: '', trustProxy: false, cookieSecure: false, cookieName: 'admin_plan_browser_acceptance', sessionHours: 2,
    ...provider,
    mailer: { configured: false, async sendCode() { throw new Error('匿名隔离验收不发送邮件'); } } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await pool.end(); await admin.end(); await db.close();
  });
  return { admin, url, project, week, month, accounts };
}
async function login(browser, f, id, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const account = f.accounts.find(row => row.id === id);
  await page.goto(f.url); await page.locator('#email').fill(account.email); await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.locator('.planning-mainnav')).toBeVisible();
  return page;
}
const richEditor = (page, id) => page.locator('[data-rich-editor-for="' + id + '"] .ql-editor');
async function context(page, f) {
  const response = await page.request.get(f.url + '/api/admin-plans/context?project_type=res&month=' + f.month);
  assert.equal(response.status(), 200); const result = await response.json(); assert.equal(result.error, null); return result.data;
}
function reportWrite(response) {
  if (!response.url().endsWith('/api/db') || response.request().method() !== 'POST') return false;
  try { const body = response.request().postDataJSON(); return body.table === 'reports' && body.operation === 'upsert'; } catch { return false; }
}

test('实际HTTP与Edge：商业总览在零周报时显示本月已确认计划，按专业隔离且不放入历史周期', {timeout:120000},async t=>{
 const f=await runtime(t),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];t.after(()=>browser.close());const page=await login(browser,f,'demo-ops',errors),project='browser-commercial-plan',line='土建工程（东地块）',name='已确认但尚未提交周报的商业工作计划';
 await f.admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES($1,'匿名商业确认计划验收','com',1)",[project]);await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pm-com',$1)",[project]);
 const response=await page.request.post(f.url+'/api/admin-plans/save',{headers:{Origin:f.url},data:{operation_id:randomUUID(),plans:[{project_id:project,line,owner_id:'demo-pm-com',month:f.month,expected_plan_id:null,items:[{source_id:'preview-source',mod:'主体施工',name,due:f.month+'-28'}],rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:name,attributes:{bold:true}}]}}}}]}});assert.equal(response.status(),200);
 await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.getByRole('button',{name:'计划总览',exact:true}).click();await page.getByRole('button',{name:'商业计划总览',exact:true}).click();await page.locator('#overviewFilter').selectOption(line);
 const group=page.locator('.overview-project[data-project-id="'+project+'"]');await expect(group).toContainText('本期 0 份填报');const table=group.locator('.overview-data-table[data-section="plans"]');await expect(table).toContainText(name);await expect(table.locator('strong')).toContainText(name);await expect(table).toContainText('月计划已确认，本周尚未提交');
 const evidence=path.resolve('.local/overview-plan-layout-20261102');await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'commercial-confirmed-plan.png'),fullPage:true});
 const periods=await page.locator('#overviewPeriod option').evaluateAll(nodes=>nodes.map(node=>node.value));const historical=periods.find(value=>value.slice(0,7)!==f.month);assert.ok(historical);await page.locator('#overviewPeriod').selectOption(historical);await expect(group).not.toContainText(name);await page.locator('#overviewPeriod').selectOption(f.week);await expect(group).toContainText(name);
 await page.locator('#overviewFilter').selectOption('机电工程');await expect(group).not.toContainText(name);assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE project_id=$1',[project])).rows[0].n,0);assert.deepEqual(errors,[]);
});

test('实际HTTP与Edge：刷新后可查保存批次，确认完整跨月范围后整批撤回，恢复原计划和汇总', {timeout:120000},async t=>{
 const f=await runtime(t),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];t.after(()=>browser.close());const page=await login(browser,f,'demo-ops',errors);
 const nextDate=new Date(f.month+'-01T00:00:00Z');nextDate.setUTCMonth(nextDate.getUTCMonth()+1);const next=nextDate.toISOString().slice(0,7),fixed={source_id:'retained-source',mod:'工程',name:'导入前已有的正式事项',due:f.month+'-20'};
 const plan={project_id:f.project,line:'工程',owner_id:'demo-pm-res',month:f.month,items:[fixed],expected_plan_id:null},summary={...plan,items:[{...fixed,progress:'导入前的月度记录'}],expected_summary_id:null};delete summary.expected_plan_id;
 async function save(data){const result=await page.request.post(f.url+'/api/admin-plans/save',{headers:{Origin:f.url},data:{operation_id:randomUUID(),...data}});assert.equal(result.status(),200);return (await result.json()).data;}
 const before=await save({plans:[plan],summaries:[summary]}),imported=await save({plans:[{...plan,expected_plan_id:before.plans[0].id,items:[fixed,{...fixed,source_id:'added-source',name:'这次误导入的事项'}]},{...plan,month:next,items:[{...fixed,source_id:'next-source',name:'这次导入的下月事项'}]}],summaries:[{...summary,expected_summary_id:before.summaries[0].id,items:[{...fixed,progress:'本次导入的月度记录'}]}]});
 await page.reload();await expect(page.locator('.planning-mainnav')).toBeVisible();await page.getByRole('button',{name:'计划总览',exact:true}).click();await page.getByRole('button',{name:'住宅计划总览',exact:true}).click();await page.locator('.work').getByRole('button',{name:'批量导入计划',exact:true}).click();await page.locator('#admin-plan-month').fill(f.month);await page.locator('#admin-plan-project').selectOption(JSON.stringify([f.project,'']));
 await page.getByRole('button',{name:'导入记录 / 撤回',exact:true}).click();const batch=page.locator('.admin-plan-batch[data-operation-id="'+imported.operation_id+'"]');await expect(batch).toContainText(f.month);await expect(batch).toContainText(next);await expect(batch.getByRole('button',{name:'撤回整批',exact:true})).toBeEnabled();
 const evidence=path.resolve('.local/admin-batch-withdrawal-20261102');await mkdir(evidence,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'batch-withdraw-before.png'),fullPage:true});
 let confirmation='';page.once('dialog',dialog=>{confirmation=dialog.message();return dialog.accept();});const response=page.waitForResponse(response=>response.url().endsWith('/api/admin-plans/withdraw-batch'));await batch.getByRole('button',{name:'撤回整批',exact:true}).click();const result=await response;assert.equal(result.status(),200);const receipt=(await result.json()).data;
 assert.match(confirmation,new RegExp(next));assert.match(confirmation,/2 份月计划、1 份月度汇总|1 份月计划、1 份月度汇总/);assert.equal(receipt.removed_plan_ids.length,2);assert.equal(receipt.plans.length,1);assert.deepEqual(receipt.plans[0].items,before.plans[0].items);assert.deepEqual(receipt.summaries[0].items,before.summaries[0].items);assert.notEqual(receipt.plans[0].id,before.plans[0].id);
 await expect(batch.getByRole('button',{name:'本批次已撤回',exact:true})).toBeDisabled();await page.getByRole('button',{name:'重新读取保存批次',exact:true}).click();await expect(batch.getByRole('button',{name:'本批次已撤回',exact:true})).toBeDisabled();
 const plans=(await f.admin.query('SELECT id,items FROM public.monthly_plans WHERE project_id=$1',[f.project])).rows;assert.equal(plans.length,1);assert.deepEqual(plans[0].items,[fixed]);assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE project_id=$1',[f.project])).rows[0].n,0);
 await page.screenshot({path:path.join(evidence,'batch-withdraw-after.png'),fullPage:true});assert.deepEqual(errors,[]);
});

test('实际HTTP与Edge：未选项目可打开文件选择器，导入后直接修改计划和汇总，并发冲突保留原输入', {timeout:120000},async t=>{
  const f=await runtime(t),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],imports=[],saves=[];t.after(()=>browser.close());
  const page=await login(browser,f,'demo-ops',errors),evidence=path.resolve('.local/admin-import-fix-20261102');await mkdir(evidence,{recursive:true});
  page.on('request',request=>{if(request.url().includes('/api/admin-plans/import?'))imports.push(request.url());if(request.url().endsWith('/api/admin-plans/save'))saves.push(request.postDataJSON());});
  await page.getByRole('button',{name:'计划总览',exact:true}).click();await page.getByRole('button',{name:'住宅计划总览',exact:true}).click();await page.locator('.work').getByRole('button',{name:'批量导入计划',exact:true}).click();
  await page.locator('#admin-plan-month').fill(f.month);await page.locator('#admin-plan-project').selectOption('');await page.getByRole('radio',{name:'仅所选单月计划',exact:true}).check();
  await expect(page.locator('#admin-plan-file')).toBeEnabled();await expect(page.locator('#admin-plan-file-help')).toContainText('请先在上方选择项目');
  const workbook=makeAdminPlanWorkbook([{name:'工程',xml:adminPlanSheet([adminPlanTitle(1,f.month.slice(0,4)+'年'+Number(f.month.slice(5))+'月份'),adminPlanHeaders(2),adminPlanRow(3,[adminPlanInline('A3','工程'),adminPlanInline('C3','可核对的原计划事项'),adminPlanInline('E3',f.month+'-28')])])}]);
  const chooserPromise=page.waitForEvent('filechooser');await page.locator('#admin-plan-file').click();const chooser=await chooserPromise;await chooser.setFiles({name:'anonymous-editable.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:workbook});
  await expect(page.locator('.admin-plan-selected-file')).toContainText('anonymous-editable.xlsx');assert.equal(imports.length,0);await page.screenshot({path:path.join(evidence,'file-before-project.png'),fullPage:true});
  await page.locator('#admin-plan-project').selectOption(JSON.stringify([f.project,'']));await expect(page.locator('.admin-plan-selected-file')).toContainText('anonymous-editable.xlsx');assert.equal(imports.length,0);
  const previewResponse=page.waitForResponse(response=>response.url().includes('/api/admin-plans/import?'));await page.getByRole('button',{name:'读取 Excel 预览',exact:true}).click();assert.equal((await previewResponse).status(),200);await expect(page.getByRole('button',{name:'确认保存所选计划',exact:true})).toBeEnabled();
  page.once('dialog',dialog=>dialog.accept());let receiptPromise=page.waitForResponse(response=>response.url().endsWith('/api/admin-plans/save'));await page.getByRole('button',{name:'确认保存所选计划',exact:true}).click();const initial=(await (await receiptPromise).json()).data.plans[0];
  const summary={project_id:f.project,line:'工程',owner_id:'demo-pm-res',month:f.month,expected_summary_id:null,items:[{source_id:'original-summary',mod:'现场',name:'独立月度事项',due:f.month+'-20',progress:'原月度完成情况'}]};
  const seed=await page.request.post(f.url+'/api/admin-plans/save',{headers:{Origin:f.url},data:{operation_id:randomUUID(),plans:[],summaries:[summary]}});assert.equal(seed.status(),200);const originalSummary=(await seed.json()).data.summaries[0];
  await page.getByRole('button',{name:'重新读取计划',exact:true}).click();await page.getByRole('button',{name:'已保存内容 / 修改',exact:true}).click();await expect(page.locator('.admin-plan-records tbody tr')).toHaveCount(2);
  await page.getByRole('button',{name:/^修改月计划：/}).click();const editor=richEditor(page,'admin_plan_name_0');await expect(editor).toContainText('可核对的原计划事项');await editor.fill('导入后修正的计划事项');await editor.press('Control+A');await editor.press('Control+B');
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'saved-plan-edit.png'),fullPage:true});page.once('dialog',dialog=>dialog.accept());receiptPromise=page.waitForResponse(response=>response.url().endsWith('/api/admin-plans/save'));await page.getByRole('button',{name:'保存计划修改',exact:true}).click();const corrected=(await (await receiptPromise).json()).data.plans[0];
  assert.notEqual(corrected.id,initial.id);assert.equal(corrected.items[0].source_id,initial.items[0].source_id);assert.equal(corrected.items[0].name,'导入后修正的计划事项');assert.equal(corrected.rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
  const archived=(await f.admin.query('SELECT snapshot,withdrawn_by FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[initial.id])).rows[0];assert.equal(archived.snapshot.items[0].name,'可核对的原计划事项');assert.equal(archived.withdrawn_by,'demo-ops');
  await page.getByRole('button',{name:/^修改月度完成汇总：/}).click();await expect(page.locator('#admin_plan_progress_0')).toHaveValue('原月度完成情况');await page.locator('#admin_plan_progress_0').fill('本窗口不能丢失的完成情况');
  const concurrent=await page.request.post(f.url+'/api/admin-plans/save',{headers:{Origin:f.url},data:{operation_id:randomUUID(),plans:[],summaries:[{...summary,expected_summary_id:originalSummary.id,items:[{...summary.items[0],progress:'另一窗口已核对的最新情况'}]}]}});assert.equal(concurrent.status(),200);const concurrentSummary=(await concurrent.json()).data.summaries[0];
  page.once('dialog',dialog=>dialog.accept());receiptPromise=page.waitForResponse(response=>response.url().endsWith('/api/admin-plans/save'));await page.getByRole('button',{name:'保存汇总修改',exact:true}).click();assert.equal((await receiptPromise).status(),409);await expect(page.locator('#admin_plan_progress_0')).toHaveValue('本窗口不能丢失的完成情况');
  await page.getByRole('button',{name:'重新读取计划',exact:true}).click();await expect(page.getByRole('button',{name:'保存汇总修改',exact:true})).toBeDisabled();await expect(page.locator('#admin_plan_progress_0')).toHaveValue('本窗口不能丢失的完成情况');
  await page.getByRole('button',{name:'载入最新内容，保留原输入副本',exact:true}).click();await expect(page.locator('#admin_plan_progress_0')).toHaveValue('另一窗口已核对的最新情况');await page.getByText('载入前的未保存输入副本',{exact:true}).click();await expect(page.locator('#admin-plan-saved-editor details')).toContainText('本窗口不能丢失的完成情况');
  await page.locator('#admin_plan_progress_0').fill('最终人工核对后的完成情况');page.once('dialog',dialog=>dialog.accept());receiptPromise=page.waitForResponse(response=>response.url().endsWith('/api/admin-plans/save'));await page.getByRole('button',{name:'保存汇总修改',exact:true}).click();const finalSummary=(await (await receiptPromise).json()).data.summaries[0];
  assert.notEqual(finalSummary.id,concurrentSummary.id);assert.equal(finalSummary.version,3);assert.equal(finalSummary.items[0].source_id,'original-summary');assert.equal(finalSummary.items[0].progress,'最终人工核对后的完成情况');
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE project_id=$1',[f.project])).rows[0].n,0);assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.completion_requests WHERE project_id=$1',[f.project])).rows[0].n,0);assert.equal(imports.length,1);assert.equal(saves.filter(body=>body.summaries).every(body=>body.plans.length===0),true);assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'summary-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
});

test('实际HTTP与Edge：双月Excel一次保存本月独立完成汇总和下月计划，员工原协调草稿与周报审核保持', {timeout:120000},async t=>{
  let modelCalls=0;const f=await runtime(t,{planningAIFetch:async()=>{modelCalls++;throw new Error('本测试禁止调用模型');}}),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],saves=[],aiRequests=[];t.after(()=>browser.close());
  const nextDate=new Date(f.month+'-01T00:00:00Z');nextDate.setUTCMonth(nextDate.getUTCMonth()+1);const next=nextDate.toISOString().slice(0,7);
  const snapshot=async()=>(await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'completions',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.completion_requests c),'coordination',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.coordination_tasks c)) data")).rows[0].data;
  const before=await snapshot(),employee=await login(browser,f,'demo-pm-res',errors);await employee.evaluate(({project,week})=>App.fillProject(project,week),{project:f.project,week:f.week});
  await richEditor(employee,'co_what_0').fill('管理员导入不能覆盖的本人原协调草稿');await expect(employee.locator('#co_what_0')).toHaveValue('管理员导入不能覆盖的本人原协调草稿');await employee.getByRole('button',{name:'保存本机草稿',exact:true}).click();
  const originalDraft=await employee.evaluate(project=>{const candidates=Object.keys(localStorage).filter(value=>value.startsWith('zh_draft_demo-pm-res_'+project+'_')).map(key=>({key,raw:localStorage.getItem(key)})).sort((a,b)=>JSON.parse(b.raw).ts-JSON.parse(a.raw).ts);if(!candidates.length)throw new Error('missing-anonymous-employee-draft');return candidates[0];},f.project);assert.equal(JSON.parse(originalDraft.raw).coordRows[0].what,'管理员导入不能覆盖的本人原协调草稿');
  const admin=await login(browser,f,'demo-ops',errors);admin.on('request',request=>{if(request.url().endsWith('/api/admin-plans/save'))saves.push(request.postDataJSON());if(request.url().includes('/api/admin-plans/ai/') || request.url().includes('/api/planning-ai/'))aiRequests.push(request.url());});
  await admin.getByRole('button',{name:'计划总览',exact:true}).click();await admin.getByRole('button',{name:'住宅计划总览',exact:true}).click();await admin.locator('.work').getByRole('button',{name:'批量导入计划',exact:true}).click();
  await expect(admin.getByRole('button',{name:'Excel 直接导入',exact:true})).toHaveAttribute('aria-pressed','true');await expect(admin.getByRole('radio',{name:'本月计划及完成情况 ＋ 下月工作计划',exact:true})).toBeChecked();
  await admin.locator('#admin-plan-month').fill(f.month);await admin.locator('#admin-plan-project').selectOption(JSON.stringify([f.project,'']));
  const title=month=>month.slice(0,4)+'年'+Number(month.slice(5))+'月份',head=row=>adminPlanRow(row,[['A','模块'],['B','序号'],['C','事项'],['D','完成标准'],['E','计划完成时间'],['F','当前工作进展与下步工作计划'],['H','主责人']].map(([column,label])=>adminPlanInline(column+row,label)));
  const rawProgress='原表已完成现场初验，余项待复核',secondProgress='原表仍在推进，不代表审核完成',editedProgress=rawProgress+'；管理员核对补充',nextName='下月原计划事项',editedNextName='管理员修订后的下月计划事项';
  const workbook=makeAdminPlanWorkbook([{name:'工程',xml:adminPlanSheet([
    adminPlanTitle(1,title(f.month)),head(2),adminPlanRow(3,[adminPlanInline('A3','工程'),adminPlanInline('B3','1'),adminPlanInline('C3','本月跨月截止事项'),adminPlanInline('D3','完成验收资料核对'),adminPlanInline('E3',next+'-10'),adminPlanInline('F3',rawProgress),adminPlanInline('H3','原表工作责任人')]),
    adminPlanRow(4,[adminPlanInline('A4','工程'),adminPlanInline('B4','2'),adminPlanInline('C4','本月第二项工作'),adminPlanInline('E4',f.month+'-28'),adminPlanInline('F4',secondProgress)]),
    adminPlanTitle(6,title(next)),head(7),adminPlanRow(8,[adminPlanInline('A8','工程'),adminPlanInline('B8','1'),adminPlanInline('C8',nextName),adminPlanInline('E8',next+'-28'),adminPlanInline('F8','下月原备注仅供参考')])
  ])}]);
  const previewResponse=admin.waitForResponse(response=>response.url().includes('/api/admin-plans/import?'));await admin.locator('#admin-plan-file').setInputFiles({name:'anonymous-two-months.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:workbook});
  const previewHttp=await previewResponse;assert.equal(previewHttp.status(),200);assert.equal(new URL(previewHttp.url()).searchParams.get('include_next'),'1');const preview=await previewHttp.json();assert.equal(preview.error,null);assert.equal(preview.data.batches.length,2);
  const currentPreview=preview.data.batches.find(row=>row.month===f.month),nextPreview=preview.data.batches.find(row=>row.month===next);assert.equal(currentPreview.rows.length,2);assert.equal(nextPreview.rows.length,1);assert.equal(currentPreview.rows[0].due,next+'-10');assert.equal(currentPreview.rows[0].progress,rawProgress);
  await expect(admin.locator('.admin-month-card')).toHaveCount(2);await expect(admin.getByRole('checkbox',{name:f.month+'保存月度完成情况',exact:true})).toBeChecked();await expect(admin.getByRole('checkbox',{name:f.month+'写入月计划',exact:true})).not.toBeChecked();await expect(admin.getByRole('checkbox',{name:next+'写入月计划',exact:true})).toBeChecked();await expect(admin.getByRole('checkbox',{name:next+'保存月度完成情况',exact:true})).not.toBeChecked();
  await admin.getByRole('textbox',{name:'第1项月度完成情况',exact:true}).fill(editedProgress);await admin.locator('.admin-month-open').filter({hasText:next+' · 下月工作计划'}).click();await expect(richEditor(admin,'admin_plan_name_0')).toContainText(nextName);await richEditor(admin,'admin_plan_name_0').fill(editedNextName);
  await admin.locator('.admin-month-open').filter({hasText:f.month+' · 本月计划及完成情况'}).click();await expect(admin.getByRole('textbox',{name:'第1项月度完成情况',exact:true})).toHaveValue(editedProgress);assert.deepEqual(await snapshot(),before);assert.equal(saves.length,0);
  admin.once('dialog',dialog=>dialog.accept());const savedResponse=admin.waitForResponse(response=>response.url().endsWith('/api/admin-plans/save'));await admin.getByRole('button',{name:'确认保存所选月份',exact:true}).click();const savedHttp=await savedResponse;assert.equal(savedHttp.status(),200);const receipt=await savedHttp.json();assert.equal(receipt.error,null);assert.equal(receipt.data.plans.length,1);assert.equal(receipt.data.summaries.length,1);assert.equal(saves.length,1);assert.equal(saves[0].plans[0].month,next);assert.equal(saves[0].summaries[0].month,f.month);
  const summariesHttp=await admin.request.get(f.url+'/api/monthly-summaries?month='+f.month);assert.equal(summariesHttp.status(),200);const summaries=(await summariesHttp.json()).data.filter(row=>row.project_id===f.project);assert.equal(summaries.length,1);assert.equal(summaries[0].owner_id,'demo-pm-res');assert.equal(summaries[0].items.length,2);assert.equal(summaries[0].items[0].progress,editedProgress);assert.equal(summaries[0].items[1].progress,secondProgress);assert.equal(summaries[0].items[0].due,next+'-10');assert.ok(!Object.hasOwn(summaries[0],'status'));
  const nextPlanHttp=await employee.request.post(f.url+'/api/monthly-plans/list',{headers:{Origin:f.url},data:{project_id:f.project,month:next,line:'工程'}});assert.equal(nextPlanHttp.status(),200);const nextPlans=(await nextPlanHttp.json()).data;assert.equal(nextPlans.length,1);assert.equal(nextPlans[0].owner_id,'demo-pm-res');assert.equal(nextPlans[0].items[0].name,editedNextName);assert.equal(nextPlans[0].items[0].due,next+'-28');assert.ok(nextPlans[0].items.every(item=>!Object.hasOwn(item,'progress')&&!Object.hasOwn(item,'prog')));
  const currentPlanHttp=await employee.request.post(f.url+'/api/monthly-plans/list',{headers:{Origin:f.url},data:{project_id:f.project,month:f.month,line:'工程'}});assert.equal(currentPlanHttp.status(),200);assert.deepEqual((await currentPlanHttp.json()).data,[]);assert.equal(await employee.evaluate(key=>localStorage.getItem(key),originalDraft.key),originalDraft.raw);
  await employee.reload();await expect(employee.locator('.planning-mainnav')).toBeVisible();await employee.evaluate(({project,week})=>App.fillProject(project,week),{project:f.project,week:f.week});await expect(richEditor(employee,'co_what_0')).toHaveText('管理员导入不能覆盖的本人原协调草稿');await employee.getByRole('button',{name:'准备下月 '+next,exact:true}).click();await expect(employee.locator('.monthly-next-plan')).toContainText(editedNextName);
  assert.deepEqual(await snapshot(),before);assert.equal(modelCalls,0);assert.deepEqual(aiRequests,[]);assert.deepEqual(errors,[]);
});

test('实际HTTP与Edge：管理员富文本代填贯通本人周报、引用锁定，Excel工作责任人不影响专业匹配且仅预览', { timeout: 120000 }, async t => {
  const f = await runtime(t), browser = await chromium.launch({ channel: 'msedge', headless: true }), errors = [];
  t.after(() => browser.close());
  const admin = await login(browser, f, 'demo-ops', errors), saves = [];
  admin.on('request', request => { if (request.url().endsWith('/api/admin-plans/save')) saves.push(request.postDataJSON()); });
  await admin.getByRole('button', { name: '计划总览', exact: true }).click();
  await admin.getByRole('button', { name: '住宅计划总览', exact: true }).click();
  await admin.locator('.work').getByRole('button', { name: '批量导入计划', exact: true }).click();
  await expect(admin.getByRole('heading', { name: '代填与批量导入计划' })).toBeVisible();
  await admin.getByRole('button', { name: '手工代填', exact: true }).click();
  await admin.locator('#admin-plan-month').fill(f.month);
  await admin.locator('#admin-plan-project').selectOption(JSON.stringify([f.project, '']));
  await admin.locator('#admin-plan-line').selectOption('工程'); await admin.locator('#admin-plan-owner').selectOption('demo-pm-res');
  await richEditor(admin, 'admin_plan_mod_0').fill('设备安装');
  const name = '匿名代填同一权威月计划', nameEditor = richEditor(admin, 'admin_plan_name_0');
  await nameEditor.fill(name); await nameEditor.press('Control+A'); await nameEditor.press('Control+B');
  await expect(nameEditor.locator('strong')).toHaveText(name);
  await admin.locator('#admin_plan_due_0').fill(f.month + '-28');
  admin.once('dialog', dialog => dialog.accept());
  const savedResponse = admin.waitForResponse(response => response.url().endsWith('/api/admin-plans/save'));
  await admin.getByRole('button', { name: '保存月计划', exact: true }).click();
  const savedHttp = await savedResponse; assert.equal(savedHttp.status(), 200);
  const receipt = await savedHttp.json(); assert.equal(receipt.error, null); const plan = receipt.data.plans[0];
  assert.equal(plan.confirmed_by, 'demo-pm-res'); assert.equal(plan.owner_id, 'demo-pm-res');
  assert.equal(plan.items[0].name, name); assert.equal(plan.rich_text.fields['items.0.name'].ops[0].attributes.bold, true);
  await expect(admin.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  assert.equal(saves.length, 1); assert.equal(saves[0].plans[0].owner_id, 'demo-pm-res');

  const employee = await login(browser, f, 'demo-pm-res', errors);
  await employee.evaluate(({ project, week }) => App.fillProject(project, week), { project: f.project, week: f.week });
  const planRow = employee.locator('.report3-monthly-table tbody tr').filter({ hasText: name });
  await expect(planRow).toHaveCount(1); await expect(planRow.locator('strong')).toContainText(name);
  const progress = '匿名本人填写的本周进展：已完成现场核查';
  await planRow.locator('[data-rich-editor-for^="bi_pg_"] .ql-editor').fill(progress);
  const submitted = employee.waitForResponse(reportWrite);
  await employee.getByRole('button', { name: '提交本期直报', exact: true }).click();
  const reportHttp = await submitted; assert.equal(reportHttp.status(), 200);
  const reportReceipt = await reportHttp.json(); assert.equal(reportReceipt.error, null); const report = reportReceipt.data[0];
  assert.equal(report.author_id, 'demo-pm-res'); assert.equal(report.project_id, f.project);
  assert.equal(report.biz.monthly_plan_id, plan.id); assert.equal(report.biz.items[0].prog, progress);
  assert.equal(report.rich_text.fields['biz.items.0.name'].ops[0].attributes.bold, true);
  const locked = (await context(admin, f)).plans.find(row => row.id === plan.id); assert.equal(locked.editable, false);
  await admin.getByRole('button', { name: '重新读取计划', exact: true }).click();
  await expect(admin.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await expect(admin.locator('.admin-plan-locked')).toContainText('引用');

  await admin.getByRole('button', { name: 'Excel 直接导入', exact: true }).click();
  await admin.getByRole('radio',{name:'仅所选单月计划',exact:true}).check();
  const before = JSON.stringify((await context(admin, f)).plans), titleMonth = f.month.slice(0, 4) + '年' + Number(f.month.slice(5)) + '月份';
  const workbook = makeAdminPlanWorkbook([{ name: '工程', xml: adminPlanSheet([
    adminPlanTitle(1, titleMonth), adminPlanHeaders(2), adminPlanRow(3, [adminPlanInline('A3', '工程'),
      adminPlanInline('C3', '匿名Excel待分配事项'), adminPlanInline('E3', f.month + '-28'), adminPlanInline('H3', '未分配示例负责人')])
  ]) }]);
  const previewResponse = admin.waitForResponse(response => response.url().includes('/api/admin-plans/import?'));
  await admin.locator('#admin-plan-file').setInputFiles({ name: 'anonymous-month.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook });
  const previewHttp = await previewResponse; assert.equal(previewHttp.status(), 200); const preview = await previewHttp.json();
  assert.equal(preview.error, null); assert.equal(preview.data.month, f.month); assert.equal(preview.data.rows.length, 1);
  assert.equal(preview.data.rows[0].owner_id, 'demo-pm-res'); assert.equal(preview.data.rows[0].match_status, 'matched');assert.equal(preview.data.rows[0].match_basis,'project_line_unique');
  await expect(admin.getByRole('status')).toContainText('仅预览，尚未写入任何计划');
  await expect(admin.getByRole('status')).toContainText('待分配 0 项');
  await expect(admin.getByRole('combobox', { name: '第1项专业及提报人' })).toHaveValue(JSON.stringify([f.project,'','工程','demo-pm-res']));
  await expect(admin.getByRole('button', { name: '确认保存所选计划', exact: true })).toBeDisabled();
  assert.equal(JSON.stringify((await context(admin, f)).plans), before); assert.equal(saves.length, 1);
  assert.deepEqual(errors, []);
});

test('实际HTTP与Edge：匿名AI整项目识别、对话澄清、带标准与加粗计划一次确认，模型无直接写入能力', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planning-admin-ai-browser-')), configPath = path.join(dir, 'provider.json');
  const key = 'sk-' + randomBytes(24).toString('hex');
  await writeFile(configPath, JSON.stringify({ enabled: true, api_key: key, model: 'deepseek-flash' }), { mode: 0o600 });
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  const f = await runtime(t, { planningAIConfigPath: configPath, planningAIFetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/responses'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ' + key); assert.equal(options.body.includes(key), false);
    const body = JSON.parse(options.body), evidence = JSON.parse(body.input[0].content); calls.push(body);
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.tools, undefined);
    assert.equal(evidence.strict_rows.length, 1); assert.equal(evidence.strict_rows[0].standard, '完成联合验收');
    const clarified = calls.length > 1;
    if (clarified) assert.ok(body.input.some(message => typeof message.content === 'string' && message.content.includes('保留原表事项和完成标准')));
    const rows = evidence.strict_rows.map(row => ({ row_id: row.id, region_id: row.region_id, source_row: row.source_row,
      name_cells: [], standard_cells: [], mod_cells: [], due_cell: '', line: '工程', owner_id: 'demo-pm-res', included: true, reason: '' }));
    const value = { reply: clarified ? '已核对原表完成标准，保持原文，请核对后确认导入。' : '已按项目专业匹配填报人，请核对原表完成标准。',
      rows, questions: clarified ? [] : [{ id: 'confirm-standard',kind:'source', text: '请确认按原表事项和完成标准生成预览，保持原文。', row_ids: rows.map(row => row.row_id) }], complete: true };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true }), errors = []; t.after(() => browser.close());
  const page = await login(browser, f, 'demo-ops', errors), modelWrites = [];
  page.on('request', request => { if (request.url().includes('/api/admin-plans/ai/confirm')) modelWrites.push(request.postDataJSON()); });
  await page.getByRole('button', { name: '计划总览', exact: true }).click();
  await page.getByRole('button', { name: '住宅计划总览', exact: true }).click();
  await page.locator('.work').getByRole('button', { name: '批量导入计划', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Excel 直接导入', exact: true })).toHaveAttribute('aria-pressed', 'true');await page.getByRole('button', { name: 'AI 整项目批量导入', exact: true }).click();
  await page.locator('#admin-plan-month').fill(f.month);
  await page.locator('#admin-plan-project').selectOption(JSON.stringify([f.project, '']));
  assert.equal(await page.locator('#admin-plan-line:visible,#admin-plan-owner:visible').count(), 0);
  const before = JSON.stringify((await context(page, f)).plans), titleMonth = f.month.slice(0, 4) + '年' + Number(f.month.slice(5)) + '月份';
  const styles = '<styleSheet><fonts><font/><font><b/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/></cellXfs></styleSheet>';
  const bytes = makeAdminPlanWorkbook([{ name: '工程', xml: adminPlanSheet([adminPlanTitle(1, titleMonth), adminPlanHeaders(2), adminPlanRow(3, [
    adminPlanInline('A3', '工程'), adminPlanInline('C3', '匿名AI识别的原始工程事项', ' s="1"'), adminPlanInline('D3', '完成联合验收'),
    adminPlanInline('E3', f.month + '-28'), adminPlanInline('H3', '待明确的负责人')])]) }], { styles });
  const uploaded = page.waitForResponse(response => response.url().includes('/api/admin-plans/ai/upload?'));
  await page.locator('#admin-plan-file').setInputFiles({ name: 'anonymous-ai-project.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  assert.equal(await page.locator('.admin-plan-selected-file').textContent().then(text=>text.includes('anonymous-ai-project.xlsx')),true);
  await page.locator('#admin-plan-ai-start').click();
  const uploadHttp = await uploaded; assert.equal(uploadHttp.status(), 200); const upload = await uploadHttp.json();
  assert.equal(upload.error, null); assert.equal(upload.data.can_confirm, false); assert.equal(upload.data.rows.length, 1);
  assert.equal(upload.data.rows[0].owner_id,'demo-pm-res');await expect(page.getByRole('log', { name: '批量导入 AI 对话' })).toContainText('请核对原表完成标准');
  await expect(page.getByRole('button', { name: '一次确认导入全部计划', exact: true })).toBeDisabled();
  assert.equal(JSON.stringify((await context(page, f)).plans), before); assert.equal(modelWrites.length, 0);
  await page.locator('#admin-plan-ai-input').fill('保留原表事项和完成标准，系统填报人按项目和专业匹配即可。');
  const chatted = page.waitForResponse(response => response.url().endsWith('/api/admin-plans/ai/chat'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const chatHttp = await chatted; assert.equal(chatHttp.status(), 200); const chat = await chatHttp.json();
  assert.equal(chat.error, null); assert.equal(chat.data.can_confirm, true); assert.equal(chat.data.rows[0].owner_id, 'demo-pm-res');
  await expect(page.getByRole('log', { name: '批量导入 AI 对话' })).toContainText('已核对原表完成标准');
  await expect(page.getByRole('button', { name: '一次确认导入全部计划', exact: true })).toBeEnabled();
  assert.equal(JSON.stringify((await context(page, f)).plans), before); assert.equal(modelWrites.length, 0);
  page.once('dialog', dialog => dialog.accept());
  const confirmed = page.waitForResponse(response => response.url().endsWith('/api/admin-plans/ai/confirm'));
  await page.getByRole('button', { name: '一次确认导入全部计划', exact: true }).click();
  const confirmedHttp = await confirmed; assert.equal(confirmedHttp.status(), 200); const receipt = await confirmedHttp.json(); assert.equal(receipt.error, null);
  assert.equal(modelWrites.length, 1); assert.equal(calls.length, 2);
  const saved = (await context(page, f)).plans.find(plan => plan.project_id === f.project);
  assert.equal(saved.owner_id, 'demo-pm-res'); assert.equal(saved.items[0].name, '匿名AI识别的原始工程事项\n完成标准：完成联合验收');
  assert.equal(saved.rich_text.fields['items.0.name'].ops[0].attributes.bold, true);
  assert.equal(saved.rich_text.fields['items.0.name'].ops.map(op => op.insert).join(''), saved.items[0].name);
  assert.deepEqual(errors, []);
});

test('实际HTTP与Edge：本人空事项从合并Excel提取月计划，明确加入本机草稿并可撤销，正式计划与周报不变', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planning-month-draft-browser-')), configPath = path.join(dir, 'provider.json');
  const key = 'sk-' + randomBytes(24).toString('hex');
  await writeFile(configPath, JSON.stringify({ enabled: true, api_key: key, model: 'deepseek-flash' }), { mode: 0o600 });
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await rm(dir, { recursive: true, force: true }); });
  const calls = [];
  let targetMonth;
  const f = await runtime(t, { planningAIConfigPath: configPath, planningAIFetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/responses'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ' + key); assert.equal(options.body.includes(key), false);
    const body = JSON.parse(options.body), facts = JSON.parse(body.input[0].content); calls.push(body);
    assert.equal(facts.items.length, 0, 'new monthly plans must not require pre-existing weekly items');
    assert.ok(facts.monthly_plans.some(plan => plan.month === targetMonth && plan.editable));
    const rows = facts.monthly_source_rows.filter(row => row.month === targetMonth);
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.source_row), [3, 4]);
    assert.ok(rows.some(row => row.name.includes('基准点移交'))); assert.ok(rows.some(row => row.name.includes('施工材料定样')));
    const attachmentText = body.input.at(-1).content.filter(part => part.type === 'input_text').map(part => part.text).join('\n');
    assert.match(attachmentText, /D4：施工材料定样完成/, 'self-closing empty cells must not consume the following real cell');
    const result = { reply: '已按表内月份提取两项景观计划，请核对后加入月计划草稿。',
      draft: { items: [], monthly_plan: { month: targetMonth, items: rows.map((row, index) => ({
        source_row_id: row.row_id, mod: '', name: '', due: '', progress: index ? '待封样' : '基准核查完成', sources: [row.source]
      })) } }, lookup: { kind: 'none', scope: 'current', start: '', end: '', keyword: '', project_name: '', limit: 10 } };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
  targetMonth = f.month;
  const businessSnapshot = async () => (await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r)) AS data")).rows[0].data;
  const before = await businessSnapshot(), browser = await chromium.launch({ channel: 'msedge', headless: true }), errors = [], writes = [];
  t.after(() => browser.close());
  const page = await login(browser, f, 'demo-pm-res', errors);
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const route = new URL(request.url()).pathname;
    if (['/api/monthly-plans/confirm', '/api/monthly-plans/withdraw', '/api/admin-plans/save', '/api/admin-plans/ai/confirm'].includes(route)) writes.push(route);
    if (route === '/api/db' && request.postDataJSON().operation !== 'select') writes.push(route);
  });
  await page.evaluate(project => App.fillProject(project), f.project);
  await expect(page.getByRole('button', { name: '本月 ' + f.month, exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(() => MonthlyPlans.aiContext().filter(plan => plan.month === MonthlyPlans.month()).map(plan => plan.items)), [[]]);
  await richEditor(page, 'co_what_0').fill('原协调事项草稿应保留');
  await expect(page.locator('#co_what_0')).toHaveValue('原协调事项草稿应保留');
  await page.getByRole('button', { name: '保存本机草稿', exact: true }).click();
  const nextMonth = new Date(f.month + '-01T00:00:00Z'); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  await page.getByRole('button', { name: '准备下月 ' + nextMonth.toISOString().slice(0,7), exact: true }).click();
  await expect(page.locator('.monthly-next-plan')).toBeVisible();
  await page.getByRole('button', { name: '本月 ' + f.month, exact: true }).click();
  const prefix = 'zh_draft_demo-pm-res_' + f.project + '_';
  const readDraft = () => page.evaluate(start => {
    const name = Object.keys(localStorage).find(key => key.startsWith(start));
    return name ? { key: name, value: JSON.parse(localStorage.getItem(name)) } : null;
  }, prefix);
  const original = await readDraft(); assert.ok(original); assert.equal(original.value.coordRows[0].what, '原协调事项草稿应保留');
  await page.getByRole('button', { name: 'AI 填报助手', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.planning-ai-memory-status')).not.toContainText('正在读取');
  const title = f.month.slice(0, 4) + '年' + Number(f.month.slice(5)) + '月份工作计划—项目部（景观）';
  const workbook = makeAdminPlanWorkbook([{ name: '景观', xml: adminPlanSheet([
    adminPlanRow(1, [adminPlanInline('A1', title)]),
    adminPlanRow(2, ['序号', '事项', '分项', '完成标准', '计划完成时间', '主责人', '当前工作进展与下步工作计划'].map((label, index) => adminPlanInline(String.fromCharCode(65 + index) + '2', label))),
    adminPlanRow(3, [adminPlanInline('A3', '1'), adminPlanInline('B3', '匿名东区域'), adminPlanInline('C3', '一标段'), adminPlanInline('D3', '原始基准点移交完成'), adminPlanInline('E3', f.month + '-28'), adminPlanInline('F3', '原表工作责任人'), adminPlanInline('G3', '基准核查完成')]),
    adminPlanRow(4, ['<c r="A4" s="0"/>', '<c r="B4" s="0"/>', '<c r="C4" s="0"/>', adminPlanInline('D4', '施工材料定样完成'), adminPlanInline('E4', f.month + '-27'), adminPlanInline('F4', '原表工作责任人'), adminPlanInline('G4', '待封样')])
  ], ['A1:H1', 'B3:B4', 'C3:C4']) }]);
  await page.locator('.planning-ai-picker').setInputFiles({ name: 'anonymous-landscape-month.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook });
  await page.locator('.planning-ai-input').fill('请将表内' + f.month + '月计划事项填入本月月计划草稿，保留原来的协调事项。');
  const pending = page.waitForResponse(response => response.url().endsWith('/api/planning-ai/chat'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200); const candidate = await response.json(); assert.equal(candidate.error, null);
  assert.equal(candidate.data.draft.items.length, 0); assert.equal(candidate.data.draft.monthly_plan.items.length, 2);
  assert.ok(candidate.data.draft.monthly_plan.items.every(item => item.due.startsWith(f.month)));
  await expect(page.locator('.planning-ai-preview-item')).toHaveCount(2);
  await expect(page.locator('.planning-ai-preview')).toContainText('施工材料定样完成');
  await expect(page.locator('.planning-ai-preview')).toContainText('保留已有输入');
  assert.deepEqual(await businessSnapshot(), before); assert.deepEqual((await readDraft()).value.bizItems, original.value.bizItems); assert.deepEqual(writes, []);
  const concurrentDraft = await page.evaluate(key => {
    const before = localStorage.getItem(key), changed = JSON.parse(before);
    changed.coordRows[0].what = '另一窗口刚修改的原草稿不可覆盖'; changed.ts += 1;
    const after = JSON.stringify(changed); localStorage.setItem(key, after); return {before, after};
  },original.key);
  await page.getByRole('button', { name: '确认加入' + f.month + '月计划草稿', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('其他窗口修改');
  assert.equal(await page.evaluate(key => localStorage.getItem(key),original.key),concurrentDraft.after,'a rejected monthly save must preserve another window\'s current weekly draft bytes');
  await expect(page.locator('.planning-ai-receipt')).toHaveCount(0); assert.deepEqual(await businessSnapshot(), before); assert.deepEqual(writes, []);
  await page.evaluate(({key,raw}) => localStorage.setItem(key,raw),{key:original.key,raw:concurrentDraft.before});
  const otherMonth = await page.evaluate(project => {
    const prefix = 'zh_monthly_plan_draft_v1_', target = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => ({key,scope:JSON.parse(decodeURIComponent(key.slice(prefix.length)))})).find(row => row.scope[0] === 'demo-pm-res' && row.scope[1] === project && row.scope[3] !== MonthlyPlans.month());
    if (!target) throw new Error('anonymous-next-month-draft-fixture-not-cached');
    const raw = JSON.stringify({v:1,scope:target.scope,items:[{source_id:'anonymous-other-window-next',mod:'下一月原输入',name:'另一窗口刚保存的下月计划',due:target.scope[3]+'-28'}],ts:'external-window'});
    localStorage.setItem(target.key,raw); return {key:target.key,raw};
  },f.project);
  await page.getByRole('button', { name: '确认加入' + f.month + '月计划草稿', exact: true }).click();
  await expect(page.locator('.planning-ai-receipt')).toContainText('已加入 2 项');
  await expect(page.locator('.planning-ai-receipt')).toContainText('尚未确认月计划或提交周报');
  const saved = await readDraft(); assert.equal(saved.value.bizItems.length, 2);
  assert.ok(saved.value.bizItems[0].name.includes('基准点移交')); assert.ok(saved.value.bizItems[1].name.includes('施工材料定样'));
  assert.equal(saved.value.bizItems[0].prog, '基准核查完成'); assert.equal(saved.value.bizItems[1].prog, '待封样');
  assert.equal(saved.value.coordRows[0].what, '原协调事项草稿应保留'); assert.equal(calls.length, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key),otherMonth.key),otherMonth.raw,'saving this month must preserve another window\'s next-month draft bytes');
  assert.deepEqual(await businessSnapshot(), before); assert.deepEqual(writes, []);
  await page.getByRole('button', { name: '撤销这次保存', exact: true }).click();
  await expect(page.locator('.planning-ai-receipt')).toContainText('已撤销这次月计划新增');
  const undone = await readDraft(); assert.deepEqual(undone.value.bizItems, original.value.bizItems); assert.equal(undone.value.coordRows[0].what, '原协调事项草稿应保留');
  assert.equal(await page.evaluate(key => localStorage.getItem(key),otherMonth.key),otherMonth.raw,'undoing this month must preserve another window\'s next-month draft bytes');
  await page.reload(); await expect(page.locator('.planning-mainnav')).toBeVisible();
  assert.equal(await page.evaluate(key => localStorage.getItem(key),otherMonth.key),otherMonth.raw,'reload and beforeunload autosave must preserve another window\'s next-month draft bytes');
  await page.evaluate(project => App.fillProject(project), f.project);
  await page.getByRole('button', { name: 'AI 填报助手', exact: true }).click();
  await expect(page.locator('.planning-ai-message.is-assistant')).toContainText(candidate.data.reply);
  await expect(page.getByRole('button', { name: '确认加入' + f.month + '月计划草稿', exact: true })).toHaveCount(0);
  assert.equal(calls.length, 0); assert.deepEqual(await businessSnapshot(), before); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
});
