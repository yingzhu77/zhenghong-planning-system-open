import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readOnlyGate, readOnlyHtml } from '../server/read-only.mjs';

test('frozen instance permits reads and sessions, rejects every mutation route before handlers', async t => {
  const app = express(); let reached = 0;
  app.use('/api', readOnlyGate({ readOnly: true }));
  app.use((req, res) => { reached++; res.json({ reached }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/db', '/auth/login', '/auth/logout', '/management-read', '/completions/list', '/project-library/unlock', '/DB/']) {
    const r = await fetch(base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'select' }) }); assert.equal(r.status, 200, route);
  }
  for (const [route, body] of [['/db', { operation: 'update' }], ['/db/', { operation: 'upsert' }], ['/DB', { operation: 'delete' }], ['/auth/change-password', {}], ['/auth/password/reset/complete', {}], ['/auth/otp/verify', {}], ['/completions/review', {}], ['/report-attachments/upload', {}], ['/project-library/password', {}], ['/unknown-future-write', {}]]) {
    const before = reached;
    const r = await fetch(base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, route); assert.equal((await r.json()).error.code, 'INSTANCE_READ_ONLY'); assert.equal(reached, before);
  }
  assert.equal((await fetch(base + '/api/report-attachments/example')).status, 200);
  assert.equal((await fetch(base + '/api/db', { method: 'PUT' })).status, 403);
});
test('normal instance is unchanged and frozen page points to HTTPS target', () => {
  const html = '<html><body class="app">original</body></html>';
  assert.equal(readOnlyHtml(html, {}), html);
  const frozen = readOnlyHtml(html, { readOnly: true, readOnlyTarget: 'https://example.invalid:25656/' });
  assert.match(frozen, /本站为迁移前只读记录/); assert.match(frozen, /https:\/\/example.invalid:25656\//); assert.match(frozen, /original/);
  assert.throws(() => readOnlyHtml(html, { readOnly: true, readOnlyTarget: 'http://example.invalid/' }));
});
