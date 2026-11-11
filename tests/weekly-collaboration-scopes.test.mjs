import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as Y from 'yjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { confirmMonthlyPlan } from '../server/monthly-plans.mjs';
import { createWeeklyCollaboration } from '../server/weekly-collaboration.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const week = '2026-11-09';
const month = '2026-11';
const operator = { id: 'weekly-operator' };
const retailLead = { id: 'weekly-retail-lead' };
const retailPeer = { id: 'weekly-retail-peer' };
const engineering = { id: 'weekly-engineer' };
const engineeringPeer = { id: 'weekly-engineer-peer' };
const incomplete = { id: 'weekly-partial-member' };
const pilot = { id: 'weekly-038-reporter' };
const customLine = '协同样板管理';
const a = { project_id: 'weekly-retail-a', line: '成本', report_scope_id: null };
const b = { project_id: 'weekly-retail-b', line: '成本', report_scope_id: null };
const custom = { ...a, line: customLine };
const independent = { project_id: 'weekly-housing', line: '工程', report_scope_id: null };
const merged = { project_id: 'zhx1', line: '工程', report_scope_id: 'zhenghongxu-residential' };
const oldPilot = { project_id: 'hf', line: '设计部', report_scope_id: null };
const sourceId = 'shared-source-id';
const progressCell = sourceId + ':prog';
const blockerCell = sourceId + ':blocker';
const denied = error => error.status === 403;
const conflict = error => error.status === 409;
const collaborationGuard = error => error.code === 'P3801' || error.status === 409;

async function fixture(t, through = 39) {
  const database = await initializedDatabase({through:38});
  t.after(() => database.close());
  const admin = testPool(database, null);
  const pool = testPool(database);
  await admin.query(`INSERT INTO public.projects(id,name,project_type,reporting_professions)
    VALUES ($1,'匿名商业甲','com',ARRAY[$2]::text[]), ($3,'匿名商业乙','com',NULL),
      ($4,'匿名独立住宅','res',NULL), ('zhx1','匿名住宅一期','res',NULL),
      ('zhx2','匿名住宅二期','res',NULL), ('klq','匿名住宅三期','res',NULL),
      ('hf','匿名原试点','com',NULL)`, [a.project_id,customLine,b.project_id,independent.project_id]);
  const seed = [
    [operator,'ops',null,null,[]],
    [retailLead,'pm','成本',null,[a.project_id,b.project_id]],
    [retailPeer,'pm','招采',null,[a.project_id]],
    [engineering,'pm',null,'工程',[independent.project_id,'zhx1','zhx2','klq']],
    [engineeringPeer,'pm',null,'工程',[independent.project_id,'zhx1','zhx2','klq']],
    [incomplete,'pm',null,'工程',['zhx1','zhx2']],
    [pilot,'pm','设计部',null,['hf']]
  ];
  for (const [user,role,bizLine,discipline,projects] of seed) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)',[user.id,user.id+'@example.invalid','unused-anonymous-fixture']);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line,discipline) VALUES($1,$1,$2,'approved',$3,$4,$5)",
      [user.id,role,projects[0] ?? null,bizLine,discipline]);
    for (const project of projects) {
      await admin.query('INSERT INTO public.project_members(user_id,project_id) VALUES($1,$2)',[user.id,project]);
    }
  }
  for (const user of [retailLead,retailPeer]) {
    await admin.query('INSERT INTO public.project_reporting_grants(user_id,project_id,line,granted_by) VALUES($1,$2,$3,$4)',
      [user.id,a.project_id,customLine,operator.id]);
  }
  const upgrade = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/039-weekly-collaboration-scopes.sql',import.meta.url),'utf8'));
  };
  if (through === 39) await upgrade();
  return { database, admin, pool, upgrade, service:createWeeklyCollaboration(pool) };
}

function item(label, projectId) {
  return {source_id:sourceId,mod:'原模块',name:label,due:month+'-24',...(projectId ? {project_id:projectId} : {})};
}

function inWeek(scope, selected = week) {
  return {...scope,week:selected};
}

async function confirm(f, user, scope, plannedItem) {
  const {report_scope_id,...identity} = scope;
  return confirmMonthlyPlan(f.pool,user,{...identity,month,items:[plannedItem],...(report_scope_id ? {report_scope_id} : {})});
}

function edit(text) {
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0,text);
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  } finally { doc.destroy(); }
}

function contents(encoded) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc,Buffer.from(encoded,'base64'));
    return doc.getText('content').toString();
  } finally { doc.destroy(); }
}

function standaloneReport(f,user,scope,plan,period=week) {
  const {report_scope_id,...identity} = scope;
  return executeDatabase(f.pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',
    values:{...identity,period,biz:{monthly_plan_id:plan.id,monthly_plan_month:month,
      items:plan.items.map(row=>({...row,prog:'匿名独立周报',blocker:''}))},...(report_scope_id ? {report_scope_id} : {})}});
}

test('运营可以给不同项目和专业分别指定负责人，同周同一事项标识也不会混稿',async t=>{
  const f=await fixture(t), service=f.service;
  const {projects}=await service.catalog(operator,{week});
  assert.ok(projects.find(row=>row.project_id===a.project_id)?.professions.includes(customLine));
  assert.ok(projects.find(row=>row.project_id===b.project_id)?.professions.includes('成本'));
  assert.ok(projects.find(row=>row.project_id===independent.project_id)?.professions.includes('工程'));
  assert.equal(projects.find(row=>row.project_id===independent.project_id)?.professions.includes('综合'),false);
  assert.equal(projects.find(row=>row.project_id==='zhx1')?.report_scope_id,merged.report_scope_id);
  assert.equal(projects.some(row=>['zhx2','klq'].includes(row.project_id)),false);
  await assert.rejects(service.catalog(retailLead,{week}),denied);
  await assert.rejects(service.settings(retailLead,{...inWeek(a),submitter_id:retailLead.id}),denied);
  await assert.rejects(service.settings(operator,{...inWeek(a),submitter_id:retailPeer.id}),denied);
  await assert.rejects(service.open(retailPeer,inWeek(a)),denied);
  await assert.rejects(service.open(retailPeer,inWeek(b)),denied);
  assert.equal((await service.open(retailLead,inWeek(a))).status,'unconfigured');

  const cases=[[a,retailLead,'商业甲成本'],[b,retailLead,'商业乙成本'],[custom,retailPeer,'商业甲自定义专业'],
    [independent,engineering,'独立住宅工程']];
  const operationId=randomUUID();
  for (const [scope,owner,label] of cases) {
    const plan=await confirm(f,owner,scope,item(label));
    const config=await service.settings(operator,{...inWeek(scope),submitter_id:owner.id});
    assert.equal(config.submitter_id,owner.id);
    assert.equal(config.status,'ready');
    const snapshot=await service.open(owner,inWeek(scope));
    assert.equal(snapshot.plan.id,plan.id);
    assert.equal(snapshot.plan.items[0].name,label);
    await service.change(owner,{...inWeek(scope),plan_id:plan.id,cell:progressCell,update:edit(label+'进展'),operation_id:operationId});
  }
  for (const [scope,owner,label] of cases) {
    const room=await service.open(owner,inWeek(scope));
    assert.equal(contents(room.cells[progressCell]),label+'进展');
  }
  const costRoom=await service.open(retailLead,inWeek(a));
  await assert.rejects(standaloneReport(f,retailLead,a,costRoom.plan),collaborationGuard);
  const legacyHousing=(await executeDatabase(f.pool,engineering,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',
    values:{project_id:independent.project_id,period:week,line:'综合',change_text:'匿名原住宅综合周报'}}))[0];
  assert.equal(legacyHousing.line,'综合');
  const shared=await service.open(retailLead,inWeek(custom));
  assert.equal(shared.can_publish,false);
  const draft=await service.open(retailPeer,inWeek(custom));
  const request={...inWeek(custom),plan_id:draft.plan.id,revision:draft.revision,operation_id:randomUUID()};
  await assert.rejects(service.publish(retailLead,request),denied);
  const submissions=[request,{...request,operation_id:randomUUID()}];
  const results=await Promise.allSettled(submissions.map(body=>service.publish(retailPeer,body)));
  const accepted=results.findIndex(result=>result.status==='fulfilled');
  assert.notEqual(accepted,-1);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.ok(conflict(results.find(result=>result.status==='rejected').reason));
  const published=results[accepted].value;
  assert.equal(published.report.project_id,a.project_id);
  assert.equal(published.report.author_id,retailPeer.id);
  assert.equal(published.report.line,customLine);
  assert.equal(published.report.biz.items[0].prog,'商业甲自定义专业进展');
  assert.equal((await service.publish(retailPeer,submissions[accepted])).report.id,published.report.id);
  assert.equal((await service.open(retailLead,inWeek(custom))).report.id,published.report.id);
  const rows=await f.admin.query("SELECT count(*)::int count FROM public.reports WHERE project_id=$1 AND line=$2",[a.project_id,customLine]);
  assert.equal(rows.rows[0].count,1);

  const nextWeek='2026-11-16';
  const activationRace=await Promise.allSettled([
    service.settings(operator,{...inWeek(a,nextWeek),submitter_id:retailLead.id}),
    standaloneReport(f,retailLead,a,costRoom.plan,nextWeek)
  ]);
  assert.equal(activationRace.filter(result=>result.status==='fulfilled').length,1);
  assert.ok(collaborationGuard(activationRace.find(result=>result.status==='rejected').reason));
});

test('专业合并项目要求所有分期原授权，正式周报保留每条事项的实际分期',async t=>{
  const f=await fixture(t), service=f.service;
  const plan=await confirm(f,engineering,merged,item('匿名二期工程事项','zhx2'));
  const settings=await service.settings(operator,{...inWeek(merged),submitter_id:engineering.id});
  assert.equal(settings.status,'ready');
  assert.ok(settings.eligible.some(row=>row.user_id===engineeringPeer.id));
  assert.equal(settings.eligible.some(row=>row.user_id===incomplete.id),false);
  await assert.rejects(service.open(incomplete,inWeek(merged)),denied);
  await assert.rejects(service.open(engineering,inWeek({...merged,report_scope_id:null})),denied);
  await assert.rejects(service.open(engineering,inWeek({...merged,project_id:'zhx2'})),denied);
  await service.change(engineeringPeer,{...inWeek(merged),plan_id:plan.id,cell:blockerCell,update:edit('匿名二期机电问题'),operation_id:randomUUID()});
  const room=await service.open(engineering,inWeek(merged));
  const saved=(await service.publish(engineering,{...inWeek(merged),plan_id:plan.id,revision:room.revision,operation_id:randomUUID()})).report;
  assert.equal(saved.project_id,'zhx1');
  assert.equal(saved.report_scope_id,merged.report_scope_id);
  assert.deepEqual(saved.scope_project_ids,['zhx1','zhx2','klq']);
  assert.deepEqual(saved.biz.monthly_plan_ids,[plan.id]);
  assert.equal(saved.biz.items[0].project_id,'zhx2');
  assert.equal(saved.biz.items[0].blocker,'匿名二期机电问题');
  assert.equal((await service.open(engineeringPeer,inWeek(merged))).report.id,saved.id);
  await f.admin.query("DELETE FROM public.project_members WHERE user_id=$1 AND project_id='klq'",[engineeringPeer.id]);
  await assert.rejects(service.open(engineeringPeer,inWeek(merged)),denied);
});

test('038 的活动草稿、操作历史及已发布周报经过 039 重复迁移仍保持原身份',async t=>{
  const f=await fixture(t,38), editableWeek='2026-11-02';
  const plan=await confirm(f,pilot,oldPilot,item('原试点已确认事项'));
  const encoded=edit('原试点草稿正文');
  const editId=randomUUID();
  const publishedId=randomUUID();
  const publishFingerprint=createHash('sha256').update(JSON.stringify(['publish',2,plan.id,week,[]])).digest('hex');
  await f.admin.query(`INSERT INTO app_private.hongfang_weekly_drafts(week,submitter_id,configured_by,revision,plan_id,cells)
    VALUES($1,$2,$3,2,$4,$5::jsonb),($6,$2,$3,2,$4,$5::jsonb)`,
    [editableWeek,pilot.id,operator.id,plan.id,JSON.stringify({[progressCell]:encoded}),week]);
  await f.admin.query(`INSERT INTO app_private.hongfang_weekly_operations(week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash)
    VALUES($1,$2,$3,'匿名原协作者','edit',2,$4,$5)`,
    [editableWeek,editId,pilot.id,progressCell,createHash('sha256').update(JSON.stringify(['edit',plan.id,progressCell,encoded])).digest('hex')]);
  const original=await withIdentity(f.pool,pilot.id,async client=>{
    await client.query(`INSERT INTO app_private.hongfang_weekly_operations(week,operation_id,actor_id,actor_name,kind,revision,payload_hash)
      VALUES($1,$2,$3,'匿名原负责人','publish',3,$4)`,[week,publishedId,pilot.id,publishFingerprint]);
    await client.query("SELECT set_config('app.hongfang_weekly_publish',$1,true)",[publishedId]);
    const row=(await client.query(`INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz)
      VALUES('hf',$1,'设计部',$2,'匿名原负责人',$3::jsonb) RETURNING *`,[week,pilot.id,JSON.stringify({
      monthly_plan_id:plan.id,monthly_plan_month:month,items:[{...plan.items[0],prog:'原试点草稿正文',blocker:''}],
      weekly_collaboration:{week,revision:2}
    })])).rows[0];
    await client.query(`UPDATE app_private.hongfang_weekly_drafts
      SET revision=3,published_revision=2,published_report_id=$1 WHERE week=$2`,[row.id,week]);
    return row;
  });
  const oldDrafts=(await f.admin.query('SELECT to_jsonb(d) row FROM app_private.hongfang_weekly_drafts d ORDER BY week')).rows;
  const oldOperations=(await f.admin.query('SELECT to_jsonb(o) row FROM app_private.hongfang_weekly_operations o ORDER BY week')).rows;
  await f.upgrade();
  await f.upgrade();
  assert.deepEqual((await f.admin.query(`SELECT to_jsonb(d)-'project_id'-'line'-'report_scope_id' row
    FROM app_private.weekly_collaboration_drafts d WHERE project_id='hf' AND line='设计部' ORDER BY week`)).rows,oldDrafts);
  assert.deepEqual((await f.admin.query(`SELECT to_jsonb(o)-'project_id'-'line' row
    FROM app_private.weekly_collaboration_operations o WHERE project_id='hf' AND line='设计部' ORDER BY week`)).rows,oldOperations);
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(d) row FROM app_private.hongfang_weekly_drafts d ORDER BY week')).rows,oldDrafts);
  assert.deepEqual((await f.admin.query('SELECT to_jsonb(o) row FROM app_private.hongfang_weekly_operations o ORDER BY week')).rows,oldOperations);
  assert.deepEqual((await f.admin.query('SELECT * FROM public.reports WHERE id=$1',[original.id])).rows[0],original);
  const ready=await f.service.open(pilot,{week:editableWeek});
  assert.equal(ready.status,'ready');
  assert.equal(contents(ready.cells[progressCell]),'原试点草稿正文');
  assert.equal((await f.service.change(pilot,{week:editableWeek,plan_id:plan.id,cell:progressCell,update:encoded,operation_id:editId})).revision,2);
  const prior=await f.service.open(pilot,{week});
  assert.equal(prior.status,'published');
  assert.equal(prior.report.id,original.id);
  assert.equal((await f.service.publish(pilot,{week,plan_id:plan.id,revision:2,operation_id:publishedId})).report.id,original.id);
  const more=await f.service.change(pilot,{week:editableWeek,plan_id:plan.id,cell:blockerCell,update:edit('升级后的新记录'),operation_id:randomUUID()});
  await f.upgrade();
  const restored=await f.service.open(pilot,{week:editableWeek});
  assert.equal(restored.revision,more.revision);
  assert.equal(contents(restored.cells[blockerCell]),'升级后的新记录');
});

test('同一账号两个标签页保持不同焦点时，空闲长轮询不会连续自唤醒',async t=>{
  const f=await fixture(t);
  await confirm(f,retailLead,a,item('匿名同账号标签页校验'));
  await f.service.settings(operator,{...inWeek(a),submitter_id:retailLead.id});
  const first={...inWeek(a),tab_id:randomUUID(),active_cell:progressCell};
  const second={...inWeek(a),tab_id:randomUUID(),active_cell:blockerCell};
  await f.service.open(retailLead,first);
  const stable=await f.service.open(retailLead,second);
  assert.equal((await f.service.open(retailLead,first)).cursor,stable.cursor);
  const controller=new AbortController();
  const elapsed=performance.now();
  const timer=setTimeout(()=>controller.abort(),180);
  try {
    const poll=body=>f.service.poll(retailLead,{...body,since_revision:stable.revision,since_cursor:stable.cursor},controller.signal);
    assert.deepEqual(await Promise.all([poll(first),poll(second)]),[null,null]);
    assert.ok(performance.now()-elapsed>=140,'空闲轮询应保持等待，直到外部取消');
  } finally { clearTimeout(timer); }
});
