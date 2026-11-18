import test from 'node:test';
import assert from 'node:assert/strict';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {createUser} from '../scripts/create-user.mjs';
import {enableWeeklyCollaboration} from '../scripts/enable-weekly-collaboration.mjs';
import {createWeeklyCollaboration} from '../server/weekly-collaboration.mjs';
import {executeDatabase} from '../server/database.mjs';
import {confirmMonthlyPlan} from '../server/monthly-plans.mjs';

const ops={id:'demo-ops'},lead={id:'anonymous-weekly-lead'},scope={project_id:'demo-com',line:'土建工程（东地块）',report_scope_id:null};
const config={kind:'role-derived-weekly-collaboration-bindings',operator_id:ops.id,first_week:'2026-11-09',bindings:[{...scope,submitter_id:lead.id}]};
async function fixture(t){
 const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);
 await createUser(admin,{userId:lead.id,name:'匿名负责人',email:'weekly.lead@example.invalid',password:'anonymous-password',role:'pm',projects:['demo-com'],line:scope.line});
 return {admin,pool,service:createWeeklyCollaboration(pool)};
}
test('current Shanghai week enables once, repeated runs keep receipts, and the next week opens automatically',async t=>{
 const f=await fixture(t);
 let result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-12'});
 assert.equal(result.week,'2026-11-09');assert.equal(result.enabled,1,JSON.stringify(result));assert.equal(result.blocked,0);
 assert.equal(result.records[0].status,'ready');
 result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-15'});assert.equal(result.preserved,1);assert.equal(result.enabled,0);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM app_private.weekly_collaboration_operations')).rows[0].n,1);
 result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-16'});assert.equal(result.week,'2026-11-16');assert.equal(result.enabled,1);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM app_private.weekly_collaboration_operations')).rows[0].n,2);
});
test('a manually designated week and existing edit history are never reassigned by the recurring job',async t=>{
 const f=await fixture(t),peer={id:'anonymous-peer'};
 await createUser(f.admin,{userId:peer.id,name:'匿名协作者',email:'peer@example.invalid',password:'anonymous-password',role:'pm',projects:['demo-com'],line:scope.line});
 await f.service.settings(ops,{...scope,week:'2026-11-09',submitter_id:peer.id,member_ids:[lead.id]});
 const before=(await f.admin.query('SELECT to_jsonb(d) AS row FROM app_private.weekly_collaboration_drafts d')).rows;
 const result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-12'});assert.equal(result.preserved,1);assert.equal(result.records[0].submitter_id,peer.id);
 assert.deepEqual((await f.admin.query('SELECT to_jsonb(d) AS row FROM app_private.weekly_collaboration_drafts d')).rows,before);
 const next=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-16'});
 assert.equal(next.records[0].submitter_id,peer.id);
 const carried=await f.service.settings(ops,{...scope,week:'2026-11-16'});
 assert.deepEqual(carried.member_ids,[lead.id]);
});
test('revoked owner, wrong project and unauthorized operator cannot create a room or widen permissions',async t=>{
 const f=await fixture(t);
 await f.admin.query('UPDATE app_private.auth_users SET disabled=true WHERE user_id=$1',[lead.id]);
 const result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-12'});assert.equal(result.blocked,1);assert.equal(result.records[0].status,403);
 const denied=await enableWeeklyCollaboration(f.pool,{...config,operator_id:'demo-pm-res'},{today:'2026-11-12'});assert.equal(denied.blocked,1);
 const cross=await enableWeeklyCollaboration(f.pool,{...config,bindings:[{project_id:'demo-res',line:'工程',submitter_id:lead.id}]},{today:'2026-11-12'});assert.equal(cross.blocked,1);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM app_private.weekly_collaboration_drafts')).rows[0].n,0);
});
test('existing personal reports remain intact and collaboration starts next week without replacing them',async t=>{
 const f=await fixture(t),plan=await confirmMonthlyPlan(f.pool,lead,{project_id:scope.project_id,line:scope.line,month:'2026-11',items:[{source_id:'existing',name:'原业务事项',mod:'工程',due:'2026-11-30'}]});
 await executeDatabase(f.pool,lead,{table:'reports',operation:'upsert',onConflict:'project_id,period,line,author_id',values:{project_id:scope.project_id,line:scope.line,period:'2026-11-09',biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-11',items:plan.items}}});
 const before=(await f.admin.query('SELECT to_jsonb(r) AS row FROM public.reports r')).rows;
 const result=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-12'});assert.equal(result.enabled,1);assert.equal(result.records[0].week,'2026-11-16');assert.equal(result.records[0].deferred_from_week,'2026-11-09');
 assert.deepEqual((await f.admin.query('SELECT to_jsonb(r) AS row FROM public.reports r')).rows,before);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM app_private.weekly_collaboration_drafts')).rows[0].n,1);
 const again=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-12'});assert.equal(again.preserved,1);
 const next=await enableWeeklyCollaboration(f.pool,config,{today:'2026-11-16'});assert.equal(next.preserved,1);
});
test('malformed or duplicate bindings fail before any writes',async t=>{
 const f=await fixture(t);
 await assert.rejects(enableWeeklyCollaboration(f.pool,{...config,bindings:[...config.bindings,...config.bindings]},{today:'2026-11-12'}),/Duplicate/);
 await assert.rejects(enableWeeklyCollaboration(f.pool,config,{today:'2026-11-01'}),/precedes/);
 assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM app_private.weekly_collaboration_drafts')).rows[0].n,0);
});
