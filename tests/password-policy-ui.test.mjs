import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { webAssets } from '../server/web-assets.mjs';

const web = new URL('../web/', import.meta.url), assets = webAssets(fileURLToPath(web));
const source = fs.readFileSync(new URL('app.js', web), 'utf8');
const boundary = source.indexOf('  (async function boot() {');
assert.ok(boundary > 0);
const artifacts = process.env.PASSWORD_POLICY_ARTIFACT_DIR || path.join(os.tmpdir(), 'planning-password-policy');

async function fixture() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const calls = [], errors = [], behavior = { loginSuccess: false, changeWrongIdentity: false };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://password-policy.test') return route.abort('blockedbyclient');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: assets.html });
    const asset = assets.responses.get(url.pathname);
    if (asset) {
      if (asset.name.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: '' });
      const type = { '.png': 'image/png', '.avif': 'image/avif', '.webp': 'image/webp' }[path.extname(asset.name)];
      return route.fulfill({ contentType: type || 'application/octet-stream', body: asset.body });
    }
    assert.ok(url.pathname.startsWith('/api/'), 'all requests stay inside the isolated test host');
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    calls.push({ path: url.pathname, body });
    let status = 200, result = { data: null, error: null };
    if (url.pathname === '/api/auth/login') {
      if (behavior.loginSuccess) result.data = { session: { user: { id: 'anonymous-user', email: body.email, must_change_password: false } } };
      else { status = 401; result.error = { message: '隔离测试登录失败', code: 'INVALID_CREDENTIALS' }; }
    } else if (url.pathname === '/api/auth/otp/send') result.data = { verificationId: 'anonymous-registration', isExistingUser: false };
    else if (url.pathname === '/api/auth/otp/verify') { status = 400; result.error = { message: '隔离测试验证码不正确' }; }
    else if (url.pathname === '/api/auth/password/reset/start') result.data = { verificationId: 'anonymous-recovery' };
    else if (url.pathname === '/api/auth/password/reset/complete') result.data = {};
    else if (url.pathname === '/api/auth/change-password') result.data = { session: { user: { id: behavior.changeWrongIdentity ? 'different-user' : 'anonymous-user', must_change_password: false } } };
    else if (url.pathname === '/api/db') { assert.equal(body.operation, 'select'); result.data = []; }
    else assert.fail('unexpected isolated API route: ' + url.pathname);
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('http://password-policy.test/');
  await page.addScriptTag({ content: fs.readFileSync(new URL('cloud-compat.js', web), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(new URL('password-change.js', web), 'utf8') });
  await page.addStyleTag({ content: fs.readFileSync(new URL('password-change.css', web), 'utf8') });
  await page.evaluate(() => { window.PlanningBoot = { assets: JSON.parse(document.getElementById('planning-assets').textContent), ensurePasswordChange: async () => { window.gateLoads = (window.gateLoads || 0) + 1; } }; });
  await page.addScriptTag({ content: source.slice(0, boundary) + '\nwindow.passwordPolicyAudit={S,renderLogin,pwdIssue};\n})();' });
  await page.evaluate(() => window.passwordPolicyAudit.renderLogin());
  return { browser, page, calls, errors, behavior };
}
const routeCalls = (h, route) => h.calls.filter(call => call.path === '/api/auth/' + route);

test('initial and dynamic password login preserve six digits, leading zeros and longer original strings without forcing an unmarked session to change password', async () => {
  const h = await fixture(), { page } = h;
  try {
    const passwords = ['111111', '000123', 'letters-only-password', '!@#$%^', ' 00123 '];
    for (const [index, password] of passwords.entries()) {
      if (index) await page.evaluate(() => window.passwordPolicyAudit.renderLogin(''));
      await page.locator('#email').fill('anonymous-' + index + '@example.invalid');
      await page.locator('#password').fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('#msg')).toContainText('邮箱或密码不正确');
      assert.equal(routeCalls(h, 'login').at(-1).body.password, password);
    }
    const validation = await page.evaluate(() => ({ short: window.passwordPolicyAudit.pwdIssue('12345'), long: window.passwordPolicyAudit.pwdIssue('x'.repeat(129)),
      six: window.passwordPolicyAudit.pwdIssue('000123'), letters: window.passwordPolicyAudit.pwdIssue('lettersOnly'), symbols: window.passwordPolicyAudit.pwdIssue('!@#$%^'), max: window.passwordPolicyAudit.pwdIssue('x'.repeat(128)) }));
    assert.ok(validation.short && validation.long); assert.equal(validation.six, null); assert.equal(validation.letters, null); assert.equal(validation.symbols, null); assert.equal(validation.max, null);
    h.behavior.loginSuccess = true;
    await page.locator('#email').fill('anonymous-success@example.invalid'); await page.locator('#password').fill('000123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '完善账号信息', exact: true })).toBeVisible();
    await expect(page.locator('.password-change-overlay')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.gateLoads || 0), 0);
    assert.equal(await page.evaluate(() => window.passwordPolicyAudit.S.session.user.must_change_password), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.browser.close(); }
});

test('actual registration accepts six numeric and longer character combinations while preserving verification ownership and length errors', async () => {
  const h = await fixture(), { page } = h;
  try {
    await page.evaluate(() => window.App.authTab('reg'));
    await expect(page.locator('#password')).toHaveAttribute('placeholder', '6 至 128 个字符，可使用纯数字');
    await page.locator('#email').fill('anonymous-register@example.invalid'); await page.locator('#code').fill('123456');
    await page.locator('#password').fill('000123'); await page.getByRole('button', { name: '注册并登录', exact: true }).click();
    await expect(page.locator('#msg')).toContainText('请先获取该邮箱的验证码'); assert.equal(routeCalls(h, 'otp/verify').length, 0);
    await page.getByRole('button', { name: '获取验证码', exact: true }).click();
    await expect(page.locator('#msg')).toContainText('验证码已发送');
    assert.deepEqual(routeCalls(h, 'otp/send')[0].body, { email: 'anonymous-register@example.invalid', purpose: 'register' });
    for (const password of ['12345', 'x'.repeat(129)]) {
      await page.locator('#password').fill(password); await page.getByRole('button', { name: '注册并登录', exact: true }).click();
      await expect(page.locator('#msg')).toContainText('6 至 128 个字符');
      assert.equal(routeCalls(h, 'otp/verify').length, 0);
    }
    for (const password of ['111111', '000123', 'lettersOnly', '!@#$%^', ' 12345 ']) {
      await page.locator('#password').fill(password); await page.getByRole('button', { name: '注册并登录', exact: true }).click();
      await expect(page.locator('#msg')).toContainText('隔离测试验证码不正确');
      assert.deepEqual(routeCalls(h, 'otp/verify').at(-1).body, { email: 'anonymous-register@example.invalid', verificationId: 'anonymous-registration', isExistingUser: false, token: '123456', password });
    }
    const verified = routeCalls(h, 'otp/verify').length;
    await page.locator('#email').fill('another-user@example.invalid'); await page.getByRole('button', { name: '注册并登录', exact: true }).click();
    await expect(page.locator('#msg')).toContainText('请先获取该邮箱的验证码'); assert.equal(routeCalls(h, 'otp/verify').length, verified);
    assert.deepEqual(h.errors, []);
  } finally { await h.browser.close(); }
});

test('actual recovery preserves email verification, rejects invalid lengths and mismatches, and submits a six-digit password with its leading zeros', async () => {
  const h = await fixture(), { page } = h;
  try {
    await page.locator('#email').fill('anonymous-recovery@example.invalid'); await page.evaluate(() => window.App.forgot());
    await expect(page.locator('#fp_new')).toHaveAttribute('placeholder', '6 至 128 个字符，可使用纯数字');
    await page.locator('#fp_new').fill('000123'); await page.locator('#fp_new2').fill('000123');
    await page.locator('#fp_go').click(); await expect(page.locator('#fp_msg')).toContainText('请先点击');
    assert.equal(routeCalls(h, 'password/reset/complete').length, 0);
    await page.locator('#fp_send').click(); await expect(page.locator('#fp_msg')).toContainText('验证码已发送');
    await page.locator('#fp_go').click(); await expect(page.locator('#fp_msg')).toContainText('请填写邮箱收到的验证码');
    await page.locator('#fp_code').fill('012345');
    for (const password of ['12345', 'x'.repeat(129)]) {
      await page.locator('#fp_new').fill(password); await page.locator('#fp_new2').fill(password); await page.locator('#fp_go').click();
      await expect(page.locator('#fp_msg')).toContainText('6 至 128 个字符');
      assert.equal(routeCalls(h, 'password/reset/complete').length, 0);
    }
    await page.locator('#fp_new').fill('000123'); await page.locator('#fp_new2').fill('111111'); await page.locator('#fp_go').click();
    await expect(page.locator('#fp_msg')).toContainText('两次输入的新密码不一致'); assert.equal(routeCalls(h, 'password/reset/complete').length, 0);
    await page.locator('#fp_new2').fill('000123'); await page.locator('#fp_go').click();
    await expect(page.locator('#zh_modal')).toHaveCount(0); await expect(page.locator('#msg')).toContainText('密码已重置');
    assert.deepEqual(routeCalls(h, 'password/reset/complete')[0].body, { email: 'anonymous-recovery@example.invalid', verificationId: 'anonymous-recovery', token: '012345', password: '000123' });
    assert.deepEqual(h.errors, []);
  } finally { await h.browser.close(); }
});

async function showGate(page, id = 'anonymous-user') {
  await page.evaluate(id => {
    window.gateIdentity = id; window.gateSuccess = []; window.gateLogouts = 0;
    window.gateOptions = { session: { user: { id, must_change_password: true } }, isCurrent: () => window.gateIdentity === id,
      onSuccess: session => window.gateSuccess.push(session), onLogout: async () => { window.gateLogouts++; window.gateIdentity = null; } };
    window.PasswordChange.show(window.gateOptions);
  }, id);
}
async function fillGate(page, current, next, confirmation = next) {
  await page.locator('#password-change-current').fill(current); await page.locator('#password-change-new').fill(next);
  await page.locator('#password-change-confirm').fill(confirmation);
}

test('first-change dialog accepts six digits but preserves native bounds, matching passwords, response identity and late-session isolation', async () => {
  const h = await fixture(), { page } = h;
  try {
    assert.equal(await page.evaluate(() => window.PasswordChange.show({ session: { user: { id: 'anonymous-user', must_change_password: false } } })), false);
    await showGate(page);
    await expect(page.locator('#password-change-new')).toHaveAttribute('minlength', '6');
    await expect(page.locator('#password-change-confirm')).toHaveAttribute('minlength', '6');
    await expect(page.locator('#password-change-new')).toHaveAttribute('maxlength', '128');
    await expect(page.locator('#password-change-policy')).toHaveText('6 至 128 个字符，可使用纯数字。');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'first-change-policy-desktop.png'), fullPage: true });
    await fillGate(page, '222222', '12345');
    await page.locator('.password-change-form').dispatchEvent('submit');
    await expect(page.locator('.password-change-message')).toContainText('6 至 128 个字符');
    await fillGate(page, '000123', '000123'); await page.locator('.password-change-submit').click();
    await expect(page.locator('.password-change-message')).toContainText('不能与当前密码相同');
    await fillGate(page, '222222', '000123', '000124'); await page.locator('.password-change-submit').click();
    await expect(page.locator('.password-change-message')).toContainText('两次输入的新密码不一致');
    assert.equal(routeCalls(h, 'change-password').length, 0);
    await fillGate(page, '222222', '000123'); await page.locator('.password-change-submit').click();
    await expect(page.locator('.password-change-overlay')).toHaveCount(0);
    assert.deepEqual(routeCalls(h, 'change-password')[0].body, { currentPassword: '222222', newPassword: '000123' });
    assert.equal(await page.evaluate(() => window.gateSuccess.length), 1);
    assert.equal(await page.locator('#root').evaluate(root => root.inert), false);

    h.behavior.changeWrongIdentity = true; await showGate(page);
    await fillGate(page, '222222', '111111'); await page.locator('.password-change-submit').click();
    await expect(page.locator('.password-change-message')).toContainText('未能确认密码修改结果');
    assert.equal(await page.evaluate(() => window.gateSuccess.length), 0);
    await page.evaluate(() => window.PasswordChange.close());

    await showGate(page, 'old-user');
    await page.evaluate(() => {
      window.pendingChanges = [];
      window.fetch = (url, options) => new Promise(resolve => window.pendingChanges.push({ body: JSON.parse(options.body), resolve }));
    });
    await fillGate(page, '222222', '000123'); await page.locator('.password-change-submit').click();
    await expect(page.locator('#password-change-new')).toBeDisabled();
    await page.evaluate(async () => {
      window.gateIdentity = 'new-user';
      window.pendingChanges[0].resolve({ ok: true, json: async () => ({ data: { session: { user: { id: 'old-user', must_change_password: false } } }, error: null }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    assert.equal(await page.evaluate(() => window.gateSuccess.length), 0);
    await showGate(page, 'new-user'); await expect(page.locator('#password-change-new')).toHaveValue('');
    await fillGate(page, '222222', '000123'); await page.locator('.password-change-submit').click();
    await page.locator('.password-change-logout').click(); await expect(page.locator('.password-change-overlay')).toHaveCount(0);
    await page.evaluate(async () => {
      window.pendingChanges[1].resolve({ ok: true, json: async () => ({ data: { session: { user: { id: 'new-user', must_change_password: false } } }, error: null }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    assert.equal(await page.evaluate(() => window.gateSuccess.length), 0); assert.equal(await page.evaluate(() => window.gateLogouts), 1);
    await expect(page.locator('.password-change-overlay')).toHaveCount(0); assert.deepEqual(h.errors, []);
  } finally { await h.browser.close(); }
});
