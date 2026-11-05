import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { chromium, expect } from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const source = readFileSync(new URL('admin-plan-overview.js', web), 'utf8');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const imageId = '10000000-0000-4000-8000-000000000001';
const fixture = {
  uid: 'anonymous-ops', session: {}, view: 'pres', profile: {role: 'ops'}, overviewUI: {project: '', open: {}},
  projects: [{id: 'phase-1', name: '住宅一期', display_group: '住宅展示组'}, {id: 'phase-2', name: '住宅二期', display_group: '住宅展示组'}],
  drawings: [{id: 1, project_id: 'phase-1', name: '一期总图.png', kind: '项目总图', path: 'drawings/phase-1/master.png'},
    {id: 2, project_id: 'foreign', name: '越权图片.png', kind: '项目总图', path: 'drawings/foreign/master.png'},
    {id: 3, project_id: 'phase-1', name: '不可执行.png', kind: '项目总图', url: 'javascript:alert(1)'}],
  reportAttachments: [{id: imageId, project_id: 'phase-2', name: '二期本期图片.png', inline: true, mime: 'image/png'}],
  reports: [{id: 'r1', project_id: 'phase-1', author_name: '匿名一期负责人', line: '综合', items: ['一期计划'], biz: {attachments: [imageId]}},
    {id: 'r2', project_id: 'phase-2', author_name: '匿名二期负责人', line: '综合', items: ['二期计划'], biz: {attachments: [imageId]}},
    {id: 'r3', project_id: 'foreign', author_name: '越权负责人', line: '综合', items: ['越权事项'], biz: {attachments: []}}]
};
function configuration(S) {
  function table(rows, kind) {
    return '<div class="overview-table-scroll"><table class="overview-data-table" data-section="' + kind + '"><colgroup><col class="overview-col-seq"><col class="overview-col-content"></colgroup><thead><tr><th>序号</th><th>事项</th></tr></thead><tbody>'
      + (rows.length ? rows.map(r => r.items.map((item, i) => '<tr><td class="overview-cell-seq">' + (i + 1) + '</td><td>' + esc(item) + '</td></tr>').join('')).join('') : '<tr><td class="overview-cell-empty" colspan="2">暂无</td></tr>') + '</tbody></table></div>';
  }
  return {S, esc, disciplines: ['工程', '设计'], currentPeriod: () => '2026-10-19',
    residentialGroups: (pid, rows) => ({'工程': rows}), nodeHtml: rows => table(rows, 'nodes'),
    planHtml: rows => '<div class="overview-table-scroll"><table class="overview-data-table" data-section="plans"><colgroup><col class="overview-col-source"><col class="overview-col-seq"><col class="overview-col-content"></colgroup><thead><tr><th>实际子项目／分期</th><th>序号</th><th>事项</th></tr></thead><tbody>'+rows.flatMap(r=>r.items.map(item=>({r,item}))).map(({r,item},i)=>'<tr data-source-project-id="'+esc(r.project_id)+'"><td><span>'+esc(S.projects.find(p=>p.id===r.project_id)?.name)+'</span></td><td class="overview-cell-seq">'+(i+1)+'</td><td>'+esc(item)+'</td></tr>').join('')+'</tbody></table></div>',
    coordHtml: rows => table(rows, 'coord'), otherHtml: rows => table(rows, 'other'),
    notesHtml: () => '', legacyHtml: () => '', unassignedHtml: () => '',
    reportHistoryButton: row => '<button data-history-id="' + esc(row.id) + '">版本记录</button>',
    foldAttrs: (_kind, _key, _line, initial) => initial ? ' open' : '', foldHint: () => '',
    projectDetailButton: pid => '<button data-detail-id="' + esc(pid) + '">项目详情</button>',
    drawingHtml: pid => '<p>原总图入口 ' + esc(pid) + '</p>', filesHtml: rows => '<p>原附件入口 ' + esc(rows.map(r => r.id).join(',')) + '</p>'};
}
function harness() {
  const sandbox = {console}; sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const S = structuredClone(fixture), cfg = configuration(S), meetings = [];
  sandbox.OverviewMeetings = {residentialHtml: projects => projects.map(project => { meetings.push({pid: project.id}); return '<p data-meeting-project="' + esc(project.id) + '">原项目会议 ' + esc(project.id) + '</p>'; }).join(''), legacyHtml: () => ''};
  sandbox.AdminPlanOverview.configure(cfg);
  return {api: sandbox.AdminPlanOverview, sandbox, S, cfg, meetings};
}

test('住宅展示组使用整页计划表，每行保留实际分期，原事项、历史及会议的项目关联保持', () => {
  const h = harness(), original = structuredClone(h.S);
  const html = h.api.residential({name: '住宅展示组', projects: [...h.S.projects, {id: 'foreign', name: '越权项目'}]}, h.S.reports, true);
  assert.equal((html.match(/class="card overview-project/g) || []).length, 1);
  assert.equal((html.match(/class="overview-residential-report"/g) || []).length, 1);
  assert.doesNotMatch(html,/data-discipline=|data-report-scope-id=/);
  assert.equal((html.match(/data-section="plans"/g) || []).length, 1);
  assert.match(html, /实际子项目／分期/);
  assert.match(html, /data-source-project-id="phase-1"><td[^>]*><span[^>]*>住宅一期/);
  assert.match(html, /data-source-project-id="phase-2"><td[^>]*><span[^>]*>住宅二期/);
  assert.match(html, /data-history-id="r1"/); assert.match(html, /data-history-id="r2"/);
  assert.match(html, /data-detail-id="phase-1"/); assert.match(html, /data-detail-id="phase-2"/);
  assert.match(html, /一期计划/); assert.match(html, /二期计划/); assert.doesNotMatch(html, /越权项目|越权事项|越权负责人|越权图片/);
  assert.deepEqual(h.meetings, [{pid: 'phase-1'}, {pid: 'phase-2'}]);
  assert.deepEqual(h.S, original, '只读汇总不得改写原报告、源ID或项目记录');
});

test('普通住宅基准合并保留四列和原项目状态，其他计划表仍按原规则合并', () => {
  const h = harness();
  for (const name of ['planning-windows.js', 'baseline-core.js']) vm.runInContext(readFileSync(new URL(name, web), 'utf8'), h.sandbox);
  h.sandbox.BaselineCore.configure({S: h.S, esc});
  const window = {start: '2026-10-19', end: '2026-11-18', exclusiveEnd: '2026-11-19'};
  const nodes = h.S.projects.map((project, index) => ({id: index + 1, project_id: project.id, name: project.name + '原基准节点',
    discipline: '工程', plan_date: '2026-10-22', forecast_date: '2026-10-25', is_key: true}));
  let state = null;
  h.cfg.nodeHtml = (_reports, pid, line, _commercial, projectIds) => h.sandbox.BaselineCore.coreHtml({projectId: pid, projectIds, allScopes:!!projectIds, includeUnassigned:!!projectIds, commercial: false, discipline: line,
    window: pid === 'phase-1' && state === 'window' ? null : window,
    baselineState: pid === 'phase-1' && state === 'error' ? {ready: true, error: '匿名基准读取故障'}
      : pid === 'phase-1' && state === 'loading' ? {ready: false} : {ready: true}});
  h.S.milestones = structuredClone(nodes);
  const render = () => h.api.residential({name: '住宅展示组', projects: h.S.projects}, h.S.reports, true);
  function table(html, section) { return new RegExp('<table\\b[^>]*data-section="' + section + '"[^>]*>([\\s\\S]*?)<\\/table>').exec(html)[1]; }
  function columns(html, tag) { return (html.match(new RegExp('<' + tag + '(?:\\s|>)', 'g')) || []).length; }
  const ready = render(), baseline = table(ready, 'nodes');
  assert.equal(columns(baseline.split('</thead>')[0], 'th'), 4);
  const rows = baseline.split('<tbody>')[1].match(/<tr\b[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 2);
  rows.forEach(row => assert.equal(columns(row, 'td'), 4));
  assert.match(rows[0], /data-source-key="milestone:phase-1:1" data-source-project-id="phase-1"/);
  assert.match(rows[1], /data-source-key="milestone:phase-2:2" data-source-project-id="phase-2"/);
  assert.doesNotMatch(baseline, /实际子项目／分期/);
  for (const section of ['plans', 'coord']) {
    const merged = table(ready, section);
    assert.equal(columns(merged.split('</thead>')[0], 'th'), 3);
    assert.match(merged, /data-source-project-id="phase-1"><td[^>]*><span[^>]*>住宅一期/);
    assert.match(merged, /data-source-project-id="phase-2"><td[^>]*><span[^>]*>住宅二期/);
    assert.match(merged, /overview-cell-seq">1<\/td>/); assert.match(merged, /overview-cell-seq">2<\/td>/);
  }
  for (const status of ['error', 'loading', 'not-imported', 'no-scope', 'window']) {
    state = status;
    h.S.milestones = structuredClone(nodes).filter(node => status !== 'not-imported' || node.project_id !== 'phase-1');
    if (status === 'no-scope') h.S.milestones[0].discipline = '设计';
    const fragment = h.cfg.nodeHtml([], 'phase-1', status==='no-scope'?'工程':null,false,status==='no-scope'?undefined:['phase-1']), html = render();
    const core = html.split('<section class="overview-core-nodes">')[1].split('<section class="overview-monthly-plans">')[0];
    assert.match(fragment, new RegExp('data-baseline-status="' + status + '"'));
    if(status==='no-scope')assert.match(core,/data-source-key="milestone:phase-1:1"/,'整页汇总仍包含其他专业，独立专业查询继续明确无匹配');
    else {
      assert.ok(core.includes(fragment), status + '原状态必须完整保留');
      assert.match(core, /<section class="overview-source-section" data-source-project-id="phase-1"><h5><span class="overview-source-project">住宅一期/);
    }
    assert.match(core, /data-source-key="milestone:phase-2:2"/);
    assert.doesNotMatch(core, /暂无核心节点/);
  }
  h.cfg.nodeHtml = (_reports, pid) => '<p class="notice err" role="alert">' + esc(pid) + '基准组件读取失败</p>';
  const failures = render().split('<section class="overview-core-nodes">')[1].split('<section class="overview-monthly-plans">')[0];
  assert.match(failures, /phase-1基准组件读取失败/); assert.match(failures, /phase-2基准组件读取失败/);
  assert.doesNotMatch(failures, /暂无核心节点/);
});

test('对照图片仅来自当前有权项目的总图及本期报告引用，附件元数据必须匹配真实项目', () => {
  const h = harness(), images = JSON.parse(JSON.stringify(h.api.pictures([...h.S.projects, {id: 'foreign'}], h.S.reports)));
  assert.equal(images.length, 2);
  assert.equal(images[0].projectId, 'phase-1'); assert.equal(images[0].url, '/api/files/drawings/phase-1/master.png');
  assert.equal(images[1].projectId, 'phase-2'); assert.equal(images[1].url, '/api/report-attachments/' + imageId);
  h.S.reportAttachments[0].inline = false;
  assert.equal(h.api.pictures(h.S.projects, h.S.reports).length, 1, '不把下载附件强行内嵌');
  h.S.drawings = [];
  const empty = h.api.layout({key: 'empty', projects: h.S.projects, reports: [], content: '<p>计划</p>', sidebar: '<p>原入口</p>'});
  assert.match(empty, /data-compare-toggle[^>]+disabled/); assert.match(empty, /<p>原入口<\/p>/); assert.doesNotMatch(empty, /其他文件沿原入口打开/);
});

test('图文对照在桌面同屏独立滚动、缩放拖动、切换来源，窄屏可切换图文且关闭不丢计划', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const artifacts = process.env.ADMIN_PLAN_ARTIFACT_DIR || path.join(os.tmpdir(), 'admin-plan-overview-artifacts'); mkdirSync(artifacts, {recursive: true});
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().isNavigationRequest()
      ? route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root" style="padding:20px"></div>'})
      : route.fulfill({status: 200, contentType: 'image/webp', body: readFileSync(new URL('login-bg-desktop.webp', web))}));
    await page.goto('http://admin-plan-overview.test/');
    for (const name of ['styles.css', 'planning-ui.css', 'admin-plan-overview.css']) await page.addStyleTag({content: readFileSync(new URL(name, web), 'utf8')});
    await page.addScriptTag({content: source});
    await page.evaluate(({fixture, configureText}) => {
      const configure = (0, eval)('(' + configureText + ')');
      window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
      const cfg = configure(fixture);
      window.AdminPlanOverview.configure(cfg);
      const longRows = [{...fixture.reports[0], items: Array.from({length: 18}, (_, i) => '匿名计划事项 ' + i + '，原进展和富文本仍在原报告中保留。')}, fixture.reports[1]];
      document.getElementById('root').innerHTML = window.AdminPlanOverview.residential({name: '住宅展示组', projects: fixture.projects}, longRows, true);
    }, {fixture, configureText: configuration.toString()});
    await page.getByRole('button', {name: '图文对照', exact: true}).click();
    const content = page.locator('.admin-reading-content'), pane = page.locator('.admin-compare-pane');
    await expect(content).toBeVisible(); await expect(pane).toBeVisible();
    const boxes = await Promise.all([content.boundingBox(), pane.boundingBox()]);
    assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x + 1, '计划和图片在桌面横向同屏');
    assert.ok(await content.evaluate(el => el.scrollHeight > el.clientHeight), '计划正文有独立滚动容器');
    const originalWidth = boxes[0].width;
    await page.getByRole('slider', {name: '计划栏宽度百分比'}).fill('50');
    assert.ok((await content.boundingBox()).width < originalWidth);
    await page.getByRole('button', {name: '放大图片', exact: true}).click();
    await expect(page.locator('[data-compare-zoom]')).toHaveText('125%');
    await page.getByRole('combobox', {name: '对照图片'}).selectOption('1');
    await expect(page.locator('[data-compare-image]')).toHaveAttribute('src', '/api/report-attachments/' + imageId);
    await expect(page.locator('[data-compare-image]')).toHaveJSProperty('complete', true);
    assert.ok(await page.locator('[data-compare-image]').evaluate(image => image.naturalWidth > 0), '真实图片响应成功解码');
    await expect(page.locator('.admin-compare-file')).toContainText('住宅二期 · 本期图片');
    await expect(page.locator('[data-compare-zoom]')).toHaveText('100%');
    await page.getByRole('button', {name: '放大图片', exact: true}).click();
    const viewport = page.locator('.admin-compare-viewport');
    await viewport.evaluate(el => {el.scrollLeft = 100; el.scrollTop = 100;});
    const start = await viewport.evaluate(el => ({left: el.scrollLeft, top: el.scrollTop}));
    const box = await viewport.boundingBox(); await page.mouse.move(box.x + 150, box.y + 150); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.up();
    const end = await viewport.evaluate(el => ({left: el.scrollLeft, top: el.scrollTop}));
    assert.ok(end.left > start.left || end.top > start.top, '放大图片可拖动浏览');
    await page.screenshot({path: path.join(artifacts, 'overview-compare-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await expect(content).toBeVisible(); await expect(pane).toBeHidden();
    await page.getByRole('button', {name: '看图片', exact: true}).click(); await expect(pane).toBeVisible(); await expect(content).toBeHidden();
    await page.screenshot({path: path.join(artifacts, 'overview-compare-mobile.png'), fullPage: true});
    await page.getByRole('button', {name: '看计划', exact: true}).click(); await expect(content).toBeVisible();
    await page.getByRole('button', {name: '关闭图文对照', exact: true}).click(); await expect(content).toBeVisible(); await expect(pane).toBeHidden();
    await expect(page.locator('.admin-reading-original')).toBeVisible();
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
});

test('实际App联合渲染：两分期汇总、富文本会议详情保持，商业核心仅基准而第二部分保留月计划', async () => {
  const app = readFileSync(new URL('app.js', web), 'utf8')
    .replace('window.App = App;', 'window.App = App; window.overviewAudit = {S,configureReporter,renderShell,currentPeriod,attachRich,dataState};')
    .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
  const artifacts = process.env.ADMIN_PLAN_ARTIFACT_DIR || path.join(os.tmpdir(), 'admin-plan-overview-artifacts'); mkdirSync(artifacts, {recursive: true});
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1680, height: 1100}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/logo.png')) return route.fulfill({status: 200, contentType: 'image/png', body: readFileSync(new URL('logo.png', web))});
      if (url.pathname.startsWith('/api/files/') || url.pathname.startsWith('/api/report-attachments/')) return route.fulfill({status: 200, contentType: 'image/webp', body: readFileSync(new URL('login-bg-desktop.webp', web))});
      return route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>'});
    });
    await page.goto('http://admin-plan-app.test/');
    await page.evaluate(() => {
      window.fixtureTables = {}; window.fixtureCalls = []; window.fixtureWrites = [];
      window.WorkBuddyCloud = {createWorkBuddyCloud: () => ({auth: {}, database: {from(table) {
        const q = {select() {return q;}, eq() {return q;}, limit() {return q;}, order() {return q;},
          then(resolve, reject) {return Promise.resolve({data: window.fixtureTables[table] || [], error: null}).then(resolve, reject);}};
        return q;
      }}})};
      window.fetch = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        window.fixtureCalls.push({url: String(url), body});
        const tables = window.fixtureTables;
        let data = {'/api/monthly-plans/list': tables.monthlyPlans, '/api/reporter-tasks/list': tables.reporterTasks,
          '/api/report-attachments/list': tables.reportAttachments}[String(url)] || [];
        if (String(url) === '/api/project-people/list') data = (tables.people || {})[body.project_id] || [];
        if (String(url) === '/api/reporter-tasks/save') {
          window.fixtureWrites.push({url: String(url), body});
          data = {...tables.reporterTasks.find(task => task.id === body.id), ...body, id: body.id || 'new-leader-arrangement', proposer_role: 'president', proposer_name: '匿名总裁', revision: body.expected_revision ? body.expected_revision + 1 : 1};
          if (body.id) tables.reporterTasks = tables.reporterTasks.map(task => task.id === data.id ? data : task);
          else tables.reporterTasks.push(data);
        }
        return new Response(JSON.stringify({data, error: null, meta: {has_more: false, next_cursor: null}}), {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    for (const name of ['styles.css', 'planning-ui.css', 'report3-layout.css', 'admin-plan-overview.css', 'completion-review.css', 'report-attachments.css', 'reporter-tasks.css', 'vendor/quill/quill.core.css']) {
      await page.addStyleTag({content: readFileSync(new URL(name, web), 'utf8')});
    }
    for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'monthly-plans.js', 'monthly-summaries.js', 'reporter-tasks.js', 'completion-review.js', 'report-attachments.js', 'overview-meetings.js', 'admin-plan-overview.js']) {
      await page.addScriptTag({content: readFileSync(new URL(name, web), 'utf8')});
    }
    await page.addScriptTag({content: app});
    await page.evaluate(({imageId}) => {
      const h = window.overviewAudit, period = h.currentPeriod(), start = window.PlanningWindows.periodStart(period), due = window.PlanningWindows.addDays(start, 3);
      const projects = [{id: 'phase-1', name: '匿名住宅一期', display_group: '匿名住宅展示组', project_type: 'res', active: true},
        {id: 'phase-2', name: '匿名住宅二期', display_group: '匿名住宅展示组', project_type: 'res', active: true},
        {id: 'commercial', name: '匿名商业项目', project_type: 'com', active: true}];
      const members = [{user_id: 'owner-1', name: '匿名一期工程', role: 'pm', status: 'approved', discipline: '工程'},
        {user_id: 'owner-2', name: '匿名二期工程', role: 'pm', status: 'approved', discipline: '工程'},
        {user_id: 'designer-2', name: '匿名二期设计', role: 'pm', status: 'approved', discipline: '设计'},
        {user_id: 'commercial-owner', name: '匿名商业工程', role: 'pm', status: 'approved', biz_line: '土建工程（东地块）'},
        {user_id: 'president', name: '匿名总裁', role: 'president', status: 'approved'}];
      const milestone = (id, project_id, name, discipline) => ({id, project_id, name, discipline, is_key: true, plan_date: due, forecast_date: due, done: false});
      const milestones = [milestone(101, 'phase-1', '一期工程基准', '工程'), milestone(102, 'phase-2', '二期工程基准', '工程'), milestone(103, 'phase-2', '二期设计基准未反馈', '设计')];
      const reports = projects.slice(0, 2).map((p, index) => ({id: index + 11, project_id: p.id, period, line: '综合', author_id: 'owner-' + (index + 1), author_name: members[index].name,
        submitted_at: start + 'T02:00:00Z', updated_at: start + 'T02:00:00Z', status: '正常', node_items: [], coord_items: [],
        history: [{at: start + 'T01:00:00Z', by: '原提交者', data: {project_id: p.id, period, line: '综合', change_text: '匿名旧版住宅记录'}}],
        biz: {form_version: 2, nodes: [{milestone_id: index + 101, name: milestones[index].name, plan: due, forecast: due, prog: '工程进展'}],
          items: [{source_id: 'original-item-' + index, mod: '工程', name: '**' + (index ? '二期计划' : '一期计划') + '**', due, prog: index ? '二期进展' : '一期红色加粗进展'}], attachments: index ? [imageId] : []},
        rich_text: {v: 1, fields: index ? {} : {'biz.items.0.prog': {ops: [{insert: '一期红色加粗进展', attributes: {bold: true, color: '#d81e06'}}]}}}}));
      const commercialLine = '土建工程（东地块）', planItem = {source_id: 'original-commercial-source', mod: '砌筑', name: '商业已确认事项', due};
      milestones.push({...milestone(104, 'commercial', '商业普通基准', '工程'), biz_line: commercialLine, is_key: false},
        {...milestone(105, 'commercial', '商业关键基准', '工程'), biz_line: commercialLine},
        {...milestone(106, 'commercial', '商业其他模块基准', '成本'), biz_line: '成本'},
        {...milestone(107, 'commercial', '商业普通未分配基准', '工程'), is_key: false});
      const monthlyPlans = [{id: 'commercial-confirmed', project_id: 'commercial', line: commercialLine, plan_month: start.slice(0, 7) + '-01', confirmed_by: 'commercial-owner', items: [planItem, {...planItem, source_id: 'not-reported', name: '商业未反馈确认事项'}]}];
      reports.push({id: 13, project_id: 'commercial', period, line: commercialLine, author_id: 'commercial-owner', author_name: '匿名商业工程', submitted_at: start + 'T03:00:00Z',
        biz: {monthly_plan_id: 'commercial-confirmed', monthly_plan_month: start.slice(0, 7), nodes: [], items: [{...planItem, prog: '商业原反馈必须保留'}], attachments: []}});
      const reporterTasks = [{id: 'meeting-1', project_id: 'phase-1', owner_id: 'owner-1', owner_name: '匿名一期工程', proposer_id: 'president', proposer_role: 'president', proposer_name: '匿名总裁', meeting_kind: 'requirement', title: '一期原会议要求', what: '一期原会议正文', due, status: 'open', progress: '一期原会议反馈', revision: 3},
        {id: 'meeting-2', project_id: 'phase-2', owner_id: 'owner-2', owner_name: '匿名二期工程', proposer_id: 'president', proposer_role: 'president', proposer_name: '匿名总裁', meeting_kind: 'requirement', title: '二期原会议要求', what: '二期原会议正文', due, status: 'in_progress', progress: '二期原会议反馈', revision: 5}];
      const tables = window.fixtureTables;
      Object.assign(tables, {projects, profiles: members, project_members: [{project_id: 'phase-1', user_id: 'owner-1'}, {project_id: 'phase-2', user_id: 'owner-2'}, {project_id: 'phase-2', user_id: 'designer-2'}],
        reports, milestones, reporterTasks, monthlyPlans, leader_notes: [], leader_reviews: [], org: [], project_master: [], project_phases: [],
        project_drawings: [{id: 1, project_id: 'phase-1', name: '一期总图.png', kind: '项目总图', path: 'drawings/phase-1/master.png'}],
        reportAttachments: [{id: imageId, project_id: 'phase-2', name: '二期本期图片.png', inline: true, mime: 'image/png', size: 1024}],
        people: {'phase-1': [members[0], members[4]], 'phase-2': [members[1], members[2], members[4]], commercial: [members[3], members[4]]}});
      Object.assign(h.S, {uid: 'anonymous-ops', session: {}, profile: {user_id: 'anonymous-ops', name: '匿名运营', role: 'ops', status: 'approved'},
        projects, members, pms: tables.project_members, milestones, reports, monthlyPlans, reporterTasks, drawings: tables.project_drawings,
        reportAttachments: tables.reportAttachments, view: 'pres', overviewUI: {project: '', line: '', open: {}}});
      h.dataState.milestones = {ready: true, revision: 0};
      h.attachRich(reports); h.attachRich(milestones); h.attachRich(reporterTasks); h.configureReporter(); h.renderShell();
    }, {imageId});
    const group = page.locator('.overview-display-group'), engineering = group.locator('.overview-residential-report');
    await expect(group).toHaveCount(1); await expect(group).toContainText('2 个实际子项目');
    await expect(engineering.locator('[data-section="plans"]')).toHaveCount(1);
    await expect(engineering.locator('[data-section="plans"] tbody tr')).toHaveCount(2);
    await expect(engineering.locator('[data-section="plans"] tbody tr').nth(0)).toContainText('匿名住宅一期');
    await expect(engineering.locator('[data-section="plans"] tbody tr').nth(1)).toContainText('匿名住宅二期');
    await expect(engineering.locator('[data-section="plans"] .rt-red strong')).toContainText('一期红色加粗进展');
    await expect(group.locator('.overview-core-nodes')).toContainText('二期设计基准未反馈');
    const arrangements = group.locator('.overview-leader-arrangements');
    await expect(arrangements).toHaveCount(1); await expect(engineering.locator('[data-section="meetings"]')).toHaveCount(0);
    await expect(group.locator('.overview-unassigned')).toHaveCount(0);
    await expect(arrangements.locator('[data-arrangement-id="meeting-1"]')).toContainText('一期原会议正文');
    await expect(arrangements.locator('[data-arrangement-id="meeting-2"]')).toContainText('二期原会议正文');
    const meeting2 = arrangements.locator('[data-arrangement-id="meeting-2"]');
    await meeting2.getByRole('button', {name: '维护', exact: true}).click();
    const editing = arrangements.locator('.overview-meeting-draft');
    await editing.locator('[data-rich-editor-for^="overview_meeting_what_"] .ql-editor').fill('二期原会议正文');
    await editing.getByRole('button', {name: '保存安排', exact: true}).click();
    await expect(arrangements.locator('.overview-meeting-draft')).toHaveCount(0);
    const writes = await page.evaluate(() => window.fixtureWrites);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.project_id, 'phase-2'); assert.equal(writes[0].body.id, 'meeting-2'); assert.equal(writes[0].body.expected_revision, 5);
    assert.equal(writes[0].body.owner_id, 'owner-2'); assert.equal(writes[0].body.progress, '二期原会议反馈');
    assert.equal(writes[0].body.proposer_id, 'president'); assert.equal(writes[0].body.meeting_kind, 'requirement');
    await arrangements.getByRole('button', {name: '新增工作安排', exact: true}).click();
    const draft = arrangements.locator('.overview-meeting-draft');
    await expect(draft.getByRole('combobox', {name: '工作安排实际项目'})).toHaveValue('');
    await draft.getByRole('combobox', {name: '工作安排实际项目'}).selectOption('phase-2');
    await draft.getByRole('combobox', {name: '工作安排专业', exact: true}).selectOption('成本');
    await expect(draft).toContainText('该专业暂无本项目有效责任人');
    await draft.getByRole('combobox', {name: '工作安排专业', exact: true}).selectOption('设计');
    await draft.getByRole('combobox', {name: '工作安排责任人'}).selectOption('designer-2');
    await draft.getByRole('combobox', {name: '工作安排提出领导'}).selectOption('president');
    await draft.locator('[data-rich-editor-for^="overview_meeting_what_"] .ql-editor').fill('二期设计新工作安排');
    await draft.getByRole('textbox', {name: '工作安排完成时间'}).fill('2026-11-01');
    await page.screenshot({path: path.join(artifacts, 'leader-arrangement-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await expect(draft.getByRole('combobox', {name: '工作安排实际项目'})).toHaveValue('phase-2');
    await expect(draft.getByRole('combobox', {name: '工作安排责任人'})).toHaveValue('designer-2');
    await expect(draft.getByRole('textbox', {name: '工作安排完成时间'})).toHaveValue('2026-11-01');
    await expect(arrangements.locator('table[data-section="leader-arrangements"]')).toHaveCSS('display','block');
    const mobileControls = [];
    for (const control of [draft.getByRole('combobox',{name:'工作安排实际项目'}),draft.getByRole('combobox',{name:'工作安排提出领导'}),
      draft.getByRole('combobox',{name:'工作安排专业',exact:true}),draft.getByRole('combobox',{name:'工作安排责任人'}),
      draft.locator('[data-rich-editor-for^="overview_meeting_what_"] .ql-editor'),draft.getByRole('textbox',{name:'工作安排完成时间'}),draft.getByRole('button',{name:'保存安排',exact:true})]) {
      await control.scrollIntoViewIfNeeded();
      mobileControls.push(await control.evaluate(el=>{const box=el.getBoundingClientRect();return {label:el.getAttribute('aria-label')||el.textContent,box:{x:box.x,y:box.y,width:box.width,height:box.height},viewport:{width:innerWidth,height:innerHeight},parents:[el.parentElement,el.parentElement.parentElement,el.closest('td'),el.closest('tr')].map(p=>({className:p.className,clientWidth:p.clientWidth,scrollWidth:p.scrollWidth,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,overflow:getComputedStyle(p).overflow}))};}));
      writeFileSync(path.join(artifacts,'mobile-control-dimensions.json'),JSON.stringify(mobileControls,null,2));
      if(await control.getAttribute('class')==='ql-editor')await page.screenshot({path:path.join(artifacts,'leader-arrangement-mobile-editor.png')});
      await expect(control).toBeInViewport({ratio:1});
      const box = await control.boundingBox(); assert.ok(box.x >= -1 && box.x + box.width <= 391,'手机安排控件完整位于视口宽度内，无需横滑');
    }
    assert.ok(await arrangements.locator('.overview-table-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+2 && el.scrollLeft===0),'手机安排区使用卡片且无需横滑');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'手机安排表单不产生整页横向滚动');
    await page.screenshot({path: path.join(artifacts, 'leader-arrangement-mobile.png'), fullPage: true});
    await page.screenshot({path: path.join(artifacts, 'leader-arrangement-mobile-controls.png')});
    await draft.getByRole('button', {name: '保存安排', exact: true}).click();
    await expect(arrangements.locator('.overview-meeting-draft')).toHaveCount(0);
    await expect(arrangements.locator('[data-arrangement-id="new-leader-arrangement"]')).toContainText('二期设计新工作安排');
    const newWrites = await page.evaluate(() => window.fixtureWrites);
    assert.equal(newWrites.length,2); assert.equal(newWrites[1].body.project_id,'phase-2'); assert.equal(newWrites[1].body.owner_id,'designer-2');
    assert.equal(newWrites[1].body.proposer_id,'president'); assert.equal(newWrites[1].body.due,'2026-11-01'); assert.equal(newWrites[1].body.discipline,undefined);
    await page.setViewportSize({width: 1680, height: 1100});
    await group.getByRole('button', {name: '图文对照', exact: true}).click();
    await group.getByRole('combobox', {name: '对照图片'}).selectOption('1');
    await expect(group.locator('[data-compare-image]')).toHaveJSProperty('complete', true);
    assert.ok(await group.locator('[data-compare-image]').evaluate(image => image.naturalWidth > 0));
    await expect(group.locator('.admin-reading-content')).toBeVisible(); await expect(group.locator('.admin-compare-pane')).toBeVisible();
    await page.screenshot({path: path.join(artifacts, 'admin-overview-actual-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await group.getByRole('button', {name: '看图片', exact: true}).click();
    await expect(group.getByRole('button', {name: '看图片', exact: true})).toHaveAttribute('aria-pressed', 'true');
    await expect(group.getByRole('button', {name: '看计划', exact: true})).toHaveAttribute('aria-pressed', 'false');
    await expect(group.getByRole('button', {name: '看图片', exact: true})).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(group.getByRole('button', {name: '看图片', exact: true})).toHaveCSS('background-color', 'rgb(40, 87, 131)');
    await expect(group.getByRole('button', {name: '看计划', exact: true})).toHaveCSS('color', 'rgb(37, 79, 125)');
    await expect(group.locator('.admin-compare-pane')).toBeVisible(); await expect(group.locator('.admin-reading-content')).toBeHidden();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), '实际App手机图文对照不产生整页横向滚动');
    await page.screenshot({path: path.join(artifacts, 'admin-overview-actual-mobile.png'), fullPage: true});
    await group.getByRole('button', {name: '关闭图文对照', exact: true}).click();
    await page.setViewportSize({width: 1680, height: 1100});
    await group.locator('.overview-project-tools>span').filter({hasText: '匿名住宅二期'}).getByRole('button', {name: '查看详情', exact: true}).click();
    await expect(page.locator('.project-detail')).toHaveAttribute('data-project-id', 'phase-2');
    await expect(page.locator('.project-detail')).toContainText('二期计划'); await expect(page.locator('.project-detail')).not.toContainText('一期计划');
    await page.getByRole('button', {name: '历史版本', exact: true}).click();
    await expect(page.locator('.project-detail')).toContainText('匿名旧版住宅记录');
    await page.evaluate(() => window.App.view('presCom'));
    const commercial = page.locator('.overview-project[data-project-id="commercial"]');
    const core = commercial.locator('[data-module="土建工程（东地块）"] .overview-core-nodes');
    await expect(core).toContainText('商业普通基准'); await expect(core).toContainText('商业关键基准');
    await expect(core).not.toContainText('商业已确认事项'); await expect(core).not.toContainText('商业未反馈确认事项');
    await expect(core).not.toContainText('商业原反馈必须保留'); await expect(core).not.toContainText('商业其他模块基准');
    await expect(core.locator('[data-source-key]')).toHaveCount(2);
    await core.getByRole('combobox', {name: '核心基准节点范围'}).selectOption('key');
    await expect(core.locator('[data-source-key]')).toHaveCount(1);
    await core.getByRole('combobox', {name: '核心基准节点范围'}).selectOption('all');
    await expect(core.locator('[data-source-key]')).toHaveCount(2);
    await expect(commercial.locator('[data-module="土建工程（东地块）"] .overview-monthly-plans')).toContainText('商业已确认事项');
    await expect(commercial.locator('[data-module="土建工程（东地块）"] .overview-monthly-plans')).toContainText('商业原反馈必须保留');
    await expect(commercial.locator('.overview-unassigned')).toContainText('商业普通未分配基准');
    const preservation = await page.evaluate(() => ({reports: window.overviewAudit.S.reports.map(r => ({id: r.id, project_id: r.project_id, itemIds: (r.biz.items || []).map(item => item.source_id), history: (r.history || []).length})), calls: window.fixtureCalls, writes: window.fixtureWrites}));
    assert.equal(preservation.reports[0].itemIds[0], 'original-item-0'); assert.equal(preservation.reports[1].itemIds[0], 'original-item-1');
    assert.equal(preservation.reports[0].history, 1); assert.equal(preservation.reports[1].history, 1);
    assert.deepEqual(errors, []);
    writeFileSync(path.join(artifacts, 'admin-overview-actual-result.json'), JSON.stringify({desktop: true, mobile: true, mobileCardsWithoutHorizontalScroll:true,mobileControlsWithinViewport:true,groupedSources: true, originalMeetingIdAndRevision: true, residentialLeaderArrangements: true, explicitActualProjectAndDiscipline: true, newDueRequired: true, commercialBaselineCore: true, commercialAllAndKey: true, secondSectionMonthFeedbackPreserved: true, browserErrors: errors, mockWrites: 2, productionWrites: 0, ...preservation}, null, 2));
  } finally {await browser.close();}
});
