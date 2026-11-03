import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { withIdentity } from '../server/database.mjs';
import { previewCompletion, requestCompletion, reviewCompletion, withdrawCompletion, listCompletions } from '../server/completions.mjs';

const pm = { id: 'demo-pm-res' }, ops = { id: 'demo-ops' };
const doc = (text, attributes = { bold: true }) => ({ ops: [{ insert: text, attributes }] });
const format = (field, text, attributes) => ({ v: 1, fields: { [field]: doc(text, attributes) } });
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  const source = (await admin.query("SELECT id FROM public.leader_notes WHERE project_id='demo-res' LIMIT 1")).rows[0];
  return { db, admin, pool, key: 'leader:demo-res:' + source.id };
}
async function request(f, extra = {}, actor = pm, key = f.key) {
  const preview = await previewCompletion(f.pool, actor, { source_key: key });
  return requestCompletion(f.pool, actor, { source_key: key, source_version: preview.source_version,
    completion_date: '2026-10-23', completion_note: '已核验交付', rich_text: format('completion_note', '已核验交付'), ...extra });
}
function review(row, decision, note, attributes) {
  return { id: row.id, expected_revision: row.revision, decision, note, rich_text: format('review_note', note, attributes) };
}

test('completion note and review formatting survive rejection, resubmission, withdrawal, approval, reopening and audit history', async t => {
  const f = await fixture(t), original = await request(f);
  const version = original.source_version;
  assert.deepEqual(original.rich_text, format('completion_note', '已核验交付'));
  const rejected = await reviewCompletion(f.pool, ops, review(original, 'reject', '补充验收材料', { color: '#d81e06' }));
  assert.deepEqual(rejected.rich_text.fields.completion_note, original.rich_text.fields.completion_note);
  assert.deepEqual(rejected.rich_text.fields.review_note, doc('补充验收材料', { color: '#d81e06' }));
  const next = await request(f, { expected_revision: rejected.revision, completion_note: '补齐后的结果', rich_text: format('completion_note', '补齐后的结果', { bold: true, color: '#d81e06' }) });
  assert.equal(next.review_note, ''); assert.equal(next.rich_text.fields.review_note, undefined);
  await assert.rejects(withIdentity(f.pool, pm.id, client => client.query("UPDATE public.completion_requests SET status='withdrawn',rich_text='{}' WHERE id=$1", [next.id])), error => error.code === '42501');
  const withdrawn = await withdrawCompletion(f.pool, pm, { id: next.id, expected_revision: next.revision });
  assert.deepEqual(withdrawn.rich_text, next.rich_text);
  const again = await request(f, { expected_revision: withdrawn.revision, rich_text: undefined });
  assert.deepEqual(again.rich_text, {}, 'a plain-text client replaces only its own old formatting');
  const approved = await reviewCompletion(f.pool, ops, review(again, 'approve', '验收通过'));
  const reopened = await reviewCompletion(f.pool, ops, review(approved, 'reopen', '重新核验', { color: '#d81e06' }));
  assert.equal(reopened.source_version, version);
  const detail = (await listCompletions(f.pool, pm, { id: original.id }))[0];
  assert.equal(detail.history.length, 6);
  assert.deepEqual(detail.history[0].data.rich_text, original.rich_text);
  assert.deepEqual(detail.history[1].data.rich_text, rejected.rich_text);
  assert.deepEqual(detail.history[4].data.rich_text, again.rich_text);
  assert.deepEqual(detail.rich_text.fields.review_note, doc('重新核验', { color: '#d81e06' }));
  const before = (await f.admin.query('SELECT to_jsonb(r) AS value FROM public.completion_requests r WHERE id=$1', [original.id])).rows[0].value;
  const migration = await readFile(new URL('../db/023-completion-rich-text.sql', import.meta.url), 'utf8');
  await f.db.exec('RESET ROLE'); await f.db.exec(migration); await f.db.exec(migration);
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(r) AS value FROM public.completion_requests r WHERE id=$1', [original.id])).rows[0].value, before);
});

test('format validation and the database review guard protect applicant evidence and immutable audit/source fields', async t => {
  const f = await fixture(t);
  for (const rich of [format('completion_note', '与正文不同'), format('review_note', '越权审核'),
    format('completion_note', '已核验交付', { link: 'javascript:alert(1)' }),
    format('completion_note', '已核验交付', { color: '#ff0000' }),
    { v: 1, fields: { completion_note: { ops: [{ insert: { image: 'https://example.invalid' } }] } } }])
    await assert.rejects(request(f, { rich_text: rich }), error => error.code === 'invalid_rich_text');
  const row = await request(f);
  await assert.rejects(reviewCompletion(f.pool, ops, { ...review(row, 'approve', ''), rich_text: format('completion_note', row.completion_note) }), error => error.code === 'invalid_rich_text');
  for (const patch of ["completion_note='篡改申请证据'", "rich_text='{}'::jsonb", "source_version=repeat('a',64)", "history='[{}]'::jsonb"])
    await assert.rejects(withIdentity(f.pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='rejected',review_note='退回'," + patch + ' WHERE id=$1', [row.id])), error => error.code === '42501');
  for (const rich of [{ ...row.rich_text, v: 2 }, { ...row.rich_text, extra: true }, { v: 1, fields: [] },
    { v: 1, fields: { ...row.rich_text.fields, identity: doc('越权') } }])
    await assert.rejects(withIdentity(f.pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='rejected',review_note='退回',rich_text=$1 WHERE id=$2", [JSON.stringify(rich), row.id])), error => error.code === '23514');
  await assert.rejects(withIdentity(f.pool, ops.id, client => client.query("UPDATE public.completion_requests SET status='rejected',review_note='退回',rich_text=$1 WHERE id=$2", [JSON.stringify(format('completion_note', row.completion_note, { color: '#d81e06' })), row.id])), error => error.code === '42501');
  const current = (await listCompletions(f.pool, pm, { id: row.id }))[0];
  assert.equal(current.status, 'pending'); assert.deepEqual(current.rich_text, row.rich_text); assert.equal(current.history.length, 0);
});

test('extension reasons keep their format and original deadlines while each approval remains a separate historical request', async t => {
  const f = await fixture(t);
  const preview = await previewCompletion(f.pool, pm, { source_key: f.key });
  const extension = await request(f, { request_type: 'extension', completion_date: undefined, requested_due: '2099-12-30', completion_note: '材料尚未到场', rich_text: format('completion_note', '材料尚未到场', { color: '#d81e06' }) });
  const approved = await reviewCompletion(f.pool, ops, review(extension, 'approve', '同意延期'));
  assert.equal(approved.due, preview.due); assert.equal(approved.effective_due, '2099-12-30');
  assert.deepEqual(approved.rich_text.fields.completion_note, extension.rich_text.fields.completion_note);
  await assert.rejects(reviewCompletion(f.pool, ops, review(approved, 'reopen', '不能重开延期')), error => error.code === 'invalid_transition');
  const next = await request(f, { request_type: 'extension', completion_date: undefined, requested_due: '2099-12-31', completion_note: '追加安排', rich_text: format('completion_note', '追加安排') });
  assert.notEqual(next.id, approved.id); assert.equal(next.review_note, '');
  assert.equal((await listCompletions(f.pool, pm)).length, 2);
});

test('reopening all approved milestone owners preserves each applicant Delta while sharing the new review note', async t => {
  const f = await fixture(t), other = { id: 'completion-rich-other' };
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,'匿名承办人','pm','approved','工程')", [other.id]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')", [other.id]);
  const node = (await f.admin.query("SELECT id FROM public.milestones WHERE project_id='demo-res' AND line='工程' LIMIT 1")).rows[0];
  const key = 'milestone:demo-res:' + node.id;
  const a = await reviewCompletion(f.pool, ops, review(await request(f, {}, pm, key), 'approve', '第一位已验收'));
  const b = await reviewCompletion(f.pool, ops, review(await request(f, { completion_note: '另一承办人证据', rich_text: format('completion_note', '另一承办人证据', { color: '#d81e06' }) }, other, key), 'approve', '第二位已验收'));
  const reopened = await reviewCompletion(f.pool, ops, review(a, 'reopen', '共同重新验收'));
  assert.equal(reopened.reopened_count, 2);
  for (const [owner, original] of [[pm, a], [other, b]]) {
    const row = (await listCompletions(f.pool, owner, { id: original.id }))[0];
    assert.equal(row.status, 'reopened'); assert.deepEqual(row.rich_text.fields.completion_note, original.rich_text.fields.completion_note);
    assert.deepEqual(row.rich_text.fields.review_note, doc('共同重新验收'));
  }
});

async function uiHarness() {
  const elements = {}, calls = [], key = 'leader:p1:note';
  const S = { uid: 'owner', session: {}, profile: { role: 'pm' }, pmProject: 'p1', pmPeriod: '2026-10-19', view: 'form', completions: [] };
  const sandbox = { document: { getElementById: id => elements[id] || null } }; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['rich-text.js', 'completion-review.js']) vm.runInContext(await readFile(new URL('../web/' + file, import.meta.url), 'utf8'), sandbox);
  const api = sandbox.CompletionReview, rt = sandbox.ZHRichText;
  const options = { S, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    richItem: rt.field, richCopy: rt.copy, richCollect: row => rt.collect(plain(row)), render() {}, toast() {}, loadData: async () => true,
    request: async (url, body) => { calls.push({ url, body: plain(body) }); return { data: url.endsWith('/preview') ? { source_version: 'version', what: '源事项', due: '2026-10-30' }
      : { id: 'saved', revision: 2, status: 'pending', owner_id: S.uid, source_key: key, ...plain(body) } }; } };
  api.configure(options);
  return { S, api, elements, calls, rt, options, key };
}

test('completion UI bindings retain Delta through redraws and payload trimming, render escaped text and reject old-session writers', async () => {
  const h = await uiHarness(); await h.api.open(h.key);
  assert.match(h.api.overlayHtml(), /id="completion_note" data-rich/);
  const old = h.api.binding('completion_note'); old.set(doc('  已核验<script>文字</script>  ', { bold: true, color: '#d81e06' }));
  h.elements.completion_date = { value: '2026-10-23' }; h.api.dateChanged();
  assert.deepEqual(plain(h.api.binding('completion_note').get()), doc('  已核验<script>文字</script>  ', { bold: true, color: '#d81e06' }));
  await h.api.request();
  assert.deepEqual(h.calls.at(-1).body.rich_text, format('completion_note', '已核验<script>文字</script>', { bold: true, color: '#d81e06' }));
  const stored = { id: 'stored', source_key: h.key, project_id: 'p1', owner_id: 'owner', status: 'pending', revision: 1,
    completion_note: '正文<script>内容</script>', review_note: '审核结果', rich_text: { v: 1, fields: {
      completion_note: doc('正文<script>内容</script>'), review_note: doc('审核结果', { color: '#d81e06' }) } } };
  h.S.completions = [stored]; h.S.uid = 'operator'; h.S.profile.role = 'ops'; h.api.configure(h.options); await h.api.open(h.key, { owner_id: 'owner' });
  const html = h.api.overlayHtml();
  assert.match(html, /<strong>正文&lt;script&gt;内容&lt;\/script&gt;<\/strong>/); assert.match(html, /rt-red/); assert.doesNotMatch(html, /<script>/);
  const reviewer = h.api.binding('completion_review_note'); reviewer.set(doc('  退回说明  ', { color: '#d81e06' }));
  await h.api.review('reject');
  assert.deepEqual(h.calls.at(-1).body.rich_text, format('review_note', '退回说明', { color: '#d81e06' }));
  h.S.session = {}; h.api.configure(h.options); old.set(doc('过期内容')); reviewer.set(doc('过期审核'));
  assert.equal(h.api.binding('completion_review_note'), null);
  assert.equal(stored.completion_note, '正文<script>内容</script>');
});
