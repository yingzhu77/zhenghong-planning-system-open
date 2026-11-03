import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startPlanningAiLocal} from './helpers/planning-ai-local.mjs';
import {testPool} from './helpers/pglite-pool.mjs';
import {loadPlanningAIFacts,assertPlanningAIFactAccess,validatePlanningAILookup,planningAIReadIntent} from '../server/planning-ai-data.mjs';
import {previewCompletion,requestCompletion,reviewCompletion} from '../server/completions.mjs';
import {planningAIChat,validatePlanningAIOutput} from '../server/planning-ai.mjs';

const now=new Date('2026-10-27T04:00:00Z'),user={id:'ai-local-acceptance-user'};
test('旧领导安排不进入本人待办汇总，原记录和历史反馈保留',async t=>{
  const f=await fixture(t);
  await f.admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,owner_id) VALUES($1,$2,'ceo_brief','旧总裁交代内容',$3),($1,$2,'pzo_note','旧项目总安排内容',NULL)",[f.scope.project_id,f.scope.period,user.id]);
  const before=(await f.admin.query('SELECT jsonb_agg(to_jsonb(n) ORDER BY id) AS snapshot FROM public.leader_notes n')).rows[0].snapshot;
  const facts=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now});
  assert.equal(facts.summary.total,3);assert.equal(facts.items.some(row=>row.source_key.startsWith('leader:')),false);
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(n) ORDER BY id) AS snapshot FROM public.leader_notes n')).rows[0].snapshot,before);
});
const query=(kind='summary',patch={})=>({kind,scope:'current',start:'',end:'',keyword:'',project_name:'',limit:10,...patch});
async function fixture(t){const runtime=await startPlanningAiLocal({mode:'local-acceptance',now});t.after(()=>runtime.close());return {...runtime,admin:testPool(runtime.db,null)};}
test('多项目专业查询批量核权，返回前仍重新核对全部项目和专业',async t=>{
  const f=await fixture(t);
  await f.admin.query("UPDATE public.profiles SET biz_line='*',discipline='工程' WHERE user_id=$1",[user.id]);
  const added=[];
  for(let index=0;index<7;index++){
    const id='ai-batch-'+index;added.push(id);
    await f.admin.query('INSERT INTO public.projects(id,name,project_type) VALUES($1,$2,$3)',[id,'匿名批量项目'+index,index<2?'com':'res']);
    await f.admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[user.id,id]);
  }
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('ai-unassigned','未授权项目','res')");
  const permissions=[];
  const counted={async connect(){const client=await f.pool.connect();return {query(sql,values){if(sql.includes('app_private.can_write_report('))permissions.push({sql,values});return client.query(sql,values);},release(){client.release();}};}};
  const facts=await loadPlanningAIFacts(counted,user,f.scope,query('summary',{scope:'mine'}),{now});
  assert.equal(facts.projects.length,8);assert.equal(facts.summary.total,3);
  assert.equal(facts.projects.some(project=>project.id==='ai-unassigned'),false);
  assert.deepEqual(facts.projects.filter(project=>project.id.startsWith('ai-batch-')&&Number(project.id.at(-1))>=2).map(project=>project.lines),Array(5).fill(['综合','工程']));
  assert.equal(permissions.length,1);assert.equal(permissions[0].values[0].length,46);
  await assertPlanningAIFactAccess(counted,user,facts);
  assert.equal(permissions.length,2);assert.equal(permissions[1].values[0].length,46);
  await f.admin.query('DELETE FROM public.project_members WHERE user_id=$1 AND project_id=$2',[user.id,added.at(-1)]);
  await assert.rejects(assertPlanningAIFactAccess(counted,user,facts),error=>error.status===403&&error.code==='ai_scope_forbidden');
  assert.equal(permissions.length,3);
  await assert.rejects(loadPlanningAIFacts(counted,user,{...f.scope,line:'不属于本人的专业'},query(),{now}),error=>error.status===403&&error.code==='ai_scope_forbidden');
});
test('本人汇总按稳定来源去重，历史按周/关键词查询，只暴露本人当前授权数据',async t=>{
  const f=await fixture(t),facts=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now});
  assert.equal(facts.summary.total,3);assert.equal(facts.summary.overdue,1);assert.equal(facts.summary.due_next7,2);
  const overdue=await loadPlanningAIFacts(f.pool,user,f.scope,query('overdue'),{now});
  assert.equal(overdue.items.length,1);assert.equal(overdue.items[0].what,'核对试运行方案');assert.equal(overdue.items[0].overdue_days,4);
  const history=await loadPlanningAIFacts(f.pool,user,f.scope,query('history',{start:'2026-10-19',end:'2026-10-19',keyword:'50%'}),{now});
  assert.equal(history.total,1);assert.equal(history.reports[0].week,'2026-10-19');assert.match(history.reports[0].items[0].progress,/50%/);
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line) VALUES('ai-other','其他提报人','pm','approved','ai-local-project','成本')");
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('ai-other','ai-local-project')");
  await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,change_text) VALUES('ai-local-project','2026-10-19','成本','ai-other','其他提报人','不能泄露的其他人周报')");
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES('ai-hidden','隐藏项目','res')");
  await f.admin.query("INSERT INTO public.reports(project_id,period,line,author_id,author_name,change_text) VALUES('ai-hidden','2026-10-19','综合',$1,'本人','已失去项目授权的旧周报')",[user.id]);
  const mine=await loadPlanningAIFacts(f.pool,user,f.scope,query('history',{scope:'mine'}),{now});
  assert.equal(mine.total,3);assert.doesNotMatch(JSON.stringify(mine),/不能泄露|失去项目授权|隐藏项目/);
  await assert.rejects(loadPlanningAIFacts(f.pool,{id:'ai-other'},f.scope,query(),{now}),e=>e.status===403);
});
test('逾期复用有效延期和完成审核口径，不把文字完成当审核完成',async t=>{
  const f=await fixture(t),ops={id:'ai-reviewer'};
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES($1,'匿名审核人','ops','approved')",[ops.id]);
  const base=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now}),meeting=base.items.find(row=>row.kind==='meeting');
  const source=await previewCompletion(f.pool,user,{source_key:meeting.source_key});
  const extension=await requestCompletion(f.pool,user,{source_key:source.source_key,source_version:source.source_version,request_type:'extension',requested_due:'2026-10-30',completion_note:'等待方案核对'});
  await reviewCompletion(f.pool,ops,{id:extension.id,expected_revision:extension.revision,decision:'approve',note:'同意延期'});
  let facts=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now});assert.equal(facts.summary.overdue,0);
  const extended=facts.items.find(row=>row.source_key===meeting.source_key);assert.equal(extended.effective_due,'2026-10-30');assert.equal(extended.extension_approved,true);
  const monthly=facts.items.find(row=>row.kind==='plan'),preview=await previewCompletion(f.pool,user,{source_key:monthly.source_key});
  const application=await requestCompletion(f.pool,user,{source_key:monthly.source_key,source_version:preview.source_version,completion_date:'2026-10-26',completion_note:'匿名完工资料核对'});
  await reviewCompletion(f.pool,ops,{id:application.id,expected_revision:application.revision,decision:'approve',note:'审核完成'});
  facts=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now});assert.equal(facts.summary.completed,1);
  await f.admin.query("UPDATE public.reporter_tasks SET what='方案内容已变更',progress='已完成' WHERE id='c189160c-b758-4017-bf1a-b735813391a7'");
  facts=await loadPlanningAIFacts(f.pool,user,f.scope,query(),{now});assert.equal(facts.summary.completed,1);assert.equal(facts.summary.overdue,1);
});
test('模型只可发起受限只读查询，查询后拒绝循环和不匹配AI补充的修改',async t=>{
  const f=await fixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'planning-ai-lookup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const configPath=path.join(directory,'provider.json');await writeFile(configPath,JSON.stringify({enabled:true,model:'deepseek-flash',api_key:'sk-anonymous-lookup-test-key'}),{mode:0o600});
  const input={project_id:f.scope.project_id,line:f.scope.line,period:f.scope.period,items:[],messages:[{role:'user',content:'汇总我本人事项并分析逾期'}],files:[]};
  let calls=0;const before=(await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.reports r')).rows;
  const fetchImpl=async(url,options)=>{calls++;const body=JSON.parse(options.body);let value;
    if(calls===1)value={reply:'正在查询本人事项。',draft:{items:[]},lookup:query()};
    else{const context=JSON.parse(body.input[0].content);assert.equal(context.server_records.summary.total,3);assert.equal(context.server_records.summary.overdue,1);value={reply:'本人共3项，1项逾期4天。',draft:{items:[]},lookup:query('none')};}
    return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));};
  const result=await planningAIChat(f.pool,user,input,{configPath,fetchImpl,now});assert.equal(calls,2);assert.equal(result.records.summary.total,3);
  assert.deepEqual((await f.admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS rows FROM public.reports r')).rows,before);
  assert.throws(()=>validatePlanningAILookup(query('history',{start:'2026-02-30'})),e=>e.code==='ai_lookup_invalid');
  assert.equal(planningAIReadIntent('再分析本人哪些事项已经逾期',f.scope.period,now).kind,'overdue');
  assert.equal(planningAIReadIntent('查上周周报',f.scope.period,now).start,'2026-10-19');
  const suggestion={reply:'删除',draft:{items:[{id:'monthly:0',progress:'',sources:['本机AI草稿'],operation:'remove',entry_id:'not-owned'}]}};
  assert.throws(()=>validatePlanningAIOutput(suggestion,[{id:'monthly:0'}],['本机AI草稿'],[]),e=>e.code==='ai_output_invalid');
  const applied=[{entry_id:'local-entry-a',id:'monthly:0',text:'AI补充'}];
  const display=validatePlanningAIOutput({reply:'替换设备安装（entry_id: local-entry-a），保留原文。',draft:{items:[{id:'monthly:0',progress:'新进展',sources:['本机AI草稿'],operation:'replace',entry_id:'local-entry-a'}]}},[{id:'monthly:0'}],['本机AI草稿'],applied);
  assert.equal(display.reply,'替换设备安装，保留原文。');
});
