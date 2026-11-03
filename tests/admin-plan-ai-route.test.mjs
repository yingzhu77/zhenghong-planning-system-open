import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { ADMIN_PLAN_IMPORT_LIMITS } from '../server/admin-plan-import.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { makeAdminPlanWorkbook, adminPlanSheet, adminPlanTitle, adminPlanHeaders, adminPlanRow, adminPlanInline } from './helpers/admin-plan-workbook.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function providerReply(body) {
  const context = JSON.parse(body.input[0].content);
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
    reply: '已识别全部专业，请核对后再确认导入。', complete: true, questions: [], rows: context.strict_rows.map(row => ({ row_id: row.id,
      region_id: row.region_id, source_row: row.source_row, name_cells: [], standard_cells: [], mod_cells: [], due_cell: '',
      line: '工程', owner_id: 'demo-pm-res', included: true, reason: '' }))
  }) }] }] }));
}
async function fixture(t, provider) {
  const db = await initializedDatabase(), admin = testPool(db, null), pool = testPool(db), accounts = await seedDemo(admin);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-ai-route-')), configPath = path.join(directory, 'anonymous-provider.json');
  await writeFile(configPath, JSON.stringify({ enabled: true, model: 'deepseek-flash', api_key: 'sk-anonymous-ai-route-test' }), { mode: 0o600 });
  let calls = 0;
  const app = createApp({ pool, config: { authCodeSecret: 'anonymous-admin-ai-route', planningAIConfigPath: configPath,
    planningAIFetch: async (url, options) => { calls++; assert.equal(url, 'https://api.deepseek.com/responses'); return provider ? provider(JSON.parse(options.body), options) : providerReply(JSON.parse(options.body)); } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, cookies = {}, sessions = new Set();
  async function call(route, { role = 'ops', method = 'POST', data, raw, originHeader = origin, extraHeaders = {} } = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(cookies[role] ? { cookie: cookies[role] } : {}), ...(originHeader ? { origin: originHeader } : {}),
      'content-type': raw ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json', ...extraHeaders }, body: raw ?? JSON.stringify(data ?? {}) });
    const body = await response.json(); if (body.data?.conversation_id) sessions.add(body.data.conversation_id);
    return { status: response.status, body, response };
  }
  t.after(async () => {
    for (const conversation_id of sessions) { try { await call('/api/admin-plans/ai/close', { data: { conversation_id } }); } catch {} }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await pool.end(); await admin.end(); await db.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('admin-ai-route-'));
    await rm(target, { recursive: true, force: true });
  });
  for (const account of accounts) {
    const role = account.id.replace('demo-', '');
    const login = await call('/api/auth/login', { role, data: { email: account.email, password: account.password } });
    assert.equal(login.status, 200); cookies[role] = login.response.headers.get('set-cookie').split(';')[0];
  }
  const bytes = makeAdminPlanWorkbook([{ name: '工程', xml: adminPlanSheet([adminPlanTitle(1), adminPlanHeaders(2), adminPlanRow(3,
    [adminPlanInline('A3', '工程'), adminPlanInline('C3', '匿名整项目AI事项'), adminPlanInline('D3', '匿名验收标准'), adminPlanInline('E3', '2026-11-30'), adminPlanInline('H3', '演示住宅经理')])]) }]);
  const snapshot = async () => (await admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY operation_id) FROM app_private.admin_monthly_plan_operations a)) data")).rows[0].data;
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
  return { admin, call, bytes, snapshot, calls: () => calls, origin, cookies, declaredOversize };
}
const upload = '/api/admin-plans/ai/upload?project_id=demo-res&month=2026-11&name=anonymous.xlsx';

test('AI整项目HTTP入口先验登录和角色，上传与对话仅预览，最后确认沿原月计划事务且可重放回执', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await f.snapshot();
  assert.equal((await f.call(upload, { role: 'anonymous', raw: f.bytes })).status, 401);
  assert.equal((await f.call(upload, { role: 'pm-res', raw: Buffer.from('not a workbook') })).status, 403);
  assert.equal((await f.call(upload, { raw: f.bytes, originHeader: 'https://external.example.invalid' })).status, 403);
  assert.equal((await f.call(upload, { raw: f.bytes, originHeader: '' })).status, 403);
  assert.equal((await f.call(upload, { raw: f.bytes, extraHeaders: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call(upload, { raw: Buffer.alloc(8 * 1024 * 1024 + 1) })).status, 400);
  const tooLarge = await f.declaredOversize(upload);
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'admin_plan_import_size');
  assert.equal(f.calls(), 0);
  const recognized = await f.call(upload, { raw: f.bytes });
  assert.equal(recognized.status, 200); assert.equal(recognized.body.error, null);
  const preview = recognized.body.data; assert.equal(preview.rows.length, 1); assert.equal(preview.can_confirm, true);
  assert.deepEqual(await f.snapshot(), before);
  const revision = preview.revision;
  const chatted = await f.call('/api/admin-plans/ai/chat', { data: { conversation_id: preview.conversation_id, expected_revision: revision, messages: [{ role: 'user', content: '请保留完成标准，再核对一次归属。' }] } });
  assert.equal(chatted.status, 200); assert.equal(chatted.body.data.revision, revision + 1); assert.deepEqual(await f.snapshot(), before);
  const stale = await f.call('/api/admin-plans/ai/revise', { data: { conversation_id: preview.conversation_id, expected_revision: revision, changes: [] } });
  assert.equal(stale.status, 409);
  const request = { conversation_id: preview.conversation_id, expected_revision: chatted.body.data.revision, operation_id: randomUUID(), modes: [{ line: '工程', owner_id: 'demo-pm-res', mode: 'replace', expected_plan_id: null }] };
  const confirmed = await f.call('/api/admin-plans/ai/confirm', { data: request });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.data.confirmed, true);
  const saved = confirmed.body.data.result.plans[0]; assert.equal(saved.confirmed_by, 'demo-pm-res'); assert.match(saved.items[0].name, /完成标准：匿名验收标准/);
  const again = await f.call('/api/admin-plans/ai/confirm', { data: request }); assert.equal(again.status, 200); assert.deepEqual(again.body.data.result, confirmed.body.data.result);
  const resumed = await f.call('/api/admin-plans/ai/session', { data: { conversation_id: preview.conversation_id } });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.data.confirmed, true); assert.equal(resumed.body.data.result.plans[0].id, saved.id);
});

test('AI处理期间退出登录后，实际HTTP拒绝返回候选且不会建立任何计划或导入审计', { timeout: 30000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, async body => { entered.resolve(); await release.promise; return providerReply(body); });
  const before = await f.snapshot(), pending = f.call(upload, { raw: f.bytes });
  await entered.promise; assert.equal((await f.call('/api/auth/logout')).status, 200); release.resolve();
  const result = await pending; assert.equal(result.status, 401); assert.equal(result.body.error.code, 'admin_plan_ai_session_expired');
  assert.equal(result.body.data, null); assert.deepEqual(await f.snapshot(), before); assert.equal(f.calls(), 1);
});

test('AI处理中管理员撤权或强制改密，返回前复验会拒绝结果并保留原数据', { timeout: 30000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, async body => { entered.resolve(); await release.promise; return providerReply(body); });
  const before = await f.snapshot(), pending = f.call(upload, { raw: f.bytes }); await entered.promise;
  await f.admin.query('UPDATE app_private.auth_users SET must_change_password=true WHERE user_id=$1', ['demo-ops']); release.resolve();
  const result = await pending; assert.equal(result.status, 403); assert.equal(result.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.deepEqual(await f.snapshot(), before);
  for (const route of ['upload?project_id=demo-res&month=2026-11', 'chat', 'session', 'revise', 'confirm', 'close']) {
    const gated = await f.call('/api/admin-plans/ai/' + route, { ...(route.startsWith('upload') ? { raw: f.bytes } : {}) });
    assert.equal(gated.status, 403); assert.equal(gated.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  }
});

test('首次模型连接失败仍以真实HTTP返回可恢复规则预览，同会话重试后恢复AI状态且全程不写计划', { timeout: 30000 }, async t => {
  let attempts=0;
  const f=await fixture(t,async body=>{if(++attempts===1)throw new Error('private upstream failure');return providerReply(body);}),before=await f.snapshot();
  const initial=await f.call(upload,{raw:f.bytes});assert.equal(initial.status,200);assert.equal(initial.body.error,null);
  const p=initial.body.data;assert.equal(p.ai_status,'needs_retry');assert.equal(p.ai_error.code,'ai_network_failed');assert.doesNotMatch(p.ai_error.message,/private/);
  assert.equal(p.rows.length,1);assert.equal(p.can_confirm,false);assert.equal(p.complete,false);assert.equal(p.revision,0);assert.deepEqual(await f.snapshot(),before);
  const retained=await f.call('/api/admin-plans/ai/session',{data:{conversation_id:p.conversation_id}});assert.equal(retained.status,200);assert.equal(retained.body.data.ai_status,'needs_retry');
  const retry=await f.call('/api/admin-plans/ai/chat',{data:{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'请继续整理已上传的本月计划'}]}});
  assert.equal(retry.status,200);assert.equal(retry.body.data.conversation_id,p.conversation_id);assert.equal(retry.body.data.ai_status,'ready');assert.equal(retry.body.data.ai_error,null);
  assert.equal(retry.body.data.can_confirm,true);assert.equal(attempts,2);assert.deepEqual(await f.snapshot(),before);
});

test('首次模型故障同时发生退出或强制改密，真实HTTP仍拒绝响应候选而不返回可恢复预览', { timeout: 30000 }, async t => {
  for(const kind of ['logout','password']){
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    const f=await fixture(t,async()=>{entered.resolve();await release.promise;throw new Error('upstream failure after auth change');}),before=await f.snapshot();
    const pending=f.call(upload,{raw:f.bytes});await entered.promise;
    if(kind==='logout')assert.equal((await f.call('/api/auth/logout')).status,200);
    else await f.admin.query('UPDATE app_private.auth_users SET must_change_password=true WHERE user_id=$1',['demo-ops']);
    release.resolve();const denied=await pending;assert.equal(denied.status,kind==='logout'?401:403);assert.equal(denied.body.data,null);
    assert.equal(denied.body.error.code,kind==='logout'?'admin_plan_ai_session_expired':'PASSWORD_CHANGE_REQUIRED');assert.deepEqual(await f.snapshot(),before);
  }
});
