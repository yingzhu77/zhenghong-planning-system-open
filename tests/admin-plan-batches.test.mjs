import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {saveAdminMonthlyPlans} from '../server/admin-monthly-plans.mjs';
import {listAdminPlanBatches,withdrawAdminPlanBatch} from '../server/admin-plan-batches.mjs';
import {withIdentity,executeDatabase} from '../server/database.mjs';
import {previewCompletion,requestCompletion,reviewCompletion,withdrawCompletion} from '../server/completions.mjs';

const ops={id:'demo-ops'},pm={id:'demo-pm-com'},line='土建工程（东地块）';
const item={source_id:'source-original',mod:'主体',name:'原计划事项',due:'2026-11-20'};
const plan=(extra={})=>({project_id:'demo-com',line,owner_id:pm.id,month:'2026-11',items:[item],expected_plan_id:null,...extra});
const summary=(extra={})=>({...plan(),items:[{...item,progress:'原月度完成情况'}],expected_plan_id:undefined,expected_summary_id:null,...extra});
function summaryValue(extra={}){const value=summary(extra);delete value.expected_plan_id;return value;}
async function fixture(t){const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);return {db,admin,pool};}
const save=(f,plans,summaries,operation_id=randomUUID())=>saveAdminMonthlyPlans(f.pool,ops,{operation_id,plans,...(summaries===undefined?{}:{summaries})});
const history=(f,extra={})=>listAdminPlanBatches(f.pool,ops,{project_id:'demo-com',month:'2026-11',...extra});
const undo=(f,saved,user=ops)=>withdrawAdminPlanBatch(f.pool,user,{actor_id:ops.id,operation_id:saved.operation_id});
async function snapshot(f){return (await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'summaries',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.monthly_plan_summaries s),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'completions',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.completion_requests c),'undo',(SELECT count(*) FROM app_private.admin_monthly_batch_withdrawals),'withdrawals',(SELECT count(*) FROM app_private.monthly_plan_withdrawals)) value")).rows[0].value;}

test('new plan and dual-month summary undo together, historical standalone saves are supported, replay is idempotent and old save cannot revive',async t=>{
 const f=await fixture(t),before=await snapshot(f),operation=randomUUID(),plans=[plan()],summaries=[summaryValue({month:'2026-10'})];
 const saved=await save(f,plans,summaries,operation);let rows=(await history(f)).batches;assert.equal(rows.length,1);assert.equal(rows[0].can_withdraw,true);assert.equal(rows[0].records.length,2);
 assert.equal((await history(f,{month:'2026-10'})).batches[0].operation_id,operation);assert.equal((await history(f,{project_id:'demo-res'})).batches.length,0);
 const result=await undo(f,saved);assert.equal(result.withdrawn,true);assert.equal(result.plans.length,0);assert.equal(result.summaries.length,0);
 assert.deepEqual(result.removed_plan_ids,[saved.plans[0].id]);const after=await snapshot(f);assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.summaries,before.summaries);assert.deepEqual(after.reports,before.reports);assert.deepEqual(after.completions,before.completions);
 assert.equal((await undo(f,saved)).replayed,true);assert.deepEqual(await snapshot(f),after);
 await assert.rejects(save(f,plans,summaries,operation),e=>e.status===409&&e.code==='monthly_plan_operation_withdrawn');
 rows=(await history(f)).batches;assert.equal(rows[0].withdrawn,true);assert.equal(rows[0].can_withdraw,false);
 const standalone=await save(f,[plan()],undefined);assert.equal((await history(f)).batches[0].operation_id,standalone.operation_id);await undo(f,standalone);
 await assert.rejects(save(f,[plan()],undefined,standalone.operation_id),e=>e.code==='monthly_plan_operation_withdrawn');
});

test('append and replace undo restore exact old content, rich text and source ids with new versions and retain both audits',async t=>{
 const f=await fixture(t),rich_text={v:1,fields:{'items.0.name':{ops:[{insert:item.name,attributes:{bold:true}}]}}};
 const first=await save(f,[plan({rich_text})],[summaryValue()]);
 const second=await save(f,[plan({expected_plan_id:first.plans[0].id,items:[item,{...item,source_id:'added-source',name:'本次追加'}],rich_text})],[summaryValue({expected_summary_id:first.summaries[0].id,items:[{...item,progress:'本次替换完成情况'}]})]);
 const restored=await undo(f,second);assert.equal(restored.plans.length,1);assert.equal(restored.summaries.length,1);assert.notEqual(restored.plans[0].id,first.plans[0].id);assert.notEqual(restored.plans[0].id,second.plans[0].id);
 assert.deepEqual(restored.plans[0].items,first.plans[0].items);assert.deepEqual(restored.plans[0].rich_text,first.plans[0].rich_text);assert.deepEqual(restored.summaries[0].items,first.summaries[0].items);assert.equal(restored.summaries[0].version,3);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals WHERE plan_id=ANY($1::uuid[])',[[first.plans[0].id,second.plans[0].id]])).rows[0].n,2);
 assert.equal((await history(f)).batches.find(row=>row.operation_id===first.operation_id).can_withdraw,false,'restoring content must not reactivate an old operation id');
});

test('any later plan or summary change refuses the entire original batch without deleting the unchanged half',async t=>{
 const f=await fixture(t),original=await save(f,[plan()],[summaryValue()]);
 await save(f,[],[summaryValue({expected_summary_id:original.summaries[0].id,items:[{...item,progress:'后来正式核对的内容'}]})]);
 const before=await snapshot(f);await assert.rejects(undo(f,original),e=>e.status===409);assert.deepEqual(await snapshot(f),before);
 const row=(await history(f)).batches.find(row=>row.operation_id===original.operation_id);assert.equal(row.can_withdraw,false);assert.match(row.blockers.join('；'),/汇总已被后续修改/);
});

test('current reports and report history prevent batch withdrawal',async t=>{
 const f=await fixture(t),saved=await save(f,[plan()],[summaryValue()]),p=saved.plans[0];
 await executeDatabase(f.pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'demo-com',line,period:'2026-11-02',biz:{monthly_plan_id:p.id,monthly_plan_month:'2026-11',items:p.items.map(row=>({...row,prog:'已开始反馈',blocker:''}))}}});
 const before=await snapshot(f);await assert.rejects(undo(f,saved),e=>e.status===409);assert.deepEqual(await snapshot(f),before);
 const other=await save(f,[plan({month:'2026-12'})],[]);await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,biz,history) VALUES('demo-com','2026-12-07',$1,$2,'{}',$3)",[line,pm.id,JSON.stringify([{data:{biz:{monthly_plan_ids:[other.plans[0].id]}}}])]);
 await assert.rejects(undo(f,other),e=>e.status===409);
});

test('every completion/extension status and revoked permission on retry preserve the complete batch',async t=>{
 const f=await fixture(t),variants=[['pending','completion'],['approved','completion'],['rejected','completion'],['withdrawn','completion'],['reopened','completion'],['pending','extension'],['approved','extension']];
 for(let index=0;index<variants.length;index++){
  const [status,type]=variants[index],month='2027-'+String(index+1).padStart(2,'0'),saved=await save(f,[plan({month})],[summaryValue({month})]),p=saved.plans[0],source_key='monthly:demo-com:'+p.id+':'+item.source_id;
  const preview=await previewCompletion(f.pool,pm,{source_key});let request=await requestCompletion(f.pool,pm,{source_key,source_version:preview.source_version,request_type:type,completion_note:'匿名证据',...(type==='extension'?{requested_due:'2027-12-01'}:{completion_date:'2026-11-20'})});
  if(status==='approved'||status==='reopened')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'approve'});
  if(status==='reopened')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'reopen',note:'匿名重开'});
  if(status==='rejected')request=await reviewCompletion(f.pool,ops,{id:request.id,expected_revision:request.revision,decision:'reject',note:'匿名退回'});
  if(status==='withdrawn')request=await withdrawCompletion(f.pool,pm,{id:request.id,expected_revision:request.revision});
  assert.equal(request.status,status);const before=await snapshot(f);await assert.rejects(undo(f,saved),e=>e.status===409);assert.deepEqual(await snapshot(f),before);
 }
 const unused=await save(f,[plan({month:'2028-01'})],[]);await undo(f,unused);await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);await assert.rejects(undo(f,unused),e=>e.status===403);
});

test('scoped residential restoration retains members, owner, source and rich text; scope drift blocks without partial writes',async t=>{
 const f=await fixture(t),members=['zhx1','zhx2','klq'],scope='zhenghongxu-residential';
 for(const pid of members){await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,'res')",[pid,'匿名'+pid]);await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pm-res',$1)",[pid]);}
 const p=plan({project_id:'zhx1',line:'工程',owner_id:'demo-pm-res',report_scope_id:scope}),s=summaryValue({project_id:'zhx1',line:'工程',owner_id:'demo-pm-res',report_scope_id:scope});
 const first=await save(f,[p],[s]),second=await save(f,[{...p,expected_plan_id:first.plans[0].id,items:[{...item,name:'替换后住宅事项'}]}],[{...s,expected_summary_id:first.summaries[0].id}]);
 const result=await undo(f,second);assert.deepEqual(result.plans[0].scope_project_ids,members);assert.equal(result.plans[0].owner_id,'demo-pm-res');assert.deepEqual(result.plans[0].items,first.plans[0].items);
 const third=await save(f,[{...p,expected_plan_id:result.plans[0].id}],[]);await f.admin.query('UPDATE app_private.report_scopes SET project_ids=$1 WHERE id=$2',[[members[0],members[1]],scope]);
 const before=await snapshot(f);await assert.rejects(undo(f,third),e=>e.status===409);assert.deepEqual(await snapshot(f),before);
});

test('batch history paginates and validates its scope; missing batches never create a withdrawal audit',async t=>{
 const f=await fixture(t);let prior=null;
 for(let i=0;i<11;i++){const saved=await save(f,[],[summaryValue({expected_summary_id:prior})]);prior=saved.summaries[0].id;}
 const first=await history(f),second=await history(f,{page:1});assert.equal(first.batches.length,10);assert.equal(first.has_more,true);assert.equal(second.batches.length,1);assert.equal(second.has_more,false);assert.equal(new Set([...first.batches,...second.batches].map(row=>row.operation_id)).size,11);
 await assert.rejects(history(f,{page:-1}),e=>e.status===400);const before=await snapshot(f);await assert.rejects(undo(f,{operation_id:randomUUID()}),e=>e.status===404);assert.deepEqual(await snapshot(f),before);
});

test('migration is repeatable and preserves data; only approved ops can list/undo and runtime cannot bypass guarded save entries',async t=>{
 const f=await fixture(t),saved=await save(f,[plan()],[summaryValue()]),before=await snapshot(f),sql=await readFile(new URL('../db/035-admin-monthly-batch-withdrawal.sql',import.meta.url),'utf8');
 await f.admin.query('RESET ROLE');await f.db.exec(sql);await f.db.exec(sql);assert.deepEqual(await snapshot(f),before);
 for(const user of [pm,{id:'demo-president'}]){await assert.rejects(listAdminPlanBatches(f.pool,user,{project_id:'demo-com',month:'2026-11'}),e=>e.status===403);await assert.rejects(undo(f,saved,user),e=>e.status===403);}
 for(const fn of ['save_admin_monthly_plans_before_withdrawal(uuid,jsonb)','save_admin_monthly_plan_bundle_before_withdrawal(uuid,jsonb,jsonb)','admin_monthly_batch(text,uuid)'])assert.equal((await f.admin.query('SELECT has_function_privilege($1,$2,$3) allowed',['app_runtime','app_private.'+fn,'EXECUTE'])).rows[0].allowed,false);
 await assert.rejects(withIdentity(f.pool,ops.id,c=>c.query('SELECT * FROM app_private.admin_monthly_batch_withdrawals')),e=>e.code==='42501');
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);await assert.rejects(undo(f,saved),e=>e.status===403);assert.deepEqual((await history(f)).batches[0].can_withdraw,false);
});
