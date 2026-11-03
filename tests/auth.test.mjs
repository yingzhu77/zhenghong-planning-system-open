import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth, readCookie } from '../server/auth.mjs';

test('cookie parsing rejects malformed encoding and matches the complete name', () => {
  assert.equal(readCookie({ headers: { cookie: 'prefix_zh_session=wrong; zh_session=actual' } }, 'zh_session'), 'actual');
  assert.equal(readCookie({ headers: { cookie: 'zh_session=%E0%A4%A' } }, 'zh_session'), null);
});

test('unconfigured SMTP gives 503 and foreign origins cannot submit authentication', async t => {
  const app = express();
  const pool = { query: async () => { throw new Error('No database query expected'); } };
  const auth = createAuth({ pool, config: { publicOrigin: 'http://localhost', mailer: { configured: false } } });
  app.use('/api/auth', auth.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const send = await fetch(`${base}/otp/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'person@example.com', purpose: 'register' }) });
  assert.equal(send.status, 503);
  assert.equal((await send.json()).error.code, 'SMTP_NOT_CONFIGURED');
  const foreign = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ email: 'person@example.com', password: 'Password918' }) });
  assert.equal(foreign.status, 403);
  const session = await fetch(`${base}/session`, { headers: { cookie: 'zh_session=bad' } });
  assert.deepEqual(await session.json(), { data: { session: null }, error: null });
});
