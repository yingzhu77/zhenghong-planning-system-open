import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/coordination-workbench.js', import.meta.url), 'utf8');
const pm = { user_id: 'pm-p1', name: '匿名工程承办人', role: 'pm', discipline: '工程' };
const pm2 = { user_id: 'pm-p2', name: '匿名第二项目承办人', role: 'pm', discipline: '设计' };
const people = [pm, { user_id: 'leader', name: '不应出现的项目总候选', role: 'pzo' }, { user_id: 'operator', name: '不应出现的运营候选', role: 'ops' }];
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const clone = value => JSON.parse(JSON.stringify(value));
function row(extra = {}) {
  return { id: '11111111-1111-4111-8111-111111111111', project_id: 'p1', author_id: 'initiator', author_name: '匿名发起人',
    owner_id: pm.user_id, owner_name: pm.name, what: '既有独立协调事项', due: '2026-11-02', created_at: '2026-10-21T00:00:00Z',
    source_key: 'coordtask:p1:11111111-1111-4111-8111-111111111111', ...extra };
}
function harness(handler, overrides = {}) {
  const calls = [], peopleCalls = [], messages = [], elements = {};
  let renders = 0, storageCalls = 0, uuid = 0;
  const S = { uid: 'initiator', session: {}, profile: { role: 'pm' }, pmProject: 'p1', view: 'pm',
    projects: [{ id: 'p1', name: '匿名项目一' }, { id: 'p2', name: '匿名项目二' }], coordinationTasks: [],
    reports: [{ id: 'original-report', biz: { followups: [{ source_key: 'old' }] } }], biz: { items: [{ name: '原填报' }] }, coordRows: [{ who_id: 'old-owner', what: '原协调行' }] };
  const sandbox = { document: { getElementById: id => elements[id] || null },
    crypto: { randomUUID: () => '22222222-2222-4222-8222-' + String(++uuid).padStart(12, '0') },
    localStorage: { getItem() { storageCalls++; return null; }, setItem() { storageCalls++; }, removeItem() { storageCalls++; } } };
  sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.CoordinationWorkbench;
  const options = { S, esc, render: () => renders++, toast: (...args) => messages.push(args),
    loadPeople: async pid => { peopleCalls.push(pid); return { data: pid === 'p2' ? [pm2] : people, error: null }; },
    request: async (url, body) => {
      calls.push({ url, body: clone(body) });
      return handler ? handler(url, body) : url.endsWith('/list') ? { data: [row()], error: null } : { data: row(body), error: null };
    }, ...overrides };
  api.configure(options);
  return { S, api, options, calls, peopleCalls, messages, elements, get renders() { return renders; }, get storageCalls() { return storageCalls; } };
}
function fill(h, pid = 'p1', what = '需要核对的匿名协调事项') {
  h.api.change(pid, 'owner_id', pid === 'p2' ? pm2.user_id : pm.user_id);
  h.api.change(pid, 'what', what); h.api.change(pid, 'due', '2026-11-02');
}
function creates(h) { return h.calls.filter(call => call.url === '/api/coordination-tasks/create'); }

test('coordination rendering and loading are pure, repeated loading shares the query and uses the session cache', async () => {
  let finish;
  const h = harness(url => url.endsWith('/list') ? new Promise(resolve => { finish = resolve; }) : { data: row(), error: null });
  h.api.render({ project_id: 'p1' }); h.api.render('p1');
  assert.equal(h.calls.length, 0); assert.equal(h.peopleCalls.length, 0, 'render must not lazily request candidates');
  const first = h.api.load('p1', false), second = h.api.load('p1', false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { url: '/api/coordination-tasks/list', body: { project_id: 'p1' } });
  finish({ data: [row()], error: null });
  assert.equal((await first).error, null); assert.equal((await second).error, null);
  assert.equal(h.renders, 0, 'loader cannot render recursively');
  await h.api.load('p1', false); h.api.configure(h.options); await h.api.load('p1', false);
  assert.equal(h.calls.length, 1); assert.equal(h.peopleCalls.length, 1);
  assert.match(h.api.render('p1'), /既有独立协调事项/);
});

test('the initiator sees only their own rows and only PM candidates can be selected', async () => {
  const h = harness(() => ({ data: [row(), row({ id: 'incoming', author_id: 'another-author', owner_id: 'initiator', what: '不应放进发起栏的收到事项' })], error: null }));
  await h.api.load('p1');
  const html = h.api.render({ project_id: 'p1' });
  assert.match(html, /既有独立协调事项/); assert.doesNotMatch(html, /不应放进发起栏的收到事项/);
  assert.match(html, /匿名工程承办人/);
  assert.doesNotMatch(html, /不应出现的项目总候选|不应出现的运营候选/);
  assert.doesNotMatch(html, /CompletionReview\.request|提交完成申请|完成／延期申报/, 'the initiator cannot submit on behalf of the recipient here');
});

test('project list refresh replaces only its own rows and preserves records belonging to other projects', async () => {
  const h = harness();
  h.S.coordinationTasks = [row({ id: 'preserved-p2', project_id: 'p2', what: '第二项目保留事项' }), row({ id: 'obsolete-p1', what: '旧项目列表条目' })];
  await h.api.load('p1', true);
  assert.equal(h.S.coordinationTasks.some(item => item.id === 'preserved-p2'), true);
  assert.equal(h.S.coordinationTasks.some(item => item.id === 'obsolete-p1'), false);
  assert.match(h.api.render('p1'), /既有独立协调事项/); assert.doesNotMatch(h.api.render('p1'), /第二项目保留事项/);
});

test('creating a task writes only coordinationTasks with an explicit stable id and leaves report state and storage intact', async () => {
  const h = harness(); await h.api.load('p1');
  const before = clone({ reports: h.S.reports, biz: h.S.biz, coordRows: h.S.coordRows });
  fill(h); await h.api.create('p1');
  const call = creates(h)[0]; assert.ok(call);
  assert.deepEqual(Object.keys(call.body).sort(), ['due', 'id', 'owner_id', 'project_id', 'what']);
  assert.match(call.body.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(call.body.project_id, 'p1'); assert.equal(call.body.owner_id, pm.user_id);
  assert.equal(h.S.coordinationTasks.some(item => item.id === call.body.id && item.what === call.body.what), true);
  assert.deepEqual(clone({ reports: h.S.reports, biz: h.S.biz, coordRows: h.S.coordRows }), before);
  assert.equal(h.storageCalls, 0);
  await h.api.create('p1'); assert.equal(creates(h).length, 1, 'a cleared successful draft cannot submit the same task again');
  fill(h, 'p1', '下一条协调事项'); await h.api.create('p1');
  assert.notEqual(creates(h)[1].body.id, call.body.id, 'the next successful draft gets a new id');
});

test('selection, content and calendar-date validation block invalid requests before a write', async () => {
  const h = harness(); await h.api.load('p1');
  fill(h); h.api.change('p1', 'owner_id', 'leader'); await h.api.create('p1');
  assert.equal(creates(h).length, 0);
  h.api.change('p1', 'owner_id', pm.user_id); h.api.change('p1', 'what', '  '); await h.api.create('p1');
  assert.equal(creates(h).length, 0);
  h.api.change('p1', 'what', '有效事项'); h.api.change('p1', 'due', '2026-02-30'); await h.api.create('p1');
  assert.equal(creates(h).length, 0);
  h.api.change('p1', 'due', '2026-11-02'); await h.api.create('p1'); assert.equal(creates(h).length, 1);
});

test('double-click creation is single-flight and failure preserves values plus the exact id for retry', async () => {
  let finish, failure = true;
  const h = harness((url, body) => url.endsWith('/list') ? { data: [], error: null }
    : failure ? new Promise(resolve => { finish = resolve; }) : { data: row(body), error: null });
  await h.api.load('p1'); fill(h, 'p1', '<需要保留的草稿>');
  const pending = h.api.create('p1'); await h.api.create('p1');
  assert.equal(creates(h).length, 1);
  finish({ data: null, error: { code: 'NETWORK_ERROR', message: '匿名连接中断' } }); await pending;
  h.api.configure(h.options);
  const html = h.api.render('p1');
  assert.match(html, /&lt;需要保留的草稿&gt;/); assert.match(html, /2026-11-02/); assert.match(html, /匿名连接中断/);
  assert.equal(h.S.coordinationTasks.length, 0);
  failure = false; await h.api.create('p1');
  assert.deepEqual(creates(h)[1].body, creates(h)[0].body, 'uncertain requests are retried with the same id and content');
});

test('a create conflict displays its actual error and keeps the draft without claiming a successful save', async () => {
  const h = harness(url => url.endsWith('/list') ? { data: [], error: null }
    : { data: null, error: { status: 409, code: 'coordination_id_conflict', message: '同一请求标识已保存不同事项，请核对原记录' } });
  await h.api.load('p1'); fill(h, 'p1', '冲突后应保留的事项'); await h.api.create('p1');
  const html = h.api.render('p1');
  assert.match(html, /同一请求标识已保存不同事项|同一请求标识|已保存不同事项/);
  assert.match(html, /冲突后应保留的事项/);
  assert.equal(h.S.coordinationTasks.length, 0);
  assert.equal(h.messages.some(message => /已创建|已保存成功|已发起/.test(message[0])), false);
});

test('a shell capture of unchanged fields preserves a create failure until the user edits the draft',async()=>{
  const h=harness(url=>url.endsWith('/list')?{data:[],error:null}:{data:null,error:{code:'HTTP_503',message:'已提交后响应中断，请重试'}});
  await h.api.load('p1');fill(h,'p1','保留错误的协调草稿');
  h.elements.coordination_owner_id_p1={value:pm.user_id};
  h.elements.coordination_what_p1={value:'保留错误的协调草稿'};
  h.elements.coordination_due_p1={value:'2026-11-02'};
  let rendered='';h.options.render=()=>{h.api.capture();rendered=h.api.render('p1');};h.api.configure(h.options);
  await h.api.create('p1');
  assert.match(rendered,/<p class="completion-error" role="alert">已提交后响应中断，请重试<\/p>/);
  h.api.capture();assert.match(h.api.render('p1'),/已提交后响应中断，请重试/);
  h.api.change('p1','what','实际改动后的协调草稿');
  assert.doesNotMatch(h.api.render('p1'),/已提交后响应中断，请重试/);
});

test('drafts are isolated per project and are cleared when the identity or session changes', async () => {
  const h = harness(() => ({ data: [], error: null }));
  await h.api.load('p1'); fill(h, 'p1', '项目一会话草稿');
  h.S.pmProject = 'p2'; h.api.configure(h.options); await h.api.load('p2'); fill(h, 'p2', '项目二会话草稿');
  assert.match(h.api.render('p2'), /项目二会话草稿/); assert.doesNotMatch(h.api.render('p2'), /项目一会话草稿/);
  h.S.pmProject = 'p1'; h.api.configure(h.options);
  assert.match(h.api.render('p1'), /项目一会话草稿/); assert.doesNotMatch(h.api.render('p1'), /项目二会话草稿/);
  h.S.uid = 'another-pm'; h.S.session = {}; h.api.configure(h.options);
  assert.doesNotMatch(h.api.render('p1'), /项目一会话草稿/); assert.doesNotMatch(h.api.render('p2'), /项目二会话草稿/);
  assert.equal(h.storageCalls, 0);
});

test('late create responses cannot insert old-identity data or replace the newly selected project draft', async () => {
  for (const change of [h => { h.S.uid = 'new-pm'; h.S.session = {}; }, h => { h.S.pmProject = 'p2'; }]) {
    let finish;
    const h = harness((url, body) => url.endsWith('/list') ? { data: [], error: null } : new Promise(resolve => { finish = () => resolve({ data: row(body), error: null }); }));
    await h.api.load('p1'); fill(h, 'p1', '旧请求内容');
    const pending = h.api.create('p1'); change(h); h.api.configure(h.options);
    if (h.S.pmProject === 'p2') { await h.api.load('p2'); fill(h, 'p2', '新项目必须保留的草稿'); }
    finish(); await pending;
    if (h.S.pmProject === 'p2') {
      assert.match(h.api.render('p2'), /新项目必须保留的草稿/); assert.doesNotMatch(h.api.render('p2'), /旧请求内容/);
      assert.equal(h.S.coordinationTasks.some(item => item.project_id === 'p2' && item.what === '旧请求内容'), false);
    } else assert.equal(h.S.coordinationTasks.some(item => item.what === '旧请求内容'), false);
  }
});

test('late list responses cannot overwrite data obtained for a new session or project', async () => {
  let finish;
  const h = harness((url, body) => body.project_id === 'p1' ? new Promise(resolve => { finish = resolve; })
    : { data: [row({ id: 'new-project-row', project_id: 'p2', what: '新项目查询内容' })], error: null });
  const old = h.api.load('p1'); h.S.pmProject = 'p2'; h.api.configure(h.options); await h.api.load('p2');
  finish({ data: [row({ what: '旧项目迟响应内容' })], error: null }); await old;
  assert.match(h.api.render('p2'), /新项目查询内容/); assert.doesNotMatch(h.api.render('p2'), /旧项目迟响应内容/);
  assert.equal(h.S.coordinationTasks.some(item => item.project_id === 'p2' && item.what === '旧项目迟响应内容'), false);
});

test('successful creation remains successful if its refresh hook fails and cannot repeat the persisted request', async () => {
  const h = harness((url, body) => url.endsWith('/list') ? { data: [], error: null } : { data: row(body), error: null },
    { afterCreated: async () => { throw new Error('匿名刷新故障'); } });
  await h.api.load('p1'); fill(h); await h.api.create('p1');
  assert.equal(creates(h).length, 1); assert.equal(h.S.coordinationTasks.length, 1);
  assert.match(h.api.render('p1') + h.messages.map(item => item[0]).join(' '), /已保存|已创建|已发起/);
  assert.match(h.api.render('p1') + h.messages.map(item => item[0]).join(' '), /刷新.*失败|刷新.*故障/);
  await h.api.create('p1'); assert.equal(creates(h).length, 1);
});

test('capture reads only the current project plain fields before creation', async () => {
  const h = harness(); await h.api.load('p1');
  const html = h.api.render('p1');
  const textId = /<textarea[^>]*id="([^"]+)"/.exec(html)?.[1];
  const ownerId = /<select[^>]*id="([^"]+)"/.exec(html)?.[1];
  const dueTag = /<input[^>]*type="date"[^>]*>/.exec(html)?.[0] || '';
  const dueId = /id="([^"]+)"/.exec(dueTag)?.[1];
  assert.ok(textId); assert.ok(ownerId); assert.ok(dueId);
  h.elements[textId] = { value: '从普通文本框采集的协调事项' }; h.elements[ownerId] = { value: pm.user_id }; h.elements[dueId] = { value: '2026-11-02' };
  h.api.capture(); await h.api.create('p1');
  assert.equal(creates(h)[0].body.what, '从普通文本框采集的协调事项');
  assert.equal(creates(h)[0].body.owner_id, pm.user_id); assert.equal(creates(h)[0].body.due, '2026-11-02');
});

test('a delayed pre-create list cannot erase a task created after candidates were loaded', async () => {
  for (const projectId of ['p1', undefined]) {
    let finishList;
    const h = harness((url, body) => url.endsWith('/list') ? new Promise(resolve => { finishList = resolve; }) : { data: row(body), error: null });
    const listing = h.api.load(projectId, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(h.api.render('p1'), /匿名工程承办人/);
    fill(h, 'p1', '列表请求期间已成功发起的协调事项'); await h.api.create('p1');
    assert.equal(creates(h).length, 1); assert.equal(h.S.coordinationTasks.length, 1);
    const savedId = creates(h)[0].body.id;
    finishList({ data: [], error: null }); await listing;
    assert.equal(h.S.coordinationTasks.some(item => item.id === savedId), true);
    assert.match(h.api.render('p1'), /列表请求期间已成功发起的协调事项/);
    assert.deepEqual(h.calls[0].body, projectId ? { project_id: projectId } : {});
  }
});
