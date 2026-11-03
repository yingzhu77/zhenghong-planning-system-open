import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { BUSINESS_MODULES, businessModulesForProject, hasAllBusinessModules, canUseBusinessModule, resolveWritableBusinessLine } from '../server/commercial-modules.mjs';
import { uploadReportAttachment, listReportAttachments, loadReportAttachment } from '../server/report-attachments.mjs';
import { previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';

const wild = { id: 'qa-all' }, fixed = { id: 'qa-fixed' }, blank = { id: 'qa-blank' }, origin = { id: 'qa-origin' }, ops = { id: 'qa-ops' };
const LEGACY_MODULES=businessModulesForProject('qa-com');
const status = value => error => error.status === value;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  const admin = testPool(db, null), pool = testPool(db);
  await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('qa-com','匿名商业','com'),('qa-res','匿名住宅','res'),('qa-foreign','未分配商业','com')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,biz_line) VALUES ('qa-all','匿名通配填报人','pm','approved','*'),('qa-fixed','匿名固定填报人','pm','approved','土建工程（东地块）'),('qa-blank','匿名未分配填报人','pm','approved',NULL),('qa-origin','匿名需求发起人','pm','approved','成本'),('qa-ops','匿名运营','ops','approved',NULL),('qa-pending','匿名待审','pm','pending','*'),('qa-president','匿名总裁','president','approved','*')");
  for (const user of [wild, fixed, blank, origin, { id: 'qa-pending' }]) await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'qa-com')", [user.id]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('qa-all','qa-res')");
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planning-commercial-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { db, admin, pool, directory };
}
function save(f, user, values) {
  return executeDatabase(f.pool, user, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line',
    values: { project_id: 'qa-com', period: '匿名验证周期', change_text: '匿名填报内容', ...values } });
}
function edit(f, user, report, values) { return executeDatabase(f.pool, user, { table: 'reports', operation: 'update', filters: [{ column: 'id', value: report.id }], values }); }
function upload(f, user, line) { return uploadReportAttachment(f.pool, user, f.directory, { project_id: 'qa-com', period: '匿名验证周期', line, filename: '匿名资料.png' }, png); }
function key(report, type, id, kind = 'plan') { return kind + ':' + report.project_id + ':' + report.id + ':' + type + ':' + id; }
async function apply(f, source_key, user = wild) {
  const preview = await previewCompletion(f.pool, user, { source_key });
  return requestCompletion(f.pool, user, { source_key, source_version: preview.source_version, completion_date: '2026-10-20', completion_note: '匿名完成说明' });
}

test('only the explicit account wildcard expands the twelve real modules and never becomes a report line', () => {
  assert.deepEqual(LEGACY_MODULES, ['土建工程（东地块）','土建工程（西地块）','机电工程','精装工程','幕墙设计+工程','景观设计+工程','开发','建筑结构设计','机电设计','精装设计','成本','招采']);
  assert.deepEqual(BUSINESS_MODULES,[...LEGACY_MODULES,'设计部']);assert.deepEqual(businessModulesForProject('hf'),BUSINESS_MODULES);
  assert.equal(canUseBusinessModule({biz_line:'*'},'设计部','hf'),true);assert.equal(canUseBusinessModule({biz_line:'*'},'设计部','qa-com'),false);
  for (const biz_line of [null, undefined, '', ' * ', '所有模块', 1]) {
    assert.equal(hasAllBusinessModules({ biz_line }), false);
    assert.equal(canUseBusinessModule({ biz_line }, '成本'), false);
    assert.throws(() => resolveWritableBusinessLine({ biz_line }, '成本'), status(400));
  }
  assert.equal(resolveWritableBusinessLine({ biz_line: '土建工程（东地块）' }), '土建工程（东地块）');
  assert.throws(() => resolveWritableBusinessLine({ biz_line: '*' }), status(400));
  for (const line of ['*', '综合', '', null, '未知模块', ' 成本']) {
    assert.equal(canUseBusinessModule({ biz_line: '*' }, line), false);
    assert.throws(() => resolveWritableBusinessLine({ biz_line: '*' }, line), status(403));
  }
});

test('012 is repeatable and preserves the existing helper owner, ACL, identity and all business rows', async t => {
  const f = await fixture(t), [report] = await save(f, wild, { line: '机电工程', change_text: '原始记录' });
  const metadata = async () => (await f.admin.query("SELECT oid,proowner,proacl::text AS acl,prosecdef,proconfig FROM pg_proc WHERE oid='app_private.can_write_report(text,text,text)'::regprocedure")).rows[0];
  const snapshot = async () => (await f.admin.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id) FROM public.profiles p),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.reports r)) AS data")).rows[0].data;
  const before = await snapshot(), beforeFunction = await metadata();
  const sql = await readFile(new URL('../db/012-commercial-module-split.sql', import.meta.url), 'utf8');
  await f.db.exec(sql); await f.db.exec(sql);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await metadata(), beforeFunction);
  assert.equal(before.reports[0].id, report.id);
});

test('reports persist twelve actual module scopes while fixed, unassigned, foreign project and forged owners stay restricted', async t => {
  const f = await fixture(t);
  assert.equal((await save(f, fixed, { period: '固定周期' }))[0].line, '土建工程（东地块）');
  await assert.rejects(save(f, fixed, { line: '机电工程' }), status(403));
  await assert.rejects(save(f, blank, { line: '土建工程（东地块）' }), status(400));
  for (const user of [{ id: 'qa-pending' }, { id: 'qa-president' }]) await assert.rejects(save(f, user, { line: '成本' }), status(403));
  for (const line of LEGACY_MODULES) {
    const [report] = await save(f, wild, { line, change_text: line });
    assert.equal(report.line, line); assert.equal(report.author_id, wild.id);
    const [updated] = await edit(f, wild, report, { change_text: '按实际已保存模块更新' });
    assert.equal(updated.line, line); assert.equal(updated.history.length, 1);
  }
  await assert.rejects(save(f, wild, {}), status(400));
  for (const line of ['*', '未知模块', '综合']) await assert.rejects(save(f, wild, { line }), status(403));
  await assert.rejects(save(f, wild, { project_id: 'qa-foreign', line: '成本' }), status(403));
  await assert.rejects(save(f, wild, { line: '成本', author_id: fixed.id }), status(403));
  const [res] = await save(f, wild, { project_id: 'qa-res', line: '综合' }); assert.equal(res.line, '综合');
  await assert.rejects(save(f, wild, { project_id: 'qa-res', line: '成本' }), status(403));
  const helper = (user, pid, line, author = user.id) => withIdentity(f.pool, user.id, async client => (await client.query('SELECT app_private.can_write_report($1,$2,$3) AS ok', [pid,line,author])).rows[0].ok);
  for (const line of LEGACY_MODULES) assert.equal(await helper(wild, 'qa-com', line), true);
  for (const line of ['*', '综合', '未知模块']) assert.equal(await helper(wild, 'qa-com', line), false);
  assert.equal(await helper(blank, 'qa-com', '土建工程（东地块）'), false);
  assert.equal(await helper(fixed, 'qa-com', '机电工程'), false);
  assert.equal(await helper(wild, 'qa-foreign', '成本'), false);
  assert.equal(await helper(wild, 'qa-com', '成本', fixed.id), false);
  await assert.rejects(withIdentity(f.pool, wild.id, client => client.query("INSERT INTO public.reports(project_id,period,line,author_id) VALUES('qa-com','恶意原生写入','*',$1)", [wild.id])), error => error.code === '42501');
  assert.equal((await f.admin.query("SELECT count(*)::integer AS n FROM public.reports WHERE author_id='qa-all' AND project_id='qa-com'")).rows[0].n, 12);
});

test('wildcard attachment uploads and references retain each real report scope and revoke future writes when fixed again', async t => {
  const f = await fixture(t), reports = [], attachments = [];
  for (const line of LEGACY_MODULES) {
    const attachment = await upload(f, wild, line); attachments.push(attachment);
    const [report] = await save(f, wild, { line, biz: { attachments: [attachment.id] } }); reports.push(report);
    assert.equal(attachment.line, line); assert.equal(report.line, line);
  }
  await assert.rejects(upload(f, fixed, '机电工程'), status(403));
  await assert.rejects(upload(f, blank, '土建工程（东地块）'), status(400));
  for (const line of ['*', '未知模块', '综合']) await assert.rejects(upload(f, wild, line), status(403));
  await assert.rejects(edit(f, wild, reports[0], { biz: { attachments: [attachments[1].id] } }), status(403));
  assert.equal((await f.admin.query('SELECT history FROM public.reports WHERE id=$1', [reports[0].id])).rows[0].history.length, 0);
  assert.equal((await edit(f, wild, reports[0], { biz: { attachments: [attachments[0].id] } }))[0].line, LEGACY_MODULES[0]);
  await f.admin.query("UPDATE public.profiles SET biz_line='土建工程（东地块）' WHERE user_id=$1", [wild.id]);
  await assert.rejects(upload(f, wild, '机电工程'), status(403));
  await assert.rejects(edit(f, wild, reports[1], { change_text: '已撤销其他模块修改权' }), status(403));
  assert.equal((await f.admin.query('SELECT history FROM public.reports WHERE id=$1', [reports[1].id])).rows[0].history.length, 0);
  assert.equal((await readdir(path.join(f.directory, 'report-attachments'))).length, 12);
  assert.equal((await f.admin.query('SELECT count(*)::integer AS n FROM public.report_attachment_links')).rows[0].n, 12);
});

test('completion sources expand real coordination targets, enforce actual plan report modules and recheck revoked grants on approval', async t => {
  const f = await fixture(t), reports = [];
  for (const line of LEGACY_MODULES) reports.push((await save(f, wild, { line,
    coord_items: [{ source_id: 'own-coord', who: '其他接收人', what: '本人发起协调' }, { source_id: 'own-coord-new', who: '匿名通配填报人', what: '本人旧协调新申报' }],
    biz: { items: [{ source_id: 'own-item', name: '匿名事项', mod: '土建工程（东地块）' }],
      handover: [{ source_id: 'own-handover', to: '其他接收人', what: '本人发起移交' }, { source_id: 'own-handover-new', to: '匿名通配填报人', what: '本人旧移交新申报' }] } }))[0]);
  const coord = LEGACY_MODULES.map((line, index) => ({ source_id: 'coord-' + index, who: line, what: '匿名协调内容' }));
  coord.push({ source_id: 'literal-star', who: '*', what: '匿名无实际目标' }, { source_id: 'person', who: '匿名未分配填报人', what: '按姓名提出的需求' });
  const [otherReport] = await save(f, origin, { line: '成本', period: '他人协调周期', coord_items: coord,
    biz: { handover: LEGACY_MODULES.map((line, index) => ({ source_id: 'handover-' + index, to: line, what: '匿名移交内容' })) } });
  for (let index = 0; index < LEGACY_MODULES.length; index++) {
    assert.equal((await previewCompletion(f.pool, wild, { source_key: key(reports[index], 'items', 'own-item') })).line, LEGACY_MODULES[index]);
    assert.equal((await previewCompletion(f.pool, wild, { source_key: key(otherReport, 'coord', 'coord-' + index, 'coord') })).kind, 'coord');
    assert.equal((await previewCompletion(f.pool, wild, { source_key: key(otherReport, 'handover', 'handover-' + index, 'coord') })).kind, 'coord');
    for (const [group, id] of [['coord','own-coord'],['handover','own-handover']]) assert.equal((await previewCompletion(f.pool, wild, { source_key: key(reports[index], group, id, 'coord') })).kind, 'coord');
  }
  await assert.rejects(previewCompletion(f.pool, wild, { source_key: key(otherReport, 'coord', 'literal-star', 'coord') }), status(403));
  await assert.rejects(previewCompletion(f.pool, fixed, { source_key: key(otherReport, 'coord', 'coord-1', 'coord') }), status(403));
  await assert.rejects(previewCompletion(f.pool, blank, { source_key: key(otherReport, 'coord', 'coord-0', 'coord') }), status(403));
  assert.equal((await previewCompletion(f.pool, blank, { source_key: key(otherReport, 'coord', 'person', 'coord') })).kind, 'coord');
  await assert.rejects(previewCompletion(f.pool, fixed, { source_key: key(reports[0], 'items', 'own-item') }), status(403));
  // Historic invalid scopes and a forged item.mod never grant completion rights.
  for (const line of ['*', '综合', '未知模块']) {
    const report = (await f.admin.query('INSERT INTO public.reports(project_id,period,line,author_id,biz) VALUES($1,$2,$3,$4,$5) RETURNING *', ['qa-com','旧异常范围',line,wild.id,JSON.stringify({ items: [{ source_id: 'old-item', name: '旧事项', mod: '土建工程（东地块）' }] })])).rows[0];
    await assert.rejects(previewCompletion(f.pool, wild, { source_key: key(report, 'items', 'old-item') }), status(403));
  }
  const pending = await apply(f, key(reports[1], 'items', 'own-item'));
  const ownCoordPending = await apply(f, key(reports[1], 'coord', 'own-coord', 'coord'));
  const ownHandoverPending = await apply(f, key(reports[1], 'handover', 'own-handover', 'coord'));
  const newOwnSources = await Promise.all([['coord','own-coord-new'],['handover','own-handover-new']].map(([group,id]) => previewCompletion(f.pool, wild, { source_key:key(reports[1],group,id,'coord') })));
  await f.admin.query("UPDATE public.profiles SET biz_line='土建工程（东地块）' WHERE user_id=$1", [wild.id]);
  await assert.rejects(previewCompletion(f.pool, wild, { source_key: key(reports[1], 'items', 'own-item') }), status(403));
  await assert.rejects(reviewCompletion(f.pool, ops, { id: pending.id, expected_revision: pending.revision, decision: 'approve', note: '' }), error => error.status === 409 && error.code === 'source_changed');
  assert.deepEqual((await f.admin.query('SELECT status,revision,history FROM public.completion_requests WHERE id=$1', [pending.id])).rows[0], { status: 'pending', revision: 1, history: [] });
  for (const source of newOwnSources) await assert.rejects(requestCompletion(f.pool,wild,{source_key:source.source_key,source_version:source.source_version,completion_date:'2026-10-20',completion_note:'已撤销模块新申报'}),status(403));
  // Coordination is confirmed by its originating reporter; handovers retain
  // operator review. Exercise revocation through each actually authorized role.
  await assert.rejects(reviewCompletion(f.pool,ops,{id:ownCoordPending.id,expected_revision:ownCoordPending.revision,decision:'approve',note:''}),error => error.status===403 && error.code==='completion_forbidden');
  for (const [request,reviewer] of [[ownCoordPending,wild],[ownHandoverPending,ops]]) {
    await assert.rejects(reviewCompletion(f.pool,reviewer,{id:request.id,expected_revision:request.revision,decision:'approve',note:''}),error => error.status===409 && error.code==='source_changed');
    assert.deepEqual((await f.admin.query('SELECT status,revision,history FROM public.completion_requests WHERE id=$1',[request.id])).rows[0],{status:'pending',revision:1,history:[]});
  }
  assert.equal((await apply(f, key(reports[0], 'items', 'own-item'))).status, 'pending');
  for (const [group,id] of [['coord','own-coord'],['handover','own-handover']]) assert.equal((await apply(f,key(reports[0],group,id,'coord'))).status,'pending');
  // A different module may still send a real demand to this reporter's current
  // module; only their own no-longer-authorized source branch is revoked.
  for (const [group,id] of [['coord','coord-0'],['handover','handover-0']]) assert.equal((await previewCompletion(f.pool,wild,{source_key:key(otherReport,group,id,'coord')})).kind,'coord');
  const [res] = await save(f, wild, { project_id: 'qa-res', line: '综合', biz: { items: [{ source_id: 'res-item', name: '住宅事项' }] } });
  assert.equal((await previewCompletion(f.pool, wild, { source_key: key(res, 'items', 'res-item') })).kind, 'plan');
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='qa-com'", [wild.id]);
  await assert.rejects(previewCompletion(f.pool, wild, { source_key: key(otherReport, 'coord', 'coord-0', 'coord') }), status(403));
});

test('only ops can assign the explicit test wildcard and restore one fixed module', async t => {
  const f = await fixture(t), change = (user, biz_line) => executeDatabase(f.pool, user, { table: 'profiles', operation: 'update', filters: [{ column: 'user_id', value: fixed.id }], values: { biz_line } });
  await assert.rejects(change(fixed, '*'), status(403));
  assert.equal((await change(ops, '*'))[0].biz_line, '*');
  assert.equal((await save(f, fixed, { line: '招采' }))[0].line, '招采');
  assert.equal((await change(ops, '土建工程（东地块）'))[0].biz_line, '土建工程（东地块）');
  await assert.rejects(save(f, fixed, { line: '招采' }), status(403));
  for (const value of ['所有模块', ' * ', '未知模块', []]) await assert.rejects(change(ops, value), status(400));
  assert.equal((await change(ops, null))[0].biz_line, null);
  await assert.rejects(save(f, fixed, { line: '土建工程（东地块）' }), status(400));
});

test('unsplit civil-work reports and referenced files stay readable while new writes and completion approvals are blocked', async t => {
  const f = await fixture(t), id = randomUUID(), storageKey = 'report-attachments/' + id + '.png';
  await mkdir(path.join(f.directory, 'report-attachments'), {recursive:true});
  await writeFile(path.join(f.directory, storageKey), png);
  await f.admin.query("INSERT INTO public.report_attachments(id,project_id,period,line,owner_id,name,mime,size,storage_key) VALUES($1,'qa-com','旧土建周期','土建工程',$2,'旧资料.png','image/png',$3,$4)", [id,wild.id,png.length,storageKey]);
  const historic = {items:[{source_id:'legacy-item',name:'旧土建事项',mod:'土建工程'}],attachments:[id]};
  const report = (await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,history) VALUES('qa-com','旧土建周期','土建工程',$1,'匿名历史填报人',$2,$3) RETURNING *",
    [wild.id,JSON.stringify(historic),JSON.stringify([{at:'2026-10-01',data:{line:'土建工程',change_text:'保留历史'}}])])).rows[0];
  const readable = await executeDatabase(f.pool,wild,{table:'reports',filters:[{column:'id',value:report.id}]});
  assert.equal(readable[0].line,'土建工程'); assert.deepEqual(readable[0].biz,historic);
  assert.deepEqual(readable[0].history,report.history);
  assert.equal((await listReportAttachments(f.pool,ops,{report_id:report.id}))[0].id,id);
  assert.deepEqual((await loadReportAttachment(f.pool,ops,f.directory,id)).buffer,png);
  await assert.rejects(save(f,wild,{period:'新旧模块周期',line:'土建工程'}),status(403));
  await assert.rejects(edit(f,wild,report,{change_text:'不应更新历史'}),status(403));
  await assert.rejects(upload(f,wild,'土建工程'),status(403));
  await assert.rejects(withIdentity(f.pool,wild.id,client => client.query("INSERT INTO public.reports(project_id,period,line,author_id) VALUES('qa-com','原生旧模块写入','土建工程',$1)",[wild.id])),error => error.code==='42501');
  const source_key = key(report,'items','legacy-item');
  await assert.rejects(previewCompletion(f.pool,wild,{source_key}),status(403));
  const pendingId = randomUUID();
  await withIdentity(f.pool,wild.id,client => client.query("INSERT INTO public.completion_requests(id,source_key,source_version,project_id,kind,source_id,report_id,title,what,source_snapshot,owner_id,owner_name,completion_date,completion_note) VALUES($1,$2,$3,'qa-com','plan','legacy-item',$4,'旧土建计划','旧土建事项','{}',$5,'匿名历史填报人','2026-10-20','旧待审结果')",
    [pendingId,source_key,'a'.repeat(64),report.id,wild.id]));
  await assert.rejects(reviewCompletion(f.pool,ops,{id:pendingId,expected_revision:1,decision:'approve',note:''}),error => error.status===409 && error.code==='source_changed');
  assert.deepEqual((await f.admin.query('SELECT status,revision,history FROM public.completion_requests WHERE id=$1',[pendingId])).rows[0],{status:'pending',revision:1,history:[]});
  assert.deepEqual((await f.admin.query('SELECT biz,history FROM public.reports WHERE id=$1',[report.id])).rows[0],{biz:report.biz,history:report.history});
});
