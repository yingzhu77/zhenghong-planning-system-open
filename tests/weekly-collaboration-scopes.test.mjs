import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as Y from 'yjs';
import { previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';
import { createCoordinationTask } from '../server/coordination-tasks.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { confirmMonthlyPlan, withdrawMonthlyPlan } from '../server/monthly-plans.mjs';
import { listReportAttachments } from '../server/report-attachments.mjs';
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

async function fixture(t, through = 46) {
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
  if (through >= 39) await upgrade();
  if (through >= 40) await database.exec(await readFile(new URL('../db/040-materials-only-viewers.sql',import.meta.url),'utf8'));
  const upgradeItems = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/041-weekly-collaboration-items.sql',import.meta.url),'utf8'));
  };
  if (through >= 41) await upgradeItems();
  const upgradeMonths = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/042-shared-monthly-plans.sql',import.meta.url),'utf8'));
  };
  if (through >= 42) await upgradeMonths();
  if (through >= 43) await database.exec(await readFile(new URL('../db/043-personnel-directory.sql',import.meta.url),'utf8'));
  const upgradeWithdrawals = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/044-weekly-report-withdrawal.sql',import.meta.url),'utf8'));
  };
  if (through >= 44) await upgradeWithdrawals();
  const upgradeSupplements = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/045-weekly-collaboration-supplements.sql',import.meta.url),'utf8'));
  };
  if (through >= 45) await upgradeSupplements();
  const upgradeFollowups = async () => {
    await database.exec('RESET ROLE');
    await database.exec(await readFile(new URL('../db/046-weekly-collaboration-followups.sql',import.meta.url),'utf8'));
  };
  if (through >= 46) await upgradeFollowups();
  return { database, admin, pool, upgrade, upgradeItems, upgradeMonths, upgradeWithdrawals, upgradeSupplements, upgradeFollowups,
    service:createWeeklyCollaboration(pool) };
}

function item(label, projectId) {
  return {source_id:sourceId,mod:'原模块',name:label,due:month+'-24',...(projectId ? {project_id:projectId} : {})};
}

function inWeek(scope, selected = week) {
  return {...scope,week:selected};
}

test('只提前显示北京时间下一周中本人可以协同的项目专业',async t=>{
  const f=await fixture(t), service=f.service;
  const {current,next,later}=(await f.admin.query(`SELECT monday::text AS current,(monday+7)::text AS next,(monday+14)::text AS later
    FROM (SELECT date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date AS monday) dates`)).rows[0];
  await service.settings(operator,{...inWeek(a,next),submitter_id:retailLead.id,member_ids:[]});
  await service.settings(operator,{...inWeek(custom,next),submitter_id:retailLead.id,member_ids:[retailPeer.id]});
  await service.settings(operator,{...inWeek(merged,next),submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  await service.settings(operator,{...inWeek(independent,current),submitter_id:engineering.id});
  await service.settings(operator,{...inWeek(b,later),submitter_id:retailLead.id});
  assert.deepEqual(await service.nextWeek(retailLead),{week:next,rooms:[custom,a].sort((x,y)=>x.line<y.line?-1:1)});
  assert.deepEqual(await service.nextWeek(retailPeer),{week:next,rooms:[custom]});
  assert.deepEqual(await service.nextWeek(engineeringPeer),{week:next,rooms:[merged]});
  for (const user of [operator,incomplete,pilot]) assert.deepEqual(await service.nextWeek(user),{week:null,rooms:[]});
  await service.settings(operator,{...inWeek(custom,next),submitter_id:retailLead.id,member_ids:[]});
  assert.deepEqual(await service.nextWeek(retailPeer),{week:null,rooms:[]});
});

async function confirm(f, user, scope, plannedItem) {
  const {report_scope_id,...identity} = scope;
  return confirmMonthlyPlan(f.pool,user,{...identity,month,items:[plannedItem],...(report_scope_id ? {report_scope_id} : {})});
}

async function currentWeekAndSiblings(f) {
  return (await f.admin.query(`WITH calendar AS (
    SELECT date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date AS monday
  )
  SELECT monday::text AS current,ARRAY(SELECT sibling::date::text
    FROM generate_series(date_trunc('month',monday)::date,(date_trunc('month',monday)+interval '1 month - 1 day')::date,
      interval '1 day') AS dates(sibling)
    WHERE extract(isodow from sibling)=1 AND sibling::date<>monday
    ORDER BY sibling) AS siblings FROM calendar`)).rows[0];
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

test('本周负责人可撤回已提交周报，保留共享稿和附件，组员修改后重新提交',async t=>{
  const f=await fixture(t), {service}=f;
  const {current,prior}=(await f.admin.query(`SELECT monday::text AS current,(monday-7)::text AS prior
    FROM (SELECT date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date AS monday) dates`)).rows[0];
  const scope=inWeek(custom,current), month=current.slice(0,7);
  const plan=await confirmMonthlyPlan(f.pool,retailLead,{
    project_id:scope.project_id,line:scope.line,month,items:[{...item('待重新提交的原计划事项'),due:month+'-24'}]
  });
  await service.settings(operator,{...scope,submitter_id:retailLead.id,member_ids:[retailPeer.id]});
  const draft=await service.change(retailPeer,{...scope,plan_id:plan.id,cell:progressCell,
    update:edit('原提交进展'),operation_id:randomUUID()});
  const attachment=randomUUID();
  await f.admin.query(`INSERT INTO public.report_attachments(id,project_id,period,line,owner_id,name,mime,size,storage_key)
    VALUES ($1,$2,$3,$4,$5,'匿名验收.png','image/png',100,$6)`,
  [attachment,scope.project_id,current,scope.line,retailLead.id,'report-attachments/'+attachment+'.png']);
  const publish=revision=>service.publish(retailLead,{...scope,plan_id:plan.id,revision,operation_id:randomUUID(),
    period:current,attachment_ids:[attachment]});
  const published=await publish(draft.revision);
  assert.equal(published.can_withdraw,true);
  assert.equal((await service.open(retailPeer,scope)).can_withdraw,false);
  const reportId=String(published.report.id);
  const request={...scope,report_id:reportId,revision:published.revision,operation_id:randomUUID()};
  await assert.rejects(service.withdraw(retailPeer,request),denied);
  await assert.rejects(service.withdraw(retailLead,{...request,revision:draft.revision}),conflict);
  const readReport=id=>withIdentity(f.pool,operator.id,async client=>(await client.query(
    'SELECT id FROM public.reports WHERE id=$1',[id])).rows);
  assert.equal((await readReport(reportId)).length,1);

  const reopened=await service.withdraw(retailLead,request);
  assert.equal(reopened.status,'ready');
  assert.equal(reopened.can_publish,true);
  assert.equal(reopened.report,null);
  assert.equal(reopened.plan.confirmed_id,plan.id);
  assert.equal(contents(reopened.cells[progressCell]),'原提交进展');
  assert.deepEqual(reopened.withdrawn_attachment_ids,[attachment]);
  assert.equal((await readReport(reportId)).length,0);
  const archived=(await f.admin.query(`SELECT report_snapshot,actor_id FROM app_private.weekly_collaboration_withdrawals
    WHERE report_id=$1 AND operation_id=$2`,[reportId,request.operation_id])).rows[0];
  assert.equal(archived.actor_id,retailLead.id);
  assert.deepEqual(archived.report_snapshot.biz,published.report.biz);
  const links=(await f.admin.query(`SELECT attachment_id FROM app_private.weekly_collaboration_withdrawal_attachments
    WHERE report_id=$1`,[reportId])).rows;
  assert.deepEqual(links,[{attachment_id:attachment}]);
  assert.equal((await listReportAttachments(f.pool,retailLead,{ids:[attachment]}))[0].referenced,true);
  assert.deepEqual(await listReportAttachments(f.pool,operator,{ids:[attachment]}),[]);
  await assert.rejects(withIdentity(f.pool,retailLead.id,client=>client.query(
    'SELECT report_snapshot FROM app_private.weekly_collaboration_withdrawals')),error=>error.code==='42501');
  await assert.rejects(withIdentity(f.pool,retailLead.id,client=>client.query(
    'SELECT * FROM app_private.discard_report_attachment($1::uuid)',[attachment])),error=>error.code==='P0001');
  await assert.rejects(withdrawMonthlyPlan(f.pool,retailLead,{project_id:scope.project_id,line:scope.line,month,
    expected_plan_id:plan.id}),error=>error.code==='monthly_plan_in_use');
  const peerRoom=await service.open(retailPeer,scope);
  assert.equal(peerRoom.can_edit,true);
  assert.equal(peerRoom.can_publish,false);
  assert.ok(!peerRoom.withdrawn_attachment_ids?.length);
  assert.equal((await service.withdraw(retailLead,request)).revision,reopened.revision);
  await assert.rejects(service.withdraw(retailLead,{...request,operation_id:randomUUID()}),conflict);

  const edited=await service.change(retailPeer,{...scope,plan_id:plan.id,cell:blockerCell,
    update:edit('组员补录后的卡点'),operation_id:randomUUID()});
  const republished=await publish(edited.revision);
  assert.equal(republished.status,'published');
  assert.deepEqual(republished.report.biz.attachments,[attachment]);
  assert.equal(republished.report.biz.items[0].prog,'原提交进展');
  assert.equal(republished.report.biz.items[0].blocker,'组员补录后的卡点');
  assert.equal((await readReport(republished.report.id)).length,1);
  const reportCount=(await f.admin.query('SELECT count(*)::int AS count FROM public.reports WHERE project_id=$1 AND period=$2 AND line=$3',
    [scope.project_id,current,scope.line])).rows[0].count;
  assert.equal(reportCount,1);
  assert.equal((await service.withdraw(retailLead,request)).report.id,republished.report.id);
  await assert.rejects(service.withdraw(retailLead,{...request,revision:republished.revision,operation_id:randomUUID()}),conflict);

  const source=await previewCompletion(f.pool,retailLead,{source_key:'plan:'+scope.project_id+':'+republished.report.id+':items:'+sourceId});
  const completion=await requestCompletion(f.pool,retailLead,{source_key:source.source_key,source_version:source.source_version,
    completion_date:current,completion_note:'匿名已完工证据'});
  const approval=await reviewCompletion(f.pool,operator,{id:completion.id,expected_revision:completion.revision,decision:'approve'});
  assert.equal(approval.status,'approved');
  assert.equal((await service.open(retailLead,scope)).can_withdraw,false);
  await assert.rejects(service.withdraw(retailLead,{...scope,revision:republished.revision,report_id:String(republished.report.id),
    operation_id:randomUUID()}),conflict);
  assert.equal((await readReport(republished.report.id)).length,1);

  const history=inWeek(custom,prior), oldMonth=prior.slice(0,7);
  const oldPlan=oldMonth===month?plan:await confirmMonthlyPlan(f.pool,retailLead,{
    project_id:scope.project_id,line:scope.line,month:oldMonth,items:[{...item('已结束的报告周事项'),due:oldMonth+'-24'}]
  });
  const oldDraft=await service.settings(operator,{...history,submitter_id:retailLead.id});
  const oldReport=await service.publish(retailLead,{...history,plan_id:oldPlan.id,
    revision:oldDraft.revision,operation_id:randomUUID()});
  assert.equal(oldReport.can_withdraw,false);
  await assert.rejects(service.withdraw(retailLead,{...history,report_id:String(oldReport.report.id),
    revision:oldReport.revision,operation_id:randomUUID()}),conflict);
});

test('已确认月计划保留原事项与历史周报，组员临时事项随负责人提交同步且可重新提报',async t=>{
  const f=await fixture(t), {service}=f;
  const {current,siblings:[alreadySubmitted,otherWeek,standaloneWeek]}=await currentWeekAndSiblings(f);
  const month=current.slice(0,7), scope=inWeek(custom,current), historical=inWeek(custom,alreadySubmitted);
  const originalName='保留的确认月计划事项', originalId=randomUUID();
  const plan=await confirmMonthlyPlan(f.pool,retailLead,{
    project_id:scope.project_id,line:scope.line,month,
    items:[{...item(originalName),source_id:originalId,due:month+'-24'}],
    rich_text:{v:1,fields:{'items.0.name':{ops:[{insert:originalName,attributes:{bold:true}}]}}}
  });
  const settings=scope=>service.settings(operator,{...scope,submitter_id:retailLead.id,member_ids:[retailPeer.id]});
  await settings(historical);
  const publishBody=(room,state)=>({...room,plan_id:state.plan.id,plan_revision:state.plan.revision,
    revision:state.revision,operation_id:randomUUID()});
  const historicalReport=(await service.publish(retailLead,publishBody(historical,await service.open(retailLead,historical)))).report;
  assert.deepEqual(historicalReport.biz.items.map(row=>row.source_id),[originalId]);
  const saveStandalone=(name,prog)=>executeDatabase(f.pool,retailLead,{table:'reports',operation:'upsert',
    onConflict:'project_id,period,line',values:{project_id:scope.project_id,line:scope.line,period:standaloneWeek,
      biz:{monthly_plan_id:plan.id,monthly_plan_month:month,items:[{...plan.items[0],name,prog,blocker:''}]},
      rich_text:{v:1,fields:{'biz.items.0.name':{ops:[{insert:name,attributes:{bold:true}}]}}}}});
  const [legacy]=await saveStandalone(originalName,'历史个人周报进展');
  const originalKey='monthly:'+scope.project_id+':'+plan.id+':'+originalId;
  const originalSource=await previewCompletion(f.pool,retailLead,{source_key:originalKey});
  await settings(scope);
  const sibling=inWeek(custom,otherWeek);
  await settings(sibling);
  const siblingBefore=await service.open(retailLead,sibling);
  assert.equal(siblingBefore.plan.can_add_weekly_items,false);
  const before=await service.open(retailPeer,scope);
  assert.equal(before.plan.can_add_weekly_items,true);
  assert.equal(before.can_publish,false);
  const request={...scope,weekly_supplement:true,plan_id:plan.id,action:'add',revision:before.revision,
    operation_id:randomUUID(),item:{...item('本周临时完成项'),due:month+'-20'}};
  await assert.rejects(service.items(retailPeer,{...request,...inWeek(b,current)}),denied);
  await assert.rejects(service.items(retailPeer,{...request,plan_id:randomUUID()}),conflict);
  const added=await service.items(retailPeer,request);
  const id=request.operation_id;
  assert.deepEqual(added.plan.weekly_supplement_ids,[id]);
  assert.deepEqual(added.plan.items.map(row=>row.source_id),[originalId,id]);
  assert.equal((await service.items(retailPeer,request)).revision,added.revision);
  await assert.rejects(service.items(retailPeer,{...request,action:'update',source_id:originalId,
    revision:added.revision,operation_id:randomUUID()}),conflict);
  await assert.rejects(service.items(retailPeer,{...request,action:'update',source_id:id,operation_id:randomUUID()}),conflict);
  const editRequest={...request,action:'update',source_id:id,revision:added.revision,
    operation_id:randomUUID(),item:{...request.item,name:'组员更新的本周临时事项'}};
  const updated=await service.items(retailPeer,editRequest);
  assert.equal(updated.plan.items.at(-1).name,editRequest.item.name);
  const temporary={...request,revision:updated.revision,operation_id:randomUUID()};
  const extra=await service.items(retailPeer,temporary);
  const removed=await service.items(retailPeer,{...request,action:'delete',item:undefined,source_id:temporary.operation_id,
    revision:extra.revision,operation_id:randomUUID()});
  assert.deepEqual(removed.plan.weekly_supplement_ids,[id]);
  const edited=await service.change(retailPeer,{...scope,plan_id:removed.plan.id,cell:id+':prog',
    update:edit('组员补录临时进展'),operation_id:randomUUID()});
  assert.equal(contents((await service.open(retailLead,scope)).cells[id+':prog']),'组员补录临时进展');

  const physicalPlan=async()=> (await f.admin.query('SELECT id,items,rich_text,confirmed_at FROM public.monthly_plans WHERE id=$1',[plan.id])).rows[0];
  const original=await physicalPlan();
  assert.deepEqual(original.items,plan.items);
  const draft=await service.open(retailLead,scope);
  assert.equal(draft.revision,edited.revision);
  const publish=publishBody(scope,draft);
  await assert.rejects(service.publish(retailPeer,publish),denied);
  await assert.rejects(service.publish(retailLead,{...publish,revision:before.revision}),conflict);
  assert.deepEqual(await physicalPlan(),original);
  const submitted=await service.publish(retailLead,publish);
  assert.equal(submitted.report.biz.monthly_plan_id,plan.id);
  assert.equal(submitted.report.biz.items.at(-1).prog,'组员补录临时进展');
  const synchronized=await physicalPlan();
  assert.deepEqual(synchronized.items.map(row=>row.source_id),[originalId,id]);
  assert.deepEqual(synchronized.items[0],original.items[0]);
  assert.equal(synchronized.items[1].name,editRequest.item.name);
  assert.deepEqual(synchronized.rich_text,original.rich_text);
  assert.equal((await previewCompletion(f.pool,retailLead,{source_key:originalKey})).source_version,originalSource.source_version);
  const synchronizedKey='monthly:'+scope.project_id+':'+plan.id+':'+id;
  assert.equal((await previewCompletion(f.pool,retailLead,{source_key:synchronizedKey})).what,editRequest.item.name);
  assert.deepEqual((await service.open(retailLead,historical)).report.biz,historicalReport.biz);
  await assert.rejects(saveStandalone('试图改写原固定事项','历史个人周报进展'),error=>error.code==='23514' || error.status>=400);
  const [legacyUpdated]=await saveStandalone(originalName,'保留固定快照并更新个人进展');
  assert.equal(legacyUpdated.id,legacy.id);
  assert.equal(legacyUpdated.biz.items.length,1);
  assert.equal(legacyUpdated.biz.items[0].prog,'保留固定快照并更新个人进展');
  assert.deepEqual((await service.open(retailPeer,sibling)).plan.items.map(row=>row.source_id),[originalId,id]);
  await assert.rejects(service.publish(retailLead,publishBody(sibling,siblingBefore)),conflict);
  assert.equal((await service.publish(retailLead,publish)).report.id,submitted.report.id);

  await service.withdraw(retailLead,{...scope,report_id:String(submitted.report.id),revision:submitted.revision,operation_id:randomUUID()});
  const reopened=await service.open(retailPeer,scope);
  assert.deepEqual(reopened.plan.items.map(row=>row.source_id),[originalId,id]);
  assert.equal(contents(reopened.cells[id+':prog']),'组员补录临时进展');
  const revised=await service.change(retailPeer,{...scope,plan_id:reopened.plan.id,cell:id+':blocker',
    update:edit('撤回后继续填报'),operation_id:randomUUID()});
  const republished=await service.publish(retailLead,publishBody(scope,revised));
  assert.equal(republished.report.biz.items.at(-1).blocker,'撤回后继续填报');
  assert.deepEqual(await physicalPlan(),synchronized);
});

test('合并项目临时事项受原月计划分期约束，发布后按原确认版同步',async t=>{
  const f=await fixture(t), {service}=f;
  const {current,siblings:[otherWeek]}=await currentWeekAndSiblings(f);
  const month=current.slice(0,7), scope=inWeek(merged,current), later=inWeek(merged,otherWeek);
  for(const room of [scope,later]){
    await service.settings(operator,{...room,submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  }
  const built=await service.monthItems(engineeringPeer,{...scope,month,action:'add',revision:0,
    operation_id:randomUUID(),item:{...item('合并项目已确认事项','zhx2'),due:month+'-24'}});
  const confirmed=await service.confirmMonth(engineering,{...scope,month,revision:built.plan.revision,operation_id:randomUUID()});
  assert.notEqual(confirmed.plan.id,confirmed.plan.confirmed_id);
  const body={...scope,weekly_supplement:true,plan_id:confirmed.plan.confirmed_id,action:'add',
    revision:confirmed.revision,operation_id:randomUUID(),item:{...item('一期临时事项','zhx1'),due:month+'-22'}};
  await assert.rejects(service.items(engineeringPeer,{...body,item:{...body.item,project_id:b.project_id}}),error=>error.status===400);
  await assert.rejects(service.items(engineeringPeer,{...body,plan_id:confirmed.plan.id}),conflict);
  const ready=await service.items(engineeringPeer,body);
  const blocker=await service.change(engineeringPeer,{...scope,plan_id:ready.plan.id,cell:body.operation_id+':blocker',
    update:edit('一期临时工作卡点'),operation_id:randomUUID()});
  const published=await service.publish(engineering,{...scope,plan_id:blocker.plan.id,plan_revision:blocker.plan.revision,
    revision:blocker.revision,operation_id:randomUUID()});
  assert.deepEqual(published.report.biz.monthly_plan_ids,[confirmed.plan.confirmed_id]);
  assert.deepEqual(published.report.biz.items.map(row=>[row.project_id,row.monthly_plan_id]),
    [['zhx2',confirmed.plan.confirmed_id],['zhx1',confirmed.plan.confirmed_id]]);
  assert.equal(published.report.biz.items[1].blocker,'一期临时工作卡点');
  const refreshed=await service.open(engineeringPeer,later);
  assert.equal(refreshed.plan.id,confirmed.plan.id);
  assert.equal(refreshed.plan.confirmed_id,confirmed.plan.confirmed_id);
  assert.deepEqual(refreshed.plan.items.map(row=>row.project_id),['zhx2','zhx1']);
});

test('商业协同的个人待办仅本人可保存，负责人提交后才归入正式周报', async t => {
  const f = await fixture(t), { service } = f;
  const { current } = await currentWeekAndSiblings(f);
  const scope = inWeek(custom, current);
  const plan = await confirmMonthlyPlan(f.pool, retailLead, {
    project_id: scope.project_id, line: scope.line, month: current.slice(0, 7),
    items: [item('本周计划')]
  });
  const assigned = async (author, owner, line, title) => {
    const [report] = (await f.admin.query(
      `INSERT INTO public.reports(project_id,period,author_id,author_name,line,coord_items)
       VALUES($1,($2::date-7)::text,$3,$3,$4,$5::jsonb) RETURNING id::text AS id`,
      [scope.project_id, current, author.id, line, JSON.stringify([
        { source_id: 'assigned', who_id: owner.id, who: owner.id, what: title, by: current }
      ])]
    )).rows;
    return 'coord:' + scope.project_id + ':' + report.id + ':coord:assigned';
  };
  const peerKey = await assigned(retailLead, retailPeer, '成本', '请协助核对一批匿名专项图纸');
  const leadKey = await assigned(retailPeer, retailLead, '招采', '请确认匿名工程交接界面');
  await service.settings(operator, { ...scope, submitter_id: retailLead.id, member_ids: [retailPeer.id] });
  const initial = await service.open(retailPeer, scope);
  assert.equal(initial.my_followups_revision, 0);
  assert.deepEqual(initial.my_followups ?? [], []);

  const progress = '反馈已确认原样';
  const richProgress = { ops: [{ insert: progress, attributes: { bold: true } }] };
  const feedback = {
    ...scope, feedback_revision: 0,
    entries: [{ source_key: peerKey, progress, status: 'in_progress',
      rich_text: { v: 1, fields: { progress: richProgress } } }]
  };
  await assert.rejects(service.followups(retailLead, feedback), denied);
  const saved = await service.followups(retailPeer, feedback);
  assert.equal(saved.feedback_revision, 1);
  assert.ok(saved.revision > initial.revision);
  assert.equal(saved.rows[0].source_key, peerKey);
  assert.equal(saved.rows[0].what, '请协助核对一批匿名专项图纸');
  assert.deepEqual(saved.rows[0].rich_text.fields.progress, richProgress);
  assert.equal((await service.followups(retailPeer, feedback)).revision, saved.revision);
  await assert.rejects(service.followups(retailPeer, {
    ...feedback, entries: [{ source_key: peerKey, status: 'open', progress: '另一端的旧版草稿' }]
  }), conflict);
  assert.deepEqual((await service.open(retailLead, scope)).my_followups ?? [], []);
  assert.equal((await service.open(retailPeer, scope)).my_followups[0].progress, progress);
  assert.equal((await service.open(retailPeer, scope)).report, null);
  const before = await service.followups(retailLead, {
    ...scope, feedback_revision: 0, entries: [{ source_key: leadKey, status: 'open', progress: '' }]
  });
  const submission = { ...scope, plan_id: plan.id, revision: before.revision, operation_id: randomUUID() };
  await assert.rejects(service.publish(retailPeer, submission), denied);
  await assert.rejects(service.publish(retailLead, { ...submission, revision: initial.revision }), conflict);
  const published = await service.publish(retailLead, submission);
  const rows = published.report.biz.followups;
  assert.equal(rows.length, 2);
  const peerIndex = rows.findIndex(row => row.source_key === peerKey);
  assert.ok(peerIndex >= 0);
  assert.deepEqual([rows[peerIndex].owner_id, rows[peerIndex].owner_name, rows[peerIndex].progress],
    [retailPeer.id, retailPeer.id, progress]);
  assert.equal(rows.find(row => row.source_key === leadKey).owner_id, retailLead.id);
  assert.deepEqual(published.report.rich_text.fields['biz.followups.' + peerIndex + '.progress'], richProgress);
  assert.deepEqual((await service.open(retailPeer, scope)).report.biz.followups, rows);
  await assert.rejects(service.followups(retailPeer, {
    ...feedback, feedback_revision: saved.feedback_revision,
    entries: [{ source_key: peerKey, status: 'in_progress', progress: '正式提交后不能直接修改' }]
  }), conflict);
});

test('合并住宅待办保留实际分期，其他项目事项与移出协同名单的草稿不纳入提交', async t => {
  const f = await fixture(t), { service } = f;
  const { current } = await currentWeekAndSiblings(f);
  const scope = inWeek(merged, current);
  const plan = await confirmMonthlyPlan(f.pool, engineering, {
    ...merged, month: current.slice(0, 7), items: [item('本周分期计划', 'zhx2')]
  });
  const assigned = (projectId, author, owner, what) => createCoordinationTask(f.pool, author, {
    id: randomUUID(), project_id: projectId, owner_id: owner.id, what, due: current
  });
  const leadTask = await assigned('zhx2', engineeringPeer, engineering, '请核对住宅二期材料清单');
  const peerTask = await assigned('zhx1', engineering, engineeringPeer, '请核对住宅一期交接资料');
  const otherProject = await assigned(independent.project_id, engineeringPeer, engineering, '另一个住宅项目的专属事项');
  await service.settings(operator, { ...scope, submitter_id: engineering.id, member_ids: [engineeringPeer.id] });
  const feedback = (source_key, progress) => ({
    ...scope, feedback_revision: 0, entries: [{ source_key, progress, status: 'in_progress' }]
  });
  await assert.rejects(service.followups(engineering, feedback(otherProject.source_key, '不可跨范围同步')), denied);
  await service.followups(engineering, feedback(leadTask.source_key, '已核对二期材料清单'));
  await service.followups(engineeringPeer, feedback(peerTask.source_key, '已核对一期交接资料'));
  await service.settings(operator, { ...scope, submitter_id: engineering.id, member_ids: [] });
  await assert.rejects(service.open(engineeringPeer, scope), denied);
  const ready = await service.open(engineering, scope);
  const published = await service.publish(engineering, {
    ...scope, plan_id: plan.id, revision: ready.revision, operation_id: randomUUID()
  });
  const rows = published.report.biz.followups;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, 'zhx2');
  assert.equal(rows[0].source_key, leadTask.source_key);
  assert.equal(rows[0].owner_id, engineering.id);
  assert.equal(rows[0].progress, '已核对二期材料清单');
});

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
  await f.upgradeItems();
  await f.upgradeItems();
  await f.upgradeMonths();
  await f.upgradeMonths();
  await f.upgradeWithdrawals();
  await f.upgradeSupplements();
  await f.upgradeFollowups();
  await f.upgradeFollowups();
  assert.deepEqual((await f.admin.query(`SELECT to_jsonb(d)-'project_id'-'line'-'report_scope_id'-'unplanned_items'-'member_ids'-'shared_monthly_plan_id'-'supplement_items'-'followup_feedback' row
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

test('管理员名单控制合并住宅协同，组员可直接登记和编辑，只有负责人能提交',async t=>{
  const f=await fixture(t), service=f.service, scope=inWeek(merged);
  await assert.rejects(service.settings(operator,{...scope,submitter_id:engineering.id,member_ids:[incomplete.id]}),denied);
  await service.settings(operator,{...scope,submitter_id:engineering.id,member_ids:[]});
  assert.equal((await service.mode(engineeringPeer,scope)).mode,'excluded');
  await assert.rejects(service.open(engineeringPeer,scope),denied);
  const configured=await service.settings(operator,{...scope,submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  const before=await service.open(engineeringPeer,scope);
  assert.equal(before.can_edit,true);
  assert.deepEqual(before.plan.items,[]);
  const itemId=randomUUID(), addition={...scope,action:'add',operation_id:itemId,revision:configured.revision,
    item:{mod:'工程',name:'直接登记的事项',due:month+'-24',project_id:'zhx2'}};
  await assert.rejects(service.items(engineeringPeer,{...addition,item:{...addition.item,project_id:'outside'}}),e=>e.status===400);
  const added=await service.items(engineeringPeer,addition);
  assert.equal((await service.items(engineeringPeer,addition)).revision,added.revision);
  const request={...scope,plan_id:null,cell:itemId+':prog',update:edit('组员已填写进展'),operation_id:randomUUID()};
  const edited=await service.change(engineeringPeer,request);
  assert.equal(contents((await service.open(engineering,scope)).cells[request.cell]),'组员已填写进展');
  await assert.rejects(service.publish(engineeringPeer,{...scope,plan_id:null,operation_id:randomUUID(),revision:edited.revision}),denied);
  await confirm(f,engineering,merged,item('稍后另行确认的月计划','zhx1'));
  const saved=await service.publish(engineering,{...scope,plan_id:null,operation_id:randomUUID(),revision:edited.revision});
  assert.equal(saved.report.author_id,engineering.id);
  assert.equal(saved.report.biz.items[0].project_id,'zhx2');
  assert.equal(saved.report.biz.items[0].prog,'组员已填写进展');
  assert.equal(saved.report.biz.monthly_plan_ids,undefined);
});

test('单项目管理员仅可查看和配置授权范围的协同名单',async t=>{
  const f=await fixture(t), service=f.service, viewer={id:'scoped-personnel-viewer'}, scope=inWeek(merged);
  await f.admin.query("INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,'viewer@example.invalid','unused')",[viewer.id]);
  await f.admin.query("INSERT INTO public.profiles(user_id,name,role,status,viewer_scope,viewer_access) VALUES($1,'项目管理员','viewer','approved','projects','materials')",[viewer.id]);
  await f.admin.query('INSERT INTO app_private.project_personnel_admins(user_id,project_id) VALUES($1,$2)',[viewer.id,merged.project_id]);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'zhx1','viewer'),($1,'zhx2','viewer')",[viewer.id]);
  await assert.rejects(service.catalog(viewer,{week}),denied);
  await f.admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,'klq','viewer')",[viewer.id]);
  assert.deepEqual((await service.catalog(viewer,{week})).projects.map(p=>p.project_id),[merged.project_id]);
  await assert.rejects(service.settings(viewer,inWeek(independent)),denied);
  await assert.rejects(service.settings(viewer,{...scope,report_scope_id:null}),denied);
  await assert.rejects(service.settings(viewer,{...scope,submitter_id:incomplete.id}),denied);
  const request={...scope,submitter_id:engineering.id,member_ids:[engineeringPeer.id]};
  const saved=await service.settings(viewer,request);
  assert.equal(saved.status,'ready');
  assert.equal(saved.submitter_id,engineering.id);
  assert.deepEqual(saved.member_ids,[engineeringPeer.id]);
  assert.ok(!Object.hasOwn(saved,'report') && !Object.hasOwn(saved,'cells') && !Object.hasOwn(saved,'plan'));
  assert.deepEqual(await service.settings(viewer,scope),saved);
  await assert.rejects(service.open(viewer,scope),denied);
  await service.monthItems(engineeringPeer,{...scope,month,action:'add',revision:0,
    operation_id:randomUUID(),item:item('不返回给项目管理员的月稿','zhx2')});
  assert.equal((await service.settings(viewer,scope)).can_configure,false);
  await assert.rejects(service.settings(viewer,{...scope,submitter_id:engineeringPeer.id,member_ids:[]}),conflict);
  const changed=await service.settings(viewer,{...request,member_ids:[]});
  assert.deepEqual(changed.member_ids,[]);
  await assert.rejects(service.open(engineeringPeer,scope),denied);
  await withIdentity(f.pool,viewer.id,async client=>{
    assert.equal((await client.query('SELECT user_id FROM app_private.personnel_directory')).rows.length,0);
    assert.equal((await client.query('SELECT project_id FROM app_private.weekly_collaboration_drafts')).rows.length,0);
    assert.equal((await client.query('SELECT project_id FROM app_private.collaboration_monthly_drafts')).rows.length,0);
  });
});

test('共同编制的月计划跨周共享，确认前可提交，确认后保留事项和进展身份',async t=>{
  const f=await fixture(t), service=f.service;
  const first=inWeek(merged), second=inWeek(merged,'2026-11-16'), third=inWeek(merged,'2026-11-23');
  for(const scope of [first,second,third])await service.settings(operator,{...scope,submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  const empty=await service.open(engineeringPeer,first);
  assert.equal(empty.plan.shared,true);
  assert.deepEqual(empty.month_plans.next.items,[]);
  assert.equal(empty.month_plans.next.month,'2026-12');
  const add=(scope,chosenMonth,label)=>({ ...scope,month:chosenMonth,action:'add',revision:0,operation_id:randomUUID(),item:item(label,'zhx2') });
  const invalid={...add(first,month,'越界'),item:item('越界','weekly-retail-a')};
  await assert.rejects(service.monthItems(engineeringPeer,invalid),e=>e.status===400);
  const insertion=add(first,month,'十一月共同事项');
  const added=await service.monthItems(engineeringPeer,insertion);
  assert.equal((await service.monthItems(engineeringPeer,insertion)).revision,added.revision);
  const chosenNext=await service.monthItems(engineeringPeer,add(first,'2026-12','下月共同事项'));
  assert.equal(chosenNext.month_plans.next.items[0].name,'下月共同事项');
  assert.equal(chosenNext.month_plans.current.items.length,1);
  const nextConfirmation={...first,month:'2026-12',revision:chosenNext.month_plans.next.revision,operation_id:randomUUID()};
  await assert.rejects(service.confirmMonth(engineeringPeer,nextConfirmation),denied);
  const nextConfirmed=await service.confirmMonth(engineering,nextConfirmation);
  assert.equal(nextConfirmed.month_plans.next.confirmed,true);
  assert.equal(nextConfirmed.month_plans.next.id,chosenNext.month_plans.next.id);
  const current=await service.open(engineeringPeer,second);
  assert.equal(current.plan.id,added.plan.id);
  const cell=insertion.operation_id+':prog';
  const edited=await service.change(engineeringPeer,{...second,plan_id:current.plan.id,cell,update:edit('第二周已填进展'),operation_id:randomUUID()});
  assert.equal((await service.settings(operator,second)).status,'ready');
  assert.equal((await service.open(engineeringPeer,first)).cells[cell],undefined);
  await assert.rejects(service.monthItems(engineeringPeer,{...first,month,action:'delete',source_id:insertion.operation_id,
    revision:current.plan.revision,operation_id:randomUUID()}),conflict);
  const saved=await service.publish(engineering,{...second,plan_id:edited.plan.id,plan_revision:edited.plan.revision,revision:edited.revision,operation_id:randomUUID()});
  assert.equal(saved.report.biz.monthly_plan_ids,undefined);
  assert.equal(saved.report.biz.items[0].prog,'第二周已填进展');
  assert.equal(saved.report.biz.items[0].project_id,'zhx2');
  const firstBefore=await service.change(engineeringPeer,{...first,plan_id:current.plan.id,cell,update:edit('首周已填进展'),operation_id:randomUUID()});
  const confirmation={...first,month,revision:firstBefore.plan.revision,operation_id:randomUUID()};
  const confirmed=await service.confirmMonth(engineering,confirmation);
  assert.equal(confirmed.plan.id,firstBefore.plan.id);
  assert.equal(confirmed.plan.confirmed,true);
  assert.equal(contents(confirmed.cells[cell]),'首周已填进展');
  assert.equal((await service.confirmMonth(engineering,confirmation)).revision,confirmed.revision);
  const thirdWeek=await service.open(engineering,third);
  assert.equal(thirdWeek.plan.id,confirmed.plan.id);
  assert.equal(thirdWeek.plan.confirmed,true);
  const thirdEdited=await service.change(engineeringPeer,{...third,plan_id:confirmed.plan.id,cell,update:edit('第三周确认后填写'),operation_id:randomUUID()});
  const withdrawal={...first,month,revision:confirmed.plan.revision,operation_id:randomUUID()};
  await assert.rejects(service.withdrawMonth(engineeringPeer,withdrawal),denied);
  const withdrawn=await service.withdrawMonth(engineering,withdrawal);
  assert.equal(withdrawn.plan.id,confirmed.plan.id);
  assert.equal(withdrawn.plan.confirmed_id,null);
  assert.equal(contents(withdrawn.cells[cell]),'首周已填进展');
  const thirdAfter=await service.open(engineeringPeer,third);
  assert.equal(thirdAfter.plan.id,thirdEdited.plan.id);
  assert.equal(thirdAfter.plan.confirmed,false);
  assert.equal(contents(thirdAfter.cells[cell]),'第三周确认后填写');
  const reconfirmed=await service.confirmMonth(engineering,{...confirmation,revision:withdrawn.plan.revision,operation_id:randomUUID()});
  assert.equal(reconfirmed.plan.id,confirmed.plan.id);
  assert.notEqual(reconfirmed.plan.confirmed_id,confirmed.plan.confirmed_id);
  await assert.rejects(service.publish(engineering,{...first,plan_id:confirmed.plan.id,plan_revision:firstBefore.plan.revision,
    revision:reconfirmed.revision,operation_id:randomUUID()}),conflict);
  const finalized=await service.publish(engineering,{...first,plan_id:reconfirmed.plan.id,plan_revision:reconfirmed.plan.revision,
    revision:reconfirmed.revision,operation_id:randomUUID()});
  assert.deepEqual(finalized.report.biz.monthly_plan_ids,[reconfirmed.plan.confirmed_id]);
  assert.equal(finalized.report.biz.items[0].prog,'首周已填进展');
  await assert.rejects(service.withdrawMonth(engineering,{...third,month,revision:reconfirmed.plan.revision,operation_id:randomUUID()}),conflict);
});

test('本月或下月的已保存共享稿锁定负责人，仍可调整成员',async t=>{
  const f=await fixture(t), service=f.service;
  const first=inWeek(merged), second=inWeek(merged,'2026-11-16');
  const owner=scope=>service.settings(operator,{...scope,submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  const replace=scope=>service.settings(operator,{...scope,submitter_id:engineeringPeer.id,member_ids:[]});
  await owner(first);
  await owner(second);
  assert.equal((await service.settings(operator,first)).can_configure,true);
  assert.equal((await replace(first)).submitter_id,engineeringPeer.id);
  await owner(first);
  const next='2026-12', nextItem=randomUUID();
  const added=await service.monthItems(engineeringPeer,{...first,month:next,action:'add',revision:0,
    operation_id:nextItem,item:item('下月共享事项','zhx2')});
  for (const scope of [first,second]) {
    assert.equal((await service.settings(operator,scope)).can_configure,false);
    await assert.rejects(replace(scope),conflict);
  }
  const emptied=await service.monthItems(engineeringPeer,{...first,month:next,action:'delete',source_id:nextItem,
    revision:added.month_plans.next.revision,operation_id:randomUUID()});
  assert.deepEqual(emptied.month_plans.next.items,[]);
  assert.equal((await service.settings(operator,first)).can_configure,false);
  await assert.rejects(replace(first),conflict);
  assert.equal((await service.open(engineering,second)).month_plans.next.id,emptied.month_plans.next.id);

  const currentFirst=inWeek(independent), currentSecond=inWeek(independent,'2026-11-16');
  await owner(currentFirst);
  await owner(currentSecond);
  await service.monthItems(engineeringPeer,{...currentSecond,month,action:'add',revision:0,
    operation_id:randomUUID(),item:item('本月共享事项')});
  for (const scope of [currentFirst,currentSecond]) {
    assert.equal((await service.settings(operator,scope)).can_configure,false);
    await assert.rejects(replace(scope),conflict);
  }
  const updated=await service.settings(operator,{...currentSecond,submitter_id:engineering.id,member_ids:[]});
  assert.equal(updated.can_configure,false);
  assert.deepEqual(updated.member_ids,[]);
  await assert.rejects(service.open(engineeringPeer,currentSecond),denied);
  assert.equal((await service.open(engineering,currentFirst)).plan.items[0].name,'本月共享事项');
});

test('后来报告周的名单不能借共享月计划访问未授权的原月稿',async t=>{
  const f=await fixture(t), service=f.service, first=inWeek(merged), second=inWeek(merged,'2026-11-16');
  await service.settings(operator,{...first,submitter_id:engineering.id,member_ids:[]});
  await service.settings(operator,{...second,submitter_id:engineering.id,member_ids:[engineeringPeer.id]});
  const request={...first,month,action:'add',revision:0,operation_id:randomUUID(),item:item('不向后来名单公开的月稿','zhx2')};
  await service.monthItems(engineering,request);
  const unavailable=await service.open(engineeringPeer,second);
  assert.equal(unavailable.status,'month_access_changed');
  assert.equal(unavailable.plan,null);
  assert.equal(unavailable.month_plans.current.unavailable,true);
  assert.deepEqual(unavailable.month_plans.current.items,[]);
  await assert.rejects(service.monthItems(engineeringPeer,{...request,...second,operation_id:randomUUID()}),conflict);
});

test('042 保留 041 已保存的独立周稿、编辑和操作回执',async t=>{
  const f=await fixture(t,41), scope=inWeek(independent), operationId=randomUUID();
  const rows=[item('升级前的独立周事项')], encoded=edit('升级前的已保存进展');
  await f.admin.query(`INSERT INTO app_private.weekly_collaboration_drafts
    (project_id,line,week,submitter_id,configured_by,revision,unplanned_items,cells)
    VALUES($1,$2,$3,$4,$5,3,$6::jsonb,$7::jsonb)`,
    [scope.project_id,scope.line,scope.week,engineering.id,operator.id,JSON.stringify(rows),JSON.stringify({[progressCell]:encoded})]);
  await f.admin.query(`INSERT INTO app_private.weekly_collaboration_operations
    (project_id,line,week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash)
    VALUES($1,$2,$3,$4,$5,'原匿名成员','edit',3,$6,$7)`,
    [scope.project_id,scope.line,scope.week,operationId,engineeringPeer.id,progressCell,
      createHash('sha256').update(JSON.stringify(['edit',null,progressCell,encoded])).digest('hex')]);
  await f.upgradeMonths();
  await f.upgradeWithdrawals();
  await f.upgradeSupplements();
  await f.upgradeFollowups();
  const legacy=await f.service.open(engineeringPeer,scope);
  assert.equal(legacy.plan.shared,false);
  assert.equal(legacy.plan.id,null);
  assert.deepEqual(legacy.plan.items,rows);
  assert.equal(contents(legacy.cells[progressCell]),'升级前的已保存进展');
  const replay=await f.service.change(engineeringPeer,{...scope,plan_id:null,cell:progressCell,update:encoded,operation_id:operationId});
  assert.equal(replay.revision,3);
  await f.service.monthItems(engineeringPeer,{...scope,month,action:'add',revision:0,operation_id:randomUUID(),item:item('独立准备的共享月事项')});
  const after=await f.service.open(engineering,scope);
  assert.equal(after.plan.shared,false);
  assert.deepEqual(after.plan.items,rows);
  assert.equal(contents(after.cells[progressCell]),'升级前的已保存进展');
  const published=await f.service.publish(engineering,{...scope,plan_id:null,revision:after.revision,operation_id:randomUUID()});
  assert.equal(published.report.biz.items[0].prog,'升级前的已保存进展');
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
