import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {BUSINESS_MODULES,businessModulesForProject,canUseBusinessModule,resolveWritableBusinessLine} from '../server/commercial-modules.mjs';
import {executeDatabase,withIdentity,getProfile} from '../server/database.mjs';
import {listCommercialModuleGrants,saveCommercialModuleGrant} from '../server/commercial-module-grants.mjs';
import {confirmMonthlyPlan,listMonthlyPlans,withdrawMonthlyPlan} from '../server/monthly-plans.mjs';
import {getAdminPlanContext,previewAdminPlanRows,saveAdminMonthlyPlans} from '../server/admin-monthly-plans.mjs';
import {parseAdminPlanImport,parseAdminPlanEvidence} from '../server/admin-plan-import.mjs';
import {startAdminPlanAI,closeAdminPlanAI} from '../server/admin-plan-ai.mjs';
import {authorizePlanningAI} from '../server/planning-ai-scope.mjs';
import {loadPlanningAIFacts} from '../server/planning-ai-data.mjs';
import {loadPlanningAIMemory,savePlanningAIPreference} from '../server/planning-ai-memory.mjs';
import {uploadReportAttachment} from '../server/report-attachments.mjs';
import {previewCompletion,requestCompletion,reviewCompletion} from '../server/completions.mjs';
import {createCoordinationTask} from '../server/coordination-tasks.mjs';
import {makeAdminPlanWorkbook as workbook,adminPlanSheet as sheet,adminPlanRow as row,adminPlanInline as cell,adminPlanHeaders as headers,adminPlanTitle as title} from './helpers/admin-plan-workbook.mjs';

const ops={id:'demo-ops'},designer={id:'design-fixed'},wild={id:'design-wild'},architect={id:'design-architect'},line='设计部';
const item={source_id:'design-one',mod:'图纸',name:'建筑与机电整体更新图',due:'2026-11-25'};
const denied=error=>[400,403].includes(error.status);
async function fixture(t,{through=33}={}){
 const db=await initializedDatabase({through}),beforeClose=[];t.after(async()=>{for(const close of beforeClose)await close();await db.close();});const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);
 await admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('hf','匿名弘坊范围','com')");
 for(const [id,biz]of [[designer.id,line],[wild.id,'*'],[architect.id,'建筑结构设计'],['design-electrical','机电设计'],['design-interior','精装设计'],['design-unassigned',null],['design-outsider',line]]){
  await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,disabled) VALUES($1,$2,$3,false)',[id,id+'@example.invalid','isolated-unused-auth-value']);
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,biz_line) VALUES($1,$2,'pm','approved',$3)",[id,'匿名'+id,biz]);
  if(id!=='design-outsider')await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'hf')",[id]);
  if([designer.id,wild.id,'design-outsider'].includes(id))await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[id]);
 }
 return {db,admin,pool,beforeClose};
}
async function temporary(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'planning-design-scope-'));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('planning-design-scope-'));await rm(directory,{recursive:true,force:true});});return directory;
}
const report=(f,user,pid,module,extra={})=>executeDatabase(f.pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:pid,period:'2026-11-02',line:module,...extra}});
const plan=(owner=designer.id,extra={})=>({project_id:'hf',line,owner_id:owner,month:'2026-11',items:[item],expected_plan_id:null,...extra});
const save=(f,plans)=>saveAdminMonthlyPlans(f.pool,ops,{operation_id:randomUUID(),plans});
const functions=async f=>(await f.admin.query("SELECT oid,proname,proowner,proacl::text,prosecdef,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['app_private.can_write_report(text,text,text)'::regprocedure,'app_private.can_assign_monthly_plan(text,text,text,text)'::regprocedure]) ORDER BY oid")).rows;
const snapshot=async f=>(await f.admin.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.profiles t),'projects',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.projects t),'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,user_id) FROM public.project_members t),'reports',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.reports t),'plans',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.monthly_plans t),'requests',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.completion_requests t)) value")).rows[0].value;
function sourceBook(){return workbook([{name:line,xml:sheet([title(1),headers(2),
 row(3,[cell('A3','机电调整'),cell('C3','建筑与机电整体更新图'),cell('D3','统一会签'),cell('E3','2026-11-25'),cell('H3','原工作责任人')]),
 row(4,[cell('A4','精装图纸'),cell('C4','室内样板图更新'),cell('E4','2026-11-26')])])}]);}

test('design department is a canonical module only in hf while legacy modules and explicit wildcard semantics stay unchanged',()=>{
 assert.equal(BUSINESS_MODULES.length,13);assert.equal(businessModulesForProject('hf').length,13);assert.equal(businessModulesForProject('demo-com').length,12);assert.equal(businessModulesForProject().length,12);
 for(const profile of [{biz_line:line},{biz_line:'*'}]){
  assert.equal(canUseBusinessModule(profile,line,'hf'),true);assert.equal(resolveWritableBusinessLine(profile,line,'hf'),line);
  for(const pid of ['demo-com','other',undefined])assert.equal(canUseBusinessModule(profile,line,pid),false);
 }
 for(const biz_line of ['建筑结构设计','机电设计','精装设计',null])assert.equal(canUseBusinessModule({biz_line},line,'hf'),false);
 for(const module of businessModulesForProject('demo-com'))assert.equal(canUseBusinessModule({biz_line:'*'},module,'demo-com'),true);
});

test('032 migration is repeatable and preserves existing data, profiles, memberships, helper identities and ACLs',async t=>{
 const f=await fixture(t,{through:31});await report(f,{id:'demo-pm-com'},'demo-com','土建工程（东地块）',{change_text:'原专业周报'});
 await confirmMonthlyPlan(f.pool,{id:'demo-pm-com'},{project_id:'demo-com',line:'土建工程（东地块）',month:'2026-12',items:[{...item,name:'原专业月计划'}]});
 const before=await snapshot(f),metadata=await functions(f),sql=await readFile(new URL('../db/032-hongfang-design-department.sql',import.meta.url),'utf8');
 await f.db.exec(sql);await f.db.exec(sql);assert.deepEqual(await snapshot(f),before);assert.deepEqual(await functions(f),metadata);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.commercial_module_grants')).rows[0].n,0,'migration does not assign any person or rewrite a primary module');
 assert.deepEqual((await f.admin.query("SELECT has_table_privilege('app_runtime','public.commercial_module_grants','SELECT') r,has_table_privilege('app_runtime','public.commercial_module_grants','INSERT') i,has_table_privilege('app_runtime','public.commercial_module_grants','DELETE') d")).rows[0],{r:true,i:false,d:false});
});

test('an explicit hf extra design grant preserves architecture primary and its history, supports both modules end to end, and revokes only the additional permission',async t=>{
 const f=await fixture(t),primary='建筑结构设计',request={user_id:architect.id,project_id:'hf',line,enabled:true};
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[architect.id]);
 const original=(await f.admin.query('SELECT to_jsonb(p) value FROM public.profiles p WHERE user_id=$1',[architect.id])).rows[0].value;
 const write=(pid,module)=>withIdentity(f.pool,architect.id,async c=>(await c.query('SELECT app_private.can_write_report($1,$2,$3) allowed',[pid,module,architect.id])).rows[0].allowed);
 assert.equal(await write('hf',primary),true);assert.equal(await write('hf',line),false);assert.deepEqual(await listCommercialModuleGrants(f.pool,architect),[]);
 for(const actor of [architect,designer])await assert.rejects(saveCommercialModuleGrant(f.pool,actor,request),error=>error.status===403);
 await assert.rejects(saveCommercialModuleGrant(f.pool,ops,{...request,user_id:'design-outsider'}),error=>error.status===403);
 await assert.rejects(saveCommercialModuleGrant(f.pool,ops,{...request,user_id:wild.id}),error=>error.status===400);
 await assert.rejects(saveCommercialModuleGrant(f.pool,ops,{...request,project_id:'demo-com'}),error=>error.status===400);
 assert.deepEqual(await saveCommercialModuleGrant(f.pool,ops,request),request);
 const grantBefore=(await f.admin.query('SELECT to_jsonb(g) value FROM public.commercial_module_grants g')).rows[0].value;
 await saveCommercialModuleGrant(f.pool,ops,request);assert.deepEqual((await f.admin.query('SELECT to_jsonb(g) value FROM public.commercial_module_grants g')).rows[0].value,grantBefore,'idempotent grant retains actor/time');
 assert.deepEqual((await f.admin.query('SELECT to_jsonb(p) value FROM public.profiles p WHERE user_id=$1',[architect.id])).rows[0].value,original);
 assert.deepEqual(await listCommercialModuleGrants(f.pool,architect),[{user_id:architect.id,project_id:'hf',line}]);assert.deepEqual(await listCommercialModuleGrants(f.pool,designer),[],'GET only exposes own extras');
 assert.equal((await listCommercialModuleGrants(f.pool,ops)).length,1);
 assert.deepEqual((await withIdentity(f.pool,'demo-pm-com',c=>c.query('SELECT user_id FROM public.commercial_module_grants'))).rows,[],'an unrelated project member cannot read grant metadata');
 const profile=await withIdentity(f.pool,architect.id,c=>getProfile(c,architect.id,{project_id:'hf'}));assert.equal(profile.biz_line,primary);assert.equal(canUseBusinessModule(profile,line,'hf'),true);assert.equal(canUseBusinessModule(profile,line,'demo-com'),false);assert.equal(resolveWritableBusinessLine(profile,undefined,'hf'),primary);
 assert.equal(await write('hf',primary),true);assert.equal(await write('hf',line),true);assert.equal(await write('demo-com',primary),true);assert.equal(await write('demo-com',line),false);
 const context=await getAdminPlanContext(f.pool,ops,{project_type:'com',month:'2026-11'});assert.deepEqual(context.targets.filter(target=>target.project_id==='hf'&&target.owner_id===architect.id).map(target=>target.line).sort(),[primary,line].sort());
 const assisted=await saveAdminMonthlyPlans(f.pool,ops,{operation_id:randomUUID(),plans:[plan(architect.id,{month:'2026-12'})],summaries:[{project_id:'hf',line,owner_id:architect.id,month:'2026-10',items:[{...item,progress:'原表设计部完成情况'}],expected_summary_id:null}]});assert.equal(assisted.plans[0].line,line);assert.equal(assisted.summaries[0].owner_id,architect.id);
 const architecturePlan=await confirmMonthlyPlan(f.pool,architect,{project_id:'hf',line:primary,month:'2026-11',items:[{...item,name:'保留原建筑结构工作'}]});
 const designPlan=await confirmMonthlyPlan(f.pool,architect,{project_id:'hf',line,month:'2026-11',items:[{...item,name:'附加设计部整体会签'}]});
 for(const plan of [architecturePlan,designPlan])await report(f,architect,'hf',plan.line,{biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-11',items:plan.items.map(source=>({...source,prog:'独立本专业反馈',blocker:''}))}});
 assert.equal((await f.admin.query("SELECT count(*)::int n FROM public.reports WHERE project_id='hf' AND author_id=$1",[architect.id])).rows[0].n,2);
 const scope={project_id:'hf',line,period:'2026-11-02'};assert.equal((await authorizePlanningAI(f.pool,architect,scope)).line,line);
 const facts=await loadPlanningAIFacts(f.pool,architect,scope,{kind:'summary',scope:'mine',start:'',end:'',keyword:'',project_name:'',limit:10});assert.deepEqual(facts.projects.find(project=>project.id==='hf').lines.sort(),[primary,line].sort());assert.equal(facts.projects.find(project=>project.id==='demo-com').lines.includes(line),false);
 const directory=await temporary(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');assert.equal((await uploadReportAttachment(f.pool,architect,directory,{...scope,filename:'extra-design.png'},png)).line,line);
 const source_key='monthly:hf:'+designPlan.id+':'+designPlan.items[0].source_id,preview=await previewCompletion(f.pool,architect,{source_key});
 const application=await requestCompletion(f.pool,architect,{source_key,source_version:preview.source_version,completion_date:'2026-11-25',completion_note:'附加专业已完成图纸'});assert.equal((await reviewCompletion(f.pool,ops,{id:application.id,expected_revision:application.revision,decision:'approve',note:''})).status,'approved');
 const task=await createCoordinationTask(f.pool,designer,{id:randomUUID(),project_id:'hf',owner_id:architect.id,what:'请设计部整体会签',due:'2026-11-30'}),coord=await previewCompletion(f.pool,architect,{source_key:task.source_key});
 const requestCoord=await requestCompletion(f.pool,architect,{source_key:task.source_key,source_version:coord.source_version,completion_date:'2026-11-25',completion_note:'已会签'});assert.equal((await reviewCompletion(f.pool,designer,{id:requestCoord.id,expected_revision:requestCoord.revision,decision:'approve',note:''})).status,'approved','non-ops origin reviewer resolves target extra module');
 const preserved=await snapshot(f);await saveCommercialModuleGrant(f.pool,ops,{...request,enabled:false});assert.deepEqual(await snapshot(f),preserved);assert.deepEqual(await listCommercialModuleGrants(f.pool,architect),[]);
 assert.equal(await write('hf',primary),true);assert.equal(await write('demo-com',primary),true);assert.equal(await write('hf',line),false);await assert.rejects(authorizePlanningAI(f.pool,architect,scope),error=>error.status===403);
 await assert.rejects(saveAdminMonthlyPlans(f.pool,ops,{operation_id:randomUUID(),plans:[],summaries:[{project_id:'hf',line,owner_id:architect.id,month:'2026-11',items:[{...item,progress:'撤销附加授权后不得再写'}],expected_summary_id:null}]}),error=>error.status===403);
 assert.equal((await listMonthlyPlans(f.pool,architect,{project_id:'hf'})).length,3,'existing plans remain readable and retained');
});

test('database and API permissions restrict new design writes to hf members and never grant existing design specialties another module',async t=>{
 const f=await fixture(t),write=(user,pid,module)=>withIdentity(f.pool,user.id,async c=>(await c.query('SELECT app_private.can_write_report($1,$2,$3) allowed',[pid,module,user.id])).rows[0].allowed);
 const assigned=(owner,pid,module)=>withIdentity(f.pool,ops.id,async c=>(await c.query('SELECT app_private.can_assign_monthly_plan($1,$2,$3,NULL) allowed',[owner,pid,module])).rows[0].allowed);
 for(const user of [designer,wild]){
  assert.equal(await write(user,'hf',line),true);assert.equal(await assigned(user.id,'hf',line),true);
  assert.equal(await write(user,'demo-com',line),false);assert.equal(await assigned(user.id,'demo-com',line),false);
  await assert.rejects(report(f,user,'demo-com',line),denied);
  const [stored]=await report(f,user,'hf',line,{change_text:'本人专业填报'});assert.equal(stored.line,line);assert.equal(stored.author_id,user.id);
 }
 for(const id of [architect.id,'design-electrical','design-interior','design-unassigned','design-outsider']){
  assert.equal(await write({id},'hf',line),false);assert.equal(await assigned(id,'hf',line),false);await assert.rejects(report(f,{id},'hf',line),denied);
 }
 assert.equal(await write(designer,'demo-res',line),false);assert.equal(await assigned(designer.id,'demo-res',line),false);
 for(const module of businessModulesForProject('demo-com'))assert.equal(await write(wild,'demo-com',module),true);
 await assert.rejects(withIdentity(f.pool,wild.id,c=>c.query("INSERT INTO public.reports(project_id,period,line,author_id) VALUES('demo-com','native-attempt','设计部',$1)",[wild.id])),error=>error.code==='42501');
 const [node]=await executeDatabase(f.pool,ops,{table:'milestones',operation:'insert',values:{project_id:'hf',name:'新设计节点',biz_line:line}});assert.equal(node.biz_line,line);
 await assert.rejects(executeDatabase(f.pool,ops,{table:'milestones',operation:'insert',values:{project_id:'demo-com',name:'跨项目节点不允许',biz_line:line}}),denied);
 await assert.rejects(f.admin.query("INSERT INTO public.milestones(project_id,name,biz_line) VALUES('demo-com','原生约束也拒绝','设计部')"),error=>error.code==='23514');
});

test('whole design worksheet stays one exact profession; administrator import and AI do not split content into existing specialties',async t=>{
 const f=await fixture(t);await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='hf'",[wild.id]);
 const bytes=sourceBook(),parsed=await parseAdminPlanImport(bytes,{month:'2026-11'}),preview=await previewAdminPlanRows(f.pool,ops,{project_id:'hf',month:'2026-11',rows:parsed.rows});
 assert.equal(preview.rows.length,2);for(const row of preview.rows){assert.equal(row.line,line);assert.equal(row.line_hint,line);assert.equal(row.owner_id,designer.id);assert.equal(row.profession_mapping.basis,'exact');assert.equal(row.profession_suggestion,null);}
 const context=await getAdminPlanContext(f.pool,ops,{project_type:'com',month:'2026-11'});assert.ok(context.targets.some(target=>target.project_id==='hf'&&target.line===line&&target.owner_id===designer.id));assert.equal(context.targets.some(target=>target.project_id!=='hf'&&target.line===line),false);
 await assert.rejects(save(f,[plan(architect.id)]),error=>error.status===403);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
 const directory=await temporary(t),configPath=path.join(directory,'anonymous-provider.json');await writeFile(configPath,JSON.stringify({enabled:true,api_key:'sk-'+randomBytes(24).toString('hex'),model:'deepseek-flash'}),{mode:0o600});
 const evidence=(await parseAdminPlanEvidence(bytes,{month:'2026-11'})).evidence,region=evidence.regions[0];
 const options={configPath,sessionKey:randomUUID(),fetchImpl:async(_url,request)=>{
  const payload=JSON.parse(request.body);assert.match(payload.instructions,/设计部.*独立的正式专业/);
  const value={reply:'请核对',complete:true,questions:[],rows:evidence.rows.map(row=>({row_id:row.id,region_id:region.id,source_row:row.source_row,name_cells:[],standard_cells:[],mod_cells:[],due_cell:'',line:'建筑结构设计',owner_id:architect.id,included:true,reason:''}))};
  return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));
 }};
 const ai=await startAdminPlanAI(f.pool,ops,{project_id:'hf',month:'2026-11',evidence},options);f.beforeClose.push(()=>closeAdminPlanAI(f.pool,ops,{conversation_id:ai.conversation_id},options));
 assert.equal(ai.can_confirm,true);for(const row of ai.rows){assert.equal(row.line,line);assert.equal(row.owner_id,designer.id);assert.equal(row.profession_suggestion,null);}
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('new design plans retain individual owner, weekly fixed columns, completion review, coordination origin and reference locks',async t=>{
 const f=await fixture(t),p=await confirmMonthlyPlan(f.pool,designer,{project_id:'hf',line,month:'2026-11',items:[item]});
 const [weekly]=await report(f,designer,'hf',line,{biz:{monthly_plan_id:p.id,monthly_plan_month:'2026-11',items:[{...p.items[0],prog:'已提交图纸',blocker:''}]}});
 assert.equal(weekly.line,line);assert.equal(weekly.author_id,designer.id);assert.equal((await listMonthlyPlans(f.pool,designer,{project_id:'hf',line}))[0].id,p.id);
 await assert.rejects(save(f,[plan(designer.id,{expected_plan_id:p.id,items:[{...item,name:'不可覆盖引用计划'}]})]),error=>error.status===409&&error.code==='monthly_plan_in_use');
 await assert.rejects(withdrawMonthlyPlan(f.pool,designer,{project_id:'hf',line,month:'2026-11',expected_plan_id:p.id}),error=>error.status===409);
 const source_key='monthly:hf:'+p.id+':'+p.items[0].source_id,preview=await previewCompletion(f.pool,designer,{source_key});assert.equal(preview.line,line);
 await assert.rejects(previewCompletion(f.pool,architect,{source_key}),error=>error.status===403);
 const application=await requestCompletion(f.pool,designer,{source_key,source_version:preview.source_version,completion_date:'2026-11-25',completion_note:'已核验图纸成果'});
 await assert.rejects(reviewCompletion(f.pool,architect,{id:application.id,expected_revision:application.revision,decision:'approve',note:''}),error=>error.status===403);
 const approved=await reviewCompletion(f.pool,ops,{id:application.id,expected_revision:application.revision,decision:'approve',note:''});assert.equal(approved.status,'approved');
 const task=await createCoordinationTask(f.pool,architect,{id:randomUUID(),project_id:'hf',owner_id:designer.id,what:'请设计部统一会签',due:'2026-11-30'}),coord=await previewCompletion(f.pool,designer,{source_key:task.source_key});
 const completed=await requestCompletion(f.pool,designer,{source_key:task.source_key,source_version:coord.source_version,completion_date:'2026-11-25',completion_note:'已会签'});
 await assert.rejects(reviewCompletion(f.pool,ops,{id:completed.id,expected_revision:completed.revision,decision:'approve',note:''}),error=>error.status===403);
 assert.equal((await reviewCompletion(f.pool,architect,{id:completed.id,expected_revision:completed.revision,decision:'approve',note:''})).status,'approved');
 assert.equal((await listMonthlyPlans(f.pool,designer,{project_id:'hf',line}))[0].id,p.id);
});

test('employee AI memory, fact lookup and attachments accept authorized hf design scope and reject other project/profession access',async t=>{
 const f=await fixture(t),scope={project_id:'hf',line,period:'2026-11-02'},directory=await temporary(t);
 assert.equal((await authorizePlanningAI(f.pool,designer,scope)).line,line);
 for(const [user,input]of [[designer,{...scope,project_id:'demo-com'}],[architect,scope],[{id:'design-electrical'},scope]])await assert.rejects(authorizePlanningAI(f.pool,user,input),denied);
 await savePlanningAIPreference(f.pool,designer,{...scope,expected_revision:0,content:'保留设计部整体会签用语'});assert.equal((await loadPlanningAIMemory(f.pool,designer,scope)).preference.content,'保留设计部整体会签用语');
 await assert.rejects(loadPlanningAIMemory(f.pool,designer,{...scope,project_id:'demo-com'}),denied);
 const facts=await loadPlanningAIFacts(f.pool,wild,scope,{kind:'summary',scope:'mine',start:'',end:'',keyword:'',project_name:'',limit:10});
 assert.equal(facts.projects.find(project=>project.id==='hf').lines.includes(line),true);assert.equal(facts.projects.find(project=>project.id==='demo-com').lines.includes(line),false);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
 const attachment=await uploadReportAttachment(f.pool,designer,directory,{...scope,filename:'anonymous-design.png'},png);assert.equal(attachment.line,line);
 await assert.rejects(uploadReportAttachment(f.pool,designer,directory,{...scope,project_id:'demo-com',filename:'blocked.png'},png),denied);
 await assert.rejects(uploadReportAttachment(f.pool,architect,directory,{...scope,filename:'blocked.png'},png),denied);
});
