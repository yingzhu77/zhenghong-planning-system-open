import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { initializedDatabase, testPool } from './helpers/pglite-pool.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { createApp } from '../server/app.mjs';
import { loadFile } from '../server/files.mjs';
import { publicSchemeCatalog } from '../server/scheme-protection.mjs';
import { buildQuery, withIdentity } from '../server/database.mjs';

const pid = 'demo-res', original = 'drawings/' + pid + '/scheme-source.pdf', oldPreview = 'drawings/' + pid + '/scheme-full-page.png';
const ordinary = 'drawings/' + pid + '/ordinary-drawing.png';
async function fixture(t) {
  const db = await initializedDatabase(), admin = testPool(db, null), pool = testPool(db), accounts = await seedDemo(admin);
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'scheme-protection-'));
  let server;
  t.after(async () => { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); await pool.end(); await admin.end(); await db.close(); await rm(uploadDir, { recursive: true, force: true }); });
  const image = await sharp({ create: { width: 120, height: 60, channels: 3, background: '#326584' } }).png().toBuffer();
  const preview = await sharp(image).extract({ left: 20, top: 10, width: 60, height: 30 }).webp().toBuffer();
  const sha = createHash('sha256').update(preview).digest('hex'), previewPath = 'scheme-previews/' + pid + '/' + sha + '.webp';
  for (const [name, buffer] of [[original, Buffer.from('%PDF-1.7\nprivate-original-sentinel')], [oldPreview, image], [ordinary, image], [previewPath, preview]]) {
    const absolute = path.join(uploadDir, ...name.split('/')); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, buffer);
  }
  const catalog = { version: 1, source: { name: '匿名方案.pdf', url: '/api/files/' + original, sha256: 'private-source-hash' },
    preview: '/api/files/' + oldPreview, plan_page: 2, kind: '住宅方案', summary: '只保留关键指标',
    facts: [{ label: '总建筑面积', value: '1000', unit: '㎡', page: 2, group: '建筑规模', highlight: true }],
    pages: [{ page: 1, text: 'private-entire-page-sentinel' }, { page: 2, text: 'second-private-page-sentinel' }], issues: [] };
  await admin.query('INSERT INTO public.project_master(project_id,fields) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET fields=EXCLUDED.fields', [pid, JSON.stringify({ ordinary_field: 'keep', scheme_catalog: catalog })]);
  for (const [name, kind] of [[original, '方案资料'], [oldPreview, '项目总图'], [ordinary, '项目总图']])
    await admin.query('INSERT INTO public.project_drawings(project_id,kind,name,path,url) VALUES($1,$2,$3,$4,$5)', [pid, kind, name.split('/').at(-1), name, '/api/files/' + name]);
  const registry = { version: 1, projects: [{ project_id: pid, protected_paths: [original, oldPreview],
    preview: { path: previewPath, sha256: sha, width: 60, height: 30, source_page: 2 } }] };
  const registryPath = path.join(uploadDir, 'scheme-protection', 'registry.json'); await mkdir(path.dirname(registryPath), { recursive: true });
  const saveRegistry = () => writeFile(registryPath, JSON.stringify(registry)); await saveRegistry();
  const ops = accounts.find(account => account.id === 'demo-ops');
  for (const [id, status] of [['scheme-viewer', 'approved'], ['scheme-pending', 'pending']]) {
    await admin.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) SELECT $1,$2,password_hash FROM app_private.auth_users WHERE user_id=$3', [id, id + '@example.invalid', ops.id]);
    await admin.query("INSERT INTO public.profiles(user_id,name,role,status) VALUES($1,'匿名方案查看人','viewer',$2)", [id, status]);
    accounts.push({ id, email: id + '@example.invalid', password: ops.password });
  }
  const app = createApp({ pool, config: { uploadDir, authCodeSecret: randomBytes(32).toString('hex'), readOnly: false,
    publicOrigin: '', cookieSecure: false, mailer: { configured: false } } });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port, cookies = new Map();
  async function login(id) {
    if (cookies.has(id)) return cookies.get(id);
    const account = accounts.find(account => account.id === id), response = await fetch(base + '/api/auth/login', { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0]; cookies.set(id, cookie); return cookie;
  }
  async function call(route, { role = 'demo-ops', method = 'GET', body, headers = {} } = {}) {
    return fetch(base + route, { method, headers: { origin: base, ...(role ? { cookie: await login(role) } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function query(body, options = {}) { const response = await call('/api/db', { ...options, method: 'POST', body }); return { status: response.status, body: await response.json() }; }
  return { admin, pool, uploadDir, image, preview, sha, previewPath, registry, registryPath, saveRegistry, catalog, call, query, base, accounts };
}

test('scheme original and old full-page links are blocked for every permitted reader while only the registered crop is served', { timeout: 60000 }, async t => {
  const f = await fixture(t), cropUrl = '/api/scheme-previews/' + pid + '/' + f.sha + '.webp';
  for (const role of ['demo-ops', 'demo-president', 'demo-pm-res', 'scheme-viewer']) {
    for (const name of [original, oldPreview]) for (const method of ['GET', 'HEAD']) {
      const response = await f.call('/api/files/' + name + '?download=1', { role, method, headers: { Range: 'bytes=0-100' } });
      assert.equal(response.status, 403, role + ' ' + method + ' ' + name);
    }
    const response = await f.call(cropUrl, { role }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.preview);
  }
  assert.equal((await f.call(cropUrl, { role: null })).status, 401);
  assert.equal((await f.call(cropUrl, { role: 'demo-pm-com' })).status, 404);
  assert.equal((await f.call(cropUrl, { role: 'scheme-pending' })).status, 404);
  assert.equal((await f.call(cropUrl + '?crop=0,0,1,1')).status, 400);
  assert.equal((await f.call(cropUrl.replace(f.sha, '0'.repeat(64)))).status, 404);
  const ordinaryResponse = await f.call('/api/files/' + ordinary, { role: 'demo-pm-res' }); assert.equal(ordinaryResponse.status, 200);
  assert.deepEqual(Buffer.from(await ordinaryResponse.arrayBuffer()), f.image);
});

test('all database projections and management archives omit full text and original URLs; generic saves preserve the retained complete index', { timeout: 60000 }, async t => {
  const f = await fixture(t), filters = [{ column: 'project_id', value: pid }];
  const sparse = publicSchemeCatalog({ ...f.catalog, pages: [{ page: 3, text: 'sparse-private-text' }, { page: 8, text: 'another-private-text' }] });
  assert.deepEqual(sparse.page_numbers, [3, 8]); assert.equal(sparse.page_count, 2); assert.doesNotMatch(JSON.stringify(sparse), /sparse-private-text|another-private-text/);
  for (const columns of ['*', 'fields', ['fields', 'project_id']]) {
    const result = await f.query({ table: 'project_master', columns, filters }); assert.equal(result.status, 200);
    const catalog = result.body.data[0].fields.scheme_catalog; assert.deepEqual(catalog.source, { name: '匿名方案.pdf' });
    assert.deepEqual(catalog.pages, []); assert.equal(catalog.page_count, 2); assert.equal(catalog.facts[0].value, '1000');
    assert.equal(catalog.preview, '/api/scheme-previews/' + pid + '/' + f.sha + '.webp');
    assert.doesNotMatch(JSON.stringify(result.body), /private-entire-page-sentinel|private-source-hash|scheme-source\.pdf|scheme-full-page\.png/);
  }
  for (const columns of ['*', 'path,url', ['path']]) {
    const result = await f.query({ table: 'project_drawings', columns, filters }); assert.equal(result.status, 200); assert.equal(result.body.data.length, 2);
    assert.doesNotMatch(JSON.stringify(result.body), /scheme-source\.pdf|scheme-full-page\.png/);
  }
  const archive = await f.call('/api/management-read', { role: 'scheme-viewer', method: 'POST', body: { view: 'archive', project_id: pid } });
  assert.equal(archive.status, 200); const view = await archive.json(); assert.equal(view.data.archive.project_drawings.length, 2);
  assert.doesNotMatch(JSON.stringify(view), /private-entire-page-sentinel|private-source-hash|scheme-source\.pdf|scheme-full-page\.png/);
  const saved = await f.query({ table: 'project_master', operation: 'update', filters, columns: 'fields',
    values: { fields: { ordinary_field: 'changed', scheme_catalog: { source: { url: '/api/files/drawings/demo-res/injected.pdf' }, pages: [] } } } });
  assert.equal(saved.status, 200); assert.doesNotMatch(JSON.stringify(saved.body), /injected\.pdf|private-entire-page-sentinel/);
  const stored = (await f.admin.query('SELECT fields FROM public.project_master WHERE project_id=$1', [pid])).rows[0].fields;
  assert.equal(stored.ordinary_field, 'changed'); assert.deepEqual(stored.scheme_catalog, f.catalog);
  assert.equal((await f.query({ table: 'project_master', operation: 'delete', filters })).status, 409);
  assert.equal((await f.query({ table: 'project_master', operation: 'upsert', onConflict: 'project_id',
    values: { project_id: 'demo-com', fields: { scheme_catalog: f.catalog } } })).status, 403);
  const ordinary = await f.query({ table: 'project_master', operation: 'upsert', onConflict: 'project_id',
    values: { project_id: 'demo-com', fields: { ordinary_field: 'new ordinary archive' } }, columns: 'fields' });
  assert.equal(ordinary.status, 200); assert.equal(ordinary.body.data[0].fields.ordinary_field, 'new ordinary archive');
  await withIdentity(f.pool, 'demo-ops', client => client.query(buildQuery({ table: 'project_master', operation: 'upsert', onConflict: 'project_id',
    values: { project_id: pid, fields: { ordinary_field: 'stale prepared write' } } })));
  const atomic = (await f.admin.query('SELECT fields FROM public.project_master WHERE project_id=$1', [pid])).rows[0].fields;
  assert.equal(atomic.ordinary_field, 'stale prepared write'); assert.deepEqual(atomic.scheme_catalog, f.catalog, 'the SQL conflict retains an index created after an earlier lookup');
});

test('generic master updates cannot move a retained scheme index to another project, with or without a fields payload', { timeout: 60000 }, async t => {
  const f = await fixture(t), target = 'scheme-target-without-master', filters = [{ column: 'project_id', value: pid }];
  await f.admin.query("INSERT INTO public.projects(id,name,project_type) VALUES($1,'匿名目标项目','res')", [target]);
  for (const values of [{ project_id: target }, { project_id: target, fields: { ordinary_field: 'would move' } }]) {
    const result = await f.query({ table: 'project_master', operation: 'update', filters, values });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'scheme_catalog_project_locked');
    const retained = (await f.admin.query('SELECT project_id,fields FROM public.project_master WHERE project_id=$1 OR project_id=$2', [pid, target])).rows;
    assert.equal(retained.length, 1); assert.equal(retained[0].project_id, pid); assert.deepEqual(retained[0].fields.scheme_catalog, f.catalog);
  }
});

test('bulk master deletion checks every matching row instead of inheriting client SELECT pagination or order', { timeout: 60000 }, async t => {
  const f = await fixture(t), marker = 'scheme-delete-guard';
  await f.admin.query('UPDATE public.project_master SET updated_by=$1 WHERE project_id=$2', [marker, pid]);
  await f.admin.query('INSERT INTO public.project_master(project_id,fields,updated_by) VALUES($1,$2,$3)', ['demo-com', JSON.stringify({ ordinary_field: 'first ordinary row' }), marker]);
  const before = (await f.admin.query('SELECT project_id,fields FROM public.project_master WHERE updated_by=$1 ORDER BY project_id', [marker])).rows;
  assert.equal(before[0].project_id, 'demo-com');
  const result = await f.query({ table: 'project_master', operation: 'delete', filters: [{ column: 'updated_by', value: marker }],
    order: [{ column: 'project_id', ascending: true }], limit: 1 });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'scheme_catalog_retained');
  const retained = (await f.admin.query('SELECT project_id,fields FROM public.project_master WHERE updated_by=$1 ORDER BY project_id', [marker])).rows;
  assert.deepEqual(retained, before);
});

test('missing or corrupt protection files never expose originals or a full-page fallback, and sealed files stay denied after catalog removal', { timeout: 60000 }, async t => {
  const f = await fixture(t), cropUrl = '/api/scheme-previews/' + pid + '/' + f.sha + '.webp';
  await unlink(f.registryPath);
  for (const name of [original, oldPreview]) assert.equal((await f.call('/api/files/' + name)).status, 403);
  assert.equal((await f.call(cropUrl)).status, 404);
  const absent = await f.query({ table: 'project_master', columns: 'fields' }); assert.equal(absent.status, 200);
  assert.equal(absent.body.data[0].fields.scheme_catalog.preview, '');
  await f.saveRegistry(); await unlink(path.join(f.uploadDir, ...f.previewPath.split('/')));
  assert.equal((await f.call(cropUrl)).status, 503); assert.equal((await f.call('/api/files/' + oldPreview)).status, 403);
  await writeFile(path.join(f.uploadDir, ...f.previewPath.split('/')), Buffer.from('tampered-preview'));
  assert.equal((await f.call(cropUrl)).status, 503);
  await writeFile(f.registryPath, '{broken'); assert.equal((await f.call('/api/files/' + original)).status, 503);
  assert.equal((await f.query({ table: 'project_master', columns: 'fields' })).status, 503);
  await f.saveRegistry(); await f.admin.query("UPDATE public.project_master SET fields='{}' WHERE project_id=$1", [pid]);
  assert.equal((await f.call('/api/files/' + original)).status, 403, 'the independent registry survives catalog removal');
  await writeFile(path.join(f.uploadDir, ...original.split('/')), Buffer.concat([Buffer.from('ZHSCM001'), randomBytes(40)]));
  await unlink(f.registryPath);
  await assert.rejects(loadFile(f.pool, { id: 'demo-ops' }, f.uploadDir, original), error => error.status === 403);
  const bytes = await readFile(path.join(f.uploadDir, ...original.split('/'))); assert.equal(bytes.subarray(0, 8).toString(), 'ZHSCM001');
});

test('actual Edge archive navigation reads only key excerpts and the registered crop, including the legacy archive entry', { timeout: 60000 }, async t => {
  const f = await fixture(t), browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], requested = [], jsonReads = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requested.push(new URL(request.url()).pathname));
  page.on('response', response => { if (response.url().includes('/api/db') || response.url().includes('/api/management-read')) jsonReads.push(response.json()); });
  const account = f.accounts.find(account => account.id === 'demo-ops'); await page.goto(f.base);
  await page.locator('#email').fill(account.email); await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.locator('.planning-mainnav')).toBeVisible();
  await page.getByRole('button', { name: '项目资料', exact: true }).click();
  await page.getByRole('button', { name: '项目档案', exact: true }).click();
  if (await page.locator('#reporterArchiveProject').count()) await page.locator('#reporterArchiveProject').selectOption(pid);
  try { await expect(page.locator('.project-knowledge')).toBeVisible(); }
  catch (error) {
    const diagnostic = path.resolve('.local/scheme-protection-20261105/http-edge'); await mkdir(diagnostic, { recursive: true });
    await writeFile(path.join(diagnostic, 'entry-failure.json'), JSON.stringify({ body: await page.locator('body').innerText(), errors, requested, responses: await Promise.all(jsonReads) }, null, 2));
    throw error;
  }
  const image = page.locator('.pk-plan img'); await expect(image).toHaveAttribute('src', '/api/scheme-previews/' + pid + '/' + f.sha + '.webp');
  await expect(image).toBeVisible(); assert.equal(await image.evaluate(image => image.complete && image.naturalWidth > 0), true);
  await expect(page.locator('.project-knowledge')).toContainText('1000'); await expect(page.getByRole('button', { name: '原文检索', exact: true })).toHaveCount(0);
  assert.equal(await page.locator('.project-knowledge a[href]').count(), 0);
  const artifacts = path.resolve('.local/scheme-protection-20261105/http-edge'); await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'key-excerpts-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'key-excerpts-390.png'), fullPage: true });
  await page.locator('.pk-title').getByRole('button', { name: /档案/ }).click(); await expect(page.locator('.reporter-archive')).toBeVisible();
  await page.getByRole('button', { name: '项目总图', exact: true }).click();
  assert.equal(await page.locator('a[href]').evaluateAll(links => links.some(link => /scheme-source\.pdf|scheme-full-page\.png/.test(link.href))), false);
  assert.equal(requested.some(name => name === '/api/files/' + original || name === '/api/files/' + oldPreview), false);
  assert.ok(requested.includes('/api/scheme-previews/' + pid + '/' + f.sha + '.webp'));
  const responses = await Promise.all(jsonReads); assert.doesNotMatch(JSON.stringify(responses), /private-entire-page-sentinel|second-private-page-sentinel|private-source-hash/);
  const stored = (await f.admin.query('SELECT fields FROM public.project_master WHERE project_id=$1', [pid])).rows[0].fields;
  assert.deepEqual(stored.scheme_catalog, f.catalog); assert.deepEqual(errors, []);
});
