import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {initializedDatabase,testPool} from './helpers/pglite-pool.mjs';
import {seedDemo} from '../scripts/seed-demo.mjs';
import {startAdminPlanAI as startAI,chatAdminPlanAI,getAdminPlanAISession,reviseAdminPlanAI,confirmAdminPlanAI,closeAdminPlanAI} from '../server/admin-plan-ai.mjs';
import {acquirePlanningAIRequest} from '../server/planning-ai.mjs';
import {HttpError} from '../server/errors.mjs';
import {withdrawAdminPlanBatch} from '../server/admin-plan-batches.mjs';

const ops={id:'demo-ops'},pm={id:'demo-pm-com'},line='土建工程（东地块）',region='s0:1-4',month='2026-11';
const item=()=>({row_id:'s0:r3',region_id:region,source_row:3,name_cells:[],standard_cells:[],mod_cells:[],due_cell:'',line,owner_id:pm.id,included:true,reason:''});
const output=()=>({reply:'已识别本月计划，请核对后再确认导入。',rows:[item()],questions:[],complete:true});
async function startAdminPlanAI(pool,user,input,options){const p=await startAI(pool,user,input,options);options._sessions.add(p.conversation_id);return p;}
const response=v=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(v)}]}]}));
function evidence({strict=true,verified=true}={}){
 const cells=[{id:'s0!A1',cell:'A1',row:1,column:1,text:verified?'2026年11月份工作计划':'工程安排',date:'',formula_cached:false},
  {id:'s0!A3',cell:'A3',row:3,column:1,text:'土建',date:'',formula_cached:false},
  {id:'s0!C3',cell:'C3',row:3,column:3,text:'设备基础施工',date:'',formula_cached:false,doc:{ops:[{insert:'设备基础施工',attributes:{bold:true}}]}},
  {id:'s0!D3',cell:'D3',row:3,column:4,text:'完成验收',date:'',formula_cached:false},
  {id:'s0!E3',cell:'E3',row:3,column:5,text:'2026-11-25',date:'2026-11-25',formula_cached:false}];
 return {v:1,source:{name:'匿名计划.xlsx',sha256:'a'.repeat(64)},month,sheets:[{id:'s0',name:'土建',state:'visible'}],
  regions:[{id:region,sheet_id:'s0',sheet:'土建',structured:strict,month:verified?month:null,month_cell:verified?'A1':null,kind:verified?'strict_month_block':'unverified_region',bounds:{start_row:1,end_row:4,start_col:1,end_col:5},merges:[],cells}],
  rows:strict?[{id:'s0:r3',region_id:region,source_row:3,mod:'土建',name:'设备基础施工',standard:'完成验收',due:'2026-11-25',reporter_hint:'演示土建负责人',line_hint:line,name_doc:{ops:[{insert:'设备基础施工',attributes:{bold:true}}]},source:{sheet:'土建',row:3,cell:'C3'},source_refs:{name_cells:['s0!C3'],standard_cells:['s0!D3'],mod_cells:['s0!A3'],due_cell:'s0!E3'},warnings:[]}]:[],warnings:[]};
}
async function fixture(t){
 const db=await initializedDatabase();const admin=testPool(db,null),pool=testPool(db);await seedDemo(admin);
 const dir=await mkdtemp(path.join(os.tmpdir(),'admin-plan-ai-'));t.after(async()=>{
  const resolved=path.resolve(dir),temporary=path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved),temporary,'recursive cleanup must remain directly inside the temporary directory');
  assert.ok(path.basename(resolved).startsWith('admin-plan-ai-'),'recursive cleanup must target only this fixture prefix');
  await rm(resolved,{recursive:true,force:true});
 });
 const configPath=path.join(dir,'provider.json'),key='sk-'+randomBytes(24).toString('hex');await writeFile(configPath,JSON.stringify({enabled:true,api_key:key,model:'deepseek-flash'}),{mode:0o600});
 const options={configPath,sessionKey:randomBytes(32).toString('hex'),fetchImpl:async()=>response(output()),_sessions:new Set()};
 t.after(async()=>{for(const id of options._sessions)await closeAdminPlanAI(pool,ops,{conversation_id:id},options);await db.close();});
 const input={project_id:'demo-com',month,evidence:evidence()};
 return {db,admin,pool,options,input};
}
const commit=(preview)=>({conversation_id:preview.conversation_id,expected_revision:preview.revision,operation_id:randomUUID(),modes:[{line,owner_id:pm.id,mode:'replace',expected_plan_id:null}]});
const snap=async f=>(await f.admin.query("SELECT jsonb_build_object('reports',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reports r),'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.monthly_plans p),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,project_id) FROM public.project_members m),'operations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY operation_id) FROM app_private.admin_monthly_plan_operations a)) s")).rows[0].s;

test('深圳良安田AI专业保持待分配，不套工程账号，不改原事项且阻止保存',async t=>{
 const f=await fixture(t),scope='shenzhen-shangmugu-residential',owner='demo-pm-res';
 for(const pid of ['szzz','szgy']){
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,'res')",[pid,'匿名深圳'+pid]);
  await f.admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[owner,pid]);
 }
 await f.admin.query("INSERT INTO app_private.report_scopes(id,name,anchor_project_id,project_ids,effective_week,reporting_mode) VALUES($1,'匿名深圳','szzz',ARRAY['szzz','szgy'],'2026-10-26','professional')",[scope]);
 const source=evidence();source.sheets[0].name='良安田';source.regions[0].sheet='良安田';source.regions[0].cells.find(c=>c.cell==='A3').text='工程';
 Object.assign(source.rows[0],{mod:'工程',line_hint:'工程',source:{sheet:'良安田',row:3,cell:'C3'}});
 const copy=structuredClone(source),before=await snap(f);let attempt=0;
 const options={...f.options,fetchImpl:async(url,init)=>{
  const sent=JSON.parse(JSON.parse(init.body).input[0].content);assert.deepEqual(sent.project_professions,[{project_id:'szzz',report_scope_id:scope,line:'良安田项目',assigned:false}]);
  assert.equal(sent.strict_rows[0].line,'良安田项目');assert.equal(sent.strict_rows[0].owner_id,null);
  return response({...output(),rows:[{...item(),line:attempt++?'工程':'良安田项目',owner_id:attempt===1?'':owner}]});
 }};
 const input={project_id:'szzz',report_scope_id:scope,month,evidence:source};
 let p=await startAdminPlanAI(f.pool,ops,input,options);assert.equal(p.ai_status,'ready');assert.equal(p.rows[0].line,'良安田项目');assert.equal(p.rows[0].owner_id,null);assert.equal(p.rows[0].mod,'工程');assert.equal(p.can_confirm,false);
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),options),e=>e.code==='admin_plan_ai_unresolved');
 p=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'核对后保持原专业'}]},options);
 assert.equal(p.rows[0].line,'良安田项目');assert.equal(p.rows[0].owner_id,null);assert.equal(p.rows[0].mod,'工程');assert.equal(p.can_confirm,false);assert.deepEqual(source,copy);assert.deepEqual(await snap(f),before);
});

async function addProfessionalPeer(f){
 const id='anonymous-dynamic-peer';
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'匿名同专业新增提报人','pm','approved','demo-com',$2)",[id,line]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[id]);return id;
}
async function rejectedSuggestion(f,input,options){
 const p=await startAdminPlanAI(f.pool,ops,input,options);
 assert.equal(p.ai_status,'needs_retry');assert.equal(p.ai_error.code,'admin_plan_ai_output_invalid');assert.equal(p.can_confirm,false);assert.equal(p.complete,false);
 assert.equal(p.rows.length,input.evidence.rows.length,'invalid model rows must never enter the rules-only preview');
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),f.options),e=>e.code==='admin_plan_ai_unresolved');
 await closeAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id},f.options);
}

test('AI确认缓存不能把已撤回批次重新作为保存成功返回',async t=>{
 const f=await fixture(t),preview=await startAdminPlanAI(f.pool,ops,f.input,f.options),input=commit(preview),saved=await confirmAdminPlanAI(f.pool,ops,input,f.options);
 assert.equal(saved.confirmed,true);await withdrawAdminPlanBatch(f.pool,ops,{actor_id:ops.id,operation_id:input.operation_id});
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,input,f.options),error=>error.code==='admin_plan_ai_saved_changed');
 await assert.rejects(getAdminPlanAISession(f.pool,ops,{conversation_id:preview.conversation_id},f.options),error=>error.code==='admin_plan_ai_saved_changed');
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('whole-project AI uses the existing DeepSeek configuration and grounded strict facts; only final confirmation saves the reporter monthly plan',async t=>{
 const f=await fixture(t),before=await snap(f);let calls=0;
 f.options.fetchImpl=async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/responses');const p=JSON.parse(init.body);assert.equal(p.model,'deepseek-flash');assert.equal(p.reasoning.effort,'none');assert.equal(p.tools,undefined);assert.match(p.instructions,/没有数据库/);
  assert.match(p.instructions,/"name_cells":\[\],"standard_cells":\[\],"mod_cells":\[\],"due_cell":""/);
  assert.match(p.instructions,/不要复制strict_rows\.source_refs/);assert.match(p.instructions,/s0!C3，不可使用用于显示坐标的cell字段C3/);
  return response(output());};
 const preview=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 assert.equal(calls,1);assert.equal(preview.can_confirm,true);assert.equal(preview.rows[0].name,'设备基础施工\n完成标准：完成验收');assert.equal(preview.rows[0].due,'2026-11-25');assert.deepEqual(await snap(f),before);
 const request=commit(preview),saved=await confirmAdminPlanAI(f.pool,ops,request,f.options),retry=await confirmAdminPlanAI(f.pool,ops,request,f.options);
 assert.equal(saved.result.plans[0].owner_id,pm.id);assert.equal(saved.result.plans[0].confirmed_by,pm.id);assert.deepEqual(retry.result,saved.result);
 assert.equal(saved.result.plans[0].rich_text.fields['items.0.name'].ops[0].attributes.bold,true);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.admin_monthly_plan_operations')).rows[0].n,1);
});

test('optional dates retain multi-date source facts without blocking, while real date and source questions remain',async t=>{
 const f=await fixture(t),before=await snap(f);
 for(const mode of ['blank','multi','real']){
  const source=evidence(),row=source.rows[0],cell=source.regions[0].cells.find(c=>c.cell==='E3');
  const raw='1、2026/11/10；2、2026/11/20；';
  if(mode!=='real'){row.due='';cell.date='';cell.text=mode==='multi'?raw:'';row.due_note=cell.text;if(mode==='blank')row.source_refs.due_cell=null;}
  const value={...output(),questions:[{id:'date-check',text:mode==='real'?'此日期与其他安排冲突，请核对':'请补齐日期',row_ids:['s0:r3'],kind:'date'},
   {id:'source-check',text:'需核对来源正文',row_ids:['s0:r3'],kind:'source'}]};
  const p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:source},{...f.options,fetchImpl:async()=>response(value)});
  assert.equal(p.questions.some(q=>q.kind==='date'),mode==='real');assert.equal(p.questions.some(q=>q.kind==='source'),true);
  if(mode==='multi'){
   assert.equal(p.rows[0].due,'');assert.equal(p.rows[0].due_note,raw);assert.match(p.rows[0].name,/原表完成时间：1、2026\/11\/10/);
   assert.ok(p.rows[0].name_doc.ops.some(op=>op.insert.includes(raw)));
  }
  await closeAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id},f.options);f.options._sessions.delete(p.conversation_id);
 }
 assert.deepEqual(await snap(f),before);
});

test('design summary suggestions survive an unhelpful AI response and require explicit authorized confirmation',async t=>{
 const f=await fixture(t),owner='anonymous-design-reporter',design='精装设计';
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'匿名精装提报人','pm','approved','demo-com',$2)",[owner,design]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[owner]);
 const source=evidence();source.sheets[0].name='设计管理部';source.regions[0].sheet='设计管理部';
 const task='室内样板段及招标施工图';
 Object.assign(source.rows[0],{name:task,name_doc:{ops:[{insert:task}]},line_hint:'设计管理部',source:{sheet:'设计管理部',row:3,cell:'C3'},reporter_hint:'原表责任人姓名不用于匹配'});
 Object.assign(source.regions[0].cells.find(c=>c.cell==='C3'),{text:task,doc:{ops:[{insert:task}]}});
 const before=await snap(f),model={...output(),rows:[{...item(),line:'',owner_id:''}],questions:[{id:'assignment',kind:'assignment',text:'请选择专业',row_ids:['s0:r3']}]};
 const p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:source},{...f.options,fetchImpl:async()=>response(model)});
 assert.equal(p.rows[0].line,null);assert.equal(p.rows[0].owner_id,null);assert.equal(p.rows[0].profession_suggestion.line,design);
 assert.equal(p.rows[0].profession_suggestion.owner_id,owner);assert.equal(p.rows[0].profession_suggestion.requires_confirmation,true);assert.equal(p.can_confirm,false);
 const fixed=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line:design,owner_id:owner}]},f.options);
 assert.equal(fixed.can_confirm,true);assert.equal(fixed.questions.length,0);assert.equal(fixed.rows[0].profession_suggestion,null);assert.deepEqual(await snap(f),before);
});

test('read-only AI sessions bind account, login session, source and revision; untrusted client evidence is never accepted during chat',async t=>{
 const f=await fixture(t),p=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 await assert.rejects(getAdminPlanAISession(f.pool,pm,{conversation_id:p.conversation_id},f.options),e=>e.status===403);
 await assert.rejects(getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},{...f.options,sessionKey:'another-login-session'}),e=>e.status===403);
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:0,messages:[{role:'user',content:'请继续'}]},f.options),e=>e.status===409);
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'请继续'}],evidence:evidence()},f.options),e=>e.status===400);
 f.input.evidence.rows[0].name='调用者后来篡改';assert.equal((await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options)).rows[0].name,'设备基础施工\n完成标准：完成验收');
});

test('source project-profession routing is authoritative, responsibility-name questions are resolved structurally and real data questions remain',async t=>{
 const f=await fixture(t),cost='anonymous-ai-cost';
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'匿名成本填报人','pm','approved','demo-com','成本')",[cost]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[cost]);
 f.input.evidence.rows[0].reporter_hint='原表工作责任人不是平台账号';
 const before=await snap(f),questions=[
  {id:'routing',text:'原表姓名不同，请指定填报人',row_ids:['s0:r3'],kind:'assignment'},
  ...['date','month','source','other'].map(kind=>({id:kind,text:'仍需确认的'+kind+'问题',row_ids:['s0:r3'],kind})),
  {id:'legacy',text:'未分类问题不能自动消除',row_ids:['s0:r3']},
  {id:'global',text:'没有具体行的归属问题不能自动消除',row_ids:[],kind:'assignment'}];
 let captured;
 const options={...f.options,fetchImpl:async(url,init)=>{
  captured=JSON.parse(init.body);return response({...output(),reply:'原表姓名不同，仍待分配',rows:[{...item(),line:'成本',owner_id:cost}],questions});
 }};
 let p=await startAdminPlanAI(f.pool,ops,f.input,options);
 assert.equal(p.rows[0].line,line);assert.equal(p.rows[0].owner_id,pm.id);assert.equal(p.rows[0].match_basis,'project_line_unique');
 assert.equal(p.rows[0].reporter_hint,'原表工作责任人不是平台账号');assert.equal(p.can_confirm,false);
 assert.deepEqual(p.questions.map(q=>q.id),['date','month','source','other','legacy','global']);assert.doesNotMatch(p.reply,/原表姓名不同|仍待分配/);
 const context=JSON.parse(captured.input[0].content);assert.equal(context.strict_rows[0].reporter_hint,undefined);
 assert.equal(context.strict_rows[0].work_responsible_reference,'原表工作责任人不是平台账号');
 assert.equal(context.current_rows[0].reporter_hint,undefined);assert.match(captured.instructions,/不是系统提报人/);
 assert.deepEqual(captured.text.format.schema.properties.questions.items.properties.kind.enum,['assignment','date','month','source','other']);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,name:'只修正文案不解决日期'}]},f.options);
 assert.deepEqual(p.questions.map(q=>q.id),['date','month','source','other','legacy','global']);assert.equal(p.can_confirm,false);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line:'成本',owner_id:cost}]},f.options);
 assert.equal(p.rows[0].match_basis,'manual');
 p=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'保留管理员明确选择的成本提报人'}]},f.options);
 assert.equal(p.rows[0].owner_id,cost);assert.equal(p.rows[0].line,'成本');assert.equal(p.rows[0].match_basis,'manual');
 assert.deepEqual(await snap(f),before);
});

test('unique professional assignment survives blank model routing and blank work responsibility, but same-profession peers require explicit administrator choice',async t=>{
 const f=await fixture(t);f.input.evidence.rows[0].reporter_hint='';
 const unresolved={...output(),rows:[{...item(),line:'',owner_id:'',included:false,reason:'原表责任人为空所以暂不导入'}],questions:[{id:'person',kind:'assignment',text:'原表责任人为空，请确认系统填报人',row_ids:['s0:r3']}]};
 const options={...f.options,fetchImpl:async()=>response(unresolved)};
 const single=await startAdminPlanAI(f.pool,ops,f.input,options);
 assert.equal(single.rows[0].owner_id,pm.id);assert.equal(single.rows[0].included,true);assert.equal(single.questions.length,0);assert.equal(single.can_confirm,true);
 const excluded=await chatAdminPlanAI(f.pool,ops,{conversation_id:single.conversation_id,expected_revision:single.revision,messages:[{role:'user',content:'管理员明确要求排除此项'}]},options);
 assert.equal(excluded.rows[0].included,false);assert.equal(excluded.can_confirm,false);
 await closeAdminPlanAI(f.pool,ops,{conversation_id:single.conversation_id},f.options);
 const peer='anonymous-ai-peer';await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES($1,'演示土建负责人','pm','approved','demo-com',$2)",[peer,line]);
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES($1,'demo-com')",[peer]);
 f.input.evidence.rows[0].reporter_hint='演示土建负责人';
 const multiple={...unresolved,rows:[item()]};let p=await startAdminPlanAI(f.pool,ops,f.input,{...options,fetchImpl:async()=>response(multiple)});
 assert.equal(p.rows[0].owner_id,null);assert.equal(p.rows[0].match_status,'ambiguous');assert.equal(p.questions.length,1);assert.equal(p.can_confirm,false);
 assert.equal(p.rows[0].candidate_targets.length,2);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,owner_id:peer,line}]},f.options);
 assert.equal(p.rows[0].owner_id,peer);assert.equal(p.rows[0].match_basis,'manual');assert.equal(p.questions.length,0);assert.equal(p.can_confirm,true);
 p=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'保留我明确选择的提报人'}]},f.options);
 assert.equal(p.rows[0].owner_id,peer);assert.equal(p.rows[0].match_basis,'manual');
});

test('fallback professional identification uses the same unique-grant routing and cannot be rebound to a different granted profession',async t=>{
 const f=await fixture(t),source=evidence({strict:false});source.regions[0].cells.find(c=>c.cell==='A3').text=line;
 await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES('anonymous-fallback-cost','匿名其他专业','pm','approved','demo-com','成本')");
 await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('anonymous-fallback-cost','demo-com')");
 const proposal={...item(),row_id:region+':3',name_cells:['s0!C3'],standard_cells:[],mod_cells:['s0!A3'],due_cell:'s0!E3',line:'成本',owner_id:'anonymous-fallback-cost'};
 const p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:source},{...f.options,fetchImpl:async()=>response({...output(),reply:'原工作责任人姓名不匹配，无法分配',rows:[proposal]})});
 assert.equal(p.rows[0].line,line);assert.equal(p.rows[0].owner_id,pm.id);assert.equal(p.rows[0].match_basis,'project_line_unique');assert.equal(p.can_confirm,true);
 assert.doesNotMatch(p.reply,/姓名不匹配|无法分配/);
});

test('an unknown source profession keeps the model routing as a button-confirmable suggestion without silently selecting the reporter',async t=>{
 const f=await fixture(t);f.input.evidence.rows[0].line_hint='项目综合保障组';
 const before=await snap(f),options={...f.options,fetchImpl:async()=>response({...output(),questions:[{id:'profession',text:'请确认是否属于土建专业',row_ids:['s0:r3'],kind:'assignment'}]})};
 let p=await startAdminPlanAI(f.pool,ops,f.input,options);
 assert.equal(p.rows[0].owner_id,null);assert.equal(p.rows[0].line,null);assert.equal(p.can_confirm,false);
 assert.deepEqual(p.rows[0].profession_suggestion,{line,owner_id:pm.id,reason:'AI根据原表专业及事项内容建议，请核对后确认',requires_confirmation:true});
 assert.equal(p.questions.length,1);await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),options),e=>e.code==='admin_plan_ai_unresolved');
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line,owner_id:pm.id}]},f.options);
 assert.equal(p.rows[0].profession_suggestion,null);assert.equal(p.rows[0].match_basis,'manual');
 assert.equal(p.rows[0].profession_mapping.source_label,'项目综合保障组');assert.equal(p.rows[0].profession_mapping.basis,'manual');
 assert.equal(p.questions.length,0);assert.equal(p.can_confirm,true);assert.deepEqual(await snap(f),before);
});

test('dynamic professional grants refresh every retained automatic row and invalidate stale confirmations and model requests',async t=>{
 const f=await fixture(t),p=await startAdminPlanAI(f.pool,ops,f.input,f.options),facts=({name,mod,due,name_doc,source_refs})=>({name,mod,due,name_doc,source_refs});
 await addProfessionalPeer(f);let modelCalls=0;
 const options={...f.options,fetchImpl:async(url,init)=>{
  modelCalls++;const context=JSON.parse(JSON.parse(init.body).input[0].content);
  assert.equal(context.strict_rows[0].owner_id,null);assert.equal(context.strict_rows[0].candidate_targets.length,2);
  assert.equal(context.current_rows[0].owner_id,null);return response({...output(),rows:[]});
 }};
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),options),e=>e.code==='admin_plan_ai_changed');
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'过期预览不得继续'}]},options),e=>e.code==='admin_plan_ai_changed');
 assert.equal(modelCalls,0);
 let current=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 assert.ok(current.revision>p.revision);assert.equal(current.rows[0].owner_id,null);assert.equal(current.rows[0].match_status,'ambiguous');assert.equal(current.can_confirm,false);
 assert.deepEqual(facts(current.rows[0]),facts(p.rows[0]));
 const same=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);assert.equal(same.revision,current.revision);
 current=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:current.revision,messages:[{role:'user',content:'继续核对，但模型省略原始行'}]},options);
 assert.equal(modelCalls,1);assert.equal(current.rows.length,1);assert.equal(current.rows[0].owner_id,null);assert.equal(current.can_confirm,false);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.admin_monthly_plan_operations')).rows[0].n,0);
});

test('an explicitly selected reporter survives added peers but loses confirmation eligibility when their project grant is revoked',async t=>{
 const f=await fixture(t);let p=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line,owner_id:pm.id}]},f.options);
 await addProfessionalPeer(f);
 const kept=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 assert.equal(kept.rows[0].owner_id,pm.id);assert.equal(kept.rows[0].match_basis,'manual');assert.equal(kept.can_confirm,true);
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(kept),f.options),e=>e.code==='admin_plan_ai_changed');
 const revoked=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 assert.equal(revoked.rows[0].owner_id,pm.id);assert.equal(revoked.rows[0].match_basis,'manual');assert.equal(revoked.can_confirm,false);
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(revoked),f.options),e=>e.code==='admin_plan_ai_unresolved');
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('a professional grant change during final session revalidation cannot save a stale automatically routed plan',async t=>{
 const f=await fixture(t),p=await startAdminPlanAI(f.pool,ops,f.input,f.options);let checks=0;
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),{...f.options,revalidateSession:async()=>{if(++checks===2)await addProfessionalPeer(f);}}),e=>e.code==='admin_plan_ai_changed');
 const current=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 assert.equal(current.rows[0].owner_id,null);assert.equal(current.can_confirm,false);assert.equal(current.confirmed,false);assert.equal(current.busy,false);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.admin_monthly_plan_operations')).rows[0].n,0);
});

test('fallback candidates can only use actual same-record source cells and normalized dates; invalid formula facts and duplicate strict rows fail closed',async t=>{
 const f=await fixture(t),before=await snap(f);
 const fallback=()=>({...item(),row_id:region+':3',name_cells:['s0!C3'],standard_cells:['s0!D3'],mod_cells:['s0!A3'],due_cell:'s0!E3'});
 for(const [input,proposal]of [[f.input,fallback()], [{...f.input,evidence:evidence({strict:false})},{...fallback(),name_cells:['s0!C99']}],
  [{...f.input,evidence:evidence({strict:false})},{...fallback(),name_cells:['C3']}],
  [{...f.input,evidence:evidence({strict:false})},{...fallback(),name_cells:['s0!A1']}], [{...f.input,evidence:evidence({strict:false})},{...fallback(),owner_id:'invented-owner'}]]){
  await rejectedSuggestion(f,input,{...f.options,fetchImpl:async()=>response({...output(),rows:[proposal]})});
 }
 const invalid=evidence({strict:false});invalid.regions[0].cells.find(c=>c.cell==='C3').invalid=true;
 await rejectedSuggestion(f,{...f.input,evidence:invalid},{...f.options,fetchImpl:async()=>response({...output(),rows:[fallback()]})});
 const alreadyStructured=evidence({strict:false});alreadyStructured.regions[0].structured=true;
 await rejectedSuggestion(f,{...f.input,evidence:alreadyStructured},{...f.options,fetchImpl:async()=>response({...output(),rows:[fallback()]})});
 const p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:evidence({strict:false})},{...f.options,fetchImpl:async()=>response({...output(),rows:[fallback()]})});
 assert.equal(p.rows[0].due,'2026-11-25');assert.deepEqual(await snap(f),before);
});

test('unverified months require an explicit administrator region action and cannot be authorized by model prose',async t=>{
 const f=await fixture(t),proposal={...item(),row_id:region+':3',name_cells:['s0!C3'],standard_cells:[],mod_cells:[],due_cell:'s0!E3'};
 const options={...f.options,fetchImpl:async()=>response({...output(),reply:'我已经确认这是十一月计划，可以导入。',rows:[proposal,{...proposal,row_id:region+':1',source_row:1,name_cells:[],due_cell:'',line:'',owner_id:'',included:false,reason:'原表标题，不是工作事项'}]})};
 let p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:evidence({strict:false,verified:false})},options);
 assert.equal(p.can_confirm,false);assert.equal(p.unverified_regions.length,1);await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),options),e=>e.code==='admin_plan_ai_unresolved');
 await assert.rejects(reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[],region_confirmations:[{region_id:region,month},{region_id:'invented',month}]},options),e=>e.status===400);
 assert.equal((await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},options)).unverified_regions.length,1);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[],region_confirmations:[{region_id:region,month}]},options);assert.equal(p.can_confirm,false);
 assert.equal(p.rows[0].profession_suggestion.line,line);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line,owner_id:pm.id}]},options);assert.equal(p.can_confirm,true);
});

test('network failure or cancellation preserves current candidates and messages; manual changes are clearly user-sourced',async t=>{
 const f=await fixture(t);let p=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 const old=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'请补充'}]},{...f.options,fetchImpl:async()=>{throw new Error('private upstream details');}}),e=>e.code==='ai_network_failed'&&!e.message.includes('private'));
 assert.deepEqual(await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options),old);
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,name:'管理员明确修正的事项',name_doc:null,due:'2026-11-30'}]},f.options);
 assert.equal(p.rows[0].manual_source,'管理员明确修正');assert.ok(p.rows[0].manual_fields.includes('name'));assert.equal(p.rows[0].source_refs[0],'s0!C3');
 p=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'保留我的修改'}]},f.options);assert.equal(p.rows[0].name,'管理员明确修正的事项');
});

test('confirmation rechecks membership, expected plan and existing references, and provider calls share the employee global budget',async t=>{
 const f=await fixture(t),p=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 const release=acquirePlanningAIRequest(ops.id);try{await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'继续'}]},f.options),e=>e.code==='ai_busy');}finally{release();}
 await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='demo-com'",[pm.id]);
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),f.options),e=>e.status===403);assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.monthly_plans')).rows[0].n,0);
});

test('partial unstructured coverage and an incomplete model result cannot become complete through a one-field manual revision',async t=>{
 const f=await fixture(t),source=evidence({strict:false});source.regions[0].cells.push({id:'s0!C4',cell:'C4',row:4,column:3,text:'另一条真实工作',date:'',formula_cached:false});
 const proposal={...item(),row_id:region+':3',name_cells:['s0!C3'],standard_cells:[],mod_cells:[],due_cell:''};
 let p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:source},{...f.options,fetchImpl:async()=>response({...output(),rows:[proposal],complete:false})});
 assert.equal(p.can_confirm,false);assert.deepEqual(p.coverage[0].pending_rows,[4]);assert.equal(p.unprocessed_rows[0].cells[0].cell,'C4');
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,name:'管理员明确修订'}]},f.options);
 assert.equal(p.complete,false);assert.equal(p.can_confirm,false);assert.equal(p.rows[0].name_doc,null);
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),f.options),e=>e.code==='admin_plan_ai_unresolved');
 p=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'第4行为说明，不是工作任务'}]},{...f.options,fetchImpl:async()=>response({...output(),rows:[proposal,{...proposal,row_id:region+':4',source_row:4,name_cells:[],included:false,reason:'管理员明确说明这是说明行'}]})});
 assert.equal(p.complete,true);assert.deepEqual(p.coverage[0].pending_rows,[]);assert.equal(p.rows[1].included,false);
 assert.equal(p.can_confirm,false,'complete coverage cannot implicitly accept an uncertain source profession');
 p=await reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,line,owner_id:pm.id}]},f.options);
 assert.equal(p.can_confirm,true,'after full coverage and explicit profession confirmation the original completion guarantee still holds');
});

test('a pending confirmation claims the candidate revision before session revalidation and cannot race a manual edit or chat',async t=>{
 const f=await fixture(t),p=await startAdminPlanAI(f.pool,ops,f.input,f.options);
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const options={...f.options,revalidateSession:async()=>{if(++calls===2){enter();await gate;}}};
 const saving=confirmAdminPlanAI(f.pool,ops,commit(p),options);await entered;
 const current=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options);assert.equal(current.busy,true);assert.equal(current.can_confirm,false);
 await assert.rejects(reviseAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,changes:[{id:p.rows[0].id,name:'竞态更改'}]},f.options),e=>e.code==='admin_plan_ai_busy');
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'同时重整'}]},f.options),e=>e.code==='admin_plan_ai_busy');
 release();const result=await saving;assert.equal(result.confirmed,true);assert.equal(result.busy,false);assert.equal(result.result.plans[0].items[0].name,p.rows[0].name);
});

test('explicit merge evidence permits a real inherited module while nonmerge cross-record cells and anchor titles cannot become tasks',async t=>{
 const f=await fixture(t),source=evidence({strict:false});source.regions[0].cells=source.regions[0].cells.filter(c=>c.cell!=='A3');
 source.regions[0].cells.push({id:'s0!A2',cell:'A2',row:2,column:1,text:'合并土建模块',date:'',formula_cached:false});source.regions[0].merges=[{first:{row:2,col:1},last:{row:3,col:1}}];
 const proposal={...item(),row_id:region+':3',name_cells:['s0!C3'],standard_cells:[],mod_cells:['s0!A2'],due_cell:'s0!E3'};
 const options={...f.options,fetchImpl:async()=>response({...output(),rows:[proposal]})};
 const p=await startAdminPlanAI(f.pool,ops,{...f.input,evidence:source},options);assert.equal(p.rows[0].mod,'合并土建模块');
 source.regions[0].merges=[];await rejectedSuggestion(f,{...f.input,evidence:source},options);
});

test('completed imports keep short-term receipt replay without consuming the three active preview slots',async t=>{
 const f=await fixture(t);let expected=null;
 for(let i=0;i<4;i++){
  const p=await startAdminPlanAI(f.pool,ops,f.input,f.options),request=commit(p);request.modes[0].expected_plan_id=expected;
  const result=await confirmAdminPlanAI(f.pool,ops,request,f.options);expected=result.result.plans[0].id;
  assert.equal(result.confirmed,true);assert.equal(result.busy,false);
  assert.deepEqual((await confirmAdminPlanAI(f.pool,ops,request,f.options)).result,result.result);
 }
 assert.equal((await f.admin.query('SELECT count(*)::int n FROM app_private.admin_monthly_plan_operations')).rows[0].n,4);
});

test('expiry and a model response arriving after cancellation cannot silently change a retained preview',async t=>{
 const f=await fixture(t);let clock=Date.now();const options={...f.options,nowMs:()=>clock};
 const p=await startAdminPlanAI(f.pool,ops,f.input,options),before=await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},options),controller=new AbortController();
 await assert.rejects(chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:p.revision,messages:[{role:'user',content:'取消本轮'}]},
  {...options,signal:controller.signal,fetchImpl:async()=>{controller.abort();return response({...output(),reply:'不应写入的新回复'});}}),e=>e.code==='ai_cancelled');
 assert.deepEqual(await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},options),before);
 clock+=31*60*1000;await assert.rejects(getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},options),e=>e.code==='admin_plan_ai_expired');
});

test('initial recoverable model failures retain only rules-parsed rows with a fixed sanitized retry notice and no business writes',async t=>{
 const f=await fixture(t),before=await snap(f),cases=[
  ['ai_provider_failed',async()=>new Response('private upstream detail',{status:503})],
  ['ai_provider_rate_limited',async()=>new Response('private upstream detail',{status:429})],
  ['ai_network_failed',async()=>{throw new Error('private network detail');}],
  ['ai_timeout',async()=>{throw new HttpError(504,'private timeout detail','ai_timeout');}],
  ['ai_output_invalid',async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'private malformed JSON'}]}]}))],
  ['ai_output_incomplete',async()=>new Response(JSON.stringify({status:'incomplete',output:[]}))],
  ['admin_plan_ai_output_invalid',async()=>response({...output(),rows:[{...item(),owner_id:'invented-owner'}]})]
 ];
 for(const [code,fetchImpl]of cases){
  const p=await startAdminPlanAI(f.pool,ops,f.input,{...f.options,fetchImpl});
  assert.equal(p.ai_status,'needs_retry');assert.equal(p.ai_error.code,code);assert.doesNotMatch(p.ai_error.message,/private/);
  assert.equal(p.revision,0);assert.equal(p.complete,false);assert.equal(p.can_confirm,false);assert.equal(p.busy,false);assert.equal(p.messages.length,0);
  assert.equal(p.rows[0].name,'设备基础施工\n完成标准：完成验收');assert.equal(p.rows[0].due,'2026-11-25');assert.equal(p.rows[0].owner_id,pm.id);
  assert.deepEqual(await getAdminPlanAISession(f.pool,ops,{conversation_id:p.conversation_id},f.options),p);
  await closeAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id},f.options);
 }
 const release=acquirePlanningAIRequest(ops.id);let busy;
 try{busy=await startAdminPlanAI(f.pool,ops,f.input,f.options);assert.equal(busy.ai_error.code,'ai_busy');assert.equal(busy.can_confirm,false);}finally{release();}
 await closeAdminPlanAI(f.pool,ops,{conversation_id:busy.conversation_id},f.options);assert.deepEqual(await snap(f),before);
});

test('a retained initial preview retries through the same conversation without reuploading or confirming any plan',async t=>{
 const f=await fixture(t),before=await snap(f),p=await startAdminPlanAI(f.pool,ops,f.input,{...f.options,fetchImpl:async()=>{throw new Error('upstream');}});
 await assert.rejects(confirmAdminPlanAI(f.pool,ops,commit(p),f.options),e=>e.code==='admin_plan_ai_unresolved');
 const retried=await chatAdminPlanAI(f.pool,ops,{conversation_id:p.conversation_id,expected_revision:0,messages:[{role:'user',content:'请继续整理已上传的整份本月计划'}]},f.options);
 assert.equal(retried.conversation_id,p.conversation_id);assert.equal(retried.revision,1);assert.equal(retried.ai_status,'ready');assert.equal(retried.ai_error,null);assert.equal(retried.can_confirm,true);
 assert.deepEqual(retried.rows.map(r=>({name:r.name,due:r.due,source_refs:r.source_refs})),p.rows.map(r=>({name:r.name,due:r.due,source_refs:r.source_refs})));
 assert.deepEqual(await snap(f),before);
});

test('an initial model failure followed by administrator revocation must reject rather than return workbook contents',async t=>{
 const f=await fixture(t),before=await snap(f);
 await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,{...f.options,fetchImpl:async()=>{
  await f.admin.query("UPDATE public.profiles SET status='pending' WHERE user_id=$1",[ops.id]);throw new Error('network failure after revocation');
 }}),e=>e.status===403&&e.code==='admin_monthly_plan_forbidden');
 await f.admin.query("UPDATE public.profiles SET status='approved' WHERE user_id=$1",[ops.id]);assert.deepEqual(await snap(f),before);
});

test('logout, forced password change and scope rejection during the initial failure recheck cannot be downgraded to a retry preview',async t=>{
 const f=await fixture(t),before=await snap(f);
 for(const [status,code]of [[401,'admin_plan_ai_session_expired'],[403,'PASSWORD_CHANGE_REQUIRED'],[409,'admin_plan_ai_scope_changed']]){
  let reject=false;const options={...f.options,revalidateSession:async()=>{if(reject)throw new HttpError(status,'revalidation rejected',code);},fetchImpl:async()=>{reject=true;throw new Error('network failure');}};
  await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,options),e=>e.status===status&&e.code===code);
 }
 assert.deepEqual(await snap(f),before);
});

test('cancelling an initial request still rejects and does not turn the parsed workbook into a recoverable AI result',async t=>{
 const f=await fixture(t),before=await snap(f),controller=new AbortController();
 await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,{...f.options,signal:controller.signal,fetchImpl:async()=>{controller.abort();throw new Error('cancelled network');}}),e=>e.code==='ai_cancelled');
 assert.deepEqual(await snap(f),before);
});

test('configuration errors, unexpected failures and mismatched error statuses stay outside the initial retry whitelist',async t=>{
 const f=await fixture(t),before=await snap(f);
 await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,{...f.options,configPath:path.join(path.dirname(f.options.configPath),'absent.json')}),e=>e.code==='ai_config_invalid'&&e.status===503);
 await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,{...f.options,revalidateSession:async()=>{throw new Error('unexpected auth failure');}}),/unexpected auth failure/);
 await assert.rejects(startAdminPlanAI(f.pool,ops,f.input,{...f.options,fetchImpl:async()=>{throw new HttpError(403,'must not downgrade','ai_timeout');}}),e=>e.code==='ai_timeout'&&e.status===403);
 assert.deepEqual(await snap(f),before);
});
