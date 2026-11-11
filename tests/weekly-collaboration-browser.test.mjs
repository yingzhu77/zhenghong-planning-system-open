import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
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

async function login(browser, fixture, id, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const account = fixture.accounts.find(row => row.id === id);
  await page.goto(fixture.base);
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.planning-mainnav')).toBeVisible();
  return page;
}

function cell(page, key) {
  return page.locator('[data-collaboration-cell="' + key + '"] .ql-editor');
}

async function openWorkspace(page) {
  const entry = page.locator('[data-open-weekly-collaboration]');
  if (!await entry.isVisible()) {
    const project = page.locator('#planProject');
    await expect(project).toBeVisible();
    if (await project.inputValue() !== 'hf') await project.selectOption('hf');
  }
  await entry.click();
  await expect(page.locator('[data-weekly-collaboration]')).toBeVisible();
}

test('弘坊设计部两个实名会话合并同一单元格的中文改动并统一提交', { timeout: 120000 }, async t => {
  const fixture = await createFixture(t);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const errors = [];
  const [ops, lead, editor] = await Promise.all([
    login(browser, fixture, 'demo-ops', errors),
    login(browser, fixture, 'design-pilot-lead', errors),
    login(browser, fixture, 'design-pilot-editor', errors)
  ]);
  const headers = { Origin: fixture.base };
  const source = { source_id: 'pilot-source-one', mod: '图纸', name: '会签本周图纸及技术复核结果', due: fixture.month + '-20' };
  const planResponse = await lead.request.post(fixture.base + '/api/monthly-plans/confirm', {
    headers, data: { project_id: 'hf', line: '设计部', month: fixture.month, items: [source] }
  });
  assert.equal(planResponse.status(), 200, JSON.stringify((await planResponse.json()).error));
  const planId = (await planResponse.json()).data.id;

  await ops.getByRole('button', { name: '系统设置', exact: true }).click();
  await ops.getByRole('button', { name: '周报协同设置', exact: true }).click();
  await ops.locator('[data-weekly-collaboration-submitter]').selectOption('design-pilot-lead');
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

  const artifacts = '.local/weekly-collaboration-browser';
  await mkdir(artifacts, { recursive: true });
  await lead.locator('[data-weekly-collaboration]').screenshot({ path: artifacts + '/desktop.png' });
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
  const audit = (await fixture.admin.query("SELECT DISTINCT actor_id FROM app_private.hongfang_weekly_operations WHERE kind='edit' ORDER BY actor_id")).rows;
  assert.deepEqual(audit.map(row=>row.actor_id),['design-pilot-editor','design-pilot-lead']);
  const overview = lead.locator('.professional-overview[data-report-id]');
  await expect(overview).toContainText('本专业总览');
  await expect(overview).toContainText('建筑复核');
  await expect(overview).toContainText('机电复核');
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
  await fixture.admin.query("DELETE FROM public.project_members WHERE project_id='hf' AND user_id='design-pilot-editor'");
  const revoked = await editor.request.post(fixture.base + '/api/weekly-collaboration/open',{headers,data:{week:fixture.week}});
  assert.equal(revoked.status(),403);
  assert.deepEqual(errors, []);
});
