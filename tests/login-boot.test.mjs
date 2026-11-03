import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/login-boot.js', import.meta.url), 'utf8');
function fixture(failures = {}) {
  const names = ['planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'app.js', 'overview-meetings.js', 'admin-plan-overview.js', 'admin-plan-overview.css', 'project-plan-statistics.js', 'project-plan-statistics.css', 'coordination-workbench.js', 'monthly-plans.js', 'completion-statistics.js', 'completion-statistics.css', 'completion-review.js', 'completion-review.css', 'report-attachments.js', 'report-attachments.css',
    'reporter-tasks.js', 'reporter-tasks.css', 'reporter-workbench.css', 'reporter-archive.js', 'reporter-archive.css', 'admin-archive.js', 'admin-archive.css',
    'vendor/quill/quill.core.css', 'selection-format.css', 'vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'password-change.js', 'password-change.css', 'management-reader.js', 'management-reader.css'];
  const assets = Object.fromEntries(names.map(name => [name, '/assets/' + name])), downloads = [], removed = [], events = {};
  const form = {value: 'early-input', addEventListener(name, handler) {events[name] = handler;}, dispatchEvent() {form.submits++;}, submits: 0};
  const shell = {addEventListener(name, handler) {events['shell-' + name] = handler;}};
  const elements = {'planning-assets': {textContent: JSON.stringify(assets)}, authForm: form, msg: {textContent: ''}};
  const document = {getElementById: id => elements[id] || null, querySelector: selector => selector === '[data-initial-login]' ? shell : null,
    createElement(tag) {return {tagName: tag, remove() {removed.push(this.src || this.href);}};},
    head: {appendChild(element) {
      const url = element.src || element.href; assert.ok(url, 'every real asset key must resolve'); downloads.push(url);
      Promise.resolve().then(() => {
        if (failures[url] > 0) {failures[url]--; element.onerror();} else element.onload();
      });
    }}};
  const actions = [], session = Promise.resolve({data: null});
  const window = {WorkBuddyCloud: {createWorkBuddyCloud: () => ({auth: {getSession: () => session}})},
    App: {authTab: value => actions.push(['tab', value]), forgot: () => actions.push(['forgot'])}};
  const context = {window, document, Event: class {constructor(type, options) {this.type = type; Object.assign(this, options);}}};
  vm.createContext(context); new vm.Script(source, {filename: 'login-boot.js'}).runInContext(context);
  return {boot: window.PlanningBoot, downloads, removed, form, events, actions, session, elements};
}
const flushDownloads = () => new Promise(resolve => setImmediate(resolve));

test('the real login loader parses and exports workflow, reporter and editor gates on first execution', async () => {
  assert.doesNotThrow(() => new vm.Script(source, {filename: 'login-boot.js'}));
  const f = fixture();
  for (const name of ['ensureWorkflow', 'ensureReporter', 'ensureAdmin', 'ensureOverview', 'ensureCoordination', 'ensureStatistics', 'ensureProjectPlanStatistics', 'ensureManagementReader', 'ensureEditor', 'ensurePasswordChange', 'complete']) assert.equal(typeof f.boot[name], 'function');
  assert.equal(f.boot.session, f.session); assert.deepEqual(f.downloads, ['/assets/planning-windows.js']);
  await flushDownloads();
  assert.deepEqual(f.downloads, ['/assets/planning-windows.js', '/assets/report-scopes.js', '/assets/baseline-core.js', '/assets/app.js'], 'calendar, stable reporting scope and read-only baseline helpers must finish before app hydration');
  await f.boot.ensureWorkflow(true);
  for (const name of ['completion-review.js', 'completion-review.css', 'report-attachments.js', 'report-attachments.css']) assert.equal(f.downloads.filter(url => url.endsWith('/' + name)).length, 1);
});

test('workflow reads coalesce across simultaneous calls and attachments upgrade only adds their own assets', async () => {
  const f = fixture(); await Promise.all([f.boot.ensureWorkflow(false), f.boot.ensureWorkflow(false)]);
  assert.equal(f.downloads.some(url => url.includes('report-attachments')), false);
  await Promise.all([f.boot.ensureWorkflow(true), f.boot.ensureWorkflow(true), f.boot.ensureWorkflow(false)]);
  assert.equal(f.downloads.length, 8);
  assert.equal(new Set(f.downloads).size, 8);
});

test('a failed workflow download can be retried without discarding the successful attachment gate', async () => {
  const f = fixture({'/assets/completion-review.js': 1});
  await assert.rejects(f.boot.ensureWorkflow(true), /组件下载失败/);
  await f.boot.ensureWorkflow(true);
  assert.equal(f.downloads.filter(url => url === '/assets/completion-review.js').length, 2);
  assert.equal(f.downloads.filter(url => url === '/assets/completion-review.css').length, 2);
  assert.equal(f.downloads.filter(url => url === '/assets/report-attachments.js').length, 1);
  assert.ok(f.removed.includes('/assets/completion-review.js'));
});

test('editor dependencies finish before the real rich editor adapter is appended', async () => {
  const f = fixture(); await Promise.all([f.boot.ensureEditor(), f.boot.ensureEditor()]);
  assert.equal(f.downloads.filter(url => url.endsWith('/rich-editor.js')).length, 1);
  const editor = f.downloads.indexOf('/assets/rich-editor.js');
  for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'vendor/quill/quill.core.css', 'selection-format.css']) assert.ok(f.downloads.indexOf('/assets/' + name) < editor);
});

test('administrator archive assets load only on demand and reuse the shared archive', async () => {
  const f = fixture();
  assert.equal(f.downloads.some(url => url.includes('archive')), false);
  await Promise.all([f.boot.ensureAdmin(), f.boot.ensureAdmin()]);
  for (const name of ['reporter-archive.js', 'reporter-archive.css', 'admin-archive.js', 'admin-archive.css']) assert.equal(f.downloads.filter(url => url.endsWith('/' + name)).length, 1);
  await f.boot.ensureReporter('master');
  assert.equal(f.downloads.length, 8);
});

test('overview meeting and statistics gates load only their requested assets and coalesce repeated calls', async () => {
  const f = fixture(); await flushDownloads();
  assert.equal(f.downloads.some(url => /overview-meetings|completion-statistics/.test(url)), false);
  await Promise.all([f.boot.ensureOverview(), f.boot.ensureOverview()]);
  assert.equal(f.downloads.filter(url => url.endsWith('/overview-meetings.js')).length, 1);
  assert.equal(f.downloads.some(url => /completion-statistics/.test(url)), false);
  await Promise.all([f.boot.ensureStatistics(), f.boot.ensureStatistics()]);
  for (const name of ['completion-statistics.js', 'completion-statistics.css']) assert.equal(f.downloads.filter(url => url.endsWith('/' + name)).length, 1);
  assert.equal(f.downloads.length, 9);
  await Promise.all([f.boot.ensureProjectPlanStatistics(),f.boot.ensureProjectPlanStatistics()]);
  for(const name of ['project-plan-statistics.js','project-plan-statistics.css'])assert.equal(f.downloads.filter(url=>url.endsWith('/'+name)).length,1);
  assert.equal(f.downloads.length,11);
});

test('management reading loads on demand and can retry without loading editing components', async () => {
  const f = fixture({'/assets/management-reader.js': 1}); await flushDownloads();
  assert.equal(f.downloads.some(url => url.includes('management-reader')), false);
  await assert.rejects(f.boot.ensureManagementReader(), /组件下载失败/);
  await Promise.all([f.boot.ensureManagementReader(), f.boot.ensureManagementReader()]);
  for (const name of ['management-reader.js', 'management-reader.css'])
    assert.equal(f.downloads.filter(url => url.endsWith('/' + name)).length, 2);
  assert.equal(f.downloads.some(url => /admin-archive|rich-editor|reporter-tasks/.test(url)), false);
});

test('the coordination workbench downloads only on demand and simultaneous requests share its single asset', async () => {
  const f = fixture(); await flushDownloads();
  assert.equal(f.downloads.some(url => url.includes('coordination-workbench')), false);
  const before = f.downloads.slice();
  await Promise.all([f.boot.ensureCoordination(), f.boot.ensureCoordination(), f.boot.ensureCoordination()]);
  assert.deepEqual(f.downloads, [...before, '/assets/coordination-workbench.js']);
  await f.boot.ensureCoordination();
  assert.equal(f.downloads.filter(url => url.endsWith('/coordination-workbench.js')).length, 1);
});

test('a failed coordination workbench asset can retry without downloading unrelated components', async () => {
  const f = fixture({ '/assets/coordination-workbench.js': 1 }); await flushDownloads();
  const before = f.downloads.slice();
  await assert.rejects(f.boot.ensureCoordination(), /组件下载失败/);
  await Promise.all([f.boot.ensureCoordination(), f.boot.ensureCoordination()]);
  assert.deepEqual(f.downloads, [...before, '/assets/coordination-workbench.js', '/assets/coordination-workbench.js']);
  assert.ok(f.removed.includes('/assets/coordination-workbench.js'));
});

test('a failed calendar helper prevents app hydration and shows the existing login error', async () => {
  const f = fixture({'/assets/planning-windows.js': 1}); await flushDownloads();
  assert.deepEqual(f.downloads, ['/assets/planning-windows.js']);
  assert.match(f.elements.msg.textContent, /页面组件加载失败/);
  assert.ok(f.removed.includes('/assets/planning-windows.js'));
});

test('a failed reporting scope or baseline helper prevents app hydration without discarding early login input', async () => {
  for (const helper of ['report-scopes.js', 'baseline-core.js']) {
    const f = fixture({['/assets/' + helper]: 1}); await flushDownloads();
    assert.equal(f.downloads.filter(url => url === '/assets/planning-windows.js').length, 1);
    assert.equal(f.downloads.filter(url => url === '/assets/report-scopes.js').length, 1);
    assert.equal(f.downloads.filter(url => url === '/assets/baseline-core.js').length, 1);
    assert.equal(f.downloads.includes('/assets/app.js'), false);
    assert.match(f.elements.msg.textContent, /页面组件加载失败/);
    assert.equal(f.form.value, 'early-input');
    assert.ok(f.removed.includes('/assets/' + helper));
  }
});

test('early login interaction is replayed once after hydration without replacing existing input', () => {
  const f = fixture(); let prevented = 0;
  f.events.submit({preventDefault() {prevented++;}});
  assert.equal(prevented, 1); assert.equal(f.form.submits, 0);
  f.boot.complete(); f.boot.complete();
  assert.equal(f.form.submits, 1); assert.equal(f.form.value, 'early-input');
});

test('first-login password assets load on demand, coalesce, and retry a failed download', async () => {
  const f = fixture({'/assets/password-change.js': 1});
  assert.equal(f.downloads.some(url => url.includes('password-change')), false);
  await assert.rejects(f.boot.ensurePasswordChange(), /组件下载失败/);
  await Promise.all([f.boot.ensurePasswordChange(), f.boot.ensurePasswordChange()]);
  assert.equal(f.downloads.filter(url => url === '/assets/password-change.js').length, 2);
  assert.equal(f.downloads.filter(url => url === '/assets/password-change.css').length, 2);
  assert.equal(f.downloads.length, 8);
});
