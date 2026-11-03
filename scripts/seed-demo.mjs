import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPassword } from '../server/password.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function periodLabel(now = new Date()) {
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - year) / 86400000) + 1) / 7);
  const mon = new Date(now); mon.setDate(now.getDate() - (now.getDay() || 7) + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const show = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  return `第${week}周（${show(mon)}–${show(sun)}）`;
}
const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function seedDemo(pool, { persistAccounts } = {}) {
  const definitions = [
    { id: 'demo-ops', email: 'ops.demo@example.invalid', name: '演示运营', role: 'ops' },
    { id: 'demo-president', email: 'president.demo@example.invalid', name: '演示总裁', role: 'president' },
    { id: 'demo-pzo', email: 'pzo.demo@example.invalid', name: '演示项目总', role: 'pzo', project: 'demo-com' },
    { id: 'demo-pm-res', email: 'pm.res.demo@example.invalid', name: '演示住宅经理', role: 'pm', project: 'demo-res', discipline: '工程' },
    { id: 'demo-pm-com', email: 'pm.com.demo@example.invalid', name: '演示土建负责人', role: 'pm', project: 'demo-com', line: '土建工程（东地块）', discipline: '工程' }
  ];
  const accounts = await Promise.all(definitions.map(async (u) => {
    const password = 'Zh-' + randomBytes(18).toString('base64url') + '8a';
    return { ...u, password, passwordHash: await hashPassword(password) };
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query("SELECT user_id FROM app_private.auth_users WHERE user_id=ANY($1::text[])", [definitions.map((u) => u.id)])).rows.length) throw new Error('演示账号已存在；不会重置密码或覆盖既有演示数据');
    await client.query(`INSERT INTO public.projects(id,name,project_type,sort_order,biz_meta)
      VALUES('demo-res','演示 · 住宅项目','res',900,NULL),('demo-com','演示 · 商业项目','com',901,$1::jsonb)`, [JSON.stringify({ open_date: iso(350), gfa: '演示数据', invest: '演示数据' })]);
    for (const user of accounts) {
      await client.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', [user.id, user.email, user.passwordHash]);
      await client.query(`INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line,discipline) VALUES($1,$2,$3,'approved',$4,$5,$6)`, [user.id, user.name, user.role, user.project || null, user.line || null, user.discipline || null]);
      if (user.project) await client.query("INSERT INTO public.project_members(user_id,project_id,role_in_project) VALUES($1,$2,'pm')", [user.id, user.project]);
    }
    await client.query(`INSERT INTO public.milestones(project_id,name,plan_date,forecast_date,is_key,key_name,line,owner_dept,standard)
      VALUES('demo-res','主体结构封顶',$1,$2,true,'主体封顶','工程','工程部','全部单体封顶'),
      ('demo-res','竣工备案',$3,$3,true,'竣工备案','开发报建','开发报建','完成备案手续'),
      ('demo-com','东地块结构封顶',$4,$5,true,'结构封顶','工程','工程部','完成主体结构'),
      ('demo-com','正式开业',$6,$6,true,'正式开业','商管运营','商管运营','具备正式开业条件')`, [iso(10), iso(30), iso(180), iso(-7), iso(7), iso(350)]);
    const period = periodLabel();
    const residential = {
      project_id: 'demo-res', period, line: '综合', author_id: 'demo-pm-res', author_name: '演示住宅经理', status: '异常',
      change_text: '演示：地下室工作面完成移交，主体施工持续推进。',
      dev_text: '幕墙材料定标延后', impact: '工期/节点', projection: '如材料不能按期进场，将影响外立面移交。',
      node_items: [{ name: '主体结构封顶', key: '主体封顶', plan: iso(10), forecast: iso(30), reason: '材料供货与工作面冲突' }],
      speed_items: [{ act: '增加一个作业面', gain: '预计追回7天' }],
      effect_items: [{ act: '样板先行，联合验收', target: '一次验收通过' }],
      coord_items: [{ who: '演示运营', what: '协调幕墙材料定标', by: iso(3) }],
      next_items: ['完成材料定标', '确定新增作业面'], self_speed: '滞后'
    };
    const commercial = {
      project_id: 'demo-com', period, line: '土建工程（东地块）', author_id: 'demo-pm-com', author_name: '演示土建负责人', status: '关注',
      coord_items: [{ who: '演示项目总', what: '确认西区施工面移交安排', by: iso(2) }],
      biz: { nodes: [{ name: '东地块结构封顶', plan: iso(-7), prog: '屋面施工中', is_key: true }],
        items: [{ mod: '土建工程（东地块）', name: '幕墙材料封样', due: iso(-2), prog: '尚未完成，等待样品确认' }, { mod: '土建工程（东地块）', name: '地下室设备基础', due: iso(5), prog: '按计划推进' }], handover: [] }
    };
    for (const report of [residential, commercial]) {
      const cols = Object.keys(report);
      const jsonFields = new Set(['node_items', 'speed_items', 'effect_items', 'coord_items', 'next_items', 'biz']);
      await client.query('INSERT INTO public.reports (' + cols.map((c) => '"' + c + '"').join(',') + ') VALUES (' + cols.map((_, i) => '$' + (i + 1)).join(',') + ')', cols.map((c) => jsonFields.has(c) ? JSON.stringify(report[c]) : report[c]));
    }
    await client.query(`INSERT INTO public.leader_reviews(project_id,period,kind,speed,effect,author_name,author_role,note)
      VALUES('demo-res',$1,'ceo','滞后','良好','演示总裁','总裁','演示：关注材料到货，保持样板验收。')`, [period]);
    await client.query(`INSERT INTO public.leader_reviews(project_id,period,kind,rating,author_name,author_role,note)
      VALUES('demo-com',$1,'pzo','中','演示项目总','项目总','演示：重点跟踪工作面移交。')`, [period]);
    await client.query(`INSERT INTO public.leader_notes(project_id,period,kind,what,due,author_name) VALUES
      ('demo-res',$1,'ceo_brief','演示：周五前反馈材料定标结果',$2,'演示总裁'),
      ('demo-com',$1,'pzo_note','演示：明确西区工作面交接责任人',$2,'演示项目总')`, [period, iso(4)]);
    await client.query("INSERT INTO public.project_master(project_id,fields,updated_by) VALUES('demo-res',$1::jsonb,'演示运营')", [JSON.stringify({ city: '演示城市', area: '120000', gfa: '380000', far: '2.5', owner_company: '演示开发主体' })]);
    await client.query(`INSERT INTO public.project_phases(project_id,name,units_total,units_launched,units_sold,avg_price,plan_handover)
      VALUES('demo-res','演示一期',800,500,320,'18000',$1)`, [iso(500)]);
    const credentials = accounts.map(({ passwordHash, ...user }) => user);
    // Persist random credentials before COMMIT. If disk access fails, the entire
    // demo transaction rolls back instead of creating accounts nobody can use.
    if (persistAccounts) await persistAccounts(credentials);
    await client.query('COMMIT');
    return credentials;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function saveDemoAccounts(target, accounts) {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ createdAt: new Date().toISOString(), note: '仅供本地演示，请勿上传或公开此文件。若初始化报告失败，请先核验数据库提交状态再使用或删除本文件。', accounts }, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: docker compose --profile tools run --rm admin node scripts/seed-demo.mjs\nCreates isolated demo-res/demo-com projects and five random-password accounts covering four roles. Credentials are saved to .local/demo-accounts.json before database commit. Existing demo accounts, projects, and credential files are never overwritten.');
    return;
  }
  if (process.argv.length > 2) throw new Error('不支持额外参数，请使用 --help 查看用法');
  if (!process.env.ADMIN_DATABASE_URL) throw new Error('请通过admin工具服务运行，需ADMIN_DATABASE_URL');
  const local = path.join(projectRoot, '.local'), target = path.join(local, 'demo-accounts.json');
  await mkdir(local, { recursive: true });
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  try {
    await seedDemo(pool, { persistAccounts: (accounts) => saveDemoAccounts(target, accounts) });
    console.log('演示数据已建立。账号和随机密码仅保存在 ' + target);
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error('演示初始化失败：' + (error.code === 'EEXIST' ? '演示账号文件已存在，不会覆盖；本次数据库写入已回滚。' : error.message));
  console.error('如 .local/demo-accounts.json 已生成，请保留并核验提交状态；脚本不会自动删除账号凭据或历史数据。');
  process.exitCode = 1;
});
