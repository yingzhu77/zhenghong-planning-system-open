import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webAssets } from '../server/web-assets.mjs';
import { createApp } from '../server/app.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
test('public assets use content versions in responsive background sources and preload', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planning-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(webRoot, directory, { recursive: true });
  const before = webAssets(directory);
  const manifest = JSON.parse(before.html.match(/id="planning-assets"[^>]*>(.*?)<\/script>/s)[1]);
  assert.ok(!before.html.includes('__ASSET_MANIFEST__'));
  assert.ok(!before.html.includes('__PAGE_STYLES__'));
  assert.match(before.html, /<style>[\s\S]*\.authpage/);
  assert.ok(!before.html.includes('rel="stylesheet"'));
  assert.match(before.html, /data-initial-login/);
  assert.ok(!/<script[^>]+src="[^"]*(?:quill|rich-editor|rich-text)/.test(before.html));
  for (const size of ['desktop', 'mobile']) {
    assert.ok(before.html.includes(`srcset="${manifest[`login-bg-${size}.avif`]}"`));
    assert.match(before.html, new RegExp(`href="${manifest[`login-bg-${size}.avif`]}"[^>]*fetchpriority="high"`));
  }
  assert.ok(before.html.includes(`src="${manifest['login-bg-desktop.webp']}"`));
  assert.ok(before.html.includes(`srcset="${manifest['login-bg-mobile.webp']}"`));
  assert.ok(!/<link[^>]+preload[^>]+\.webp/.test(before.html));
  assert.ok(!before.responses.get(manifest['planning-ui.css']).body.includes(Buffer.from('url(')));
  for (const name of ['login-bg-desktop.avif', 'login-bg-desktop.webp']) {
    await appendFile(path.join(directory, name), Buffer.from([0]));
  }
  const after = webAssets(directory);
  for (const name of ['login-bg-desktop.avif', 'login-bg-desktop.webp']) {
    assert.ok(!after.responses.has(manifest[name]));
    assert.ok(!after.html.includes(manifest[name]));
  }
  assert.ok(after.responses.has(manifest['planning-ui.css']));
  assert.ok(after.responses.has(manifest['app.js']));
});

test('only versioned public assets are immutable; HTML revalidates and APIs stay private', async t => {
  const app = createApp({ pool: { query: async () => ({ rows: [] }) } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(base);
  assert.equal(home.headers.get('cache-control'), 'no-cache, max-age=0, must-revalidate');
  const html = await home.text();
  const manifest = JSON.parse(html.match(/id="planning-assets"[^>]*>(.*?)<\/script>/s)[1]);
  for (const url of Object.values(manifest)) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url);
    if (url.endsWith('.avif')) assert.equal(response.headers.get('content-type'), 'image/avif');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const cached = await fetch(base + url, { headers: { 'if-none-match': response.headers.get('etag'), 'cache-control': 'max-age=0' } });
    assert.equal(cached.status, 304);
  }
  for (const url of ['/api/health', '/api/auth/session', '/api/files/missing']) {
    const response = await fetch(base + url);
    assert.equal(response.headers.get('cache-control'), 'no-store', url);
  }
  for (const url of ['/assets/0000000000000000/app.js', '/assets/0000000000000000/.env', '/server/app.mjs']) {
    const response = await fetch(base + url);
    assert.equal(response.status, 404);
    assert.ok(!response.headers.get('cache-control')?.includes('immutable'));
  }
  assert.equal((await fetch(base + '/app.js')).headers.get('cache-control'), 'no-store, max-age=0');
});
