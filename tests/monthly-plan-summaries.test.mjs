import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {withIdentity,executeDatabase} from '../server/database.mjs';
import {saveAdminMonthlyPlans,getAdminPlanContext,previewAdminPlanRows} from '../server/admin-monthly-plans.mjs';
import {listMonthlyPlanSummaries} from '../server/monthly-plan-summaries.mjs';

const ops={id:'demo-ops'},pm={id:'demo-pm-com'},line='土建工程（东地块）';
const fixed={source_id:'source-one',mod:'工程',name:'原计划事项',due:'2026-11-30'};
const plan=extra=>({project_id:'demo-com',line,owner_id:pm.id,month:'2026-11',items:[fixed],expected_plan_id:null,...extra});
const summary=extra=>({project_id:'demo-com',line,owner_id:pm.id,month:'2026-11',items:[{...fixed,progress:'原表文字：本月完成部分；不代表审核完成'}],expected_summary_id:null,...extra});
async function fixture(t){const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);return {db,admin,pool};}
const save=(f,plans,summaries,operation_id=randomUUID())=>saveAdminMonthlyPlans(f.pool,ops,{operation_id,plans,summaries});
const unchanged=async f=>(await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'requests',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.completion_requests c),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,project_id) FROM public.project_members m),'auth',(SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id) FROM app_private.auth_users a)) state")).rows[0].state;

test('033 is repeatable and only adds independent summaries with SELECT/RLS and bounded audited RPC grants',async t=>{
 const f=await fixture(t),before=await unchanged(f),saved=await save(f,[],[summary()]);
 const schema=await readFile(new URL('../db/033-monthly-plan-summaries.sql',import.meta.url),'utf8');
 await f.admin.query('RESET ROLE');await f.db.exec(schema);await f.db.exec(schema);
 assert.deepEqual(await unchanged(f),before);assert.equal((await listMonthlyPlanSummaries(f.pool,ops,{month:'2026-11'}))[0].id,saved.summaries[0].id);
 const grants=(await f.admin.query("SELECT has_table_privilege('app_runtime','public.monthly_plan_summaries','SELECT') r,has_table_privilege('app_runtime','public.monthly_plan_summaries','INSERT') i,has_table_privilege('app_runtime','public.monthly_plan_summaries','UPDATE') u,has_table_privilege('app_runtime','public.monthly_plan_summaries','DELETE') d,has_table_privilege('app_runtime','app_private.admin_monthly_summary_operations','SELECT') audit,has_table_privilege('app_runtime','app_private.admin_monthly_bundle_operations','INSERT') audit_write")).rows[0];
 assert.deepEqual(grants,{r:true,i:false,u:false,d:false,audit:false,audit_write:false});
 assert.equal((await f.admin.query("SELECT has_function_privilege('app_runtime','app_private.save_admin_monthly_summaries(uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
 for(const user of [pm,{id:'demo-pm-res'},{id:'demo-president'}])await assert.rejects(saveAdminMonthlyPlans(f.pool,user,{operation_id:randomUUID(),plans:[],summaries:[summary()]}),error=>error.status===403);
 await assert.rejects(withIdentity(f.pool,pm.id,c=>c.query('SELECT app_private.save_admin_monthly_summaries($1,$2::jsonb)',[randomUUID(),JSON.stringify([summary()])])),error=>error.code==='42501');
 await assert.rejects(withIdentity(f.pool,ops.id,c=>c.query('SELECT app_private.save_admin_monthly_summaries($1,$2::jsonb)',[randomUUID(),JSON.stringify([summary()])])),error=>error.code==='42501','internal helper cannot bypass whole-batch operation identity');
});

test('one batch stores two plan months and independent source results without fabricating a weekly report or approval',async t=>{
 const f=await fixture(t),before=await unchanged(f);
 const result=await save(f,[plan({month:'2026-10'}),plan()],[summary({month:'2026-10'}),summary()]);
 assert.equal(result.plans.length,2);assert.equal(result.summaries.length,2);assert.equal(result.replayed,false);
 const row=result.summaries.find(row=>row.month==='2026-10');assert.equal(row.owner_id,pm.id);assert.equal(row.owner_name,'演示土建负责人');assert.equal(row.version,1);assert.equal(row.report_scope_id,null);assert.equal(row.scope_project_ids,null);
 assert.equal(row.items[0].progress,summary().items[0].progress);assert.ok(!Object.hasOwn(row,'status'));
 assert.deepEqual(await unchanged(f),before);
 assert.equal((await listMonthlyPlanSummaries(f.pool,pm,{month:'2026-10'})).length,1);
 assert.deepEqual(await listMonthlyPlanSummaries(f.pool,{id:'demo-pm-res'},{month:'2026-10'}),[]);
 assert.equal((await listMonthlyPlanSummaries(f.pool,{id:'demo-president'},{month:'2026-10'})).length,1);
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES('summary-viewer','匿名管理查看','viewer','approved')");
 assert.deepEqual((await withIdentity(f.pool,'summary-viewer',c=>c.query('SELECT id FROM public.monthly_plan_summaries'))).rows,[]);
 assert.equal((await listMonthlyPlanSummaries(f.pool,{id:'summary-viewer'},{month:'2026-10'})).length,1);
 assert.deepEqual((await withIdentity(f.pool,'summary-viewer',c=>c.query('SELECT id FROM public.monthly_plan_summaries'))).rows,[],'management capability remains transaction-local');
 await f.admin.query("UPDATE public.profiles SET management_viewer=true WHERE user_id='demo-pm-res'");
 assert.equal((await listMonthlyPlanSummaries(f.pool,{id:'demo-pm-res'},{month:'2026-10'})).length,1);
 assert.deepEqual((await withIdentity(f.pool,'demo-pm-res',c=>c.query('SELECT id FROM public.monthly_plan_summaries'))).rows,[]);
 await assert.rejects(saveAdminMonthlyPlans(f.pool,{id:'summary-viewer'},{operation_id:randomUUID(),plans:[],summaries:[summary()]}),error=>error.status===403);
 const context=await getAdminPlanContext(f.pool,ops,{month:'2026-10',project_type:'com'});assert.equal(context.summaries[0].id,row.id);
 const preview=await previewAdminPlanRows(f.pool,ops,{project_id:'demo-com',month:'2026-10',rows:[]});assert.equal(preview.summaries[0].id,row.id);
 await assert.rejects(save(f,[],[summary({items:[{...summary().items[0],status:'approved'}]})]),error=>error.status===400);
 await assert.rejects(save(f,[],[summary({owner_name:'客户端伪造姓名'})]),error=>error.status===400);
 await assert.rejects(listMonthlyPlanSummaries(f.pool,ops,{month:'2026-11',project_id:'demo-com'}),error=>error.status===400);
});

test('summary UUID CAS and complete-batch idempotency reject changed-body replay, concurrent edits and revoked ownership',async t=>{
 const f=await fixture(t),operation=randomUUID(),body=[summary()];
 const first=await save(f,[],body,operation),replay=await save(f,[],body,operation);assert.equal(replay.replayed,true);assert.equal(replay.summaries[0].id,first.summaries[0].id);
 await assert.rejects(save(f,[plan({month:'2026-12'})],body,operation),error=>error.code==='monthly_summary_operation_conflict');
 const id=first.summaries[0].id,next=summary({expected_summary_id:id,items:[{...fixed,progress:'管理员核对原表后的修正'}]});
 const replaced=await save(f,[],[next]);assert.notEqual(replaced.summaries[0].id,id);assert.equal(replaced.summaries[0].version,2);
 await assert.rejects(save(f,[],[next]),error=>error.code==='monthly_summary_changed');
 assert.equal((await listMonthlyPlanSummaries(f.pool,ops,{month:'2026-11'}))[0].id,replaced.summaries[0].id);
 const audit=(await f.admin.query('SELECT before_summaries FROM app_private.admin_monthly_summary_operations WHERE result @> $1::jsonb',[JSON.stringify({summaries:[{id:replaced.summaries[0].id}]})])).rows[0];assert.equal(audit.before_summaries[0].id,id);
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);
 await assert.rejects(save(f,[],body,operation),error=>error.status===403);
 assert.deepEqual(await listMonthlyPlanSummaries(f.pool,pm,{month:'2026-11'}),[]);
});

test('referenced fixed plans remain unchanged while summaries can save independently; a later CAS failure rolls the whole plan/results batch back',async t=>{
 const f=await fixture(t),original=(await save(f,[plan()],[])).plans[0];
 await executeDatabase(f.pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'demo-com',line,period:'2026-11-02',biz:{monthly_plan_id:original.id,monthly_plan_month:'2026-11',items:original.items.map(item=>({...item,prog:'已有真实周反馈',blocker:''}))}}});
 const before=await unchanged(f),saved=await save(f,[],[summary()]);assert.equal(saved.plans.length,0);assert.equal(saved.summaries.length,1);assert.deepEqual(await unchanged(f),before);
 const originalAfter=(await f.admin.query('SELECT id,items FROM public.monthly_plans WHERE id=$1',[original.id])).rows[0];assert.deepEqual(originalAfter.items,original.items);
 const count=async()=>(await f.admin.query("SELECT jsonb_build_object('plans',(SELECT count(*) FROM public.monthly_plans),'summaries',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.monthly_plan_summaries s),'plan_audit',(SELECT count(*) FROM app_private.admin_monthly_plan_operations),'summary_audit',(SELECT count(*) FROM app_private.admin_monthly_summary_operations),'bundle_audit',(SELECT count(*) FROM app_private.admin_monthly_bundle_operations)) state")).rows[0].state;
 const snapshot=await count();
 await assert.rejects(save(f,[plan({month:'2026-12'})],[summary({expected_summary_id:randomUUID()})]),error=>error.code==='monthly_summary_changed');assert.deepEqual(await count(),snapshot);assert.deepEqual(await unchanged(f),before);
 await assert.rejects(save(f,[plan({expected_plan_id:original.id})],[summary({expected_summary_id:saved.summaries[0].id})]),error=>error.code==='monthly_plan_in_use');assert.deepEqual(await count(),snapshot);
});

test('residential summaries retain the complete unified scope and month activation; partial memberships cannot save or read',async t=>{
 const f=await fixture(t),members=['zhx1','zhx2','klq'],owner={id:'summary-res-owner'};
 for(const pid of members)await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,'res')",[pid,'匿名'+pid]);
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES($1,'匿名住宅工程','pm','approved','工程')",[owner.id]);
 for(const pid of members)await f.admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[owner.id,pid]);
 const value=summary({project_id:'zhx1',report_scope_id:'zhenghongxu-residential',owner_id:owner.id,line:'工程'});
 const row=(await save(f,[],[value])).summaries[0];assert.deepEqual(row.scope_project_ids,members);assert.equal((await listMonthlyPlanSummaries(f.pool,owner,{month:'2026-11'})).length,1);
 await assert.rejects(save(f,[],[{...value,month:'2026-09'}]),error=>error.status===403);
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='klq'",[owner.id]);
 await assert.rejects(save(f,[],[{...value,expected_summary_id:row.id}]),error=>error.status===403);assert.deepEqual(await listMonthlyPlanSummaries(f.pool,owner,{month:'2026-11'}),[]);
});
