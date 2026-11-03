import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {executeDatabase,withIdentity} from '../server/database.mjs';
import {confirmMonthlyPlan,listMonthlyPlans,withdrawMonthlyPlan} from '../server/monthly-plans.mjs';
import {getAdminPlanContext,previewAdminPlanRows,saveAdminMonthlyPlans,assertAdminPlanOperator,matchAdminPlanTarget} from '../server/admin-monthly-plans.mjs';
import {previewCompletion,requestCompletion} from '../server/completions.mjs';
import {loadPlanningAIFacts,assertPlanningAIFactAccess} from '../server/planning-ai-data.mjs';
import {planProfession,workbookProfessionHint,suggestPlanProfession} from '../server/plan-professions.mjs';
import {RESIDENTIAL_DISCIPLINES,residentialDisciplinesForProject} from '../server/report-lines.mjs';

const ops={id:'demo-ops'},pm={id:'demo-pm-com'},peer={id:'admin-plan-peer'},line='土建工程（东地块）';
const item={source_id:'original-item',mod:'工程',name:'正式月度计划',due:'2026-11-25'};
async function fixture(t,{through=33}={}) {
  const db=await initializedDatabase({through});t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line,discipline) VALUES($1,'匿名同专业提报人','pm','approved','demo-com',$2,'工程')",[peer.id,line]);
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[peer.id]);
  return {db,admin,pool};
}
const plan=(extra={})=>({project_id:'demo-com',report_scope_id:null,line,owner_id:pm.id,month:'2026-11',items:[item],expected_plan_id:null,...extra});
const save=(f,plans,operation_id=randomUUID())=>saveAdminMonthlyPlans(f.pool,ops,{operation_id,plans});
const linked=p=>({monthly_plan_id:p.id,monthly_plan_month:'2026-11',items:p.items.map(i=>({...i,prog:'进展',blocker:''}))});
const report=(f,user,p,period='2026-11-02')=>executeDatabase(f.pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:p.project_id,line:p.line,period,biz:linked(p)}});
const denied=e=>e.status===403;

test('深圳良安田待分配专业仅在本项目目录识别，保留原事项与计划且不能无授权保存',async t=>{
 assert.equal(RESIDENTIAL_DISCIPLINES.length,9);assert.equal(residentialDisciplinesForProject('szzz').at(-1),'良安田项目');assert.equal(residentialDisciplinesForProject('szgy').length,10);
 assert.equal(residentialDisciplinesForProject('zhx1'),RESIDENTIAL_DISCIPLINES);assert.equal(planProfession('良安田项目','res','zhx1'),null);assert.equal(planProfession('良安田项目','res','szzz').line,'良安田项目');
 assert.deepEqual(planProfession('良安田','res','szzz'),{line:'良安田项目',basis:'alias'});assert.equal(planProfession('良安田','res','szgy').line,'良安田项目');
 for(const [type,pid]of [['res','zhx1'],['res',undefined],['com','szzz']])assert.equal(planProfession('良安田',type,pid),null);
 const f=await fixture(t),scope='shenzhen-shangmugu-residential',owner='demo-pm-res';
 for(const pid of ['szzz','szgy']){
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,'res')",[pid,'匿名深圳'+pid]);
  await f.admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[owner,pid]);
 }
 await f.admin.query("INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week,reporting_mode) VALUES($1,'匿名深圳','szzz',ARRAY['szzz','szgy'],'2026-10-26','professional')",[scope]);
 const original=(await save(f,[plan({project_id:'szzz',report_scope_id:scope,line:'工程',owner_id:owner})])).plans[0];
 const capture=async()=>(await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,project_id) FROM public.project_members m),'scopes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app_private.report_scopes s)) state")).rows[0].state;
 const before=await capture(),context=await getAdminPlanContext(f.pool,ops,{project_type:'res',month:'2026-11'});
 assert.deepEqual(context.project_professions,[{project_id:'szzz',report_scope_id:scope,line:'良安田项目',assigned:false}]);assert.ok(!context.targets.some(t=>t.line==='良安田项目'));
 assert.deepEqual((await getAdminPlanContext(f.pool,ops,{project_type:'com',month:'2026-11'})).project_professions,[]);
 const raw={mod:'工程',mod_doc:{ops:[{insert:'工程',attributes:{bold:true}}]},name:'良安田原始事项',due:'2026-11-30',line_hint:'工程',source:{sheet:'良安田',row:3,cell:'C3'}},copy=structuredClone(raw);
 const result=await previewAdminPlanRows(f.pool,ops,{project_id:'szzz',report_scope_id:scope,month:'2026-11',rows:[raw]});
 assert.equal(result.rows[0].line,'良安田项目');assert.equal(result.rows[0].owner_id,null);assert.deepEqual(result.rows[0].candidate_targets,[]);assert.equal(result.rows[0].match_status,'unmatched');
 for(const key of ['mod','mod_doc','name','due','source'])assert.deepEqual(result.rows[0][key],raw[key]);assert.deepEqual(raw,copy);assert.deepEqual(result.plans.find(p=>p.id===original.id).items,original.items);
 const other=await previewAdminPlanRows(f.pool,ops,{project_id:'demo-com',month:'2026-11',rows:[{...raw,line_hint:'良安田项目'}]});assert.equal(other.rows[0].line,null);assert.equal(other.rows[0].owner_id,null);
 await assert.rejects(save(f,[plan({project_id:'szzz',report_scope_id:scope,line:'良安田项目',owner_id:owner})]),e=>e.code==='invalid_admin_monthly_plan');
 assert.deepEqual(await capture(),before);
});

test('professional aliases are explicit, type-specific and still require a unique authorized project-profession target',()=>{
 const residential=[{project_type:'res',line:'开发报建',owner_id:'anonymous-developer'}];
 const alias=matchAdminPlanTarget(residential,'开发');assert.equal(alias.owner_id,'anonymous-developer');assert.equal(alias.line,'开发报建');
 assert.deepEqual(alias.profession_mapping,{source_label:'开发',line:'开发报建',basis:'alias',requires_confirmation:false});
 const landscape=[{project_type:'com',line:'景观设计+工程',owner_id:'anonymous-landscape'}];
 assert.equal(matchAdminPlanTarget(landscape,'景观').owner_id,'anonymous-landscape');
 assert.equal(matchAdminPlanTarget(landscape,'景观').profession_mapping.basis,'alias');
 assert.equal(matchAdminPlanTarget([...landscape,{...landscape[0],owner_id:'anonymous-peer'}],'景观').owner_id,null);
 assert.equal(matchAdminPlanTarget(landscape,'土建').line,null);
 assert.equal(matchAdminPlanTarget(landscape,'设计').owner_id,null,'a work category must not pick another professional');
});

test('construction worksheets own their work categories; design summaries only suggest an explicit single profession',()=>{
 for(const [sheet,canonical]of [['土建-东地块','土建工程（东地块）'],['土建—西地块','土建工程（西地块）'],['机电施工','机电工程'],['精装施工','精装工程'],['幕墙施工','幕墙设计+工程']]){
  assert.equal(planProfession(sheet,'com').line,canonical);
  assert.equal(workbookProfessionHint(sheet,'砌体'),sheet);
  const targets=[{project_type:'com',line:canonical,owner_id:'authorized-reporter'}];
  assert.equal(matchAdminPlanTarget(targets,workbookProfessionHint(sheet,'砌体')).owner_id,'authorized-reporter');
 }
 assert.equal(planProfession('土建','com'),null);assert.equal(planProfession('设计部','com').line,'设计部');
 assert.equal(suggestPlanProfession({source:{sheet:'设计部'},name:'建筑与机电图纸'},'com'),null);
 const row=name=>({source:{sheet:'设计管理部'},name,reporter_hint:'任意非系统责任人'});
 for(const [name,expected]of [['室内样板段及招标施工图','精装设计'],['公园景观构筑升级方案','景观设计+工程'],['竖向风系统立管审核及签批','机电设计']]){
  const suggestion=suggestPlanProfession(row(name),'com');assert.equal(suggestion.line,expected);assert.match(suggestion.reason,/确认/);
 }
 assert.equal(suggestPlanProfession(row('更新图（建筑和机电）'),'com'),null);
 assert.equal(suggestPlanProfession({source:{sheet:'招采'},name:'机电设备招采'},'com'),null,'known worksheet profession wins over task keywords');
});

test('031 migration is repeatable and preserves business rows and credentials; admin command grants are bounded',async t=>{
  const f=await fixture(t,{through:30});
  await confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',items:[item]});
  const capture=async()=> (await f.admin.query("SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id) FROM public.profiles p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,project_id) FROM public.project_members m),'auth',(SELECT jsonb_agg(to_jsonb(a) ORDER BY user_id) FROM app_private.auth_users a)) state")).rows[0].state;
  const before=await capture(),sql=await readFile(new URL('../db/031-admin-individual-monthly-plans.sql',import.meta.url),'utf8');
  await f.db.exec(sql);await f.db.exec(sql);assert.deepEqual(await capture(),before);
  assert.deepEqual((await f.admin.query("SELECT has_table_privilege('app_runtime','public.monthly_plans','UPDATE') u,has_table_privilege('app_runtime','public.monthly_plans','DELETE') d,has_table_privilege('app_runtime','app_private.admin_monthly_plan_operations','SELECT') audit_read,has_table_privilege('app_runtime','app_private.admin_monthly_plan_operations','INSERT') audit_write")).rows[0],{u:false,d:false,audit_read:false,audit_write:false});
});

test('admin context requires ops and exposes only actually authorized individual target combinations; no role is granted',async t=>{
  const f=await fixture(t);
  for(const actor of [pm,peer,{id:'demo-pzo'},{id:'demo-president'}]) {
    await assert.rejects(assertAdminPlanOperator(f.pool,actor),denied);
    await assert.rejects(getAdminPlanContext(f.pool,actor,{month:'2026-11'}),denied);
    await assert.rejects(saveAdminMonthlyPlans(f.pool,actor,{operation_id:randomUUID(),plans:[plan()]}),denied);
    await assert.rejects(withIdentity(f.pool,actor.id,c=>c.query('SELECT app_private.save_admin_monthly_plans($1,$2)',[randomUUID(),JSON.stringify([plan()])])),e=>e.code==='42501');
  }
  const context=await getAdminPlanContext(f.pool,ops,{project_type:'com',month:'2026-11'});
  assert.equal(context.targets.filter(p=>p.line===line).length,2);
  assert.ok(context.targets.every(p=>p.project_type==='com' && p.report_scope_id===null && p.line!=='*'));
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1",[peer.id]);
  assert.ok(!(await getAdminPlanContext(f.pool,ops,{month:'2026-11'})).targets.some(p=>p.owner_id===peer.id));
  await assert.rejects(save(f,[plan({owner_id:peer.id})]),denied);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('manual/import admin saves and employee monthly/weekly flows share the target owner and actual-actor audit',async t=>{
  const f=await fixture(t),result=await save(f,[plan(),plan({owner_id:peer.id,items:[{...item,name:'同专业另一人独立计划'}]})]);
  assert.equal(result.plans.length,2);const first=result.plans.find(p=>p.owner_id===pm.id),second=result.plans.find(p=>p.owner_id===peer.id);
  assert.equal(first.confirmed_by,pm.id);assert.equal(first.confirmed_name,'演示土建负责人');
  assert.equal((await listMonthlyPlans(f.pool,pm,{owner_id:pm.id}))[0].id,first.id);
  assert.equal((await f.admin.query('SELECT actor_id,request,result FROM app_private.admin_monthly_plan_operations')).rows[0].actor_id,ops.id);
  await assert.rejects(confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',items:[item]}),e=>e.status===409);
  const [a]=await report(f,pm,first),[b]=await report(f,peer,second);assert.notEqual(a.id,b.id);assert.equal(a.author_id,pm.id);assert.equal(b.author_id,peer.id);
  const [again]=await report(f,peer,second);assert.equal(again.id,b.id);assert.equal(again.history.length,1);
  await assert.rejects(report(f,peer,first),e=>e.status===409);
  await assert.rejects(withIdentity(f.pool,ops.id,c=>c.query('INSERT INTO public.monthly_plans(id,project_id,line,plan_month,items,confirmed_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),'demo-com',line,'2026-12-01',JSON.stringify([item]),pm.id])),e=>e.code==='42501');
});

test('unused correction is atomic, retains the original snapshot and rejects stale expectations; referenced current/history plans hard lock',async t=>{
  const f=await fixture(t),first=(await save(f,[plan()])).plans[0];
  const corrected=(await save(f,[plan({expected_plan_id:first.id,items:[{...item,name:'修正计划'}]})])).plans[0];
  assert.notEqual(corrected.id,first.id);
  assert.equal((await f.admin.query('SELECT snapshot,withdrawn_by FROM app_private.monthly_plan_withdrawals WHERE plan_id=$1',[first.id])).rows[0].withdrawn_by,ops.id);
  await assert.rejects(save(f,[plan({expected_plan_id:first.id})]),e=>e.status===409 && e.code==='monthly_plan_changed');
  await report(f,pm,corrected);
  await assert.rejects(save(f,[plan({expected_plan_id:corrected.id})]),e=>e.status===409 && e.code==='monthly_plan_in_use');
  const context=await getAdminPlanContext(f.pool,ops,{month:'2026-11'});assert.equal(context.plans[0].editable,false);
  const historyPlan=(await save(f,[plan({owner_id:peer.id})])).plans[0];
  await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,biz,history) VALUES('demo-com','2026-12-01',$1,$2,'{}',$3)",[line,peer.id,JSON.stringify([{data:{biz:{monthly_plan_ids:[historyPlan.id]}}}])]);
  await assert.rejects(save(f,[plan({owner_id:peer.id,expected_plan_id:historyPlan.id})]),e=>e.status===409 && e.code==='monthly_plan_in_use');
});

test('batch failure rolls back all replacements and audit; operation identity replays exactly once and rejects changed body',async t=>{
  const f=await fixture(t),operation=randomUUID(),body=plan({items:[{mod:'土建',name:'无标识导入事项',due:''}]});
  const result=await save(f,[body],operation),retry=await save(f,[body],operation);
  assert.equal(retry.replayed,true);assert.deepEqual(retry.plans,result.plans);
  await assert.rejects(save(f,[{...body,items:[item]}],operation),e=>e.status===409 && e.code==='monthly_plan_operation_conflict');
  const original=result.plans[0];
  await assert.rejects(save(f,[plan({expected_plan_id:original.id}),plan({owner_id:peer.id,expected_plan_id:randomUUID()})]),e=>e.status===409);
  assert.equal((await listMonthlyPlans(f.pool,pm,{owner_id:pm.id}))[0].id,original.id);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.admin_monthly_plan_operations')).rows[0].n,1);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.monthly_plan_withdrawals')).rows[0].n,0);
});

test('preview ignores work-responsible names and requires an explicit reporter for same-profession peers',async t=>{
  const f=await fixture(t),base={project_id:'demo-com',month:'2026-11'};
  const preview=await previewAdminPlanRows(f.pool,ops,{...base,rows:[{mod:'土建',name:'预览事项',due:'',line_hint:line},{name:'指定事项',line_hint:line,reporter_hint:'演示土建负责人'},{name:'未知负责人',line_hint:line,reporter_hint:'未分配的人'}]});
  assert.ok(preview.rows.every(row=>row.owner_id===null&&row.match_status==='ambiguous'&&row.candidate_targets.length===2));
  assert.equal(preview.rows[1].reporter_hint,'演示土建负责人');assert.equal(preview.rows[2].reporter_hint,'未分配的人');
  assert.ok(preview.rows.every(row=>row.match_basis===''));
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('a unique project-profession reporter matches despite a blank or different work-responsible name, while unknown or ungranted professions stay unresolved',async t=>{
  const f=await fixture(t),cost='admin-plan-res-cost';
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,'匿名成本填报人','pm','approved','demo-res','成本')",[cost]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-res')",[cost]);
  const base={project_id:'demo-res',month:'2026-11'},source={sheet:'工程',row:8,cell:'C8'};
  const preview=await previewAdminPlanRows(f.pool,ops,{...base,rows:[
    {name:'原表主责并非填报人',line_hint:'工程',reporter_hint:'原表现场责任人',source},
    {name:'没有工作主责姓名',line_hint:'工程专业',reporter_hint:'',warnings:[{code:'reporter_missing',message:'负责人为空，需要手动分配'},{code:'due_missing',message:'完成时间为空'}]},
    {name:'另专业同名不能跨专业',line_hint:'工程',reporter_hint:'匿名成本填报人'},
    {name:'未知专业',line_hint:'尚待明确',reporter_hint:'演示住宅经理'},
    {name:'未授权专业',line_hint:'设计',reporter_hint:'演示住宅经理'}]});
  for(const row of preview.rows.slice(0,3)){
    assert.equal(row.owner_id,'demo-pm-res');assert.equal(row.line,'工程');assert.equal(row.match_basis,'project_line_unique');
    assert.equal(row.match_status,'matched');assert.deepEqual(row.candidate_targets.map(t=>t.owner_id),['demo-pm-res']);
  }
  assert.deepEqual(preview.rows[0].source,source);assert.equal(preview.rows[0].reporter_hint,'原表现场责任人');
  assert.match(preview.rows[1].warnings[0].message,/工作责任人为空，仅供参考/);assert.doesNotMatch(preview.rows[1].warnings[0].message,/手动分配/);
  assert.equal(preview.rows[1].warnings[1].code,'due_missing');
  assert.equal(preview.rows[3].owner_id,null);assert.equal(preview.rows[3].line,null);assert.equal(preview.rows[3].match_status,'unmatched');
  assert.equal(preview.rows[4].owner_id,null);assert.equal(preview.rows[4].line,'设计');assert.deepEqual(preview.rows[4].candidate_targets,[]);
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('direct Excel preview suggests design professions as a group without assigning by responsibility names or saving',async t=>{
 const f=await fixture(t),owner='anonymous-direct-design',design='精装设计';
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'匿名精装填报人','pm','approved','demo-com',$2)",[owner,design]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[owner]);
 const source={sheet:'设计管理部',row:8,cell:'C8'},before=(await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n;
 const preview=await previewAdminPlanRows(f.pool,ops,{project_id:'demo-com',month:'2026-11',rows:[
  {name:'室内样板段及招标施工图',line_hint:'设计管理部',source,reporter_hint:'原工作责任人',due:'',due_note:'1、2026/11/10；2、2026/11/20；'},
  {name:'更新图（建筑和机电）',line_hint:'设计管理部',source:{...source,row:9,cell:'C9'},reporter_hint:'匿名精装填报人'}]});
 const [suggested,mixed]=preview.rows;
 assert.equal(suggested.line,null);assert.equal(suggested.owner_id,null);assert.equal(suggested.profession_suggestion.line,design);
 assert.equal(suggested.profession_suggestion.owner_id,owner);assert.equal(suggested.profession_suggestion.requires_confirmation,true);
 assert.equal(suggested.due_note,'1、2026/11/10；2、2026/11/20；');assert.deepEqual(suggested.source,source);
 assert.equal(mixed.profession_suggestion,null);assert.equal(mixed.owner_id,null);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,before);
});

test('an employee can withdraw an unused administrator-assisted confirmation as its original logical owner',async t=>{
  const f=await fixture(t),saved=(await save(f,[plan(),plan({owner_id:peer.id})])).plans;
  const mine=saved.find(p=>p.owner_id===pm.id),other=saved.find(p=>p.owner_id===peer.id);
  await withdrawMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',expected_plan_id:mine.id});
  assert.equal((await listMonthlyPlans(f.pool,pm,{owner_id:peer.id}))[0].id,other.id);
  // Other people's active plans do not break a retry of my own withdrawal.
  await withdrawMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',expected_plan_id:mine.id});
});

test('normal employee confirmation and administrator confirmation share personal uniqueness without changing employee permissions',async t=>{
  const f=await fixture(t),own=await confirmMonthlyPlan(f.pool,pm,{project_id:'demo-com',line,month:'2026-11',items:[item]});
  const other=(await save(f,[plan({owner_id:peer.id})])).plans[0];
  assert.equal(own.owner_id,pm.id);assert.equal(other.owner_id,peer.id);
  const context=await getAdminPlanContext(f.pool,ops,{project_type:'com',month:'2026-11'});
  assert.equal(context.plans.length,2);assert.ok(context.plans.every(p=>p.editable));
  await assert.rejects(save(f,[plan({expected_plan_id:own.id,owner_id:peer.id})]),e=>e.status===409);
});

test('completion/extension source locks administrator corrections and leaves original application, owner and plan intact',async t=>{
  const f=await fixture(t),p=(await save(f,[plan()])).plans[0],source_key='monthly:'+p.project_id+':'+p.id+':'+p.items[0].source_id;
  const preview=await previewCompletion(f.pool,pm,{source_key});
  const application=await requestCompletion(f.pool,pm,{source_key,source_version:preview.source_version,request_type:'extension',requested_due:'2026-11-30',completion_note:'待正式材料到货'});
  await assert.rejects(save(f,[plan({expected_plan_id:p.id,items:[{...item,name:'不得覆盖'}]})]),e=>e.status===409 && e.code==='monthly_plan_in_use');
  assert.equal((await listMonthlyPlans(f.pool,pm,{owner_id:pm.id}))[0].id,p.id);
  const stored=(await f.admin.query('SELECT owner_id,source_key FROM public.completion_requests WHERE id=$1',[application.id])).rows[0];
  assert.equal(stored.owner_id,pm.id);assert.equal(stored.source_key,source_key);
});

test('merged residential individual plans retain group authorization and same-profession owner isolation through weekly and AI flows',async t=>{
  const f=await fixture(t),members=['zhx1','zhx2','klq'],scope='zhenghongxu-residential',a={id:'admin-res-engineer-a'},b={id:'admin-res-engineer-b'},partial={id:'admin-res-partial'};
  for(const pid of members) await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,'res')",[pid,'匿名'+pid]);
  for(const [user,name,granted] of [[a,'匿名工程甲',members],[b,'匿名工程乙',members],[partial,'匿名不完整授权',members.slice(0,2)]]) {
    await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,discipline) VALUES($1,$2,'pm','approved','zhx1','工程')",[user.id,name]);
    for(const pid of granted) await f.admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[user.id,pid]);
  }
  const base={project_id:'zhx1',report_scope_id:scope,line:'工程',month:'2026-11',items:[{...item,project_id:'klq'}],expected_plan_id:null};
  const context=await getAdminPlanContext(f.pool,ops,{project_type:'res',month:'2026-11'});
  assert.equal(context.targets.filter(v=>v.report_scope_id===scope).length,2);assert.ok(!context.targets.some(v=>v.owner_id===partial.id));
  const ownConfirmed=await confirmMonthlyPlan(f.pool,a,{project_id:'zhx1',report_scope_id:scope,line:'工程',month:'2026-12',items:[item]});
  assert.equal(ownConfirmed.owner_id,a.id);assert.deepEqual(ownConfirmed.scope_project_ids,members);
  await assert.rejects(save(f,[{...base,owner_id:partial.id}]),denied);
  const saved=(await save(f,[{...base,owner_id:a.id},{...base,owner_id:b.id,items:[{...item,name:'乙独立工程月计划',project_id:'zhx2'}]}])).plans;
  const pa=saved.find(p=>p.owner_id===a.id),pb=saved.find(p=>p.owner_id===b.id);
  const submit=(user,p)=>executeDatabase(f.pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx1',report_scope_id:scope,line:'工程',period:'2026-11-02',biz:{monthly_plan_ids:[p.id],items:p.items.map(i=>({...i,monthly_plan_id:p.id,prog:'本人的周反馈'}))}}});
  const ra=(await submit(a,pa))[0],rb=(await submit(b,pb))[0];assert.notEqual(ra.id,rb.id);
  await assert.rejects(submit(b,pa),e=>e.status===409);
  const input={project_id:'zhx1',report_scope_id:scope,scope_project_ids:members,line:'工程',period:'2026-11-02'};
  const facts=await loadPlanningAIFacts(f.pool,a,input,{kind:'summary',scope:'current',start:'',end:'',keyword:pa.items[0].name,project_name:'',limit:10});
  assert.ok(facts.items.some(i=>i.what===pa.items[0].name));assert.doesNotMatch(JSON.stringify(facts),/乙独立工程月计划/);await assertPlanningAIFactAccess(f.pool,a,facts);
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[a.id,'klq']);
  await assert.rejects(assertPlanningAIFactAccess(f.pool,a,facts),denied);
  await assert.rejects(save(f,[{...base,owner_id:a.id,expected_plan_id:pa.id}]),denied);
});
