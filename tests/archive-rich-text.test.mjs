import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sources = ['rich-text.js', 'reporter-archive.js', 'admin-archive.js'].map(name =>
  fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const delta = (text, attributes) => ({ ops: [{ insert: text, ...(attributes ? { attributes } : {}) }] });
const rich = fields => ({ v: 1, fields });
function fixture(fields = { fitout: '交付标准' }) {
  const window = {};
  for (const source of sources) vm.runInNewContext(source, { window });
  const calls = [];
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const context = {
    identity: 'test-operator', pid: 'p1', tab: 'standards', editable: true,
    projects: [{ id: 'p1', name: '匿名项目甲' }, { id: 'p2', name: '匿名项目乙' }], fields, phases: [], drawings: [], milestones: [],
    helpers: { esc, richItem: (row, key) => window.ZHRichText.field(row, key), sd: value => value || '—' },
    saveFields: async (patch, pid) => {
      calls.push({ patch: plain(patch), pid });
      context.fields = window.ZHAdminArchive.mergeFields(context.fields, patch);
    },
    onChanged: () => window.ZHAdminArchive.render(context)
  };
  const api = window.ZHAdminArchive;
  api.render(context);
  return { api, window, context, calls };
}

test('archive standard editor binds selection formatting without changing identifier and numeric fields', () => {
  const { api, context } = fixture();
  assert.match(api.render(context), /<textarea id="aa_fitout"[^>]*data-rich data-shared-rich-editor[^>]*data-aa-field="fitout"/);
  assert.equal(typeof api.binding('aa_fitout').get, 'function');
  assert.equal(api.binding('aa_city'), null);
  assert.doesNotMatch(api.render({ ...context, tab: 'basic' }), /data-rich/);
  assert.equal(api.binding('aa_fitout'), null);
});

test('format-only standard changes save a narrow format patch and survive read-only rendering', async () => {
  const { api, window, context, calls } = fixture({ fitout: '交付标准', unknown: { retained: true } });
  const doc = delta('交付标准', { bold: true, color: '#d81e06' });
  api.binding('aa_fitout').set(doc);
  await api.saveFields();
  assert.deepEqual(calls, [{ pid: 'p1', patch: { rich_text: rich({ fitout: doc }) } }]);
  assert.deepEqual(plain(api.binding('aa_fitout').get()), doc);
  assert.deepEqual(plain(context.fields.unknown), { retained: true });
  const html = window.ZHReporterArchive.render({ ...context, editable: false });
  assert.match(html, /<span class="rt-red"><strong>交付标准<\/strong><\/span>/);
  assert.doesNotMatch(html, /data-rich/);
});

test('standard text and format drafts stay with their project and category and reset on identity changes', () => {
  const { api, context } = fixture();
  const first = api.binding('aa_fitout');
  const doc = delta('已修改\n第二行', { bold: true });
  first.set(doc);
  api.render({ ...context, pid: 'p2', fields: { fitout: '乙项目标准' } });
  first.set(delta('跨项目迟到编辑', { color: '#d81e06' }));
  assert.deepEqual(plain(api.binding('aa_fitout').get()), delta('乙项目标准'));
  api.render({ ...context, tab: 'basic' });
  first.set(delta('跨分类迟到编辑', { color: '#d81e06' }));
  api.render(context);
  assert.deepEqual(plain(api.binding('aa_fitout').get()), doc);
  api.render({ ...context, identity: 'other-operator' });
  first.set(delta('旧会话不应污染', { bold: true }));
  assert.deepEqual(plain(api.binding('aa_fitout').get()), delta('交付标准'));
  api.render({ ...context, editable: false, identity: 'other-operator' });
  assert.equal(api.binding('aa_fitout'), null);
});

test('saving standards merges with latest unrelated fields and format paths without mutating either input', () => {
  const { api } = fixture();
  const server = {
    fitout: '旧标准', city: '最新城市', future: { preserved: true },
    rich_text: { v: 1, extension: { keep: true }, fields: { fitout: delta('旧标准', { bold: true }), 'future.note': delta('独立内容', { color: '#d81e06' }) } }
  };
  const patch = { fitout: '新标准', rich_text: rich({ fitout: delta('新标准', { color: '#d81e06' }) }) };
  const before = plain(server), patchBefore = plain(patch), merged = plain(api.mergeFields(server, patch));
  assert.deepEqual(merged, { ...server, fitout: '新标准', rich_text: { ...server.rich_text, fields: { ...server.rich_text.fields, fitout: patch.rich_text.fields.fitout } } });
  assert.deepEqual(server, before);
  assert.deepEqual(patch, patchBefore);
  const textOnly = plain(api.mergeFields(server, { fitout: '新标准' }));
  assert.equal('fitout' in textOnly.rich_text.fields, false);
  assert.deepEqual(textOnly.rich_text.fields['future.note'], server.rich_text.fields['future.note']);
});

test('text edits replace stale format drafts and clearing format remains explicit', async () => {
  const sourceDoc = delta('交付标准', { bold: true, color: '#d81e06' });
  const { api, calls } = fixture({ fitout: '交付标准', rich_text: rich({ fitout: sourceDoc }) });
  api.binding('aa_fitout').set(delta('交付标准'));
  await api.saveFields();
  assert.deepEqual(calls[0].patch, { rich_text: rich({ fitout: delta('交付标准') }) });
  api.binding('aa_fitout').set(delta('第一稿', { bold: true }));
  api.field('fitout', '第二稿');
  await api.saveFields();
  assert.deepEqual(calls[1].patch, { fitout: '第二稿', rich_text: rich({ fitout: delta('第二稿') }) });
});

test('editing a legacy standard preserves its formatting when the editor emits plain companion text', async () => {
  const { api, calls, context, window } = fixture({ fitout: '**既有标准**' });
  const doc = api.binding('aa_fitout').get();
  api.binding('aa_fitout').set(doc);
  await api.saveFields();
  assert.deepEqual(calls[0].patch, { fitout: '既有标准', rich_text: rich({ fitout: delta('既有标准', { bold: true }) }) });
  assert.match(window.ZHReporterArchive.render(context), /<strong>既有标准<\/strong>/);
});

test('save failures keep standard drafts and busy saves reject late formatting changes', async () => {
  const { api, context, calls } = fixture();
  const draft = delta('待保存标准', { bold: true });
  api.binding('aa_fitout').set(draft);
  let rejectSave;
  context.saveFields = () => new Promise((resolve, reject) => { rejectSave = reject; });
  const pending = api.saveFields();
  await Promise.resolve();
  api.binding('aa_fitout').set(delta('保存中误改', { color: '#d81e06' }));
  assert.deepEqual(plain(api.binding('aa_fitout').get()), draft);
  rejectSave(new Error('隔离保存故障'));
  await pending;
  assert.match(api.render(context), /隔离保存故障/);
  assert.deepEqual(plain(api.binding('aa_fitout').get()), draft);
  context.saveFields = async patch => { calls.push(plain(patch)); };
  await api.saveFields();
  assert.deepEqual(calls[0], { fitout: '待保存标准', rich_text: rich({ fitout: draft }) });
});

test('read-only standards render legacy formatting and matching Delta safely while unrelated fields stay plain', () => {
  const { window, context } = fixture();
  const render = fields => window.ZHReporterArchive.render({ ...context, fields });
  assert.match(render({ fitout: '**旧标准**\n==重点==' }), /<strong>旧标准<\/strong><br><span class="rt-red">重点<\/span>/);
  const text = '<img src=x onerror=bad>\n第二行';
  const html = render({ fitout: text, rich_text: rich({ fitout: delta(text, { bold: true, color: '#d81e06', link: 'javascript:bad' }) }) });
  assert.match(html, /<strong>&lt;img src=x onerror=bad&gt;<br>第二行<\/strong>/);
  assert.doesNotMatch(html, /<img src=x|javascript:/);
  assert.match(render({ fitout: '现有标准', rich_text: rich({ fitout: delta('过期文字', { bold: true }) }) }), /<td>现有标准<\/td>/);
  const basic = window.ZHReporterArchive.render({ ...context, tab: 'basic', fields: { city: '**城市**' } });
  assert.match(basic, /<td>\*\*城市\*\*<\/td>/);
});
