import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import { chromium, expect } from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const source = readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);
const exposed = source.slice(0, boundary) + '\nwindow.audit={S,App,configureReporter,preparePM,viewPMForm,overviewNodeHtml,loadData,dataState,draftKey,saveDraft,reportingProjects,pmHistoryReports,currentPeriod,renderShell};\n})();';
const scope = { id: 'anonymous-residential-scope', name: '匿名统一住宅', anchor_project_id: 'r1', project_ids: ['r1', 'r2', 'r3'], effective_week: '2026-10-19' };
const projects = scope.project_ids.map((id, index) => ({ id, name: '匿名住宅' + index, active: true, project_type: 'res' }));
const plan = { id: 'confirmed-plan', project_id: 'commercial', line: '机电工程', plan_month: '2026-10-01', confirmed_by: 'anonymous',
  items: [{ source_id: 'fixed-item', mod: '原月计划模块', name: '确认月计划同名事项', due: '2026-10-23' }] };
const plain = value => JSON.parse(JSON.stringify(value));
function corePart(html) { return html.slice(html.indexOf('一、本周核心节点计划'), html.indexOf('二、当月计划填报')); }
function harness({ realAttachments = false } = {}) {
  const storage = new Map(), requests = [], writes = [], elements = { root: { innerHTML: '' }, toast: { style: {} } }, fixture = { milestones: [], error: null, attachments: [] };
  const sandbox = { console, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    document: { getElementById: id => elements[id] || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    WorkBuddyCloud: { createWorkBuddyCloud: () => ({ auth: {}, database: { from(table) { const query = {
      select() { return query; }, eq() { return query; }, limit() { return query; }, order() { return query; },
      upsert(row) { writes.push({ table, row: plain(row) }); return query; },
      then(resolve, reject) { return Promise.resolve(table === 'milestones' ? { data: fixture.milestones, error: fixture.error } : { data: [], error: null }).then(resolve, reject); }
    }; return query; } } }) },
    CompletionReview: { configure() {}, approved: () => false, effectiveDue: (_key, due) => due,
      actionHtml: key => '<span data-claim="' + key + '">原事项申报</span>', snapshotsHtml: () => '', overlayHtml: () => '' },
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      requests.push({ url, method: options?.method, body });
      const data = url === '/api/report-attachments/list' ? fixture.attachments.filter(row =>
        row.project_id === body.project_id && row.period === body.period && row.line === body.line && row.report_scope_id === body.report_scope_id) : [];
      return { ok: true, json: async () => ({ data }) };
    } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  for (const name of ['rich-text.js', 'planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'monthly-plans.js', ...(realAttachments ? ['report-attachments.js'] : [])])
    vm.runInContext(readFileSync(new URL(name, web), 'utf8'), sandbox);
  vm.runInContext(exposed, sandbox);
  const h = sandbox.audit;
  Object.assign(h.S, { uid: 'anonymous', session: {}, view: 'form', pmProject: 'commercial', pmPeriod: '2026-10-19', pmLine: '机电工程',
    profile: { user_id: 'anonymous', name: '匿名填报人', role: 'pm', status: 'approved', project_id: 'commercial', biz_line: '机电工程', discipline: '工程' },
    projects: [{ id: 'commercial', name: '匿名商业项目', project_type: 'com', active: true }], pms: [{ user_id: 'anonymous', project_id: 'commercial' }],
    reportScopes: [], monthlyPlans: [plain(plan)], reports: [], milestones: [] });
  h.dataState.milestones = { ready: true, revision: 0 };
  h.configureReporter();
  return { ...h, sandbox, storage, requests, writes, elements, fixture };
}

test('actual personal form leaves baseline core empty despite confirmed month plans and preserves the original second section', async () => {
  const h = harness(); await h.preparePM();
  const before = JSON.stringify({ plans: h.S.monthlyPlans, nodes: h.S.bizNodes });
  const html = h.viewPMForm(), core = corePart(html);
  assert.match(core, /尚未导入项目基准节点/);
  assert.doesNotMatch(core, /确认月计划同名事项|已确认月计划按完成时间自动汇总|monthly-core-summary/);
  assert.match(html, /二、当月计划填报/); assert.match(html, /确认月计划同名事项/);
  assert.match(html, /data-claim="monthly:commercial:confirmed-plan:fixed-item"/);
  assert.equal(h.S.bizItems[0].source_id, 'fixed-item');
  assert.equal(JSON.stringify({ plans: h.S.monthlyPlans, nodes: h.S.bizNodes }), before);
  assert.equal(h.writes.length, 0);
});

test('actual data refresh distinguishes a read error from no baseline and displays subsequent imports without rewriting report nodes', async () => {
  const h = harness(); await h.preparePM();
  h.fixture.error = { message: '隔离基准读取失败' };
  assert.equal(await h.loadData(['milestones'], true), false);
  assert.match(corePart(h.viewPMForm()), /项目基准节点读取失败：隔离基准读取失败/);
  assert.doesNotMatch(corePart(h.viewPMForm()), /尚未导入|确认月计划同名事项/);
  h.fixture.error = null;
  h.fixture.milestones = [{ id: 501, project_id: 'commercial', name: '导入后的原基准', biz_line: '机电工程', is_key: false, plan_date: '2026-10-23', forecast_date: '2026-11-02', note: '原保存说明' }];
  assert.equal(await h.loadData(['milestones'], true), true);
  const html = corePart(h.viewPMForm());
  assert.match(html, /导入后的原基准/); assert.match(html, /milestone:commercial:501/);
  assert.match(html, /2026-10-23/); assert.match(html, /2026-11-02/);
  assert.doesNotMatch(html, /确认月计划同名事项|<textarea|id="bn_/);
  assert.deepEqual(plain(h.S.bizNodes), []);
  assert.equal(h.S.bizItems[0].source_id, 'fixed-item'); assert.equal(h.writes.length, 0);
});

test('residential group form has one scope, uses all original project baselines, and keeps three legacy drafts byte-identical', async () => {
  const h = harness();
  Object.assign(h.S, { projects: plain(projects), pms: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r2', profile: { user_id: 'anonymous', name: '匿名住宅填报人', role: 'pm', status: 'approved', discipline: '工程' }, monthlyPlans: [] });
  h.S.milestones = projects.map((project, i) => ({ id: 601 + i, project_id: project.id, name: '原项目基准' + i, discipline: i === 1 ? '设计' : '工程', is_key: true, plan_date: '2026-10-23' }));
  const oldKeys = projects.map(project => 'zh_draft_anonymous_' + project.id + '_43');
  oldKeys.forEach((key, index) => h.storage.set(key, JSON.stringify({ ts: 1, bizItems: [{ source_id: 'old-source-' + index, name: '旧稿' + index }], attachmentIds: ['old-attachment-' + index] })));
  const oldBytes = oldKeys.map(key => h.storage.get(key));
  await h.preparePM();
  assert.equal(h.S.pmProject, 'r1'); assert.equal(h.S.pmScopeId, scope.id);
  assert.equal(h.reportingProjects().length, 1);
  assert.equal(h.draftKey(), 'zh_scope_draft_anonymous_' + scope.id + '_2026-10-19');
  assert.deepEqual(plain(h.S.bizNodes), []);
  assert.ok(h.S.bizItems.every(item => !item.source_id), 'legacy drafts are not silently chosen as the group draft');
  const html = h.viewPMForm();
  assert.match(html, /发现 3 份原地块本机草稿/);
  assert.match(corePart(html), /milestone:r1:601/); assert.match(corePart(html), /milestone:r2:602/); assert.match(corePart(html), /milestone:r3:603/);
  h.S.bizItems = [{ source_id: 'new-group-source', name: '组稿独立正文', prog: '未提交进展', _rich: { prog: { ops: [{ insert: '未提交进展', attributes: { bold: true } }] } } }];
  assert.equal(h.saveDraft(), true);
  const saved = JSON.parse(h.storage.get(h.draftKey()));
  assert.equal(saved.bizItems[0].source_id, 'new-group-source');
  assert.equal(saved.bizItems[0]._rich.prog.ops[0].attributes.bold, true);
  assert.deepEqual(oldKeys.map(key => h.storage.get(key)), oldBytes);
  await h.preparePM();
  assert.equal(h.S.bizItems[0].source_id, 'new-group-source');
  assert.equal(h.writes.length, 0);
});

test('partial original project authorization cannot select the unified form and an existing legacy report blocks that week', async () => {
  const h = harness();
  Object.assign(h.S, { projects: plain(projects), pms: projects.slice(0, 2).map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r1', profile: { user_id: 'anonymous', name: '部分授权填报人', role: 'pm', status: 'approved', discipline: '工程' }, monthlyPlans: [] });
  await h.preparePM();
  assert.equal(h.S.pmReportScope, null); assert.equal(h.reportingProjects().length, 2);
  h.S.pms = projects.map(project => ({ user_id: 'anonymous', project_id: project.id }));
  h.S.reports = [{ id: 'old-report', project_id: 'r3', period: '2026-10-19', line: '综合', author_id: 'original-author', biz: { nodes: [] } }];
  await h.preparePM();
  assert.equal(h.S.pmReportScope, null); assert.equal(h.reportingProjects().length, 3);
  assert.equal(h.S.reports[0].project_id, 'r3'); assert.equal(h.S.reports[0].author_id, 'original-author');
  assert.equal(h.writes.length, 0);
});

test('group history retains each original author, attachment, rich field and source without duplicating the unified report', async () => {
  const h = harness();
  Object.assign(h.S, { projects: plain(projects), pms: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r1', profile: { user_id: 'anonymous', role: 'pm', status: 'approved', discipline: '工程' }, monthlyPlans: [] });
  h.S.reports = [{ id: 'old-r2', project_id: 'r2', period: '2026-10-12', author_id: 'old-author', rich_text: { v: 1, fields: { change_text: { ops: [{ insert: '历史原正文', attributes: { bold: true } }] } } }, biz: { items: [{ source_id: 'original-source', name: '历史原正文' }], attachments: ['old-attachment'] } },
    { id: 'new-group', project_id: 'r1', report_scope_id: scope.id, scope_project_ids: scope.project_ids, line: '综合', period: '2026-10-19', author_id: 'anonymous', biz: { items: [{ source_id: 'new-source', name: '组报原正文' }], nodes: [], attachments: ['new-attachment'] } }];
  const before = JSON.stringify(h.S.reports);
  await h.preparePM();
  const history = h.pmHistoryReports();
  assert.deepEqual(plain(history.map(row => row.id)), ['old-r2', 'new-group']);
  assert.equal(h.S.pmReport.id, 'new-group'); assert.equal(h.S.bizItems[0].source_id, 'new-source');
  assert.equal(history[0].author_id, 'old-author'); assert.equal(history[0].biz.attachments[0], 'old-attachment');
  assert.equal(history[0].rich_text.fields.change_text.ops[0].attributes.bold, true);
  assert.equal(JSON.stringify(h.S.reports), before);
});

test('actual App resubmission retains non-anchor project IDs, source IDs and rich fields for every existing group-report section', async () => {
  const h = harness();
  const original = { id: 'existing-group', project_id: 'r1', report_scope_id: scope.id, scope_project_ids: scope.project_ids,
    period: '2026-10-19', line: '综合', author_id: 'anonymous', author_name: '原填报人', submitted_at: '2026-10-19T02:00:00Z',
    coord_items: [{ project_id: 'r3', source_id: 'original-coordinate', who_id: 'original-owner', who: '原承办人', what: '原协调内容', by: '2026-10-25' }],
    biz: { form_version: 2,
      nodes: [{ project_id: 'r2', milestone_id: 901, source_id: 'original-node', name: '原节点', plan: '2026-10-23', forecast: '2026-10-24', prog: '原节点反馈', is_key: true }],
      items: [{ project_id: 'r2', source_id: 'original-item', mod: '工程', name: '原月计划事项', due: '2026-10-24', prog: '原事项进展', blocker: '原事项卡点' }],
      handover: [{ project_id: 'r3', source_id: 'original-handover', what: '原移交内容', to: '原接收人', due: '2026-10-25' }],
      attachments: ['original-attachment'] },
    rich_text: { v: 1, fields: Object.fromEntries([
      ['biz.nodes.0.prog', '原节点反馈'], ['biz.items.0.prog', '原事项进展'], ['biz.items.0.blocker', '原事项卡点'],
      ['biz.handover.0.what', '原移交内容'], ['coord_items.0.what', '原协调内容']
    ].map(([field, text]) => [field, { ops: [{ insert: text, attributes: { bold: true, color: '#d81e06' } }] }])) } };
  Object.assign(h.S, { projects: plain(projects), pms: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r2', profile: { user_id: 'anonymous', name: '原填报人', role: 'pm', status: 'approved', discipline: '工程' },
    monthlyPlans: [], reports: [original], attachmentIds: ['original-attachment'] });
  h.sandbox.ZHRichText.attach(original);
  const originalBytes = JSON.stringify(original);
  await h.preparePM();
  assert.equal(h.S.pmReport.id, 'existing-group');
  await h.App.submitReport();
  assert.equal(h.writes.length, 1, 'the actual submit handler sends one group report, without copying it to member projects');
  const saved = h.writes[0].row;
  assert.equal(h.writes[0].table, 'reports'); assert.equal(saved.project_id, 'r1'); assert.equal(saved.report_scope_id, scope.id);
  assert.deepEqual([saved.biz.nodes[0].project_id, saved.biz.items[0].project_id, saved.biz.handover[0].project_id, saved.coord_items[0].project_id], ['r2', 'r2', 'r3', 'r3']);
  assert.deepEqual([saved.biz.nodes[0].source_id, saved.biz.items[0].source_id, saved.biz.handover[0].source_id, saved.coord_items[0].source_id],
    ['original-node', 'original-item', 'original-handover', 'original-coordinate']);
  assert.equal(saved.biz.nodes[0].milestone_id, 901); assert.equal(saved.node_items[0].milestone_id, 901); assert.equal(saved.node_items[0].project_id, 'r2');
  assert.equal(saved.coord_items[0].who_id, 'original-owner');
  for (const field of ['biz.nodes.0.prog', 'node_items.0.reason', 'biz.items.0.prog', 'biz.items.0.blocker', 'biz.handover.0.what', 'coord_items.0.what']) {
    assert.equal(saved.rich_text.fields[field].ops[0].attributes.bold, true, field + ' must retain original formatting');
    assert.equal(saved.rich_text.fields[field].ops[0].attributes.color, '#d81e06');
  }
  assert.equal(JSON.stringify(original), originalBytes, 'building the payload does not rewrite the old report or its source associations');
});

test('actual legacy-draft modal displays the original project name and read-only content without converting a helper function to visible text', async () => {
  const h = harness(), mounted = [];
  Object.assign(h.S, { projects: plain(projects), pms: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r1', profile: { user_id: 'anonymous', name: '匿名住宅填报人', role: 'pm', status: 'approved', discipline: '工程' }, monthlyPlans: [] });
  const key = 'zh_draft_anonymous_r2_43', raw = JSON.stringify({ ts: Date.now(), bizItems: [{ source_id: 'old-project-source', name: '原地块草稿正文', prog: '原稿进展' }] });
  h.storage.set(key, raw);
  await h.preparePM();
  h.sandbox.document.createElement = () => ({ innerHTML: '', addEventListener() {}, querySelector: () => null });
  h.sandbox.document.body = { appendChild: element => mounted.push(element) };
  h.App.showLegacyScopeDraft('r2');
  assert.equal(mounted.length, 1);
  assert.match(mounted[0].innerHTML, /匿名住宅1 · 原地块本机草稿（只读核对）/);
  assert.match(mounted[0].innerHTML, /匿名住宅1 · 本机草稿（未提交，只读核对）/);
  assert.match(mounted[0].innerHTML, /原地块草稿正文|原稿进展/);
  assert.match(mounted[0].innerHTML, /<textarea readonly[^>]*aria-label="原始草稿备份"/);
  assert.doesNotMatch(mounted[0].innerHTML, /function\s+projName|function\s*\(|return\s+S\.|=>/);
  assert.equal(h.storage.get(key), raw); assert.equal(h.writes.length, 0);
});

test('same-week group-report aliases read attachment metadata under the stored period and retain the selected original file in the actual submit payload', async () => {
  const h = harness({ realAttachments: true }), attachmentId = '10000000-0000-4000-8000-000000000091';
  const original = { id: 'group-with-existing-file', project_id: 'r1', report_scope_id: scope.id, scope_project_ids: scope.project_ids,
    period: '2026-10-19', line: '综合', author_id: 'anonymous', author_name: '原填报人', submitted_at: '2026-10-19T02:00:00Z',
    biz: { form_version: 2, nodes: [], items: [{ project_id: 'r2', source_id: 'original-item', name: '原组报事项', prog: '原进展' }], handover: [], attachments: [attachmentId] } };
  Object.assign(h.S, { projects: plain(projects), pms: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })),
    reportScopes: [plain(scope)], pmProject: 'r2', pmPeriod: '第43周（2026.10.19–2026.10.25）',
    profile: { user_id: 'anonymous', name: '原填报人', role: 'pm', status: 'approved', discipline: '工程' }, monthlyPlans: [], reports: [original] });
  h.fixture.attachments = [{ id: attachmentId, project_id: 'r1', report_scope_id: scope.id, period: '2026-10-19', line: '综合', owner_id: 'anonymous',
    name: '原组报附件.png', mime: 'image/png', inline: true, size: 2048, referenced: true }];
  const originalBytes = JSON.stringify(original), metadataBytes = JSON.stringify(h.fixture.attachments);
  assert.equal(await h.loadData(['reportAttachments'], true), true);
  const calls = h.requests.filter(request => request.url === '/api/report-attachments/list');
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].body), { project_id: 'r1', period: '2026-10-19', line: '综合', report_scope_id: scope.id });
  assert.equal(h.S.reportAttachments.length, 1, 'the original file must not disappear because a same-week display label was used');
  await h.preparePM();
  assert.equal(h.S.pmPeriod, original.period);
  assert.deepEqual(plain(h.sandbox.ReportAttachments.ids()), [attachmentId]);
  assert.equal(h.sandbox.ReportAttachments.validationError(), '');
  const html = h.sandbox.ReportAttachments.formHtml();
  assert.match(html, /原组报附件\.png/); assert.match(html, / checked/);
  assert.doesNotMatch(html, /部分附件资料尚未加载|所选附件不属于当前本人填报范围/);
  await h.App.submitReport();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].row.period, '2026-10-19');
  assert.deepEqual(h.writes[0].row.biz.attachments, [attachmentId]);
  assert.equal(h.writes[0].row.biz.items[0].project_id, 'r2');
  assert.equal(JSON.stringify(original), originalBytes); assert.equal(JSON.stringify(h.fixture.attachments), metadataBytes);
  assert.ok(h.requests.every(request => !/\/(?:upload|create|save|discard)$/.test(request.url)), 'reading the same report never creates a replacement-period attachment');
});

test('actual Edge desktop and phone preserve monthly feedback while baseline imports, read errors and grouped drafts use their own sources', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const artifacts = process.env.ADMIN2_APP_ARTIFACT_DIR || path.join(os.tmpdir(), 'admin2-app-artifacts');
  mkdirSync(artifacts, { recursive: true });
  const errors = [], requests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).pathname.endsWith('/logo.png')
      ? route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(new URL('logo.png', web)) })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>' }));
    await page.goto('http://admin2-app.test/');
    await page.exposeFunction('recordIsolatedRequest', request => requests.push(request));
    await page.evaluate(({ plan }) => {
      window.fixtureTables = { projects: [{ id: 'commercial', name: '匿名商业项目', project_type: 'com', active: true }], project_members: [{ project_id: 'commercial', user_id: 'anonymous' }],
        reports: [], milestones: [], monthlyPlans: [plan], reportScopes: [], milestoneError: null };
      window.WorkBuddyCloud = { createWorkBuddyCloud: () => ({ auth: {}, database: { from(table) {
        const q = { select() { return q; }, eq() { return q; }, limit() { return q; }, order() { return q; },
          then(resolve, reject) { return Promise.resolve({ data: window.fixtureTables[table] || [], error: table === 'milestones' ? window.fixtureTables.milestoneError : null }).then(resolve, reject); } };
        return q;
      } } }) };
      window.CompletionReview = { configure() {}, approved: () => false, effectiveDue: (_key, due) => due,
        actionHtml: key => '<span data-claim="' + key + '">原事项申报</span>', snapshotsHtml: () => '', overlayHtml: () => '' };
      window.fetch = async (url, options = {}) => {
        window.recordIsolatedRequest({ url: String(url), method: options.method || 'GET' });
        const key = { '/api/monthly-plans/list': 'monthlyPlans', '/api/report-scopes/list': 'reportScopes' }[String(url)];
        return new Response(JSON.stringify({ data: window.fixtureTables[key] || [], error: null, meta: { has_more: false, next_cursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    }, { plan: plain(plan) });
    for (const name of ['styles.css', 'planning-ui.css', 'report3-layout.css', 'reporter-workbench.css', 'reporter-tasks.css', 'personal-report4.css', 'selection-format.css', 'vendor/quill/quill.core.css'])
      await page.addStyleTag({ content: readFileSync(new URL(name, web), 'utf8') });
    for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'monthly-plans.js'])
      await page.addScriptTag({ content: readFileSync(new URL(name, web), 'utf8') });
    await page.addScriptTag({ content: exposed });
    await page.evaluate(async () => {
      const h = window.audit, S = h.S, f = window.fixtureTables;
      Object.assign(S, { uid: 'anonymous', session: {}, view: 'form', pmProject: 'commercial', pmPeriod: '2026-10-19', pmLine: '机电工程',
        profile: { user_id: 'anonymous', name: '匿名填报人', role: 'pm', status: 'approved', project_id: 'commercial', biz_line: '机电工程', discipline: '工程' },
        projects: f.projects, pms: f.project_members, monthlyPlans: f.monthlyPlans, reports: [], reportScopes: [], milestones: [] });
      await h.loadData(['milestones'], true); h.configureReporter(); await h.preparePM(); h.renderShell();
    });
    await expect(page.locator('#baseline-core-summary')).toContainText('尚未导入项目基准节点');
    await expect(page.locator('#baseline-core-summary')).not.toContainText('确认月计划同名事项');
    await expect(page.locator('.report3-monthly-table')).toContainText('确认月计划同名事项');
    await expect(page.locator('[data-claim="monthly:commercial:confirmed-plan:fixed-item"]')).toHaveCount(1);
    await page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor').fill('第二部分原进展\n遇到卡点：第二部分卡点');
    await page.evaluate(() => window.MonthlyPlans.refreshCore());
    await expect(page.locator('#baseline-core-summary')).toContainText('尚未导入项目基准节点');
    await page.screenshot({ path: path.join(artifacts, 'commercial-no-baseline-desktop.png'), fullPage: true });
    await page.evaluate(async () => {
      window.fixtureTables.milestones = [{ id: 701, project_id: 'commercial', name: '确认月计划同名事项', biz_line: '机电工程', is_key: false, plan_date: '2026-10-20', forecast_date: '2026-11-05', note: '导入基准原说明' },
        { id: 702, project_id: 'commercial', name: '商业关键基准', biz_line: '机电工程', is_key: true, plan_date: '2026-10-23' }];
      await window.App.reload();
    });
    await expect(page.locator('#baseline-core-summary [data-source-key="milestone:commercial:701"]')).toHaveCount(1);
    await expect(page.locator('#baseline-core-summary')).toContainText('2026-10-20');
    await expect(page.locator('#baseline-core-summary')).not.toContainText('第二部分原进展');
    await expect(page.locator('#bi_pg_0')).toHaveValue('第二部分原进展\n遇到卡点：第二部分卡点');
    await page.locator('#baseline-core-summary select').selectOption('key');
    await expect(page.locator('#baseline-core-summary [data-source-key]')).toHaveCount(1);
    await expect(page.locator('#bi_pg_0')).toHaveValue('第二部分原进展\n遇到卡点：第二部分卡点');
    await page.locator('#baseline-core-summary select').selectOption('all');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#baseline-core-summary [data-source-key]')).toHaveCount(2);
    await expect(page.locator('#baseline-core-summary input, #baseline-core-summary textarea')).toHaveCount(0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(artifacts, 'commercial-baseline-mobile.png'), fullPage: true });
    await page.screenshot({ path: path.join(artifacts, 'commercial-baseline-mobile-viewport.png') });
    await page.evaluate(async () => { window.fixtureTables.milestoneError = { message: '隔离读取失败' }; await window.App.reload(); });
    await expect(page.locator('#baseline-core-summary')).toContainText('项目基准节点读取失败');
    await expect(page.locator('#baseline-core-summary')).not.toContainText('尚未导入');
    await expect(page.locator('#bi_pg_0')).toHaveValue('第二部分原进展\n遇到卡点：第二部分卡点');
    await page.screenshot({ path: path.join(artifacts, 'commercial-baseline-error-mobile.png'), fullPage: true });
    await page.evaluate(async ({ projects, scope }) => {
      const h = window.audit, S = h.S;
      const old = JSON.stringify({ ts: 1, bizItems: [{ source_id: 'legacy-plot-source', name: '原地块草稿独立保留' }] });
      scope.project_ids.forEach(id => localStorage.setItem('zh_draft_anonymous_' + id + '_43', old));
      window.legacyDraftBytes = old;
      Object.assign(window.fixtureTables, { projects, project_members: projects.map(project => ({ user_id: 'anonymous', project_id: project.id })), reportScopes: [scope], milestoneError: null,
        milestones: projects.map((project, i) => ({ id: 801 + i, project_id: project.id, name: '原项目基准' + i, discipline: '工程', is_key: true, plan_date: '2026-10-23' })) });
      Object.assign(S, { projects: window.fixtureTables.projects, pms: window.fixtureTables.project_members, reportScopes: [scope], pmProject: 'r2', pmRenderedScope: undefined,
        pmReport: null, pmReportScope: null, pmScopeId: null, reports: [], monthlyPlans: [], profile: { user_id: 'anonymous', name: '匿名住宅填报人', role: 'pm', status: 'approved', discipline: '工程' } });
      await h.loadData(['milestones'], true); await h.preparePM(); h.renderShell();
    }, { projects: plain(projects), scope: plain(scope) });
    await expect(page.locator('.plan-context-project')).toContainText('匿名统一住宅');
    await expect(page.locator('#baseline-core-summary [data-source-key]')).toHaveCount(3);
    await expect(page.getByText('发现 3 份原地块本机草稿（独立保留）', { exact: true })).toBeVisible();
    await expect(page.locator('#baseline-core-summary')).not.toContainText('原地块草稿独立保留');
    await page.locator('[data-rich-editor-for="bi_nm_0"] .ql-editor').fill('统一组稿正文');
    await page.getByRole('button', { name: '保存本机草稿', exact: true }).click();
    assert.equal(await page.evaluate(() => window.audit.S.pmProject), 'r1');
    assert.equal(await page.evaluate(() => window.audit.reportingProjects().length), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(window.audit.draftKey())).bizItems[0].name), '统一组稿正文');
    assert.equal(await page.evaluate(() => ['r1', 'r2', 'r3'].every(id => localStorage.getItem('zh_draft_anonymous_' + id + '_43') === window.legacyDraftBytes)), true);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(artifacts, 'residential-scope-mobile.png'), fullPage: true });
    await page.screenshot({ path: path.join(artifacts, 'residential-scope-mobile-viewport.png') });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'residential-scope-desktop.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => !/\/(?:save|create|confirm|request|review|upload)$/.test(request.url)));
    writeFileSync(path.join(artifacts, 'admin2-app-ui-result.json'), JSON.stringify({ desktop: true, mobile: true, noMonthlyFallback: true, importRefresh: true,
      baselineReadFailure: true, exactSourceKeys: true, secondSectionPreserved: true, residentialGroup: true, legacyDraftsUnchanged: true, browserErrors: errors, businessWrites: 0, mockedRequests: requests }, null, 2));
  } finally { await browser.close(); }
});
