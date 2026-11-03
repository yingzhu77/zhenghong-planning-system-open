import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';

test('report3 isolated HTTP: real sessions protect watermarked sharing and preserve meeting source contracts', async t => {
  const db = await initializedDatabase(), admin = testPool(db, null), pool = testPool(db);
  t.after(() => db.close());
  for (const migration of ['019-meeting-categories.sql', '020-project-library.sql'])
    await db.exec(await readFile(new URL('../db/' + migration, import.meta.url), 'utf8'));
  const accounts = await seedDemo(admin);
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'report3-http-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const server = createApp({ pool, config: { uploadDir, authCodeSecret: 'report3-http-disposable-secret' } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, cookies = {};
  async function json(route, body, who = 'ops') {
    const response = await fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookies[who] ? { cookie: cookies[who] } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), response };
  }
  async function login(accountId) {
    const account = accounts.find(row => row.id === accountId);
    const result = await json('/api/auth/login', { email: account.email, password: account.password }, 'anonymous');
    assert.equal(result.status, 200);
    return result.response.headers.get('set-cookie').split(';')[0];
  }
  cookies.ops = await login('demo-ops');
  cookies.pm = await login('demo-pm-com');
  cookies.outside = await login('demo-pm-res');
  assert.equal((await json('/api/project-library/list', { project_id: 'demo-com' }, 'anonymous')).status, 401);
  assert.equal((await json('/api/project-library/password', { project_id: 'demo-com', password: 'Project123!' })).status, 200);
  const initial = await json('/api/project-library/list', { project_id: 'demo-com' }, 'pm');
  assert.equal(initial.status, 200); assert.equal(initial.body.data.configured, true); assert.equal(initial.body.data.unlocked, false);
  assert.equal((await json('/api/project-library/list', { project_id: 'demo-com' }, 'outside')).status, 403);

  const original = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#f3f3f3' } }).png().toBuffer();
  const query = new URLSearchParams({ project_id: 'demo-com', filename: '隔离图纸.png', title: 'HTTP水印资料', category: '图纸' });
  async function upload(who) {
    return fetch(base + '/api/project-library/upload?' + query, { method: 'POST', headers: { origin: base, cookie: cookies[who], 'content-type': 'image/png' }, body: original });
  }
  assert.equal((await upload('outside')).status, 403);
  const uploaded = await upload('pm'); assert.equal(uploaded.status, 200);
  const row = (await uploaded.json()).data;
  assert.equal(row.version, 1); assert.equal(row.uploaded_by, 'demo-pm-com'); assert.equal('storage_key' in row, false);
  const download = (who, extra = '') => fetch(base + '/api/project-library/' + row.id + extra, { headers: { cookie: cookies[who], origin: base } });
  const locked = await download('pm'); assert.equal(locked.status, 403); assert.equal((await locked.json()).error.code, 'library_locked');
  assert.equal((await json('/api/project-library/unlock', { project_id: 'demo-com', password: 'Wrong123!' }, 'pm')).status, 403);
  assert.equal((await json('/api/project-library/unlock', { project_id: 'demo-com', password: 'Project123!' }, 'pm')).status, 200);
  assert.equal((await json('/api/project-library/list', { project_id: 'demo-com' }, 'pm')).body.data.unlocked, true);
  const marked = await download('pm', '?inline=1');
  assert.equal(marked.status, 200); assert.match(marked.headers.get('content-type'), /^image\/png/);
  assert.equal(marked.headers.get('cache-control'), 'no-store'); assert.match(marked.headers.get('content-disposition'), /^inline/);
  const markedBytes = Buffer.from(await marked.arrayBuffer());
  const before = await sharp(original).ensureAlpha().raw().toBuffer(), after = await sharp(markedBytes).ensureAlpha().raw().toBuffer();
  assert.equal(before.length, after.length);
  let changed = 0; for (let index = 0; index < before.length; index++) if (before[index] !== after[index]) changed++;
  assert.ok(changed > 100, 'the actual downloaded pixels must contain a watermark, rather than only changed PNG metadata');
  assert.equal((await download('pm', '?original=1')).status, 403);
  const keptOriginal = await download('ops', '?original=1'); assert.equal(keptOriginal.status, 200);
  assert.deepEqual(Buffer.from(await keptOriginal.arrayBuffer()), original);
  cookies.secondSession = await login('demo-pm-com');
  assert.equal((await download('secondSession')).status, 403, 'another real session must not inherit the first session project password proof');

  const requirement = await json('/api/reporter-tasks/save', { project_id: 'demo-com', owner_id: 'demo-pm-com', meeting_kind: 'requirement', proposer_id: 'demo-president', title: '会议要求', what: 'HTTP会议事项', due: '2026-10-30' });
  assert.equal(requirement.status, 200, JSON.stringify(requirement.body));
  assert.equal(requirement.body.data.proposer_name, '演示总裁'); assert.equal(requirement.body.data.created_by, 'demo-ops');
  const tasks = await json('/api/reporter-tasks/list', { project_id: 'demo-com', meeting_kind: 'requirement' }, 'pm');
  assert.equal(tasks.status, 200); assert.equal(tasks.body.data[0].id, requirement.body.data.id);
  const note = (await admin.query("INSERT INTO public.leader_notes(project_id,period,kind,what,author_name) VALUES ('demo-com','2026-10-19','ceo_brief','原来源不得复制','原领导') RETURNING *")).rows[0];
  const assigned = await json('/api/leader-notes/assign', { id: note.id, project_id: 'demo-com', owner_id: 'demo-pm-com', expected_owner_id: null });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.data.id, note.id); assert.equal(assigned.body.data.what, note.what); assert.equal(assigned.body.data.owner_id, 'demo-pm-com');
});
