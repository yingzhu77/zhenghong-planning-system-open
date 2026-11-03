import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { ADMIN_PLAN_IMPORT_LIMITS } from '../server/admin-plan-import.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { makeAdminPlanWorkbook, adminPlanSheet, adminPlanTitle, adminPlanHeaders, adminPlanRow, adminPlanInline } from './helpers/admin-plan-workbook.mjs';

async function fixture(t) {
  const db = await initializedDatabase();
  t.after(() => db.close());
  const admin = testPool(db, null), accounts = await seedDemo(admin);
  const app = createApp({ pool: testPool(db), config: { authCodeSecret: 'anonymous-admin-plan-route' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, cookies = {};
  async function call(route, { role = 'ops', data, raw, method = 'POST', originHeader = origin, contentType, extraHeaders = {} } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(cookies[role] ? { cookie: cookies[role] } : {}), ...(originHeader ? { origin: originHeader } : {}),
      ...(method === 'GET' ? {} : { 'content-type': contentType || (raw ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json') }), ...extraHeaders
    }, ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(data ?? {}) }) });
    return { status: response.status, body: await response.json(), response };
  }
  for (const account of accounts) {
    const role = account.id.replace('demo-', '');
    const result = await call('/api/auth/login', { role, data: { email: account.email, password: account.password } });
    assert.equal(result.status, 200); cookies[role] = result.response.headers.get('set-cookie').split(';')[0];
  }
  async function plansSnapshot() {
    return (await admin.query('SELECT to_jsonb(p) AS value FROM public.monthly_plans p ORDER BY id')).rows;
  }
  function declaredOversize(route) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(route, origin), { method: 'POST', headers: {
        cookie: cookies.ops, origin, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-length': String(ADMIN_PLAN_IMPORT_LIMITS.fileBytes + 1), connection: 'close'
      } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('oversize header guard timed out'))); request.end();
    });
  }
  const bytes = makeAdminPlanWorkbook([{ name: '工程', xml: adminPlanSheet([
    adminPlanTitle(1), adminPlanHeaders(2), adminPlanRow(3, [adminPlanInline('A3', '工程'), adminPlanInline('C3', '匿名正式前预览事项'), adminPlanInline('E3', '2026-11-30'), adminPlanInline('H3', '演示住宅经理')])
  ]) }]);
  return { db, admin, origin, call, cookies, plansSnapshot, bytes, declaredOversize };
}

test('保存批次HTTP入口限制管理员和同源请求，撤回整批且拒绝旧保存重放',async t=>{
 const f=await fixture(t),operation_id=randomUUID(),body={operation_id,plans:[{project_id:'demo-com',line:'土建工程（东地块）',owner_id:'demo-pm-com',month:'2026-11',expected_plan_id:null,items:[{source_id:'route-source',mod:'主体',name:'匿名批次事项',due:''}]}]};
 const saved=await f.call('/api/admin-plans/save',{data:body});assert.equal(saved.status,200);
 const route='/api/admin-plans/batches?project_id=demo-com&month=2026-11';assert.equal((await f.call(route,{method:'GET',role:'pm-com'})).status,403);assert.equal((await f.call(route,{method:'GET',role:'anonymous'})).status,401);
 const listed=await f.call(route,{method:'GET'});assert.equal(listed.status,200);assert.equal(listed.body.data.batches[0].can_withdraw,true);
 const undo={actor_id:'demo-ops',operation_id};assert.equal((await f.call('/api/admin-plans/withdraw-batch',{data:undo,originHeader:'https://external.example.invalid'})).status,403);
 assert.equal((await f.call('/api/admin-plans/withdraw-batch',{data:undo,role:'pm-com'})).status,403);
 assert.equal((await f.call('/api/admin-plans/withdraw-batch',{data:{...undo,force:true}})).status,400);
 const result=await f.call('/api/admin-plans/withdraw-batch',{data:undo});assert.equal(result.status,200);assert.equal(result.body.data.withdrawn,true);
 assert.equal((await f.call('/api/admin-plans/withdraw-batch',{data:undo})).body.data.replayed,true);assert.equal((await f.call('/api/admin-plans/save',{data:body})).status,409);
 assert.equal((await f.call(route,{method:'GET'})).body.data.batches[0].withdrawn,true);
});

test('管理员计划HTTP入口在读取文件前检查登录、角色和初始密码，预览不会写计划', { timeout: 30000 }, async t => {
  const f = await fixture(t), route = '/api/admin-plans/import?project_id=demo-res&month=2026-11';
  assert.equal((await f.call(route, { role: 'anonymous', raw: f.bytes })).status, 401);
  assert.equal((await f.call(route, { role: 'pm-res', raw: Buffer.from('bad xml') })).status, 403);
  assert.equal((await f.call('/api/admin-plans/context?project_type=res&month=2026-11', { method: 'GET', role: 'president' })).status, 403);
  assert.equal((await f.call(route, { raw: f.bytes, originHeader: 'https://external.example.invalid' })).status, 403);
  assert.equal((await f.call(route, { raw: f.bytes, originHeader: '' })).status, 403);
  const before = await f.plansSnapshot();
  const preview = await f.call(route, { raw: f.bytes });
  assert.equal(preview.status, 200); assert.equal(preview.body.error, null);
  assert.equal(preview.body.data.rows.length, 1); assert.equal(preview.body.data.rows[0].owner_id, 'demo-pm-res');
  assert.deepEqual(preview.body.data.rows[0].source, { sheet: '工程', row: 3, cell: 'C3' });
  assert.deepEqual(await f.plansSnapshot(), before);
  const broken = await f.call(route, { raw: Buffer.from('not a workbook') });
  assert.equal(broken.status, 400); assert.equal(broken.body.data, null);
  const encoded = await f.call(route, { raw: Buffer.from('not a gzip'), extraHeaders: { 'content-encoding': 'gzip' } });
  assert.equal(encoded.status, 415); assert.equal(encoded.body.error.code, 'admin_plan_import_encoding');
  const formerlyTooLarge = await f.call(route, { raw: Buffer.alloc(8 * 1024 * 1024 + 1) });
  assert.equal(formerlyTooLarge.status, 400); // Format error, no longer the old upload ceiling.
  const tooLarge = await f.declaredOversize(route);
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'admin_plan_import_size');
  await f.admin.query('UPDATE app_private.auth_users SET must_change_password=true WHERE user_id=$1', ['demo-ops']);
  for (const [path, method] of [['/api/admin-plans/context?project_type=res&month=2026-11', 'GET'], ['/api/admin-plans/preview', 'POST'], ['/api/admin-plans/save', 'POST'], [route, 'POST']]) {
    const blocked = await f.call(path, { method, ...(path === route ? { raw: f.bytes } : {}) });
    assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  }
  assert.deepEqual(await f.plansSnapshot(), before);
});

test('管理员保存与本人月计划贯通，重试幂等并且引用后的计划HTTP端不可编辑', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const context = await f.call('/api/admin-plans/context?project_type=res&month=2026-11', { method: 'GET' });
  assert.equal(context.status, 200);
  assert.ok(context.body.data.targets.some(target => target.owner_id === 'demo-pm-res' && target.line === '工程'));
  const planInput = { project_id: 'demo-res', line: '工程', owner_id: 'demo-pm-res', month: '2026-11', expected_plan_id: null,
    items: [{ source_id: 'anonymous-http-item', mod: '工程', name: '匿名代填计划', due: '2026-11-30' }] };
  const request = { operation_id: randomUUID(), plans: [planInput] };
  const first = await f.call('/api/admin-plans/save', { data: request });
  assert.equal(first.status, 200); assert.equal(first.body.error, null);
  const plan = first.body.data.plans[0];
  assert.equal(plan.owner_id, 'demo-pm-res'); assert.equal(plan.confirmed_by, 'demo-pm-res');
  const own = await f.call('/api/monthly-plans/list', { role: 'pm-res', data: { project_id: 'demo-res', line: '工程', month: '2026-11' } });
  assert.equal(own.status, 200); assert.ok(own.body.data.some(row => row.id === plan.id));
  const replay = await f.call('/api/admin-plans/save', { data: request });
  assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true); assert.equal(replay.body.data.plans[0].id, plan.id);
  const changedReplay = await f.call('/api/admin-plans/save', { data: { ...request, plans: [{ ...planInput, items: [{ ...planInput.items[0], name: '不同请求' }] }] } });
  assert.equal(changedReplay.status, 409);
  const report = await f.call('/api/db', { role: 'pm-res', data: { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line',
    values: { project_id: 'demo-res', line: '工程', period: '2026-11-02', biz: { monthly_plan_id: plan.id, monthly_plan_month: '2026-11', items: plan.items.map(item => ({ ...item, prog: '匿名本人反馈' })) } } } });
  assert.equal(report.status, 200); assert.equal(report.body.error, null);
  const before = await f.plansSnapshot();
  const edit = await f.call('/api/admin-plans/save', { data: { operation_id: randomUUID(), plans: [{ ...planInput, expected_plan_id: plan.id, items: [{ ...planInput.items[0], name: '被引用后试图改名' }] }] } });
  assert.equal(edit.status, 409); assert.deepEqual(await f.plansSnapshot(), before);
  const lockedContext = await f.call('/api/admin-plans/context?project_type=res&month=2026-11', { method: 'GET' });
  assert.equal(lockedContext.status, 200);
  assert.equal(lockedContext.body.data.plans.find(row => row.id === plan.id).editable, false);
});

test('真实HTTP按项目专业匹配提报人，原表工作责任人不同或为空不阻断，多人和无授权专业仍待确认', { timeout: 30000 }, async t => {
  const f=await fixture(t),route='/api/admin-plans/import?project_id=demo-res&month=2026-11',before=await f.plansSnapshot();
  for(const responsible of ['原表施工工作责任人','']){
    const bytes=makeAdminPlanWorkbook([{name:'工程',xml:adminPlanSheet([adminPlanTitle(1),adminPlanHeaders(2),adminPlanRow(3,[
      adminPlanInline('A3','工程'),adminPlanInline('C3','匿名责任人与提报人分离事项'),adminPlanInline('E3','2026-11-30'),adminPlanInline('H3',responsible)])])}]);
    const result=await f.call(route,{raw:bytes});assert.equal(result.status,200);assert.equal(result.body.error,null);
    const row=result.body.data.rows[0];assert.equal(row.owner_id,'demo-pm-res');assert.equal(row.line,'工程');assert.equal(row.reporter_hint,responsible);
    assert.equal(row.match_basis,'project_line_unique');assert.equal(row.match_status,'matched');
    assert.ok(row.warnings.every(w=>typeof w==='string'||w.code!=='reporter_missing'||!w.message.includes('手动分配')));
  }
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES('anonymous-http-peer','匿名同专业提报人','pm','approved','demo-res','工程')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('anonymous-http-peer','demo-res')");
  const preview=await f.call('/api/admin-plans/preview',{data:{project_id:'demo-res',month:'2026-11',rows:[
    {name:'名字吻合也不自动挑选',line_hint:'工程',reporter_hint:'演示住宅经理'},
    {name:'无此专业授权',line_hint:'设计',reporter_hint:'演示住宅经理'},
    {name:'未知专业不按名字分配',line_hint:'未识别专业',reporter_hint:'演示住宅经理'}]}});
  assert.equal(preview.status,200);const rows=preview.body.data.rows;
  assert.equal(rows[0].owner_id,null);assert.equal(rows[0].match_status,'ambiguous');assert.equal(rows[0].candidate_targets.length,2);
  assert.equal(rows[1].owner_id,null);assert.equal(rows[1].line,'设计');assert.deepEqual(rows[1].candidate_targets,[]);
  assert.equal(rows[2].owner_id,null);assert.equal(rows[2].line,null);assert.equal(rows[2].match_status,'unmatched');
  assert.deepEqual(await f.plansSnapshot(),before);
});
