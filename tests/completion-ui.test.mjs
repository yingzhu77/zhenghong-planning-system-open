import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'web/completion-review.js'), 'utf8');
const richSource = fs.readFileSync(path.join(root, 'web/rich-text.js'), 'utf8');
const key = 'meeting:p1:task';
const preview = { source_key: key, source_version: 'version-1', project_id: 'p1', kind: 'meeting', title: '会议决议', what: '落实事项', due: '2026-10-25' };
function row(extra = {}) { return { id: 'completion-1', source_key: key, owner_id: 'owner', owner_name: '测试承办人', project_id: 'p1', status: 'pending', revision: 2,
  completion_date: '2026-10-20', completion_note: '已落实并附核验结果', source_snapshot: preview, ...extra }; }
function harness(overrides = {}) {
  const elements = {}, calls = [], messages = [];
  let renders = 0, drafts = 0, flushes = 0, loads = 0;
  const S = { uid: 'owner', session: {}, profile: { role: 'pm' }, pmProject: 'p1', pmPeriod: '第43周', view: 'form',
    projects: [{ id: 'p1', name: '测试项目' }], completions: [] };
  const sandbox = { document: { getElementById: id => elements[id] || null } }; sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(richSource, sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.CompletionReview;
  const options = { S, esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    request: async (url, body) => { calls.push({ url, body }); return { data: url.endsWith('/preview') ? preview : row({ ...body, status: url.endsWith('/request') ? 'pending' : 'approved', revision: 3 }) }; },
    loadData: async () => { loads++; return true; }, render: () => renders++, toast: (...args) => messages.push(args),
    flush: () => flushes++, saveDraft: () => drafts++, queryCompletions: async () => true, loadMoreCompletions: async () => true, ...overrides };
  api.configure(options);
  return { S, api, sandbox, elements, calls, messages, options, get renders() { return renders; }, get drafts() { return drafts; }, get flushes() { return flushes; }, get loads() { return loads; } };
}

test('approval badges require effective approval for the exact owner and do not accept historical completed flags', () => {
  const h = harness();
  assert.equal(h.api.approved(key), false);
  h.S.completions = [row({ status: 'approved', owner_id: 'other' })];
  assert.equal(h.api.approved(key), false);
  assert.equal(h.api.approved(key, 'other'), true);
  h.S.completions.push(row({ status: 'approved', effective_status: 'source_changed', source_changed: true }));
  assert.equal(h.api.approved(key), false);
  assert.match(h.api.badge(key), /来源已变化/);
  h.S.completions[1] = row({ status: 'approved' });
  assert.equal(h.api.approved(key), true);
});

test('an approved extension changes the execution date without closing the source or showing a reopen action', async () => {
  const h = harness();
  h.S.completions = [row({ id: 'extension-1', request_type: 'extension', status: 'approved', requested_due: '2026-10-30', effective_due: '2026-10-30' })];
  assert.equal(h.api.approved(key), false);
  assert.equal(h.api.effectiveDue(key, '2026-10-25'), '2026-10-30');
  assert.match(h.api.badge(key), /延期已批准/);
  await h.api.open(key);
  assert.match(h.api.overlayHtml(), /提交完成申请/);
  assert.match(h.api.overlayHtml(), /id="completion_note"[^>]*><\/textarea>/, 'new completion needs its own result, not a prefilled extension reason');
  h.S.profile.role = 'ops'; await h.api.open(key);
  assert.doesNotMatch(h.api.overlayHtml(), /CompletionReview.review\('reopen'\)/);
});

test('extension requests validate later dates, preserve failure input and never reuse the completion revision', async () => {
  const h = harness(); await h.api.open(key);
  h.elements.completion_request_type = { value: 'extension' };
  h.elements.completion_requested_due = { value: '2026-10-25' };
  h.elements.completion_note = { value: '等待材料到场，申请调整安排' };
  await h.api.request(); assert.equal(h.calls.length, 1); assert.match(h.messages.at(-1)[0], /晚于当前执行截止时间/);
  h.elements.completion_requested_due.value = '2026-10-30'; await h.api.request();
  assert.equal(h.calls[1].body.request_type, 'extension');
  assert.equal(h.calls[1].body.requested_due, '2026-10-30');
  assert.equal(h.calls[1].body.completion_date, undefined);
  assert.equal(h.calls[1].body.expected_revision, undefined);
  assert.equal(h.api.approved(key), false);
  assert.match(h.api.overlayHtml(), /原执行截止时间继续有效/);
});

test('queue records sharing source and owner open the selected extension or completion by exact id', async () => {
  const h = harness(); h.S.profile.role = 'ops'; h.S.completionQuery = { project_id: '', status: '' };
  h.S.completions = [row({ id: 'completion-1', status: 'approved' }), row({ id: 'extension-1', request_type: 'extension', status: 'approved', requested_due: '2026-10-30' })];
  const tokens = [...h.api.renderQueue({ scope: 'all' }).matchAll(/CompletionReview.openKey\((\d+)\)/g)].map(m => Number(m[1]));
  assert.equal(tokens.length, 2);
  await h.api.openKey(tokens[1]); assert.match(h.api.overlayHtml(), /申请延期至：2026-10-30/); assert.doesNotMatch(h.api.overlayHtml(), /重新打开事项/);
  await h.api.openKey(tokens[0]); assert.match(h.api.overlayHtml(), /实际完成日期：2026-10-20/); assert.match(h.api.overlayHtml(), /重新打开事项/);
});

test('PM request previews the authorized source and submits actual date, explanation and exact source version', async () => {
  const h = harness();
  await h.api.open(key);
  h.elements.completion_date = { value: '2026-10-20' }; h.elements.completion_note = { value: '  已核验实际完成  ' };
  await h.api.request();
  assert.equal(h.calls[0].url, '/api/completions/preview');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { source_key: key });
  assert.equal(h.calls[1].url, '/api/completions/request');
  assert.equal(h.calls[1].body.source_version, 'version-1');
  assert.equal(h.calls[1].body.completion_date, '2026-10-20');
  assert.equal(h.calls[1].body.completion_note, '已核验实际完成');
  assert.equal(h.calls[1].body.owner_id, undefined);
  assert.equal(h.loads, 1);
  assert.match(h.api.overlayHtml(), /申请待审核，事项继续滚动/);
});

test('date and explanation validation reject invalid dates and empty completion claims', async () => {
  const h = harness(); await h.api.open(key);
  h.elements.completion_date = { value: '2026-02-31' }; h.elements.completion_note = { value: '已完成' };
  await h.api.request(); assert.equal(h.calls.length, 1); assert.match(h.messages.at(-1)[0], /有效的实际完成日期/);
  h.elements.completion_date.value = '2026-10-20'; h.elements.completion_note.value = '  ';
  await h.api.request(); assert.equal(h.calls.length, 1); assert.match(h.messages.at(-1)[0], /填写完成说明/);
});

test('ops review sends expected revision; rejection and reopening require a reason', async () => {
  const h = harness(); h.S.profile.role = 'ops'; h.S.completions = [row()];
  await h.api.open(key, { owner_id: 'owner' });
  assert.equal(h.calls.length, 0, 'ops uses the server-provided request snapshot');
  await h.api.review('reject'); assert.equal(h.calls.length, 0); assert.match(h.messages.at(-1)[0], /填写退回原因/);
  h.elements.completion_review_note = { value: '缺少现场验收记录' };
  await h.api.review('reject');
  assert.equal(h.calls[0].body.expected_revision, 2);
  assert.equal(h.calls[0].body.decision, 'reject');
  assert.equal(h.calls[0].body.note, '缺少现场验收记录');
  h.S.completions = [row({ status: 'approved' })]; await h.api.open(key);
  h.elements.completion_review_note.value = ''; await h.api.review('reopen');
  assert.match(h.messages.at(-1)[0], /填写重新打开原因/);
});

test('a failed request and conflict preserve the date and explanation and never imply approval', async () => {
  const h = harness({ request: async url => url.endsWith('/preview') ? { data: preview } : { error: { code: 'revision_conflict', message: '已变化' } } });
  await h.api.open(key); h.elements.completion_date = { value: '2026-10-18' }; h.elements.completion_note = { value: '必须保留的完成说明' };
  await h.api.request();
  assert.match(h.api.overlayHtml(), /必须保留的完成说明/);
  assert.match(h.api.overlayHtml(), /value="2026-10-18"/);
  assert.match(h.messages.at(-1)[0], /刷新核对后重试/);
  assert.equal(h.api.approved(key), false);
});

test('saving is single-flight and a list refresh failure does not repeat a persisted request', async () => {
  let resolve, count = 0;
  const h = harness({ request: async url => {
    if (url.endsWith('/preview')) return { data: preview };
    count++; return new Promise(done => { resolve = done; });
  }, loadData: async () => false });
  await h.api.open(key); h.elements.completion_date = { value: '2026-10-20' }; h.elements.completion_note = { value: '完整说明' };
  const pending = h.api.request(); await h.api.request(); assert.equal(count, 1);
  assert.match(h.api.overlayHtml(), /正在保存/);
  resolve({ data: row() }); await pending;
  assert.equal(h.S.completions.length, 1);
  assert.match(h.messages.at(-1)[0], /操作已保存.*刷新失败/);
});

test('late preview and mutation responses cannot restore a modal after project, period, or session change', async () => {
  for (const change of [S => { S.pmProject = 'p2'; }, S => { S.pmPeriod = '第44周'; }, S => { S.session = {}; }, S => { S.uid = 'another'; }]) {
    let resolve;
    const h = harness({ request: () => new Promise(done => { resolve = done; }) });
    const loading = h.api.open(key); change(h.S); h.api.configure(h.options);
    resolve({ data: preview }); await loading;
    assert.equal(h.api.overlayHtml(), '');
    assert.equal(h.S.completions.length, 0);
  }
  let resolve;
  const h = harness({ request: async url => url.endsWith('/preview') ? { data: preview } : new Promise(done => { resolve = done; }) });
  await h.api.open(key); h.elements.completion_date = { value: '2026-10-20' }; h.elements.completion_note = { value: '说明' };
  const pending = h.api.request(); h.S.session = {}; h.api.configure(h.options); resolve({ data: row() }); await pending;
  assert.equal(h.S.completions.length, 0); assert.equal(h.messages.length, 0);
});

test('read-only leaders render escaped summaries without running reporter draft functions or review actions', async () => {
  const h = harness(); h.S.profile.role = 'president'; h.S.completions = [row({ completion_note: '<script>bad</script>', source_snapshot: { ...preview, report_id: 'r1', title: '<img src=x>' } })];
  const html = h.api.snapshotsHtml({ id: 'r1', author_id: 'owner', biz: { followups: [null] } });
  assert.match(html, /当前完成审核状态/); assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|onclick/);
  await h.api.open(key, { owner_id: 'owner', readOnly: true }); await h.api.review('approve'); await h.api.request();
  assert.equal(h.drafts, 0); assert.equal(h.flushes, 0); assert.equal(h.calls.length, 0);
  assert.doesNotMatch(h.api.overlayHtml(), /提交完成申请|onclick="CompletionReview.review/);
});

test('queues remain per source plus owner, PM cannot request all users, and filters keep distinct records', async () => {
  const h = harness(); h.S.completions = [row(), row({ id: 'other-owner', owner_id: 'other', owner_name: '另一承办人' })];
  assert.doesNotMatch(h.api.renderQueue({ scope: 'all' }), /另一承办人/);
  h.S.profile.role = 'ops';
  assert.match(h.api.renderQueue({ scope: 'all' }), /另一承办人/);
  assert.match(h.api.renderQueue({ scope: 'all' }), /2 项/);
  await h.api.filter('status', 'approved'); assert.match(h.api.renderQueue({ scope: 'all' }), /没有完成申请/);
});

test('source-changed approved requests cannot be silently resubmitted by PM', async () => {
  const h = harness(); h.S.completions = [row({ status: 'approved', source_changed: true, effective_status: 'source_changed' })];
  await h.api.open(key);
  assert.match(h.api.overlayHtml(), /联系管理员.*重新打开/);
  assert.doesNotMatch(h.api.overlayHtml(), /提交完成申请/);
  await h.api.request(); assert.equal(h.calls.length, 0);
});

test('source formatting stays restricted and survives detail, queue and leader summary', async () => {
  const text = '红粗事项\n<img src=x>', rich = { v: 1, fields: { what: { ops: [{ insert: text, attributes: { bold: true, color: '#d81e06' } }] } } };
  const h = harness(); h.S.profile.role = 'ops'; h.S.completions = [row({ kind: 'meeting', report_id: 'r1', source_snapshot: { ...preview, what: text, rich_text: rich } })];
  await h.api.open(key);
  for (const html of [h.api.overlayHtml(), h.api.renderQueue({ scope: 'all' }), h.api.snapshotsHtml({ id: 'r1' })]) {
    assert.match(html, /<strong>红粗事项<br>&lt;img src=x&gt;<\/strong>/);
    assert.match(html, /class="rt-red"/);
    assert.doesNotMatch(html, /<img src=x>/);
  }
});

test('an incomplete successful HTTP body is not treated as a persisted completion', async () => {
  const h = harness({ request: async url => url.endsWith('/preview') ? { data: preview } : { data: {} } });
  await h.api.open(key); h.elements.completion_date = { value: '2026-10-20' }; h.elements.completion_note = { value: '保留说明' };
  await h.api.request();
  assert.equal(h.S.completions.length, 0);
  assert.match(h.messages.at(-1)[0], /保存结果不完整/);
  assert.match(h.api.overlayHtml(), /保留说明/);
});

test('ops initially queries pending including changed-source pending records, while PM includes all statuses', () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.S.completions = [row({ source_changed: true, effective_status: 'source_changed', source_snapshot: { title: '需核对的待审项' } }), row({ id: 'approved', status: 'approved', source_snapshot: { title: '已通过项目' } })];
  let html = h.api.renderQueue({ scope: 'all' });
  assert.match(html, /value="pending" selected/);
  assert.match(html, /需核对的待审项/);
  assert.doesNotMatch(html, /已通过项目/);
  h.S.profile.role = 'pm'; html = h.api.renderQueue();
  assert.match(html, /已通过项目/);
});

test('pagination distinguishes main queue from source-key side records and deduplicates appended pages by id', async () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.S.completionQuery = { project_id: '', status: 'pending' };
  h.S.completions = Array.from({ length: 100 }, (_, index) => row({ id: 'r' + index }));
  h.S.completions.push(row({ id: 'side-only', source_snapshot: { title: '状态补充记录' } }));
  h.S.completionQueueIds = h.S.completions.slice(0, 100).map(r => r.id);
  h.S.completionMeta = { has_more: true, next_cursor: 'cursor-100' };
  let html = h.api.renderQueue({ scope: 'all' });
  assert.match(html, /已加载 100 条审核记录/); assert.match(html, /还有后续记录/); assert.doesNotMatch(html, /状态补充记录/);
  let pages = 0;
  h.options.loadMoreCompletions = async () => {
    pages++;
    h.S.completions.push(row({ id: 'r99', revision: 3, source_snapshot: { title: '更新后的记录' } }), row({ id: 'r100' }));
    h.S.completionQueueIds.push('r99', 'r100'); h.S.completionMeta = { has_more: false, next_cursor: null }; return true;
  };
  await h.api.loadMore(); html = h.api.renderQueue({ scope: 'all' });
  assert.equal(pages, 1); assert.match(html, /已加载 101 条审核记录/); assert.match(html, /更新后的记录/);
  assert.match(html, /当前查询已读取完毕/); assert.doesNotMatch(html, /加载更多审核记录/);
});

test('status and project filters query the server instead of filtering only the first loaded page', async () => {
  const h = harness(); h.S.profile.role = 'ops'; const queries = [];
  h.S.completionQuery = { project_id: '', status: 'pending' }; h.S.completionMeta = { has_more: true, next_cursor: 'old-page' };
  h.S.completions = [row()];
  h.options.queryCompletions = async query => {
    queries.push(JSON.parse(JSON.stringify(query)));
    h.S.completions = [row({ id: 'remote-only', project_id: query.project_id || 'p1', status: query.status || 'pending', kind: 'meeting', source_snapshot: { title: '后端新查询结果' } })];
    h.S.completionMeta = { has_more: false, next_cursor: null }; return true;
  };
  await h.api.filter('status', 'approved');
  assert.deepEqual(queries[0], { project_id: '', status: 'approved' });
  assert.match(h.api.renderQueue({ scope: 'all' }), /后端新查询结果/);
  await h.api.filter('project_id', 'p2');
  assert.deepEqual(queries[1], { project_id: 'p2', status: 'approved' });
  await h.api.filter('kind', 'meeting'); assert.equal(queries.length, 2, 'type filtering is explicitly local to loaded records');
});

test('a local type miss on a partial page is described as incomplete and still offers later pages', async () => {
  const h = harness(); h.S.completions = [row({ kind: 'meeting' })];
  h.S.completionMeta = { has_more: true, next_cursor: 'more' };
  await h.api.filter('kind', 'plan');
  const html = h.api.renderQueue();
  assert.match(html, /后续记录尚未读取/); assert.match(html, /加载更多审核记录/);
  assert.match(html, /已加载 1 条审核记录，当前类型匹配 0 条/);
  assert.doesNotMatch(html, /当前查询已读取完毕/);
});

test('query and page requests are single-flight; failures preserve rows, query and retry controls', async () => {
  let resolve, queryCalls = 0, pageCalls = 0;
  const h = harness(); h.S.completions = [row()]; h.S.completionQuery = { project_id: '', status: '' };
  h.S.completionMeta = { has_more: true, next_cursor: 'more' };
  h.options.queryCompletions = () => { queryCalls++; return new Promise(done => { resolve = done; }); };
  const pending = h.api.filter('status', 'approved');
  await h.api.filter('project_id', 'p2'); await h.api.loadMore(); assert.equal(queryCalls, 1);
  assert.match(h.api.renderQueue(), /正在按筛选条件读取/);
  resolve(false); await pending;
  assert.equal(h.S.completionQuery.status, ''); assert.equal(h.S.completions.length, 1);
  assert.match(h.api.renderQueue(), /已加载记录保留/);
  h.options.loadMoreCompletions = () => { pageCalls++; return new Promise(done => { resolve = done; }); };
  const paging = h.api.loadMore(); await h.api.loadMore(); assert.equal(pageCalls, 1);
  assert.match(h.api.renderQueue(), /正在加载/); resolve(false); await paging;
  assert.equal(h.S.completionMeta.has_more, true); assert.match(h.api.renderQueue(), /加载更多审核记录/);
});

test('late queue work cannot change the new session or selected project query', async () => {
  for (const change of [S => { S.pmProject = 'p2'; }, S => { S.session = {}; }, S => { S.pmPeriod = '第44周'; }]) {
    let resolve;
    const h = harness(); h.S.completionQuery = { project_id: '', status: '' };
    h.options.queryCompletions = () => new Promise(done => { resolve = done; });
    const pending = h.api.filter('status', 'approved'); change(h.S); h.api.configure(h.options);
    h.S.completionQuery = { project_id: 'new-project', status: 'pending' };
    resolve(true); await pending;
    assert.equal(h.S.completionQuery.project_id, 'new-project'); assert.equal(h.S.completionQuery.status, 'pending');
    assert.equal(h.messages.length, 0); assert.doesNotMatch(h.api.renderQueue(), /正在按筛选条件/);
  }
});

test('lost source access retains the request snapshot read-only and cannot be treated as approved or reviewed through', async () => {
  const h = harness(); h.S.profile.role = 'ops';
  h.S.completions = [row({source_access_lost: true, source_snapshot: {...preview, title: '原申请快照'}})];
  await h.api.open(key);
  assert.match(h.api.overlayHtml(), /原申请快照/);
  assert.match(h.api.overlayHtml(), /来源权限已变化/);
  assert.match(h.api.overlayHtml(), /onclick="CompletionReview.review\('approve'\)" disabled/);
  await h.api.review('approve'); assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1)[0], /暂不能通过审核/);
  h.S.completions[0].status = 'approved';
  assert.equal(h.api.approved(key), false);
});

test('a saved milestone review invokes the integration hook for milestone plus approval refresh', async () => {
  const refreshed = [];
  const h = harness({afterSaved: async saved => {refreshed.push(saved); return true;},
    request: async () => ({data: row({kind: 'milestone', status: 'approved', revision: 3})})});
  h.S.profile.role = 'ops'; h.S.completions = [row({kind: 'milestone'})];
  await h.api.open(key); await h.api.review('approve');
  assert.equal(refreshed.length, 1); assert.equal(refreshed[0].kind, 'milestone');
  assert.equal(h.loads, 0, 'the integration hook owns the complete affected-table refresh');
});
