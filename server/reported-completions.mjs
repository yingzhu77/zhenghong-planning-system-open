import { randomUUID } from 'node:crypto';
import { getProfile, withIdentity } from './database.mjs';
import { resolveCompletionSource } from './completion-sources.mjs';
import { HttpError } from './errors.mjs';
import { recognizeProgress, reportProgressEntries, validProgressDate } from './progress-status.mjs';

const shanghaiDay = timestamp => new Date(new Date(timestamp).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const today = () => shanghaiDay(Date.now());
const fail = (status, message) => { throw new HttpError(status, message, 'reported_completion'); };
const identity = (client, id) => client.query("SELECT set_config('app.current_user_id',$1,true)", [id]);
const evidenceId = entry => JSON.stringify([entry.key, entry.ownerId]);

function uniqueEntries(report) {
  const seen = new Map();
  for (const entry of reportProgressEntries(report)) {
    const id = evidenceId(entry);
    seen.set(id, seen.has(id) ? null : entry);
  }
  return [...seen.values()].filter(Boolean);
}

export function annotateReportProgress(report) {
  if (!report.id || !report.project_id || !report.author_id || !report.biz) return report;
  const reportedOn = today();
  const recognized = uniqueEntries(report).map(entry => {
    const result = recognizeProgress({...entry, reportedOn});
    return { source_key:entry.key, owner_id:entry.ownerId, status:result.status };
  }).filter(entry => entry.status !== 'not_reported');
  return recognized.length ? {...report, progress_recognition:recognized} : report;
}

async function complete(client, owner, report, entry, completedOn, submittedBy) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['completion:' + entry.key]);
  const old = (await client.query(`SELECT status,source_snapshot FROM public.completion_requests
    WHERE source_key=$1 AND owner_id=$2 AND (request_type='completion' OR status='pending')`,
  [entry.key, entry.ownerId])).rows;
  if (old.length) {
    if (old.some(row => row.status==='approved' && row.source_snapshot?.completion_feedback?.report_id===String(report.id))) return true;
    return false;
  }
  let source;
  try { source = await resolveCompletionSource(client, owner, entry.key); }
  catch (error) {
    if (error instanceof HttpError && [400,403,404].includes(error.status)) return false;
    throw error;
  }
  if (source.milestone_done || source.what.trim()!==entry.subject?.trim?.()) return false;
  const snapshot = {...source.source_snapshot, source_key:source.source_key, source_version:source.source_version,
    title:source.title, what:source.what, due:source.due, original_due:source.original_due, effective_due:source.effective_due,
    completion_feedback:{ report_id:String(report.id), progress:entry.progress, recorded_by:submittedBy,
      ...(report.evidence_revision ? {report_revision:report.evidence_revision} : {}) }};
  if (source.rich_text) snapshot.rich_text=source.rich_text;
  await client.query("SELECT set_config('app.reported_completion',$1,true)", [String(report.id)]);
  await client.query(`INSERT INTO public.completion_requests(id,source_key,source_version,project_id,kind,source_id,report_id,
    title,what,due,source_snapshot,owner_id,owner_name,completion_date,completion_note,request_type)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',$13,$14,'completion')`,
  [randomUUID(),entry.key,source.source_version,source.project_id,source.kind,source.source_id,source.report_id || null,
    source.title,source.what,source.due || '',JSON.stringify(snapshot),entry.ownerId,completedOn,entry.progress.trim()]);
  await client.query("SELECT set_config('app.reported_completion','',true)");
  return true;
}

export async function completeFromReport(client, user, report, collaborative = false) {
  if (!report?.id || report.author_id !== user.id) return;
  const reportedOn = today();
  const entries = uniqueEntries(report).filter(entry => (collaborative || entry.ownerId===user.id) && entry.progress.trim().length<=10000)
    .sort((a,b)=>a.key.localeCompare(b.key) || a.ownerId.localeCompare(b.ownerId));
  for (const entry of entries) {
    const {completedOn} = recognizeProgress({...entry, reportedOn});
    if (!completedOn) continue;
    if (entry.ownerId!==user.id) await identity(client, entry.ownerId);
    await complete(client, {id:entry.ownerId}, report, entry, completedOn, user.id);
    if (entry.ownerId!==user.id) await identity(client, user.id);
  }
}

export async function supplyReportedCompletionDate(pool, user, body) {
  const {report_id:id, source_key:key, completion_date:date} = body || {};
  const reportedOn = today();
  if (typeof id!=='string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id)>9223372036854775807n
    || typeof key!=='string' || !key.length || key.length>500 || key.includes('\u0000') || !validProgressDate(date, reportedOn))
    fail(400,'请填写有效的实际完成日期。');
  return withIdentity(pool, user.id, async client => {
    const profile = await getProfile(client, user.id);
    if (profile?.role!=='pm' || profile.status!=='approved') fail(403,'当前账号不能补填实际完成日期。');
    const report = (await client.query('SELECT id,project_id,author_id,updated_at,updated_at::text AS evidence_revision,submitted_at,biz FROM public.reports WHERE id=$1',[id])).rows[0];
    const entry = report && uniqueEntries(report).find(entry => entry.key===key && entry.ownerId===user.id);
    if (!entry) fail(403,'只能为本人承办且已提交的事项补日期。');
    const latest = [reportedOn, shanghaiDay(report.updated_at || report.submitted_at)].sort()[0];
    if (date>latest || entry.progress.trim().length>10000) fail(400,'实际完成日期应在该周报保存当天或之前。');
    const status = recognizeProgress({...entry, reportedOn:latest}).status;
    if (status!=='awaiting_date') fail(409,'该反馈当前无需补完成日期，请刷新后核对。');
    try {
      if (!await complete(client, user, report, entry, date, user.id)) fail(409,'事项来源或申报状态已变化，请刷新后核对。');
    } catch (error) {
      if (error.code==='P4801') fail(409,'这条周报反馈已更新，请刷新后核对原文。');
      throw error;
    }
    return { source_key:key };
  });
}
