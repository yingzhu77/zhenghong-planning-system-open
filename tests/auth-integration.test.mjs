import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { createAuth } from '../server/auth.mjs';
import { hashPassword, hashTemporaryPassword, verifyPassword } from '../server/password.mjs';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* Optional integration dependency. */ }

test('PGlite PostgreSQL authentication: hashed sessions, OTP limits, registration and recovery', { skip: !PGlite }, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE ROLE app_runtime; CREATE TABLE public.profiles(user_id text PRIMARY KEY,name text,role text,status text);');
  await db.exec(await readFile(new URL('../db/004-auth.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../db/010-first-password-change.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../db/010-first-password-change.sql', import.meta.url), 'utf8'));
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({
    query: (sql, args) => db.query(sql, args), release() {}
  }) };
  const sent = [];
  const mailer = { configured: true, async sendCode(message) { sent.push(message); } };
  const app = express();
  const auth = createAuth({ pool, config: { mailer, authCodeSecret: 'integration-code-secret', publicOrigin: 'http://localhost' } });
  app.use('/api/auth', auth.router);
  app.get('/protected', auth.requireUser, (req, res) => res.json({ user: req.user }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, body, cookie) {
    const response = await fetch(`${base}${path.startsWith('/protected') ? path : '/api/auth' + path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {})
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const email = 'person@example.com';
  await db.query('INSERT INTO app_private.auth_users(user_id,email,password_hash) VALUES($1,$2,$3)', ['existing-user', email, await hashPassword('Existing-pass918')]);
  const logged = await call('/login', { email: ' PERSON@EXAMPLE.COM ', password: 'Existing-pass918' });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.data.session.user.id, 'existing-user');
  assert.equal(logged.body.data.session.user.must_change_password, false);
  assert.match(logged.cookie, /HttpOnly/);
  assert.match(logged.cookie, /SameSite=Lax/);
  const cookie = logged.cookie.split(';')[0], rawToken = decodeURIComponent(cookie.split('=')[1]);
  const sessions = await db.query('SELECT token_hash FROM app_private.sessions');
  assert.equal(sessions.rows[0].token_hash, createHash('sha256').update(rawToken).digest('hex'));
  assert.notEqual(sessions.rows[0].token_hash, rawToken);
  assert.equal((await call('/protected', undefined, cookie)).body.user.id, 'existing-user');

  const otp = await call('/otp/send', { email, purpose: 'login' });
  assert.equal(otp.status, 200);
  assert.equal((await call('/otp/send', { email, purpose: 'login' })).status, 429);
  const actualCode = sent.at(-1).code;
  const wrongCode = actualCode === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('/otp/verify', {
    email, verificationId: otp.body.data.verificationId, token: wrongCode
  })).status, 400);
  assert.equal((await call('/otp/verify', { email, verificationId: otp.body.data.verificationId, token: actualCode })).status, 400);
  assert.equal((await db.query('SELECT attempts FROM app_private.auth_challenges WHERE id=$1', [otp.body.data.verificationId])).rows[0].attempts, 5);

  const newEmail = 'newperson@example.com';
  const register = await call('/otp/send', { email: newEmail, purpose: 'register' });
  assert.equal(register.status, 200);
  const registered = await call('/otp/verify', { email: newEmail, verificationId: register.body.data.verificationId,
    token: sent.at(-1).code, password: 'New-person918', isExistingUser: true, user_id: 'existing-user', role: 'ops' });
  assert.equal(registered.status, 200);
  assert.notEqual(registered.body.data.session.user.id, 'existing-user');
  assert.equal((await db.query('SELECT * FROM profiles')).rows.length, 0);
  assert.equal((await call('/otp/verify', { email: newEmail, verificationId: register.body.data.verificationId,
    token: sent.at(-1).code, password: 'New-person918' })).status, 400);

  for (let i = 0; i < 5; i++) assert.equal((await call('/login', { email, password: 'Wrong-pass918' })).status, 401);
  assert.equal((await call('/login', { email, password: 'Existing-pass918' })).status, 429);
  await db.query("UPDATE app_private.auth_challenges SET created_at=now()-interval '61 seconds' WHERE email=$1", [email]);
  const reset = await call('/password/reset/start', { email });
  assert.equal(reset.status, 200);
  const resetResult = await call('/password/reset/complete', { email, verificationId: reset.body.data.verificationId,
    token: sent.at(-1).code, password: 'Reset-pass918' });
  assert.equal(resetResult.status, 200);
  assert.equal((await call('/protected', undefined, cookie)).status, 401);
  const changed = (await db.query('SELECT password_hash FROM app_private.auth_users WHERE email=$1', [email])).rows[0].password_hash;
  assert.equal(await verifyPassword('Existing-pass918', changed), false);
  assert.equal(await verifyPassword('Reset-pass918', changed), true);
  const relogged = await call('/login', { email, password: 'Reset-pass918' });
  assert.equal(relogged.status, 200);
  const freshCookie = relogged.cookie.split(';')[0];
  assert.equal((await call('/logout', {}, freshCookie)).status, 200);
  assert.equal((await call('/protected', undefined, freshCookie)).status, 401);

  const importedEmail = 'imported-person@example.invalid', temporaryPassword = '98371625';
  await db.query('INSERT INTO app_private.auth_users(user_id,email,password_hash,must_change_password) VALUES($1,$2,$3,true)',
    ['imported-user', importedEmail, await hashTemporaryPassword(temporaryPassword)]);
  const imported = await call('/login', { email: importedEmail, password: temporaryPassword });
  const importedCookie = imported.cookie.split(';')[0];
  const otherImported = await call('/login', { email: importedEmail, password: temporaryPassword });
  const otherCookie = otherImported.cookie.split(';')[0];
  assert.equal(imported.body.data.session.user.must_change_password, true);
  assert.equal((await call('/session', undefined, importedCookie)).body.data.session.user.must_change_password, true);
  assert.equal((await call('/user', undefined, importedCookie)).body.data.user.must_change_password, true);
  const blocked = await call('/protected', undefined, importedCookie);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('/change-password', { currentPassword: temporaryPassword, newPassword: 'Changed-pass918' })).status, 401);
  const wrongCurrent = await call('/change-password', { currentPassword: 'Wrong-current918', newPassword: 'Changed-pass918' }, importedCookie);
  assert.equal(wrongCurrent.status, 400);
  assert.equal(wrongCurrent.body.error.code, 'INVALID_CURRENT_PASSWORD');
  assert.equal((await call('/change-password', { currentPassword: temporaryPassword, newPassword: temporaryPassword }, importedCookie)).body.error.code, 'PASSWORD_UNCHANGED');
  assert.equal((await call('/session', undefined, importedCookie)).body.data.session.user.must_change_password, true);
  const importedOtp = await call('/otp/send', { email: importedEmail, purpose: 'login' });
  const importedOtpLogin = await call('/otp/verify', { email: importedEmail,
    verificationId: importedOtp.body.data.verificationId, token: sent.at(-1).code });
  const otpCookie = importedOtpLogin.cookie.split(';')[0];
  assert.equal(importedOtpLogin.body.data.session.user.must_change_password, true);
  assert.equal((await call('/protected', undefined, otpCookie)).status, 403);
  const changedImported = await call('/change-password', { currentPassword: temporaryPassword, newPassword: 'Changed-pass918' }, importedCookie);
  assert.equal(changedImported.status, 200);
  assert.equal(changedImported.body.data.session.user.must_change_password, false);
  assert.equal((await call('/protected', undefined, importedCookie)).status, 200);
  assert.equal((await call('/protected', undefined, otherCookie)).status, 401);
  assert.equal((await call('/protected', undefined, otpCookie)).status, 401);
  const storedImported = (await db.query('SELECT password_hash,must_change_password FROM app_private.auth_users WHERE user_id=$1', ['imported-user'])).rows[0];
  assert.equal(storedImported.must_change_password, false);
  assert.equal(await verifyPassword(temporaryPassword, storedImported.password_hash), false);
  assert.equal(await verifyPassword('Changed-pass918', storedImported.password_hash), true);
  assert.equal((await call('/change-password', { currentPassword: 'Changed-pass918', newPassword: 'Changed-pass918' }, importedCookie)).body.error.code, 'PASSWORD_UNCHANGED');

  // Verified recovery replaces the initial password and ends all sessions. A
  // code login alone cannot complete this first-login requirement.
  await db.query('UPDATE app_private.auth_users SET password_hash=$1,must_change_password=true WHERE user_id=$2',
    [await hashTemporaryPassword(temporaryPassword), 'imported-user']);
  const recovery = await call('/password/reset/start', { email: importedEmail });
  const recovered = await call('/password/reset/complete', { email: importedEmail,
    verificationId: recovery.body.data.verificationId, token: sent.at(-1).code, password: 'Recovered-pass918' });
  assert.equal(recovered.status, 200);
  assert.equal((await call('/protected', undefined, importedCookie)).status, 401);
  const afterRecovery = await call('/login', { email: importedEmail, password: 'Recovered-pass918' });
  assert.equal(afterRecovery.status, 200);
  assert.equal(afterRecovery.body.data.session.user.must_change_password, false);

  // Six-digit credentials work at each interactive entry point, while existing
  // longer passwords and the explicit first-change gate remain compatible.
  const numericPassword = '384629', otherNumericPassword = '729463';
  const numericRegistration = await call('/otp/send', { email: 'numeric@example.invalid', purpose: 'register' });
  const numericRegistered = await call('/otp/verify', { email: 'numeric@example.invalid',
    verificationId: numericRegistration.body.data.verificationId, token: sent.at(-1).code, password: numericPassword });
  assert.equal(numericRegistered.status, 200);
  const numericLogin = await call('/login', { email: 'numeric@example.invalid', password: numericPassword });
  assert.equal(numericLogin.status, 200);
  const numericCookie = numericLogin.cookie.split(';')[0];
  assert.equal((await call('/protected', undefined, numericCookie)).status, 200);
  assert.equal((await call('/change-password', { currentPassword: numericPassword, newPassword: '38462' }, numericCookie)).body.error.code, 'WEAK_PASSWORD');
  assert.equal((await call('/change-password', { currentPassword: numericPassword, newPassword: otherNumericPassword }, numericCookie)).status, 200);
  assert.equal((await call('/login', { email: 'numeric@example.invalid', password: numericPassword })).status, 401);
  assert.equal((await call('/login', { email: 'numeric@example.invalid', password: otherNumericPassword })).status, 200);
  const numericRecovery = await call('/password/reset/start', { email });
  assert.equal(numericRecovery.status, 200);
  assert.equal((await call('/password/reset/complete', { email, verificationId: numericRecovery.body.data.verificationId,
    token: sent.at(-1).code, password: numericPassword })).status, 200);
  assert.equal((await call('/login', { email, password: numericPassword })).status, 200);
});
