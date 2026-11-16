import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { getProfile, lockWeeklyCollaborationWrite, reportDelay, reportStatus, reportWeekStart, withIdentity } from './database.mjs';
import { businessModulesForProject } from './commercial-modules.mjs';
import { HttpError } from './errors.mjs';
import { confirmMonthlyPlanInTransaction, normalizeMonthlyPlanItems } from './monthly-plans.mjs';
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

function monthsOf(scope) {
  const current=scope.week.slice(0,7);
  const [year,month]=current.split('-').map(Number);
  const next=new Date(Date.UTC(year,month,1)).toISOString().slice(0,7);
  return {current,next};
}

async function monthlySources(client, scope, draft, user, status) {
  const months=monthsOf(scope);
  const result=await client.query(`SELECT v.month, to_jsonb(m) AS shared, to_jsonb(p) AS confirmed,
      j.project_type, $5::date=date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date AS current_week,
      app_private.collaboration_monthly_draft_unavailable($1,$2,$3,$5::date,(v.month||'-01')::date) AS unavailable
    FROM unnest($6::text[]) AS v(month) JOIN public.projects j ON j.id=$1
    LEFT JOIN app_private.collaboration_monthly_drafts m ON m.project_id=$1 AND m.line=$2 AND m.report_scope_id IS NOT DISTINCT FROM $3::text
      AND m.owner_id=$4 AND m.plan_month=(v.month||'-01')::date
    LEFT JOIN public.monthly_plans p ON p.project_id=$1 AND p.line=$2 AND p.report_scope_id IS NOT DISTINCT FROM $3::text
      AND p.confirmed_by=$4 AND p.plan_month=(v.month||'-01')::date`,
    [...scope.eligibility,draft.submitter_id,scope.week,[months.current,months.next]]);
  const planFor=(row,key)=>{
    const {month,project_type,confirmed,shared,unavailable,current_week}=row;
    const usingShared=!!shared || !confirmed && !unavailable;
    const confirmedHere=!!confirmed && (!shared || confirmed.id===shared.confirmed_id);
    const confirmationConflict=!!shared && !!confirmed && !confirmedHere;
    const canEdit=!confirmedHere && !unavailable && (status==='ready' || status==='published' && key==='next');
    return {
      id:usingShared?shared?.id ?? null:confirmed?.id ?? null,
      confirmed_id:confirmedHere?confirmed.id:null,
      month,project_type,items:confirmedHere?confirmed.items:shared?.items ?? [],
      revision:usingShared?shared?.revision ?? 0:confirmed?.supplement_revision ?? 0,shared:usingShared,confirmed:confirmedHere,
      unplanned:!confirmedHere,unavailable,confirmation_conflict:confirmationConflict,
      can_edit:canEdit,can_confirm:canEdit && !confirmationConflict && !!shared?.items.length && user.id===draft.submitter_id,
      can_withdraw:confirmedHere && !!shared && user.id===draft.submitter_id && (status==='ready' || status==='published' && key==='next'),
      can_add_weekly_items: key==='current' && status==='ready' && confirmedHere && !unavailable
        && (current_week || !!draft.supplement_items?.length),
      rich_text:confirmedHere?confirmed.rich_text:undefined,scope_project_ids:confirmedHere?confirmed.scope_project_ids:undefined,
      confirmed_name:confirmedHere?confirmed.confirmed_name:undefined,confirmed_at:confirmedHere?confirmed.confirmed_at:undefined
    };
  };
  const byMonth=new Map(result.rows.map(row=>[row.month,row]));
  return {current:planFor(byMonth.get(months.current),'current'),next:planFor(byMonth.get(months.next),'next')};
}

async function lockSharedMonth(client,scope,owner,month) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('collaboration-month:'||jsonb_build_array($1::text,$2::text,$3::text,$4::text,$5::text)::text,0))",
    [...scope.eligibility,owner,month]);
}

async function lockConfirmedMonth(client,scope) {
  await client.query('SELECT app_private.lock_weekly_supplement_month($1,$2,$3,$4::date)',[...scope.eligibility,scope.week]);
}

async function ownerIsLocked(client,scope,draft) {
  if (!draft) return false;
  if (draft.plan_id || draft.shared_monthly_plan_id || draft.unplanned_items?.length || draft.supplement_items?.length || draft.published_report_id) return true;
  const months=Object.values(monthsOf(scope)).map(month=>month+'-01');
  // An emptied draft retains its identity and still uses the original week's roster.
  return (await client.query(`SELECT EXISTS(SELECT 1 FROM app_private.collaboration_monthly_drafts
    WHERE project_id=$1 AND line=$2 AND report_scope_id IS NOT DISTINCT FROM $3::text
      AND owner_id=$4 AND plan_month=ANY($5::date[])) AS locked`,
    [...scope.eligibility,draft.submitter_id,months])).rows[0].locked;
}

async function existingReport(client, scope, submitter) {
  return (await client.query(`SELECT EXISTS(SELECT 1 FROM public.reports WHERE project_id=$1 AND line=$2
    AND app_private.weekly_collaboration_existing_report_week(period,submitted_at)=$3::date AND author_id=$4) AS found`,
    [...scope.weekValues,submitter])).rows[0].found;
}

async function scopedConflicts(client,scope,candidate) {
  return (await client.query(`SELECT * FROM app_private.scoped_weekly_settings_conflicts($1,$2,$3,$4::date,$5)`,
    [...scope.eligibility,scope.week,candidate])).rows[0] || {};
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
    const result = { ...item, ...(scoped && plan.confirmed_id ? {monthly_plan_id:plan.confirmed_id} : {}) };
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

  async function access(client, user, scope) {
    if (!['member','unconfigured'].includes(await roomAccess(client,user,scope))) fail(403,'当前账号没有该项目专业的协同权限。');
  }

  async function settingsAccess(client,user,scope) {
    if ((await client.query('SELECT app_private.weekly_collaboration_operator() AS allowed')).rows[0].allowed) return null;
    if ((await getProfile(client,user.id))?.role !== 'viewer')
      fail(403,'当前账号没有该项目的协同设置权限。');
    const projects=(await client.query('SELECT * FROM app_private.personnel_admin_projects()')).rows;
    if (!projects.length || scope && !projects.some(p=>p.project_id===scope.projectId && p.report_scope_id===scope.scopeId))
      fail(403,'当前账号没有该项目的协同设置权限。');
    await client.query("SELECT set_config('app.scoped_weekly_settings','on',true)");
    return projects;
  }

  async function scopedSettingsState(client,scope) {
    const draft=await readWeek(client,scope);
    const eligible=(await client.query('SELECT * FROM app_private.weekly_collaboration_participants($1,$2,$3)',scope.eligibility)).rows;
    const submitter=eligible.find(person=>person.user_id===draft?.submitter_id);
    const conflicts=draft?await scopedConflicts(client,scope,draft.submitter_id):{};
    const locked=draft && (draft.plan_id || draft.shared_monthly_plan_id || draft.unplanned_items?.length || draft.published_report_id || conflicts.has_month_draft);
    const status=!draft?'unconfigured':draft.published_report_id?'published':!submitter?'submitter_unavailable':
      !draft.plan_id && !draft.shared_monthly_plan_id && conflicts.has_report?'legacy_report':'ready';
    return {status,revision:draft?.revision || 0,submitter_id:draft?.submitter_id || null,
      submitter_name:submitter?.name || '',can_configure:!locked,eligible,member_ids:draft?.member_ids ?? null};
  }

  async function roomAccess(client,user,scope) {
    return (await client.query('SELECT app_private.weekly_collaboration_room_access($1,$2,$3,$4,$5::date) AS mode',
      [user.id,...scope.eligibility,scope.week])).rows[0].mode;
  }

  function mode(user,body) {
    const scope=scopeOf(body);
    return withIdentity(pool,user.id,async client=>({mode:await roomAccess(client,user,scope)}));
  }

  async function nextWeek(user) {
    return withIdentity(pool,user.id,async client=>{
      const {rows}=await client.query(`SELECT d.week::text AS week,d.project_id,d.line,d.report_scope_id
        FROM app_private.weekly_collaboration_drafts d
        WHERE d.week=date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date+7
          AND app_private.weekly_collaboration_room_access(auth.uid(),d.project_id,d.line,d.report_scope_id,d.week)='member'
        ORDER BY d.project_id,d.line`);
      return {week:rows[0]?.week ?? null,rooms:rows.map(({project_id,line,report_scope_id})=>({project_id,line,report_scope_id}))};
    });
  }

  async function state(client, user, scope, settings, presenceInput) {
    const draft=await readWeek(client,scope);
    if (draft && draft.report_scope_id!==scope.scopeId) fail(409,'该周的合并填报范围已变化，请核对原协同稿。');
    const eligible=settings || draft
      ? (await client.query('SELECT * FROM app_private.weekly_collaboration_participants($1,$2,$3)',scope.eligibility)).rows : [];
    const submitter = draft && eligible.find(person => person.user_id === draft.submitter_id);
    let status = 'unconfigured';
    let plan = null;
    let monthPlans = null;
    let report = null;
    if (draft?.published_report_id) {
      report = (await client.query('SELECT * FROM public.reports WHERE id=$1',[draft.published_report_id])).rows[0] || null;
      status = 'published';
    } else if (draft && !submitter) status = 'submitter_unavailable';
    else if (draft) status = !draft.plan_id && !draft.shared_monthly_plan_id && await existingReport(client,scope,submitter.user_id)
      ? 'legacy_report':'ready';
    if (status==='ready' || status==='published') {
      monthPlans=await monthlySources(client,scope,draft,user,status);
      if (status==='ready') {
        const current=monthPlans.current;
        if (draft.unplanned_items!=null || current.confirmed && !current.items.length && !draft.plan_id && !draft.shared_monthly_plan_id)
          plan={id:null,shared:false,unplanned:true,items:draft.unplanned_items ?? [],project_type:current.project_type,month:current.month};
        else if (current.unavailable && (!current.confirmed || draft.shared_monthly_plan_id)) status='month_access_changed';
        else if ((draft.plan_id && current.confirmed_id!==draft.plan_id)
          || (draft.shared_monthly_plan_id && current.id!==draft.shared_monthly_plan_id)) status='plan_changed';
        else {
          const supplements=draft.supplement_items ?? [];
          plan={...current,items:[...current.items,...supplements],weekly_supplement_ids:supplements.map(item=>item.source_id)};
        }
      }
    }
    const withdrawal = !settings && draft?.submitter_id === user.id && (status==='published' || status==='ready')
      ? (await client.query('SELECT * FROM app_private.weekly_withdrawal_info($1,$2,$3,$4::date)',
        [...scope.eligibility,scope.week])).rows[0]
      : null;
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
      cursor:digest([revision,status,plan?.id,...Object.values(monthPlans || {}).map(value=>[
        value.id,value.revision,value.confirmed_id,value.items.length,value.unavailable,value.confirmation_conflict
      ]),online]),
      submitter_id:draft?.submitter_id || null, submitter_name:submitter?.name || report?.author_name || '',
      can_edit:!settings && status === 'ready', can_publish:!settings && status === 'ready' && submitter.user_id === user.id && (!plan.unplanned || plan.items.length>0),
      can_withdraw:status === 'published' && !!withdrawal?.can_withdraw,
      withdraw_blocked:status === 'published' && !!withdrawal?.withdraw_blocked,
      withdrawn_revision:withdrawal?.withdrawn_revision ?? null,
      withdrawn_attachment_ids:withdrawal?.withdrawn_attachment_ids ?? [],
      can_configure:settings && !(await ownerIsLocked(client,scope,draft)),
      eligible:settings ? eligible : [], member_ids:settings ? draft?.member_ids ?? null : undefined, plan:settings || status !== 'ready' ? null : plan,
      month_plans:settings ? undefined : monthPlans,
      cells:!settings && status === 'ready' ? draft.cells : {}, report, last_change:last || null, presence:online
    };
  }

  async function openState(user, scope, body) {
    const tab=body.tab_id ?? '';
    if (tab!=='' && (typeof tab!=='string' || !uuid.test(tab))) fail(400,'协同页面标识不正确。');
    return withIdentity(pool,user.id,async client => {
      await access(client,user,scope);
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
      const scoped=await settingsAccess(client,user,scope);
      const readSettings=()=>scoped?scopedSettingsState(client,scope):state(client,user,scope,true);
      if (!Object.hasOwn(body,'submitter_id')) return readSettings();
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
      if (draft?.submitter_id===submitter && JSON.stringify(draft.member_ids ?? null)===JSON.stringify(members)) return readSettings();
      if (draft?.published_report_id) fail(409,'该周已提交，不能修改协同设置。');
      if (draft && draft.submitter_id!==submitter) {
        // Other weeks can create or edit these drafts under the same monthly locks.
        for (const month of Object.values(monthsOf(scope))) await lockSharedMonth(client,scope,draft.submitter_id,month);
        if (await ownerIsLocked(client,scope,draft) || scoped && (await scopedConflicts(client,scope,draft.submitter_id)).has_month_draft)
          fail(409,'本周已有月计划或协同进展，不能更改负责人。');
      }
      if (members?.length) {
        const eligible=(await client.query('SELECT * FROM app_private.weekly_collaboration_participants($1,$2,$3)',scope.eligibility)).rows;
        if (!members.every(id=>eligible.some(person=>person.user_id===id))) fail(403,'协同人员须有该项目专业的填报权限。');
      }
      if (draft?.submitter_id!==submitter && (scoped ? (await scopedConflicts(client,scope,submitter)).has_report : await existingReport(client,scope,submitter)))
        fail(409,'该负责人本周已有个人周报，请选择其他报告周或核对历史记录。');
      const revision = draft ? draft.revision + 1 : 1;
      await client.query(`INSERT INTO app_private.weekly_collaboration_drafts(project_id,line,week,report_scope_id,submitter_id,configured_by,revision,member_ids)
        VALUES($1,$2,$3::date,$4,$5,$6,$7,$8) ON CONFLICT(project_id,line,week) DO UPDATE
        SET submitter_id=excluded.submitter_id,configured_by=excluded.configured_by,revision=excluded.revision,member_ids=excluded.member_ids`,
        [...scope.weekValues,scope.scopeId,submitter,user.id,revision,members]);
      await appendOperation(client,user,scope,randomUUID(),'designate',revision,null,digest([submitter,members]));
      return readSettings();
    });
    if (Object.hasOwn(body,'submitter_id')) notify(scope);
    return result;
  }

  async function catalog(user,body) {
    weekOf(body);
    return withIdentity(pool,user.id,async client => {
      const scopedProjects=await settingsAccess(client,user,null);
      const scopes=await configuredReportScopes(client);
      const grouped=new Map(scopes.flatMap(scope=>scope.project_ids.map(id=>[id,scope])));
      const records=scopedProjects ? scopedProjects.map(({project_id,project_name,...project})=>({...project,id:project_id,name:project_name}))
        : (await client.query(`SELECT id,name,project_type,reporting_professions FROM public.projects
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
    if (body.weekly_supplement === true) return supplementItems(user,body);
    const scope=scopeOf(body), operation=operationOf(body), {action,revision}=body;
    if (!['add','update'].includes(action) || !Number.isSafeInteger(revision) || revision<0) fail(400,'事项操作不正确。');
    const id=action==='add'?operation:body.source_id;
    if (typeof id!=='string' || !uuid.test(id)) fail(400,'事项标识不正确。');
    const item=normalizeMonthlyPlanItems([{...body.item,source_id:id}],scope.scopeId)[0];
    const fingerprint=digest(['items',action,id,item,revision]);
    const result=await withIdentity(pool,user.id,async client=>{
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      const draft=await readWeek(client,scope);
      if (draft) await lockSharedMonth(client,scope,draft.submitter_id,monthsOf(scope).current);
      const current=await state(client,user,scope,false);
      if (!current.can_edit || !current.plan.unplanned || current.plan.shared && current.plan.id)
        fail(409,'当前周报不允许调整独立事项，请重新读取月计划。');
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

  async function supplementItems(user,body) {
    const scope=scopeOf(body),operation=operationOf(body),{action,revision,plan_id:planId}=body;
    if (!['add','update','delete'].includes(action) || !Number.isSafeInteger(revision) || revision<1
      || typeof planId!=='string' || !uuid.test(planId)) fail(400,'本周新增事项的操作或月计划不正确。');
    const id=action==='add'?operation:body.source_id;
    if (typeof id!=='string' || !uuid.test(id)) fail(400,'事项标识不正确。');
    const item=action==='delete'?null:normalizeMonthlyPlanItems([{...body.item,source_id:id}],scope.scopeId)[0];
    const fingerprint=digest(['weekly-supplement',action,id,item,planId,revision]);
    const result=await withIdentity(pool,user.id,async client=>{
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope);
      const draft=await readWeek(client,scope);
      if (draft) await lockSharedMonth(client,scope,draft.submitter_id,monthsOf(scope).current);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      await lockConfirmedMonth(client,scope);
      const current=await state(client,user,scope,false),plan=current.plan;
      if (!current.can_edit || !plan?.can_add_weekly_items || plan.confirmed_id!==planId)
        fail(409,'当前周报或月计划已变化，请刷新后核对。');
      if (action!=='add' && revision!==current.revision) fail(409,'协同稿已更新，请核对事项后重试。');
      if (item && scope.scopeId) {
        const range=(await client.query('SELECT project_ids FROM app_private.report_scopes WHERE id=$1',[scope.scopeId])).rows[0];
        if (!range.project_ids.includes(item.project_id)) fail(400,'请选择本项目范围内的实际分期。');
      }
      const rows=draft.supplement_items.slice();
      if (action==='add') {
        if (plan.items.length>=500) fail(400,'月计划及本周新增事项合计最多 500 项。');
        rows.push(item);
      } else {
        const index=rows.findIndex(row=>row.source_id===id);
        if (index<0) fail(409,'只能修改尚未提交同步的本周新增事项。');
        if (action==='update') rows[index]=item;
        else {
          if (draft.cells[id+':prog'] || draft.cells[id+':blocker'])
            fail(409,'该事项已有当周进展或卡点，不能删除。');
          rows.splice(index,1);
        }
      }
      if (Buffer.byteLength(JSON.stringify(rows))>maxDraftBytes) fail(400,'本周新增事项累计内容已达上限。');
      const nextRevision=current.revision+1;
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET supplement_items=$4::jsonb,revision=$5,plan_id=$6
        WHERE ${weekFilter}`,[...scope.weekValues,JSON.stringify(rows),nextRevision,planId]);
      await appendOperation(client,user,scope,operation,'items',nextRevision,null,fingerprint);
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  async function writeMonth(user,body,transition) {
    const scope=scopeOf(body),operation=operationOf(body),months=monthsOf(scope);
    const {month,revision}=body;
    const target=month===months.current?'current':month===months.next?'next':null;
    if (!target || !Number.isSafeInteger(revision) || revision<0) fail(400,'只能调整当前或下月的月计划。');
    const action=transition || body.action;
    if (!transition && !['add','update','delete'].includes(action)) fail(400,'月计划事项操作不正确。');
    const id=action==='add'?operation:body.source_id;
    if (!transition && (typeof id!=='string' || !uuid.test(id))) fail(400,'月计划事项标识不正确。');
    const item=action==='add' || action==='update'?normalizeMonthlyPlanItems([{...body.item,source_id:id}],scope.scopeId)[0]:null;
    const fingerprint=digest(['month',month,action,id,item,revision]);
    const result=await withIdentity(pool,user.id,async client=>{
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope);
      const draft=await readWeek(client,scope);
      if (!draft) fail(409,'当前报告周尚未启用协同。');
      if (transition && draft.submitter_id!==user.id) fail(403,'仅本周指定负责人可以确认或撤回月计划。');
      await lockSharedMonth(client,scope,draft.submitter_id,month);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      const current=await state(client,user,scope,false);
      const plan=current.month_plans?.[target];
      if (transition==='withdraw' && target==='current' && draft.supplement_items?.length)
        fail(409,'本周已有待同步事项，请先处理新增事项后再撤回月计划。');
      const allowed=transition==='withdraw'?plan?.can_withdraw:transition==='confirm'?plan?.can_confirm:plan?.can_edit;
      if (!allowed || !plan.shared) fail(409,'当前月计划无法执行该操作，请刷新后核对。');
      if (action!=='add' && revision!==plan.revision) fail(409,'月计划已更新，请核对后重试。');
      if (item && scope.scopeId) {
        const range=(await client.query('SELECT project_ids FROM app_private.report_scopes WHERE id=$1',[scope.scopeId])).rows[0];
        if (!range.project_ids.includes(item.project_id)) fail(400,'请选择本项目范围内的实际分期。');
      }
      const sharedId=plan.id || randomUUID(), rows=plan.items.slice();
      let confirmedId=null;
      if (transition==='withdraw') {
        try {
          await client.query('SELECT app_private.withdraw_collaboration_monthly_plan($1,$2::date,$3)',[sharedId,scope.week,revision]);
        } catch (error) {
          if (error.code==='P0002' || error.code==='23514' && error.detail==='monthly_plan_in_use') fail(409,error.message);
          if (error.code==='42501') fail(403,error.message);
          throw error;
        }
      } else if (transition==='confirm') {
        const confirmed=await confirmMonthlyPlanInTransaction(client,user,{project_id:scope.projectId,line:scope.line,month,items:rows,
          ...(scope.scopeId?{report_scope_id:scope.scopeId}:{})});
        confirmedId=confirmed.id;
      } else if (action==='add') {
        if (rows.length>=500) fail(400,'月计划事项最多 500 项。');
        rows.push(item);
      } else {
        const index=rows.findIndex(row=>row.source_id===id);
        if (index<0) fail(409,'事项已变化，请刷新后核对。');
        if (action==='update') rows[index]=item;
        else {
          const {used}=(await client.query('SELECT app_private.collaboration_monthly_item_in_use($1,$2) AS used',[sharedId,id])).rows[0];
          if (used) fail(409,'该事项已有进展、卡点或已提交记录，不能删除。');
          rows.splice(index,1);
        }
      }
      if (Buffer.byteLength(JSON.stringify(rows))>maxDraftBytes) fail(400,'月计划事项累计内容已达上限。');
      if (transition!=='withdraw' && plan.id) {
        await client.query('UPDATE app_private.collaboration_monthly_drafts SET items=$2::jsonb,revision=revision+1,confirmed_id=$3 WHERE id=$1',
          [sharedId,JSON.stringify(rows),confirmedId]);
      } else if (transition!=='withdraw') {
        await client.query(`INSERT INTO app_private.collaboration_monthly_drafts
          (id,project_id,line,report_scope_id,plan_month,owner_id,origin_week,items,revision)
          VALUES($1,$2,$3,$4,$5::date,$6,$7::date,$8::jsonb,1)`,
          [sharedId,...scope.eligibility,month+'-01',draft.submitter_id,scope.week,JSON.stringify(rows)]);
      }
      const nextRevision=current.revision+1;
      await client.query('UPDATE app_private.weekly_collaboration_drafts SET revision=$4 WHERE '+weekFilter,[...scope.weekValues,nextRevision]);
      await appendOperation(client,user,scope,operation,'items',nextRevision,null,fingerprint);
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  const monthItems=(user,body)=>writeMonth(user,body);
  const confirmMonth=(user,body)=>writeMonth(user,body,'confirm');
  const withdrawMonth=(user,body)=>writeMonth(user,body,'withdraw');

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
      await access(client,user,scope);
      const draft=await readWeek(client,scope);
      if (draft) await lockSharedMonth(client,scope,draft.submitter_id,monthsOf(scope).current);
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      const current=await state(client,user,scope,false);
      if (!current.can_edit) fail(409,'该周协同稿当前无法编辑，请刷新后核对。');
      if (current.plan.id !== planId) fail(409,'协同事项来源已变化，原输入保留在当前浏览器。');
      if (!validCell(current.plan,body.cell)) fail(400,'协同单元格不属于当前事项。');
      const next = readCell(current.cells[body.cell],bytes);
      const cells = {...current.cells,[body.cell]:next};
      if (Buffer.byteLength(JSON.stringify(cells)) > maxDraftBytes) fail(400,'该周协同稿累计改动已达上限。');
      const revision = current.revision + 1;
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET plan_id=$4,cells=$5::jsonb,revision=$6,shared_monthly_plan_id=$7
        WHERE ${weekFilter}`,[...scope.weekValues,current.plan.confirmed_id ?? null,JSON.stringify(cells),revision,
        current.plan.shared?current.plan.id:null]);
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
    if (body.plan_revision!==undefined && (!Number.isSafeInteger(body.plan_revision) || body.plan_revision<0)) fail(400,'月计划版本不正确。');
    const period = body.period ?? week;
    if (typeof period !== 'string' || period.length > 100 || reportWeekStart(period) !== week)
      fail(400,'附件周期与本周协同稿不一致。');
    const attachments = body.attachment_ids ?? [];
    if (!Array.isArray(attachments) || attachments.length > 20 || attachments.some(id => typeof id !== 'string' || !uuid.test(id)))
      fail(400,'本周附件引用不正确。');
    const fingerprint = digest(['publish',body.revision,planId,period,attachments,...(body.plan_revision===undefined?[]:[body.plan_revision])]);
    const result = await withIdentity(pool,user.id,async client => {
      await lockWeeklyCollaborationWrite(client,projectId,line,week);
      await access(client,user,scope);
      const draft=await readWeek(client,scope);
      if (draft) await lockSharedMonth(client,scope,draft.submitter_id,monthsOf(scope).current);
      if (draft?.supplement_items?.length) await lockConfirmedMonth(client,scope);
      const current=await state(client,user,scope,false);
      if (current.submitter_id !== user.id) fail(403,'仅本周指定负责人可以正式提交。');
      if (await replay(client,user,scope,operation,fingerprint)) return current;
      const hasSupplements=!!draft?.supplement_items?.length;
      if (!current.can_publish || current.revision !== body.revision || current.plan.id !== planId
        || (current.plan.shared || hasSupplements || current.plan.revision>0) && current.plan.revision!==body.plan_revision)
        fail(409,'协同稿版本或状态已变化，请核对最新内容后提交。');
      const normalized = (await client.query('SELECT app_private.report_week_start($1,now())::text AS week',[period])).rows[0].week;
      if (normalized !== week) fail(400,'附件周期与本周协同稿不一致。');
      const {items,fields}=reportFields(current,current.plan,Boolean(scopeId));
      const profile = await getProfile(client,user.id);
      const row = {project_id:projectId,period,line,...(scopeId?{report_scope_id:scopeId}:{}),biz:{
        ...(current.plan.confirmed_id?{...(scopeId?{monthly_plan_ids:[current.plan.confirmed_id]}:{monthly_plan_id:current.plan.confirmed_id}),
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
      await client.query(`UPDATE app_private.weekly_collaboration_drafts SET plan_id=$4,unplanned_items=$5::jsonb,shared_monthly_plan_id=$6
        WHERE ${weekFilter}`,[...scope.weekValues,current.plan.confirmed_id ?? null,
        current.plan.unplanned?JSON.stringify(current.plan.items):null,current.plan.shared?current.plan.id:null]);
      await appendOperation(client,user,scope,operation,'publish',revision,null,fingerprint);
      if (hasSupplements) {
        try {
          await client.query('SELECT app_private.append_weekly_collaboration_monthly_items($1,$2,$3,$4::date,$5::uuid,$6::int,$7::uuid)',
            [...scope.eligibility,scope.week,current.plan.confirmed_id,current.revision,operation]);
        } catch (error) {
          if (error.code==='P4501' || error.code==='P4502') fail(409,error.message);
          if (error.code==='42501') fail(403,'仅本周指定负责人可以同步新增事项并提交。');
          if (error.code==='23514') fail(400,error.message);
          throw error;
        }
      }
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

  async function withdraw(user,body) {
    const scope = scopeOf(body);
    const operation = operationOf(body);
    const suppliedId = body.report_id;
    const reportId = typeof suppliedId === 'string' || Number.isSafeInteger(suppliedId) ? String(suppliedId) : '';
    if (!/^[1-9]\d{0,18}$/.test(reportId) || BigInt(reportId) > 9223372036854775807n)
      fail(400,'已提交周报编号不正确。');
    const revision = body.revision;
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= 2147483647)
      fail(400,'协同稿版本不正确。');
    const fingerprint = digest(['withdraw',revision,reportId]);
    const result = await withIdentity(pool,user.id,async client => {
      await lockWeeklyCollaborationWrite(client,scope.projectId,scope.line,scope.week);
      await access(client,user,scope);
      const draft = await readWeek(client,scope);
      if (draft?.submitter_id !== user.id) fail(403,'仅本周指定负责人可以撤回周报。');
      if (await replay(client,user,scope,operation,fingerprint)) return state(client,user,scope,false);
      if (draft.revision !== revision || String(draft.published_report_id) !== reportId)
        fail(409,'已提交周报的状态已变化，请刷新后核对。');
      await lockSharedMonth(client,scope,draft.submitter_id,monthsOf(scope).current);
      await appendOperation(client,user,scope,operation,'withdraw',revision+1,null,fingerprint);
      try {
        await client.query('SELECT app_private.withdraw_weekly_collaboration_report($1,$2,$3,$4::date,$5::bigint,$6::int,$7::uuid)',
          [...scope.eligibility,scope.week,reportId,revision,operation]);
      } catch (error) {
        if (error.code==='P4401') fail(409,'只能撤回当前报告周的已提交周报，请刷新后核对。');
        if (error.code==='P4402') fail(409,'这份周报已关联事项申报或历史记录，请联系管理员处理。');
        if (error.code==='P4403') fail(403,'仅本周指定负责人可以撤回周报。');
        throw error;
      }
      return state(client,user,scope,false);
    });
    notify(scope);
    return result;
  }

  return {open,poll,mode,nextWeek,catalog,settings,items,monthItems,confirmMonth,withdrawMonth,change,publish,withdraw};
}
