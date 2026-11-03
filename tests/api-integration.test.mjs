import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { hashTemporaryPassword } from '../server/password.mjs';

test('first-password requirement gates every business API and private file route before reading request data', async (t) => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null);
  await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,must_change_password) VALUES($1,$2,$3,true)',
    ['initial-user', 'initial-user@example.invalid', await hashTemporaryPassword('98371625')]);
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES($1,$2,'ops','approved')",
    ['initial-user', '匿名初始化用户']);
  const app = createApp({ pool: testPool(db), config: { authCodeSecret: 'gate-integration-secret' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'initial-user@example.invalid', password: '98371625' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const routes = ['/api/db', '/api/project-plan-statistics', '/api/leader-notes/replace', '/api/reporter-tasks/list', '/api/reporter-tasks/save',
    '/api/coordination-tasks/list', '/api/coordination-tasks/create', '/api/monthly-plans/list', '/api/monthly-plans/confirm',
    '/api/completions/list', '/api/completions/preview', '/api/completions/request', '/api/completions/review', '/api/completions/withdraw',
    '/api/report-attachments/upload', '/api/report-attachments/list', '/api/report-attachments/discard', '/api/report-attachments/discard-inaccessible', '/api/files/upload'];
  for (const route of routes) {
    const blocked = await fetch(base + route, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403, route);
    assert.equal((await blocked.json()).error.code, 'PASSWORD_CHANGE_REQUIRED', route);
  }
  for (const route of ['/api/report-attachments/unknown', '/api/files/drawings/project/unknown.png']) {
    const blocked = await fetch(base + route, { headers: { cookie } });
    assert.equal(blocked.status, 403, route);
    assert.equal((await blocked.json()).error.code, 'PASSWORD_CHANGE_REQUIRED', route);
  }
  const change = await fetch(base + '/api/auth/change-password', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: '98371625', newPassword: 'New-private918' }) });
  assert.equal(change.status, 200);
  assert.equal((await change.json()).data.session.user.must_change_password, false);
  const ready = await fetch(base + '/api/db', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ table: 'projects' }) });
  assert.equal(ready.status, 200);
});

test('full self-host HTTP flow uses runtime RLS: login, reporting, revisions, leaders and private files', async (t) => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null);
  const accounts = await seedDemo(admin);
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'zh-weekly-test-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const pool = testPool(db);
  const app = createApp({ pool, config: { uploadDir, authCodeSecret: 'integration-secret' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookies = {};
  async function call(route, body, role = 'ops', headers = {}) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookies[role] ? { cookie: cookies[role] } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, response, body: await response.json() };
  }
  async function query(payload, role = 'ops') { return call('/api/db', payload, role); }
  for (const user of accounts) {
    const key = user.id.replace('demo-', '');
    const logged = await call('/api/auth/login', { email: user.email, password: user.password }, key);
    assert.equal(logged.status, 200);
    cookies[key] = logged.response.headers.get('set-cookie').split(';')[0];
  }
  assert.equal((await fetch(base + '/')).status, 200);
  for (const secretPath of ['/.env', '/db/002-import.sql', '/.local/demo-accounts.json', '/server/auth.mjs']) assert.equal((await fetch(base + secretPath)).status, 404);
  assert.equal((await call('/api/health')).body.data.status, 'ok');
  assert.equal((await query({ table: 'projects' }, 'anonymous')).status, 401);
  assert.equal((await query({ table: 'app_private.auth_users' })).status, 400);
  assert.equal((await query({ table: 'projects', filters: [null] })).status, 400);
  const malformed = await fetch(base + '/api/db', { method: 'POST', headers: { origin: base, cookie: cookies.ops, 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
  const ownProjects = await query({ table: 'projects' }, 'pm-res');
  assert.deepEqual(ownProjects.body.data.map((p) => p.id), ['demo-res']);
  assert.equal((await query({ table: 'projects' })).body.data.length, 2);
  assert.equal((await call('/api/project-plan-statistics', {kind:'res'}, 'anonymous')).status, 401);
  assert.equal((await call('/api/project-plan-statistics', {kind:'res'}, 'pm-res')).status, 403);
  assert.equal((await call('/api/project-plan-statistics', {kind:'all'}, 'anonymous')).status, 401);
  assert.equal((await call('/api/project-plan-statistics', {kind:'all'}, 'pm-com')).status, 403);
  for(const role of ['ops','president','pzo']){
    const statistics=await call('/api/project-plan-statistics',{kind:'res'},role);
    assert.equal(statistics.status,200,role+' statistics');
    assert.equal(statistics.body.data.totals.total,statistics.body.data.rows.length);
    if(role==='pzo')assert.ok(statistics.body.data.rows.every(row=>row.project_id==='demo-com'));
    const unified = await call('/api/project-plan-statistics', {}, role);
    const business = await call('/api/project-plan-statistics', {kind:'com'}, role);
    assert.equal(unified.status,200,role+' unified statistics');
    assert.equal(business.status,200,role+' commercial compatibility');
    assert.equal(unified.body.data.source,'all_baseline');
    assert.equal(unified.body.data.filters.kind,'all');
    assert.equal(unified.body.data.totals.total,statistics.body.data.totals.total+business.body.data.totals.total);
    assert.deepEqual(new Set(unified.body.data.rows.map(row=>row.source_key)),new Set([...statistics.body.data.rows,...business.body.data.rows].map(row=>row.source_key)));
    assert.deepEqual(new Set(unified.body.data.options.projects.map(row=>row.project_type)),new Set(role==='pzo'?['com']:['res','com']));
    if(role==='pzo')assert.ok(unified.body.data.rows.every(row=>row.project_id==='demo-com'));
  }
  assert.equal((await query({ table: 'project_members', operation: 'insert', values: { user_id: 'demo-pm-res', project_id: 'demo-com' } }, 'pm-res')).status, 403);

  const oldReport = (await query({ table: 'reports', filters: [{ column: 'project_id', value: 'demo-res' }] }, 'pm-res')).body.data[0];
  const report = { project_id: 'demo-res', period: oldReport.period, line: '综合', change_text: '本周测试更新',
    node_items: [{ name: '自定义延期节点', plan: '2026-10-01', forecast: '2026-10-31', custom: true }],
    next_items: ['下一步'], author_name: '伪造姓名', history: [{ forged: true }] };
  assert.equal((await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: { ...report, author_id: 'someone-else' } }, 'pm-res')).status, 403);
  const written = await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: report }, 'pm-res');
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.data[0].status, '异常');
  assert.equal(written.body.data[0].author_id, 'demo-pm-res');
  assert.equal(written.body.data[0].author_name, '演示住宅经理');
  assert.equal(written.body.data[0].history.length, 1);
  assert.equal(written.body.data[0].history[0].data.change_text, oldReport.change_text);
  assert.equal(JSON.stringify(written.body.data[0].history).includes('forged'), false);
  assert.equal((await query({ table: 'reports', operation: 'update', filters: [{ column: 'id', value: oldReport.id }], values: { change_text: '不允许' } })).status, 403);
  assert.equal((await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: { ...report, project_id: 'demo-com', line: '成本' } }, 'pm-com')).status, 403);
  const commercial = (await query({ table: 'reports' }, 'pm-com')).body.data[0];
  const partial = await query({ table: 'reports', operation: 'update', filters: [{ column: 'id', value: commercial.id }],
    values: { biz: { ...commercial.biz, handover: [{ what: '验收后的工作面', to: '机电工程', due: '2026-10-30' }] } } }, 'pm-com');
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.data[0].biz.handover[0].what, '验收后的工作面');
  assert.equal(partial.body.data[0].period, commercial.period);
  assert.equal(partial.body.data[0].author_id, 'demo-pm-com');
  assert.deepEqual(partial.body.data[0].history[0].data.biz, commercial.biz);
  assert.equal((await query({ table: 'reports', operation: 'update', filters: [{ column: 'id', value: commercial.id }], values: { coord: '跨项目非法修改' } }, 'pm-res')).status, 403);
  assert.equal((await query({ table: 'reports', operation: 'update', filters: [{ column: 'id', value: commercial.id }], values: { period: '改写周期' } }, 'pm-com')).status, 403);
  assert.equal((await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: { ...report, node_items: [null] } }, 'pm-res')).status, 400);
  const refreshed = (await query({ table: 'reports', filters: [{ column: 'id', value: commercial.id }] }, 'pm-com')).body.data[0];
  assert.deepEqual(refreshed.biz, partial.body.data[0].biz);

  const first = { project_id: 'demo-res', period: oldReport.period, kind: 'ceo_brief', items: [{ what: '事务保存的交代', due: '2026-10-30' }] };
  assert.equal((await call('/api/leader-notes/replace', first)).status, 200);
  assert.equal((await call('/api/leader-notes/replace', { ...first, items: [{ what: '' }] })).status, 400);
  // This passes API validation and fails in PostgreSQL only after DELETE;
  // the original rows must survive the transaction rollback.
  assert.equal((await call('/api/leader-notes/replace', { ...first, items: [{ what: '数据库拒绝\u0000字符' }] })).status, 400);
  const notes = await query({ table: 'leader_notes', filters: [{ column: 'project_id', value: 'demo-res' }, { column: 'kind', value: 'ceo_brief' }] }, 'pm-res');
  assert.equal(notes.body.data[0].what, '事务保存的交代');
  assert.equal((await call('/api/leader-notes/replace', first, 'pzo')).status, 403);
  assert.equal((await call('/api/leader-notes/replace', { ...first, project_id: 'demo-com', kind: 'pzo_note' }, 'pzo')).status, 200);
  assert.equal((await query({ table: 'leader_reviews', operation: 'upsert', onConflict: 'project_id,period,kind', values: { project_id: 'demo-res', period: oldReport.period, kind: 'ceo', speed: '领跑', effect: '优秀' } }, 'president')).status, 200);

  const milestones = (await query({ table: 'milestones' }, 'pm-res')).body.data;
  assert.equal((await query({ table: 'milestones', operation: 'update', filters: [{ column: 'id', value: milestones[0].id }], values: { forecast_date: '2026-12-01', note: '调整预计时间' } }, 'pm-res')).status, 200);
  assert.equal((await query({ table: 'milestones', operation: 'update', filters: [{ column: 'id', value: milestones[0].id }], values: { plan_date: '2026-12-01' } }, 'pm-res')).status, 403);
  assert.equal((await query({ table: 'profiles', operation: 'update', filters: [{ column: 'user_id', value: 'demo-pm-res' }], values: { role: 'ops' } }, 'pm-res')).status, 403);
  assert.equal((await query({ table: 'profiles', operation: 'update', filters: [{ column: 'user_id', value: 'demo-pm-res' }], values: { status: 'rejected' } })).status, 200);
  assert.deepEqual((await query({ table: 'projects' }, 'pm-res')).body.data, []);
  assert.equal((await query({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: report }, 'pm-res')).status, 403);
  assert.equal((await query({ table: 'profiles', operation: 'update', filters: [{ column: 'user_id', value: 'demo-pm-res' }], values: { status: 'approved' } })).status, 200);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6khQAAAAASUVORK5CYII=', 'base64');
  const filePath = 'drawings/demo-res/api-test.png';
  const form = new FormData(); form.set('path', filePath); form.set('file', new Blob([png], { type: 'image/png' }), 'test.png');
  const uploaded = await fetch(base + '/api/files/upload', { method: 'POST', headers: { origin: base, cookie: cookies.ops }, body: form });
  assert.equal(uploaded.status, 200, await uploaded.text());
  assert.equal((await query({ table: 'project_drawings', operation: 'insert', values: { project_id: 'demo-res', kind: '项目总图', name: '测试图纸', path: filePath, url: '/api/files/' + filePath } })).status, 200);
  const downloaded = await fetch(base + '/api/files/' + filePath, { headers: { cookie: cookies['pm-res'] } });
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await fetch(base + '/api/files/' + filePath, { headers: { cookie: cookies['pm-com'] } })).status, 404);
  assert.equal((await fetch(base + '/api/files/' + filePath)).status, 401);
  assert.equal((await call('/api/db', { table: 'projects' }, 'ops', { origin: 'https://other.invalid' })).status, 403);
});
