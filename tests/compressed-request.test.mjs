import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { hashPassword } from '../server/password.mjs';

const origin = 'https://compressed.example.test';
const email = 'compressed-user@example.invalid';
const password = 'Anonymous-compressed-129';
const loginBody = gzipSync(JSON.stringify({ email, password }));

// The fixture runs in a separate process: a decoder regression must fail the
// test rather than terminate the test runner. No real pool, SMTP or env config.
async function runFixture() {
  const user = { user_id: 'compressed-anonymous-user', email,
    password_hash: await hashPassword(password), disabled: false, must_change_password: false };
  const sessions = new Set();
  const query = async (sql, args = []) => {
    if (sql.includes('UPDATE app_private.sessions')) return { rows: sessions.has(args[0]) ? [user] : [] };
    if (sql.includes('FROM app_private.auth_users')) return { rows: [user] };
    if (sql.includes('INSERT INTO app_private.sessions')) sessions.add(args[0]);
    if (sql.includes('DELETE FROM app_private.sessions')) sessions.delete(args[0]);
    if (sql.includes('FROM public.profiles')) return { rows: [{ user_id: user.user_id, role: 'pm', status: 'approved' }] };
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const app = createApp({ pool, config: { publicOrigin: origin, additionalOrigins: '',
    readOnly: false, cookieSecure: false, trustProxy: false, sessionHours: 1,
    planningAIConfigPath: '', authCodeSecret: 'isolated-compressed-request-secret', mailer: { configured: false } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  process.on('message', message => {
    if (message === 'stop') {
      server.close(() => { if (process.connected) process.disconnect(); });
      server.closeAllConnections();
    }
  });
  process.send({ port: server.address().port });
}

async function fixture(t) {
  // Do not inherit DATABASE_URL, SMTP, model secrets or NODE_OPTIONS from the
  // developer's shell. The OS variables are only for launching Node on Windows.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = fork(fileURLToPath(import.meta.url), ['compressed-fixture'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), execArgv: [], env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send('stop');
      const timer = setTimeout(() => child.kill(), 1500);
      try { await exited; } finally { clearTimeout(timer); }
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Compressed fixture startup timed out: ' + output)), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Compressed fixture exited (${code}, ${signal}): ${output}`)); });
  });
  assert.ok(Number.isInteger(ready.port));
  return { base: `http://127.0.0.1:${ready.port}`, alive() {
    assert.equal(child.exitCode, null, output);
    assert.equal(child.signalCode, null, output);
  } };
}

function compressedPost(base, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/auth/login', base), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip',
        'content-length': body.length, origin, ...extraHeaders } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Compressed request timed out')));
    req.end(body);
  });
}

async function healthy(f) {
  f.alive();
  const response = await fetch(f.base + '/api/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'ok');
  f.alive();
}

if (process.argv[2] === 'compressed-fixture') {
  await runFixture();
} else {
  test('compressed JSON stays within login/origin boundaries and decoder failures do not kill the API process', { timeout: 25000 }, async t => {
    const f = await fixture(t);
    await t.test('valid gzip JSON creates an anonymous fixture session', async () => {
      const result = await compressedPost(f.base, loginBody);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.session.user.id, 'compressed-anonymous-user');
      assert.match(result.headers['set-cookie'][0], /HttpOnly/);
      const cookie = result.headers['set-cookie'][0].split(';')[0];
      const session = await fetch(f.base + '/api/auth/session', { headers: { cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal((await session.json()).data.session.user.id, result.body.data.session.user.id);
    });
    await t.test('foreign Origin cannot use compressed login', async () => {
      const result = await compressedPost(f.base, loginBody, { origin: 'https://foreign.example.test' });
      assert.equal(result.status, 403);
      assert.equal(result.body.error.code, 'origin_mismatch');
      assert.equal(result.headers['set-cookie'], undefined);
    });
    await t.test('upstream gzip trailing-byte regression input leaves the API alive', async () => {
      // Adapted input shape from the upstream body-parser regression, not a
      // claim to exhaust all compression/chunk timing combinations:
      // https://github.com/expressjs/body-parser/commit/1260c38
      const body = Buffer.concat([loginBody, Buffer.from([0x00]), Buffer.alloc(100 * 1024, 0x58)]);
      const result = await compressedPost(f.base, body);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.session.user.id, 'compressed-anonymous-user');
      // The original failure can occur after a response has already completed.
      await delay(200);
      await healthy(f);
    });
    await t.test('malformed gzip is rejected without killing subsequent health/login requests', async st => {
      const result = await compressedPost(f.base, Buffer.concat([loginBody, Buffer.from('invalid-gzip-tail')]));
      // This is a rejection/survival assertion, not a claim that every decoder
      // error already has the ideal client-error status in publicError().
      assert.ok(result.status >= 400 && result.status <= 599, 'Malformed gzip must not authenticate');
      assert.equal(result.body.data, null);
      assert.equal(typeof result.body.error.code, 'string');
      st.diagnostic(`Malformed gzip response: ${result.status}/${result.body.error.code}`);
      assert.equal(result.headers['set-cookie'], undefined);
      await healthy(f);
      const login = await compressedPost(f.base, loginBody);
      assert.equal(login.status, 200);
      assert.equal(login.body.data.session.user.id, 'compressed-anonymous-user');
    });
  });
}
