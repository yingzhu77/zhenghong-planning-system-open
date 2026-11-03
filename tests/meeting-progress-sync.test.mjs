import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { executeDatabase, reportWeekStart } from '../server/database.mjs';
import { saveReporterTask, listReporterTasks } from '../server/reporter-tasks.mjs';
import { requestCompletion, reviewCompletion } from '../server/completions.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';

const pm = { id: 'demo-pm-res' }, ops = { id: 'demo-ops' };
const doc = insert => ({ ops: [{ insert, attributes: { bold: true } }] });
const rich = fields => ({ v: 1, fields });
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
test('report week boundaries use Shanghai and preserve a historical label year', () => {
  assert.equal(reportWeekStart('第1周（12.29–01.04）', '2025-12-31T01:00:00Z'), '2025-12-29');
  assert.equal(reportWeekStart('第43周', '2025-10-22T01:00:00Z'), '2025-10-20');
  assert.equal(reportWeekStart('第43周', '2026-10-22T01:00:00Z'), '2026-10-19');
  assert.equal(reportWeekStart('2026-10-19'), '2026-10-19');
});

test('current report synchronizes one live task transactionally; history, approvals, versions and formats remain protected', async t => {
  const db = await initializedDatabase(); t.after(() => db.close());
  const pool = testPool(db), admin = testPool(db, null);
  await seedDemo(admin);
  const task = await saveReporterTask(pool, ops, { project_id: 'demo-res', owner_id: pm.id, title: '同步进展', what: '保留原事项', rich_text: rich({ what: doc('保留原事项') }) });
  const monday = reportWeekStart(today());
  const item = (revision, progress, extra = {}) => ({ source_key: 'meeting:demo-res:' + task.id, source_id: task.id, source_type: 'meeting', what: task.what, progress, status: 'in_progress', source_revision: revision, ...extra });
  const save = (period, followup, extra = {}) => executeDatabase(pool, pm, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
    project_id: 'demo-res', period, line: '综合', biz: { followups: [followup] }, ...extra
  } });
  const submitted = (await save(monday, item(1, '本周已完成资料整理', { status: 'completed' }), { rich_text: rich({ 'biz.followups.0.progress': doc('本周已完成资料整理') }) }))[0];
  let current = (await listReporterTasks(pool, pm, { id: task.id }))[0];
  assert.equal(current.progress, '本周已完成资料整理');
  assert.equal(current.status, 'in_progress', 'report completion cannot approve or close the task');
  assert.equal(current.revision, 2);
  assert.deepEqual(current.rich_text.fields.what, task.rich_text.fields.what);
  assert.deepEqual(current.rich_text.fields.progress, doc(current.progress));
  assert.equal(current.history[0].data.progress, '');
  assert.equal(submitted.biz.followups[0].source_revision, 2);
  const originalSnapshot = (await admin.query('SELECT to_jsonb(r) AS row FROM public.reports r WHERE id=$1', [submitted.id])).rows[0].row;
  await assert.rejects(save(monday, item(1, '陈旧覆盖')), error => error.code === 'meeting_progress_conflict');
  assert.deepEqual((await admin.query('SELECT to_jsonb(r) AS row FROM public.reports r WHERE id=$1', [submitted.id])).rows[0].row, originalSnapshot, 'conflict rolls back report and task');
  const lastWeek = new Date(Date.parse(monday + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  await save(lastWeek, item(1, '仅补录历史周报'));
  assert.equal((await listReporterTasks(pool, pm, { id: task.id }))[0].progress, current.progress, 'past reports cannot flow into current work');
  await save(monday, item(2, '纯文字更新'));
  current = (await listReporterTasks(pool, pm, { id: task.id }))[0];
  assert.equal(current.revision, 3);
  assert.equal(current.rich_text.fields.progress, undefined, 'plain progress clears stale rich runs');
  assert.deepEqual(current.rich_text.fields.what, task.rich_text.fields.what);
  const preview = await import('../server/completions.mjs').then(m => m.previewCompletion(pool, pm, { source_key: 'meeting:demo-res:' + task.id }));
  const pending = await requestCompletion(pool, pm, { source_key: preview.source_key, source_version: preview.source_version, completion_date: today(), completion_note: '已落实', request_type: 'completion' });
  await reviewCompletion(pool, ops, { id: pending.id, expected_revision: pending.revision, decision: 'approve', note: '通过' });
  await save(monday, item(1, '审核后补充报告文字'));
  const closed = (await listReporterTasks(pool, pm, { id: task.id }))[0];
  assert.equal(closed.progress, '纯文字更新');
  assert.equal(closed.revision, 3, 'approved work is not reopened or edited through its report snapshot');
  await admin.query("INSERT INTO public.project_members(user_id,project_id) VALUES ('demo-pm-com','demo-res')");
  const reassigned = await saveReporterTask(pool, ops, { id: task.id, project_id: 'demo-res', expected_revision: 3, owner_id: 'demo-pm-com' });
  const retained = (await save(monday, item(3, '原责任人的报告快照仍可提交')))[0];
  assert.equal(retained.biz.followups[0].source_missing, true);
  const newOwnerTask = (await listReporterTasks(pool, ops, { id: task.id }))[0];
  assert.equal(newOwnerTask.progress, ''); assert.equal(newOwnerTask.revision, reassigned.revision, 'retained snapshot cannot update the new owner');
  const foreign = await saveReporterTask(pool, ops, { project_id: 'demo-res', owner_id: 'demo-pm-com', title: '他人事项', what: '未曾向本人分派' });
  await assert.rejects(save(monday, { ...item(1, '伪造越权'), source_key: 'meeting:demo-res:' + foreign.id, source_id: foreign.id }), error => error.status === 403);
});

const richSource = await readFile(new URL('../web/rich-text.js', import.meta.url), 'utf8');
const taskSource = await readFile(new URL('../web/reporter-tasks.js', import.meta.url), 'utf8');
const windowSource = await readFile(new URL('../web/planning-windows.js', import.meta.url), 'utf8');
function frontend(overrides = {}) {
  const S = { uid: 'owner', profile: { role: 'pm', name: '本人' }, pmProject: 'p1', pmPeriod: '2026-10-19', pmLine: '综合', reports: [], leaderNotes: [], reporterTasks: [], followupRows: [] };
  const elements = {}, messages = []; let draftSaves = 0;
  class Now extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-22T01:00:00Z'])); } }
  const context = { Date: Now, document: { getElementById: id => elements[id] || null } }; context.window = context;
  vm.createContext(context); [richSource, windowSource, taskSource].forEach(code => vm.runInContext(code, context));
  const rt = context.ZHRichText, api = context.ReporterTasks;
  api.configure({ S, currentPeriod: () => '2026-10-19', weekNo: () => 43, esc: String, richItem: rt.field, richCopy: rt.copy,
    richCollect: rt.collect, render() {}, flush() {}, saveDraft() { draftSaves++; }, toast: message => messages.push(message),
    request: async (url, body) => ({ data: { ...S.reporterTasks[0], ...body, revision: 3 } }), reloadTasks: async () => {}, ...overrides });
  return { S, rt, api, elements, context, get draftSaves() { return draftSaves; } };
}
const liveTask = extra => ({ id: 'task', project_id: 'p1', owner_id: 'owner', title: '专项会议决议事项', meeting_kind: 'special', what: '会议事项', status: 'in_progress', progress: '当前进展', revision: 2, created_at: '2026-10-19T01:00:00Z', updated_at: '2026-10-22T01:00:00Z', ...extra });
const snapshotItem = extra => ({ source_key: 'meeting:p1:task', source_id: 'task', source_type: 'meeting', what: '会议事项', progress: '已提交旧进展', status: 'in_progress', source_revision: 1, ...extra });
test('live meeting progress enters current form, preserves snapshots and requires a choice for conflicting drafts', () => {
  const h = frontend(), original = snapshotItem();
  h.S.reporterTasks = [liveTask()]; h.S.pmReport = { period: '2026-10-19', submitted_at: '2026-10-20T01:00:00Z', biz: { followups: [original] } };
  h.api.prepare(); assert.equal(h.S.followupRows[0].progress, '当前进展'); assert.equal(original.progress, '已提交旧进展');
  h.S.followupRows = [snapshotItem({ progress: '未提交草稿' })];
  h.api.syncMeetingRows(true); assert.equal(h.S.followupRows[0].progress, '未提交草稿'); assert.match(h.api.validationError(), /核对冲突/);
  h.api.resolveMeeting(0, true); assert.equal(h.S.followupRows[0].progress, '未提交草稿'); assert.equal(h.S.followupRows[0].source_revision, 2); assert.equal(h.api.validationError(), '');
  h.S.pmReport.biz.followups=[snapshotItem({source_revision:2,progress:'部署前已提交但尚未回写task的进展'})];
  h.api.prepare();h.api.syncMeetingRows(true);
  assert.equal(h.S.followupRows[0].progress,'部署前已提交但尚未回写task的进展','unchanged task revision cannot erase existing report feedback');
  h.S.pmReport.biz.followups=[snapshotItem({progress:'旧版无revision进展'})];delete h.S.pmReport.biz.followups[0].source_revision;
  h.api.prepare();assert.equal(h.S.followupRows[0].progress,'旧版无revision进展');assert.equal(h.S.followupRows[0].meeting_conflict,true);
  h.S.pmPeriod = '2026-10-12'; h.S.pmReport = { period: '2026-10-12', submitted_at: '2026-10-13T01:00:00Z', biz: { followups: [original] } };
  h.api.prepare(); h.api.syncMeetingRows(true); assert.equal(h.S.followupRows[0].progress, original.progress, 'historical editable report remains its own snapshot');
});
test('classification save updates current draft and its rich progress without changing the report or other drafts', async () => {
  const h = frontend(), original = snapshotItem({ source_revision: 2 });
  h.S.reporterTasks = [liveTask()]; h.S.pmReport = { submitted_at: '2026-10-20T01:00:00Z', biz: { followups: [original] } };
  h.api.prepare(); h.S.followupRows.push({ source_key: 'coord:p1:other', source_type: 'coord', what: '其他事项', progress: '其他未提交输入', status: 'open' });
  h.api.edit(0); h.elements.meeting_progress = { value: '分类表新进展' }; h.api.binding('meeting_progress').set(doc('分类表新进展'));
  await h.api.save();
  assert.equal(h.S.followupRows[0].progress, '分类表新进展'); assert.equal(h.S.followupRows[0].source_revision, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(h.rt.doc(h.S.followupRows[0], 'progress'))), doc('分类表新进展'));
  assert.equal(h.S.followupRows[1].progress, '其他未提交输入'); assert.equal(original.progress, '已提交旧进展'); assert.equal(h.draftSaves, 1);
});
test('a late classification response preserves progress and formatting typed in the form while waiting', async () => {
  let resolve;
  const h=frontend({request:()=>new Promise(done=>{resolve=done;})});
  h.S.reporterTasks=[liveTask()];h.api.prepare();h.api.edit(0);
  h.elements.meeting_progress={value:'分类表已发送'};
  const pending=h.api.save();
  h.elements.followup_progress_0={value:'等待时新输入'};
  h.api.binding('followup_progress_0').set(doc('等待时新输入'));
  resolve({data:liveTask({revision:3,progress:'分类表已发送'})});await pending;
  assert.equal(h.S.followupRows[0].progress,'等待时新输入');
  assert.equal(h.S.followupRows[0].meeting_conflict,true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.rt.doc(h.S.followupRows[0],'progress'))),doc('等待时新输入'));
  assert.equal(h.S.reporterTasks[0].progress,'分类表已发送');
});
