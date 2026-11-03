import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { resetPasswords } from '../scripts/reset-passwords.mjs';
import { verifyPassword } from '../server/password.mjs';
import { createAuth } from '../server/auth.mjs';
import { setLibraryPassword } from '../server/project-library.mjs';

const exec = promisify(execFile), password = '384629';
const code = expected => error => error.code === expected;

async function fixture(t) {
  const db = await initializedDatabase();
  t.after(() => db.close());
  const pool = testPool(db, null), accounts = await seedDemo(pool);
  await pool.query("UPDATE app_private.auth_users SET must_change_password=true WHERE user_id='demo-pm-com'");
  await pool.query("UPDATE app_private.auth_users SET disabled=true WHERE user_id='demo-president'");
  await pool.query("INSERT INTO app_private.auth_users(user_id,email,password_hash,disabled,must_change_password) VALUES('orphan-disabled','orphan@example.invalid','unusable-old-fixture-hash',true,true)");
  await pool.query(`INSERT INTO app_private.sessions(token_hash,user_id,expires_at) VALUES
    ('old-token-1','demo-ops',now()+interval '1 hour'),('old-token-2','demo-pm-com',now()+interval '1 hour')`);
  await pool.query(`INSERT INTO app_private.auth_challenges(id,email,purpose,code_hash,expires_at) VALUES
    ('old-challenge-1','ops.demo@example.invalid','reset','unused',now()+interval '1 hour'),
    ('old-challenge-2','not-registered@example.invalid','register','unused',now()+interval '1 hour')`);
  await pool.query(`INSERT INTO app_private.login_attempts(key,failures,locked_until) VALUES
    ('password:ops.demo@example.invalid',5,now()+interval '15 minutes'),
    ('login-ip:anonymous-test-ip',30,now()+interval '15 minutes')`);
  const database = (await pool.query('SELECT current_database() AS database')).rows[0].database;
  return { db, pool, accounts, options: { password, expectedDatabase: database, expectedCount: 6 } };
}

async function publicRows(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    result[tablename] = (await pool.query(`SELECT COALESCE(json_agg(v ORDER BY v::text),'[]') AS rows
      FROM (SELECT to_jsonb(t) v FROM public."${tablename}" t) x`)).rows[0].rows;
  }
  return result;
}

async function authState(pool) {
  const result = {};
  for (const table of ['auth_users', 'sessions', 'auth_challenges', 'login_attempts'])
    result[table] = (await pool.query(`SELECT COALESCE(json_agg(v ORDER BY v::text),'[]') AS rows
      FROM (SELECT to_jsonb(t) v FROM app_private.${table} t) x`)).rows[0].rows;
  return result;
}

test('all-account reset includes changed, initial and disabled users while preserving identity and every public row', async t => {
  const f = await fixture(t), before = await publicRows(f.pool);
  const metadata = (await f.pool.query('SELECT user_id,email,disabled,created_at FROM app_private.auth_users ORDER BY user_id')).rows;
  const result = await resetPasswords(f.pool, f.options);
  assert.deepEqual(result, { usersReset: 6, sessionsDeleted: 2, challengesDeleted: 2, loginAttemptsDeleted: 2 });
  assert.deepEqual(await publicRows(f.pool), before, 'roles, memberships, histories and all business rows stay identical');
  assert.deepEqual((await f.pool.query('SELECT user_id,email,disabled,created_at FROM app_private.auth_users ORDER BY user_id')).rows, metadata);
  const users = (await f.pool.query('SELECT user_id,password_hash,must_change_password FROM app_private.auth_users ORDER BY user_id')).rows;
  assert.equal(new Set(users.map(user => user.password_hash)).size, 6);
  for (const user of users) {
    assert.equal(user.must_change_password, false);
    assert.equal(await verifyPassword(password, user.password_hash), true);
    assert.equal(await verifyPassword('384628', user.password_hash), false);
    const previous = f.accounts.find(account => account.id === user.user_id);
    if (previous) assert.equal(await verifyPassword(previous.password, user.password_hash), false);
  }
  const state = await authState(f.pool);
  for (const table of ['sessions', 'auth_challenges', 'login_attempts']) assert.deepEqual(state[table], []);
});

test('instance, count and password guards reject without changing any authentication or business row', async t => {
  const f = await fixture(t), beforeAuth = await authState(f.pool), beforePublic = await publicRows(f.pool);
  for (const [change, expected] of [[{ expectedDatabase: 'different_database' }, 'RESET_DATABASE_MISMATCH'],
    [{ expectedCount: 5 }, 'RESET_COUNT_MISMATCH'], [{ expectedCount: -1 }, 'RESET_COUNT_REQUIRED'],
    [{ expectedCount: undefined }, 'RESET_COUNT_REQUIRED'], [{ expectedDatabase: '' }, 'RESET_DATABASE_REQUIRED'],
    [{ password: 'short' }, 'RESET_PASSWORD_INVALID']]) {
    await assert.rejects(resetPasswords(f.pool, { ...f.options, ...change }), code(expected));
    assert.deepEqual(await authState(f.pool), beforeAuth);
    assert.deepEqual(await publicRows(f.pool), beforePublic);
  }
});

test('a database failure after password updates and session deletion rolls back the entire batch', async t => {
  const f = await fixture(t), beforeAuth = await authState(f.pool), beforePublic = await publicRows(f.pool);
  await f.pool.query(`CREATE FUNCTION app_private.reject_reset_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'anonymous cleanup failure' USING ERRCODE='23514'; END; $$`);
  await f.pool.query(`CREATE TRIGGER reject_reset_fixture BEFORE DELETE ON app_private.auth_challenges
    FOR EACH ROW EXECUTE FUNCTION app_private.reject_reset_fixture()`);
  await assert.rejects(resetPasswords(f.pool, f.options), code('23514'));
  assert.deepEqual(await authState(f.pool), beforeAuth);
  assert.deepEqual(await publicRows(f.pool), beforePublic);
});

test('reset invalidates old HTTP sessions and permits numeric login without a first-change gate, retaining disabled accounts', async t => {
  const f = await fixture(t);
  const auth = createAuth({ pool: f.pool, config: { mailer: { configured: false }, authCodeSecret: 'isolated-reset-secret' } });
  const app = express(); app.use('/api/auth', auth.router);
  app.get('/protected', auth.requireUser, (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, cookie) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const account = f.accounts.find(user => user.id === 'demo-pzo');
  const old = await call('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(old.status, 200);
  assert.equal((await call('/protected', undefined, old.cookie)).status, 200);
  await resetPasswords(f.pool, f.options);
  assert.equal((await call('/protected', undefined, old.cookie)).status, 401);
  assert.equal((await call('/api/auth/login', { email: account.email, password: account.password })).status, 401);
  const numeric = await call('/api/auth/login', { email: account.email, password });
  assert.equal(numeric.status, 200);
  assert.equal(numeric.data.data.session.user.id, account.id);
  assert.equal(numeric.data.data.session.user.must_change_password, false);
  assert.equal((await call('/protected', undefined, numeric.cookie)).status, 200);
  assert.equal((await call('/api/auth/login', { email: 'president.demo@example.invalid', password })).status, 401);
});

test('account policy changes preserve the separate project download password policy', async () => {
  const noDatabase = { connect() { throw new Error('invalid library passwords must not access a database'); } };
  for (const value of ['384629', '38462917', 'lettersOnly', 'A1'.repeat(65)])
    await assert.rejects(setLibraryPassword(noDatabase, { id: 'anonymous-operator' }, { project_id: 'anonymous-project', password: value }), error => error.status === 400);
});

test('CLI requires explicit all/database/count and never echoes environment secrets or arguments', async () => {
  const marker = 'private-input-must-not-be-logged';
  const env = { ...process.env, DATABASE_URL: '', ADMIN_DATABASE_URL: '', RESET_PASSWORD: marker, SMTP_HOST: '', SMTP_URL: '' };
  delete env.NODE_OPTIONS;
  const script = fileURLToPath(new URL('../scripts/reset-passwords.mjs', import.meta.url));
  for (const [args, extra, expected] of [
    [[], {}, 'RESET_ALL_REQUIRED'],
    [['--all', '--database', 'expected'], {}, 'RESET_COUNT_REQUIRED'],
    [['--all', '--database', 'expected', '--expected-count', '6'], {}, 'RESET_ADMIN_DATABASE_URL_REQUIRED'],
    [['--all', '--database', 'expected', '--expected-count', '6'], { ADMIN_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/different' }, 'RESET_DATABASE_MISMATCH'],
    [['--password', marker], {}, 'RESET_OPERATION_FAILED']
  ]) {
    let failure;
    try { await exec(process.execPath, [script, ...args], { env: { ...env, ...extra }, windowsHide: true }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 1);
    assert.deepEqual(JSON.parse(failure.stderr), { classification: expected });
    assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.includes(marker), false);
    assert.equal(failure.stderr.includes('postgres://'), false);
  }
});
