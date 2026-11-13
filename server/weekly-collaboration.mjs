import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { getProfile, lockWeeklyCollaborationWrite, reportDelay, reportStatus, reportWeekStart, withIdentity } from './database.mjs';
import { businessModulesForProject } from './commercial-modules.mjs';
import { HttpError } from './errors.mjs';
import { normalizeMonthlyPlanItems } from './monthly-plans.mjs';
import { validateReportAttachmentReferences } from './report-attachments.mjs';
import { residentialDisciplinesForProject } from './report-lines.mjs';
import { configuredReportScopes, resolveReportScope } from './report-scopes.mjs';
import { validateRichText } from './rich-text.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const weekFilter = 'project_id=$1 AND line=$2 AND week=$3::date';
const maxCellBytes = 65536;
const maxDraftBytes = 2 * 1024 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => { throw new HttpError(status, message, 'weekly_collaboration'); };

function weekOf(body) {
  const value = body?.week;
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value) || reportWeekStart(value) !== value) fail(400, '请选择有效的报告周（周一）。');
  return value;
}

function scopeOf(body) {
  const week = weekOf(body);
  // 038 pages already open at cutover may still address the original room.
  const legacy = body.project_id === undefined && body.line === undefined && body.report_scope_id === undefined;
  const projectId = legacy ? 'hf' : body.project_id;
  const line = legacy ? '设计部' : body.line;
  const scopeId = body.report_scope_id ?? null;
  const valid = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
    && value === value.trim() && !value.includes('\u0000');
  if (!valid(projectId,200) || !valid(line,100) || line === '综合' || scopeId !== null && !valid(scopeId,200))
    fail(400,'请选择有效的项目、汇报专业和报告周。');
  return {projectId,line,scopeId,week,key:JSON.stringify([projectId,line,week]),
    weekValues:[projectId,line,week], eligibility:[projectId,line,scopeId]};
}

function operationOf(body) {
  if (typeof body.operation_id !== 'string' || !uuid.test(body.operation_id)) fail(400, '协同操作编号无效。');
  return body.operation_id.toLowerCase();
}

function validCell(plan, cell) {
  if (!plan || typeof cell !== 'string' || cell.length > 208) return false;
  return plan.items.some(item => cell === item.source_id + ':prog' || cell === item.source_id + ':blocker');
}

function cellDelta(doc) {
  const text = doc.getText('content');
  if (doc.share.size !== 1 || doc.store.pendingStructs || doc.store.pendingDs || text.length > 12000)
    fail(400, '协同单元格内容过长或更新不完整。');
  const ops = text.toDelta();
  if (ops.length > 2000 || ops.some(op => typeof op.insert !== 'string' || op.insert.includes('\u0000')
    || Object.entries(op.attributes || {}).some(([name,value]) => !(name === 'bold' && value === true) && !(name === 'color' && value === '#d81e06'))))
    fail(400, '协同单元格仅支持文字、加粗和标红。');
  return ops;
}

function readCell(saved, update) {
  const doc = new Y.Doc();
  try {
    doc.getText('content');
    if (saved) Y.applyUpdate(doc, Buffer.from(saved, 'base64'));
    if (update) Y.applyUpdate(doc, update);
    const ops = cellDelta(doc);
    if (!update) return ops;
    const bytes = Y.encodeStateAsUpdate(doc);
    if (bytes.length > maxCellBytes) fail(400, '该单元格累计改动已达上限。');
    return Buffer.from(bytes).toString('base64');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, '协同单元格更新无效，请重新同步。');
  } finally { doc.destroy(); }
}

async function readWeek(client, scope) {
  return (await client.query('SELECT * FROM app_private.weekly_collaboration_drafts WHERE '+weekFilter,scope.weekValues)).rows[0];
}

async function confirmedPlan(client, scope, submitter) {
  const month = scope.week.slice(0, 7);
  const row = (await client.query(`SELECT p.id,p.items,p.rich_text,p.scope_project_ids,j.project_type
    FROM public.monthly_plans p JOIN public.projects j ON j.id=p.project_id
    WHERE p.project_id=$1 AND p.line=$2 AND p.report_scope_id IS NOT DISTINCT FROM $3::text
      AND p.confirmed_by=$4 AND p.plan_month=$5::date`,
    [...scope.eligibility,submitter,month+'-01'])).rows[0];
  return row && { ...row, month };
}

async function existingReport(client, scope, submitter) {
  return (await client.query(`SELECT EXISTS(SELECT 1 FROM public.reports WHERE project_id=$1 AND line=$2
    AND app_private.weekly_collaboration_existing_report_week(period,submitted_at)=$3::date AND author_id=$4) AS found`,
    [...scope.weekValues,submitter])).rows[0].found;
}

async function appendOperation(client, user, scope, operation, kind, revision, cell, fingerprint) {
  const { name } = await getProfile(client, user.id);
  await client.query(`INSERT INTO app_private.weekly_collaboration_operations
    (project_id,line,week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash)
    VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)`,
    [...scope.weekValues,operation,user.id,name,kind,revision,cell,fingerprint]);
}

async function replay(client, user, scope, operation, fingerprint) {
  const row = (await client.query(`SELECT actor_id,payload_hash FROM app_private.weekly_collaboration_operations
    WHERE ${weekFilter} AND operation_id=$4`, [...scope.weekValues,operation])).rows[0];
  if (row && (row.actor_id !== user.id || row.payload_hash !== fingerprint)) fail(409, '该协同操作编号已被使用。');
  return Boolean(row);
}

function reportFields(draft, plan, scoped) {
  const fields = {};
  for (const [key, delta] of Object.entries(plan.rich_text?.fields || {})) fields['biz.' + key] = delta;
  const items = plan.items.map((item, index) => {
    const result = { ...item, ...(scoped && plan.id ? {monthly_plan_id:plan.id} : {}) };
    for (const field of ['prog','blocker']) {
      const ops = readCell(draft.cells[item.source_id + ':' + field]);
      result[field] = ops.map(op => op.insert).join('');
      if (ops.some(op => op.attributes)) fields['biz.items.' + index + '.' + field] = {ops};
    }
    return result;
  });
  return {items, fields};
}

export function createWeeklyCollaboration(pool) {
  const events = new EventEmitter().setMaxListeners(0);
  const presence = new Map();
  let sequence = 0;
  let nextSweep = 0;
  function notify(scope) { sequence++; events.emit(scope.key); }

  function people(scope, eligible) {
    const now = Date.now();
    const known = new Map(eligible.map(person => [person.user_id, person.name]));
    const active = new Map();
    for (const entry of presence.get(scope.key)?.values() || []) {
      if (entry.until < now || !known.has(entry.user_id)) continue;
      const prior = active.get(entry.user_id);
      if (!prior || entry.active_cell && (!prior.active_cell || entry.focused > prior.focused)) active.set(entry.user_id,entry);
    }
    return [...active.values()].sort((a,b)=>a.user_id.localeCompare(b.user_id))
      .map(entry=>({user_id:entry.user_id,name:known.get(entry.user_id),active_cell:entry.active_cell}));
  }

  function touch(user, scope, tab, activeCell) {
    const now=Date.now();
    if (now>=nextSweep) {
      nextSweep=now+60000;
      for (const [key,room] of presence) {
        for (const [id,entry] of room) if (entry.until<now) room.delete(id);
        if (!room.size) presence.delete(key);
      }
    }
    let room=presence.get(scope.key);
    if (!room) presence.set(scope.key,room=new Map());
    const key=JSON.stringify([user.id,tab]);
    const prior=room.get(key);
    const changed=!prior || prior.until<now || prior.active_cell!==activeCell;
    room.set(key,{user_id:user.id,active_cell:activeCell,focused:changed?now:prior.focused,until:now+35000});
    if (changed) notify(scope);
  }

  async function access(client, user, scope, settings) {
    const allowed=settings?(await client.query('SELECT app_private.weekly_collaboration_operator() AS allowed')).rows[0].allowed
      : ['member','unconfigured'].includes(await roomAccess(client,user,scope));
    if (!allowed) fail(403,settings?'只有管理员可指定提交负责人。':'当前账号没有该项目专业的协同权限。');
  }

  async function roomAccess(client,user,scope) {
    return (await client.query('SELECT app_private.weekly_collaboration_room_access($1,$2,$3,$4,$5::date) AS mode',
      [user.id,...scope.eligibility,scope.week])).rows[0].mode;
  }

  function mode(user,body) {
    const scope=scopeOf(body);
    return withIdentity(pool,user.id,async client=>({mode:await roomAccess(client,user,scope)}));
  }

  async function state(client, user, scope, settings, presenceInput) {
    const draft=await readWeek(client,scope);
    if (draft && draft.report_scope_id!==scope.scopeId) fail(409,'该周的合并填报范围已变化，请核对原协同稿。');
    const eligible=settings || draft
      ? (await client.query('SELECT * FROM app_private.weekly_collaboration_participants($1,$2,$3)',scope.eligibility)).rows : [];
    const submitter = draft && eligible.find(person => person.user_id === draft.submitter_id);
    let status = 'unconfigured';
    let plan = null;
    let report = null;
    if (draft?.published_report_id) {
      report = (await client.query('SELECT * FROM public.reports WHERE id=$1',[draft.published_report_id])).rows[0] || null;
      status = 'published';
    } else if (draft && !submitter) status = 'submitter_unavailable';
    else if (draft) {
      plan = draft.unplanned_items == null ? await confirmedPlan(client,scope,submitter.user_id) || null : null;
      if (!draft.plan_id && await existingReport(client,scope,submitter.user_id)) status = 'legacy_report';
      else if (draft.plan_id && draft.plan_id !== plan?.id) status = 'plan_changed';
      else {
        if (!plan || !draft.plan_id && !plan.items.length) {
          const project = (await client.query('SELECT project_type FROM public.projects WHERE id=$1',[scope.projectId])).rows[0];
          plan = {id:null,unplanned:true,items:draft.unplanned_items ?? [],project_type:project.project_type,month:scope.week.slice(0,7)};
        }
        status = 'ready';
      }
    }
    if (!settings && draft && presenceInput) {
      const {tab,activeCell}=presenceInput;
      touch(user,scope,tab,validCell(plan,activeCell)?activeCell:null);
    }
    const online=people(scope,draft?.member_ids==null?eligible:eligible.filter(person=>person.user_id===draft.submitter_id || draft.member_ids.includes(person.user_id)));
    const last = !settings && draft && (await client.query(`SELECT actor_name,recorded_at AS at,cell
      FROM app_private.weekly_collaboration_operations WHERE ${weekFilter} AND kind='edit' ORDER BY revision DESC LIMIT 1`,scope.weekValues)).rows[0];
    const revision = draft?.revision || 0;
    return {
      week:scope.week, project_id:scope.projectId,line:scope.line,report_scope_id:scope.scopeId,status,revision,
      cursor:digest([revision,status,plan?.id,online]),
      submitter_id:draft?.submitter_id || null, submitter_name:submitter?.name || report?.author_name || '',
      can_edit:!settings && status === 'ready', can_publish:!settings && status === 'ready' && submitter.user_id === user.id && (!plan.unplanned || plan.items.length>0),
      can_configure:settings && !draft?.plan_id && !draft?.unplanned_items?.length && !draft?.published_report_id,
      eligible:settings ? eligible : [], member_ids:settings ? draft?.member_ids ?? null : undefined, plan:settings || status !== 'ready' ? null : plan,
      cells:!settings && status === 'ready' ? draft.cells : {}, report, last_change:last || null, presence:online
    };
  }

  async function openState(user, scope, body) {
    const tab=body.tab_id ?? '';
    if (tab!=='' && (typeof tab!=='string' || !uuid.test(tab))) fail(400,'协同页面标识不正确。');
    return withIdentity(pool,user.id,async client => {
      await access(client,user,scope,false);
      return state(client,user,scope,false,{tab,activeCell:body.active_cell});
    });
  }

  function open(user,body) { return openState(user,scopeOf(body),body); }

  function waitForChange(scope, signal, timeout) {
    return new Promise(resolve => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        events.off(scope.key,done);
        signal?.removeEventListener('abort',done);
        resolve();
      };
      const timer = setTimeout(done,timeout);
      events.once(scope.key,done);
      signal?.addEventListener('abort',done,{once:true});
    });
  }

  async function poll(user,body,signal) {
    const scope=scopeOf(body),deadline=Date.now()+12000;
    for (;;) {
      if (signal?.aborted) return null;
      const start=sequence;
      const next=await openState(user,scope,body);
      if (next.revision!==body.since_revision || next.cursor!==body.since_cursor) return next;
      const remaining=deadline-Date.now();
      if (remaining<=0) return null;
      // A notice can race with the read or leave this caller's visible state unchanged.
      // Keep its request waiting instead of prompting another immediate poll.
      if (sequence===start) await waitForChange(scope,signal,remaining);
      else await waitForChange(scope,signal,Math.min(remaining,100));
    }
  }

  async function settings(user,body) {
    const scope=scopeOf(body);
    const result = await withIdentity(pool,user.id,async client => {
      await access(client,user,scope,true);
      if (!Object.hasOwn(body,'submitter_id')) return state(client,user,scope,true);
      const submitter = body.submitter_id;
      if (typeof submitter !== 'string' || !submitter || submitter.length > 128) fail(400,'请选择一位提交负责人。');
      const requestedMembers=body.member_ids;
      if (requestedMembers!==undefined && (!Array.isArray(requestedMembers) || requestedMembers.length>500
        || requestedMembers.some(id=>typeof id!=='string' || !id || id.length>128))) fail(400,'协同人员名单不正确。');
      const {allowed}=(await client.query('SELECT app_private.weekly_collaboration_eligible($1,$2,$3,$4) AS allowed',[submitter,...scope.eligibility])).rows[0];
      if (!allowed) fail(403,'提交负责人须有该项目专业的填报权限。');
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      const draft=await readWeek(client,scope);
      if (draft && draft.report_scope_id!==scope.scopeId) fail(409,'该周的合并填报范围已变化，请核对原协同稿。');
      const members=requestedMembers===undefined?draft?.member_ids ?? null:[...new Set(requestedMembers.filter(id=>id!==submitter))].sort();
      if (draft?.submitter_id===submitter && JSON.stringify(draft.member_ids ?? null)===JSON.stringify(members)) return state(client,user,scope,true);
      if (draft?.published_report_id || draft?.submitter_id!==submitter && (draft?.plan_id || draft?.unplanned_items?.length))
        fail(409,'该周已经开始编制或已提交，不能更改负责人。');
      if (members?.length) {
        const eligible=(await client.query('SELECT * FROM app_private.weekly_collaboration_participants($1,$2,$3)',scope.eligibility)).rows;
        if (!members.every(id=>eligible.some(person=>person.user_id===id))) fail(403,'协同人员须有该项目专业的填报权限。');
      }
      if (draft?.submitter_id!==submitter && await existingReport(client,scope,submitter)) fail(409,'该负责人本周已有个人周报，请选择其他报告周或核对历史记录。');
      const revision = draft ? draft.revision + 1 : 1;
      await client.query(`INSERT INTO app_private.weekly_collaboration_drafts(project_id,line,week,report_scope_id,submitter_id,configured_by,revision,member_ids)
        VALUES($1,$2,$3::date,$4,$5,$6,$7,$8) ON CONFLICT(project_id,line,week) DO UPDATE
        SET submitter_id=excluded.submitter_id,configured_by=excluded.configured_by,revision=excluded.revision,member_ids=excluded.member_ids`,
        [...scope.weekValues,scope.scopeId,submitter,user.id,revision,members]);
      await appendOperation(client,user,scope,randomUUID(),'designate',revision,null,digest([submitter,members]));
      return state(client,user,scope,true);
    });
    if (Object.hasOwn(body,'submitter_id')) notify(scope);
    return result;
  }

  async function catalog(user,body) {
    weekOf(body);
    return withIdentity(pool,user.id,async client => {
      await access(client,user,null,true);
      const scopes=await configuredReportScopes(client);
      const grouped=new Map(scopes.flatMap(scope=>scope.project_ids.map(id=>[id,scope])));
      const records=(await client.query(`SELECT id,name,project_type,reporting_professions FROM public.projects
        WHERE active ORDER BY sort_order,name,id`)).rows;
      const candidates=[];
      for (const row of records) {
        const merged=grouped.get(row.id);
        if (merged && (merged.anchor_project_id!==row.id || merged.reporting_mode!=='professional')) continue;
        const standard=row.project_type==='com'?businessModulesForProject(row.id):residentialDisciplinesForProject(row.id);
        for (const line of new Set([...standard,...(row.reporting_professions || [])])) {
          if (line!=='综合') candidates.push({project_id:row.id,project_name:merged?.name || row.name,report_scope_id:merged?.id || null,line});
        }
      }
      const eligible=(await client.query(`SELECT c.project_id,c.project_name,c.report_scope_id,c.line
        FROM jsonb_to_recordset($1::jsonb) AS c(project_id text,project_name text,report_scope_id text,line text)
        WHERE EXISTS(SELECT 1 FROM app_private.weekly_collaboration_participants(c.project_id,c.line,c.report_scope_id))`,
        [JSON.stringify(candidates)])).rows;
      const projects=new Map();
      for (const {project_id,project_name,report_scope_id,line} of eligible) {
        if (!projects.has(project_id)) projects.set(project_id,{project_id,project_name,report_scope_id,professions:[]});
        projects.get(project_id).professions.push(line);
      }
      return {projects:[...projects.values()]};
    });
  }

  async function items(user,body) {
    const scope=scopeOf(body), operation=operationOf(body), {action,revision}=body;
    if (!['add','update'].includes(action) || !Number.isSafeInteger(revision) || revision<0) fail(400,'事项操作不正确。');
    const id=action==='add'?operation:body.source_id;
    if (typeof id!=='string' || !uuid.test(id)) fail(400,'事项标识不正确。');
    const item=normalizeMonthlyPlanItems([{...body.item,source_id:id}],scope.scopeId)[0];
    const fingerprint=digest(['items',action,id,item,revision]);
    const result=await withIdentity(pool,user.id,async client=>{
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope,false);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      const current=await state(client,user,scope,false);
      if (!current.can_edit || !current.plan.unplanned) fail(409,'当前周报不允许调整事项。');
      if (action!=='add' && revision!==current.revision) fail(409,'协同稿已更新，请核对事项后重试。');
      const rows=current.plan.items.slice();
      if (scope.scopeId) {
        const range=(await client.query('SELECT project_ids FROM app_private.report_scopes WHERE id=$1',[scope.scopeId])).rows[0];
        if (!range.project_ids.includes(item.project_id)) fail(400,'请选择本项目范围内的实际分期。');
      }
      if (action==='add') {
        if (rows.length>=500) fail(400,'本周协同事项最多 500 项。');
        rows.push(item);
      } else {
        const index=rows.findIndex(row=>row.source_id===id);
        if (index<0) fail(409,'事项已变化，请刷新后核对。');
        rows[index]=item;
      }
      if (Buffer.byteLength(JSON.stringify(rows))>maxDraftBytes) fail(400,'本周事项累计内容已达上限。');
      const nextRevision=current.revision+1;
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET unplanned_items=$4::jsonb,revision=$5
        WHERE ${weekFilter}`,[...scope.weekValues,JSON.stringify(rows),nextRevision]);
      await appendOperation(client,user,scope,operation,'items',nextRevision,null,fingerprint);
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  async function change(user,body) {
    const scope=scopeOf(body);
    const operation = operationOf(body);
    const encoded = body.update;
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(maxCellBytes / 3) * 4) fail(400,'协同单元格更新过长或格式不正确。');
    const bytes = Buffer.from(encoded,'base64');
    if (!bytes.length || bytes.length > maxCellBytes || bytes.toString('base64') !== encoded) fail(400,'协同单元格更新格式不正确。');
    const planId = body.plan_id;
    if (planId!==null && (typeof planId !== 'string' || !uuid.test(planId))) fail(400,'协同事项来源不正确。');
    const fingerprint = digest(['edit',planId,body.cell,encoded]);
    const result = await withIdentity(pool,user.id,async client => {
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope,false);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      const current=await state(client,user,scope,false);
      if (!current.can_edit) fail(409,'该周协同稿当前无法编辑，请刷新后核对。');
      if (current.plan.id !== planId) fail(409,'协同事项来源已变化，原输入保留在当前浏览器。');
      if (!validCell(current.plan,body.cell)) fail(400,'协同单元格不属于当前事项。');
      const next = readCell(current.cells[body.cell],bytes);
      const cells = {...current.cells,[body.cell]:next};
      if (Buffer.byteLength(JSON.stringify(cells)) > maxDraftBytes) fail(400,'该周协同稿累计改动已达上限。');
      const revision = current.revision + 1;
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET plan_id=$4,cells=$5::jsonb,revision=$6
        WHERE ${weekFilter}`,[...scope.weekValues,current.plan.id,JSON.stringify(cells),revision]);
      await appendOperation(client,user,scope,operation,'edit',revision,body.cell,fingerprint);
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  async function publish(user,body) {
    const scope=scopeOf(body),{week,projectId,line,scopeId}=scope;
    const operation = operationOf(body);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400,'协同稿版本不正确。');
    const planId = body.plan_id;
    if (planId!==null && (typeof planId !== 'string' || !uuid.test(planId))) fail(400,'协同事项来源不正确。');
    const period = body.period ?? week;
    if (typeof period !== 'string' || period.length > 100 || reportWeekStart(period) !== week)
      fail(400,'附件周期与本周协同稿不一致。');
    const attachments = body.attachment_ids ?? [];
    if (!Array.isArray(attachments) || attachments.length > 20 || attachments.some(id => typeof id !== 'string' || !uuid.test(id)))
      fail(400,'本周附件引用不正确。');
    const fingerprint = digest(['publish',body.revision,planId,period,attachments]);
    const result = await withIdentity(pool,user.id,async client => {
      await lockWeeklyCollaborationWrite(client,projectId,line,week);
      await access(client,user,scope,false);
      const current=await state(client,user,scope,false);
      if (current.submitter_id !== user.id) fail(403,'仅本周指定负责人可以正式提交。');
      if (await replay(client,user,scope,operation,fingerprint)) return current;
      if (!current.can_publish || current.revision !== body.revision || current.plan.id !== planId)
        fail(409,'协同稿版本或状态已变化，请核对最新内容后提交。');
      const normalized = (await client.query('SELECT app_private.report_week_start($1,now())::text AS week',[period])).rows[0].week;
      if (normalized !== week) fail(400,'附件周期与本周协同稿不一致。');
      const {items,fields}=reportFields(current,current.plan,Boolean(scopeId));
      const profile = await getProfile(client,user.id);
      const row = {project_id:projectId,period,line,...(scopeId?{report_scope_id:scopeId}:{}),biz:{
        ...(current.plan.id?{...(scopeId?{monthly_plan_ids:[current.plan.id]}:{monthly_plan_id:current.plan.id}),
          monthly_plan_month:current.plan.month}:{}),
        items,attachments,
        weekly_collaboration:{week,revision:current.revision}
      }};
      await resolveReportScope(client,user,row,null,period,projectId);
      await validateReportAttachmentReferences(client,user.id,profile,row);
      const rich = validateRichText('reports',Object.keys(fields).length ? {v:1,fields} : {},row);
      const delay=await reportDelay(client,row.scope_project_ids || [projectId]);
      const status=reportStatus(delay);
      const speed=current.plan.project_type==='com'?null:delay>=5?'滞后':delay<=-5?'领跑':'达标';
      const revision = current.revision + 1;
      await client.query('UPDATE app_private.weekly_collaboration_drafts SET plan_id=$4 WHERE '+weekFilter,[...scope.weekValues,current.plan.id]);
      await appendOperation(client,user,scope,operation,'publish',revision,null,fingerprint);
      await client.query("SELECT set_config('app.weekly_collaboration_publish',$1,true)",[operation]);
      const {id}=(await client.query(`INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,rich_text,status,self_speed,
        report_scope_id,scope_project_ids,scope_week) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12) RETURNING id`,
        [projectId,period,line,user.id,profile.name,JSON.stringify(row.biz),JSON.stringify(rich),status,speed,
          row.report_scope_id || null,row.scope_project_ids || null,row.scope_week || null])).rows[0];
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET revision=$4,published_revision=$5,published_report_id=$6
        WHERE ${weekFilter}`,[...scope.weekValues,revision,current.revision,id]);
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  return {open,poll,mode,catalog,settings,items,change,publish};
}
