import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const artifacts = process.env.FORMATTING_ARTIFACT_DIR || path.join(os.tmpdir(), 'planning-formatting-artifacts');
async function resources(page, extra = []) {
  for (const name of ['vendor/quill/quill.core.css', 'styles.css', 'planning-ui.css', 'report3-layout.css', 'selection-format.css'])
    await page.addStyleTag({content: fs.readFileSync(new URL(name, web), 'utf8')});
  for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', ...extra])
    await page.addScriptTag({content: fs.readFileSync(new URL(name, web), 'utf8')});
}
async function planner(page) {
  await resources(page, ['planning-windows.js', 'monthly-plans.js']);
  await page.evaluate(() => {
    const rich = window.ZHRichText;
    window.S = {uid: 'anonymous', session: {}, profile: {role: 'pm', biz_line: '机电工程'}, pmProject: 'p1', pmLine: '机电工程',
      pmPeriod: '2026-10-19', projects: [{id: 'p1', project_type: 'com'}], monthlyPlans: [], bizItems: [{source_id: 'weekly', name: '本周草稿'}]};
    window.calls = []; window.pending = false;
    const render = () => {
      document.getElementById('root').innerHTML = '<div class="planning-shell"><main style="padding:20px">' + window.MonthlyPlans.plannerHtml() + '</main></div>';
      window.ZHRichEditor.mount(document.getElementById('root'), window.MonthlyPlans.binding);
    };
    window.MonthlyPlans.configure({S: window.S, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      render, flush: () => window.ZHRichEditor.flush(), toast: () => {}, richCopy: rich.copy, richItem: rich.field,
      richCollect: row => rich.collect(JSON.parse(JSON.stringify(row))), request: async (url, body) => {
        window.calls.push(JSON.parse(JSON.stringify(body)));
        if (window.pending) return new Promise(resolve => { window.finishRequest = resolve; });
        return {data: {id: 'next-plan', project_id: body.project_id, line: body.line, confirmed_by: window.S.uid, plan_month: body.month + '-01', items: body.items, rich_text: body.rich_text}};
      }});
    window.MonthlyPlans.select('next');
  });
}

test('next-month item selection and right click preserve formatting through row removal, draft reload, failure and confirmation', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  fs.mkdirSync(artifacts, {recursive: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://formatting.test/**', route => route.fulfill({contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>'}));
    await page.goto('http://formatting.test/'); await planner(page);
    await page.getByRole('button', {name: '添加事项'}).click();
    let editor = page.locator('[data-rich-editor-for="monthly_next_name_1"] .ql-editor');
    await editor.fill('  下月验收事项  '); await editor.press('Control+A'); await editor.click({button: 'right'});
    const tools = page.getByRole('toolbar', {name: '所选文字格式'});
    await expect(tools).toBeVisible();
    await tools.getByRole('button', {name: '加粗', exact: true}).click();
    await tools.getByRole('button', {name: '标红', exact: true}).click();
    await expect(editor.locator('strong')).toContainText('下月验收事项');
    await expect(editor.locator('[style*="color"]')).toContainText('下月验收事项');
    let moduleEditor=page.locator('[data-rich-editor-for="monthly_next_mod_1"] .ql-editor');
    await moduleEditor.fill('  验收模块  ');await moduleEditor.press('Control+A');
    await tools.getByRole('button',{name:'加粗',exact:true}).click();
    await tools.getByRole('button',{name:'标红',exact:true}).click();
    await expect(moduleEditor.locator('strong')).toContainText('验收模块');
    await page.getByRole('button', {name: '删除', exact: true}).first().click();
    editor = page.locator('[data-rich-editor-for="monthly_next_name_0"] .ql-editor');
    await expect(editor.locator('strong')).toContainText('下月验收事项');
    await expect(page.locator('[data-rich-editor-for="monthly_next_mod_0"] strong')).toContainText('验收模块');
    await page.evaluate(() => window.MonthlyPlans.saveDraft());
    await page.reload(); await planner(page);
    editor = page.locator('[data-rich-editor-for="monthly_next_name_0"] .ql-editor');
    await expect(editor.locator('strong')).toContainText('下月验收事项');
    await expect(editor.locator('[style*="color"]')).toContainText('下月验收事项');
    await expect(page.locator('[data-rich-editor-for="monthly_next_mod_0"] strong')).toContainText('验收模块');
    await editor.click(); await editor.press('Control+A'); await editor.click({button: 'right'});
    await page.screenshot({path: path.join(artifacts, 'next-month-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await editor.scrollIntoViewIfNeeded(); await editor.click(); await editor.press('Control+A'); await editor.click({button: 'right'});
    await expect(tools).toBeVisible();
    const bounds = await tools.boundingBox(); assert.ok(bounds.x >= 7 && bounds.x + bounds.width <= 383);
    await page.screenshot({path: path.join(artifacts, 'next-month-mobile.png'), fullPage: true});
    await page.evaluate(() => { window.pending = true; });
    await page.getByRole('button', {name: '确认下月计划'}).click();
    await expect(page.locator('[data-rich-editor-for="monthly_next_name_0"] .ql-editor')).toHaveAttribute('contenteditable', 'false');
    await expect(tools).toBeHidden();
    await page.evaluate(() => { window.pending = false; window.finishRequest({error: {message: '模拟失败'}}); });
    await expect(page.getByRole('button', {name: '确认下月计划'})).toBeEnabled();
    await expect(page.locator('[data-rich-editor-for="monthly_next_name_0"] strong')).toContainText('下月验收事项');
    await page.getByRole('button', {name: '确认下月计划'}).click();
    await expect(page.getByText('已确认，固定列不可修改')).toBeVisible();
    await expect(page.locator('td[data-label="事项"] strong')).toHaveText('下月验收事项');
    await expect(page.locator('td[data-label="模块"] strong')).toHaveText('验收模块');
    const saved = await page.evaluate(() => ({calls: window.calls, weekly: window.S.bizItems, plan: window.S.monthlyPlans[0]}));
    assert.equal(saved.calls.length, 2); assert.equal(saved.calls[1].items[0].name, '下月验收事项');
    assert.deepEqual(saved.calls[1].rich_text.fields['items.0.name'], {ops: [{insert: '下月验收事项', attributes: {bold: true, color: '#d81e06'}}]});
    assert.deepEqual(saved.calls[1].rich_text.fields['items.0.mod'],{ops:[{insert:'验收模块',attributes:{bold:true,color:'#d81e06'}}]});
    assert.equal(saved.calls[0].items[0].source_id, saved.calls[1].items[0].source_id);
    assert.deepEqual(saved.weekly, [{source_id: 'weekly', name: '本周草稿'}]); assert.deepEqual(errors, []);
  } finally {await browser.close();}
});

test('right click works in manager editors while disabled and readonly fields keep their original values', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="planning-shell manager-shell"><textarea data-rich id="manager">管理正文</textarea><fieldset disabled><textarea data-rich id="disabled">保存中原文</textarea></fieldset><textarea data-rich readonly id="readonly">只读原文</textarea></div>');
    await resources(page);
    await page.evaluate(() => {
      window.docs = {}; window.ZHRichEditor.mount(document.body, id => ({get: () => window.docs[id], set: doc => {window.docs[id] = doc;}}));
      document.addEventListener('contextmenu', event => {window.suppressed = event.defaultPrevented;});
    });
    const editor = page.locator('[data-rich-editor-for="manager"] .ql-editor');
    await editor.click(); await editor.press('Control+A'); await editor.click({button: 'right'});
    assert.equal(await page.evaluate(() => window.suppressed), true);
    await page.getByRole('toolbar', {name: '所选文字格式'}).getByRole('button', {name: '加粗', exact: true}).click();
    await expect(editor.locator('strong')).toHaveText('管理正文');
    for (const id of ['disabled', 'readonly']) {
      await expect(page.locator('[data-rich-editor-for="' + id + '"] .ql-editor')).toHaveAttribute('contenteditable', 'false');
      await expect(page.locator('[data-rich-editor-for="' + id + '"] .rich-toolbar button:enabled')).toHaveCount(0);
    }
    const state = await page.evaluate(() => {
      for (const id of ['disabled', 'readonly']) window.Quill.find(document.querySelector('[data-rich-editor-for="' + id + '"] .rich-surface')).insertText(0, '过期修改', 'user');
      window.ZHRichEditor.flush(); return {docs: window.docs, disabled: document.getElementById('disabled').value, readonly: document.getElementById('readonly').value};
    });
    assert.equal(state.disabled, '保存中原文'); assert.equal(state.readonly, '只读原文');
    assert.equal(state.docs.disabled, undefined); assert.equal(state.docs.readonly, undefined);
  } finally {await browser.close();}
});
