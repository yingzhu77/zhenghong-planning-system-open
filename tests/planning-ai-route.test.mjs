import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startPlanningAiLocal } from './helpers/planning-ai-local.mjs';
import { testPool } from './helpers/pglite-pool.mjs';

const candidate = { reply: '已整理，可填入本周草稿。', draft: { items: [
  { id: 'monthly:0', progress: '设备已就位', sources: ['用户输入'] }
] } };
function providerResponse() {
  return new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, provider) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planning-ai-route-'));
  const configPath = path.join(directory, 'anonymous-provider.json');
  // A fabricated test key is deliberately confined to a disposable file. The
  // injected provider handles every request; no external endpoint is contacted.
  await writeFile(configPath, JSON.stringify({ enabled: true, model: 'deepseek-flash', api_key: 'sk-anonymous-http-test-key' }), { mode: 0o600 });
  let runtime;
  t.after(async () => {
    try { if (runtime) await runtime.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  let providerCalls = 0;
  runtime = await startPlanningAiLocal({ mode: 'local-acceptance', planningAIConfigPath: configPath,
    planningAIFetch: async (url, options) => {
      providerCalls++;
      assert.equal(url, 'https://api.deepseek.com/responses');
      assert.equal(options.redirect, 'error');
      return provider ? provider(url, options) : providerResponse();
    } });
  const admin = testPool(runtime.db, null);
  const packet = { project_id: runtime.scope.project_id, line: runtime.scope.line, period: runtime.scope.period,
    items: [{ id: 'monthly:0', title: '机房设备安装', progress: '保留的原进展：设备安装进行中。' }],
    messages: [{ role: 'user', content: '设备已就位，请整理本周进展，保留原文。' }], files: [] };
  async function call(route, { cookie, body = packet, origin = runtime.url, rawBody } = {}) {
    const response = await fetch(runtime.url + route, { method: 'POST', headers: {
      'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {})
    }, body: rawBody ?? JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login() {
    const logged = await call('/api/auth/login', { body: runtime.account });
    assert.equal(logged.status, 200);
    assert.ok(logged.cookie);
    return logged.cookie;
  }
  const snapshot = async () => (await admin.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY id) AS data FROM public.reports r')).rows[0].data;
  return { runtime, admin, packet, call, login, snapshot, providerCalls: () => providerCalls };
}

test('actual AI HTTP route requires login and same origin, limits the body, and returns a draft without report writes', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await f.snapshot();
  const anonymous = await f.call('/api/planning-ai/chat');
  assert.equal(anonymous.status, 401); assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED');
  assert.equal(f.providerCalls(), 0);
  const cookie = await f.login();
  const crossOrigin = await f.call('/api/planning-ai/chat', { cookie, origin: 'https://attacker.example.invalid' });
  assert.equal(crossOrigin.status, 403); assert.equal(crossOrigin.body.error.code, 'origin_mismatch');
  const missingOrigin = await f.call('/api/planning-ai/chat', { cookie, origin: '' });
  assert.equal(missingOrigin.status, 403); assert.equal(missingOrigin.body.error.code, 'origin_required');
  const oversized = await f.call('/api/planning-ai/chat', { cookie, rawBody: JSON.stringify({ padding: 'x'.repeat(18 * 1024 * 1024) }) });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'too_large');
  assert.equal(f.providerCalls(), 0);
  const completed = await f.call('/api/planning-ai/chat', { cookie });
  assert.equal(completed.status, 200); assert.deepEqual(completed.body.data, candidate);
  assert.equal(f.providerCalls(), 1); assert.deepEqual(await f.snapshot(), before);
});

test('actual AI HTTP route rejects its result when the active login is logged out during the provider request', { timeout: 30000 }, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return providerResponse(); });
  t.after(() => release.resolve());
  const cookie = await f.login(), before = await f.snapshot();
  const pending = f.call('/api/planning-ai/chat', { cookie });
  await started.promise;
  const logout = await f.call('/api/auth/logout', { cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await f.admin.query('SELECT count(*)::integer AS n FROM app_private.sessions')).rows[0].n, 0);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 401); assert.equal(result.body.error.code, 'ai_session_expired');
  assert.equal(result.body.data, null); assert.equal(f.providerCalls(), 1);
  assert.deepEqual(await f.snapshot(), before);
});

test('actual AI HTTP route rechecks the password-change gate after the provider finishes', { timeout: 30000 }, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return providerResponse(); });
  t.after(() => release.resolve());
  const cookie = await f.login(), before = await f.snapshot();
  const pending = f.call('/api/planning-ai/chat', { cookie });
  await started.promise;
  await f.admin.query('UPDATE app_private.auth_users SET must_change_password=true WHERE user_id=$1', ['ai-local-acceptance-user']);
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(result.body.data, null); assert.equal(f.providerCalls(), 1);
  assert.deepEqual(await f.snapshot(), before);
});
