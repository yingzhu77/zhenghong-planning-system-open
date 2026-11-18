import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { executeDatabase, withIdentity } from '../server/database.mjs';
import { confirmMonthlyPlan } from '../server/monthly-plans.mjs';
import { listCompletions, previewCompletion, requestCompletion, reviewCompletion } from '../server/completions.mjs';
import { completionStatistics } from '../server/completion-statistics.mjs';
import { recognizeProgress } from '../server/progress-status.mjs';
import { supplyReportedCompletionDate } from '../server/reported-completions.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';

const reportedOn='2026-11-18', effectiveDue='2026-11-10';
test('recognition reads the full feedback and requires an actual date for closure', () => {
  const check=(progress,status,completedOn,extra={})=>assert.deepEqual(
    recognizeProgress({progress,reportedOn,effectiveDue,...extra}), {status,...(completedOn?{completedOn}:{})});
  check('甲区完成，乙区完成50%，其余待施工。','incomplete');
  check('破除完成已归堆，因扬尘管控，待外运。','incomplete');
  check('因方案未确定，暂缓施工。','incomplete');
  check('已移交甲区，乙区支模完成５０％。','incomplete');
  check('完成。','awaiting_date');
  check('计划于11月15日完成','incomplete');
  check('11月9日已全部完成。','on_time','2026-11-09');
  check('整项完成，实际完成日期：2026年11月13日。','late','2026-11-13',{subject:'整项'});
  check('11月30日完成。','unclear');
  check('已完成，尚有验收未签。','incomplete');
  check('已完成。','incomplete',null,{blocker:'仍需移交签字'});
  check('子项完成交接。','unclear');
  check('2026-11-13已完工','completed_without_deadline','2026-11-13',{effectiveDue:''});
});

test('ordinary report auto-closes monthly work, accepts the owner’s missing date and leaves prior approvals intact', async t => {
  const db = await initializedDatabase();
  t.after(()=>db.close());
  const pool=testPool(db), admin=testPool(db,null), pm={id:'demo-pm-com'}, ops={id:'demo-ops'};
  await seedDemo(admin);
  const project='demo-com', line='土建工程（东地块）';
  const items = [
    ['explicit','全部完成的测试事项','2026-11-10','2026-11-12全部完成。'],
    ['needs-date','需要填写日期的测试事项','2026-11-10','完成。'],
    ['partial','仍需办理的测试事项','2026-11-10','甲项已完成，乙项仍需验收。'],
    ['old-extension','批准延期的测试事项','2026-11-10','2026-11-12已完成。']
  ].map(([source_id,name,due,prog])=>({source_id,mod:'测试分类',name,due,prog,blocker:''}));
  const plan=await confirmMonthlyPlan(pool,pm,{project_id:project,line,month:'2026-11',items:items.map(({prog,blocker,...item})=>item)});
  const key=id=>'monthly:'+project+':'+plan.id+':'+id;
  const extensionSource=await previewCompletion(pool,pm,{source_key:key('old-extension')});
  const extension=await requestCompletion(pool,pm,{source_key:key('old-extension'),source_version:extensionSource.source_version,
    request_type:'extension',requested_due:'2026-11-13',completion_note:'模拟批准的延期计划'});
  await reviewCompletion(pool,ops,{id:extension.id,expected_revision:extension.revision,decision:'approve',note:''});
  const [report]=await executeDatabase(pool,pm,{table:'reports',operation:'upsert',onConflict:'project_id,period,line,author_id',
    values:{project_id:project,period:'2026-11-16',line,biz:{monthly_plan_id:plan.id,monthly_plan_month:'2026-11',items}}});
  const read=()=>listCompletions(pool,pm,{source_keys:items.map(item=>key(item.source_id))});
  const first=await read();
  const explicit=first.find(row=>row.source_key===key('explicit'));
  assert.equal(explicit.status,'approved');
  assert.equal(explicit.reviewer_name,'系统识别');
  assert.equal(explicit.reviewer_id,null);
  assert.equal(explicit.completion_category,'late');
  assert.equal(first.find(row=>row.source_key===key('old-extension') && row.request_type==='completion').completion_category,'on_time');
  assert.ok(!first.some(row=>[key('partial'),key('needs-date')].includes(row.source_key)));
  const evidence=report.progress_recognition.find(row=>row.source_key===key('needs-date'));
  assert.equal(evidence.status,'awaiting_date');
  const request={report_id:String(report.id),source_key:evidence.source_key,completion_date:'2026-11-10'};
  await assert.rejects(supplyReportedCompletionDate(pool,ops,request), error=>error.status===403);
  await assert.rejects(supplyReportedCompletionDate(pool,pm,{...request,source_key:key('partial')}),error=>error.status===409);
  await assert.rejects(supplyReportedCompletionDate(pool,pm,{...request,completion_date:'2099-01-01'}),error=>error.status===400);
  await supplyReportedCompletionDate(pool,pm,request);
  await supplyReportedCompletionDate(pool,pm,request);
  const rows=await read(), record=rows.find(row=>row.source_key===key('needs-date'));
  assert.equal(record.completion_category,'on_time');
  assert.equal(record.completion_date,'2026-11-10');
  assert.equal(record.source_snapshot.completion_feedback.report_id,String(report.id));
  assert.equal(rows.filter(row=>row.source_key===evidence.source_key).length,1);
  const stats=await completionStatistics(pool,ops,{project_id:project,start:'2026-11-01',end:'2026-11-30'});
  assert.equal(stats.totals.completed,3);
  assert.equal(stats.totals.late,1);
  const unauthorizedInsert=(client)=>client.query(`INSERT INTO public.completion_requests(id,source_key,source_version,
    project_id,kind,source_id,title,what,source_snapshot,owner_id,owner_name,completion_date,completion_note)
    VALUES($1,$2,$3,$4,'plan','partial','测试','测试',$5,$6,'','2026-11-01','非法测试')`,[
      randomUUID(),key('partial'),'0'.repeat(64),project,JSON.stringify({completion_feedback:{report_id:String(report.id)}}),pm.id
    ]);
  await assert.rejects(withIdentity(pool,pm.id,unauthorizedInsert),error=>error.code==='42501');
});
