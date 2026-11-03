import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import {chromium, expect} from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const source = readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);

function harness({realTasks = false} = {}) {
  const storage = new Map(), writes = [], rows = [], events = [];
  const elements = {root: {innerHTML: ''}, toast: {style: {}}};
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    document: {getElementById: id => elements[id] || null,
      querySelectorAll: selector => selector === '[data-followup-key]' ? rows : [], querySelector: () => null,
      addEventListener() {}, removeEventListener() {}, body: {appendChild() {}}},
    WorkBuddyCloud: {createWorkBuddyCloud: () => ({auth: {}, database: {from(table) {
      const query = {select() {return query;}, eq() {return query;}, limit() {return query;}, order() {return query;},
        update(payload) {writes.push({table, payload}); return query;},
        then(resolve, reject) {return Promise.resolve({data: [], error: null}).then(resolve, reject);}};
      return query;
    }}})},
    CompletionReview: {configure() {}, actionHtml: key => '<button data-claim="' + key + '">原完成／延期入口</button>', approved: () => false,
      effectiveDue: (key, due) => due, snapshotsHtml: () => '', renderQueue: () => ''},
    ReporterTasks: {configure() {}, binding: () => null, capture() {}, sourceItems: () => [], snapshotHtml: () => ''}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ['rich-text.js', 'planning-windows.js', 'monthly-plans.js', ...(realTasks ? ['reporter-tasks.js'] : [])]) {
    vm.runInContext(readFileSync(new URL(name, web), 'utf8'), sandbox);
  }
  vm.runInContext(source.slice(0, boundary) + '\nwindow.audit={S,App,viewMyLine,criticalWorkItems,personalPriorityCard,richBinding,richCollect,mergePlanProgress,planItemActionHtml,reporterNodeSectionHtml,reportSnapshotHtml,currentPeriod,configureReporter,draftKey,pmDraftScope,setPage:fn=>{showPage=fn;}};\n})();', sandbox);
  const h = sandbox.audit, S = h.S;
  Object.assign(S, {uid: 'anonymous', session: {},
    profile: {user_id: 'anonymous', role: 'pm', status: 'approved', project_id: 'p1', name: '匿名填报人'},
    projects: [{id: 'p1', name: '匿名住宅项目'}, {id: 'private', name: '未授权项目'}],
    pms: [{user_id: 'anonymous', project_id: 'p1'}], pmProject: 'p1', pmPeriod: h.currentPeriod(),
    reports: [], milestones: [], leaderNotes: [], reporterTasks: [], followupRows: [], view: 'center'});
  h.configureReporter();
  return {...h, sandbox, storage, writes, rows, events, elements};
}
function sourceRow(key, extra = {}) {
  return {source_key: key, source_type: 'meeting', title: '原会议事项（待分类）', what: '原任务正文', progress: '实时源上的新进展', due: '2026-12-01', ...extra};
}

test('combined progress keeps both rich fragments through JSON drafts and does not merge twice', () => {
  const h = harness(), rich = h.sandbox.ZHRichText;
  const saved = {prog:'原进展',blocker:'原卡点',source_id:'stable',_rich:{
    prog:{ops:[{insert:'原进展',attributes:{bold:true}}]},
    blocker:{ops:[{insert:'原卡点',attributes:{color:'#d81e06'}}]}}};
  const before = JSON.stringify(saved), working = JSON.parse(before);
  h.mergePlanProgress(working);
  assert.equal(working.prog,'原进展\n遇到卡点：原卡点');
  assert.equal(working.blocker,'');
  const draft = JSON.parse(JSON.stringify(working));
  h.mergePlanProgress(draft);
  assert.equal(JSON.stringify(draft),JSON.stringify(working));
  const payload = h.richCollect({biz:{items:[draft]}});
  assert.equal(payload.biz.items[0].source_id,'stable');
  assert.equal(payload.rich_text.fields['biz.items.0.blocker'],undefined);
  const html = rich.render(payload.rich_text.fields['biz.items.0.prog']);
  assert.match(html,/<strong>原进展<\/strong>/);
  assert.match(html,/<span class="rt-red">原卡点<\/span>/);
  assert.equal(JSON.stringify(saved),before);
});

test('monthly row actions keep the confirmed source without a weekly report and preserve owner options', () => {
  const h=harness();
  h.S.projects[0].project_type='com';h.S.profile.biz_line='机电工程';h.S.pmLine='机电工程';
  const plan={id:'confirmed',project_id:'p1',line:'机电工程',confirmed_by:h.S.uid,plan_month:'2026-10-01',
    items:[{source_id:'one',name:'本人月计划',due:'2026-10-31'}]};
  h.S.monthlyPlans=[plan];h.S.pmReport=null;
  const calls=[];h.sandbox.CompletionReview.actionHtml=(key,options)=>{calls.push({key,...options});return '<button data-claim="'+key+'">申报</button>';};
  const html=h.planItemActionHtml(plan.items[0]);
  assert.match(html,/data-claim="monthly:p1:confirmed:one"/);
  assert.equal(calls[0].owner_id,h.S.uid);assert.equal(calls[0].readOnly,false);
  h.S.monthlyPlans[0].confirmed_by='other';h.planItemActionHtml(plan.items[0]);
  assert.equal(calls[1].owner_id,'other');assert.equal(calls[1].readOnly,true);
  assert.equal(h.S.pmReport,null);
  assert.equal(h.writes.length,0);
});

test('only custom nodes remain in the workbench and monthly actions require a saved source', () => {
  const h=harness(),item={source_id:'saved',name:'本人事项'};
  h.S.reports=[{id:7,author_id:h.S.uid,project_id:'p1',line:'全部',biz:{items:[item],nodes:[{source_id:'custom-node',name:'原自主节点'}]}}];
  const html=h.reporterNodeSectionHtml('p1');
  assert.doesNotMatch(html,/data-plan-section="items"|plan:p1:7:items:/);
  assert.match(html,/data-claim="plan:p1:7:nodes:custom-node"/);
  assert.match(html,/data-plan-section="nodes"/);
  assert.doesNotMatch(html,/coord:/);
  h.S.pmReport=h.S.reports[0];
  assert.match(h.planItemActionHtml(item),/data-claim="plan:p1:7:items:saved"/);
  assert.doesNotMatch(h.planItemActionHtml({source_id:'unsaved',name:'新草稿'}),/data-claim=/);
  h.S.reports[0].author_id='other';
  assert.equal(h.reporterNodeSectionHtml('p1'),'');
  assert.doesNotMatch(h.planItemActionHtml(item),/data-claim=/);
});

test('legacy monthly actions retain the original report source and refresh conflicts cannot fabricate an action', () => {
  const h=harness();h.S.projects[0].project_type='com';h.S.profile.biz_line='机电工程';h.S.pmLine='机电工程';h.S.pmPeriod='2026-10-19';
  const item={source_id:'old',mod:'原模块',name:'既有事项',due:'2026-10-23'};
  h.S.pmReport={id:11,project_id:'p1',author_id:h.S.uid,line:'机电工程',period:'2026-10-19',biz:{items:[item]}};
  h.S.monthlyPlans=[{id:'later-plan',project_id:'p1',line:'机电工程',confirmed_by:h.S.uid,plan_month:'2026-10-01',items:[{source_id:'new',name:'新事项',due:'2026-10-31'}]}];
  const before=JSON.stringify(h.S.pmReport);
  assert.match(h.planItemActionHtml(item),/data-claim="plan:p1:11:items:old"/);
  assert.equal(JSON.stringify(h.S.pmReport),before);
  h.sandbox.MonthlyPlans.locked=()=>true;h.sandbox.MonthlyPlans.actionHtml=()=>'';
  assert.match(h.planItemActionHtml(item),/重新读取确认版/);
  assert.doesNotMatch(h.planItemActionHtml(item),/data-claim=/);
});

test('personal node reads preserve saved rich notes, all source fields and preexisting drafts without writing', () => {
  const h = harness();
  h.S.milestones = [{id: 17, project_id: 'p1', name: '原节点', line: '工程', level: '三级', standard: '原完成标准',
    plan_date: '2026-12-01', forecast_date: '2026-12-03', note: '原卡点说明', done: false,
    rich_text: {v: 1, fields: {note: {ops: [{insert: '原卡点说明', attributes: {bold: true, color: '#d81e06'}}]}}}},
  {id: 18, project_id: 'private', name: '无权节点', line: '工程', plan_date: '2026-12-02'}];
  h.S.mlineDraft = {17: {forecast_date: '2026-12-04', note: '先前未提交草稿'}};
  const before = JSON.stringify({nodes: h.S.milestones, drafts: h.S.mlineDraft});
  const html = h.viewMyLine();
  h.App.mlineCapture();
  assert.match(html, /data-milestone="17"/);
  assert.match(html, /data-claim="milestone:p1:17"/);
  assert.match(html, /<span class="rt-red"><strong>原卡点说明<\/strong><\/span>/);
  assert.match(html, /原完成标准/);
  assert.doesNotMatch(html, /无权节点|id="ml_fc_|id="ml_note_|App\.mlineSave\(/);
  assert.equal(JSON.stringify({nodes: h.S.milestones, drafts: h.S.mlineDraft}), before);
  assert.equal(h.writes.length, 0);
});

test('priority projection uses an explicitly empty selected-period feedback rather than live progress', () => {
  const h = harness(), key = 'meeting:p1:original-id';
  h.sandbox.ReporterTasks.sourceItems = () => [sourceRow(key)];
  h.S.followupRows = [sourceRow(key, {progress: '', status: 'open'})];
  assert.equal(h.criticalWorkItems('p1')[0].prog, '');
  const html = h.personalPriorityCard('p1');
  assert.doesNotMatch(html, /实时源上的新进展/);
  assert.match(html, /^<details class="card personal-priority-summary"><summary>/);
  assert.match(html, /meeting:p1:original-id/);
});

test('priority display keeps source title formatting and selected-period progress formatting independently', () => {
  const h = harness(), key = 'meeting:p1:original-id';
  h.sandbox.ReporterTasks.sourceItems = () => [sourceRow(key, {
    rich_text: {v: 1, fields: {what: {ops: [{insert: '原任务正文', attributes: {bold: true}}]}}}
  })];
  h.S.followupRows = [sourceRow(key, {progress: '本期反馈',
    rich_text: {v: 1, fields: {progress: {ops: [{insert: '本期反馈', attributes: {color: '#d81e06'}}]}}}
  })];
  const html = h.personalPriorityCard('p1');
  assert.match(html, /<strong>原任务正文<\/strong>/);
  assert.match(html, /<span class="rt-red">本期反馈<\/span>/);
  assert.doesNotMatch(html, /实时源上的新进展/);
});

test('historical priority projection does not import current live progress when that period has no feedback', () => {
  const h = harness({realTasks: true});
  h.S.pmPeriod = '2026-09-28';
  h.S.reporterTasks = [{id: 'original-id', project_id: 'p1', owner_id: h.S.uid, title: '原会议要求', what: '原任务正文',
    due: '2026-12-01', progress: '实时源上的新进展', status: 'in_progress', created_at: '2026-09-01T01:00:00Z', updated_at: '2026-10-21T01:00:00Z', revision: 5}];
  h.configureReporter();
  const projected = h.criticalWorkItems('p1');
  assert.equal(projected.length, 1);
  assert.equal(projected[0].prog, '');
  assert.doesNotMatch(h.personalPriorityCard('p1'), /实时源上的新进展/);
  assert.equal(h.S.reporterTasks[0].progress, '实时源上的新进展');
});

test('returning to an exact follow-up row awaits the normal scope transition and preserves rich local draft content', async () => {
  const h = harness(), key = 'meeting:p1:key"]:not(*)';
  h.S.view = 'form';
  h.S.bizItems = [{source_id: 'unchanged-source-id', name: '原事项', prog: '输入进展', blocker: '原卡点'}];
  h.richBinding('bi_blocker_0').set({ops: [{insert: '原卡点', attributes: {bold: true}}]});
  h.elements.bi_pg_0 = {value: '尚未提交的新进展'};
  h.elements.bi_blocker_0 = {value: '原卡点'};
  h.S.pmRenderedScope = h.pmDraftScope();
  const target = {getAttribute: name => name === 'data-followup-key' ? key : null,
    scrollIntoView: () => h.events.push('scroll'), querySelector: selector => selector === '.ql-editor'
      ? {focus: () => h.events.push('focus')} : null};
  h.rows.push({getAttribute: () => key + '-near-match', scrollIntoView() {assert.fail('must match the full source key');}}, target);
  h.setPage(async () => {await Promise.resolve(); h.events.push('page-ready'); h.S.pmScopeTransition = null; return true;});
  await h.App.openFollowup(key);
  assert.deepEqual(h.events, ['page-ready', 'scroll', 'focus']);
  assert.equal(h.S.view, 'form');
  const draft = JSON.parse(h.storage.get(h.draftKey()));
  assert.equal(draft.bizItems[0].source_id, 'unchanged-source-id');
  assert.equal(draft.bizItems[0].prog, '尚未提交的新进展');
  assert.equal(draft.bizItems[0]._rich.blocker.ops[0].attributes.bold, true);
  assert.equal(h.writes.length, 0);
});

test('a blocked draft transition does not focus a stale follow-up row or discard form input', async () => {
  const h = harness(), key = 'meeting:p1:original-id';
  h.S.view = 'center';
  h.sandbox.localStorage.setItem = () => {throw new Error('anonymous storage failure');};
  h.S.followupRows = [sourceRow(key, {progress: '本期未提交进展'})];
  h.rows.push({getAttribute: () => key, scrollIntoView() {assert.fail('failed transition cannot target stale rows');}});
  h.setPage(async () => {assert.fail('draft failure must block the original scope transition');});
  await h.App.openFollowup(key);
  assert.equal(h.S.view, 'center');
  assert.equal(h.S.followupRows[0].progress, '本期未提交进展');
  assert.equal(h.writes.length, 0);
});

test('blocker formatting binds to the original item and remains rich in report history projection', () => {
  const h = harness();
  h.S.bizItems = [{source_id: 'fixed-source', mod: '原模块', name: '原事项', due: '2026-12-01', prog: '原进展', blocker: '遇到卡点'}];
  h.richBinding('bi_blocker_0').set({ops: [{insert: '遇到卡点', attributes: {color: '#d81e06', bold: true}}]});
  h.richBinding('bi_mod_0').set({ops: [{insert: '原模块', attributes: {bold: true}}]});
  const report = h.richCollect({project_id: 'p1', line: '全部', period: h.S.pmPeriod, author_name: '匿名填报人',
    biz: {form_version: 2, items: h.S.bizItems, nodes: [], handover: []}});
  assert.equal(report.biz.items[0].source_id, 'fixed-source');
  assert.equal(report.rich_text.fields['biz.items.0.blocker'].ops[0].attributes.bold, true);
  h.sandbox.ZHRichText.attach(report);
  assert.match(h.reportSnapshotHtml(report), /<span class="rt-red"><strong>遇到卡点<\/strong><\/span>/);
  assert.match(h.reportSnapshotHtml(report), /<strong>原模块<\/strong>/);
});

test('the actual desktop and mobile shell opens the original feedback editor while keeping nodes read-only', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const artifacts = process.env.PERSONAL4_APP_ARTIFACT_DIR || path.join(os.tmpdir(), 'personal4-app-artifacts');
  mkdirSync(artifacts, {recursive: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1080}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).pathname.endsWith('/logo.png')
      ? route.fulfill({status: 200, contentType: 'image/png', body: readFileSync(new URL('logo.png', web))})
      : route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>'}));
    await page.goto('http://personal4-app.test/');
    await page.evaluate(() => {
      window.WorkBuddyCloud = {createWorkBuddyCloud: () => ({auth: {}, database: {from() {throw new Error('anonymous UI check must not access a database');}}})};
      window.CompletionReview = {configure() {}, approved: () => false, effectiveDue: (key, due) => due,
        actionHtml: key => '<button class="btn" data-claim="' + key + '">原完成／延期入口</button>', overlayHtml: () => '', renderQueue: () => ''};
    });
    for (const name of ['styles.css', 'planning-ui.css', 'report3-layout.css', 'reporter-workbench.css', 'reporter-tasks.css', 'personal-report4.css', 'selection-format.css', 'vendor/quill/quill.core.css']) {
      await page.addStyleTag({content: readFileSync(new URL(name, web), 'utf8')});
    }
    for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'planning-windows.js', 'reporter-tasks.js']) {
      await page.addScriptTag({content: readFileSync(new URL(name, web), 'utf8')});
    }
    await page.addScriptTag({content: source.slice(0, boundary) + '\nwindow.audit={S,App,renderShell,currentPeriod,setPage:fn=>{showPage=fn;}};\n})();'});
    await page.evaluate(() => {
      const h = window.audit, S = h.S, key = 'meeting:p1:original-id';
      Object.assign(S, {uid: 'anonymous', session: {}, profile: {user_id: 'anonymous', role: 'pm', status: 'approved', name: '匿名填报人', project_id: 'p1'},
        projects: [{id: 'p1', name: '匿名住宅项目', active: true}], pms: [{user_id: 'anonymous', project_id: 'p1'}],
        pmProject: 'p1', pmPeriod: h.currentPeriod(), view: 'mline', pmLine: '综合',
        milestones: [{id: 17, project_id: 'p1', name: '原节点', line: '工程', plan_date: '2026-12-01', forecast_date: '2026-12-03', note: '原说明', done: false}],
        reporterTasks: [{id: 'original-id', project_id: 'p1', owner_id: 'anonymous', owner_name: '匿名填报人', title: '原任务', what: '原任务正文', due: '2026-12-01', status: 'open', progress: '源新进展', created_at: '2026-09-01T01:00:00Z', revision: 1}],
        followupRows: [{source_key: key, source_type: 'meeting', source_id: 'original-id', title: '原会议事项（待分类）', what: '原任务正文', due: '2026-12-01', status: 'in_progress', progress: '本期草稿进展'}],
        bizItems: [{source_id: 'preserved-item', name: '原事项', prog: '草稿内容', blocker: '原卡点'}]});
      h.setPage(async () => {S.pmScopeTransition = null; h.renderShell(); return true;});
      h.renderShell();
    });
    await expect(page.locator('[data-milestone="17"]')).toHaveCount(1);
    await expect(page.locator('[id^="ml_fc_"], [id^="ml_note_"]')).toHaveCount(0);
    await expect(page.locator('[data-claim="milestone:p1:17"]')).toBeVisible();
    await page.evaluate(() => {
      const S=window.audit.S;
      S.leaderNotes=[{id:'leader-original',project_id:'p1',owner_id:'anonymous',kind:'ceo_brief',what:'领导安排正文',period:window.audit.currentPeriod()}];
      S.reports=[{id:77,project_id:'p1',author_id:'other',author_name:'其他填报人',period:window.audit.currentPeriod(),coord_items:[{source_id:'need-original',who:'匿名填报人',what:'待回复正文',by:'2026-12-01'}]}];
    });
    await page.evaluate(() => window.App.view('center'));
    await expect(page.locator('.reporter-pending')).toHaveCount(1);
    for(const category of ['会议事项要求','他人协调我的事项'])await expect(page.locator('.reporter-pending')).toContainText(category);
    await expect(page.locator('.reporter-pending table')).toHaveCount(1);
    await expect(page.locator('.reporter-pending tbody tr')).toHaveCount(2);
    await expect(page.locator('.reporter-pending')).not.toContainText('领导安排正文');
    await expect(page.locator('.reporter-pending')).not.toContainText('本期进展从');

    await expect(page.locator('.personal-priority-summary,.reporter-legacy-meetings,.reporter-special-meetings,.reporter-requirements')).toHaveCount(0);
    await expect(page.locator('.reporter-pending')).toContainText('本期草稿进展');
    await page.screenshot({path: path.join(artifacts, 'desktop-overview.png'), fullPage: true});
    await page.locator('.reporter-pending tr').filter({hasText:'原任务正文'}).getByRole('button', {name: '填写本期反馈'}).click();
    await expect(page.locator('[data-followup-key="meeting:p1:original-id"] .ql-editor')).toBeFocused();
    await expect(page.locator('#followup_progress_0')).toHaveValue('本期草稿进展');
    assert.equal(await page.evaluate(() => window.audit.S.followupRows[0].source_key), 'meeting:p1:original-id');
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.App.view('center'));
    await expect(page.locator('.reporter-pending')).toContainText('本期草稿进展');
    await page.screenshot({path: path.join(artifacts, 'mobile-overview.png'), fullPage: true});
    await page.locator('.reporter-pending tr').filter({hasText:'原任务正文'}).getByRole('button', {name: '填写本期反馈'}).click();
    await expect(page.locator('[data-followup-key="meeting:p1:original-id"] .ql-editor')).toBeFocused();
    await expect(page.locator('[data-followup-key="meeting:p1:original-id"] .ql-editor')).toBeInViewport({ratio: 0.5});
    await page.screenshot({path: path.join(artifacts, 'mobile-feedback.png'), fullPage: true});
    await page.screenshot({path: path.join(artifacts, 'mobile-feedback-viewport.png')});
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
