import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { executeDatabase, withIdentity, reportWeekStart } from '../server/database.mjs';
import { listReportScopes } from '../server/report-scopes.mjs';
import { uploadReportAttachment, loadReportAttachment, listReportAttachments, discardInaccessibleReportDrafts } from '../server/report-attachments.mjs';
const scopeId = 'zhenghongxu-residential', period = '第43周（10.19–10.25）';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t, through = 31) {
  const db = await initializedDatabase({through}); t.after(()=>db.close());
  const admin = testPool(db,null), pool = testPool(db);
  // These assertions exercise the retained comprehensive contract on the
  // current API/schema; professional individual reporting has its own suite.
  if (through >= 30) await admin.query("UPDATE app_private.report_scopes SET reporting_mode='comprehensive' WHERE id=$1",[scopeId]);
  await admin.query("INSERT INTO public.projects(id,name,project_type,active) VALUES('zhx1','一期','res',true),('zhx2','二期','res',true),('klq','可乐地块','res',true),('outside','其他住宅','res',true)");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES('full','原填报人','pm','approved','工程'),('second','另一填报人','pm','approved','工程'),('partial','部分成员','pm','approved','工程'),('ops','管理员','ops','approved',null),('pzo','项目总','pzo','approved',null)");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) SELECT u,p FROM unnest(ARRAY['full','second']) u CROSS JOIN unnest(ARRAY['zhx1','zhx2','klq']) p");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('partial','zhx1'),('pzo','zhx1')");
  const old = (await admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz) VALUES('zhx1','第42周（10.12–10.18）','综合','full','原填报人',$1) RETURNING *",[JSON.stringify({items:[{source_id:'old-original',name:'原历史事项',project_id:'zhx1',prog:'原反馈'}]})])).rows[0];
  return {db,admin,pool,old};
}
function submit(f, values = {}, id='full') {
  return executeDatabase(f.pool,{id},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx1',period,line:'综合',report_scope_id:scopeId,biz:{items:[]},...values}});
}
const status = expected => error => error.status===expected;
test('scope migration preserves all original values and exposes only full original ACL scopes',async t=>{
  const f=await fixture(t,20);
  const snapshot=async()=> (await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r)-'report_scope_id'-'scope_project_ids'-'scope_week') FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p)) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m)) FROM public.project_members m)) AS data")).rows[0].data;
  const before=await snapshot();
  await f.db.exec('RESET ROLE'); await f.db.exec(await readFile(new URL('../db/021-report-scopes.sql',import.meta.url),'utf8'));
  assert.deepEqual(await snapshot(),before);
  for(const id of ['full','ops']) {const scopes=await listReportScopes(f.pool,{id},{period});assert.equal(scopes.length,1);assert.deepEqual(scopes[0].project_ids,['zhx1','zhx2','klq']);assert.equal(scopes[0].active_for_period,true);assert.equal(scopes[0].period_week,'2026-10-19');assert.ok(scopes[0].blocked_weeks.includes('2026-10-12'));}
  assert.deepEqual(await listReportScopes(f.pool,{id:'partial'},{period}),[]);
  assert.deepEqual(await listReportScopes(f.pool,{id:'pzo'},{period}),[]);
});
test('one logical report per scope/week serializes competing authors and immutable identities',async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled([submit(f,{biz:{items:[{source_id:'same-id',project_id:'zhx2',name:'二期事项',prog:'只保存一次'}]}}),submit(f,{},'second')]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
  const saved=results.find(row=>row.status==='fulfilled').value[0];assert.equal(saved.author_id,'full');assert.equal(saved.project_id,'zhx1');assert.equal(saved.report_scope_id,scopeId);assert.deepEqual(saved.scope_project_ids,['zhx1','zhx2','klq']);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0].n,1);
  await assert.rejects(submit(f,{period:'2026-10-20'}),status(409));
  await assert.rejects(executeDatabase(f.pool,{id:'full'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx1',period:'伪造未识别周期',line:'综合',biz:{items:[]}}}),error=>error.code==='report_scope_period_invalid');
  await assert.rejects(submit(f,{scope_project_ids:['zhx1']}),status(400));
  await assert.rejects(submit(f,{project_id:'zhx2'}),status(403));
  await assert.rejects(executeDatabase(f.pool,{id:'partial'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx1',period,line:'综合',biz:{items:[]}}}),status(409));
  assert.deepEqual(await executeDatabase(f.pool,{id:'partial'},{table:'reports',filters:[{column:'report_scope_id',value:scopeId}]}),[]);
  assert.equal((await executeDatabase(f.pool,{id:'partial'},{table:'reports',filters:[{column:'id',value:f.old.id}]}))[0].id,f.old.id);
  const updated=(await submit(f,{biz:{items:[{source_id:'same-id',project_id:'zhx2',name:'二期事项',prog:'新版反馈'}]}}))[0];assert.equal(updated.id,saved.id);assert.equal(updated.history.length,1);assert.equal(updated.history[0].data.biz.items[0].prog,'只保存一次');
  await assert.rejects(submit(f,{biz:{items:[{source_id:'same-id',project_id:'klq',name:'二期事项',prog:'新版反馈'}]}}),error=>error.status===403 && error.code==='report_source_project_immutable');
  await submit(f,{biz:{items:[]}});
  await assert.rejects(submit(f,{biz:{items:[{source_id:'same-id',project_id:'klq',name:'二期事项'}]}}),error=>error.code==='report_source_project_immutable');
});
test('old reports block scope activation for their week and remain under original author/source',async t=>{
  const f=await fixture(t);
  const original=(await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,biz) VALUES('zhx2',$1,'综合','full',$2) RETURNING *",[period,JSON.stringify({items:[{source_id:'original-old',name:'原二期报告'}]})])).rows[0];
  const scopes=await listReportScopes(f.pool,{id:'full'},{period});assert.equal(scopes[0].active_for_period,false);assert.equal(scopes[0].blocked_by_legacy,true);
  await assert.rejects(submit(f),status(409));
  const saved=(await executeDatabase(f.pool,{id:'full'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx2',period,line:'综合',biz:{items:[{source_id:'original-old',name:'保留原入口'}]}}}))[0];assert.equal(saved.id,original.id);assert.equal(saved.report_scope_id,null);assert.equal(saved.history[0].data.biz.items[0].source_id,'original-old');
});
test('scope validates actual milestone project, exact source keys and transaction failure rolls all meeting changes back',async t=>{
  const f=await fixture(t);
  // Only the current week synchronizes live task progress; older reports keep
  // their saved feedback without rewriting the current meeting task.
  const now=new Date(),today=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
  const submitCurrent=values=>submit(f,{...values,period:reportWeekStart(today,now)});
  const node=(await f.admin.query("INSERT INTO public.milestones(project_id,name,discipline,plan_date) VALUES('zhx2','同名基准','工程','2026-10-22') RETURNING *")).rows[0];
  await assert.rejects(submitCurrent({biz:{nodes:[{milestone_id:node.id,project_id:'zhx1',name:'同名基准'}]}}),status(400));
  await assert.rejects(submitCurrent({biz:{nodes:[{milestone_id:node.id,project_id:'outside',name:'同名基准'}]}}),status(400));
  const task=(await f.admin.query("INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,title,what,due,progress,status) VALUES(gen_random_uuid(),'klq','full','原填报人','历史会议待办','原任务','2026-10-25','原进展','open') RETURNING *")).rows[0];
  const followup={source_key:'meeting:klq:'+task.id,source_type:'meeting',source_id:task.id,project_id:'klq',source_revision:task.revision,what:'原任务',progress:'新进展',status:'in_progress'};
  await f.db.exec('RESET ROLE'); await f.db.exec("CREATE FUNCTION public.test_scope_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable transaction failure'; END $$; CREATE TRIGGER zz_test_scope_failure BEFORE INSERT ON public.reports FOR EACH ROW EXECUTE FUNCTION public.test_scope_failure()");
  await assert.rejects(submitCurrent({biz:{nodes:[{milestone_id:node.id,project_id:'zhx2',name:'同名基准'}],followups:[followup]}}),/disposable transaction failure/);
  assert.equal((await f.admin.query('SELECT progress FROM public.reporter_tasks WHERE id=$1',[task.id])).rows[0].progress,'原进展');
  assert.deepEqual((await f.admin.query('SELECT revision,history FROM public.reporter_tasks WHERE id=$1',[task.id])).rows[0],{revision:task.revision,history:[]});
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0].n,0);
  await f.db.exec('RESET ROLE'); await f.db.exec('DROP TRIGGER zz_test_scope_failure ON public.reports; DROP FUNCTION public.test_scope_failure()');
  const saved=(await submitCurrent({biz:{nodes:[{milestone_id:node.id,project_id:'zhx2',name:'同名基准'}],followups:[followup]}}))[0];assert.equal(saved.biz.nodes[0].project_id,'zhx2');assert.equal(saved.biz.followups[0].source_key,'meeting:klq:'+task.id);assert.equal((await f.admin.query('SELECT progress FROM public.reporter_tasks WHERE id=$1',[task.id])).rows[0].progress,'新进展');
});
test('group attachments keep independent identity, immutable history links and require every member ACL',async t=>{
  const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'scope-attachments-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input={project_id:'zhx1',period,line:'综合',filename:'隔离凭证.png'};
  const old=await uploadReportAttachment(f.pool,{id:'full'},dir,input,png);
  const grouped=await uploadReportAttachment(f.pool,{id:'full'},dir,{...input,report_scope_id:scopeId},png);
  assert.equal(old.report_scope_id,null);assert.equal(grouped.report_scope_id,scopeId);
  assert.deepEqual((await listReportAttachments(f.pool,{id:'full'},{project_id:'zhx1',period,line:'综合'})).map(row=>row.id),[old.id]);
  assert.deepEqual((await listReportAttachments(f.pool,{id:'full'},{project_id:'zhx1',period,line:'综合',report_scope_id:scopeId})).map(row=>row.id),[grouped.id]);
  await assert.rejects(submit(f,{biz:{attachments:[old.id]}}),status(403));
  const saved=(await submit(f,{biz:{attachments:[grouped.id]}}))[0];assert.deepEqual(saved.biz.attachments,[grouped.id]);
  assert.equal((await listReportAttachments(f.pool,{id:'second'},{report_id:saved.id})).length,1);assert.deepEqual(await listReportAttachments(f.pool,{id:'partial'},{ids:[grouped.id]}),[]);
  await assert.rejects(loadReportAttachment(f.pool,{id:'partial'},dir,grouped.id),status(404));
  await submit(f,{biz:{attachments:[]}});assert.equal((await listReportAttachments(f.pool,{id:'second'},{report_id:saved.id})).length,1);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id='full' AND project_id='klq'");assert.deepEqual(await executeDatabase(f.pool,{id:'full'},{table:'reports',filters:[{column:'id',value:saved.id}]}),[]);await assert.rejects(loadReportAttachment(f.pool,{id:'full'},dir,grouped.id),status(404));
});

test('explicit inaccessible draft cleanup frees only the owner unreferenced group files after a non-anchor revocation',async t=>{
  const f=await fixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'scope-revoked-drafts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input={project_id:'zhx1',period,line:'综合',filename:'隔离草稿.png'};
  const original=await uploadReportAttachment(f.pool,{id:'full'},dir,input,png);
  const historical=await uploadReportAttachment(f.pool,{id:'full'},dir,{...input,report_scope_id:scopeId},png);
  const report=(await submit(f,{biz:{attachments:[historical.id]}}))[0];
  await submit(f,{biz:{attachments:[]}});
  const hidden=await uploadReportAttachment(f.pool,{id:'full'},dir,{...input,report_scope_id:scopeId},png);
  const other=await uploadReportAttachment(f.pool,{id:'second'},dir,{...input,report_scope_id:scopeId},png);
  const usage=()=>withIdentity(f.pool,'full',async client=>(await client.query('SELECT * FROM app_private.lock_report_attachment_draft_usage()')).rows[0]);
  assert.equal(Number((await usage()).draft_count),2);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id='full' AND project_id='klq'");
  assert.deepEqual(await listReportAttachments(f.pool,{id:'full'},{ids:[hidden.id,historical.id]}),[]);
  assert.deepEqual(await readFile(path.join(dir,'report-attachments',hidden.id+'.png')),png,'permission changes alone must not clean draft files');
  const before=(await f.admin.query('SELECT count(*)::int n FROM public.report_attachment_links WHERE report_id=$1',[report.id])).rows[0].n;
  const cleaned=await discardInaccessibleReportDrafts(f.pool,{id:'full'},dir);
  assert.deepEqual(cleaned,{discarded_count:1,freed_bytes:png.length});
  assert.equal(Number((await usage()).draft_count),1);assert.equal(Number((await usage()).draft_bytes),png.length);
  await assert.rejects(readFile(path.join(dir,'report-attachments',hidden.id+'.png')),error=>error.code==='ENOENT');
  const kept=(await f.admin.query('SELECT id FROM public.report_attachments WHERE id=ANY($1::uuid[]) ORDER BY id',[[original.id,historical.id,hidden.id,other.id]])).rows.map(row=>row.id).sort();
  assert.deepEqual(kept,[original.id,historical.id,other.id].sort());
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.report_attachment_links WHERE report_id=$1',[report.id])).rows[0].n,before);
  assert.deepEqual(await readFile(path.join(dir,'report-attachments',historical.id+'.png')),png);
  assert.deepEqual(await discardInaccessibleReportDrafts(f.pool,{id:'full'},dir),{discarded_count:0,freed_bytes:0});
});
