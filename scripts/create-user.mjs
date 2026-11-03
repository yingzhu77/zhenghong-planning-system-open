import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../server/password.mjs';

export async function createUser(pool, options) {
  const email = String(options.email || '').trim().toLowerCase();
  const name = String(options.name || '').trim();
  const role = options.role || 'pm';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('请提供有效的 --email');
  if (!name || name.length > 100) throw new Error('请提供 --name（不超过 100 字）');
  if (!['pm', 'ops', 'president', 'pzo', 'viewer'].includes(role)) throw new Error('--role 仅支持 pm、ops、president、pzo、viewer');
  if (options.managementViewer !== undefined && typeof options.managementViewer !== 'boolean') throw new Error('managementViewer 仅支持明确的布尔值');
  const managementViewer = options.managementViewer ?? (role === 'viewer');
  const userId = options.userId || randomUUID();
  if (typeof userId !== 'string' || userId.length > 200) throw new Error('--user-id 不正确');
  const projects = [...new Set((options.projects || []).filter(Boolean))];
  const passwordHash = await hashPassword(options.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT user_id FROM app_private.auth_users WHERE lower(email)=$1 OR user_id=$2', [email, userId]);
    if (existing.rows.length) throw new Error('邮箱或 UID 已绑定登录账号；本脚本不会覆盖现有账号');
    const oldProfile = await client.query('SELECT * FROM public.profiles WHERE user_id=$1', [userId]);
    if (oldProfile.rows.length && !options.userId) throw new Error('身份已存在，请明确指定 --user-id');
    await client.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', [userId, email, passwordHash]);
    if (!oldProfile.rows.length) {
      await client.query(`INSERT INTO public.profiles(user_id,name,role,status,project_id,biz_line,discipline,management_viewer)
        VALUES($1,$2,$3,'approved',$4,$5,$6,$7)`, [userId, name, role, projects[0] || null, options.line || null, options.discipline || null, managementViewer]);
      for (const projectId of projects) await client.query(`INSERT INTO public.project_members(user_id,project_id,role_in_project)
        VALUES($1,$2,$3) ON CONFLICT(user_id,project_id) DO NOTHING`, [userId, projectId, role]);
    } else if (projects.length || options.line || options.discipline || options.managementViewer !== undefined) {
      throw new Error('--user-id 绑定已有档案时保留原角色与项目，请勿同时传入项目、模块、条线或管理查看修改参数');
    }
    await client.query('COMMIT');
    return { userId, email, name: oldProfile.rows[0]?.name || name, role: oldProfile.rows[0]?.role || role,
      existingProfilePreserved: !!oldProfile.rows.length };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'pm' },
    project: { type: 'string', multiple: true }, line: { type: 'string' }, discipline: { type: 'string' },
    'management-viewer': { type: 'boolean' },
    'user-id': { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('BOOTSTRAP_PASSWORD=<密码> ADMIN_DATABASE_URL=<管理员连接串> node scripts/create-user.mjs --email user@company.com --name 姓名 --role pm|ops|president|pzo|viewer [--management-viewer] [--project 项目ID] [--line 商业模块] [--discipline 专业条线] [--user-id 经人工确认的历史UID]');
    return;
  }
  const connectionString = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('请设置 ADMIN_DATABASE_URL（需有建账号和档案权限）');
  if (!process.env.BOOTSTRAP_PASSWORD) throw new Error('请通过 BOOTSTRAP_PASSWORD 环境变量提供密码');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString });
  try {
    const result = await createUser(pool, { ...values, managementViewer: values['management-viewer'], userId: values['user-id'], projects: values.project || [], password: process.env.BOOTSTRAP_PASSWORD });
    console.log(JSON.stringify(result, null, 2));
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(err => {
  console.error(`创建账号失败：${err.message}`); process.exitCode = 1;
});
