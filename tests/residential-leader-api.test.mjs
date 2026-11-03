import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createApp } from '../server/app.mjs';
import { reportWeekStart } from '../server/database.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const scopeId='zhenghongxu-residential';
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const afterDays=days=>new Date(Date.parse(today()+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const doc=text=>({ops:[{insert:text,attributes:{bold:true}}]});
async function fixture(t) {
  const db=await initializedDatabase();t.after(()=>db.close());
  const admin=testPool(db,null),pool=testPool(db),accounts=await seedDemo(admin);
  // Retain the original comprehensive feedback/approval chain explicitly;
  // merged professional reporting is verified by its own HTTP regression.
  await admin.query("UPDATE app_private.report_scopes SET reporting_mode='comprehensive' WHERE id='zhenghongxu-residential'");
  await admin.query("INSERT INTO public.projects(id,name,project_type,active) VALUES('zhx1','匿名一期','res',true),('zhx2','匿名二期','res',true),('klq','匿名可乐地块','res',true)");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) SELECT 'demo-pm-res',p FROM unnest(ARRAY['zhx1','zhx2','klq']) p");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('demo-pzo','zhx2')");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES('design-pm','匿名设计承办人','pm','approved','设计'),('archived-pm','原档案承办人','pm','approved','设计'),('disabled-pm','停用承办人','pm','approved','设计'),('pending-pm','待审承办人','pm','pending','工程')");
  await admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash,disabled) VALUES('design-pm','design@example.invalid','disposable-directory-only',false),('disabled-pm','disabled@example.invalid','disposable-directory-only',true),('pending-pm','pending@example.invalid','disposable-directory-only',false)");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('design-pm','zhx2'),('archived-pm','zhx2'),('disabled-pm','zhx2'),('pending-pm','zhx2')");
  await admin.query("INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,is_key,note) VALUES('zhx2','保留的待分配原基准','2026-10-24','2026-10-29',false,'原基准说明')");
  const uploadDir=await mkdtemp(path.join(os.tmpdir(),'residential-leader-api-'));
  t.after(()=>rm(uploadDir,{recursive:true,force:true}));
  const server=createApp({pool,config:{uploadDir,authCodeSecret:'isolated-residential-leader-http-secret'}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port,cookies={};
  async function json(route,body,who='demo-ops') {
    const response=await fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json',...(cookies[who]?{cookie:cookies[who]}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),response};
  }
  for(const who of ['demo-ops','demo-president','demo-pzo','demo-pm-res','demo-pm-com']) {
    const account=accounts.find(row=>row.id===who);
    const signed=await json('/api/auth/login',{email:account.email,password:account.password},'anonymous');
    assert.equal(signed.status,200);cookies[who]=signed.response.headers.get('set-cookie').split(';')[0];
  }
  return {db,admin,pool,json};
}
function personalSources(tasks,period,approvedKeys=[]) {
  const S={uid:'demo-pm-res',session:{},profile:{role:'pm',name:'演示住宅经理',discipline:'工程'},pmProject:'zhx1',pmPeriod:period,pmLine:'综合',pmScopeId:scopeId,
    projects:[{id:'zhx1'},{id:'zhx2'},{id:'klq'}],reporterTasks:tasks,reports:[],leaderNotes:[],coordinationTasks:[],followupRows:[]};
  const sandbox={Date,document:{getElementById:()=>null}};sandbox.window=sandbox;vm.createContext(sandbox);
  for(const name of ['rich-text.js','planning-windows.js','reporter-tasks.js'])vm.runInContext(readFileSync(new URL('../web/'+name,import.meta.url),'utf8'),sandbox);
  sandbox.CompletionReview={approved:(key,owner)=>owner==='demo-pm-res' && approvedKeys.includes(key)};
  const rich=sandbox.ZHRichText;
  function weekNo(value) {
    const label=/第(\d+)周/.exec(value || '');if(label)return Number(label[1]);
    const date=new Date(value+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay() || 7));
    return Math.ceil(((date-Date.UTC(date.getUTCFullYear(),0,1))/86400000+1)/7);
  }
  sandbox.ReporterTasks.configure({S,esc:String,richCopy:rich.copy,richItem:rich.field,richCollect:rich.collect,
    weekNo,currentPeriod:()=>period,scopeProjectIds:()=>['zhx1','zhx2','klq'],saveDraft:()=>{},render:()=>{}});
  sandbox.ReporterTasks.prepare();
  return {S,rich,rows:()=>sandbox.ReporterTasks.rows()};
}

test('residential leader HTTP assignment follows the original real-project task, personal group feedback and operator completion chain',async t=>{
  const f=await fixture(t),what='住宅审阅后安排：完成工程资料核对',period=reportWeekStart(today());
  const baseline=JSON.stringify((await f.admin.query("SELECT to_jsonb(m) AS row FROM public.milestones m WHERE project_id='zhx2'")).rows);
  const saved=await f.json('/api/reporter-tasks/save',{project_id:'zhx2',owner_id:'demo-pm-res',meeting_kind:'requirement',title:'住宅领导安排',what,due:afterDays(7),
    rich_text:{v:1,fields:{what:doc(what)}}},'demo-president');
  assert.equal(saved.status,200,JSON.stringify(saved.body));const task=saved.body.data,key='meeting:zhx2:'+task.id;
  assert.equal(task.project_id,'zhx2');assert.equal(task.proposer_id,'demo-president');assert.equal(task.created_by,'demo-president');
  assert.equal(task.proposer_role,'president');assert.equal(task.owner_id,'demo-pm-res');
  const listed=await f.json('/api/reporter-tasks/list',{project_id:'zhx2',meeting_kind:'requirement'},'demo-pm-res');
  assert.equal(listed.status,200);assert.equal(listed.body.data.length,1);assert.equal(listed.body.data[0].id,task.id);
  assert.deepEqual((await f.json('/api/reporter-tasks/list',{meeting_kind:'requirement'},'demo-pm-com')).body.data,[]);
  const personal=personalSources(listed.body.data,period),rows=personal.rows();
  assert.equal(rows.length,1);assert.equal(rows[0].project_id,'zhx2');assert.equal(rows[0].source_key,key);assert.equal(rows[0].source_id,task.id);
  rows[0].progress='当周已整理安排所需资料';rows[0].status='in_progress';rows[0]._rich={...rows[0]._rich,progress:doc(rows[0].progress)};
  const reportValues=personal.rich.collect({project_id:'zhx1',period,line:'综合',report_scope_id:scopeId,biz:{followups:rows}});
  const report=await f.json('/api/db',{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:reportValues},'demo-pm-res');
  assert.equal(report.status,200,JSON.stringify(report.body));assert.equal(report.body.data.length,1);
  assert.equal(report.body.data[0].report_scope_id,scopeId);assert.equal(report.body.data[0].biz.followups[0].source_key,key);
  const live=(await f.json('/api/reporter-tasks/list',{id:task.id},'demo-pm-res')).body.data[0];
  assert.equal(live.progress,rows[0].progress);assert.equal(live.revision,2);assert.equal(live.due,task.due);
  assert.deepEqual(live.rich_text.fields.what,doc(what));assert.deepEqual(live.rich_text.fields.progress,doc(rows[0].progress));
  const preview=await f.json('/api/completions/preview',{source_key:key},'demo-pm-res');
  assert.equal(preview.status,200);assert.equal(preview.body.data.source_key,key);assert.equal(preview.body.data.what,what);
  const requested=await f.json('/api/completions/request',{source_key:key,source_version:preview.body.data.source_version,completion_date:today(),completion_note:'已落实住宅审阅要求'},'demo-pm-res');
  assert.equal(requested.status,200,JSON.stringify(requested.body));const approval=requested.body.data;
  assert.equal(approval.project_id,'zhx2');assert.equal(approval.source_key,key);assert.equal(approval.report_id,null);assert.equal(approval.status,'pending');
  assert.equal((await f.json('/api/completions/review',{id:approval.id,expected_revision:approval.revision,decision:'approve',note:''},'demo-president')).status,403);
  const decision=await f.json('/api/completions/review',{id:approval.id,expected_revision:approval.revision,decision:'approve',note:''});
  assert.equal(decision.status,200);assert.equal(decision.body.data.status,'approved');assert.equal(decision.body.data.effective_status,'approved');
  const closed=(await f.json('/api/reporter-tasks/list',{id:task.id},'demo-pm-res')).body.data[0];
  assert.equal(closed.status,'in_progress','the original task feedback remains; the original completion approval is authoritative');
  assert.equal(closed.id,task.id);assert.equal(closed.project_id,'zhx2');assert.equal(closed.due,task.due);
  assert.equal(personalSources([closed],period,[key]).rows().length,0,'the approved exact original source leaves personal pending synchronization');
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.reports WHERE report_scope_id=$1',[scopeId])).rows[0].n,1);
  assert.equal(JSON.stringify((await f.admin.query("SELECT to_jsonb(m) AS row FROM public.milestones m WHERE project_id='zhx2'")).rows),baseline,'the arrangement does not rewrite or delete the hidden unassigned baseline');
});

test('residential leader HTTP people and assignment retain original project, role and proposer boundaries',async t=>{
  const f=await fixture(t),body={project_id:'zhx2',owner_id:'demo-pm-res',meeting_kind:'requirement',title:'住宅审阅安排',what:'请完成工程事项',due:afterDays(7)};
  const directory=await f.json('/api/project-people/list',{project_id:'zhx2'},'demo-pzo');
  assert.equal(directory.status,200);const people=directory.body.data;
  assert.deepEqual(people.filter(person=>person.role==='pm').map(person=>[person.user_id,person.discipline]).sort(),[['demo-pm-res','工程'],['design-pm','设计']]);
  assert.deepEqual(Object.keys(people[0]).sort(),['user_id','name','role','biz_line','discipline'].sort());
  assert.equal((await f.json('/api/project-people/list',{project_id:'zhx1'},'demo-pzo')).status,403);
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,project_id:'zhx1'},'demo-pzo')).status,403);
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,meeting_kind:'special'},'demo-pzo')).status,403);
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,proposer_id:'demo-president'},'demo-pzo')).status,403);
  assert.equal((await f.json('/api/reporter-tasks/save',body,'demo-pm-res')).status,403);
  assert.equal((await f.json('/api/reporter-tasks/save',body)).status,400,'operator proxy needs the actual proposing leader');
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,discipline:'工程'},'demo-president')).status,400,'profession is an assignee selection, not a new task identity field');
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,owner_id:'disabled-pm'},'demo-president')).status,400);
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,owner_id:'design-pm',project_id:'zhx1'},'demo-president')).status,400);
  const own=await f.json('/api/reporter-tasks/save',body,'demo-pzo');assert.equal(own.status,200);
  assert.equal(own.body.data.proposer_id,'demo-pzo');assert.equal(own.body.data.proposer_role,'pzo');
  const proxy=await f.json('/api/reporter-tasks/save',{...body,proposer_id:'demo-pzo'});assert.equal(proxy.status,200);
  assert.equal(proxy.body.data.created_by,'demo-ops');assert.equal(proxy.body.data.proposer_id,'demo-pzo');
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,id:proxy.body.data.id,expected_revision:proxy.body.data.revision},'demo-president')).status,403,'another leader cannot rewrite the actual proposer arrangement');
  assert.equal((await f.json('/api/reporter-tasks/save',{...body,status:'completed'},'demo-president')).status,400);
});

test('residential leader edits preserve old dates, source formatting and history, and historical report feedback does not overwrite live work',async t=>{
  const f=await fixture(t),what='保留原完成日的住宅安排',due='2025-01-02';
  const first=await f.json('/api/reporter-tasks/save',{project_id:'zhx2',owner_id:'demo-pm-res',meeting_kind:'requirement',title:'原审阅安排',what,due,rich_text:{v:1,fields:{what:doc(what)}}},'demo-pzo');
  assert.equal(first.status,200);const task=first.body.data,key='meeting:zhx2:'+task.id;
  const progress=await f.json('/api/reporter-tasks/save',{id:task.id,project_id:'zhx2',expected_revision:task.revision,progress:'当前真实办理进展',status:'in_progress'},'demo-pm-res');
  assert.equal(progress.status,200);assert.equal(progress.body.data.due,due);assert.deepEqual(progress.body.data.rich_text.fields.what,doc(what));
  const title=await f.json('/api/reporter-tasks/save',{id:task.id,project_id:'zhx2',expected_revision:progress.body.data.revision,title:'领导更新安排标题'},'demo-pzo');
  assert.equal(title.status,200);assert.equal(title.body.data.due,due);
  assert.equal((await f.json('/api/reporter-tasks/save',{id:task.id,project_id:'zhx2',expected_revision:progress.body.data.revision,due:afterDays(10)},'demo-pzo')).status,409);
  assert.equal((await f.json('/api/reporter-tasks/save',{id:task.id,project_id:'zhx2',expected_revision:title.body.data.revision,due:'2026-02-30'},'demo-pzo')).status,400);
  assert.equal((await f.json('/api/reporter-tasks/save',{id:task.id,project_id:'zhx2',expected_revision:title.body.data.revision,due:afterDays(10)},'demo-pm-res')).status,403);
  const historical=await f.json('/api/db',{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:'zhx2',period:'2026-10-12',line:'综合',biz:{followups:[{
    project_id:'zhx2',source_key:key,source_type:'meeting',source_id:task.id,source_revision:1,what,progress:'历史周报原反馈',status:'in_progress'}]}}},'demo-pm-res');
  assert.equal(historical.status,200,JSON.stringify(historical.body));assert.equal(historical.body.data[0].report_scope_id,null);
  const current=(await f.json('/api/reporter-tasks/list',{id:task.id},'demo-pm-res')).body.data[0];
  assert.equal(current.progress,'当前真实办理进展');assert.equal(current.due,due);assert.equal(current.revision,title.body.data.revision);
  assert.equal(current.history[0].data.due,due);assert.equal(current.history[0].data.what,what);
  assert.deepEqual(current.history[0].data.rich_text.fields.what,doc(what));
});
