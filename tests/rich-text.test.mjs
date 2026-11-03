import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRichText, prepareRichText } from '../server/rich-text.mjs';
import { createApp } from '../server/app.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';

const delta = (text, attributes) => ({ ops: [{ insert: text, ...(attributes ? { attributes } : {}) }] });
const map = (fields) => ({ v: 1, fields });
const redBold = { bold: true, color: '#d81e06' };

test('format schema accepts only matching text, bold and one red, including multiline and literal HTML text', () => {
  const text = '第一行\n第二行<script>只是文字</script>';
  const rich = map({ change_text: delta(text, redBold) });
  assert.deepEqual(validateRichText('reports', rich, { change_text: text }), rich);
  const reject = (value, row = { change_text: text }) => assert.throws(() => validateRichText('reports', value, row), (error) => error.status === 400 && error.code === 'invalid_rich_text');
  reject(map({ change_text: delta('与正文不同') }));
  reject(map({ change_text: { ops: [{ insert: { image: 'https://invalid.example/a' } }] } }));
  for (const attrs of [{ link: 'javascript:alert(1)' }, { color: 'red' }, { color: '#00ff00' }, { bold: false }, { style: 'position:fixed' }]) reject(map({ change_text: delta(text, attrs) }));
  for (const path of ['author_name', 'project_id', 'node_items.0.plan', 'biz.items.0.mod', '__proto__.name', 'biz.items.01.name']) reject(map({ [path]: delta(text) }));
  reject({ v: 2, fields: {} });
  reject({ v: 1, fields: {}, html: '<b>bad</b>' });
  reject(map({ change_text: { ops: [{ insert: text, retain: 2 }] } }));
  assert.deepEqual(validateRichText('reports', {}, {}), {});
  assert.deepEqual(validateRichText('reports', map({ change_text: { ops: [] } }), { change_text: '' }), map({ change_text: { ops: [] } }));
  assert.throws(() => validateRichText('milestones', map({ name: delta('节点') }), { name: '节点' }));
});

test('legacy partial edits invalidate only changed roots and never rewrite legacy marker strings', () => {
  const existing = { change_text: '**原文**', coord_items: [{ what: '协调' }], biz: { items: [{ name: '第一项' }] },
    rich_text: map({ change_text: delta('**原文**', redBold), 'coord_items.0.what': delta('协调', redBold), 'biz.items.0.name': delta('第一项', redBold) }) };
  const edited = prepareRichText('reports', { biz: { items: [] } }, existing);
  assert.deepEqual(Object.keys(edited.rich_text.fields).sort(), ['change_text', 'coord_items.0.what']);
  assert.equal(existing.change_text, '**原文**');
  assert.deepEqual(prepareRichText('reports', { status: '正常' }, existing), { status: '正常' });
  assert.deepEqual(prepareRichText('reports', { change_text: '新文字', rich_text: {} }, existing).rich_text, {});
  assert.throws(() => prepareRichText('reports', { change_text: '新文字', rich_text: existing.rich_text }, existing), /文字与格式/);
});

test('additive migration is repeatable and preserves source records, history, membership and UID bindings', async (t) => {
  const db = await initializedDatabase(); t.after(() => db.close());
  await seedDemo(testPool(db, null));
  const tables = ['reports', 'leader_reviews', 'leader_notes', 'milestones', 'profiles', 'project_members'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await db.query(`SELECT to_jsonb(t) - 'rich_text' AS data FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows.map((row) => row.data)
  ])));
  const before = await snapshot();
  for (const table of tables.slice(0, 4)) await db.exec(`ALTER TABLE public.${table} DROP COLUMN rich_text`);
  const sql = await readFile(new URL('../db/005-rich-text.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM reports')).rows[0].n, 2);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM milestones WHERE rich_text='{}'::jsonb")).rows[0].n, 4);
});

test('HTTP writes persist format maps and report revisions under unchanged RLS and author/module rules', async (t) => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const accounts = await seedDemo(testPool(db, null));
  const app = createApp({ pool: testPool(db), config: { authCodeSecret: 'rich-text-isolated-test' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  const call = async (route, body, user = 'demo-pm-res') => {
    const response = await fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookies[user] ? { cookie: cookies[user] } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const query = (body, user) => call('/api/db', body, user);
  for (const account of accounts) {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
    assert.equal(response.status, 200);
    cookies[account.id] = response.headers.get('set-cookie').split(';')[0];
  }
  const source = { project_id: 'demo-res', period: '富文本隔离验收周期', line: '综合', change_text: '完成验收\n周五反馈',
    coord_items: [{ who: '演示运营', what: '协调材料' }], rich_text: map({ change_text: delta('完成验收\n周五反馈', redBold), 'coord_items.0.what': delta('协调材料', { bold: true }) }) };
  const inserted = await query({ table: 'reports', operation: 'insert', values: source });
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  const id = inserted.body.data[0].id;
  assert.deepEqual(inserted.body.data[0].rich_text, source.rich_text);
  const filters = [{ column: 'id', value: id }];
  const read = await query({ table: 'reports', filters }, 'demo-ops');
  assert.deepEqual(read.body.data[0].rich_text, source.rich_text);
  assert.equal((await query({ table: 'reports', operation: 'update', filters, values: { change_text: '不同正文', rich_text: source.rich_text } })).status, 400);
  assert.equal((await query({ table: 'reports', operation: 'update', filters, values: { rich_text: map({ change_text: delta(source.change_text, { link: 'https://invalid.example' }) }) } })).status, 400);
  const plain = map({ change_text: delta(source.change_text) });
  const cleared = await query({ table: 'reports', operation: 'update', filters, values: { rich_text: plain } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.data[0].rich_text, plain);
  assert.deepEqual(cleared.body.data[0].history[0].data.rich_text, source.rich_text);
  const restored = await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: source });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(restored.body.data[0].history[1].data.rich_text, plain);
  const legacy = await query({ table: 'reports', operation: 'update', filters, values: { coord_items: [{ who: '演示运营', what: '更新协调' }] } });
  assert.equal(legacy.status, 200);
  assert.deepEqual(Object.keys(legacy.body.data[0].rich_text.fields), ['change_text']);
  const denied = await query({ table: 'reports', operation: 'update', filters, values: { rich_text: {} } }, 'demo-pm-com');
  assert.equal(denied.status, 403);
  const spoof = await query({ table: 'reports', operation: 'insert', values: { ...source, period: '冒用', author_id: 'demo-pm-com' } });
  assert.equal(spoof.status, 403);
  assert.equal((await query({ table: 'reports', operation: 'insert', values: { ...source, project_id: 'demo-com', line: '成本' } }, 'demo-pm-com')).status, 403);
  const review = { project_id: 'demo-res', period: source.period, kind: 'ceo', note: '保持验收标准', rich_text: map({ note: delta('保持验收标准', redBold) }) };
  assert.equal((await query({ table: 'leader_reviews', operation: 'upsert', onConflict: 'project_id,period,kind', values: review }, 'demo-president')).status, 200);
  const notes = await call('/api/leader-notes/replace', { project_id: 'demo-res', period: source.period, kind: 'ceo_brief', items: [{ what: '周五前反馈', rich_text: map({ what: delta('周五前反馈', redBold) }) }] }, 'demo-ops');
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  assert.deepEqual(notes.body.data[0].rich_text.fields.what, delta('周五前反馈', redBold));
  const badNotes = await call('/api/leader-notes/replace', { project_id: 'demo-res', period: source.period, kind: 'ceo_brief', items: [{ what: '周五前反馈', rich_text: map({ what: delta('另一条文字') }) }] }, 'demo-ops');
  assert.equal(badNotes.status, 400);
  assert.equal((await query({ table: 'leader_notes', filters: [{ column: 'period', value: source.period }] }, 'demo-ops')).body.data[0].what, '周五前反馈');
  const milestone = (await query({ table: 'milestones' })).body.data[0];
  const noteUpdate = await query({ table: 'milestones', operation: 'update', filters: [{ column: 'id', value: milestone.id }], values: { note: '材料到场确认', rich_text: map({ note: delta('材料到场确认', redBold) }) } });
  assert.equal(noteUpdate.status, 200, JSON.stringify(noteUpdate.body));
  assert.deepEqual(noteUpdate.body.data[0].rich_text.fields.note, delta('材料到场确认', redBold));
  assert.equal((await query({ table: 'milestones', operation: 'update', filters: [{ column: 'id', value: milestone.id }], values: { plan_date: '2027-01-01', rich_text: {} } })).status, 403);
});
