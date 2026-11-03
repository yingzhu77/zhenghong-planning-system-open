import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const source = fs.readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);
const artifacts = process.env.FORMATTING_ENTRYPOINT_ARTIFACT_DIR || path.join(os.tmpdir(), 'planning-formatting-entrypoints');
fs.mkdirSync(artifacts, { recursive: true });
const delta = text => ({ ops: [{ insert: text, attributes: { bold: true, color: '#d81e06' } }] });

async function fixture(browser, modules) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://formatting-entrypoints.test'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root" style="padding:24px;max-width:1200px;margin:auto"></div><div id="toast"></div></body></html>' })
    : route.abort('blockedbyclient'));
  await page.goto('http://formatting-entrypoints.test/');
  await page.evaluate(() => {
    window.WorkBuddyCloud = { createWorkBuddyCloud: () => ({ auth: {}, database: { from() { throw new Error('isolated formatting check cannot access a database'); } } }) };
  });
  for (const name of ['vendor/quill/quill.core.css', 'styles.css', 'planning-ui.css', 'selection-format.css', 'completion-review.css', 'reporter-archive.css', 'admin-archive.css'])
    await page.addStyleTag({ content: fs.readFileSync(new URL(name, web), 'utf8') });
  for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', ...modules])
    await page.addScriptTag({ content: fs.readFileSync(new URL(name, web), 'utf8') });
  await page.addScriptTag({ content: source.slice(0, boundary) + '\nwindow.formattingAudit={S,richBinding,richCopy,richCollect,richItem,esc};\n})();' });
  await page.evaluate(() => {
    const S = window.formattingAudit.S;
    Object.assign(S, { uid: 'anonymous-owner', session: {}, profile: { role: 'pm', status: 'approved' }, pmProject: 'p1', pmLine: '综合',
      pmPeriod: '2026-10-19', view: 'coordination', projects: [{ id: 'p1', name: '匿名测试项目', project_type: 'res' }], coordinationTasks: [], completions: [] });
    window.delegatedIds = [];
    window.mountFormatting = () => window.ZHRichEditor.mount(document.getElementById('root'), id => {
      window.delegatedIds.push(id); return window.formattingAudit.richBinding(id);
    });
    document.addEventListener('contextmenu', event => { window.contextSuppressed = event.defaultPrevented; });
  });
  return { page, errors };
}

async function formatSelection(page, id, text) {
  const editor = page.locator('[data-rich-editor-for="' + id + '"] .ql-editor');
  await editor.fill(text); await editor.press('Control+A'); await editor.click({ button: 'right' });
  const toolbar = page.getByRole('toolbar', { name: '所选文字格式' });
  await expect(toolbar).toBeVisible();
  assert.equal(await page.evaluate(() => window.contextSuppressed), true);
  await toolbar.getByRole('button', { name: '加粗', exact: true }).click();
  await toolbar.getByRole('button', { name: '标红', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText(text.trim());
  await expect(editor.locator('[style*="color"]')).toContainText(text.trim());
  await expect(page.locator('#' + id)).toHaveValue(text);
  assert.ok(await page.evaluate(target => window.delegatedIds.includes(target), id));
  return editor;
}

test('actual coordination form delegates rich binding and preserves selection format in submitted source and read-only row', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const { page, errors } = await fixture(browser, ['coordination-workbench.js']);
    await page.evaluate(() => {
      const h = window.formattingAudit, S = h.S;
      window.coordinationCalls = [];
      const render = () => {
        document.getElementById('root').innerHTML = '<div class="planning-shell"><main>' + window.CoordinationWorkbench.render('p1') + '</main></div>';
        window.mountFormatting();
      };
      window.CoordinationWorkbench.configure({ S, esc: h.esc, richCopy: h.richCopy, richCollect: h.richCollect, richItem: h.richItem,
        flush: () => window.ZHRichEditor.flush(), render, toast() {}, request: async (url, body) => {
          window.coordinationCalls.push({ url, body: JSON.parse(JSON.stringify(body)) });
          return { data: { ...body, author_id: S.uid, owner_name: '匿名承办人', source_key: 'coord:p1:' + body.id } };
        } });
      window.CoordinationWorkbench.seed('p1', [], [{ user_id: 'anonymous-worker', role: 'pm', name: '匿名承办人' }]);
      render();
    });
    await page.locator('#coordination_owner_id_p1').selectOption('anonymous-worker');
    await page.locator('#coordination_due_p1').fill('2026-10-30');
    await expect(page.locator('[data-rich-editor-for="coordination_due_p1"], [data-rich-editor-for="coordination_owner_id_p1"]')).toHaveCount(0);
    await formatSelection(page, 'coordination_what_p1', '  请核验材料并反馈整改结果  ');
    await page.screenshot({ path: path.join(artifacts, 'coordination-form.png'), fullPage: true });
    await page.getByRole('button', { name: '发起协调', exact: true }).click();
    await expect(page.locator('.coordination-workbench tbody .rt-red strong')).toHaveText('请核验材料并反馈整改结果');
    const calls = await page.evaluate(() => window.coordinationCalls);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/coordination-tasks/create');
    assert.equal(calls[0].body.what, '请核验材料并反馈整改结果'); assert.equal(calls[0].body.due, '2026-10-30');
    assert.equal(calls[0].body.owner_id, 'anonymous-worker');
    assert.deepEqual(calls[0].body.rich_text, { v: 1, fields: { what: delta('请核验材料并反馈整改结果') } });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('completion, extension and reviewer dialogs outside planning shell format through actual dispatcher and submit matching Delta', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const { page, errors } = await fixture(browser, ['completion-review.js']);
    await page.evaluate(async () => {
      const h = window.formattingAudit, S = h.S;
      S.view = 'form'; window.completionCalls = [];
      window.previewSource = { source_key: 'leader:p1:anonymous-source', source_version: 'anonymous-version', project_id: 'p1',
        kind: 'leader', title: '领导安排', what: '核验现场整改', due: '2026-10-30' };
      const render = () => {
        document.getElementById('root').innerHTML = '<div class="planning-shell"><main><h2>匿名本期填报</h2></main></div>' + window.CompletionReview.overlayHtml();
        window.mountFormatting();
      };
      window.completionOptions = { S, esc: h.esc, richCopy: h.richCopy, richCollect: h.richCollect, richItem: h.richItem,
        render, flush: () => window.ZHRichEditor.flush(), saveDraft() {}, toast() {}, afterSaved: async () => true, loadData: async () => true,
        request: async (url, body) => {
          window.completionCalls.push({ url, body: JSON.parse(JSON.stringify(body)) });
          if (url.endsWith('/preview')) return { data: window.previewSource };
          if (url.endsWith('/request')) return { data: { ...body, id: 'anonymous-' + (body.request_type || 'completion'),
            revision: 1, status: 'pending', owner_id: 'anonymous-owner', owner_name: '匿名提报人', project_id: 'p1', kind: 'leader',
            source_snapshot: window.previewSource, review_note: '' } };
          const row = S.completions.find(item => item.id === body.id);
          return { data: { ...row, revision: row.revision + 1, status: 'approved', review_note: body.note,
            rich_text: { v: 1, fields: { ...row.rich_text.fields, ...body.rich_text.fields } } } };
        } };
      window.CompletionReview.configure(window.completionOptions);
      await window.CompletionReview.open(window.previewSource.source_key);
    });
    const note = page.locator('[data-rich-editor-for="completion_note"] .ql-editor');
    assert.equal(await note.evaluate(element => !!element.closest('.planning-shell')), false);
    await page.locator('#completion_date').fill('2026-10-23');
    await expect(page.locator('[data-rich-editor-for="completion_date"], [data-rich-editor-for="completion_request_type"]')).toHaveCount(0);
    await formatSelection(page, 'completion_note', '  已核验整改并完成验收  ');
    await page.getByRole('button', { name: '提交完成申请', exact: true }).click();
    await expect(page.locator('.completion-detail .rt-red strong')).toHaveText('已核验整改并完成验收');
    const completion = await page.evaluate(() => ({ call: window.completionCalls.find(item => item.url.endsWith('/request')), row: window.formattingAudit.S.completions[0] }));
    assert.equal(completion.call.body.completion_date, '2026-10-23');
    assert.deepEqual(completion.call.body.rich_text, { v: 1, fields: { completion_note: delta('已核验整改并完成验收') } });

    await page.evaluate(async () => {
      window.CompletionReview.close(); window.formattingAudit.S.completions = [];
      await window.CompletionReview.open(window.previewSource.source_key);
    });
    await page.locator('#completion_request_type').selectOption('extension');
    await page.locator('#completion_requested_due').fill('2026-11-05');
    await formatSelection(page, 'completion_note', '材料待到场，申请调整安排');
    await page.getByRole('button', { name: '提交延期申请', exact: true }).click();
    await expect(page.locator('.completion-detail .rt-red strong')).toHaveText('材料待到场，申请调整安排');
    const extension = await page.evaluate(() => window.completionCalls.filter(item => item.url.endsWith('/request')).at(-1).body);
    assert.equal(extension.request_type, 'extension'); assert.equal(extension.requested_due, '2026-11-05');
    assert.deepEqual(extension.rich_text, { v: 1, fields: { completion_note: delta('材料待到场，申请调整安排') } });

    await page.evaluate(async saved => {
      const S = window.formattingAudit.S;
      S.uid = 'anonymous-operator'; S.session = {}; S.profile = { role: 'ops', status: 'approved' };
      S.completions = [{ ...saved, can_review: true }];
      window.CompletionReview.configure(window.completionOptions);
      await window.CompletionReview.open(window.previewSource.source_key, { owner_id: 'anonymous-owner' });
    }, completion.row);
    const reviewEditor = await formatSelection(page, 'completion_review_note', '已复核，可以销项');
    assert.equal(await reviewEditor.evaluate(element => !!element.closest('.planning-shell')), false);
    await page.screenshot({ path: path.join(artifacts, 'completion-review-dialog.png'), fullPage: true });
    await page.getByRole('button', { name: '审核通过', exact: true }).click();
    await expect(page.locator('.completion-detail .rt-red strong')).toHaveText(['已核验整改并完成验收', '已复核，可以销项']);
    const reviewed = await page.evaluate(() => ({ call: window.completionCalls.find(item => item.url.endsWith('/review')), row: window.formattingAudit.S.completions[0] }));
    assert.equal(reviewed.call.body.note, '已复核，可以销项');
    assert.deepEqual(reviewed.call.body.rich_text, { v: 1, fields: { review_note: delta('已复核，可以销项') } });
    assert.deepEqual(reviewed.row.rich_text.fields.completion_note, completion.row.rich_text.fields.completion_note);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('actual archive construction standard editor saves formatting with latest unknown fields and keeps scalar fields plain', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const { page, errors } = await fixture(browser, ['reporter-archive.js', 'admin-archive.js']);
    await page.evaluate(() => {
      const h = window.formattingAudit, S = h.S;
      S.profile = { role: 'ops', status: 'approved' }; S.view = 'master'; window.archiveCalls = [];
      const render = () => {
        document.getElementById('root').innerHTML = '<div class="planning-shell manager-shell"><main>' + window.ZHAdminArchive.render(window.archiveContext) + '</main></div>';
        window.mountFormatting();
      };
      window.archiveContext = { identity: 'anonymous-operator', pid: 'p1', tab: 'standards', editable: true,
        projects: S.projects, fields: { fitout: '原交付标准', future: { keep: true } }, phases: [], drawings: [], milestones: [],
        helpers: { esc: h.esc, richItem: h.richItem, sd: value => value || '—' }, onChanged: render,
        saveFields: async (patch, pid) => {
          window.archiveCalls.push({ patch: JSON.parse(JSON.stringify(patch)), pid });
          const latest = { ...window.archiveContext.fields, city: '并行更新的城市', rich_text: { v: 1, fields: { 'future.note': { ops: [{ insert: '保留的其他格式', attributes: { bold: true } }] } } } };
          window.archiveContext.fields = window.ZHAdminArchive.mergeFields(latest, patch);
        } };
      window.renderArchive = render; render();
    });
    await formatSelection(page, 'aa_fitout', '住宅交付标准：完成公共区域精装');
    await page.screenshot({ path: path.join(artifacts, 'archive-construction-standard.png'), fullPage: true });
    const saveButton = page.getByRole('button', { name: '保存当前分类', exact: true });
    const editorBounds = await page.locator('[data-rich-editor-for="aa_fitout"] .ql-editor').boundingBox(), buttonBounds = await saveButton.boundingBox();
    assert.ok(buttonBounds.y >= editorBounds.y + editorBounds.height, 'construction standard editor must not cover its save button');
    await saveButton.click();
    await expect(page.getByRole('status')).toHaveText('当前分类已保存。');
    await page.locator('.admin-archive-saved summary').click();
    await expect(page.locator('.admin-archive-saved .rt-red strong')).toHaveText('住宅交付标准：完成公共区域精装');
    const saved = await page.evaluate(() => ({ calls: window.archiveCalls, fields: window.archiveContext.fields }));
    assert.equal(saved.calls.length, 1); assert.equal(saved.calls[0].pid, 'p1');
    assert.deepEqual(saved.calls[0].patch, { fitout: '住宅交付标准：完成公共区域精装', rich_text: { v: 1, fields: { fitout: delta('住宅交付标准：完成公共区域精装') } } });
    assert.equal(saved.fields.city, '并行更新的城市'); assert.deepEqual(saved.fields.future, { keep: true });
    assert.deepEqual(saved.fields.rich_text.fields['future.note'], { ops: [{ insert: '保留的其他格式', attributes: { bold: true } }] });
    await page.evaluate(() => { window.archiveContext.tab = 'basic'; window.renderArchive(); });
    await expect(page.locator('.admin-archive-editor [data-rich], .admin-archive-editor .rich-input')).toHaveCount(0);
    await expect(page.locator('[data-aa-field="open_date"]')).toHaveCount(1);
    await page.evaluate(() => { window.archiveContext.tab = 'plan'; window.renderArchive(); });
    await expect(page.locator('[data-aa-field="current_version"][data-rich]')).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
