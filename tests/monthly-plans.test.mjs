import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {initializedDatabase, testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {executeDatabase, withIdentity} from '../server/database.mjs';
import {confirmMonthlyPlan, listMonthlyPlans} from '../server/monthly-plans.mjs';

const pm = {id: 'demo-pm-com'}, ops = {id: 'demo-ops'}, line = '土建工程（东地块）';
const status = value => error => error.status === value;
const item = {source_id: 'retained-stable-item', mod: '土建', name: '确认的月度事项', due: '2026-11-25'};
const planRich = {v: 1, fields: {'items.0.name': {ops: [{insert: item.name, attributes: {bold: true, color: '#d81e06'}}]}}};
const reportRich = {v: 1, fields: {'biz.items.0.name': planRich.fields['items.0.name']}};
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null); await seedDemo(admin);
  return {db, admin, pool: testPool(db)};
}
function confirmation(extra = {}) { return {project_id: 'demo-com', line, month: '2026-11', items: [item], rich_text: planRich, ...extra}; }
function linked(plan, extra = {}) { return {monthly_plan_id: plan.id, monthly_plan_month: '2026-11', items: [{...item, prog: '本周进展', blocker: '待协调材料'}], ...extra}; }
async function save(f, period, biz, rich = {}) {
  return (await executeDatabase(f.pool, pm, {table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line',
    values: {project_id: 'demo-com', line, period, biz, rich_text: rich}}))[0];
}

test('018 is repeatable without rewriting existing business, passwords, histories, roles or the 014 extension trigger', async t => {
  const f = await fixture(t);
  const capture = async () => (await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'auth',(SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id) FROM app_private.auth_users a),'roles',(SELECT jsonb_agg(to_jsonb(g) ORDER BY rolname) FROM pg_roles g)) AS value")).rows[0].value;
  const before = await capture(), sql = await readFile(new URL('../db/018-monthly-plans.sql', import.meta.url), 'utf8');
  await f.db.exec(sql); await f.db.exec(sql);
  assert.deepEqual(await capture(), before);
  assert.equal((await f.admin.query('SELECT count(*)::integer AS n FROM public.monthly_plans')).rows[0].n, 0);
  assert.equal((await f.admin.query("SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid='public.completion_requests'::regclass AND tgname='guard_completion_extension' AND NOT tgisinternal")).rows[0].n, 1);
});

test('report month uses the actual Monday across month/year boundaries and legacy week labels', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  for (const [period, ref, expected] of [
    ['第44周（10.26–11.01）', '2026-10-29T00:00:00Z', '2026-10-01'],
    ['第1周（12.29–01.04）', '2026-01-03T00:00:00Z', '2025-12-01'],
    ['第44周', '2026-10-29T00:00:00Z', '2026-10-01'],
    ['第45周（2026-11-02至2026-11-08）', '2026-10-29T00:00:00Z', '2026-11-01'],
    ['无日期周期', '2026-10-29T00:00:00Z', null]
  ]) assert.equal((await db.query('SELECT app_private.report_month_start($1,$2)::text AS month', [period, ref])).rows[0].month, expected);
});

test('only an assigned approved commercial PM can confirm once; confirmation creates no weekly report and is immutable', async t => {
  const f = await fixture(t), before = (await f.admin.query('SELECT count(*)::integer AS n FROM public.reports')).rows[0].n;
  for (const actor of [ops, {id: 'demo-president'}, {id: 'demo-pzo'}, {id: 'demo-pm-res'}]) await assert.rejects(confirmMonthlyPlan(f.pool, actor, confirmation()), status(403));
  await assert.rejects(confirmMonthlyPlan(f.pool, pm, confirmation({line: '成本'})), status(403));
  const plan = await confirmMonthlyPlan(f.pool, pm, confirmation());
  assert.equal(plan.confirmed_by, pm.id); assert.equal(plan.confirmed_name, '演示土建负责人'); assert.equal(plan.plan_month, '2026-11-01');
  assert.equal(plan.items[0].source_id, item.source_id); assert.deepEqual(plan.rich_text, planRich);
  assert.equal((await f.admin.query('SELECT count(*)::integer AS n FROM public.reports')).rows[0].n, before);
  assert.equal((await listMonthlyPlans(f.pool, ops, {project_id: 'demo-com'})).length, 1);
  assert.equal((await listMonthlyPlans(f.pool, {id: 'demo-pm-res'})).length, 0);
  await assert.rejects(confirmMonthlyPlan(f.pool, pm, confirmation()), status(409));
  for (const sql of ['UPDATE public.monthly_plans SET items=\'[]\' WHERE id=$1', 'DELETE FROM public.monthly_plans WHERE id=$1'])
    await assert.rejects(withIdentity(f.pool, pm.id, c => c.query(sql, [plan.id])), error => error.code === '42501');
  await assert.rejects(executeDatabase(f.pool, pm, {table: 'monthly_plans'}), status(400));
});

test('confirmation validates stable identities, plain left columns, dates and restricted rich text', async t => {
  const f = await fixture(t);
  for (const request of [confirmation({month: '2026-13'}), confirmation({items: [item, item]}), confirmation({items: [{...item, source_id: '../bad'}]}),
    confirmation({items: [{...item, due: '2026-02-30'}]}), confirmation({items: [{...item, name: ''}]}),
    confirmation({rich_text: {v: 1, fields: {'items.0.due': {ops: [{insert: item.due}]}}}})]) await assert.rejects(confirmMonthlyPlan(f.pool, pm, request), status(400));
  const generated = await confirmMonthlyPlan(f.pool, pm, confirmation({items: [{mod: '', name: item.name, due: ''}], rich_text: {}}));
  assert.match(generated.items[0].source_id, /^[a-f0-9-]{36}$/);
});

test('025 preserves existing rows and grants while keeping confirmed module formatting immutable', async t => {
  const f = await fixture(t);
  const moduleDoc = {ops: [{insert: item.mod, attributes: {bold: true, color: '#d81e06'}}]};
  const rich = {v:1,fields:{...planRich.fields,'items.0.mod':moduleDoc}};
  const plan = await confirmMonthlyPlan(f.pool, pm, confirmation({rich_text:rich}));
  assert.deepEqual((await listMonthlyPlans(f.pool,pm))[0].rich_text,rich);
  const columns = {v:1,fields:{...reportRich.fields,'biz.items.0.mod':moduleDoc}};
  const report = await save(f,'第46周（11.09–11.15）',linked(plan),columns);
  await assert.rejects(save(f,'第46周（11.09–11.15）',linked(plan),reportRich),status(409));
  await assert.rejects(save(f,'第46周（11.09–11.15）',linked(plan),{v:1,fields:{...columns.fields,'biz.items.0.mod':{ops:[{insert:item.mod}]}}}),status(409));
  await assert.rejects(withIdentity(f.pool,pm.id,c=>c.query('UPDATE public.reports SET rich_text=$1 WHERE id=$2',[JSON.stringify(reportRich),report.id])),e=>e.code==='23514');
  const snapshot = async () => (await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(t)) FROM public.monthly_plans t),'reports',(SELECT jsonb_agg(to_jsonb(t)) FROM public.reports t),'auth',(SELECT jsonb_agg(to_jsonb(t)) FROM app_private.auth_users t),'owner',(SELECT proowner FROM pg_proc WHERE oid='app_private.monthly_items_unchanged(jsonb,jsonb,jsonb,jsonb,text,boolean)'::regprocedure),'acl',(SELECT proacl FROM pg_proc WHERE oid='app_private.monthly_items_unchanged(jsonb,jsonb,jsonb,jsonb,text,boolean)'::regprocedure)) data")).rows[0].data;
  const before=await snapshot(),migration=await readFile(new URL('../db/025-monthly-module-format.sql',import.meta.url),'utf8');
  await f.db.exec(migration);await f.db.exec(migration);assert.deepEqual(await snapshot(),before);
});

test('a confirmed month requires its exact plan even without client metadata and allows only weekly progress or blockers to change', async t => {
  const f = await fixture(t), plan = await confirmMonthlyPlan(f.pool, pm, confirmation());
  const period = '第46周（11.09–11.15）';
  await assert.rejects(save(f, period, {items: [{...item, name: '另造计划'}]}), status(409));
  const report = await save(f, period, linked(plan), reportRich);
  assert.equal(report.biz.items[0].blocker, '待协调材料');
  const updated = await save(f, period, linked(plan, {items: [{...item, prog: '本周更新进展', blocker: '卡点已解决'}]}), reportRich);
  assert.equal(updated.biz.items[0].blocker, '卡点已解决'); assert.equal(updated.history.length, 1);
  const variants = [linked(plan, {items: [{...item, name: '篡改事项'}]}), linked(plan, {items: [{...item, mod: '其他模块'}]}),
    linked(plan, {items: [{...item, due: '2026-12-01'}]}), linked(plan, {items: [{...item, source_id: 'other-id'}]}), linked(plan, {items: []}),
    linked(plan, {monthly_plan_month: '2026-12'}), linked(plan, {monthly_plan_id: '00000000-0000-4000-8000-000000000000'}), {items: [{...item, prog: ''}]}];
  for (const variant of variants) await assert.rejects(save(f, period, variant, reportRich), error => [400, 409].includes(error.status));
  await assert.rejects(save(f, period, linked(plan), {}), status(409));
  await assert.rejects(save(f, '不可解析的报告周期', {items: [item]}), status(409));
  await assert.rejects(withIdentity(f.pool, pm.id, c => c.query('UPDATE public.reports SET biz=$1 WHERE id=$2', [JSON.stringify(linked(plan, {items: [{...item, due: '2026-12-01'}]})), report.id])), error => error.code === '23514');
  assert.equal((await listMonthlyPlans(f.pool, pm))[0].items[0].due, item.due);
});

test('unconfirmed weekly editing remains available and pre-confirmation snapshots/history retain their original left columns', async t => {
  const f = await fixture(t), period = '第45周（11.02–11.08）';
  const legacy = await save(f, period, {items: [{mod: '旧模块', name: '原周报计划', due: '', prog: '原反馈'}]});
  await confirmMonthlyPlan(f.pool, pm, confirmation());
  const same = {...legacy.biz, items: legacy.biz.items.map(row => ({...row, prog: '确认后继续反馈', blocker: '新增卡点'}))};
  const updated = await save(f, period, same);
  assert.equal(updated.biz.items[0].name, '原周报计划'); assert.equal(updated.history[0].data.biz.items[0].prog, '原反馈');
  await assert.rejects(save(f, period, {...same, items: [{...same.items[0], name: '改写旧计划'}]}), status(409));
  await assert.rejects(save(f, '第49周（11.30–12.06）', {items: [{mod: '', name: '跨月周仍属十一月', due: '', prog: ''}]}), status(409));
  const december = await save(f, '第50周（12.07–12.13）', {items: [{mod: '', name: '十二月未确认计划', due: '', prog: ''}]});
  assert.equal(december.biz.items[0].name, '十二月未确认计划');
});
