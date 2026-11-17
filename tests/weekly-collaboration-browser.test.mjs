import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import * as Y from 'yjs';
import { createApp } from '../server/app.mjs';
import { reportWeekStart } from '../server/database.mjs';
import { hashPassword } from '../server/password.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

async function createFixture(t) {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'planning-weekly-collaboration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(uploadDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(uploadDir).startsWith('planning-weekly-collaboration-'));
    await rm(uploadDir, { recursive: true, force: true });
  });
  const database = await initializedDatabase();
  const admin = testPool(database, null);
  const pool = testPool(database);
  const accounts = await seedDemo(admin);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES ('hf','弘坊 · 匿名试点','com')");
  for (const [id, name] of [['design-pilot-lead', '匿名设计提报人'], ['design-pilot-editor', '匿名设计协作者']]) {
    const email = id + '@example.invalid';
    const password = 'Zh-' + randomBytes(18).toString('base64url') + '8a';
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES ($1,$2,$3)', [id, email, await hashPassword(password)]);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES ($1,$2,'pm','approved','hf','设计部')", [id, name]);
    await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES ($1,'hf','pm')", [id]);
    accounts.push({ id, name, email, password });
  }
  const app = createApp({ pool, config: {
    authCodeSecret: randomBytes(32).toString('hex'), publicOrigin: '', trustProxy: false,
    cookieSecure: false, cookieName: 'weekly_collaboration_browser', sessionHours: 2, readOnly: false, uploadDir,
    mailer: { configured: false }
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await database.close();
  });
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const week = reportWeekStart(today);
  return { admin, accounts, week, month: week.slice(0, 7), base: 'http://127.0.0.1:' + server.address().port };
}

async function login(browser, fixture, id, errors, requests) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  const account = fixture.accounts.find(row => row.id === id);
  await page.goto(fixture.base);
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.planning-mainnav')).toBeVisible({timeout:15000});
  return page;
}

function cell(page, key) {
  return page.locator('[data-collaboration-cell="' + key + '"] .ql-editor');
}

async function openWorkspace(page, projectId = 'hf') {
  const project = page.locator('#planProject');
  if (await project.isVisible() && await project.inputValue() !== projectId) await project.selectOption(projectId);
  await page.getByRole('button',{name:'刷新数据',exact:true}).click();
  await expect(page.locator('[data-weekly-collaboration]')).toBeVisible();
}

async function expectSharedReportLayout(page) {
  const form = page.locator('.report3-compact-form');
  await expect(form.locator('.plan-section-head h3')).toHaveText([
    '一、本周核心节点计划', '二、当月计划填报', '三、需要协调事项',
    '四、待处理事项清单', '五、附件资料'
  ]);
  await expect(form.locator('.report-attachment-upload')).toBeVisible();
  await expect(form.locator('#report-attachment-upload')).toBeEnabled();
}

test('弘坊设计部两个实名会话合并同一单元格的中文改动并统一提交', { timeout: 120000 }, async t => {
  const fixture = await createFixture(t);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const errors = [];
  const requests = [];
  const [ops, lead, editor] = await Promise.all([
    login(browser, fixture, 'demo-ops', errors, requests),
    login(browser, fixture, 'design-pilot-lead', errors, requests),
    login(browser, fixture, 'design-pilot-editor', errors, requests)
  ]);
  assert.equal(requests.some(resource=>/\/assets\/[^/]+\/(?:vendor\/)?weekly-collaboration\.(?:css|js)$/.test(resource)),false);
  assert.equal(requests.some(resource=>resource.endsWith('/api/weekly-collaboration/open')),false);
  const headers = { Origin: fixture.base };
  const source = { source_id: 'pilot-source-one', mod: '图纸', name: '会签本周图纸及技术复核结果', due: fixture.month + '-20' };
  const planResponse = await lead.request.post(fixture.base + '/api/monthly-plans/confirm', {
    headers, data: { project_id: 'hf', line: '设计部', month: fixture.month, items: [source] }
  });
  assert.equal(planResponse.status(), 200, JSON.stringify((await planResponse.json()).error));
  const planId = (await planResponse.json()).data.id;

  await ops.getByRole('button', { name: '系统设置', exact: true }).click();
  await ops.getByRole('button', { name: '周报协同设置', exact: true }).click();
  await ops.locator('[data-weekly-collaboration-project]').selectOption('hf');
  await ops.locator('[data-weekly-collaboration-profession]').selectOption('设计部');
  await ops.locator('[data-weekly-collaboration-submitter]').selectOption('design-pilot-lead');
  await ops.getByRole('checkbox',{name:'匿名设计协作者'}).check();
  const settings = ops.waitForResponse(response => response.url().endsWith('/api/weekly-collaboration/settings') &&
    response.request().postDataJSON()?.submitter_id === 'design-pilot-lead');
  await ops.locator('[data-weekly-collaboration-designate]').click();
  assert.equal((await settings).status(), 200);
  const editorCannotDesignate = await editor.request.post(fixture.base + '/api/weekly-collaboration/settings', {
    headers, data: {week:fixture.week, submitter_id:'design-pilot-editor'}
  });
  assert.equal(editorCannotDesignate.status(),403);
  const normalSubmit = await lead.request.post(fixture.base + '/api/db', {
    headers, data:{table:'reports',operation:'upsert',onConflict:'project_id,period,line',
      values:{project_id:'hf',line:'设计部',period:fixture.week,change_text:'校验普通填报入口'}}
  });
  assert.equal(normalSubmit.status(),409,JSON.stringify((await normalSubmit.json()).error));

  const uploaded = lead.waitForResponse(response => response.url().includes('/api/report-attachments/upload?'));
  await lead.locator('#report-attachment-upload').setInputFiles({
    name: '协同验收附件.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  });
  const attachment = await uploaded;
  assert.equal(attachment.status(), 200, JSON.stringify((await attachment.json()).error));
  const attachmentId = (await attachment.json()).data.id;
  await expect(lead.getByText('协同验收附件.png', {exact:true})).toBeVisible();
  await Promise.all([openWorkspace(lead), openWorkspace(editor)]);
  const leadCell = cell(lead, 'pilot-source-one:prog');
  const editorCell = cell(editor, 'pilot-source-one:prog');
  await expect(leadCell).toBeEditable();
  await expect(editorCell).toBeEditable();
  await expectSharedReportLayout(lead);
  await expect(lead.locator('[data-collaboration-presence]')).toContainText('匿名设计协作者', { timeout: 18000 });
  await expect(editor.locator('[data-collaboration-publish]')).not.toBeVisible();

  await editorCell.click();
  await editor.keyboard.press('Control+b');
  await editor.keyboard.insertText('已完成会签');
  await editor.keyboard.press('Control+b');
  await expect(leadCell).toContainText('已完成会签', { timeout: 18000 });
  await expect(leadCell.locator('strong')).toContainText('已完成会签');
  const status = page => page.locator('[data-collaboration-status]');
  await expect(status(editor)).toHaveAttribute('data-state', 'saved');

  // Each session edits the same shared starting state while disconnected.
  // Reconnecting must merge both inserts and keep the earlier live edit.
  await Promise.all([lead.context().setOffline(true), editor.context().setOffline(true)]);
  await Promise.all([leadCell.press('End'), editorCell.press('End')]);
  const ime = await lead.context().newCDPSession(lead);
  await Promise.all([
    ime.send('Input.imeSetComposition', { text: '机电', selectionStart: 2, selectionEnd: 2 }),
    editor.keyboard.insertText('、建筑复核')
  ]);
  await ime.send('Input.insertText', { text: '、机电复核' });
  await Promise.all([lead.context().setOffline(false), editor.context().setOffline(false)]);
  for (const textEditor of [leadCell, editorCell]) {
    await expect(textEditor).toContainText('、机电复核', { timeout: 20000 });
    await expect(textEditor).toContainText('、建筑复核', { timeout: 20000 });
    await expect(textEditor).toContainText('已完成会签');
  }
  assert.equal(await leadCell.innerText(), await editorCell.innerText());
  await expect(status(lead)).toHaveAttribute('data-state', 'saved', { timeout: 20000 });
  await expect(status(editor)).toHaveAttribute('data-state', 'saved', { timeout: 20000 });

  const leadPanel=lead.locator('[data-weekly-collaboration]'),editorPanel=editor.locator('[data-weekly-collaboration]');
  await leadPanel.getByRole('button',{name:/准备下月/}).click();
  await editorPanel.getByRole('button',{name:/准备下月/}).click();
  await editorPanel.getByRole('button',{name:'＋ 增加事项'}).click();
  await editorPanel.getByLabel('事项',{exact:true}).fill('组员准备下月图纸');
  await editorPanel.getByRole('button',{name:'添加事项'}).click();
  await expect(leadPanel.locator('[data-next-month-table]')).toContainText('组员准备下月图纸',{timeout:18000});
  await expect(editorPanel.getByRole('button',{name:'确认下月计划',exact:true})).toHaveCount(0);
  await leadPanel.getByRole('button',{name:/^本月 /}).click();
  await editorPanel.getByRole('button',{name:/^本月 /}).click();
  await expect(leadCell).toContainText('建筑复核');
  await editorPanel.locator('.collaboration-blocker summary').click();
  await cell(editor,'pilot-source-one:blocker').fill('待核对接口尺寸');
  await expect(cell(lead,'pilot-source-one:blocker')).toHaveText('待核对接口尺寸',{timeout:18000});
  await expect(status(editor)).toHaveAttribute('data-state','saved');

  const artifacts = '.local/weekly-collaboration-browser';
  await mkdir(artifacts, { recursive: true });
  await lead.locator('[data-weekly-collaboration]').screenshot({ path: artifacts + '/desktop.png' });
  await lead.screenshot({ path: artifacts + '/current-report-desktop.png', fullPage: true });
  await editor.setViewportSize({ width: 390, height: 844 });
  const editorMain = editor.locator('main');
  assert.ok(await editorMain.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await editor.locator('[data-weekly-collaboration]').screenshot({ path: artifacts + '/mobile.png' });

  const unauthorized = await editor.request.post(fixture.base + '/api/weekly-collaboration/publish', {
    headers, data: { week: fixture.week, plan_id:planId, revision: 0, operation_id: randomUUID() }
  });
  assert.equal(unauthorized.status(), 403);
  const stale = await lead.request.post(fixture.base + '/api/weekly-collaboration/publish', {
    headers, data: {week:fixture.week, plan_id:planId, revision:0, operation_id:randomUUID()}
  });
  assert.equal(stale.status(),409);
  const oldPlan = await editor.request.post(fixture.base + '/api/weekly-collaboration/change', {
    headers, data: {week:fixture.week,plan_id:randomUUID(),cell:'pilot-source-one:prog',update:'AAA=',operation_id:randomUUID()}
  });
  assert.equal(oldPlan.status(),409);
  const publishing = lead.waitForResponse(response => response.url().endsWith('/api/weekly-collaboration/publish'));
  await lead.locator('[data-collaboration-publish]').click();
  const published = await publishing;
  assert.equal(published.status(), 200, JSON.stringify((await published.json()).error));
  const replay = await lead.request.post(fixture.base + '/api/weekly-collaboration/publish', {
    headers, data:published.request().postDataJSON()
  });
  assert.equal(replay.status(),200);
  assert.equal((await replay.json()).data.report.id,(await published.json()).data.report.id);
  const stored = (await fixture.admin.query("SELECT author_id,biz FROM public.reports WHERE project_id='hf' AND line='设计部'")).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].author_id, 'design-pilot-lead');
  assert.deepEqual(stored[0].biz.attachments, [attachmentId]);
  assert.equal(stored[0].biz.items[0].source_id, source.source_id);
  for (const phrase of ['已完成会签', '建筑复核', '机电复核']) assert.ok(stored[0].biz.items[0].prog.includes(phrase));
  const audit = (await fixture.admin.query("SELECT DISTINCT actor_id FROM app_private.weekly_collaboration_operations WHERE project_id='hf' AND line='设计部' AND kind='edit' ORDER BY actor_id")).rows;
  assert.deepEqual(audit.map(row=>row.actor_id),['design-pilot-editor','design-pilot-lead']);
  const overview = lead.locator('.professional-overview[data-report-id]');
  await expect(overview).toContainText('本期专业汇总');
  await expect(overview).toContainText('建筑复核');
  await expect(overview).toContainText('机电复核');
  await expect(overview).toContainText('待核对接口尺寸');
  await expect(overview).not.toContainText('组员准备下月图纸');
  await expect(overview).toContainText('协同验收附件.png');
  const moduleHeaderLines = await overview.getByRole('columnheader',{name:'模块或类别'}).evaluate(node => {
    const text = document.createRange();
    text.selectNodeContents(node);
    return new Set(Array.from(text.getClientRects(),rect=>Math.round(rect.top))).size;
  });
  assert.equal(moduleHeaderLines,1);
  await overview.screenshot({ path: artifacts + '/submitted-overview.png' });
  await editor.locator('[data-collaboration-result]').click();
  await expect(editor.locator('.professional-overview[data-report-id]')).toContainText('机电复核');
  await editor.getByRole('button',{name:'本期填报',exact:true}).first().click();
  await editor.getByRole('button',{name:'本期专业汇总',exact:true}).click();
  await expect(editor.locator('.professional-overview[data-report-id]')).toContainText('机电复核');

  for (const page of [lead, editor]) {
    await page.getByRole('button',{name:'返回本期填报',exact:true}).click();
    await expect(page.locator('[data-collaboration-result]')).toBeVisible();
  }
  const withdraw = lead.getByRole('button',{name:'撤回周报并修改',exact:true});
  await expect(withdraw).toBeEnabled();
  await expect(editor.getByRole('button',{name:'撤回周报并修改',exact:true})).toHaveCount(0);
  const withdrawRequests = () => requests.filter(url=>url.endsWith('/api/weekly-collaboration/withdraw')).length;
  const attempts = withdrawRequests();
  lead.once('dialog',dialog=>dialog.dismiss());
  await withdraw.click();
  assert.equal(withdrawRequests(), attempts);
  await expect(lead.locator('[data-collaboration-result]')).toBeVisible();
  await leadPanel.screenshot({ path: artifacts + '/withdraw-report-entry.png' });

  lead.once('dialog',dialog=>dialog.accept());
  const withdrawing = lead.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/withdraw'));
  await withdraw.click();
  const withdrawn = await withdrawing;
  assert.equal(withdrawn.status(),200,JSON.stringify((await withdrawn.json()).error));
  await expect(lead.locator('[data-collaboration-result]')).toBeHidden();
  await expect(editor.locator('[data-collaboration-result]')).toBeHidden({timeout:18000});
  await expect(leadCell).toBeEditable();
  await expect(editorCell).toBeEditable();
  await expect(leadCell.locator('strong')).toContainText('已完成会签');
  await expect(cell(lead,'pilot-source-one:blocker')).toHaveText('待核对接口尺寸');
  const selectedAttachment = lead.getByRole('checkbox',{name:'将协同验收附件.png选入本期填报'});
  await expect(selectedAttachment).toBeChecked();
  await selectedAttachment.click();
  await expect(lead.locator('.report-attachment-library summary')).toContainText('1 件');
  await lead.reload();
  await expect(leadCell).toBeEditable();
  await lead.locator('.report-attachment-library summary').click();
  await expect(selectedAttachment).not.toBeChecked();
  await selectedAttachment.click();
  await expect(selectedAttachment).toBeChecked();

  await editorCell.press('End');
  await editor.keyboard.insertText('、撤回后复核');
  await expect(leadCell).toContainText('撤回后复核',{timeout:18000});
  await expect(editor.locator('[data-collaboration-publish]')).toBeHidden();
  const publishingAgain = lead.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/publish'));
  await lead.locator('[data-collaboration-publish]').click();
  const publishedAgain = await publishingAgain;
  assert.equal(publishedAgain.status(),200,JSON.stringify((await publishedAgain.json()).error));
  const republishedReport = (await publishedAgain.json()).data.report;
  assert.deepEqual(republishedReport.biz.attachments,[attachmentId]);
  assert.ok(republishedReport.biz.items[0].prog.includes('撤回后复核'));
  await expect(overview).toContainText('撤回后复核');
  await expect(editor.locator('[data-collaboration-result]')).toBeVisible({timeout:18000});
  await expect(editorPanel).toContainText('撤回后复核');

  await fixture.admin.query("DELETE FROM public.project_members WHERE project_id='hf' AND user_id='design-pilot-editor'");
  const revoked = await editor.request.post(fixture.base + '/api/weekly-collaboration/open',{headers,data:{week:fixture.week}});
  assert.equal(revoked.status(),403);
  assert.deepEqual(errors, []);
});

test('已确认月计划下两人可补充本周事项，负责人提交后同步到原月计划', {timeout: 90000}, async t => {
  const fixture = await createFixture(t);
  const receiver = 'design-pilot-coordination-receiver';
  await fixture.admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)',
    [receiver,receiver+'@example.invalid','unused-anonymous-fixture']);
  await fixture.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'匿名协调承办人','pm','approved','hf','建筑结构设计')",[receiver]);
  await fixture.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'hf','pm')",[receiver]);
  const followup = '协助核对匿名现场图纸交接';
  const delegatedFollowup = '补充匿名图纸复核意见';
  // An earlier ISO reporting week can be submitted after this week begins.
  const [origin] = (await fixture.admin.query(
    `INSERT INTO public.reports(project_id,line,period,author_id,author_name,coord_items,submitted_at)
     VALUES('hf','设计部',($1::date-14)::text,'design-pilot-lead','匿名设计提报人',$2::jsonb,
       ($1::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
     RETURNING id::text AS id`,
    [fixture.week, JSON.stringify([
      {source_id:'browser-coord',who_id:'design-pilot-editor',who:'匿名设计协作者',what:followup,by:fixture.week},
      {source_id:'browser-delegated',who_id:'design-pilot-editor',who:'匿名设计协作者',what:delegatedFollowup,by:fixture.week}
    ])]
  )).rows;
  const followupKey = 'coord:hf:' + origin.id + ':coord:browser-coord';
  const delegatedKey = 'coord:hf:' + origin.id + ':coord:browser-delegated';
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const errors=[], requests=[];
  const [ops,lead,editor] = await Promise.all([
    login(browser,fixture,'demo-ops',errors,requests),
    login(browser,fixture,'design-pilot-lead',errors,requests),
    login(browser,fixture,'design-pilot-editor',errors,requests)
  ]);
  const scope={project_id:'hf',line:'设计部',week:fixture.week};
  const headers={Origin:fixture.base};
  const original={source_id:'approved-structure-item',mod:'图纸',name:'原定图纸会签',due:fixture.month+'-20'};
  const planRequest={project_id:scope.project_id,line:scope.line,month:fixture.month};
  const confirmed=await lead.request.post(fixture.base+'/api/monthly-plans/confirm',{
    headers,data:{...planRequest,items:[original]}
  });
  assert.equal(confirmed.status(),200,JSON.stringify((await confirmed.json()).error));
  const planId=(await confirmed.json()).data.id;
  const settings=await ops.request.post(fixture.base+'/api/weekly-collaboration/settings',{
    headers,data:{...scope,submitter_id:'design-pilot-lead',member_ids:['design-pilot-editor']}
  });
  assert.equal(settings.status(),200,JSON.stringify((await settings.json()).error));
  await Promise.all([openWorkspace(lead),openWorkspace(editor)]);
  await expectSharedReportLayout(editor);
  const outgoing = '请协助复核匿名现场图纸';
  const draftCoordination = editor.locator('[data-weekly-coordination]');
  const firstRecipient = draftCoordination.locator('#wc_who_0');
  await expect(firstRecipient).toBeEnabled();
  await firstRecipient.selectOption(receiver);
  await draftCoordination.locator('.ql-editor').first().fill(outgoing);
  await draftCoordination.locator('#wc_by_0').fill(fixture.week);
  const coordinationSaved = editor.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/coordination'));
  await draftCoordination.getByRole('button',{name:'保存协调事项',exact:true}).click();
  const savedCoordination = await coordinationSaved;
  assert.equal(savedCoordination.status(),200,JSON.stringify((await savedCoordination.json()).error));
  const savedRow = (await savedCoordination.json()).data.rows[0];
  await expect(lead.locator('[data-weekly-coordination] .ql-editor').first()).toContainText('请协助复核匿名现场图纸',{timeout:18000});
  const followupRow = (page,key=followupKey) => page.locator('[data-followup-key="' + key + '"]');
  await expect(followupRow(editor)).toContainText(followup);
  await expect(followupRow(lead)).toContainText('承办人 匿名设计协作者');
  const feedback = '已核对图纸并向对方反馈';
  await followupRow(editor).locator('.ql-editor').fill(feedback);
  const feedbackSaved = editor.waitForResponse(response => response.url().endsWith('/api/weekly-collaboration/followups'));
  await editor.getByRole('button', {name:'保存本期反馈', exact:true}).click();
  const feedbackResponse = await feedbackSaved;
  assert.equal(feedbackResponse.status(),200,JSON.stringify((await feedbackResponse.json()).error));
  await editor.reload();
  await openWorkspace(editor);
  await expect(followupRow(editor).locator('.ql-editor')).toHaveText(feedback);
  await expect(followupRow(lead).locator('.ql-editor')).toHaveText(feedback,{timeout:18000});
  const leadPanel=lead.locator('[data-weekly-collaboration]');
  const editorPanel=editor.locator('[data-weekly-collaboration]');
  const add=editorPanel.getByRole('button',{name:'＋ 新增本周事项',exact:true});
  await expect(add).toBeEnabled();
  await expect(leadPanel.getByRole('row').filter({hasText:original.name}).getByRole('button',{name:'修改事项',exact:true})).toHaveCount(0);
  await expect(editorPanel.locator('[data-collaboration-publish]')).toBeHidden();

  await add.click();
  await expect(editorPanel.getByText('负责人提交周报后同步至本月计划。',{exact:false})).toBeVisible();
  await editorPanel.getByLabel('模块',{exact:true}).fill('施工配合');
  await editorPanel.getByLabel('事项',{exact:true}).fill('临时补充现场图纸复核');
  await editorPanel.getByLabel('完成时间',{exact:true}).fill(fixture.week);
  const saved=editor.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/items'));
  await editorPanel.getByRole('button',{name:'添加事项',exact:true}).click();
  const response=await saved;
  assert.equal(response.status(),200,JSON.stringify((await response.json()).error));
  const draft=(await response.json()).data;
  assert.equal(draft.plan.weekly_supplement_ids.length,1);
  const newId=draft.plan.weekly_supplement_ids[0];
  const newRow=leadPanel.getByRole('row').filter({hasText:'临时补充现场图纸复核'});
  await expect(newRow.getByText('本周新增',{exact:true})).toBeVisible({timeout:18000});
  await expect(newRow.getByRole('button',{name:'修改事项',exact:true})).toBeEnabled();
  const before=await lead.request.post(fixture.base+'/api/monthly-plans/list',{headers,data:planRequest});
  assert.equal(before.status(),200);
  const [originalPlan]=(await before.json()).data;
  assert.deepEqual(originalPlan.items.map(item=>item.source_id),[original.source_id]);

  const updated=lead.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/items'));
  await newRow.getByRole('button',{name:'修改事项',exact:true}).click();
  await leadPanel.getByLabel('事项',{exact:true}).fill('临时补充现场图纸复核及会签');
  await leadPanel.getByRole('button',{name:'保存事项',exact:true}).click();
  assert.equal((await updated).status(),200);
  await expect(editorPanel.getByRole('row').filter({hasText:'临时补充现场图纸复核及会签'})).toBeVisible({timeout:18000});
  await cell(editor,newId+':prog').fill('组员已完成复核');
  await expect(cell(lead,newId+':prog')).toHaveText('组员已完成复核',{timeout:18000});
  const publish=leadPanel.getByRole('button',{name:'提交专业周报',exact:true});
  await expect(publish).toBeEnabled({timeout:18000});
  await publish.click();
  await expect(leadPanel).toContainText('填写 1 项当周进展');
  await cell(lead,original.source_id+':prog').fill('暂无进展，等待接口资料');
  await expect(publish).toBeEnabled({timeout:18000});
  await publish.click();
  await expect(followupRow(lead,delegatedKey).locator('.ql-editor')).toBeFocused();
  const delegatedFeedback='已代组员核对，待项目方会签';
  await followupRow(lead,delegatedKey).locator('.ql-editor').fill(delegatedFeedback);
  const artifacts='.local/weekly-collaboration-browser';
  await mkdir(artifacts,{recursive:true});
  await leadPanel.screenshot({path:artifacts+'/weekly-supplement-desktop.png'});
  await lead.locator('[data-weekly-coordination]').screenshot({path:artifacts+'/weekly-coordination-desktop.png'});
  await lead.locator('.reporter-followups').screenshot({path:artifacts+'/weekly-followups-delegation-desktop.png'});
  lead.once('dialog',async dialog=>{
    assert.match(dialog.message(),/同步至本月计划/);
    await dialog.accept();
  });
  const formal=lead.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/publish'));
  await publish.click();
  const published=await formal;
  assert.equal(published.status(),200,JSON.stringify((await published.json()).error));
  const report=(await published.json()).data.report;
  const supplement=report.biz.items.find(item=>item.source_id===newId);
  const official=new Map(report.biz.followups.map(row=>[row.source_key,row]));
  assert.equal(official.size,2);
  assert.equal(official.get(followupKey).owner_name,'匿名设计协作者');
  assert.equal(official.get(followupKey).progress,feedback);
  assert.equal(official.get(followupKey).filled_by,'design-pilot-editor');
  assert.equal(official.get(delegatedKey).owner_id,'design-pilot-editor');
  assert.equal(official.get(delegatedKey).progress,delegatedFeedback);
  assert.equal(official.get(delegatedKey).filled_by,'design-pilot-lead');
  assert.deepEqual(report.coord_items.map(row=>[row.source_id,row.who_id,row.what,row.by]),[
    [savedRow.source_id,receiver,outgoing,fixture.week]
  ]);
  assert.equal(supplement.prog,'组员已完成复核');
  assert.equal(report.biz.monthly_plan_id,planId);
  const after=await lead.request.post(fixture.base+'/api/monthly-plans/list',{headers,data:planRequest});
  assert.equal(after.status(),200);
  const [synced]=(await after.json()).data;
  assert.equal(synced.id,planId);
  assert.deepEqual(synced.items[0],originalPlan.items[0]);
  assert.deepEqual(synced.items.slice(1).map(item=>[item.source_id,item.name,item.due]),[
    [newId,'临时补充现场图纸复核及会签',fixture.week]
  ]);
  const lateFollowup='较早收到但正式周报尚未反馈的匿名事项';
  const [lateReport]=(await fixture.admin.query(
    `INSERT INTO public.reports(project_id,line,period,author_id,author_name,coord_items)
     VALUES('hf','建筑结构设计',($1::date-7)::text,$2,'匿名提报人',$3::jsonb) RETURNING id::text AS id`,
    [fixture.week,receiver,JSON.stringify([{source_id:'late-review',who_id:'design-pilot-editor',what:lateFollowup,by:fixture.week}])]
  )).rows;
  const lateKey='coord:hf:'+lateReport.id+':coord:late-review';
  await expect(editor.locator('[data-collaboration-result]')).toBeVisible({timeout:18000});
  await editor.getByRole('button',{name:'更新待办事项',exact:true}).click();
  const pendingReview=followupRow(editor,lateKey);
  await expect(pendingReview).toContainText(lateFollowup);
  await expect(pendingReview).toContainText('待补填 · 未纳入已提交周报');
  await expect(pendingReview.locator('.ql-editor')).toHaveCount(0);
  await expect(followupRow(editor,delegatedKey)).toContainText('由 匿名设计提报人 代填');
  const [unchanged]=(await fixture.admin.query('SELECT biz FROM public.reports WHERE id=$1',[report.id])).rows;
  assert.deepEqual(unchanged.biz.followups,report.biz.followups);
  assert.deepEqual(errors,[]);
});

test('独立住宅保留同周旧综合报告，仍可选择本人专业协同填报并查看正式总览', {timeout: 60000}, async t => {
  const fixture = await createFixture(t);
  const projectId='demo-res';
  const legacyReport=(await fixture.admin.query("UPDATE public.reports SET period=$1 WHERE project_id=$2 AND line='综合' RETURNING *",[fixture.week,projectId])).rows[0];
  assert.ok(legacyReport);
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(() => browser.close());
  const errors = [], requests = [];
  const [ops, housing] = await Promise.all([
    login(browser,fixture,'demo-ops',errors,requests),
    login(browser,fixture,'demo-pm-res',errors,requests)
  ]);
  const headers = {Origin:fixture.base};
  const line = '工程';
  await ops.getByRole('button',{name:'系统设置',exact:true}).click();
  await ops.getByRole('button',{name:'周报协同设置',exact:true}).click();
  await ops.locator('[data-weekly-collaboration-project]').selectOption(projectId);
  await ops.locator('[data-weekly-collaboration-profession]').selectOption(line);
  await ops.locator('[data-weekly-collaboration-submitter]').selectOption('demo-pm-res');
  const designation = ops.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/settings') &&
    response.request().postDataJSON()?.submitter_id==='demo-pm-res');
  await ops.locator('[data-weekly-collaboration-designate]').click();
  const configured = await designation;
  assert.equal(configured.status(),200,JSON.stringify((await configured.json()).error));
  assert.equal(configured.request().postDataJSON().project_id,projectId);
  assert.equal(configured.request().postDataJSON().line,line);
  const profession=housing.locator('#planResLine');
  await expect(profession).toHaveValue('综合');
  await profession.selectOption(line);
  await openWorkspace(housing,projectId);
  const workspace = housing.locator('[data-weekly-collaboration]');
  await expect(housing.locator('.planning-mainnav')).not.toContainText('协同填报');
  await expect(housing.locator('[aria-label="本期填报信息"]')).toBeVisible();
  await expectSharedReportLayout(housing);
  await expect(workspace.getByRole('columnheader')).toHaveText(['模块','事项','完成时间','当周进展']);
  await workspace.getByRole('button',{name:'＋ 增加事项'}).click();
  await workspace.getByLabel('模块',{exact:true}).fill('住宅工程');
  await workspace.getByLabel('事项',{exact:true}).fill('匿名住宅楼层复核');
  await workspace.getByRole('button',{name:'添加事项'}).click();
  await expect(workspace).toContainText('匿名住宅楼层复核');
  const progress=workspace.locator('[data-collaboration-cell$=":prog"] .ql-editor');
  await expect(progress).toBeEditable();
  const writing=housing.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/change'));
  await progress.fill('住宅工程匿名进展');
  const changed=await writing;
  assert.equal(changed.status(),200,JSON.stringify((await changed.json()).error));
  await expect(workspace.locator('[data-collaboration-status]')).toHaveAttribute('data-state','saved');
  await housing.reload();
  await housing.locator('#planResLine').selectOption(line);
  await expect(progress).toHaveText('住宅工程匿名进展');
  await workspace.getByRole('button',{name:/准备下月/}).click();
  await workspace.getByRole('button',{name:'＋ 增加事项'}).click();
  await workspace.getByLabel('模块',{exact:true}).fill('下月工程');
  await workspace.getByLabel('事项',{exact:true}).fill('下月匿名任务');
  await workspace.getByRole('button',{name:'添加事项'}).click();
  await expect(workspace.locator('[data-next-month-table]')).toContainText('下月匿名任务');
  await expect(progress).not.toBeVisible();
  await workspace.getByRole('button',{name:/^本月 /}).click();
  await expect(progress).toHaveText('住宅工程匿名进展');
  await expect(workspace.locator('[data-collaboration-publish]')).toBeEnabled();
  await housing.evaluate(()=>window.scrollTo(0,0));
  await housing.screenshot({path:'.local/weekly-collaboration-browser/shared-month-desktop.png',fullPage:true});
  await housing.setViewportSize({width:390,height:844});
  await expect.poll(()=>housing.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await housing.evaluate(()=>window.scrollTo(0,0));
  await housing.screenshot({path:'.local/weekly-collaboration-browser/shared-month-mobile.png',fullPage:true});
  await housing.setViewportSize({width:1440,height:1000});
  housing.once('dialog',dialog=>dialog.accept());
  await workspace.getByRole('button',{name:'确认本月计划',exact:true}).click();
  await expect(workspace.locator('[data-month-plan-status]')).toContainText('月计划已确认');
  await expect(progress).toHaveText('住宅工程匿名进展');
  housing.once('dialog',dialog=>dialog.accept());
  await workspace.getByRole('button',{name:'撤回确认并修改',exact:true}).click();
  await expect(workspace.getByRole('button',{name:'＋ 增加事项'})).toBeVisible();
  await expect(progress).toHaveText('住宅工程匿名进展');
  await workspace.locator('[data-collaboration-publish]').click();
  const overview=housing.locator('.professional-overview[data-report-id]');
  await expect(overview).toContainText('本期专业汇总');
  await expect(overview).toContainText('住宅工程匿名进展');
  await expect(overview).not.toContainText('下月匿名任务');
  assert.deepEqual((await fixture.admin.query('SELECT * FROM public.reports WHERE id=$1',[legacyReport.id])).rows[0],legacyReport);
  assert.deepEqual(errors,[]);
});

test('已配置的下周可提前从填报页进入并续编，未加入的项目专业只显示提示', {timeout: 90000}, async t => {
  const fixture = await createFixture(t);
  await fixture.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES ('design-pilot-editor','demo-com','pm')");
  const next = new Date(fixture.week+'T00:00:00Z');
  next.setUTCDate(next.getUTCDate()+7);
  const week=next.toISOString().slice(0,10), period={week,project_id:'hf',line:'设计部',report_scope_id:null};
  const headers={Origin:fixture.base};
  const browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const errors=[],requests=[];
  const [ops,lead,editor,outsider]=await Promise.all([
    login(browser,fixture,'demo-ops',errors,requests),
    login(browser,fixture,'design-pilot-lead',errors,requests),
    login(browser,fixture,'design-pilot-editor',errors,requests),
    login(browser,fixture,'demo-pm-com',errors,requests)
  ]);
  const configured=await ops.request.post(fixture.base+'/api/weekly-collaboration/settings',{headers,data:{
    ...period,submitter_id:'design-pilot-lead',member_ids:['design-pilot-editor']
  }});
  assert.equal(configured.status(),200);
  const sourceId=randomUUID(), label='上周同步的匿名事项';
  const seed=await lead.request.post(fixture.base+'/api/weekly-collaboration/month-items',{headers,data:{
    ...period,month:week.slice(0,7),operation_id:sourceId,revision:0,action:'add',item:{mod:'设计',name:label,due:''}
  }});
  assert.equal(seed.status(),200);
  const doc=new Y.Doc();
  doc.getText('content').insert(0,'上周已填写的进展');
  const seedProgress=await lead.request.post(fixture.base+'/api/weekly-collaboration/change',{headers,data:{
    ...period,plan_id:(await seed.json()).data.plan.id,cell:sourceId+':prog',operation_id:randomUUID(),
    update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  }});
  doc.destroy();
  assert.equal(seedProgress.status(),200);
  const periodPicker=editor.locator('#pmPeriod');
  const current=await periodPicker.inputValue();
  assert.equal(reportWeekStart(current),fixture.week);
  await expect(periodPicker.locator('option').filter({hasText:'已开放协同'})).toHaveCount(0);
  await expect(outsider.locator('#pmPeriod option').filter({hasText:'已开放协同'})).toHaveCount(0);
  const projectPicker=editor.locator('#planProject');
  await projectPicker.selectOption('demo-com');
  await editor.getByRole('button',{name:'刷新数据',exact:true}).click();
  const early=periodPicker.locator('option').filter({hasText:'已开放协同'});
  await expect(early).toHaveCount(1);
  const option=await early.getAttribute('value');
  assert.notEqual(option,current);
  await periodPicker.selectOption(option);
  await expect(projectPicker).toHaveValue('hf');
  const workspace=editor.locator('[data-weekly-collaboration]');
  await expect(workspace).toContainText(label);
  const progress=cell(editor,sourceId+':prog');
  await expect(progress).toBeEditable();
  await expect(progress).toHaveText('上周已填写的进展');
  await expect(workspace.getByRole('button',{name:'提交专业周报',exact:true})).toBeHidden();
  const saved=editor.waitForResponse(response=>response.url().endsWith('/api/weekly-collaboration/change'));
  await progress.fill('提前更新的匿名进展');
  assert.equal((await saved).status(),200);
  await editor.getByRole('button',{name:'刷新数据',exact:true}).click();
  await expect(progress).toHaveText('提前更新的匿名进展');
  await projectPicker.selectOption('demo-com');
  await expect(editor.getByText('该项目专业尚未开放这周的协同填报，请切换项目、专业或报告周期。')).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await editor.evaluate(()=>window.App.submitReport());
  const savedReports=await fixture.admin.query('SELECT id FROM public.reports WHERE period=$1 AND author_id=$2',[option,'design-pilot-editor']);
  assert.equal(savedReports.rows.length,0);
  await periodPicker.selectOption(current);
  await expect(workspace).toHaveCount(0);
  assert.deepEqual(errors,[]);
});
