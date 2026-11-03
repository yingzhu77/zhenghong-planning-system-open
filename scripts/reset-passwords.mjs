import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashPassword, passwordIssue } from '../server/password.mjs';

const reject = code => { throw Object.assign(new Error(code), { code }); };

// Administrative maintenance only: pause the API before a production run.
// Never recreate users or touch profiles, memberships, permissions or business rows.
export async function resetPasswords(pool, { password, expectedDatabase, expectedCount } = {}) {
  if (passwordIssue(password)) reject('RESET_PASSWORD_INVALID');
  if (typeof expectedDatabase !== 'string' || !expectedDatabase.length || expectedDatabase.length > 63
    || expectedDatabase.includes('\0')) reject('RESET_DATABASE_REQUIRED');
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) reject('RESET_COUNT_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = (await client.query('SELECT current_database() AS database')).rows[0];
    if (identity?.database !== expectedDatabase) reject('RESET_DATABASE_MISMATCH');
    await client.query(`LOCK TABLE app_private.auth_users,app_private.sessions,
      app_private.auth_challenges,app_private.login_attempts IN SHARE ROW EXCLUSIVE MODE`);
    const users = (await client.query('SELECT user_id FROM app_private.auth_users ORDER BY user_id FOR UPDATE')).rows;
    if (users.length !== expectedCount) reject('RESET_COUNT_MISMATCH');
    for (const user of users) {
      const hash = await hashPassword(password); // Fresh salt for every account.
      const result = await client.query(`UPDATE app_private.auth_users
        SET password_hash=$1,must_change_password=false WHERE user_id=$2 RETURNING user_id`, [hash, user.user_id]);
      if (result.rows.length !== 1) reject('RESET_USER_SET_CHANGED');
    }
    const removed = {};
    for (const [name, table] of [['sessionsDeleted', 'sessions'], ['challengesDeleted', 'auth_challenges'],
      ['loginAttemptsDeleted', 'login_attempts']]) {
      // Identifiers are fixed internal constants, never CLI or roster input.
      removed[name] = (await client.query(`WITH removed AS (DELETE FROM app_private.${table} RETURNING 1)
        SELECT count(*)::integer AS count FROM removed`)).rows[0].count;
    }
    await client.query('COMMIT');
    return { usersReset: users.length, ...removed };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function main() {
  const { values } = parseArgs({ options: { all: { type: 'boolean' }, database: { type: 'string' },
    'expected-count': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('ADMIN_DATABASE_URL=<管理员连接串> RESET_PASSWORD=<密码> node scripts/reset-passwords.mjs --all --database <预期数据库> --expected-count <预期账号数>');
    return;
  }
  if (values.all !== true) reject('RESET_ALL_REQUIRED');
  if (!/^\d+$/.test(values['expected-count'] || '')) reject('RESET_COUNT_REQUIRED');
  if (!process.env.ADMIN_DATABASE_URL) reject('RESET_ADMIN_DATABASE_URL_REQUIRED');
  let url;
  try { url = new URL(process.env.ADMIN_DATABASE_URL); }
  catch { reject('RESET_CONNECTION_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) reject('RESET_CONNECTION_INVALID');
  let database;
  try { database = decodeURIComponent(url.pathname.slice(1)); }
  catch { reject('RESET_CONNECTION_INVALID'); }
  if (!values.database || database !== values.database) reject('RESET_DATABASE_MISMATCH');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 1 });
  try {
    const counts = await resetPasswords(pool, { password: process.env.RESET_PASSWORD,
      expectedDatabase: values.database, expectedCount: Number(values['expected-count']) });
    console.log(JSON.stringify(counts));
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const classification = /^RESET_[A-Z_]+$/.test(error?.code || '') ? error.code
    : /^[0-9A-Z]{5}$/.test(error?.code || '') ? 'SQLSTATE_' + error.code : 'RESET_OPERATION_FAILED';
  console.error(JSON.stringify({ classification }));
  process.exitCode = 1;
});
