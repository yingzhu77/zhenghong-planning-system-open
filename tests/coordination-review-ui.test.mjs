import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/completion-review.js', import.meta.url), 'utf8');
const coordKey = 'coord:p1:11:coord:stable-recipient';
const coordSource = { source_key: coordKey, source_version: 'source-version', project_id: 'p1', kind: 'coord',
  title: '协调需求事项', what: '匿名资料核对', due: '2026-10-25', author_id: 'initiator', group: 'coord', who_id: 'recipient' };
function row(extra = {}) {
  return { id: 'coord-request', source_key: coordKey, project_id: 'p1', kind: 'coord', owner_id: 'recipient', owner_name: '匿名承办人',
    status: 'pending', revision: 2, completion_date: '2026-10-20', completion_note: '已核验完成结果', request_type: 'completion',
    can_review: true, review_authority: 'initiator', source_snapshot: coordSource, ...extra };
}
function page(rows, more = false, cursor = null) { return { data: rows, meta: { has_more: more, next_cursor: cursor }, error: null }; }
function harness(handler = async () => page([row()])) {
  const elements = {}, calls = [], messages = [];
  let renders = 0, loads = 0, drafts = 0;
  const S = { uid: 'initiator', session: {}, profile: { role: 'pm' }, pmProject: 'p1', pmPeriod: '第43周', view: 'workbench',
    projects: [{ id: 'p1', name: '匿名项目一' }, { id: 'p2', name: '匿名项目二' }], completions: [],
    completionQuery: { project_id: '', status: 'all' }, completionQueueIds: [], completionMeta: { has_more: false, next_cursor: null } };
  const sandbox = { document: { getElementById: id => elements[id] || null } }; sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.CompletionReview;
  const options = { S, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    request: async (url, body) => { calls.push({ url, body: JSON.parse(JSON.stringify(body)) }); return handler(url, body); },
    render: () => renders++, toast: (...args) => messages.push(args), loadData: async () => { loads++; return true; },
    saveDraft: () => drafts++, flush: () => {}, afterSaved: async () => true };
  api.configure(options);
  return { S, api, options, elements, calls, messages, get renders() { return renders; }, get loads() { return loads; }, get drafts() { return drafts; } };
}
function tokens(html) { return [...html.matchAll(/CompletionReview.openKey\((\d+)\)/g)].map(match => Number(match[1])); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('initiated loader is pure, caches its complete query and preserves the owner queue', async () => {
  const h = harness();
  h.S.completions = [row({ id: 'own-row', owner_id: 'initiator', can_review: false, source_snapshot: { ...coordSource, what: '本人申报保留' } })];
  h.S.completionQueueIds = ['own-row']; h.S.completionMeta = { has_more: true, next_cursor: 'own-cursor' };
  const before = clone({ rows: h.S.completions, ids: h.S.completionQueueIds, meta: h.S.completionMeta, query: h.S.completionQuery });
  h.api.renderInitiatedQueue(); h.api.renderQueue({ review_scope: 'initiated' });
  assert.equal(h.calls.length, 0, 'rendering cannot start a request');
  const result = await h.api.loadInitiated(false);
  assert.equal(result.error, null);
  assert.equal(h.renders, 0, 'page loader cannot recursively render the page');
  assert.deepEqual(h.calls[0], { url: '/api/completions/list', body: { review_scope: 'initiated', status: 'all', limit: 100 } });
  assert.match(h.api.renderInitiatedQueue(), /匿名资料核对/);
  assert.match(h.api.renderQueue({ review_scope: 'initiated' }), /匿名承办人/);
  assert.deepEqual(clone({ rows: h.S.completions, ids: h.S.completionQueueIds, meta: h.S.completionMeta, query: h.S.completionQuery }), before);
  await h.api.loadInitiated(false); h.api.configure(h.options); await h.api.loadInitiated(false);
  assert.equal(h.calls.length, 1, 'same-session navigation reuses the initiated query');
});

test('initiated loader shares pending requests and does not turn render into retries', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const first = h.api.loadInitiated(false), second = h.api.loadInitiated(false);
  assert.equal(h.calls.length, 1);
  h.api.renderInitiatedQueue(); h.api.renderQueue({ review_scope: 'initiated' });
  assert.equal(h.calls.length, 1);
  resolve(page([row()]));
  assert.equal((await first).error, null); assert.equal((await second).error, null);
  assert.equal(tokens(h.api.renderInitiatedQueue()).length, 1);
});

test('initiated project and status filters query the server without changing the owner filters', async () => {
  const h = harness((url, body) => page([row({ project_id: body.project_id || 'p1', status: body.status === 'all' ? 'pending' : body.status })]));
  await h.api.loadInitiated(false);
  await h.api.filterInitiated('status', 'approved');
  assert.equal(h.calls.at(-1).body.status, 'approved');
  assert.equal(h.calls.at(-1).body.review_scope, 'initiated');
  await h.api.filterInitiated('project_id', 'p2');
  assert.equal(h.calls.at(-1).body.project_id, 'p2');
  assert.equal(h.calls.at(-1).body.status, 'approved');
  assert.deepEqual(clone(h.S.completionQuery), { project_id: '', status: 'all' });
  h.api.invalidateInitiated(); await h.api.loadInitiated(false);
  assert.equal(h.calls.length, 4, 'invalidating causes a fresh query');
});

test('late initiated responses are discarded after an identity, session or selected project change', async () => {
  for (const change of [S => { S.uid = 'new-initiator'; }, S => { S.session = {}; }, S => { S.pmProject = 'p2'; }]) {
    let resolve;
    const h = harness(() => new Promise(done => { resolve = done; }));
    const loading = h.api.loadInitiated(false);
    change(h.S); h.api.configure(h.options);
    resolve(page([row({ source_snapshot: { ...coordSource, what: '过期请求内容' } })]));
    await loading;
    assert.doesNotMatch(h.api.renderInitiatedQueue(), /过期请求内容/);
    assert.equal(h.messages.length, 0);
    assert.deepEqual(h.S.completions, []);
  }
});

test('failed initiated refresh preserves loaded rows and the continuation cursor', async () => {
  let failure = false;
  const h = harness((url, body) => failure && !body.cursor ? { data: null, error: { message: '匿名读取故障' } }
    : body.cursor ? page([row({ id: 'next-row', source_snapshot: { ...coordSource, what: '续页内容' } })]) : page([row()], true, 'next-page'));
  await h.api.loadInitiated(false); failure = true;
  const failed = await h.api.loadInitiated(true);
  assert.ok(failed.error);
  assert.match(h.api.renderInitiatedQueue(), /匿名资料核对/);
  assert.match(h.api.renderInitiatedQueue(), /匿名读取故障/);
  assert.equal(h.calls.length, 2, 'rendering an error cannot retry');
  await h.api.moreInitiated();
  assert.equal(h.calls.at(-1).body.cursor, 'next-page');
  assert.match(h.api.renderInitiatedQueue(), /续页内容/);
});

test('initiated pagination deduplicates record ids and keeps the latest revision', async () => {
  const h = harness((url, body) => body.cursor
    ? page([row({ revision: 3, source_snapshot: { ...coordSource, what: '修订后的协调事项' } }), row({ id: 'second-record', source_snapshot: { ...coordSource, what: '第二项协调事项' } })])
    : page([row()], true, 'page-two'));
  await h.api.loadInitiated(false); await h.api.moreInitiated();
  const html = h.api.renderInitiatedQueue();
  assert.equal(tokens(html).length, 2);
  assert.match(html, /修订后的协调事项/); assert.match(html, /第二项协调事项/);
  assert.doesNotMatch(html, /匿名资料核对/);
  assert.equal(h.calls[1].body.cursor, 'page-two');
  assert.deepEqual(h.S.completions, []);
});

test('a PM initiator opens an exact coordination request and reviews without a reporter preview', async () => {
  const h = harness((url, body) => url.endsWith('/list') ? page([row()])
    : { data: row({ status: 'approved', revision: 3, ...body }), error: null });
  await h.api.loadInitiated(false);
  const token = tokens(h.api.renderInitiatedQueue())[0];
  await h.api.openKey(token);
  assert.equal(h.calls.length, 1, 'reviewer uses the existing request snapshot');
  const html = h.api.overlayHtml();
  assert.match(html, /CompletionReview.review\('approve'\)/);
  assert.doesNotMatch(html, /提交完成申请|提交延期申请/);
  await h.api.review('approve');
  const review = h.calls.find(call => call.url.endsWith('/review'));
  assert.ok(review); assert.equal(review.body.id, 'coord-request');
  assert.equal(review.body.expected_revision, 2); assert.equal(review.body.decision, 'approve');
  assert.equal(h.calls.some(call => call.url.endsWith('/preview')), false);
  assert.deepEqual(h.S.completions, [], 'reviewing others cannot insert their request into the owner queue');
});

test('ops cannot review direct coordination requests while its other review scope remains available', async () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.S.completions = [row({ can_review: false })];
  await h.api.open(coordKey, { owner_id: 'recipient' });
  assert.doesNotMatch(h.api.overlayHtml(), /CompletionReview.review\(/);
  await h.api.review('approve'); assert.equal(h.calls.length, 0);
  const handoverKey = 'coord:p1:11:handover:handover-item';
  h.S.completions = [row({ source_key: handoverKey, can_review: true, review_authority: 'ops', source_snapshot: { ...coordSource, source_key: handoverKey, group: 'handover' } })];
  await h.api.open(handoverKey, { owner_id: 'recipient' });
  assert.match(h.api.overlayHtml(), /CompletionReview.review\('approve'\)/);
});

test('initiator approval writes are single-flight and conflicts preserve the entered explanation', async () => {
  let finish;
  const h = harness((url) => url.endsWith('/list') ? page([row()]) : new Promise(resolve => { finish = resolve; }));
  await h.api.loadInitiated(false); await h.api.openKey(tokens(h.api.renderInitiatedQueue())[0]);
  h.elements.completion_review_note = { value: '匿名审核说明，需要保留' };
  const saving = h.api.review('approve'); await h.api.review('approve');
  assert.equal(h.calls.filter(call => call.url.endsWith('/review')).length, 1);
  finish({ data: null, error: { code: 'revision_conflict', message: '记录已更新' } });
  await saving;
  assert.match(h.api.overlayHtml(), /匿名审核说明，需要保留/);
  assert.match(h.api.overlayHtml(), /刷新核对后重试/);
  assert.match(h.api.renderInitiatedQueue(), /匿名资料核对/);
  assert.equal(h.calls.filter(call => call.url.endsWith('/preview')).length, 0);
});

test('an initiator cannot approve an application whose source changed after it was submitted', async () => {
  const h = harness(() => page([row({ source_changed: true, effective_status: 'source_changed' })]));
  await h.api.loadInitiated(false); await h.api.openKey(tokens(h.api.renderInitiatedQueue())[0]);
  assert.match(h.api.overlayHtml(), /CompletionReview.review\('approve'\)" disabled/);
  await h.api.review('approve');
  assert.equal(h.calls.length, 1);
  assert.match(h.messages.at(-1)[0], /暂不能通过审核/);
});

test('PM without review permission cannot review another owner or submit on their behalf', async () => {
  for (const kind of ['coord', 'meeting']) {
    const h = harness();
    h.S.completions = [row({ kind, can_review: false, review_authority: kind === 'meeting' ? 'ops' : 'initiator' })];
    await h.api.open(coordKey, { owner_id: 'recipient' });
    assert.doesNotMatch(h.api.overlayHtml(), /CompletionReview.review\(|提交完成申请|提交延期申请/);
    await h.api.review('approve'); await h.api.request();
    assert.equal(h.calls.length, 0);
  }
});

test('the owner keeps the preview and application workflow with no reviewer controls', async () => {
  const h = harness((url, body) => url.endsWith('/preview') ? { data: coordSource, error: null }
    : { data: row({ ...body, owner_id: 'recipient', can_review: false }), error: null });
  h.S.uid = 'recipient'; h.api.configure(h.options);
  await h.api.open(coordKey);
  assert.match(h.api.overlayHtml(), /提交完成申请/);
  assert.doesNotMatch(h.api.overlayHtml(), /CompletionReview.review\(/);
  h.elements.completion_date = { value: '2026-10-20' }; h.elements.completion_note = { value: '匿名完成结果' };
  await h.api.request();
  assert.equal(h.calls[0].url, '/api/completions/preview');
  assert.equal(h.calls[1].url, '/api/completions/request');
  assert.equal(h.calls[1].body.owner_id, undefined);
});

test('unknown completion category displays unable to determine in request details', async () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.S.completions = [row({ kind: 'meeting', can_review: true, review_authority: 'ops', completion_category: 'unknown', effective_due: '',
    source_snapshot: { ...coordSource, kind: 'meeting', due: '' } })];
  await h.api.open(coordKey, { owner_id: 'recipient' });
  assert.match(h.api.overlayHtml(), /实际完成日期：2026-10-20[^<]*无法判定/);
  assert.doesNotMatch(h.api.overlayHtml(), /实际完成日期：2026-10-20[^<]*按时完成/);
});

test('new applications with no deadline are unable to determine; valid deadlines react to actual completion dates', async () => {
  for (const [due, date, expected] of [['', '2026-10-20', '无法判定'], ['2026-10-25', '2026-10-24', '按时完成'], ['2026-10-25', '2026-10-26', '延期完成']]) {
    const h = harness(() => ({ data: { ...coordSource, due }, error: null }));
    h.S.uid = 'recipient'; h.api.configure(h.options);
    await h.api.open(coordKey);
    h.elements.completion_date = { value: date }; h.api.dateChanged();
    assert.match(h.api.overlayHtml(), new RegExp('申报类别：<b>' + expected + '</b>'));
  }
});

test('invalidating initiated data cancels a pending response while a replacement query stays authoritative', async () => {
  const resolvers = [];
  const h = harness(() => new Promise(resolve => { resolvers.push(resolve); }));
  const old = h.api.loadInitiated(false);
  h.api.invalidateInitiated();
  const fresh = h.api.loadInitiated(false);
  assert.equal(h.calls.length, 2);
  resolvers[1](page([row({ source_snapshot: { ...coordSource, what: '失效后重新读取的记录' } })]));
  assert.equal((await fresh).error, null);
  resolvers[0](page([row({ source_snapshot: { ...coordSource, what: '失效前已过期的记录' } })]));
  await old;
  const html = h.api.renderInitiatedQueue();
  assert.match(html, /失效后重新读取的记录/);
  assert.doesNotMatch(html, /失效前已过期的记录/);
  await h.api.loadInitiated(false); assert.equal(h.calls.length, 2, 'a discarded response cannot invalidate the fresh cache');
});

test('initiator modal refresh requests its exact id and removes review actions when permission is lost', async () => {
  for (const lost of [page([]), page([row({ can_review: false })]), { data: null, error: { code: 'completion_forbidden', status: 403, message: '无权审核此协调事项' } }]) {
    const h = harness((url, body) => body.id ? lost : page([row()]));
    await h.api.loadInitiated(false); await h.api.openKey(tokens(h.api.renderInitiatedQueue())[0]);
    assert.match(h.api.overlayHtml(), /CompletionReview.review\('approve'\)/);
    await h.api.refresh();
    assert.deepEqual(h.calls.at(-1), { url: '/api/completions/list', body: { review_scope: 'initiated', id: 'coord-request' } });
    assert.doesNotMatch(h.api.overlayHtml(), /CompletionReview.review\(/);
    const before = h.calls.length;
    await h.api.review('approve'); assert.equal(h.calls.length, before);
    assert.equal(h.calls.some(call => call.url.endsWith('/preview')), false);
    assert.equal(h.loads, 0, 'the initiated modal cannot reload or replace the owner queue');
  }
});

test('an approved initiated request leaves the pending filter without entering the owner queue', async () => {
  const h = harness((url) => url.endsWith('/list') ? page([row()]) : { data: row({ status: 'approved', revision: 3 }), error: null });
  await h.api.filterInitiated('status', 'pending');
  assert.equal(h.calls[0].body.status, 'pending');
  await h.api.openKey(tokens(h.api.renderInitiatedQueue())[0]);
  await h.api.review('approve');
  assert.doesNotMatch(h.api.renderInitiatedQueue(), /匿名资料核对/);
  assert.equal(tokens(h.api.renderInitiatedQueue()).length, 0);
  assert.deepEqual(h.S.completions, []);
});

test('direct three-part coordination UUID sources appear in the initiator queue and can be reviewed without a preview', async () => {
  const key = 'coord:p1:33333333-3333-4333-8333-333333333333';
  const direct = row({ source_key: key, report_id: null, kind: 'coord', can_review: true, review_authority: 'initiator',
    source_snapshot: { source_key: key, source_version: 'direct-source-version', project_id: 'p1', report_id: null, kind: 'coord',
      author_id: 'initiator', who_id: 'recipient', title: '协调需求事项', what: '新独立协调来源', due: '2026-11-02' } });
  const h = harness(url => url.endsWith('/list') ? page([direct]) : { data: { ...direct, status: 'approved', revision: 3 }, error: null });
  await h.api.loadInitiated(false);
  const html = h.api.renderInitiatedQueue();
  assert.match(html, /新独立协调来源/);
  assert.equal(tokens(html).length, 1);
  await h.api.openKey(tokens(html)[0]);
  assert.match(h.api.overlayHtml(), /CompletionReview.review\('approve'\)/);
  assert.equal(h.calls.length, 1, 'opening an initiator review cannot call the owner preview');
  await h.api.review('approve');
  assert.equal(h.calls[1].url, '/api/completions/review');
  assert.equal(h.calls[1].body.id, direct.id);
  assert.equal(h.calls.some(call => call.url.endsWith('/preview')), false);
  assert.deepEqual(h.S.completions, []);
});
