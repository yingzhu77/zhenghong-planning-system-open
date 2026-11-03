import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { buildQuery, executeDatabase, replaceLeaderNotes, withIdentity } from '../server/database.mjs';
import { environmentConfig } from '../server/app.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

test('assigned project managers read and instruct only primary or member projects without changing leader powers', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('scope-primary','主住宅','res'),('scope-member','负责商业','com'),('scope-foreign','未负责住宅','res')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id) VALUES('scope-pzo','匿名项目总','pzo','approved','scope-primary'),('scope-empty','未分配项目总','pzo','approved',NULL),('scope-pending','待审项目总','pzo','pending','scope-primary'),('scope-ops','匿名运营','ops','approved',NULL),('scope-president','匿名总裁','president','approved',NULL),('scope-pm','匿名填报人','pm','approved','scope-primary')");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('scope-pzo','scope-member'),('scope-pm','scope-member')");
  const metadata = async () => (await admin.query("SELECT oid,proname,proowner,proacl::text AS acl,prosecdef,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['app_private.can_read_project(text)'::regprocedure,'app_private.can_write_leader(text,text)'::regprocedure]) ORDER BY proname")).rows;
  const snapshot = async () => (await admin.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,project_id) FROM public.project_members m)) AS data")).rows[0].data;
  const before = await snapshot(), beforeFunction = await metadata();
  const migration = await readFile(new URL('../db/011-project-manager-scope.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await metadata(), beforeFunction);
  const projects = async id => (await executeDatabase(pool, {id}, {table:'projects',columns:'id',order:[{column:'id'}]})).map(row => row.id);
  assert.deepEqual(await projects('scope-pzo'), ['scope-member','scope-primary']);
  assert.deepEqual(await projects('scope-empty'), []);
  assert.deepEqual(await projects('scope-pending'), []);
  assert.deepEqual(await projects('scope-pm'), ['scope-member'], 'PM primary project alone must not expand existing membership rules');
  for (const id of ['scope-ops','scope-president']) assert.equal((await projects(id)).length, 3);
  const note = project_id => ({project_id,period:'匿名范围周期',kind:'pzo_note',items:[{what:'项目范围内工作要求',due:''}]});
  for (const pid of ['scope-primary','scope-member']) assert.equal((await replaceLeaderNotes(pool,{id:'scope-pzo'},note(pid))).length,1);
  await assert.rejects(replaceLeaderNotes(pool,{id:'scope-pzo'},note('scope-foreign')),error => error.status===403);
  await assert.rejects(replaceLeaderNotes(pool,{id:'scope-pzo'},{...note('scope-primary'),kind:'ceo_brief'}),error => error.status===403);
  await assert.rejects(withIdentity(pool,'scope-pzo',client => client.query("INSERT INTO public.leader_notes(project_id,period,kind,what) VALUES('scope-foreign','匿名周期','pzo_note','原生越界写入')")),error => error.code==='42501');
  assert.equal((await replaceLeaderNotes(pool,{id:'scope-ops'},note('scope-foreign'))).length,1);
  assert.equal((await replaceLeaderNotes(pool,{id:'scope-president'},{...note('scope-foreign'),kind:'ceo_brief'})).length,1);
  await admin.query("DELETE FROM public.project_members WHERE user_id='scope-pzo'");
  await admin.query("UPDATE public.profiles SET project_id=NULL WHERE user_id='scope-pzo'");
  assert.deepEqual(await projects('scope-pzo'), []);
  await assert.rejects(replaceLeaderNotes(pool,{id:'scope-pzo'},note('scope-primary')),error => error.status===403);
});

test('query builder parameterizes values and preserves JSON and write returning semantics', () => {
  const query = buildQuery({ table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'p1', period: "x'; DROP TABLE projects;--", line: '综合', node_items: [{ name: 'a,b' }], change_text: 'abc', author_id: 'authenticated-reporter'
  }, columns: 'id,project_id' });
  assert.match(query.text, /ON CONFLICT \("project_id","period","line","author_id"\) DO UPDATE/);
  assert.doesNotMatch(query.text.split(' DO UPDATE SET ')[1], /"author_id"\s*=/, 'upsert must never reassign the existing report author');
  assert.match(query.text, /RETURNING "id","project_id"$/);
  assert.ok(!query.text.includes('DROP TABLE'));
  assert.equal(query.values[1], "x'; DROP TABLE projects;--");
  assert.equal(query.values[3], '[{"name":"a,b"}]');
  assert.equal(query.values[5], 'authenticated-reporter');
});

test('table, column, conflict and whole-table mutations are bounded', () => {
  assert.throws(() => buildQuery({ table: 'app_private.auth_users' }));
  assert.throws(() => buildQuery({ table: 'projects', columns: 'id,(select password_hash)' }));
  assert.throws(() => buildQuery({ table: 'projects', filters: [{ column: 'id;DROP', value: 'x' }] }));
  assert.throws(() => buildQuery({ table: 'profiles', operation: 'update', values: { role: 'ops' } }));
  assert.throws(() => buildQuery({ table: 'projects', operation: 'delete' }));
  assert.throws(() => buildQuery({ table: 'reports', operation: 'upsert', values: { project_id: 'x' }, onConflict: 'id' }));
  assert.throws(() => buildQuery({ table: 'projects', limit: 1000000 }));
  assert.throws(() => buildQuery({ table: 'projects', filters: [null] }), /筛选条件/);
  assert.throws(() => buildQuery({ table: 'projects', order: [null] }), /排序条件/);
});

test('proxy and cookie configuration parse explicit boolean and hop values', () => {
  assert.equal(environmentConfig({ TRUST_PROXY: 'false', COOKIE_SECURE: 'false' }).trustProxy, false);
  assert.equal(environmentConfig({ TRUST_PROXY: '1', COOKIE_SECURE: 'true' }).trustProxy, 1);
  assert.equal(environmentConfig({ TRUST_PROXY: '1', COOKIE_SECURE: 'true' }).cookieSecure, true);
});

test('HTTP database DATE values retain calendar dates without timezone conversion', () => {
  assert.equal(pg.types.getTypeParser(1082)('2027-01-11'), '2027-01-11');
  assert.equal(pg.types.getTypeParser(1082)('2026-10-01'), '2026-10-01');
  assert.equal(pg.types.getTypeParser(1184)('2026-10-16 12:00:00+08') instanceof Date, true);
});
