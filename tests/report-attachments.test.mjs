import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { assertTable, getProfile, withIdentity } from '../server/database.mjs';
import { uploadReportAttachment, loadReportAttachment, listReportAttachments, discardReportAttachment, discardInaccessibleReportDrafts, validateReportAttachmentReferences } from '../server/report-attachments.mjs';

const user = { id: 'demo-pm-res' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const status = expected => error => error.status === expected;
async function fixture(t) {
  const db = await initializedDatabase(); t.after(() => db.close());
  await db.exec(await readFile(new URL('../db/008-report-attachments.sql', import.meta.url), 'utf8'));
  const admin = testPool(db, null); await seedDemo(admin);
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pzo','demo-res')");
  const pool = testPool(db), directory = await mkdtemp(path.join(os.tmpdir(), 'planning-report-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = (await withIdentity(pool, user.id, client => client.query("SELECT project_id,period,line FROM public.reports WHERE author_id=$1", [user.id]))).rows[0];
  return { db, admin, pool, directory, scope };
}
function upload(f, extra = {}, actor = user, body = png) {
  return uploadReportAttachment(f.pool, actor, f.directory, { ...f.scope, filename: '验收资料.png', ...extra }, body, 'application/octet-stream');
}
async function submit(f, ids, actor = user) {
  return withIdentity(f.pool, actor.id, async client => {
    const existing = (await client.query('SELECT * FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3 FOR UPDATE', [f.scope.project_id,f.scope.period,f.scope.line])).rows[0];
    const row = { ...f.scope, biz: { ...(existing.biz || {}), attachments: ids } };
    await validateReportAttachmentReferences(client, actor.id, await getProfile(client, actor.id), row, existing);
    return (await client.query('UPDATE public.reports SET biz=$1 WHERE id=$2 RETURNING *', [JSON.stringify(row.biz),existing.id])).rows[0];
  });
}

test('report attachment migration repeats without rewriting existing business records', async t => {
  const f = await fixture(t), saved = await upload(f);
  const snapshot = async () => (await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m)) FROM public.project_members m),'attachments',(SELECT jsonb_agg(to_jsonb(a)) FROM public.report_attachments a)) AS data")).rows[0].data;
  const before = await snapshot();
  const migration = await readFile(new URL('../db/008-report-attachments.sql', import.meta.url), 'utf8');
  await f.db.exec('RESET ROLE'); await f.db.exec(migration); await f.db.exec(migration);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.attachments[0].id, saved.id);
  assert.throws(() => assertTable('report_attachments'), status(400));
  assert.throws(() => assertTable('report_attachment_links'), status(400));
});

test('uploaded drafts are visible only to their owner and never reveal a filesystem key', async t => {
  const f = await fixture(t), saved = await upload(f);
  assert.equal(saved.owner_id, user.id); assert.equal(saved.mime, 'image/png'); assert.equal(saved.size, png.length);
  assert.equal(saved.inline, true); assert.equal(saved.url, '/api/report-attachments/' + saved.id);
  assert.equal(saved.referenced,false);
  assert.equal(Object.hasOwn(saved, 'storage_key'), false);
  assert.deepEqual((await loadReportAttachment(f.pool,user,f.directory,saved.id)).buffer, png);
  const streamed = await loadReportAttachment(f.pool,user,f.directory,saved.id,{stream:true}), chunks = [];
  for await (const chunk of streamed.stream) chunks.push(chunk);
  assert.equal(Object.hasOwn(streamed,'buffer'),false); assert.equal(streamed.size,png.length);
  assert.deepEqual(Buffer.concat(chunks),png);
  assert.equal((await listReportAttachments(f.pool,user,{ ...f.scope })).length, 1);
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('attachment-other-pm','同项目填报人','pm','approved')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('attachment-other-pm','demo-res')");
  for (const id of ['demo-ops','demo-president','demo-pzo','attachment-other-pm']) {
    assert.deepEqual(await listReportAttachments(f.pool,{id},{ ids:[saved.id] }), []);
    await assert.rejects(loadReportAttachment(f.pool,{id},f.directory,saved.id),status(404));
  }
  await assert.rejects(listReportAttachments(f.pool,{id:'demo-pm-com'},{ project_id:'demo-res' }),status(403));
});

test('real report references grant existing project readers access and remain after current removal', async t => {
  const f = await fixture(t), saved = await upload(f);
  const report = await submit(f,[saved.id]);
  for (const id of ['demo-ops','demo-president','demo-pzo']) {
    const listed = await listReportAttachments(f.pool,{id},{ report_id:report.id });
    assert.equal(listed.length,1); assert.equal(listed[0].id,saved.id);
    assert.equal(listed[0].referenced,true);
    assert.deepEqual((await loadReportAttachment(f.pool,{id},f.directory,saved.id)).buffer,png);
  }
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('attachment-project-reader','同项目填报人','pm','approved')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('attachment-project-reader','demo-res')");
  assert.equal((await listReportAttachments(f.pool,{id:'attachment-project-reader'},{report_id:report.id})).length,1);
  assert.deepEqual(await listReportAttachments(f.pool,{id:'demo-pm-com'},{ ids:[saved.id] }),[]);
  const removed = await submit(f,[]);
  assert.equal(removed.biz.attachments.length,0);
  assert.ok(removed.history.some(entry => entry.data.biz?.attachments?.includes(saved.id)));
  assert.equal((await listReportAttachments(f.pool,{id:'demo-president'},{ report_ids:[report.id] })).length,1);
  assert.deepEqual((await loadReportAttachment(f.pool,{id:'demo-president'},f.directory,saved.id)).buffer,png);
  const files = await readdir(path.join(f.directory,'report-attachments')); assert.equal(files.length,1);
});

test('reference validation rejects foreign owners, periods, modules and fabricated ids', async t => {
  const f = await fixture(t), own = await upload(f), otherPeriod = await upload(f,{period:'另一期'});
  await assert.rejects(submit(f,[otherPeriod.id]),status(403));
  await assert.rejects(submit(f,[randomUUID()]),status(403));
  await assert.rejects(submit(f,[own.id,own.id]),status(400));
  await assert.rejects(submit(f,['../file']),status(400));
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('attachment-other-pm','同项目填报人','pm','approved')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('attachment-other-pm','demo-res')");
  const foreign = await upload(f,{}, {id:'attachment-other-pm'});
  await assert.rejects(submit(f,[foreign.id]),status(403));
  await assert.rejects(upload(f,{line:'土建工程（东地块）'}),status(403));
  await assert.rejects(upload(f,{}, {id:'demo-president'}),status(403));
  await assert.rejects(upload(f,{}, {id:'demo-pm-com'}),status(403));
  const commercial = { ...f,scope:{project_id:'demo-com',period:f.scope.period,line:'土建工程（东地块）'} };
  assert.ok((await upload(commercial,{}, {id:'demo-pm-com'})).id);
  await assert.rejects(upload(commercial,{line:'机电工程'}, {id:'demo-pm-com'}),status(403));
});

test('database trigger prevents forged report references and direct history-link fabrication', async t => {
  const f = await fixture(t), saved = await upload(f,{period:'不属于本报的周期'});
  await assert.rejects(withIdentity(f.pool,user.id,client => client.query('UPDATE public.reports SET biz=$1 WHERE project_id=$2', [JSON.stringify({attachments:[saved.id]}),f.scope.project_id])),error => error.code==='42501');
  await assert.rejects(withIdentity(f.pool,user.id,client => client.query('INSERT INTO public.report_attachment_links(report_id,attachment_id,project_id) SELECT id,$1,project_id FROM public.reports WHERE project_id=$2',[saved.id,f.scope.project_id])),error => error.code==='42501');
  for (const statement of ['UPDATE public.report_attachments SET name=\'changed.png\' WHERE id=$1','DELETE FROM public.report_attachments WHERE id=$1']) await assert.rejects(withIdentity(f.pool,user.id,client=>client.query(statement,[saved.id])),error=>error.code==='42501');
  const counts = await f.admin.query('SELECT (SELECT count(*) FROM public.report_attachment_links)::int AS links');
  assert.equal(counts.rows[0].links,0);
});

test('report references enforce count and combined bytes without counting historical replacements', async t => {
  const f = await fixture(t), ids = [];
  for (let i=0;i<21;i++) ids.push((await upload(f,{filename:'资料'+i+'.png'})).id);
  await assert.rejects(submit(f,ids),status(400));
  await submit(f,ids.slice(0,20));
  await submit(f,[ids[20]]);
  assert.equal((await listReportAttachments(f.pool,{id:'demo-president'},{ ...f.scope })).length,21);
  const large = ids.slice(0,6);
  await f.admin.query('UPDATE public.report_attachments SET size=8388608 WHERE id=ANY($1::uuid[])',[large]);
  await assert.rejects(submit(f,large),status(400));
  await assert.rejects(withIdentity(f.pool,user.id,client=>client.query('UPDATE public.reports SET biz=$1 WHERE project_id=$2',[JSON.stringify({attachments:large}),f.scope.project_id])),error=>error.code==='23514');
});

test('upload or database failure removes only the newly created file', async t => {
  const f = await fixture(t); await upload(f);
  const before = await readdir(path.join(f.directory,'report-attachments'));
  const failingPool = { async connect() {
    const client = await f.pool.connect();
    return { ...client, async query(sql,values) {
      if (typeof sql==='string' && sql.startsWith('INSERT INTO public.report_attachments')) throw new Error('controlled metadata failure');
      return client.query(sql,values);
    } };
  } };
  await assert.rejects(uploadReportAttachment(failingPool,user,f.directory,{...f.scope,filename:'new.png'},png,'image/png'),/controlled metadata failure/);
  assert.deepEqual(await readdir(path.join(f.directory,'report-attachments')),before);
  assert.equal((await listReportAttachments(f.pool,user,{...f.scope})).length,1);
  await assert.rejects(upload(f,{},user,Buffer.alloc(8*1024*1024+1)),status(413));
  await assert.rejects(upload(f,{filename:'fake.png'},user,Buffer.from('<html>not an image</html>')),status(400));
  await assert.rejects(upload(f,{filename:'../file.png'}),status(400));
});

test('list filters are explicit, validated, paginated only when requested, and current membership applies to drafts', async t => {
  const f = await fixture(t), first = await upload(f), second = await upload(f);
  assert.equal((await listReportAttachments(f.pool,user,{ids:[first.id,second.id]})).length,2);
  assert.equal((await listReportAttachments(f.pool,user,{...f.scope,limit:1,offset:1})).length,1);
  for (const input of [{},{owner_id:user.id},{ids:'invalid'},{ids:[first.id,first.id]},{report_id:'0'},{report_ids:['1'],report_id:'2'},{project_id:'demo-res',offset:1}]) await assert.rejects(listReportAttachments(f.pool,user,input),status(400));
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'",[user.id]);
  await assert.rejects(loadReportAttachment(f.pool,user,f.directory,first.id),status(404));
  await assert.rejects(upload(f),status(403));
  assert.equal((await stat(path.join(f.directory,'report-attachments'))).isDirectory(),true);
});

async function seedDrafts(f,count,size=1,scope=f.scope) {
  const ids = Array.from({length:count},()=>randomUUID());
  await f.admin.query(`INSERT INTO public.report_attachments(id,project_id,period,line,owner_id,name,mime,size,storage_key)
    SELECT item,$2,$3,$4,$5,'quota.png','image/png',$6,'report-attachments/' || item::text || '.png' FROM unnest($1::uuid[]) item`,
  [ids,scope.project_id,scope.period,scope.line,user.id,size]);
  return ids;
}

test('all-scope draft count quota excludes submitted history and rechecks successive same-owner reservations',async t=>{
  const f=await fixture(t),historical=await upload(f);await submit(f,[historical.id]);await submit(f,[]);
  await seedDrafts(f,99);
  const outcomes=await Promise.allSettled([upload(f,{filename:'concurrent-one.png'}),upload(f,{filename:'concurrent-two.png'})]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
  const rejected=outcomes.find(row=>row.status==='rejected').reason;
  assert.equal(rejected.status,413);assert.equal(rejected.code,'draft_storage_limit');
  const usage=(await withIdentity(f.pool,user.id,client=>client.query('SELECT * FROM app_private.lock_report_attachment_draft_usage()'))).rows[0];
  assert.equal(Number(usage.draft_count),100);
  assert.equal((await listReportAttachments(f.pool,user,{...f.scope})).length,101);
});

test('draft byte quota is global to the owner, includes revoked projects, and frees only discarded drafts',async t=>{
  const f=await fixture(t),ids=await seedDrafts(f,25,8*1024*1024);
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('attachment-second-res','另一个匿名项目','res')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'attachment-second-res')",[user.id]);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'",[user.id]);
  const second={...f,scope:{...f.scope,project_id:'attachment-second-res'}};
  await assert.rejects(upload(second),error=>error.status===413&&error.code==='draft_storage_limit');
  await assert.rejects(discardReportAttachment(f.pool,user,f.directory,{id:ids[0]}),status(404));
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')",[user.id]);
  assert.deepEqual(await discardReportAttachment(f.pool,user,f.directory,{id:ids[0]}),{id:ids[0],discarded:true});
  assert.ok((await upload(second)).id);
});

test('discard removes only current-owner unreferenced drafts and never a submitted historical file',async t=>{
  const f=await fixture(t),draft=await upload(f),referenced=await upload(f);
  await submit(f,[referenced.id]);await submit(f,[]);
  assert.equal((await listReportAttachments(f.pool,user,{ids:[draft.id]}))[0].referenced,false);
  await assert.rejects(discardReportAttachment(f.pool,{id:'demo-president'},f.directory,{id:draft.id}),status(403));
  await assert.rejects(discardReportAttachment(f.pool,{id:'demo-pm-com'},f.directory,{id:draft.id}),status(404));
  await assert.rejects(discardReportAttachment(f.pool,user,f.directory,{id:referenced.id}),error=>error.status===409&&error.code==='attachment_referenced');
  assert.deepEqual((await loadReportAttachment(f.pool,{id:'demo-president'},f.directory,referenced.id)).buffer,png);
  await discardReportAttachment(f.pool,user,f.directory,{id:draft.id});
  await assert.rejects(loadReportAttachment(f.pool,user,f.directory,draft.id),status(404));
  assert.equal((await readdir(path.join(f.directory,'report-attachments'))).length,1);
  await assert.rejects(submit(f,[draft.id]),status(403));
});

test('discard commits metadata deletion before filesystem cleanup and classifies cleanup failures',async t=>{
  const f=await fixture(t),draft=await upload(f);
  const key=(await f.admin.query('SELECT storage_key FROM public.report_attachments WHERE id=$1',[draft.id])).rows[0].storage_key;
  const absolute=path.join(f.directory,key);
  await rm(absolute);await mkdir(absolute);
  await assert.rejects(discardReportAttachment(f.pool,user,f.directory,{id:draft.id}),error=>error.status===500&&error.code==='attachment_cleanup_failed'&&error.cleanupPhase==='discard-file');
  assert.deepEqual(await listReportAttachments(f.pool,user,{ids:[draft.id]}),[]);
  assert.equal((await stat(absolute)).isDirectory(),true);
  await assert.rejects(submit(f,[draft.id]),status(403));
  await assert.rejects(discardReportAttachment(f.pool,user,f.directory,{id:randomUUID(),path:'anything'}),status(400));
});

test('inaccessible draft cleanup releases owner quota without exposing revoked project content or deleting history',async t=>{
  const f=await fixture(t),draft=await upload(f),history=await upload(f);
  await submit(f,[history.id]);await submit(f,[]);
  const accessibleScope={...f.scope,project_id:'attachment-accessible-res'};
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('attachment-accessible-res','仍可访问匿名项目','res')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'attachment-accessible-res')",[user.id]);
  const accessible=await upload({...f,scope:accessibleScope});
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('attachment-cleanup-other','其他填报人','pm','approved')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('attachment-cleanup-other','demo-res')");
  const foreign=await upload(f,{}, {id:'attachment-cleanup-other'});
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'",[user.id]);
  assert.deepEqual(await listReportAttachments(f.pool,user,{ids:[draft.id]}),[]);
  const cleaned=await discardInaccessibleReportDrafts(f.pool,user,f.directory);
  assert.deepEqual(cleaned,{discarded_count:1,freed_bytes:png.length});
  assert.deepEqual(Object.keys(cleaned).sort(),['discarded_count','freed_bytes']);
  assert.equal((await f.admin.query('SELECT id FROM public.report_attachments WHERE id=$1',[draft.id])).rows.length,0);
  assert.equal((await f.admin.query('SELECT id FROM public.report_attachments WHERE id=ANY($1::uuid[])',[[history.id,accessible.id,foreign.id]])).rows.length,3);
  assert.deepEqual((await loadReportAttachment(f.pool,{id:'demo-president'},f.directory,history.id)).buffer,png);
  assert.deepEqual((await loadReportAttachment(f.pool,user,f.directory,accessible.id)).buffer,png);
  const quota=(await withIdentity(f.pool,user.id,client=>client.query('SELECT * FROM app_private.lock_report_attachment_draft_usage()'))).rows[0];
  assert.equal(Number(quota.draft_count),1);
  assert.deepEqual(await discardInaccessibleReportDrafts(f.pool,user,f.directory),{discarded_count:0,freed_bytes:0});
  await assert.rejects(discardInaccessibleReportDrafts(f.pool,{id:'demo-president'},f.directory),status(403));
});

test('restored project permissions keep drafts eligible for normal reading instead of inaccessible cleanup',async t=>{
  const f=await fixture(t),draft=await upload(f);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'",[user.id]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')",[user.id]);
  assert.deepEqual(await discardInaccessibleReportDrafts(f.pool,user,f.directory),{discarded_count:0,freed_bytes:0});
  assert.deepEqual((await loadReportAttachment(f.pool,user,f.directory,draft.id)).buffer,png);
});

test('inaccessible cleanup attempts every file and reports sanitized cleanup failures after committing metadata',async t=>{
  const f=await fixture(t),broken=await upload(f),valid=await upload(f);
  const key=(await f.admin.query('SELECT storage_key FROM public.report_attachments WHERE id=$1',[broken.id])).rows[0].storage_key;
  const absolute=path.join(f.directory,key);await rm(absolute);await mkdir(absolute);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-res'",[user.id]);
  let failure;
  try {await discardInaccessibleReportDrafts(f.pool,user,f.directory);}catch(error){failure=error;}
  assert.equal(failure.status,500);assert.equal(failure.code,'attachment_cleanup_failed');
  assert.equal(failure.cleanupPhase,'discard-inaccessible-files');
  assert.deepEqual(Object.keys(failure.cleanupFailures[0]).sort(),['attachmentId','code']);
  assert.equal(failure.cleanupFailures[0].attachmentId,broken.id);
  assert.equal(failure.discardedCount,2);assert.equal(failure.freedBytes,png.length*2);
  assert.equal((await f.admin.query('SELECT id FROM public.report_attachments WHERE id=ANY($1::uuid[])',[[broken.id,valid.id]])).rows.length,0);
  assert.equal((await readdir(path.join(f.directory,'report-attachments'))).length,1);
  assert.equal(JSON.stringify(failure.cleanupFailures).includes('report-attachments/'),false);
});
