import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { hashPassword } from '../server/password.mjs';
import { createApp } from '../server/app.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { createCoordinationTask, listCoordinationTasks } from '../server/coordination-tasks.mjs';
import { previewCompletion, requestCompletion, reviewCompletion, listCompletions } from '../server/completions.mjs';
import { listReporterTasks } from '../server/reporter-tasks.mjs';
import { hasManagementRead, withManagementRead, managementRead } from '../server/management-read.mjs';

const viewer = { id: 'management-viewer' }, pm = { id: 'demo-pm-res' }, otherPm = { id: 'demo-pm-com' };
const forbidden = error => error.status === 403;

async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db), accounts = await seedDemo(admin);
  const password = '384629', hash = await hashPassword(password);
  for (const [id, status, role] of [['management-viewer', 'approved', 'viewer'], ['pending-viewer', 'pending', 'viewer'], ['unprovisioned', null, null]]) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', [id, id + '@example.invalid', hash]);
    if (status) await admin.query('INSERT INTO public.profiles(user_id,name,role,status) VALUES($1,$2,$3,$4)', [id, '匿名查看用户', role, status]);
  }
  await admin.query("UPDATE public.profiles SET management_viewer=true WHERE user_id='demo-pm-res'");
  const direct = [];
  for (const [user, project] of [[pm, 'demo-res'], [otherPm, 'demo-com']])
    direct.push(await createCoordinationTask(pool, user, { id: randomUUID(), project_id: project, owner_id: user.id,
      what: '独立协调-' + project, due: '2026-12-31' }));
  const preview = await previewCompletion(pool, otherPm, { source_key: direct[1].source_key });
  const request = await requestCompletion(pool, otherPm, { source_key: preview.source_key, source_version: preview.source_version,
    completion_date: '2026-10-23', completion_note: '匿名申请时说明' });
  const completion = await reviewCompletion(pool, otherPm, { id: request.id, expected_revision: request.revision,
    decision: 'approve', note: '匿名审批历史' });
  await admin.query(`INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,title,what,due,status,progress)
    VALUES($1,'demo-com','demo-pm-com','匿名承办人','匿名会议','商业会议事项','2026-12-31','open','原进度')`, [randomUUID()]);
  const today = (await admin.query("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today")).rows[0].today;
  await admin.query(`INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week)
    VALUES('management-test-scope','匿名合并范围','demo-res',ARRAY['demo-res','demo-com'],'2026-01-05')`);
  await admin.query(`INSERT INTO public.reports(project_id,period,line,author_id,author_name,report_scope_id,scope_project_ids,scope_week,coord_items,biz,rich_text)
    VALUES('demo-res',$1,'综合','demo-pm-res','匿名提报人','management-test-scope',ARRAY['demo-res','demo-com'],date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date,$2,$3,$4)`,
  [today, JSON.stringify([{ source_id: 'mapped', project_id: 'demo-com', who: '匿名承办', what: '明确商业项目协调' },
    { source_id: 'unspecified', what: '未指定项目协调' }, { what: '旧无标识协调' }]),
  JSON.stringify({ handover: [{ source_id: 'handover', project_id: 'demo-com', to: '匿名接收', what: '明确商业项目移交' },
    { source_id: '', id: 'legacy-fallback', project_id: 'demo-com', by: '', due: '2026-12-31',
      who: '旧残留字段', to: '正确移交接收人', what: '旧空串来源兼容' }] }),
  JSON.stringify({ v: 1, fields: { 'coord_items.0.what': { ops: [{ insert: '明确商业项目协调', attributes: { bold: true } }] } } })]);
  await admin.query(`INSERT INTO public.reports(project_id,period,line,author_id,coord_items)
    VALUES('demo-res',(now()-interval '14 days')::date::text,'综合','demo-pm-res',$1)`, [JSON.stringify([{ what: '过往周协调不混入本期' }])]);
  const savedCompletion = (await admin.query('SELECT id,what,source_snapshot,history FROM public.completion_requests WHERE id=$1', [completion.id])).rows[0];
  return { db, admin, pool, accounts, password, completion: savedCompletion, direct };
}

test('management migration is repeatable, defaults off and preserves every original write/read membership function', async t => {
  const db = await initializedDatabase({ through: 23 }); t.after(() => db.close());
  const admin = testPool(db, null); await seedDemo(admin);
  const snapshot = async () => (await admin.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS body
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private'
    AND p.proname IN ('can_read_project','can_write_report','can_manage_project','can_review_completion','project_people','guard_milestone_update') ORDER BY p.proname`)).rows;
  const before = await snapshot(), migration = await readFile(new URL('../db/024-management-viewers.sql', import.meta.url), 'utf8');
  await db.exec('RESET ROLE'); await db.exec(migration); await db.exec(migration);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await admin.query('SELECT count(*)::integer AS n FROM public.profiles WHERE management_viewer')).rows[0].n, 0);
  assert.equal(hasManagementRead({ role: 'viewer', status: 'approved' }), true);
  assert.equal(hasManagementRead({ role: 'pm', status: 'approved', management_viewer: true }), true);
  assert.equal(hasManagementRead({ role: 'viewer', status: 'pending', management_viewer: true }), false);
  assert.equal(hasManagementRead({ role: 'ops', status: 'approved', management_viewer: true }), false);
});

test('viewer and capable reporter read full management data while ordinary endpoints retain original scope and local GUC never leaks', async t => {
  const f = await fixture(t);
  for (const user of [viewer, pm]) {
    const projects = await managementRead(f.pool, user, { view: 'projects' });
    assert.deepEqual(projects.projects.map(row => row.id), ['demo-res', 'demo-com']);
    assert.deepEqual(projects.rows, []);
    const meetings = await managementRead(f.pool, user, { view: 'meetings' });
    assert.ok(meetings.rows.some(row => row.what === '商业会议事项'));
    const completions = await managementRead(f.pool, user, { view: 'completions' });
    const saved = completions.rows.find(row => row.id === f.completion.id);
    assert.equal(saved.what, f.completion.what);
    assert.deepEqual(saved.source_snapshot, f.completion.source_snapshot);
    assert.deepEqual(saved.history, f.completion.history);
    assert.equal(saved.can_review, false); assert.equal(saved.snapshot_only, true);
    assert.equal(saved.data_basis, 'request_snapshot'); assert.equal(Object.hasOwn(saved, 'source_changed'), false);
  }
  assert.deepEqual((await executeDatabase(f.pool, pm, { table: 'projects' })).map(row => row.id), ['demo-res']);
  assert.deepEqual(await executeDatabase(f.pool, viewer, { table: 'projects' }), []);
  assert.equal((await listCoordinationTasks(f.pool, pm)).some(row => row.project_id === 'demo-com'), false);
  assert.deepEqual(await listReporterTasks(f.pool, pm), []);
  assert.deepEqual(await listCompletions(f.pool, pm), []);
  await assert.rejects(managementRead(f.pool, otherPm, { view: 'projects' }), forbidden);
  await assert.rejects(managementRead(f.pool, { id: 'pending-viewer' }, { view: 'projects' }), forbidden);
  await assert.rejects(managementRead(f.pool, { id: 'demo-ops' }, { view: 'projects' }), forbidden);
  await assert.rejects(withManagementRead(f.pool, viewer, async () => { throw new Error('anonymous rollback'); }, { required: true }), /anonymous rollback/);
  assert.deepEqual(await executeDatabase(f.pool, viewer, { table: 'projects' }), []);
  const attempts = await withIdentity(f.pool, otherPm.id, async client => {
    await client.query("SELECT set_config('app.management_read','on',true)");
    return (await client.query('SELECT id FROM public.projects ORDER BY id')).rows;
  });
  assert.deepEqual(attempts.map(row => row.id), ['demo-com'], 'a GUC alone cannot grant a capability');
});

test('coordination includes current reports, explicit project mappings and formatting, without inventing a merged-report anchor', async t => {
  const f = await fixture(t), page = await managementRead(f.pool, viewer, { view: 'coordination' });
  for (const text of ['独立协调-demo-res', '独立协调-demo-com', '明确商业项目协调', '明确商业项目移交', '未指定项目协调', '旧无标识协调'])
    assert.ok(page.rows.some(row => row.what === text), text);
  assert.equal(page.rows.some(row => row.what === '过往周协调不混入本期'), false);
  const mapped = page.rows.find(row => row.what === '明确商业项目协调');
  assert.equal(mapped.project_id, 'demo-com'); assert.equal(mapped.source_project_id, 'demo-res');
  assert.equal(mapped.rich_text.fields.what.ops[0].attributes.bold, true);
  const unknown = page.rows.find(row => row.what === '未指定项目协调');
  assert.equal(unknown.project_id, null); assert.equal(unknown.project_name, '未指定项目');
  assert.equal(unknown.mapping_status, 'unspecified');
  assert.equal(page.rows.find(row => row.what === '旧无标识协调').source_key, null);
  const legacy = page.rows.find(row => row.what === '旧空串来源兼容');
  assert.ok(legacy.source_key.endsWith(':handover:legacy-fallback'));
  assert.equal(legacy.due, '2026-12-31'); assert.equal(legacy.owner_name, '正确移交接收人');
  const filtered = await managementRead(f.pool, viewer, { view: 'coordination', project_id: 'demo-com' });
  assert.ok(filtered.rows.some(row => row.what === '未指定项目协调' && row.project_id === null));
  assert.equal(filtered.rows.some(row => row.what === '独立协调-demo-res'), false);
});

test('management pagination has stable complete cursor traversal and rejects a cursor reused for another view or project', async t => {
  const f = await fixture(t);
  await f.admin.query(`INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,title,what,due,created_at)
    SELECT gen_random_uuid(),'demo-com','demo-pm-com','匿名承办人','分页会议','事项-'||i,'2026-12-31',
      '2026-01-01 00:00:00.123456+00'::timestamptz FROM generate_series(1,205) i`);
  const ids = new Set(); let cursor, first;
  do {
    const page = await managementRead(f.pool, viewer, { view: 'meetings', limit: 100, ...(cursor ? { cursor } : {}) });
    assert.ok(page.rows.length <= 100);
    for (const row of page.rows) { assert.equal(ids.has(row.id), false); ids.add(row.id); }
    first ||= page.next_cursor; cursor = page.next_cursor;
    assert.equal(page.has_more, !!cursor);
  } while (cursor);
  assert.equal(ids.size, 206);
  await assert.rejects(managementRead(f.pool, viewer, { view: 'completions', cursor: first }), error => error.status === 400);
  await assert.rejects(managementRead(f.pool, viewer, { view: 'meetings', project_id: 'demo-com', cursor: first }), error => error.status === 400);
  for (const request of [{ view: 'meetings', limit: 201 }, { view: 'meetings', cursor: 'bad' },
    { view: 'projects', guc: 'on' }, { view: 'projects', project_id: 'missing' }])
    await assert.rejects(managementRead(f.pool, viewer, request), error => [400, 403].includes(error.status));
});

test('viewer cannot gain business writes and capable reporters keep only their original member project writes', async t => {
  const f = await fixture(t);
  for (const user of [viewer, pm]) {
    await withManagementRead(f.pool, user, async client => {
      assert.equal((await client.query("UPDATE public.milestones SET note='unauthorized' WHERE project_id='demo-com' RETURNING id")).rows.length, 0);
    }, { required: true });
    await assert.rejects(withManagementRead(f.pool, user, client => client.query(`INSERT INTO public.reports(project_id,period,line,author_id)
      VALUES('demo-com','2026-12-01','土建工程（东地块）',$1)`, [user.id]), { required: true }), error => error.code === '42501');
    await assert.rejects(executeDatabase(f.pool, user, { table: 'profiles', operation: 'update',
      filters: [{ column: 'user_id', value: user.id }], values: { management_viewer: false } }), forbidden);
  }
  await assert.rejects(withIdentity(f.pool, 'unprovisioned', client => client.query(`INSERT INTO public.profiles(user_id,name,role,status,management_viewer)
    VALUES('unprovisioned','匿名自报','pm','pending',true)`)), error => error.code === '42501');
  const own = (await executeDatabase(f.pool, pm, { table: 'reports', filters: [{ column: 'report_scope_id', value: null }] })).find(row => row.project_id === 'demo-res');
  const saved = await executeDatabase(f.pool, pm, { table: 'reports', operation: 'update',
    filters: [{ column: 'id', value: own.id }], values: { change_text: '原项目提报职责保留' } });
  assert.equal(saved[0].change_text, '原项目提报职责保留');
  await executeDatabase(f.pool, { id: 'demo-ops' }, { table: 'profiles', operation: 'update',
    filters: [{ column: 'user_id', value: otherPm.id }], values: { management_viewer: true } });
  assert.equal((await managementRead(f.pool, otherPm, { view: 'projects' })).projects.length, 2);
});

test('isolated HTTP route authenticates capabilities, returns archive projections and keeps normal writes forbidden', async t => {
  const f = await fixture(t), app = createApp({ pool: f.pool, config: { mailer: { configured: false }, authCodeSecret: 'isolated-management' } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, cookie) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await call('/api/management-read', { view: 'projects' })).status, 401);
  const signed = await call('/api/auth/login', { email: viewer.id + '@example.invalid', password: f.password });
  assert.equal(signed.status, 200);
  const result = await call('/api/management-read', { view: 'archive' }, signed.cookie);
  assert.equal(result.status, 200); assert.equal(result.body.data.projects.length, 2);
  assert.equal(result.body.data.project_id, 'demo-res');
  assert.equal(result.body.data.archive.project_master[0].project_id, 'demo-res');
  assert.ok(result.body.data.archive.project_phases.length); assert.ok(result.body.data.archive.milestones.length);
  assert.equal(Object.hasOwn(result.body.data, 'password_hash'), false);
  assert.equal((await call('/api/db', { table: 'projects', operation: 'insert', values: { id: 'forged', name: '禁止创建' } }, signed.cookie)).status, 403);
  const ordinary = await call('/api/db', { table: 'projects' }, signed.cookie);
  assert.deepEqual(ordinary.body.data, []);
});
