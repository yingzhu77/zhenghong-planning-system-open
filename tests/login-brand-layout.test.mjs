import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium, expect } from '@playwright/test';
import { webAssets } from '../server/web-assets.mjs';

const web = new URL('../web/', import.meta.url), assets = webAssets(fileURLToPath(web));
const source = fs.readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);
const artifacts = process.env.LOGIN_BRAND_ARTIFACT_DIR || path.join(os.tmpdir(), 'planning-login-brand-layout');
fs.mkdirSync(artifacts, { recursive: true });

async function artworkBounds(buffer, inset = 0) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = inset; y < info.height - inset; y++) for (let x = inset; x < info.width - inset; x++) {
    const i = (y * info.width + x) * 4;
    if (data[i + 3] > 32 && Math.min(data[i], data[i + 1], data[i + 2]) < 180) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  assert.ok(right >= left && bottom >= top, 'original brand artwork must remain visible');
  return { left, top, right, bottom, width: info.width, height: info.height };
}

async function verifyBrand(page, label, original) {
  const image = page.locator('.authcard .ac-brand img');
  await image.evaluate(element => element.decode());
  await page.locator('.auth-background img').evaluate(element => element.decode());
  const metrics = await page.evaluate(() => {
    const image = document.querySelector('.authcard .ac-brand img'), input = document.querySelector('#email');
    const logo = image.getBoundingClientRect(), email = input.getBoundingClientRect(), card = document.querySelector('.authcard').getBoundingClientRect();
    const style = getComputedStyle(image);
    return { logo: { x: logo.x, y: logo.y, width: logo.width, height: logo.height }, email: { x: email.x, width: email.width },
      card: { x: card.x, right: card.right, y: card.y, bottom: card.bottom }, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      objectFit: style.objectFit, background: style.backgroundColor, radius: parseFloat(style.borderRadius),
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, src: image.currentSrc };
  });
  assert.ok(Math.abs(metrics.logo.x - metrics.email.x) < 1, label + ': white brand region aligns with the input');
  assert.ok(Math.abs(metrics.logo.width - metrics.email.width) < 1, label + ': white brand region matches input width');
  assert.equal(metrics.background, 'rgb(255, 255, 255)'); assert.equal(metrics.objectFit, 'contain');
  assert.equal(metrics.naturalWidth, 304); assert.equal(metrics.naturalHeight, 101); assert.match(metrics.src, /\/logo\.png$/);
  assert.ok(metrics.radius >= 7 && metrics.radius <= 9);
  assert.ok(metrics.logo.x >= metrics.card.x && metrics.logo.y >= metrics.card.y);
  assert.ok(metrics.logo.x + metrics.logo.width <= metrics.card.right + 1);
  assert.ok(metrics.scrollWidth <= metrics.viewport, label + ': login page cannot overflow horizontally');

  // The image's original top and side whitespace is uneven. Measure painted
  // artwork, since centering only the image element would hide the defect.
  const painted = await artworkBounds(await image.screenshot(), 8);
  assert.ok(Math.abs((painted.left + painted.right + 1) / 2 - painted.width / 2) <= 2, label + ': logo artwork is horizontally centered');
  assert.ok(Math.abs((painted.top + painted.bottom + 1) / 2 - painted.height / 2) <= 2, label + ': logo artwork is vertically centered');
  const width = painted.right - painted.left + 1, height = painted.bottom - painted.top + 1;
  const expectedRatio = (original.right - original.left + 1) / (original.bottom - original.top + 1);
  assert.ok(width >= 150 && height >= 30, label + ': brand remains legible');
  assert.ok(Math.abs(width / height - expectedRatio) < .18, label + ': original artwork proportions are preserved');
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#email')).toHaveAttribute('autocomplete', 'username');
  await expect(page.locator('#password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(page.locator('.ac-name')).toHaveText('工程建设数字化服务平台');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),label+': title must fit the viewport');
  await page.screenshot({ path: path.join(artifacts, label + '.png'), fullPage: true });
  return metrics;
}

test('initial HTML and dynamic login preserve the original centered logo on a full-width white region at desktop and 390px', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const original = await artworkBounds(fs.readFileSync(new URL('logo.png', web)));
  const results = [];
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }), errors = [], apiCalls = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'http://login-brand.test') return route.abort('blockedbyclient');
        if (url.pathname.startsWith('/api/')) { apiCalls.push(url.pathname); return route.abort('blockedbyclient'); }
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: assets.html });
        // Keep the delivered initial HTML unhydrated for the first-paint check.
        if (request.resourceType() === 'script') return route.fulfill({ contentType: 'text/javascript', body: '' });
        const asset = assets.responses.get(url.pathname);
        if (!asset) return route.abort('blockedbyclient');
        const extension = path.extname(asset.name), type = { '.png': 'image/png', '.avif': 'image/avif', '.webp': 'image/webp' }[extension];
        return route.fulfill({ contentType: type || 'application/octet-stream', body: asset.body });
      });
      await page.goto('http://login-brand.test/');
      await expect(page.locator('[data-initial-login]')).toHaveCount(1);
      const size = viewport.width === 390 ? 'mobile' : 'desktop';
      const initial = await verifyBrand(page, 'initial-' + size, original);
      await page.evaluate(() => {
        window.WorkBuddyCloud = { createWorkBuddyCloud: () => ({ auth: {}, database: {} }) };
        window.PlanningBoot = { assets: JSON.parse(document.getElementById('planning-assets').textContent) };
      });
      await page.addScriptTag({ content: source.slice(0, boundary) + '\nwindow.loginBrandAudit={S,renderLogin};\n})();' });
      // The existing initial form is reused before a subsequent dynamic render.
      await page.evaluate(() => window.loginBrandAudit.renderLogin());
      await expect(page.locator('[data-initial-login]')).toHaveCount(0);
      await expect(page.locator('#authForm[onsubmit]')).toHaveCount(0);
      await page.evaluate(() => { document.getElementById('root').innerHTML = ''; window.loginBrandAudit.renderLogin(); });
      const dynamic = await verifyBrand(page, 'dynamic-' + size, original);
      assert.deepEqual(dynamic.logo, initial.logo, size + ': initial and dynamic layouts must agree');
      await expect(page.getByRole('button', { name: '验证码登录', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '注册', exact: true })).toBeVisible();
      assert.deepEqual(apiCalls, []); assert.deepEqual(errors, []);
      results.push({ viewport, initial, dynamic });
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(artifacts, 'geometry.json'), JSON.stringify(results, null, 2));
});
