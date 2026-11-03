import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/cloud-compat.js', import.meta.url), 'utf8');
function client(response = { data: [], error: null }) {
  const calls = [];
  const window = {
    fetch: async (url, options) => {
      calls.push({ url, ...options, json: options.body instanceof FormData ? null : options.body ? JSON.parse(options.body) : null });
      const body = typeof response === 'function' ? await response(url, options) : response;
      return { ok: !body.error, status: body.error ? 503 : 200, json: async () => body };
    }, FormData
  };
  vm.runInNewContext(source, { window });
  return { sdk: window.WorkBuddyCloud.createWorkBuddyCloud(), calls };
}

test('write followed by select remains a write and executes once', async () => {
  const { sdk, calls } = client({ data: [{ id: 1 }], error: null });
  const query = sdk.database.from('reports').upsert({ project_id: 'p1' }, { onConflict: 'project_id,period,line' }).select('id');
  assert.equal((await query).data[0].id, 1);
  await query;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/db');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.deepEqual(calls[0].json, { table: 'reports', operation: 'upsert', filters: [], order: [], columns: 'id', returning: true, values: { project_id: 'p1' }, onConflict: 'project_id,period,line' });
});

test('query filters, sort, limits and update returning use the API contract', async () => {
  const { sdk, calls } = client();
  await sdk.database.from('milestones').select('*').eq('project_id', 'p1').order('sort_order').order('id', { ascending: false }).limit(10);
  assert.deepEqual(calls[0].json.filters, [{ column: 'project_id', value: 'p1' }]);
  assert.deepEqual(calls[0].json.order, [{ column: 'sort_order', ascending: true }, { column: 'id', ascending: false }]);
  assert.equal(calls[0].json.limit, 10);
  await sdk.database.from('reports').update({ status: '异常' }).eq('id', 1).select();
  assert.equal(calls[1].json.operation, 'update');
  assert.equal(calls[1].json.returning, true);
  await sdk.database.from('leader_notes').delete().eq('id', 2);
  assert.equal(calls[2].json.operation, 'delete');
});

test('session, OTP and reset handle the original application return shapes', async () => {
  const { sdk, calls } = client(url => url.endsWith('/start')
    ? { data: { verificationId: 'reset-1' }, error: null }
    : { data: { session: { user: { id: 'u1', email: 'pm@example.test' } } }, error: null });
  assert.equal((await sdk.auth.getUser()).data.user.id, 'u1');
  assert.equal(calls[0].method, 'GET');
  await sdk.auth.sendOtp({ email: 'pm@example.test', purpose: 'register' });
  assert.equal(calls[1].json.purpose, 'register');
  const reset = await sdk.auth.resetPasswordForEmail('pm@example.test');
  await reset.data.updateUser({ nonce: '123456', password: 'example-password-1' });
  assert.equal(calls[3].url, '/api/auth/password/reset/complete');
  assert.deepEqual(calls[3].json, { email: 'pm@example.test', verificationId: 'reset-1', token: '123456', password: 'example-password-1' });
  let event;
  sdk.auth.onAuthStateChange(value => { event = value; });
  await sdk.auth.signOut();
  assert.equal(event, 'SIGNED_OUT');
});

test('file URLs remain authenticated and uploads preserve the project path', async () => {
  const { sdk, calls } = client();
  const path = sdk.storage.sharedPath('u1', 'drawings/p1/总图.png');
  const storage = sdk.storage.from('runtime');
  assert.equal(path, 'drawings/p1/总图.png');
  assert.equal(storage.getPublicUrl(path).data.publicUrl, '/api/files/drawings/p1/%E6%80%BB%E5%9B%BE.png');
  await storage.upload(path, new Blob(['image'], { type: 'image/png' }));
  assert.equal(calls[0].url, '/api/files/upload');
  assert.equal(calls[0].body.get('path'), path);
  assert.equal(calls[0].credentials, 'same-origin');
  assert.throws(() => sdk.storage.sharedPath('u1', '../outside.png'));
});

test('server errors stay visible without retrying an external fallback', async () => {
  const { sdk, calls } = client({ data: null, error: { message: 'SMTP is not configured', code: 'SMTP_UNAVAILABLE' } });
  assert.equal((await sdk.auth.sendOtp({ email: 'pm@example.test' })).error.code, 'SMTP_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth/otp/send');
});
