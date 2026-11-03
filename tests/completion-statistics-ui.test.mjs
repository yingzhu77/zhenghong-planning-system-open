import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/completion-statistics.js', import.meta.url), 'utf8');
function fixture() {
  const window = {}, calls = [];
  let renders = 0;
  vm.runInNewContext(source, { window, Intl, Date, Map, Promise, Number, String, Object, JSON });
  const ui = window.CompletionStatistics;
  const S = { uid: 'anonymous-ops', session: {}, profile: { role: 'ops' }, view: 'completionStats', projects: [{ id: 'demo', name: '匿名项目' }] };
  const configure = () => ui.configure({ S,
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    render: () => renders++,
    request: (path, payload) => new Promise(resolve => calls.push({ path, payload, resolve })) });
  configure();
  return { ui, S, calls, configure, get renders() { return renders; } };
}
function result(number, name = '匿名员工') {
  return { data: { range: { start: '2026-10-19', end: '2026-10-25' }, filters: { projects: [], employees: [], disciplines: [], kinds: [] },
    totals: { completed: number }, employees: [{ user_id: 'employee', name, counts: { completed: number }, categories: [] }] }, error: null };
}

test('statistics render is pure and the page loader reuses its session query without recursive rendering', async () => {
  const h = fixture();
  assert.match(h.ui.pageHtml(), /员工事项完成统计/); assert.equal(h.calls.length, 0);
  const loading = h.ui.load(false), concurrent = h.ui.load(false);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/api/completions/statistics');
  assert.equal(h.renders, 0);
  h.calls[0].resolve(result(2, '<img src=x>'));
  assert.equal((await loading).error, null); assert.equal((await concurrent).error, null);
  assert.match(h.ui.pageHtml(), /&lt;img src=x>/); assert.doesNotMatch(h.ui.pageHtml(), /<img src=x>/);
  await h.ui.load(false); h.configure(); await h.ui.load(false);
  assert.equal(h.calls.length, 1); assert.equal(h.renders, 0);
});

test('changed filters and identity discard late statistics responses', async () => {
  const h = fixture(), old = h.ui.refresh(), newer = h.ui.filter('kind', 'meeting');
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(result(7, '新条件员工')); await newer;
  h.calls[0].resolve(result(99, '过期条件员工')); await old;
  assert.match(h.ui.pageHtml(), /新条件员工/); assert.doesNotMatch(h.ui.pageHtml(), /过期条件员工/);
  const staleIdentity = h.ui.refresh();
  h.S.uid = 'different-ops'; h.S.session = {}; h.configure();
  h.calls[2].resolve(result(88, '旧会话员工')); await staleIdentity;
  assert.doesNotMatch(h.ui.pageHtml(), /旧会话员工/);
  const fresh = h.ui.load(false); assert.equal(h.calls.length, 4);
  h.calls[3].resolve(result(1, '新会话员工')); await fresh;
  assert.match(h.ui.pageHtml(), /新会话员工/);
});

test('source invalidation prevents in-flight replies from restoring old counts', async () => {
  const h = fixture(), previous = h.ui.load(false);
  h.ui.invalidate();
  const latest = h.ui.load(false);
  h.calls[1].resolve(result(3, '审核后员工')); await latest;
  h.calls[0].resolve(result(8, '审核前员工')); await previous;
  assert.match(h.ui.pageHtml(), /审核后员工/); assert.doesNotMatch(h.ui.pageHtml(), /审核前员工/);
});

test('a statistics refresh cannot render a different page while its data is still loading', async () => {
  const h = fixture(), loading = h.ui.refresh();
  assert.equal(h.renders, 1, 'show the refresh busy state on the original page');
  h.S.view = 'members';
  h.calls[0].resolve(result(2)); await loading;
  assert.equal(h.renders, 1, 'leave the new page rendering to its own navigation');
  h.S.view = 'completionStats'; await h.ui.load(false);
  assert.equal(h.calls.length, 1, 'the completed query remains reusable when returning');
});

test('errors remain explicit, invalid dates are rejected, and non-operators cannot request statistics', async () => {
  const h = fixture(), loading = h.ui.load(false);
  h.calls[0].resolve({ data: null, error: { message: '匿名模拟故障' } });
  assert.equal((await loading).error.message, '匿名模拟故障');
  assert.match(h.ui.pageHtml(), /匿名模拟故障/); assert.equal(h.calls.length, 1);
  h.ui.filter('start', '2026-02-30');
  assert.ok((await h.ui.load(false)).error); assert.equal(h.calls.length, 1);
  h.S.profile.role = 'pm';
  assert.ok((await h.ui.load(true)).error); assert.match(h.ui.pageHtml(), /仅运营/); assert.equal(h.calls.length, 1);
});
