import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { resolveCompletionSource, preloadOperatorCompletionSources } from '../server/completion-sources.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { previewCompletion, requestCompletion, listCompletions } from '../server/completions.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

process.env.TZ = 'Asia/Shanghai';
const instant = '2026-10-20T08:00:00Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return Date.parse(instant); }
}
function harness(overrides = {}) {
  const S = { uid:'owner', session:{}, profile:{name:'匿名承办人',role:'pm'}, pmProject:'zhx1',pmPeriod:'第43周',pmLine:'综合',pmScopeId:'zhenghongxu-residential',
    projects:[{id:'zhx1',name:'一期'},{id:'zhx2',name:'二期'},{id:'klq',name:'可乐地块'},{id:'other',name:'其他项目'}],
    leaderNotes:[],reports:[],reporterTasks:[],coordinationTasks:[],followupRows:[] };
  const messages=[], elements={};
  const sandbox={Date:FixedDate,document:{getElementById:id=>elements[id] || null}};sandbox.window=sandbox;
  vm.createContext(sandbox);
  for(const name of ['rich-text.js','planning-windows.js','reporter-tasks.js'])vm.runInContext(readFileSync(new URL('../web/'+name,import.meta.url),'utf8'),sandbox);
  const rich=sandbox.ZHRichText, api=sandbox.ReporterTasks;
  const options={S,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),richCopy:rich.copy,richItem:rich.field,
    richCollect:row=>rich.collect(JSON.parse(JSON.stringify(row))),weekNo:period=>Number(/第(\d+)周/.exec(period || '')?.[1]) || null,
    currentPeriod:()=>'第43周',scopeProjectIds:()=>S.pmScopeId?['zhx1','zhx2','klq']:[S.pmProject],render:()=>{},saveDraft:()=>{},
    toast:(...args)=>messages.push(args),reloadSources:async()=>{},...overrides};
  api.configure(options);return {S,api,rich,options,sandbox,elements,messages};
}
function meeting(project,id='same',extra={}) { return {project_id:project,id,owner_id:'owner',title:'同名会议事项',what:'原项目任务',progress:'原会议进展',status:'open',revision:1,created_at:instant,updated_at:instant,...extra}; }
function feedback(key,extra={}) { return {source_key:key,source_type:'meeting',source_id:key.split(':').at(-1),title:'同名会议事项',what:'原项目任务',progress:'已保存反馈',status:'in_progress',source_revision:1,...extra}; }
function previous(project,rows,extra={}) { return {id:project,project_id:project,author_id:'owner',line:'综合',period:'第42周',submitted_at:'2026-10-13T08:00:00Z',biz:{followups:rows},...extra}; }

test('one group synchronizes members by original project/source IDs without adopting outside sources',()=>{
  const h=harness();
  h.S.reporterTasks=['zhx1','zhx2','klq','other'].map(project=>meeting(project));
  h.S.leaderNotes=[{project_id:'zhx2',id:'leader-id',owner_id:'owner',what:'原二期安排',period:'第43周',created_at:instant}];
  h.S.coordinationTasks=[{project_id:'klq',id:'coord-id',owner_id:'owner',what:'原可乐协调',source_key:'coord:klq:coord-id'}];
  h.S.reports=[{project_id:'zhx2',id:'17',author_id:'someone',period:'第43周',submitted_at:instant,
    coord_items:[{source_id:'old-coord',who_id:'owner',what:'旧二期原来源'}]}];
  h.api.prepare();
  assert.equal(h.S.followupRows.length,5);
  assert.deepEqual(new Set(h.S.followupRows.map(row=>row.source_key)),new Set([
    'meeting:zhx1:same','meeting:zhx2:same','meeting:klq:same','coord:klq:coord-id','coord:zhx2:17:coord:old-coord']));
  const html=h.api.formHtml();assert.match(html,/二期/);assert.match(html,/可乐地块/);assert.doesNotMatch(html,/meeting:other/);
  assert.equal(h.S.followupRows.find(row=>row.source_key==='coord:zhx2:17:coord:old-coord').project_id,'zhx2');
});

test('new group feedback does not splice the three legacy report snapshots or another scope',()=>{
  const h=harness();h.S.reporterTasks=['zhx1','zhx2','klq'].map(project=>meeting(project));
  h.S.reports=['zhx1','zhx2','klq'].map(project=>previous(project,[feedback('meeting:'+project+':same',{progress:'旧单项报告内容'})]));
  h.S.reports.push(previous('zhx1',[feedback('meeting:zhx1:same',{progress:'另一范围报告'})],{id:'unrelated',report_scope_id:'other-scope'}));
  const before=JSON.stringify(h.S.reports);h.api.prepare();
  assert.equal(h.S.followupRows.length,3);assert.equal(h.S.followupRows.every(row=>row.progress==='原会议进展'),true);
  assert.equal(JSON.stringify(h.S.reports),before);
});

test('same-scope prior feedback preserves explicit blanks and rich text by exact source key',()=>{
  const h=harness();h.S.reporterTasks=['zhx1','zhx2'].map(project=>meeting(project));
  const formatted=feedback('meeting:zhx2:same',{_rich:{progress:{ops:[{insert:'已保存反馈',attributes:{bold:true}},{insert:'\n'}]}}});
  h.S.reports=[previous('zhx1',[feedback('meeting:zhx1:same',{progress:''}),formatted],{report_scope_id:h.S.pmScopeId})];
  h.api.prepare();
  assert.equal(h.S.followupRows.find(row=>row.source_key==='meeting:zhx1:same').progress,'');
  const row=h.S.followupRows.find(row=>row.source_key==='meeting:zhx2:same');assert.equal(row.progress,'已保存反馈');
  assert.match(h.rich.field(row,'progress'),/<strong>已保存反馈<\/strong>/);
});

test('member meeting updates synchronize once, while a different report scope cannot receive the late update',()=>{
  const h=harness();h.S.reporterTasks=[meeting('zhx2')];h.api.prepare();
  const update=meeting('zhx2','same',{progress:'服务端新进展',revision:2});h.S.reporterTasks=[update];
  const scope={project:'zhx1',period:'第43周',line:'综合',reportScope:h.S.pmScopeId};
  assert.equal(h.api.syncSavedTask(update,h.S.followupRows[0],scope),true);
  assert.equal(h.S.followupRows.length,1);assert.equal(h.S.followupRows[0].progress,'服务端新进展');
  h.S.pmScopeId='';const before=JSON.stringify(h.S.followupRows);
  assert.equal(h.api.syncSavedTask(update,null,scope),false);assert.equal(JSON.stringify(h.S.followupRows),before);
});

test('source refresh keeps a replacement single-project form untouched when its group identity changed',async()=>{
  let finish;const h=harness({reloadSources:()=>new Promise(resolve=>{finish=resolve;})});
  h.S.reporterTasks=[meeting('zhx2')];h.api.prepare();const pending=h.api.refreshSources();
  h.S.pmScopeId='';h.S.followupRows=[feedback('leader:zhx1:replacement',{progress:'切换后的原单项草稿'})];
  const before=JSON.stringify(h.S.followupRows);finish();await pending;
  assert.equal(JSON.stringify(h.S.followupRows),before);assert.equal(h.messages.length,0);
});

// Resolver-level doubles keep the source hash assertion independent of the new
// scope schema; the companion database suite exercises RLS on a disposable DB.
function resolverFixture(memberProjects=['zhx1','zhx2','klq']) {
  const report={id:'21',project_id:'zhx1',period:'第43周',author_id:'owner',author_name:'匿名承办人',line:'综合',coord_items:[],
    biz:{items:[{source_id:'stable-item',name:'原事项',mod:'工程',due:'2026-10-30',prog:'反馈'}]},rich_text:null,
    report_scope_id:'zhenghongxu-residential',scope_project_ids:['zhx1','zhx2','klq']};
  const profiles=[{user_id:'operator',name:'匿名运营',role:'ops',status:'approved'},{user_id:'owner',name:'匿名承办人',role:'pm',status:'approved'}];
  const client={async query(sql,values) {
    if(sql.includes('FROM public.profiles'))return {rows:sql.includes('ANY(')?profiles.filter(row=>values[0].includes(row.user_id)):profiles.filter(row=>row.user_id===values[0])};
    if(sql.includes('FROM public.projects'))return {rows:[{id:'zhx1',project_type:'res'}]};
    if(sql.includes('FROM public.project_members')) {
      if(sql.startsWith('SELECT project_id'))return {rows:memberProjects.map(project_id=>({project_id}))};
      if(sql.startsWith('SELECT user_id,project_id'))return {rows:memberProjects.map(project_id=>({user_id:'owner',project_id}))};
      return {rows:memberProjects.includes(values[0])?[{user_id:'owner'}]:[]};
    }
    if(sql.includes('FROM public.reports'))return {rows:[report]};
    if(sql.includes('FROM public.completion_requests'))return {rows:[]};
    throw new Error('Unexpected test query: '+sql);
  }};
  return {client,report,key:'plan:zhx1:21:items:stable-item'};
}

test('completion source retains its original hash when scope ACL metadata is added',async()=>{
  const f=resolverFixture(),user={id:'operator'};
  const group=await resolveCompletionSource(f.client,user,f.key,{forOwnerId:'owner'});
  f.report.report_scope_id=null;f.report.scope_project_ids=null;
  const legacy=await resolveCompletionSource(f.client,user,f.key,{forOwnerId:'owner'});
  assert.equal(group.source_key,f.key);assert.equal(group.source_version,legacy.source_version);
  assert.deepEqual(group.source_snapshot,legacy.source_snapshot);
  assert.equal(Object.hasOwn(group.source_snapshot,'scope_project_ids'),false);
});

test('operator cannot resolve a full group report for an owner with only anchor membership',async()=>{
  const f=resolverFixture(['zhx1']);
  await assert.rejects(resolveCompletionSource(f.client,{id:'operator'},f.key,{forOwnerId:'owner'}),error=>error.status===403);
});

test('preloaded report sources carry ACL scope metadata and cannot bypass owner group checks',async()=>{
  const f=resolverFixture(['zhx1']),cache=new Map();
  await preloadOperatorCompletionSources(f.client,{id:'operator'},[{source_key:f.key,owner_id:'owner',project_id:'zhx1'}],cache);
  assert.equal(cache.get('member:operator:owner:zhx1'),true);
  assert.deepEqual(cache.get('source:operator:report:zhx1:21').scope_project_ids,['zhx1','zhx2','klq']);
  await assert.rejects(resolveCompletionSource(f.client,{id:'operator'},f.key,{forOwnerId:'owner',cache}),error=>error.status===403);
});

test('disposable database preserves group report completion identity and blocks lost member access through preview/review',async t=>{
  const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
  // This fixture exercises retained comprehensive source identities on the
  // latest schema; professional scope submissions have separate regressions.
  await admin.query("UPDATE app_private.report_scopes SET reporting_mode='comprehensive' WHERE id='zhenghongxu-residential'");
  await admin.query("INSERT INTO public.projects(id,name,project_type,active) VALUES('zhx1','匿名一期','res',true),('zhx2','匿名二期','res',true),('klq','匿名可乐地块','res',true)");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES('owner','匿名填报人','pm','approved','工程'),('partial','匿名部分授权','pm','approved','工程'),('operator','匿名运营','ops','approved',null)");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) SELECT 'owner',p FROM unnest(ARRAY['zhx1','zhx2','klq']) p");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES('partial','zhx1')");
  const report=(await executeDatabase(pool,{id:'owner'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{
    project_id:'zhx1',period:'2026-10-19',line:'综合',report_scope_id:'zhenghongxu-residential',
    biz:{items:[{source_id:'original-scope-item',project_id:'zhx2',name:'原二期事项',mod:'工程',due:'2026-10-30',prog:'已填报进展'}]}}}))[0];
  const key='plan:zhx1:'+report.id+':items:original-scope-item';
  const preview=await previewCompletion(pool,{id:'owner'},{source_key:key});
  assert.equal(preview.source_key,key);assert.equal(preview.what,'原二期事项');
  await assert.rejects(previewCompletion(pool,{id:'partial'},{source_key:key}),error=>[403,404].includes(error.status));
  const submitted=await requestCompletion(pool,{id:'owner'},{source_key:key,source_version:preview.source_version,completion_date:'2026-10-22',completion_note:'隔离申报'});
  assert.equal(String(submitted.report_id),String(report.id));assert.equal(submitted.source_key,key);
  assert.deepEqual(await listCompletions(pool,{id:'partial'},{id:submitted.id}),[],'anchor-only access cannot read the stored group source snapshot');
  const snapshot=JSON.stringify(submitted.source_snapshot);
  await admin.query("DELETE FROM public.project_members WHERE user_id='owner' AND project_id='klq'");
  await assert.rejects(previewCompletion(pool,{id:'owner'},{source_key:key}),error=>[403,404].includes(error.status));
  assert.deepEqual(await listCompletions(pool,{id:'owner'},{id:submitted.id}),[],'loss of a member permission also protects the previously stored snapshot');
  await assert.rejects(withIdentity(pool,'operator',client=>resolveCompletionSource(client,{id:'operator'},key,{forOwnerId:'owner'})),error=>error.status===403);
  const reviewed=(await listCompletions(pool,{id:'operator'},{id:submitted.id}))[0];
  assert.equal(reviewed.source_access_lost,true);assert.equal(reviewed.status,'pending');
  assert.equal(JSON.stringify(reviewed.source_snapshot),snapshot,'original approval source snapshot is retained unchanged');
});

test('actual group coordination and handover sources submit by original report key and real member project',async t=>{
  const db=await initializedDatabase();t.after(()=>db.close());const admin=testPool(db,null),pool=testPool(db);
  await admin.query("UPDATE app_private.report_scopes SET reporting_mode='comprehensive' WHERE id='zhenghongxu-residential'");
  await admin.query("INSERT INTO public.projects(id,name,project_type,active) VALUES('zhx1','匿名一期','res',true),('zhx2','匿名二期','res',true),('klq','匿名可乐地块','res',true),('outside','其他项目','res',true)");
  await admin.query("INSERT INTO public.profiles(user_id,name,role,status,discipline) VALUES('owner','匿名承办人','pm','approved','工程'),('source-author','匿名来源作者','pm','approved','工程')");
  await admin.query("INSERT INTO public.project_members(user_id,project_id) SELECT u,p FROM unnest(ARRAY['owner','source-author']) u CROSS JOIN unnest(ARRAY['zhx1','zhx2','klq']) p");
  const values={project_id:'zhx1',period:'第43周（10.19–10.25）',line:'综合',report_scope_id:'zhenghongxu-residential',
    coord_items:[{source_id:'original-coord',project_id:'zhx2',who_id:'owner',who:'匿名承办人',what:'同名成员来源',by:'2026-10-30'}],
    biz:{handover:[{source_id:'original-hand',project_id:'klq',to:'匿名承办人',what:'同名成员来源',due:'2026-10-31'}]}};
  let source=(await executeDatabase(pool,{id:'source-author'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values}))[0];
  // Retained rows may predate stable item IDs; their original content-derived
  // source key must remain usable rather than being rebound to an array index.
  await admin.query('UPDATE public.reports SET coord_items=coord_items || $1::jsonb WHERE id=$2',[JSON.stringify([
    {project_id:'klq',who_id:'owner',who:'匿名承办人',what:'旧格式原协调',by:'2026-10-29'}]),source.id]);
  source=(await admin.query('SELECT * FROM public.reports WHERE id=$1',[source.id])).rows[0];
  const h=harness();h.S.pmPeriod='第44周（10.26–11.01）';h.S.reports=[source];h.api.prepare();
  const rows=JSON.parse(JSON.stringify(h.api.rows()));
  assert.equal(rows.length,3);
  const coordination=rows.find(row=>row.source_id==='original-coord'),handover=rows.find(row=>row.source_id==='original-hand');
  assert.equal(coordination.project_id,'zhx2');assert.equal(coordination.source_key,'coord:zhx1:'+source.id+':coord:original-coord');
  assert.equal(handover.project_id,'klq');assert.equal(handover.source_key,'coord:zhx1:'+source.id+':handover:original-hand');
  const legacy=rows.find(row=>row.source_id.startsWith('legacy-'));
  assert.equal(legacy.project_id,'klq');assert.equal(legacy.source_key,'coord:zhx1:'+source.id+':coord:'+legacy.source_id);
  const beforeVersions=await Promise.all(rows.map(row=>previewCompletion(pool,{id:'owner'},{source_key:row.source_key}).then(row=>row.source_version)));
  rows.forEach(row=>{row.progress='保留原来源的本期跟进';});
  const save=(followups,period=h.S.pmPeriod)=>executeDatabase(pool,{id:'owner'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{
    project_id:'zhx1',period,line:'综合',report_scope_id:'zhenghongxu-residential',biz:{followups}}});
  const saved=(await save(rows))[0];
  assert.deepEqual(saved.biz.followups.map(row=>[row.project_id,row.source_key]),rows.map(row=>[row.project_id,row.source_key]));
  assert.deepEqual(await Promise.all(rows.map(row=>previewCompletion(pool,{id:'owner'},{source_key:row.source_key}).then(row=>row.source_version))),beforeVersions,'saving feedback does not alter the original source approval hash');
  const stored=JSON.stringify((await admin.query('SELECT to_jsonb(r) AS row FROM public.reports r WHERE id=$1',[saved.id])).rows[0].row);
  for(const forged of [
    {...coordination,project_id:'klq'},
    {...coordination,project_id:'outside'},
    {...coordination,source_key:'coord:zhx1:999999:coord:original-coord'},
    {...coordination,source_id:'missing-item',source_key:'coord:zhx1:'+source.id+':coord:missing-item'},
    {...coordination,source_key:'coord:zhx1:10000000-0000-4000-8000-000000000001'}
  ])await assert.rejects(save([forged]),error=>[400,403,404].includes(error.status));
  assert.equal(JSON.stringify((await admin.query('SELECT to_jsonb(r) AS row FROM public.reports r WHERE id=$1',[saved.id])).rows[0].row),stored,'invalid source projects cannot change the saved report/history');
  const original=(await admin.query('SELECT coord_items,biz FROM public.reports WHERE id=$1',[source.id])).rows[0];
  assert.equal(original.coord_items[0].project_id,'zhx2');assert.equal(original.coord_items[0].source_id,'original-coord');
  assert.equal(original.biz.handover[0].project_id,'klq');assert.equal(original.biz.handover[0].source_id,'original-hand');
  await executeDatabase(pool,{id:'source-author'},{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{...values,coord_items:[],biz:{handover:[]}}});
  const retained=rows.map(row=>({...row,source_missing:true,progress:'原来源移除后仍保留原跟进'}));
  const resubmitted=(await save(retained))[0];
  assert.deepEqual(resubmitted.biz.followups.map(row=>[row.project_id,row.source_key]),rows.map(row=>[row.project_id,row.source_key]),'removed sources retain their proven original projects and keys');
  const nextReport=(await save(retained,'第45周（11.02–11.08）'))[0];
  assert.notEqual(nextReport.id,saved.id);
  assert.deepEqual(nextReport.biz.followups.map(row=>[row.project_id,row.source_key]),rows.map(row=>[row.project_id,row.source_key]),'a new report can still validate exact original source items preserved only in source history');
});
