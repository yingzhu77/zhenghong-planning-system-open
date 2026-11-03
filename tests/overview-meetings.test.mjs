import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/overview-meetings.js', import.meta.url), 'utf8');
const richSource = fs.readFileSync(new URL('../web/rich-text.js', import.meta.url), 'utf8');
const candidate = { user_id: 'pm-1', name: '匿名承办人', role: 'pm', discipline: '工程', biz_line: '机电工程' };
const saved = { id: 'same-task', project_id: 'p1', owner_id: candidate.user_id, owner_name: candidate.name,
  meeting_kind: 'requirement', proposer_id: 'leader', proposer_role: 'pzo', proposer_name: '匿名领导',
  title: '既有会议', what: '原事项', due: '2026-10-25', progress: '原进展', status: 'in_progress', revision: 3 };
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function harness(overrides = {}) {
  const elements = {}, calls = [], messages = [];
  const S = { uid: 'ops', session: {}, profile: { role: 'ops' }, projects: [{ id: 'p1' }], reporterTasks: [] };
  const sandbox = { document: { getElementById: id => elements[id] || null } }; sandbox.window = sandbox;
  vm.createContext(sandbox); vm.runInContext(richSource, sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.OverviewMeetings;
  const options = { S, esc, render() {}, toast: (...args) => messages.push(args),
    richCopy: (...args) => sandbox.ZHRichText.copy(...args), richCollect: row => sandbox.ZHRichText.collect(row), richItem: (...args) => sandbox.ZHRichText.field(...args),
    loadPeople: async () => ({ data: [candidate, { user_id: 'leader', role: 'pzo', name: '匿名领导' }] }),
    request: async (url, body) => { calls.push({ url, body }); return { data: { ...saved, ...body } }; }, ...overrides };
  api.configure(options);
  async function ready() { api.html('p1', '工程', false, ['工程']); await new Promise(resolve => setImmediate(resolve)); }
  return { api, S, options, elements, calls, messages, ready };
}

test('the overview uses authorized project people and exact owner expertise to group the same task', async () => {
  let loads = 0;
  const h = harness({ loadPeople: async () => { loads++; return { data: [candidate] }; } });
  h.S.reporterTasks = [saved, { ...saved, id: 'unknown', owner_id: 'retired-owner', what: '未归属旧事项' }, { ...saved, id: 'foreign', project_id: 'p2', what: '其他项目' }];
  await h.ready();
  const engineering = h.api.html('p1', '工程', false, ['工程']);
  assert.match(engineering, /原事项/); assert.doesNotMatch(engineering, /未归属旧事项|其他项目/);
  assert.match(h.api.html('p1', null, false, ['工程']), /未归属旧事项/);
  assert.match(h.api.html('p1', '机电工程', true, ['机电工程']), /原事项/);
  assert.equal(h.api.html('p2', '工程', false, ['工程']), '');
  h.api.html('p1', '工程', false, ['工程']); assert.equal(loads, 1);
  h.S.uid = 'another-leader'; h.S.profile = { role: 'pzo', name: '另一项目总' }; h.api.configure(h.options); await h.ready();
  const leaderView = h.api.html('p1', '工程', false, ['工程']);
  assert.match(leaderView, /原事项/); assert.doesNotMatch(leaderView, /OverviewMeetings\.edit\(/);
  assert.equal(h.api.edit(0, 0), undefined, 'another proposer may read an authorized project but cannot maintain its requirement');
  h.S.projects = []; assert.equal(h.api.html('p1', '工程', false, ['工程']), '');
});

test('inline save creates one shared reporter task and excludes leaders from assignment', async () => {
  const h = harness(); await h.ready();
  const number = h.api.add(0);
  h.api.change(number, 'owner_id', 'leader'); h.api.change(number, 'what', '执行要求');
  await h.api.save(number); assert.equal(h.calls.length, 0); assert.match(h.messages.at(-1)[0], /有效填报人/);
  h.api.change(number, 'owner_id', candidate.user_id); h.api.change(number, 'due', '2026-10-25'); h.api.change(number, 'proposer_id', 'leader');
  await h.api.save(number);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/reporter-tasks/save');
  assert.equal(h.calls[0].body.owner_id, candidate.user_id); assert.equal(h.calls[0].body.project_id, 'p1');
  assert.equal(h.calls[0].body.meeting_kind, 'requirement'); assert.equal(h.calls[0].body.proposer_id, 'leader');
  assert.equal(h.calls[0].body.expected_revision, undefined); assert.equal(h.S.reporterTasks.length, 1);
  await h.api.save(number); assert.equal(h.calls.length, 1, 'a successful draft cannot be submitted again');
});

test('the pending save blocks repeated clicks and a failed response preserves every draft value across configure', async () => {
  let release, count = 0;
  const h = harness({ request: async () => { count++; return new Promise(resolve => { release = resolve; }); } }); await h.ready();
  const number = h.api.add(0); h.api.change(number, 'owner_id', candidate.user_id); h.api.change(number, 'what', '<待核对事项>'); h.api.change(number, 'due', '2026-10-29');
  h.api.change(number, 'proposer_id', 'leader');
  const pending = h.api.save(number); await h.api.save(number); assert.equal(count, 1);
  release({ error: { message: '模拟网络失败' } }); await pending;
  h.api.configure(h.options);
  const html = h.api.html('p1', '工程', false, ['工程']);
  assert.match(html, /&lt;待核对事项&gt;/); assert.match(html, /value="2026-10-29"/); assert.match(html, /模拟网络失败/);
  assert.equal(h.S.reporterTasks.length, 0);
});

test('editing sends the original task id and revision, preserves progress and retains conflict input', async () => {
  let body;
  const h = harness({ request: async (_url, value) => { body = value; return { error: { code: 'revision_conflict' } }; } });
  h.S.reporterTasks = [saved]; await h.ready();
  const number = h.api.edit(0, 0); assert.equal(h.api.edit(0, 0), number);
  h.api.change(number, 'what', '修改的会议要求'); await h.api.save(number);
  assert.equal(body.id, saved.id); assert.equal(body.expected_revision, saved.revision);
  assert.equal(body.meeting_kind, saved.meeting_kind); assert.equal(body.proposer_id, saved.proposer_id);
  assert.equal(body.progress, saved.progress); assert.equal(body.status, saved.status);
  const html = h.api.html('p1', '工程', false, ['工程']);
  assert.match(html, /事项已被其他页面更新/); assert.match(html, /修改的会议要求/);
  assert.equal(h.S.reporterTasks[0].what, saved.what);
});

test('rich binding preserves formatting while field capture keeps plain values in session memory', async () => {
  const h = harness(); await h.ready();
  const number = h.api.add(0), id = 'overview_meeting_what_' + number;
  h.api.binding(id).set({ ops: [{ insert: '红色要求', attributes: { color: '#d81e06', bold: true } }] });
  h.elements['overview_meeting_owner_' + number] = { value: candidate.user_id };
  h.elements['overview_meeting_proposer_' + number] = { value: 'leader' };
  h.elements['overview_meeting_what_' + number] = { value: '红色要求' };
  h.elements['overview_meeting_due_' + number] = { value: '2026-10-25' };
  h.api.capture(); await h.api.save(number);
  const value = h.calls[0].body;
  assert.equal(value.proposer_id, 'leader');
  assert.equal(value.what, '红色要求'); assert.equal(value.rich_text.fields.what.ops[0].attributes.bold, true);
  assert.equal(value.rich_text.fields.what.ops[0].attributes.color, '#d81e06');
});

test('a session change clears drafts and ignores a response from the former operator session', async () => {
  let release;
  const h = harness({ request: async () => new Promise(resolve => { release = resolve; }) }); await h.ready();
  const number = h.api.add(0); h.api.change(number, 'owner_id', candidate.user_id); h.api.change(number, 'what', '旧会话草稿');
  h.api.change(number, 'proposer_id', 'leader');
  const pending = h.api.save(number);
  h.S.session = {}; h.api.configure(h.options); release({ data: saved }); await pending;
  assert.equal(h.S.reporterTasks.length, 0);
  assert.doesNotMatch(h.api.html('p1', '工程', false, ['工程']), /旧会话草稿/);
});
