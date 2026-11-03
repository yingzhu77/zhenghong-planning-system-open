// Explicitly disposable runtime for browser acceptance. Never loads .env or a
// configured database URL; the only database is a fresh in-memory PGlite.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../../server/app.mjs';
import { executeDatabase } from '../../server/database.mjs';
import { confirmMonthlyPlan } from '../../server/monthly-plans.mjs';
import { hashPassword } from '../../server/password.mjs';
import { initializedDatabase, testPool } from './pglite-pool.mjs';

function acceptanceWeek(now) {
  const day = new Date(new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10) + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() || 7) + 1);
  return day.toISOString().slice(0, 10);
}

export async function startPlanningAiLocal({ mode, port = 0, planningAIConfigPath, planningAIFetch, now = new Date() } = {}) {
  if (mode !== 'local-acceptance') throw new Error('必须显式设置 mode="local-acceptance"，只允许隔离本地验收');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('本地端口不正确');
  if (planningAIConfigPath !== undefined && (typeof planningAIConfigPath !== 'string' || !planningAIConfigPath.trim())) {
    throw new Error('AI 验收配置路径不正确');
  }

  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'planning-ai-local-'));
  const tempRoot = path.resolve(os.tmpdir());
  const cleanupUploads = async () => {
    const resolved = path.resolve(uploadDir);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('planning-ai-local-')) {
      throw new Error('拒绝清理非验收临时目录');
    }
    await rm(resolved, { recursive: true, force: true });
  };
  let db, pool, server, closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
      }
    } finally {
      try { if (pool) await pool.end(); }
      finally {
        try { if (db) await db.close(); }
        finally { await cleanupUploads(); }
      }
    }
  }

  try {
    db = await initializedDatabase();
    const admin = testPool(db, null);
    const account = { email: 'ai.acceptance@example.invalid', password: 'Local-AI-' + randomBytes(12).toString('base64url') };
    const user = { id: 'ai-local-acceptance-user' };
    const week = acceptanceWeek(now), month = week.slice(0, 7), thursday=new Date(week+'T12:00:00Z');
    thursday.setUTCDate(thursday.getUTCDate()+3);
    const number=Math.ceil(((thursday-Date.UTC(thursday.getUTCFullYear(),0,1))/86400000+1)/7);
    const end=new Date(week+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+6);
    const short=value=>value.toISOString().slice(5,10).replace('-','.');
    const period='第'+number+'周（'+short(new Date(week+'T12:00:00Z'))+'–'+short(end)+'）';
    const scope = { project_id: 'ai-local-project', line: '机电工程', period, month, week };
    await admin.query("INSERT INTO public.projects(id,name,project_type,sort_order) VALUES($1,'匿名 AI 验收项目','com',1)", [scope.project_id]);
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,must_change_password) VALUES($1,$2,$3,false)',
      [user.id, account.email, await hashPassword(account.password)]);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line,discipline) VALUES($1,'匿名机电填报人','pm','approved',$2,$3,'机电')",
      [user.id, scope.project_id, scope.line]);
    await admin.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,$2,'pm')", [user.id, scope.project_id]);
    await admin.end();
    pool = testPool(db);
    const due = new Date(week + 'T12:00:00Z'); due.setUTCDate(due.getUTCDate() + 4);
    const items = [
      { source_id: 'ai-local-equipment', mod: '机电工程', name: '机房设备安装', due: due.toISOString().slice(0, 10) },
      { source_id: 'ai-local-pipeline', mod: '机电工程', name: '室外管网联调', due: due.toISOString().slice(0, 10) }
    ];
    const plan = await confirmMonthlyPlan(pool, user, { project_id: scope.project_id, line: scope.line, month, items });
    await executeDatabase(pool, user, { table: 'reports', operation: 'upsert', onConflict: 'project_id,period,line', values: {
      project_id: scope.project_id, line: scope.line, period,
      biz: { form_version: 2, monthly_plan_id: plan.id, monthly_plan_month: month, nodes: [], handover: [],
        items: items.map((item, index) => ({ ...item, prog: index === 0 ? '保留的原进展：设备安装进行中。' : '原进展：等待材料。', blocker: '' })) },
      rich_text: { v: 1, fields: { 'biz.items.0.prog': { ops: [
        { insert: '保留的原进展：', attributes: { bold: true, color: '#d81e06' } }, { insert: '设备安装进行中。' }
      ] } } }
    } });
    for(let weeks=1;weeks<=2;weeks++){
      const oldWeek=new Date(week+'T12:00:00Z');oldWeek.setUTCDate(oldWeek.getUTCDate()-weeks*7);
      const oldPeriod=oldWeek.toISOString().slice(0,10),sameMonth=oldPeriod.slice(0,7)===month;
      await executeDatabase(pool,user,{table:'reports',operation:'upsert',onConflict:'project_id,period,line',values:{project_id:scope.project_id,line:scope.line,period:oldPeriod,
        change_text:weeks===1?'上周设备安装完成50%，管网材料已下单。':'前两周设备基础验收完成，管网深化已确认。',
        biz:{form_version:2,...(sameMonth?{monthly_plan_id:plan.id,monthly_plan_month:month}:{}),items:items.map((item,index)=>({...item,prog:index===0?(weeks===1?'设备安装完成50%。':'设备基础验收完成。'):'材料已下单，等待到货。'}))}}});
    }
    const overdue=new Date(week+'T12:00:00Z');overdue.setUTCDate(overdue.getUTCDate()-3);
    await admin.query("INSERT INTO public.reporter_tasks(id,project_id,owner_id,owner_name,created_by,title,what,due,status,progress) VALUES('c189160c-b758-4017-bf1a-b735813391a7',$1,$2,'匿名机电填报人',$2,'匿名现场例会','核对试运行方案',$3,'open','方案待确认，尚未申报完成。')",[scope.project_id,user.id,overdue.toISOString().slice(0,10)]);

    // Pass the explicitly supplied provider path through without inspecting or
    // printing credentials. The provider owns config validation and loading.
    const config = { planningAIConfigPath, planningAIFetch, uploadDir, publicOrigin: '', trustProxy: false, cookieSecure: false,
      cookieName: 'planning_ai_acceptance', authCodeSecret: randomBytes(32).toString('hex'), sessionHours: 2,
      readOnly: false, mailer: { configured: false, async sendCode() { throw new Error('隔离验收实例未配置邮件'); } } };
    const app = createApp({ pool, config });
    server = app.listen(port, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const url = 'http://127.0.0.1:' + server.address().port;
    return { url, account, scope, close, db, pool, uploadDir };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--local-acceptance')) throw new Error('请显式传入 --local-acceptance；不会使用已有服务或数据库');
  let port = 0, configPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local-acceptance') continue;
    if (args[i] === '--port') { port = Number(args[++i]); continue; }
    if (args[i] === '--config') { configPath = args[++i]; if (!configPath) throw new Error('--config 需要路径'); continue; }
    throw new Error('不支持的参数：' + args[i]);
  }
  const runtime = await startPlanningAiLocal({ mode: 'local-acceptance', port, planningAIConfigPath: configPath });
  console.log(JSON.stringify({ mode: 'local-acceptance', url: runtime.url, account: runtime.account, scope: runtime.scope,
    note: '全新内存库和匿名账号，仅本机；Ctrl+C 关闭并清理临时附件。不会自动调用模型。' }, null, 2));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime.close(); }
    catch { process.exitCode = 1; console.error('本地验收实例关闭或清理失败'); }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('本地验收启动失败：' + error.message); process.exitCode = 1; });
}
