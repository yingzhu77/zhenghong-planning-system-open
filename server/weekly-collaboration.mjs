import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { getProfile, lockHongfangWeeklyWrite, reportDelay, reportStatus, reportWeekStart, withIdentity } from './database.mjs';
import { HttpError } from './errors.mjs';
import { validateReportAttachmentReferences } from './report-attachments.mjs';
import { validateRichText } from './rich-text.mjs';

const project = 'hf';
const line = '设计部';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxCellBytes = 65536;
const maxDraftBytes = 2 * 1024 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => { throw new HttpError(status, message, 'weekly_collaboration'); };

function weekOf(body) {
  const value = body?.week;
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value) || reportWeekStart(value) !== value) fail(400, '请选择有效的报告周（周一）。');
  return value;
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

async function readWeek(client, week) {
  return (await client.query('SELECT * FROM app_private.hongfang_weekly_drafts WHERE week=$1::date', [week])).rows[0];
}

async function confirmedPlan(client, week, submitter) {
  const month = week.slice(0, 7);
  const row = (await client.query(`SELECT id,items,rich_text FROM public.monthly_plans
    WHERE project_id=$1 AND line=$2 AND confirmed_by=$3 AND plan_month=$4::date AND report_scope_id IS NULL`,
    [project, line, submitter, month + '-01'])).rows[0];
  return row && { ...row, month };
}

async function existingReport(client, week, submitter) {
  return (await client.query(`SELECT EXISTS(SELECT 1 FROM public.reports WHERE project_id=$1 AND line=$2
    AND author_id=$3 AND app_private.hongfang_weekly_existing_report_week(period,submitted_at)=$4::date) AS found`,
    [project,line,submitter,week])).rows[0].found;
}

async function appendOperation(client, user, week, operation, kind, revision, cell, fingerprint) {
  const { name } = await getProfile(client, user.id);
  await client.query(`INSERT INTO app_private.hongfang_weekly_operations
    (week,operation_id,actor_id,actor_name,kind,revision,cell,payload_hash) VALUES($1::date,$2,$3,$4,$5,$6,$7,$8)`,
    [week,operation,user.id,name,kind,revision,cell,fingerprint]);
}

async function replay(client, user, week, operation, fingerprint) {
  const row = (await client.query(`SELECT actor_id,payload_hash FROM app_private.hongfang_weekly_operations
    WHERE week=$1::date AND operation_id=$2`, [week,operation])).rows[0];
  if (row && (row.actor_id !== user.id || row.payload_hash !== fingerprint)) fail(409, '该协同操作编号已被使用。');
  return Boolean(row);
}

function reportFields(draft, plan) {
  const fields = {};
  for (const [key, delta] of Object.entries(plan.rich_text?.fields || {})) fields['biz.' + key] = delta;
  const items = plan.items.map((item, index) => {
    const result = { ...item };
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
  function notify(week) { sequence++; events.emit(week); }

  function people(week, eligible) {
    const now = Date.now();
    const known = new Map(eligible.map(person => [person.user_id, person.name]));
    const result = [];
    for (const [key, entry] of presence) {
      if (entry.until < now) presence.delete(key);
      else if (entry.week === week && known.has(entry.user_id))
        result.push({ user_id:entry.user_id, name:known.get(entry.user_id), active_cell:entry.active_cell });
    }
    return result;
  }

  function touch(user, week, activeCell) {
    const key = week + ':' + user.id;
    const prior = presence.get(key);
    const next = {week,user_id:user.id,active_cell:activeCell,until:Date.now() + 35000};
    presence.set(key,next);
    if (!prior || prior.until < Date.now() || prior.active_cell !== next.active_cell) notify(week);
  }

  async function access(client, user, settings) {
    const sql = settings ? 'app_private.hongfang_weekly_operator()' : 'app_private.hongfang_weekly_eligible($1)';
    const { allowed } = (await client.query('SELECT ' + sql + ' AS allowed', settings ? [] : [user.id])).rows[0];
    if (!allowed) fail(403, settings ? '只有管理员可指定提交负责人。' : '当前账号没有弘坊设计部协同权限。');
  }

  async function state(client, user, week, settings, activeCell) {
    const draft = await readWeek(client,week);
    const eligible = (await client.query('SELECT * FROM app_private.hongfang_weekly_participants()')).rows;
    const submitter = draft && eligible.find(person => person.user_id === draft.submitter_id);
    let status = 'unconfigured';
    let plan = null;
    let report = null;
    if (draft?.published_report_id) {
      report = (await client.query('SELECT * FROM public.reports WHERE id=$1',[draft.published_report_id])).rows[0] || null;
      status = 'published';
    } else if (draft && !submitter) status = 'submitter_unavailable';
    else if (draft) {
      plan = await confirmedPlan(client,week,submitter.user_id) || null;
      if (await existingReport(client,week,submitter.user_id)) status = 'legacy_report';
      else if (draft.plan_id && draft.plan_id !== plan?.id) status = 'plan_changed';
      else status = plan ? 'ready' : 'missing_plan';
    }
    if (!settings && draft) touch(user,week,validCell(plan,activeCell) ? activeCell : null);
    const online = people(week,eligible);
    const last = !settings && draft && (await client.query(`SELECT actor_name,recorded_at AS at,cell
      FROM app_private.hongfang_weekly_operations WHERE week=$1::date AND kind='edit' ORDER BY revision DESC LIMIT 1`,[week])).rows[0];
    const revision = draft?.revision || 0;
    return {
      week, status, revision,
      cursor:digest([revision,status,plan?.id,online]),
      submitter_id:draft?.submitter_id || null, submitter_name:submitter?.name || report?.author_name || '',
      can_edit:!settings && status === 'ready', can_publish:!settings && status === 'ready' && submitter.user_id === user.id,
      can_configure:settings && !draft?.plan_id && !draft?.published_report_id,
      eligible:settings ? eligible : [], plan:settings || status !== 'ready' ? null : plan,
      cells:!settings && status === 'ready' ? draft.cells : {}, report, last_change:last || null, presence:online
    };
  }

  async function open(user,body) {
    const week = weekOf(body);
    return withIdentity(pool,user.id,async client => {
      await access(client,user,false);
      return state(client,user,week,false,body.active_cell);
    });
  }

  function waitForChange(week, signal) {
    return new Promise(resolve => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        events.off(week,done);
        signal?.removeEventListener('abort',done);
        resolve();
      };
      const timer = setTimeout(done,12000);
      events.once(week,done);
      signal?.addEventListener('abort',done,{once:true});
    });
  }

  async function poll(user,body,signal) {
    const week = weekOf(body);
    const start = sequence;
    const changed = result => result.revision !== body.since_revision || result.cursor !== body.since_cursor;
    const first = await open(user,body);
    if (changed(first)) return first;
    if (sequence === start) await waitForChange(week,signal);
    if (signal?.aborted) return null;
    const next = await open(user,body);
    return changed(next) ? next : null;
  }

  async function settings(user,body) {
    const week = weekOf(body);
    const result = await withIdentity(pool,user.id,async client => {
      await access(client,user,true);
      if (!Object.hasOwn(body,'submitter_id')) return state(client,user,week,true);
      const submitter = body.submitter_id;
      if (typeof submitter !== 'string' || !submitter || submitter.length > 128) fail(400,'请选择一位提交负责人。');
      const { allowed } = (await client.query('SELECT app_private.hongfang_weekly_eligible($1) AS allowed',[submitter])).rows[0];
      if (!allowed) fail(403,'提交负责人须有弘坊设计部填报权限。');
      await lockHongfangWeeklyWrite(client,week);
      const draft = await readWeek(client,week);
      if (draft?.submitter_id === submitter) return state(client,user,week,true);
      if (draft?.plan_id || draft?.published_report_id) fail(409,'该周已经开始编制，负责人已锁定。');
      if (await existingReport(client,week,submitter)) fail(409,'该负责人本周已有个人周报，请选择其他报告周或核对历史记录。');
      const revision = draft ? draft.revision + 1 : 1;
      await client.query(`INSERT INTO app_private.hongfang_weekly_drafts(week,submitter_id,configured_by,revision)
        VALUES($1::date,$2,$3,$4) ON CONFLICT(week) DO UPDATE
        SET submitter_id=excluded.submitter_id,configured_by=excluded.configured_by,revision=excluded.revision`,[week,submitter,user.id,revision]);
      await appendOperation(client,user,week,randomUUID(),'designate',revision,null,digest([submitter]));
      return state(client,user,week,true);
    });
    if (Object.hasOwn(body,'submitter_id')) notify(week);
    return result;
  }

  async function change(user,body) {
    const week = weekOf(body);
    const operation = operationOf(body);
    const encoded = body.update;
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(maxCellBytes / 3) * 4) fail(400,'协同单元格更新过长或格式不正确。');
    const bytes = Buffer.from(encoded,'base64');
    if (!bytes.length || bytes.length > maxCellBytes || bytes.toString('base64') !== encoded) fail(400,'协同单元格更新格式不正确。');
    const planId = body.plan_id;
    if (typeof planId !== 'string' || !uuid.test(planId)) fail(400,'确认月计划标识不正确。');
    const fingerprint = digest(['edit',planId,body.cell,encoded]);
    const result = await withIdentity(pool,user.id,async client => {
      await access(client,user,false);
      await lockHongfangWeeklyWrite(client,week);
      if (await replay(client,user,week,operation,fingerprint)) return state(client,user,week,false,body.cell);
      const current = await state(client,user,week,false,body.cell);
      if (!current.can_edit) fail(409,'该周协同稿当前无法编辑，请刷新后核对。');
      if (current.plan.id !== planId) fail(409,'确认月计划已变化，原输入保留在当前浏览器。');
      if (!validCell(current.plan,body.cell)) fail(400,'协同单元格不属于当前确认计划。');
      const next = readCell(current.cells[body.cell],bytes);
      const cells = {...current.cells,[body.cell]:next};
      if (Buffer.byteLength(JSON.stringify(cells)) > maxDraftBytes) fail(400,'该周协同稿累计改动已达上限。');
      const revision = current.revision + 1;
      await client.query(`UPDATE app_private.hongfang_weekly_drafts SET plan_id=$2,cells=$3::jsonb,revision=$4
        WHERE week=$1::date`,[week,current.plan.id,JSON.stringify(cells),revision]);
      await appendOperation(client,user,week,operation,'edit',revision,body.cell,fingerprint);
      return state(client,user,week,false,body.cell);
    });
    notify(week);
    return result;
  }

  async function publish(user,body) {
    const week = weekOf(body);
    const operation = operationOf(body);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400,'协同稿版本不正确。');
    const planId = body.plan_id;
    if (typeof planId !== 'string' || !uuid.test(planId)) fail(400,'确认月计划标识不正确。');
    const period = body.period ?? week;
    if (typeof period !== 'string' || period.length > 100 || reportWeekStart(period) !== week)
      fail(400,'附件周期与本周协同稿不一致。');
    const attachments = body.attachment_ids ?? [];
    if (!Array.isArray(attachments) || attachments.length > 20 || attachments.some(id => typeof id !== 'string' || !uuid.test(id)))
      fail(400,'本周附件引用不正确。');
    const fingerprint = digest(['publish',body.revision,planId,period,attachments]);
    const result = await withIdentity(pool,user.id,async client => {
      await access(client,user,false);
      await lockHongfangWeeklyWrite(client,week);
      const current = await state(client,user,week,false);
      if (current.submitter_id !== user.id) fail(403,'仅本周指定负责人可以正式提交。');
      if (await replay(client,user,week,operation,fingerprint)) return current;
      if (!current.can_publish || current.revision !== body.revision || current.plan.id !== planId)
        fail(409,'协同稿版本或状态已变化，请核对最新内容后提交。');
      const normalized = (await client.query('SELECT app_private.report_week_start($1,now())::text AS week',[period])).rows[0].week;
      if (normalized !== week) fail(400,'附件周期与本周协同稿不一致。');
      const {items,fields} = reportFields(current,current.plan);
      const profile = await getProfile(client,user.id);
      const row = {project_id:project,period,line,biz:{
        monthly_plan_id:current.plan.id,monthly_plan_month:current.plan.month,items,attachments,
        weekly_collaboration:{week,revision:current.revision}
      }};
      await validateReportAttachmentReferences(client,user.id,profile,row);
      const rich = validateRichText('reports',Object.keys(fields).length ? {v:1,fields} : {},row);
      const status = reportStatus(await reportDelay(client,[project]));
      const revision = current.revision + 1;
      await client.query('UPDATE app_private.hongfang_weekly_drafts SET plan_id=$2 WHERE week=$1::date',[week,current.plan.id]);
      await appendOperation(client,user,week,operation,'publish',revision,null,fingerprint);
      await client.query("SELECT set_config('app.hongfang_weekly_publish',$1,true)",[operation]);
      const { id } = (await client.query(`INSERT INTO public.reports(project_id,period,line,author_id,author_name,biz,rich_text,status)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) RETURNING id`,
        [project,period,line,user.id,profile.name,JSON.stringify(row.biz),JSON.stringify(rich),status])).rows[0];
      await client.query(`UPDATE app_private.hongfang_weekly_drafts SET revision=$2,published_revision=$3,published_report_id=$4
        WHERE week=$1::date`,[week,revision,current.revision,id]);
      return state(client,user,week,false);
    });
    notify(week);
    return result;
  }

  return {open,poll,settings,change,publish};
}
