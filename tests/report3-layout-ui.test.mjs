import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium, expect} from '@playwright/test';

const web = new URL('../web/', import.meta.url);
const app = fs.readFileSync(new URL('app.js', web), 'utf8')
  .replace('window.App = App;', 'window.App = App; window.audit = {S,configureReporter,renderShell,preparePM,loadPageData,loadData};')
  .replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
const artifacts = process.env.REPORT3_ARTIFACT_DIR || path.join(os.tmpdir(), 'report3-layout-artifacts');

test('personal reporting renders compact desktop and mobile tables, shared formatting and a complete separate coordination page', async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  fs.mkdirSync(artifacts, {recursive: true});
  const errors = [], requests = [];
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 1100}});
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/logo.png')) return route.fulfill({status: 200, contentType: 'image/png', body: fs.readFileSync(new URL('logo.png', web))});
      return route.fulfill({status: 200, contentType: 'text/html', body: '<div id="root"></div><div id="toast"></div>'});
    });
    await page.goto('http://report3-layout.test/');
    await page.exposeFunction('recordFixtureRequest', request => requests.push(request));
    await page.evaluate(() => {
      const line = '土建工程（东地块）', period = '2026-10-19';
      const item = {source_id: 'fixed-item', mod: '砌筑工程', name: '匿名已确认月计划事项，包含足够长的正文用于检查换行', due: '2026-10-23', prog: '原进展', blocker: '原卡点'};
      const report = {id: 11, project_id: 'p1', line, period, author_id: 'anonymous', author_name: '匿名填报人', status: '正常', submitted_at: '2026-10-19T05:00:00Z',
        coord_items: [{source_id: 'old-coordination', who_id: 'other', who: '匿名承办人', what: '旧报告协调事项需保留', by: '2026-10-24'}],
        node_items: [], biz: {form_version: 2, monthly_plan_id: 'confirmed-plan', monthly_plan_month: '2026-10', nodes: [{source_id:'custom-node',name:'匿名自填节点',plan:'2026-10-23',prog:'原节点反馈'}], items: [item], handover: []}};
      const otherReport = {id: 12, project_id: 'p1', line: '成本', period, author_id: 'other', author_name: '匿名另一填报人',
        coord_items: [{source_id: 'not-for-me', who_id: 'third', who: '第三位承办人', what: '未指定给本人的需求不应显示', by: '2026-10-24'}], biz: {nodes: [], items: [], handover: []}};
      window.fixtureTables = {
        projects: [{id: 'p1', name: '匿名版式项目', project_type: 'com', active: true}],
        project_members: [{project_id: 'p1', user_id: 'anonymous'}, {project_id: 'p1', user_id: 'other'}],
        reports: [report, otherReport], profiles: [], milestones: [{id: 91, project_id: 'p1', name: '独立商业基准节点', biz_line: line, is_key: false,
          plan_date: '2026-10-23', forecast_date: '2026-10-26', note: '原节点说明'}], leader_notes: [], org_list: [],
        monthlyPlans: [{id: 'confirmed-plan', project_id: 'p1', line, plan_month: '2026-10-01', confirmed_by: 'anonymous', confirmed_by_name: '匿名填报人', items: [{source_id: item.source_id, mod: item.mod, name: item.name, due: item.due}]}],
        projectPeople: [{user_id: 'anonymous', name: '匿名填报人', role: 'pm', biz_line: line}, {user_id: 'other', name: '匿名承办人', role: 'pm', biz_line: '成本'}],
        coordinationTasks: [{id: 'direct-coordination', project_id: 'p1', author_id: 'anonymous', author_name: '匿名填报人', owner_id: 'other', owner_name: '匿名承办人', what: '独立发起协调事项需保留', due: '2026-10-24'}]
      };
      window.WorkBuddyCloud = {createWorkBuddyCloud: () => ({auth: {}, database: {from(table) {
        const q = {select() {return q;}, eq() {return q;}, limit() {return q;}, order() {return q;},
          then(resolve, reject) {return Promise.resolve({data: window.fixtureTables[table] || [], error: null}).then(resolve, reject);}};
        return q;
      }}})};
      window.fetch = async (url, options = {}) => {
        window.recordFixtureRequest({url: String(url), method: options.method || 'GET',body:options.body && JSON.parse(options.body)});
        if(String(url)==='/api/completions/preview'){
          if(window.failPreviewOnce){window.failPreviewOnce=false;return new Response(JSON.stringify({data:null,error:{code:'source_changed',message:'模拟来源变化'}}),{status:409,headers:{'content-type':'application/json'}});}
          return new Response(JSON.stringify({data:{source_version:'anonymous-v1',source_key:JSON.parse(options.body).source_key,kind:'plan',what:'匿名已确认月计划事项',due:'2026-10-23'},error:null}),{status:200,headers:{'content-type':'application/json'}});
        }
        const source = {'/api/monthly-plans/list': 'monthlyPlans', '/api/project-people/list': 'projectPeople', '/api/coordination-tasks/list': 'coordinationTasks'}[String(url)];
        return new Response(JSON.stringify({data: window.fixtureTables[source] || [], error: null, meta: {has_more: false, next_cursor: null}}), {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    for (const name of ['styles.css', 'planning-ui.css', 'report3-layout.css', 'personal-report4.css', 'selection-format.css', 'reporter-workbench.css', 'reporter-tasks.css', 'completion-review.css', 'vendor/quill/quill.core.css']) {
      await page.addStyleTag({content: fs.readFileSync(new URL(name, web), 'utf8')});
    }
    for (const name of ['vendor/quill/quill.js', 'rich-text.js', 'rich-editor.js', 'planning-windows.js', 'report-scopes.js', 'baseline-core.js', 'monthly-plans.js', 'reporter-tasks.js', 'coordination-workbench.js', 'completion-review.js', 'report-attachments.js']) {
      await page.addScriptTag({content: fs.readFileSync(new URL(name, web), 'utf8')});
    }
    await page.addScriptTag({content: app});
    await page.evaluate(async () => {
      const h = window.audit, S = h.S, f = window.fixtureTables;
      Object.assign(S, {uid: 'anonymous', session: {}, profile: {user_id: 'anonymous', name: '匿名填报人', role: 'pm', status: 'approved', project_id: 'p1', biz_line: '土建工程（东地块）'},
        projects: f.projects, pms: f.project_members, reports: f.reports, monthlyPlans: f.monthlyPlans, projectPeople: f.projectPeople, coordinationTasks: f.coordinationTasks,
        view: 'form', pmProject: 'p1', pmLine: '土建工程（东地块）', pmPeriod: '2026-10-19'});
      await h.loadData(['milestones'], true); h.configureReporter(); await h.preparePM(); h.renderShell();
    });
    await expect(page.locator('.report3-monthly-table thead th')).toHaveText(['模块', '事项', '完成时间', '当周进展']);
    const narrativeCells=page.locator('.report3-monthly-table td[data-label="事项"],.report3-monthly-table td[data-label="当周进展"]');
    await expect(narrativeCells).toHaveCount(2);
    assert.ok(await narrativeCells.evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).textAlign==='left')));
    assert.ok(await page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor').evaluate(editor=>getComputedStyle(editor).textAlign==='left'));
    await expect(page.locator('.planning-brand b')).toHaveText('工程建设数字化服务平台');
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor')).toContainText('遇到卡点：原卡点');
    await expect(page.locator('#bi_blocker_0')).toHaveCount(0);
    await expect(page.locator('.monthly-previous-plan')).toHaveCount(0);
    await expect(page.locator('.reporter-followup-table thead th')).toHaveText(['类别','提出人','事项内容','完成时间','本期进展']);
    await expect(page.locator('.report3-monthly-table').getByRole('button',{name:'完成／延期申报',exact:true})).toHaveCount(1);
    await expect(page.locator('.planning-header #pmPeriod')).toHaveCount(1);
    await expect(page.locator('#pmPeriod')).toHaveCount(1);
    await expect(page.locator('.planning-header').getByRole('button', {name: '打印 / PDF', exact: true})).toBeVisible();
    await expect(page.locator('.planning-header').getByRole('button', {name: '刷新数据', exact: true})).toBeVisible();
    await page.locator('.planning-mainnav').getByRole('button', {name: '项目资料', exact: true}).click();
    await expect(page.locator('.planning-mainnav').getByRole('button', {name: '资料共享', exact: true})).toBeVisible();
    await page.locator('.planning-mainnav').getByRole('button', {name: '项目资料', exact: true}).click();
    await expect(page.locator('.work>.topbar')).toHaveCount(0);
    await expect(page.locator('[data-shared-rich-toolbar] button')).toHaveCount(0);
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .rich-toolbar')).toHaveCount(0);
    await expect(page.locator('#baseline-core-summary')).toContainText('独立商业基准节点');
    await expect(page.locator('#baseline-core-summary')).not.toContainText('匿名已确认月计划事项');
    await expect(page.locator('#baseline-core-summary input, #baseline-core-summary textarea')).toHaveCount(0);
    const editor = page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor');
    await editor.fill('第二部分新进展保持原来源'); await editor.press('Control+A');
    await page.getByRole('toolbar', {name: '所选文字格式'}).getByRole('button', {name: '加粗', exact: true}).click();
    await editor.press('End');await editor.press('Enter');await editor.press('a');
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('第二部分新进展保持原来源');
    await page.locator('.report3-monthly-table').getByRole('button',{name:'完成／延期申报',exact:true}).click();
    await expect.poll(()=>requests.filter(x=>x.url==='/api/completions/preview').length).toBe(1);
    assert.equal(requests.find(x=>x.url==='/api/completions/preview').body.source_key,'monthly:p1:confirmed-plan:fixed-item');
    await page.evaluate(()=>window.CompletionReview.close());
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('第二部分新进展保持原来源');
    await page.evaluate(()=>{window.failPreviewOnce=true;});
    await page.locator('.report3-monthly-table').getByRole('button',{name:'完成／延期申报',exact:true}).click();
    await expect(page.getByText('事项或审核记录已变化，请刷新核对后重试；当前填写内容保留。',{exact:true})).toBeVisible();
    await page.evaluate(()=>window.CompletionReview.close());
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('第二部分新进展保持原来源');
    await expect(page.locator('#baseline-core-summary')).not.toContainText('第二部分新进展保持原来源');
    assert.equal(await page.evaluate(()=>window.audit.S.bizItems[0].blocker),'');
    assert.equal(await page.evaluate(()=>window.fixtureTables.reports[0].biz.items[0].blocker),'原卡点');
    assert.equal(await page.evaluate(() => window.audit.S.bizItems[0].source_id), 'fixed-item');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: path.join(artifacts, 'report3-form-desktop.png'), fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    await expect(page.locator('.report3-monthly-table tbody tr').first()).toHaveCSS('display', 'block');
    const mobileMetrics = await page.locator('[data-rich-editor-for="bi_pg_0"]').evaluate(element => {
      const editor = element.querySelector('.ql-editor'), surface = element.querySelector('.rich-surface');
      return {wrapperHeight: element.getBoundingClientRect().height, wrapperStyle: element.getAttribute('style'),
        editorHeight: editor.getBoundingClientRect().height, editorStyle: getComputedStyle(editor).height,
        surfaceHeight: surface.getBoundingClientRect().height, surfaceStyle: getComputedStyle(surface).height};
    });
    fs.writeFileSync(path.join(artifacts, 'report3-mobile-metrics.json'), JSON.stringify(mobileMetrics, null, 2));
    assert.ok(mobileMetrics.editorHeight < 300, 'a short mobile progress paragraph must not expand its editor to the page height');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'mobile form must not require horizontal page scrolling');
    await page.screenshot({path: path.join(artifacts, 'report3-form-mobile.png'), fullPage: true});
    await page.setViewportSize({width: 1600, height: 1100});
    await page.evaluate(() => window.App.view('coordination'));
    await expect(page.locator('.coordination-workbench')).toContainText('独立发起协调事项需保留');
    await expect(page.locator('main')).toContainText('旧报告协调事项需保留');
    await expect(page.locator('.completion-initiated')).toContainText('我发起的协调事项审核');
    await expect(page.locator('.coordination-workbench select')).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: path.join(artifacts, 'report3-coordination-desktop.png'), fullPage: true});
    await page.evaluate(() => window.App.view('center'));
    await expect(page.locator('main')).toContainText('待处理事项清单');
    await expect(page.locator('main')).not.toContainText('本期其他跨专业需求');
    await expect(page.locator('main')).not.toContainText('未指定给本人的需求不应显示');
    await expect(page.locator('.coordination-workbench')).toHaveCount(0);
    await expect(page.locator('.completion-initiated')).toHaveCount(0);
    await expect(page.locator('.completion-work-items')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('计划事项办理');
    await expect(page.locator('[data-plan-section="items"]')).toHaveCount(0);
    await page.locator('[data-plan-section="nodes"]').getByRole('button',{name:'完成／延期申报',exact:true}).click();
    await expect.poll(()=>requests.filter(x=>x.url==='/api/completions/preview').length).toBe(3);
    assert.equal(requests.filter(x=>x.url==='/api/completions/preview')[2].body.source_key,'plan:p1:11:nodes:custom-node');
    await page.evaluate(()=>window.CompletionReview.close());
    await page.screenshot({path:path.join(artifacts,'report3-workbench-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    await page.screenshot({path:path.join(artifacts,'report3-workbench-mobile.png'),fullPage:true});
    await page.evaluate(() => window.App.view('form'));
    assert.ok(await narrativeCells.evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).textAlign==='left')));
    await expect(page.locator('[data-rich-editor-for="bi_pg_0"] .ql-editor strong')).toContainText('第二部分新进展保持原来源');
    await expect(page.locator('.report3-monthly-table').getByRole('button',{name:'完成／延期申报',exact:true})).toHaveCount(1);
    await expect(page.locator('#bi_blocker_0')).toHaveCount(0);
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => !/\/(?:save|create|confirm|request|review|upload)$/.test(request.url)), 'render verification must not submit any business mutation');
    fs.writeFileSync(path.join(artifacts, 'report3-layout-ui-result.json'), JSON.stringify({desktop: true, mobile: true, coordinationOldAndNew: true, draftFormattingPreserved: true, browserErrors: errors, businessWrites: 0, mockedRequests: requests}, null, 2));
  } finally {await browser.close();}
});
