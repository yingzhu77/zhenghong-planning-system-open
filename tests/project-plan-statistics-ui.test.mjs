import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { webAssets } from '../server/web-assets.mjs';

const source = readFileSync(new URL('../web/project-plan-statistics.js', import.meta.url), 'utf8');
function fixture(role = 'ops') {
  const window = {}, calls = [];
  let renders = 0;
  vm.runInNewContext(source, { window, Intl, Date, Map, Promise, Number, String, Object, JSON });
  const ui = window.ProjectPlanStatistics;
  const S = { uid: 'anonymous-reader', session: {}, profile: { role }, view: 'projectPlanStats' };
  const configure = () => ui.configure({ S,
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    render: () => renders++, request: (path, payload) => new Promise(resolve => calls.push({ path, payload, resolve })) });
  configure();
  return { ui, S, calls, configure, get renders() { return renders; } };
}
function result(title = '匿名基准节点') {
  return { data: { today: '2026-10-22', source: 'all_baseline', filters: { kind: 'all' },
    options: { projects: [{ id: 'p1', name: '匿名一期', display_group: '匿名展示组', project_type: 'res' }], groups: ['匿名展示组'], disciplines: ['土建'], levels: ['一级'] },
    rows: [{ id: 'n1', source_id: 'n1', source_key: 'milestone:n1', project_id: 'p1', project_type: 'res', project_name: '匿名一期', display_group: '匿名展示组', discipline: '土建', title,
      plan_due: '2026-10-20', effective_due: '2026-10-30', forecast_due: '', completed: false, completion_basis: 'none', completion_date: '', deviation: null,
      risk: 'insufficient', overdue: false, due_next30: true, insufficient: true, is_key: true, level: '一级', extension_approved: true }],
    totals: { total: 1, completed: 0, incomplete: 1, completion_rate: 0, overdue: 0, forecast_delayed: 0, due_next30: 1, insufficient: 1,
      on_time: 0, late: 0, timeliness_covered: 0, timeliness_unknown: 0, project_count: 1, group_count: 1 },
    projects: [{ id: 'p1', name: '匿名一期', project_type: 'res', display_group: '匿名展示组', total: 1, completed: 0, completion_rate: 0, insufficient: 1 }] }, error: null };
}
function mixedResult() {
  const value = result('住宅原基准节点'), row = value.data.rows[0];
  value.data.rows.push({ ...row, id: 'n2', source_id: 'n2', source_key: 'milestone:p2:2', project_id: 'p2', project_type: 'com',
    project_name: '匿名商业项目', title: '商业原基准节点', discipline: '成本', module: '成本', forecast_due: '2026-10-25', deviation: 5, risk: 'attention', insufficient: false });
  value.data.options.projects.push({ id: 'p2', name: '匿名商业项目', display_group: '匿名展示组', project_type: 'com' },
    { id: 'p3', name: '其他商业项目', display_group: '商业展示组', project_type: 'com' });
  value.data.options.groups.push('商业展示组'); value.data.options.disciplines.push('成本', '未归属');
  value.data.totals = { ...value.data.totals, total: 2, incomplete: 2, forecast_delayed: 1, due_next30: 2, project_count: 2 };
  value.data.projects.push({ ...value.data.projects[0], id: 'p2', name: '匿名商业项目', project_type: 'com', insufficient: 0 });
  return value;
}
async function resolveNext(h, value = result()) {
  const task = h.ui.load(); h.calls.at(-1).resolve(value); await task;
}

test('one server-filtered result defines cards, comparison, rows and export; rendering never issues requests', async () => {
  const h = fixture();
  assert.match(h.ui.pageHtml(), /项目计划统计/); assert.doesNotMatch(h.ui.pageHtml(), /已授权住宅与商业项目的基准节点|统计来源|project-statistics-switch/); assert.equal(h.calls.length, 0);
  const first = h.ui.load(), concurrent = h.ui.load();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/api/project-plan-statistics');
  assert.equal(h.calls[0].payload.kind, 'all'); assert.equal(h.calls[0].payload.date_mode, 'all');
  assert.equal(h.renders, 0);
  h.calls[0].resolve(result('<img src=x>'));
  await first; await concurrent;
  const html = h.ui.pageHtml();
  assert.match(html, /项目对比/); assert.match(html, /计划明细/); assert.match(html, /日期不足/); assert.match(html, /无法判断/);
  assert.match(html, /&lt;img src=x>/); assert.doesNotMatch(html, /<img src=x>/); assert.match(html, /1 个展示组 \/ 1 个实际项目／分期/);
  assert.match(h.ui.csvText(), /<img src=x>/); assert.match(h.ui.csvText(), /milestone:n1/); assert.match(h.ui.csvText(), /2026-10-20","2026-10-30","是"/);
  await h.ui.load(); h.configure(); await h.ui.load(); assert.equal(h.calls.length, 1);
});

test('filter changes discard stale replies and block exporting a previous query', async () => {
  const h = fixture(); await resolveNext(h, result('原结果'));
  const old = h.ui.refresh(), newer = h.ui.filter('risk', 'insufficient');
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].payload.risk, 'insufficient');
  assert.equal(h.ui.csvText(), '', 'busy query never exports old rows');
  h.calls[2].resolve(result('筛选结果')); await newer;
  h.calls[1].resolve(result('过期响应')); await old;
  assert.match(h.ui.pageHtml(), /筛选结果/); assert.doesNotMatch(h.ui.pageHtml(), /过期响应/);
  assert.match(h.ui.csvText(), /筛选结果/); assert.doesNotMatch(h.ui.csvText(), /原结果|过期响应/);
  h.ui.filter('date_mode', 'custom'); h.ui.filter('start', '2026-02-30');
  assert.equal(h.ui.csvText(), ''); assert.equal((await h.ui.load()).data, null); assert.equal(h.calls.length, 3);
  assert.match(h.ui.pageHtml(), /有效的计划起止日期/);
});

test('unified project groups include residential and commercial projects while legacy kind controls cannot narrow requests', async () => {
  const h = fixture(), mixed = mixedResult(); await resolveNext(h, mixed);
  assert.doesNotMatch(h.ui.pageHtml(), /已授权住宅与商业项目的基准节点|默认纳入全部原计划日期/); assert.match(h.ui.pageHtml(), /全部计划日期/);
  assert.match(h.ui.pageHtml(), /<th>预计偏差<\/th>/); assert.match(h.ui.pageHtml(), /节点范围|全部层级/);
  assert.match(h.ui.pageHtml(), /专业 \/ 模块/); assert.match(h.ui.pageHtml(), /商业展示组/);
  assert.doesNotMatch(h.ui.pageHtml(), /type="month"|<th>反馈<\/th>|确认月份|统计来源|project-statistics-switch/);
  const csv = h.ui.csvText(); assert.match(csv, /住宅基准节点/); assert.match(csv, /商业基准节点/); assert.match(csv, /2026-10-25","5"/);
  assert.equal(csv.split('\r\n').length, mixed.data.rows.length + 1);
  assert.doesNotMatch(h.ui.csvText(), /确认月份|未反馈|商业确认月计划/);
  h.ui.filter('kind', 'res'); h.ui.filter('kind', 'com'); assert.equal(h.calls.length, 1, 'obsolete tabs cannot reintroduce a type-only query');
  const group = h.ui.filter('display_group', '匿名展示组'); h.calls.at(-1).resolve(mixed); await group;
  const actualProjects = h.ui.pageHtml().match(/<select aria-label="实际项目／分期"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(actualProjects, /value="p1"/); assert.match(actualProjects, /value="p2"/); assert.doesNotMatch(actualProjects, /value="p3"/);
  const commercial = structuredClone(mixed); commercial.data.rows = [mixed.data.rows[1]]; commercial.data.projects = [mixed.data.projects[1]];
  commercial.data.totals = { ...mixed.data.totals, total: 1, incomplete: 1, insufficient: 0, due_next30: 1, project_count: 1 };
  const project = h.ui.filter('project_id', 'p2');
  assert.equal(h.calls.at(-1).payload.kind, 'all'); assert.equal(h.calls.at(-1).payload.project_id, 'p2'); assert.equal(h.calls.at(-1).payload.month, undefined);
  h.calls.at(-1).resolve(commercial); await project;
  const keyed = h.ui.filter('key_only', 'true'); assert.equal(h.calls.at(-1).payload.key_only, true); h.calls.at(-1).resolve(commercial); await keyed;
  const level = h.ui.filter('level', '一级'); assert.equal(h.calls.at(-1).payload.level, '一级'); h.calls.at(-1).resolve(commercial); await level;
  h.ui.filter('date_mode', 'custom'); h.ui.filter('start', '2026-10-01'); h.ui.filter('end', '2026-10-31');
  const query = h.ui.refresh();
  assert.equal(h.calls.at(-1).payload.display_group, '匿名展示组'); assert.equal(h.calls.at(-1).payload.start, '2026-10-01'); assert.equal(h.calls.at(-1).payload.end, '2026-10-31');
  h.calls.at(-1).resolve(commercial); await query;
  assert.match(h.ui.csvText(), /商业基准节点/); assert.match(h.ui.csvText(), /商业原基准节点/);
  const reset = h.ui.reset();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).payload)), { kind: 'all', completion: 'all', risk: 'all', date_mode: 'all', key_only: false });
  h.calls.at(-1).resolve(mixed); await reset;
  assert.match(h.ui.csvText(), /住宅原基准节点/); assert.match(h.ui.csvText(), /商业原基准节点/);
  assert.ok(h.calls.every(call => call.payload.kind === 'all'));
});

test('exports neutralize spreadsheet formulas, preserve quoted newlines, and expose unknown completion timeliness', async () => {
  const h = fixture(), value = result(' =HYPERLINK("https://example.invalid")\n第二行');
  value.data.rows[0] = { ...value.data.rows[0], completed: true, completion_basis: 'legacy', on_time: null, risk: 'completed', source_id: '@source', source_key: '\t=source' };
  value.data.totals.completed = 1; value.data.totals.timeliness_unknown = 1;
  await resolveNext(h, value);
  const csv = h.ui.csvText();
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\' =HYPERLINK(""https://example.invalid"")\n第二行"'));
  assert.ok(csv.includes('"\'@source"')); assert.ok(csv.includes('"\'\t=source"'));
  assert.match(csv, /历史完成标记/); assert.match(csv, /无法判断按时性/); assert.match(h.ui.pageHtml(), /无法判断按时性 1 项/);
});

test('session changes and invalidation prevent stale data from reappearing; background replies never render a new route', async () => {
  const h = fixture(), stale = h.ui.load();
  h.ui.invalidate(); const latest = h.ui.load(); h.calls[1].resolve(result('当前审批状态')); await latest;
  h.calls[0].resolve(result('旧审批状态')); await stale;
  assert.match(h.ui.pageHtml(), /当前审批状态/); assert.doesNotMatch(h.ui.pageHtml(), /旧审批状态/);
  const oldSession = h.ui.refresh(); h.S.uid = 'other-reader'; h.S.session = {}; h.configure();
  h.calls[2].resolve(result('旧会话')); await oldSession; assert.doesNotMatch(h.ui.pageHtml(), /旧会话/);
  const refresh = h.ui.refresh(), renders = h.renders; h.S.view = 'members';
  h.calls[3].resolve(result('新会话')); await refresh; assert.equal(h.renders, renders);
});

test('ops, president and pzo can read while pm cannot; request failure remains explicit', async () => {
  for (const role of ['ops', 'president', 'pzo']) {
    const h = fixture(role); await resolveNext(h); assert.match(h.ui.pageHtml(), /匿名基准节点/);
  }
  const h = fixture('pm'); assert.ok((await h.ui.load()).error); assert.equal(h.calls.length, 0); assert.equal(h.ui.csvText(), '');
  assert.match(h.ui.pageHtml(), /仅获授权管理角色/);
  h.S.profile.role = 'pzo'; const failing = h.ui.load(); h.calls[0].resolve({ data: null, error: { message: '匿名模拟故障' } });
  assert.equal((await failing).error.message, '匿名模拟故障'); assert.match(h.ui.pageHtml(), /匿名模拟故障/); assert.equal(h.ui.csvText(), '');
});

test('real app navigation lazy-loads plan statistics, exports its filtered rows, refreshes and preserves personal rich drafts', async () => {
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const assets = webAssets(webRoot);
  // Expose state only in this anonymous harness. Navigation, lazy loading,
  // browser client, rendering, filtering and downloading use the real sources.
  const app = readFileSync(path.join(webRoot, 'app.js'), 'utf8')
    .replace('window.App = App;', 'window.App = App; window.statisticsAudit = {S,configureReporter,renderShell,preparePM};')
    .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
  const artifactDir = process.env.ADMIN1_ARTIFACT_DIR || path.join(os.tmpdir(), 'admin1-plan-statistics-artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const requests = [], resources = [], errors = [];
  let revision = 1;
  const allProjects = [{ id: 'p1', name: '匿名住宅一期', display_group: '匿名住宅组', project_type: 'res', active: true },
    { id: 'p2', name: '匿名住宅二期', display_group: '匿名混合组', project_type: 'res', active: true },
    { id: 'p3', name: '匿名商业项目', display_group: '匿名混合组', project_type: 'com', active: true },
    { id: 'p4', name: '其他商业项目', display_group: '匿名商业组', project_type: 'com', active: true }];
  const allRows = [
    { id: 'n1', source_id: 'n1', source_key: 'milestone:n1', project_id: 'p1', project_name: '匿名住宅一期', display_group: '匿名住宅组', discipline: '土建', title: '匿名一期缺日期节点', plan_due: '2026-10-20', effective_due: '2026-10-30', forecast_due: '', completed: false, completion_basis: 'none', deviation: null, risk: 'insufficient', overdue: false, due_next30: true, insufficient: true, is_key: true, level: '一级', extension_approved: true },
    { id: 'n2', source_id: 'n2', source_key: 'milestone:n2', project_id: 'p2', project_name: '匿名住宅二期', display_group: '匿名住宅组', discipline: '设计', title: '匿名二期已完成节点', plan_due: '2026-10-20', effective_due: '2026-10-20', forecast_due: '', completed: true, completion_basis: 'approval', completion_date: '2026-10-18', on_time: true, deviation: null, risk: 'completed', overdue: false, due_next30: false, insufficient: false, is_key: true, level: '一级' },
    { id: 'n3', source_id: 'n3', source_key: 'milestone:p3:3', project_id: 'p3', project_name: '匿名商业项目', display_group: '匿名商业组', discipline: '成本', module: '成本', title: '匿名商业明确模块基准', plan_due: '2026-10-22', effective_due: '2026-11-06', forecast_due: '2026-11-06', completed: false, completion_basis: 'none', deviation: 15, risk: 'severe', overdue: false, due_next30: true, insufficient: false, is_key: true, level: '一级' },
    { id: 'n4', source_id: 'n4', source_key: 'milestone:p3:4', project_id: 'p3', project_name: '匿名商业项目', display_group: '匿名商业组', discipline: '未归属', module: '未归属', title: '匿名商业未归属普通基准', plan_due: '2026-10-22', effective_due: '2026-10-22', forecast_due: '2026-10-22', completed: false, completion_basis: 'none', deviation: 0, risk: 'normal', overdue: false, due_next30: true, insufficient: false, is_key: false, level: '二级' }
  ];
  allRows.push({ ...allRows[3], id: 'n5', source_id: 'n5', source_key: 'milestone:p4:5', project_id: 'p4', project_name: '其他商业项目', title: '其他商业项目基准' });
  allRows.forEach(row => { const project = allProjects.find(project => project.id === row.project_id); row.project_type = project.project_type; row.display_group = project.display_group; });
  function tally(rows) {
    const completed = rows.filter(row => row.completed).length;
    return { total: rows.length, completed, incomplete: rows.length - completed, completion_rate: rows.length ? completed / rows.length * 100 : null,
      overdue: rows.filter(row => row.overdue).length, forecast_delayed: rows.filter(row => row.deviation > 0).length, due_next30: rows.filter(row => row.due_next30).length, insufficient: rows.filter(row => row.insufficient).length,
      on_time: completed, late: 0, timeliness_covered: completed, timeliness_unknown: 0,
      project_count: new Set(rows.map(row => row.project_id)).size, group_count: new Set(rows.map(row => row.display_group)).size };
  }
  function statistics(role, filters) {
    const projects = (role === 'pzo' ? allProjects.slice(0, 1) : allProjects).filter(project => !filters.kind || filters.kind === 'all' || project.project_type === filters.kind);
    const rows = allRows.filter(row => projects.some(project => project.id === row.project_id))
      .filter(row => !filters.display_group || row.display_group === filters.display_group)
      .filter(row => !filters.project_id || row.project_id === filters.project_id)
      .filter(row => !filters.discipline || row.discipline === filters.discipline)
      .filter(row => !filters.key_only || row.is_key)
      .filter(row => !filters.level || row.level === filters.level)
      .filter(row => filters.risk !== 'insufficient' || row.insufficient)
      .map(row => ({ ...row, title: revision > 1 ? '刷新后' + row.title : row.title }));
    return { today: '2026-10-22', source: (filters.kind || 'all') + '_baseline', filters,
      options: { projects, groups: [...new Set(projects.map(project => project.display_group))], disciplines: [...new Set(allRows.filter(row => projects.some(project => project.id === row.project_id)).map(row => row.discipline))], levels: ['一级', '二级'] }, rows, totals: tally(rows),
      projects: projects.filter(project => rows.some(row => row.project_id === project.id)).map(project => ({ ...project, ...tally(rows.filter(row => row.project_id === project.id)) })) };
  }
  async function open(role) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push({ role, message: error.message }));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
      if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: assets.html });
      const asset = assets.responses.get(pathname);
      if (asset) {
        resources.push({ role, name: asset.name });
        const contentType = asset.name.endsWith('.js') ? 'text/javascript' : asset.name.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        return route.fulfill({ status: 200, contentType, body: asset.name === 'app.js' ? app : asset.body });
      }
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      requests.push({ role, path: pathname, body });
      let data = [], meta;
      if (pathname === '/api/auth/session') data = { session: null };
      else if (pathname === '/api/db') {
        assert.equal(body.operation, 'select', 'the navigation harness must never mutate business data');
        const projects = role === 'pzo' || role === 'pm' ? allProjects.slice(0, 1) : allProjects;
        const tables = { projects, project_members: [{ user_id: 'anonymous-' + role, project_id: 'p1', role_in_project: role }],
          milestones: [{ id: 1, project_id: 'p1', name: '匿名原基准节点', plan_date: '2026-10-20', forecast_date: '', done: false, discipline: '土建', is_key: true, level: '一级' }], reports: [], profiles: [] };
        data = tables[body.table] || [];
      } else if (pathname === '/api/project-plan-statistics') data = statistics(role, body);
      else if (['/api/completions/list', '/api/report-attachments/list', '/api/reporter-tasks/list', '/api/monthly-plans/list', '/api/coordination-tasks/list', '/api/project-people/list', '/api/report-scopes/list'].includes(pathname)) {
        data = []; meta = { has_more: false, next_cursor: null };
      } else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ data: null, error: { message: 'Unexpected anonymous test request: ' + pathname } }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, error: null, meta }) });
    });
    await page.goto('http://project-statistics.test/');
    await page.waitForFunction(() => !!window.statisticsAudit && !!window.PlanningBoot);
    await page.evaluate(role => {
      const S = window.statisticsAudit.S;
      Object.assign(S, { uid: 'anonymous-' + role, session: { user: { id: 'anonymous-' + role } },
        profile: { user_id: 'anonymous-' + role, name: '匿名' + role, role, status: 'approved', project_id: role === 'pzo' || role === 'pm' ? 'p1' : null, discipline: '土建' },
        view: role === 'pm' ? 'history' : 'pres', pmProject: 'p1', pmLine: '综合', pmPeriod: '第43周（10.19–10.25）' });
      localStorage.setItem('zh_draft_other-person_other-project_43', '{"privateDraft":"其他项目原草稿应保持"}');
    }, role);
    return page;
  }
  function countRequests(role) { return requests.filter(request => request.role === role && request.path === '/api/project-plan-statistics' && request.body.kind === 'all').length; }
  try {
    const page = await open('ops');
    assert.equal(resources.filter(resource => resource.name === 'project-plan-statistics.js').length, 0, 'statistics must stay lazy until navigation');
    await page.evaluate(() => window.App.view('projectPlanStats'));
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(5);
    await expect(page.locator('.project-statistics-totals')).toContainText('基准节点总量');
    await expect(page.locator('.project-statistics-details')).toContainText('匿名一期缺日期节点');
    await expect(page.locator('.project-statistics-details')).toContainText('匿名商业明确模块基准');
    await expect(page.locator('.project-statistics-switch')).toHaveCount(0);
    await expect(page.getByLabel('项目展示组', { exact: true }).locator('option')).toHaveText(['全部展示组', '匿名住宅组', '匿名混合组', '匿名商业组']);
    await page.screenshot({ path: path.join(artifactDir, 'admin3-unified-statistics-desktop.png'), fullPage: true });
    assert.equal(countRequests('ops'), 1, 'one App.view request configures and loads statistics exactly once');
    assert.equal(resources.filter(resource => resource.name === 'project-plan-statistics.js').length, 1);
    await page.getByLabel('风险／数据', { exact: true }).selectOption('insufficient');
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(1);
    assert.equal(countRequests('ops'), 2);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前明细', exact: true }).click();
    const download = await downloading, csv = readFileSync(await download.path(), 'utf8');
    assert.match(csv, /匿名一期缺日期节点/); assert.doesNotMatch(csv, /匿名二期已完成节点/);
    await page.evaluate(() => window.App.view('pres'));
    await expect(page.locator('.project-plan-statistics')).toHaveCount(0);
    await page.evaluate(() => window.App.view('projectPlanStats'));
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(1);
    assert.equal(countRequests('ops'), 2, 'returning to the same source and filter uses its current result');
    revision = 2;
    await page.evaluate(() => window.App.reload());
    await expect(page.locator('.project-statistics-details')).toContainText('刷新后匿名一期缺日期节点');
    assert.equal(countRequests('ops'), 3, 'App.reload invalidates the statistics cache and reads the current server result');
    assert.equal(await page.evaluate(() => localStorage.getItem('zh_draft_other-person_other-project_43')), '{"privateDraft":"其他项目原草稿应保持"}');
    await page.screenshot({ path: path.join(artifactDir, 'admin1-statistics-app-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(artifactDir, 'admin1-statistics-app-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(5);
    await page.getByLabel('项目展示组', { exact: true }).selectOption('匿名混合组');
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(3);
    await expect(page.getByLabel('实际项目／分期', { exact: true }).locator('option')).toHaveText(['全部实际项目', '匿名住宅二期', '匿名商业项目']);
    const mixedDownloadPending = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前明细', exact: true }).click();
    const mixedDownload = await mixedDownloadPending, mixedCsv = readFileSync(await mixedDownload.path(), 'utf8');
    assert.equal(mixedCsv.split('\r\n').length, 4); assert.match(mixedCsv, /住宅基准节点/); assert.match(mixedCsv, /商业基准节点/);
    assert.match(mixedCsv, /匿名二期已完成节点/); assert.match(mixedCsv, /匿名商业明确模块基准/);
    assert.doesNotMatch(mixedCsv, /匿名一期缺日期节点|其他商业项目基准/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifactDir, 'admin3-unified-statistics-mobile.png'), fullPage: true });
    await page.getByLabel('实际项目／分期', { exact: true }).selectOption('p3');
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(2);
    await expect(page.locator('.project-statistics-details')).toContainText('匿名商业未归属普通基准');
    await expect(page.locator('.project-statistics-details')).toContainText('预计偏差');
    await expect(page.locator('.project-statistics-details')).toContainText('+15天');
    await expect(page.locator('.project-statistics-totals div').filter({ hasText: '预计延期' })).toContainText('1');
    await expect(page.locator('main')).not.toContainText('部分数据加载失败');
    await expect(page.locator('.project-statistics-details')).not.toContainText('确认计划事项');
    assert.equal(requests.at(-1).body.month, undefined);
    await page.getByLabel('节点范围', { exact: true }).selectOption('true');
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(1);
    await expect(page.locator('.project-statistics-details')).not.toContainText('匿名商业未归属普通基准');
    await page.getByLabel('专业 / 模块', { exact: true }).selectOption('成本');
    await page.getByLabel('层级', { exact: true }).selectOption('一级');
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(1);
    const businessDownloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前明细', exact: true }).click();
    const businessDownload = await businessDownloading, businessCsv = readFileSync(await businessDownload.path(), 'utf8');
    assert.match(businessCsv, /商业基准节点/); assert.match(businessCsv, /匿名商业明确模块基准/);
    assert.match(businessCsv, /milestone:p3:3/); assert.doesNotMatch(businessCsv, /匿名商业未归属普通基准|确认月份|商业确认月计划/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(artifactDir, 'admin2-statistics-app-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(artifactDir, 'admin2-statistics-app-desktop.png'), fullPage: true });
    await page.getByLabel('项目展示组', { exact: true }).selectOption('匿名商业组');
    await expect(page.getByLabel('实际项目／分期', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('实际项目／分期', { exact: true }).locator('option')).toHaveText(['全部实际项目', '其他商业项目']);
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await expect(page.locator('.project-statistics-details tbody tr')).toHaveCount(5);
    await expect(page.getByLabel('项目展示组', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('专业 / 模块', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('节点范围', { exact: true })).toHaveValue('false');
    await page.close();
    for (const role of ['president', 'pzo']) {
      const reader = await open(role);
      await reader.evaluate(() => window.App.view('projectPlanStats'));
      await expect(reader.locator('.project-statistics-details tbody tr')).toHaveCount(role === 'pzo' ? 1 : 5);
      assert.equal(countRequests(role), 1);
      await expect(reader.locator('main')).not.toContainText('成员与权限');
      await expect(reader.locator('main')).not.toContainText('完成与延期审核');
      await reader.close();
    }
    const pm = await open('pm');
    await pm.evaluate(async () => {
      await window.PlanningBoot.ensureEditor();
      const draft = { ts: Date.now(), line: '综合', bizNodes: [], bizItems: [{ source_id: 'original-draft-source', mod: '综合', name: '原草稿事项', due: '2026-10-23', prog: '保留草稿富文本', blocker: '原卡点', _rich: { prog: { ops: [{ insert: '保留草稿富文本', attributes: { bold: true } }, { insert: '\n' }] } } }],
        bizHand: [], monthlyUnmatchedItems: [{ source_id: 'unmatched-original', name: '原未匹配草稿' }], followupRows: [], attachmentIds: ['original-draft-attachment'] };
      localStorage.setItem('zh_draft_anonymous-pm_p1_43', JSON.stringify(draft));
      await window.App.view('form');
    });
    await expect(pm.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('保留草稿富文本');
    await expect(pm.locator('.planning-mainnav')).not.toContainText('项目计划统计');
    await pm.evaluate(() => window.App.view('projectPlanStats'));
    assert.equal(countRequests('pm'), 0, 'a personal account cannot load the statistics API through App.view');
    await expect(pm.locator('.project-plan-statistics')).toHaveCount(0);
    assert.notEqual(await pm.evaluate(() => window.statisticsAudit.S.view), 'projectPlanStats');
    await pm.evaluate(() => window.App.view('form'));
    await expect(pm.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('保留草稿富文本');
    await expect(pm.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor')).toContainText('遇到卡点：原卡点');
    await expect(pm.locator('#bi_blocker_0')).toHaveCount(0);
    const preserved = await pm.evaluate(() => JSON.parse(localStorage.getItem('zh_draft_anonymous-pm_p1_43')));
    assert.equal(preserved.bizItems[0].source_id, 'original-draft-source');
    assert.equal(preserved.bizItems[0]._rich.prog.ops[0].attributes.bold, true);
    assert.equal(preserved.monthlyUnmatchedItems[0].source_id, 'unmatched-original');
    assert.deepEqual(preserved.attachmentIds, ['original-draft-attachment']);
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => request.path === '/api/db' ? request.body.operation === 'select' : !/\/(?:save|create|confirm|request|review|upload)$/.test(request.path)), 'the harness makes no business mutation');
    writeFileSync(path.join(artifactDir, 'admin1-statistics-app-result.json'), JSON.stringify({ lazyRealAssets: true, singleEntryRequest: true, filteredDownload: true,
      backNavigationCache: true, reloadInvalidation: true, unifiedMixedGroupFiltersAndExport: true, commercialBaselineFiltersAndExport: true, managerReaders: ['ops', 'president', 'pzo'], pmBlockedWithRichDraftPreserved: true,
      browserErrors: errors, businessWrites: 0, mockedApiRequests: requests, loadedAssets: resources }, null, 2));
  } finally { await browser.close(); }
});
