import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { executeDatabase } from '../server/database.mjs';
import { previewCompletion } from '../server/completions.mjs';
import { confirmMonthlyPlan, listMonthlyPlans } from '../server/monthly-plans.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const delta = (insert, attributes) => ({ ops: [{ insert, ...(attributes ? { attributes } : {}) }] });
const format = fields => ({ v: 1, fields });
const boldRed = { bold: true, color: '#d81e06' };
const path = 'biz.items.0.blocker';
const pm = { id: 'demo-pm-com' }, ops = { id: 'demo-ops' };

test('monthly blocker format persists through report writes, reload and history without changing the confirmed source', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db); await seedDemo(admin);
  const line = '土建工程（东地块）';
  const item = { source_id: 'personal4-stable-source', mod: '砌筑', name: '匿名固定月计划事项', due: '2026-11-20' };
  const nameFormat = format({ 'items.0.name': delta(item.name, { bold: true }) });
  await assert.rejects(confirmMonthlyPlan(pool, pm, { project_id: 'demo-com', line, month: '2026-11', items: [item],
    rich_text: format({ 'items.0.blocker': delta('不得进入确认列', boldRed) }) }), error => error.status === 400 && error.code === 'invalid_rich_text');
  const plan = await confirmMonthlyPlan(pool, pm, { project_id: 'demo-com', line, month: '2026-11', items: [item], rich_text: nameFormat });
  const sourceKey = 'monthly:demo-com:' + plan.id + ':' + item.source_id;
  const original = await previewCompletion(pool, pm, { source_key: sourceKey });
  const blocker = '材料待到\n需协调 <b>只是正文</b>';
  const reportNameFormat = { 'biz.items.0.name': nameFormat.fields['items.0.name'] };
  const rich = format({ ...reportNameFormat, [path]: delta(blocker, boldRed) });
  const biz = { monthly_plan_id: plan.id, monthly_plan_month: '2026-11', items: [{ ...item, prog: '当周进展', blocker }] };
  const [saved] = await executeDatabase(pool, pm, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'demo-com', period: '第46周（11.09–11.15）', line, biz, rich_text: rich
  } });
  const filters = [{ column: 'id', value: saved.id }];
  const [reloaded] = await executeDatabase(pool, ops, { table: 'reports', filters });
  assert.deepEqual(reloaded.rich_text, rich);
  assert.deepEqual(reloaded.biz, biz);
  assert.equal((await previewCompletion(pool, pm, { source_key: sourceKey })).source_version, original.source_version);

  const invalid = [
    format({ [path]: delta('与卡点正文不同', boldRed) }),
    format({ [path]: delta(blocker, { link: 'https://invalid.example' }) }),
    format({ [path]: { ops: [{ insert: { image: 'https://invalid.example/image' } }] } }),
    { ...rich, html: '<strong>非法 HTML 字段</strong>' }
  ];
  for (const rich_text of invalid) await assert.rejects(executeDatabase(pool, pm, { table: 'reports', operation: 'update', filters,
    values: { rich_text } }), error => error.status === 400 && error.code === 'invalid_rich_text');
  await assert.rejects(executeDatabase(pool, pm, {table:'reports',operation:'update',filters,
    values:{rich_text:format({...reportNameFormat,'biz.items.0.mod':delta(item.mod,boldRed)})}}),error=>error.status===409);

  const plain = format({ ...reportNameFormat, [path]: delta(blocker) });
  const [cleared] = await executeDatabase(pool, pm, { table: 'reports', operation: 'update', filters, values: { rich_text: plain } });
  assert.deepEqual(cleared.rich_text, plain);
  assert.deepEqual(cleared.history.at(-1).data.rich_text, rich);
  assert.deepEqual(cleared.biz.items[0], biz.items[0]);
  const mergedText=biz.items[0].prog+'\n遇到卡点：'+blocker;
  const mergedBiz={...biz,items:[{...biz.items[0],prog:mergedText,blocker:''}]};
  const mergedRich=format({...reportNameFormat,'biz.items.0.prog':{ops:[{insert:'当周进展\n遇到卡点：'},{insert:blocker,attributes:boldRed}]}});
  const [merged]=await executeDatabase(pool,pm,{table:'reports',operation:'update',filters,values:{biz:mergedBiz,rich_text:mergedRich}});
  assert.deepEqual(merged.biz,mergedBiz);
  assert.deepEqual(merged.rich_text,mergedRich);
  assert.deepEqual(merged.history.at(-1).data.biz,biz);
  assert.deepEqual(merged.history.at(-1).data.rich_text,plain);
  assert.equal((await previewCompletion(pool,pm,{source_key:sourceKey})).source_version,original.source_version);
  const legacyBiz = { ...biz, items: [{ ...item, prog: '旧客户端进展', blocker: '旧记录纯文本卡点' }] };
  const [legacy] = await executeDatabase(pool, pm, { table: 'reports', operation: 'update', filters,
    values: { biz: legacyBiz, rich_text: format(reportNameFormat) } });
  assert.deepEqual(legacy.rich_text, format(reportNameFormat));
  assert.deepEqual(legacy.biz, legacyBiz);
  assert.deepEqual(legacy.history.at(-1).data.rich_text, mergedRich);
  assert.equal((await previewCompletion(pool, pm, { source_key: sourceKey })).source_version, original.source_version);
  const [confirmed] = await listMonthlyPlans(pool, pm, { project_id: 'demo-com', line, month: '2026-11' });
  assert.deepEqual(confirmed.items, [item]);
  assert.deepEqual(confirmed.rich_text, nameFormat);
  const [legacyPlain] = await executeDatabase(pool, pm, { table: 'reports', operation: 'insert', values: {
    project_id: 'demo-com', period: '第50周（12.07–12.13）', line,
    biz: { items: [{ ...item, blocker: '旧记录未携带格式，仍为纯文本' }] }
  } });
  assert.deepEqual(legacyPlain.rich_text, {});
  assert.equal(legacyPlain.biz.items[0].blocker, '旧记录未携带格式，仍为纯文本');
});

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function harness() {
  const S = { uid: 'owner', session: {}, profile: { role: 'pm', biz_line: '机电工程' }, pmProject: 'p1', pmLine: '机电工程',
    pmPeriod: '2026-10-19', pmReport: null, projects: [{ id: 'p1', project_type: 'com' }], monthlyPlans: [], reports: [], bizItems: [] };
  const context = { document: { getElementById: () => null } }; context.window = context;
  vm.createContext(context);
  for (const name of ['rich-text.js', 'planning-windows.js', 'monthly-plans.js']) vm.runInContext(fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'), context);
  context.MonthlyPlans.configure({ S, esc: escape, richCopy: context.ZHRichText.copy, richItem: context.ZHRichText.field });
  return { S, api: context.MonthlyPlans, rich: context.ZHRichText, windows: context.PlanningWindows };
}
function confirmedPlan() {
  return { id: 'fixed-plan', project_id: 'p1', line: '机电工程', plan_month: '2026-10-01', confirmed_by: 'owner',
    items: [{ source_id: 'fixed-source', mod: '固定模块', name: '固定事项', due: '2026-10-23' }],
    rich_text: format({ 'items.0.name': delta('固定事项', { bold: true }) }) };
}

test('confirmed plan application and JSON draft reload retain matching blocker formatting and fixed columns', () => {
  const h = harness(), plan = confirmedPlan(), blocker = '卡点一\n<script>仅文字</script>';
  const blockerFormat = delta(blocker, boldRed);
  h.S.monthlyPlans = [plan];
  h.S.bizItems = [{ ...plan.items[0], mod: '陈旧模块', name: '陈旧事项', due: '2030-01-01', prog: '本周反馈', blocker,
    _rich: { blocker: blockerFormat } }];
  assert.equal(h.api.prepare(), true);
  const row = clone(h.S.bizItems[0]);
  assert.deepEqual({ source_id: row.source_id, mod: row.mod, name: row.name, due: row.due }, plan.items[0]);
  assert.deepEqual(row._rich.blocker, blockerFormat);
  h.S.bizItems = clone(h.S.bizItems); // The weekly local draft serializes these companion maps.
  assert.equal(h.api.prepare(), true);
  assert.deepEqual(clone(h.S.bizItems[0]._rich.blocker), blockerFormat);
  const html = h.api.personalCoreHtml();
  assert.match(html, /<span class="rt-red"><strong>卡点一<br>&lt;script&gt;仅文字&lt;\/script&gt;<\/strong><\/span>/);
  assert.doesNotMatch(html, /<script>|陈旧事项|陈旧模块/);
  const payload = h.rich.collect({ biz: { ...clone(h.api.metadata()), items: clone(h.S.bizItems) } });
  assert.deepEqual(clone(payload.rich_text.fields[path]), blockerFormat);

  const report = clone({ id: 'saved-report', project_id: 'p1', line: '机电工程', author_id: 'owner', period: '2026-10-19', ...payload });
  h.rich.attach(report);
  h.S.bizItems = report.biz.items.map(item => h.rich.copy(item, clone(item)));
  assert.equal(h.api.prepare(), true);
  assert.deepEqual(clone(h.S.bizItems[0]._rich.blocker), blockerFormat);
  h.S.reports = [report];
  assert.match(h.api.coreHtml({ projectId: 'p1', line: '机电工程', window: h.windows.windowFor('2026-10-19', 'week') }), /<span class="rt-red"><strong>卡点一<br>/);
  h.S.pmPeriod = '2026-11-02';
  assert.match(h.api.previousHtml(), /<span class="rt-red"><strong>卡点一<br>/);
});

test('legacy feedback copies blocker format from the original report map without requiring prior attachment', () => {
  const h = harness(), plan = confirmedPlan();
  const legacyItem = { ...plan.items[0], name: '原历史事项', prog: '原历史进展', blocker: '原历史卡点' };
  h.S.monthlyPlans = [plan];
  h.S.pmReport = { id: 'legacy-report', project_id: 'p1', line: '机电工程', period: '2026-10-19',
    biz: { items: [legacyItem] }, rich_text: format({
      'biz.items.0.name': delta(legacyItem.name, { bold: true }),
      'biz.items.0.prog': delta(legacyItem.prog, { bold: true }),
      [path]: delta(legacyItem.blocker, boldRed)
    }) };
  assert.equal(h.api.prepare(), true);
  assert.equal(h.S.bizItems[0].source_id, legacyItem.source_id);
  assert.equal(h.S.bizItems[0].name, legacyItem.name);
  assert.deepEqual(clone(h.S.bizItems[0]._rich.blocker), delta(legacyItem.blocker, boldRed));
  assert.deepEqual(clone(h.S.bizItems[0]._rich.prog), delta(legacyItem.prog, { bold: true }));
  assert.deepEqual(clone(h.api.metadata()), {});
  assert.equal(h.S.pmReport.biz.monthly_plan_id, undefined);
  assert.deepEqual(clone(h.S.pmReport.rich_text.fields[path]), delta(legacyItem.blocker, boldRed));
});
