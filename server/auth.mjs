import express from 'express';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, passwordIssue, verifyPassword } from './password.mjs';
import { createMailer } from './mail.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ok = (res, data) => res.json({ data, error: null });
const fail = (res, status, code, message) => res.status(status).json({ data: null, error: { code, message } });
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const error = (status, code, message) => Object.assign(new Error(message), { status, code });

export function readCookie(req, name) {
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const split = part.indexOf('=');
    if (split >= 0 && part.slice(0, split).trim() === name) {
      try { return decodeURIComponent(part.slice(split + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Extra public entries are explicit origins, never wildcard hosts or paths.
export function createOriginCheck(config = {}) {
  const extra = String(config.additionalOrigins || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const value of extra) {
    let url;
    try { url = new URL(value); } catch { throw new Error('APP_ADDITIONAL_ORIGINS must contain complete HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.includes('*') || url.origin !== value)
      throw new Error('APP_ADDITIONAL_ORIGINS must contain complete HTTP(S) origins');
  }
  const allowed = new Set([config.publicOrigin, ...extra].filter(Boolean));
  return req => allowed.size ? allowed.has(req.headers.origin)
    : req.headers.origin === `${req.protocol}://${req.get('host')}`;
}

export function createAuth({ pool, config = {} }) {
  const router = express.Router();
  const cookieName = config.cookieName || 'zh_session';
  const sessionHours = Math.max(1, Math.min(168, Number(config.sessionHours) || 12));
  const secure = config.cookieSecure ?? process.env.COOKIE_SECURE === 'true';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  const publicOrigin = config.publicOrigin || process.env.PUBLIC_ORIGIN;
  const originAllowed = createOriginCheck({ ...config, publicOrigin });
  const codeSecret = config.authCodeSecret || process.env.AUTH_CODE_SECRET || randomBytes(32);
  const codeHash = (id, token) => createHmac('sha256', codeSecret).update(`${id}:${token}`).digest('hex');
  const mailer = config.mailer || createMailer(config);
  const dummyHash = hashPassword(randomBytes(24).toString('hex') + '1a');
  const wrap = handler => async (req, res, next) => {
    try { await handler(req, res); }
    catch (err) {
      if (err.status && err.status >= 400 && err.status <= 599)
        return fail(res, err.status, err.code || 'AUTH_ERROR', err.message);
      next(err);
    }
  };

  router.use(express.json({ limit: '32kb' }));
  router.use((req, res, next) => {
    req.body ||= {};
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !originAllowed(req)))
        return fail(res, 403, 'ORIGIN_MISMATCH', '请从系统页面发起操作');
    }
    next();
  });

  async function transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async function newSession(client, user) {
    const token = randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO app_private.sessions(token_hash,user_id,expires_at,last_seen_at)
      VALUES($1,$2,now()+$3 * interval '1 hour',now())`, [sha256(token), user.user_id, sessionHours]);
    return { token, session: { user: { id: user.user_id, email: user.email,
      must_change_password: user.must_change_password === true } } };
  }

  function setSessionCookie(res, token) {
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionHours * 3600000 });
  }

  async function getSession(req, res) {
    if (!req._zhSessionPromise) req._zhSessionPromise = (async () => {
      const token = readCookie(req, cookieName);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      return transaction(async client => {
        const { rows } = await client.query(`UPDATE app_private.sessions s
          SET last_seen_at=now(),expires_at=now()+$2 * interval '1 hour'
          FROM app_private.auth_users u WHERE s.token_hash=$1 AND s.user_id=u.user_id
          AND s.expires_at>now() AND NOT u.disabled RETURNING u.user_id,u.email,u.must_change_password`, [sha256(token), sessionHours]);
        if (!rows.length) return null;
        const user = { id: rows[0].user_id, email: rows[0].email,
          must_change_password: rows[0].must_change_password === true };
        await client.query("SELECT set_config('app.current_user_id',$1,true)", [user.id]);
        const profile = await client.query('SELECT * FROM public.profiles WHERE user_id=$1', [user.id]);
        if (profile.rows[0]) user.profile = profile.rows[0];
        req.user = user;
        req.sessionTokenHash = sha256(token); // Internal only: bind protected document grants to this login session.
        return { user };
      });
    })();
    const session = await req._zhSessionPromise;
    if (session && res) setSessionCookie(res, readCookie(req, cookieName));
    return session;
  }

  async function requireUser(req, res, next) {
    try {
      if (!await getSession(req, res)) return fail(res, 401, 'UNAUTHENTICATED', '请先登录');
      if (req.user.must_change_password) return fail(res, 403, 'PASSWORD_CHANGE_REQUIRED', '首次登录请先修改初始密码');
      next();
    } catch (err) { next(err); }
  }

  async function checkLock(key) {
    const { rows } = await pool.query('SELECT locked_until FROM app_private.login_attempts WHERE key=$1 AND locked_until>now()', [key]);
    if (rows.length) throw error(429, 'AUTH_LOCKED', '尝试次数过多，请 15 分钟后重试');
  }

  async function bumpFailure(key, limit = 5) {
    await pool.query(`INSERT INTO app_private.login_attempts(key,failures,updated_at) VALUES($1,1,now())
      ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN login_attempts.updated_at<now()-interval '15 minutes'
      THEN 1 ELSE login_attempts.failures+1 END,
      locked_until=CASE WHEN (CASE WHEN login_attempts.updated_at<now()-interval '15 minutes'
      THEN 1 ELSE login_attempts.failures+1 END)>=$2 THEN now()+interval '15 minutes' ELSE NULL END,
      updated_at=now()`, [key, limit]);
  }

  router.post('/login', wrap(async (req, res) => {
    const email = emailOf(req.body.email), password = req.body.password;
    if (!validEmail(email) || typeof password !== 'string') return fail(res, 400, 'INVALID_INPUT', '请填写邮箱和密码');
    const accountKey = `password:${email}`, ipKey = `login-ip:${req.ip}`;
    await Promise.all([checkLock(accountKey), checkLock(ipKey)]);
    const { rows } = await pool.query('SELECT user_id,email,password_hash,disabled,must_change_password FROM app_private.auth_users WHERE lower(email)=$1', [email]);
    const user = rows[0];
    const valid = await verifyPassword(password, user?.password_hash || await dummyHash);
    if (!valid || !user || user.disabled) {
      await Promise.all([bumpFailure(accountKey), bumpFailure(ipKey, 30)]);
      return fail(res, 401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
    await pool.query('DELETE FROM app_private.login_attempts WHERE key=$1', [accountKey]);
    const result = await transaction(async client => {
      // Serialize session creation with password changes/imports; a password
      // verified before another change cannot create a fresh usable session.
      const current = (await client.query('SELECT user_id,email,password_hash,disabled,must_change_password FROM app_private.auth_users WHERE user_id=$1 FOR UPDATE', [user.user_id])).rows[0];
      if (!current || current.disabled || current.password_hash !== user.password_hash)
        throw error(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
      return newSession(client, current);
    });
    setSessionCookie(res, result.token); ok(res, { session: result.session });
  }));

  router.get('/session', wrap(async (req, res) => ok(res, { session: await getSession(req, res) })));
  router.get('/user', wrap(async (req, res) => ok(res, { user: (await getSession(req, res))?.user || null })));
  router.post('/logout', wrap(async (req, res) => {
    const token = readCookie(req, cookieName);
    if (token) await pool.query('DELETE FROM app_private.sessions WHERE token_hash=$1', [sha256(token)]);
    res.clearCookie(cookieName, cookieOptions); ok(res, {});
  }));

  router.post('/change-password', wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!session) return fail(res, 401, 'UNAUTHENTICATED', '请先登录');
    const currentPassword = req.body.currentPassword, newPassword = req.body.newPassword;
    if (typeof currentPassword !== 'string' || currentPassword.length > 128)
      return fail(res, 400, 'INVALID_INPUT', '请填写当前密码');
    const issue = passwordIssue(newPassword);
    if (issue) return fail(res, 400, 'WEAK_PASSWORD', issue);
    const lockKey = `password-change:${session.user.id}`, ipKey = `password-change-ip:${req.ip}`;
    await Promise.all([checkLock(lockKey), checkLock(ipKey)]);
    const tokenHash = sha256(readCookie(req, cookieName));
    const result = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-password:${session.user.email.toLowerCase()}`]);
      const user = (await client.query(`SELECT user_id,email,password_hash,disabled,must_change_password
        FROM app_private.auth_users WHERE user_id=$1 FOR UPDATE`, [session.user.id])).rows[0];
      if (!user || user.disabled) throw error(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
      const live = await client.query(`SELECT token_hash FROM app_private.sessions
        WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE`, [tokenHash, user.user_id]);
      if (!live.rows.length) throw error(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
      if (!await verifyPassword(currentPassword, user.password_hash)) return { rejected: true };
      if (newPassword === currentPassword) throw error(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
      await client.query('UPDATE app_private.auth_users SET password_hash=$1,must_change_password=false WHERE user_id=$2',
        [await hashPassword(newPassword), user.user_id]);
      await client.query('DELETE FROM app_private.sessions WHERE user_id=$1 AND token_hash<>$2', [user.user_id, tokenHash]);
      await client.query('DELETE FROM app_private.auth_challenges WHERE lower(email)=$1', [user.email.toLowerCase()]);
      await client.query('DELETE FROM app_private.login_attempts WHERE key=ANY($1::text[])', [[lockKey, `password:${user.email.toLowerCase()}`]]);
      return { session: { user: { ...session.user, must_change_password: false } } };
    });
    if (result.rejected) {
      await Promise.all([bumpFailure(lockKey), bumpFailure(ipKey, 30)]);
      return fail(res, 400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
    }
    req.user = result.session.user;
    req._zhSessionPromise = Promise.resolve(result.session);
    ok(res, result);
  }));

  async function sendChallenge(req, res, purpose) {
    const email = emailOf(req.body.email);
    if (!validEmail(email) || !['login', 'register', 'reset'].includes(purpose))
      return fail(res, 400, 'INVALID_INPUT', '邮箱或验证码用途不正确');
    if (!mailer.configured) return fail(res, 503, 'SMTP_NOT_CONFIGURED', '邮件服务尚未配置，请联系管理员开通账号或配置 SMTP');
    const ipKey = `otp-send:${req.ip}`;
    await checkLock(ipKey);
    await bumpFailure(ipKey, 10);
    const result = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`otp:${email}`]);
      const recent = await client.query(`SELECT id FROM app_private.auth_challenges
        WHERE email=$1 AND created_at>now()-interval '60 seconds' LIMIT 1`, [email]);
      if (recent.rows.length) throw error(429, 'OTP_COOLDOWN', '请 60 秒后再获取验证码');
      const found = await client.query('SELECT user_id,email,disabled FROM app_private.auth_users WHERE lower(email)=$1', [email]);
      const isExistingUser = !!found.rows[0];
      // Purpose is recorded server-side; client-supplied isExistingUser never grants an identity.
      if (purpose === 'register' && isExistingUser) throw error(409, 'EMAIL_REGISTERED', '该邮箱已注册，请使用登录或找回密码');
      if (purpose !== 'register' && (!isExistingUser || found.rows[0].disabled))
        throw error(400, 'ACCOUNT_UNAVAILABLE', '该账号不存在或暂不可用，请联系管理员');
      const id = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
      await client.query('DELETE FROM app_private.auth_challenges WHERE email=$1 AND purpose=$2', [email, purpose]);
      await client.query(`INSERT INTO app_private.auth_challenges(id,email,purpose,code_hash,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [id, email, purpose, codeHash(id, code)]);
      try { await mailer.sendCode({ email, purpose, code }); }
      catch { throw error(502, 'SMTP_SEND_FAILED', '验证码邮件发送失败，请稍后重试或联系管理员'); }
      return { verificationId: id, isExistingUser };
    });
    ok(res, result);
  }

  router.post('/otp/send', wrap((req, res) => sendChallenge(req, res, req.body.purpose)));
  router.post('/password/reset/start', wrap((req, res) => sendChallenge(req, res, 'reset')));

  async function consumeChallenge(req, expectedPurpose, action) {
    const email = emailOf(req.body.email), id = req.body.verificationId, token = req.body.token;
    if (!validEmail(email) || typeof id !== 'string' || id.length > 80 || !/^\d{6}$/.test(String(token || '')))
      throw error(400, 'INVALID_INPUT', '请填写邮箱和六位验证码');
    return transaction(async client => {
      // Recovery and in-session changes use the same lock order before they
      // touch challenge/user/session rows, including concurrent code use.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`auth-password:${email}`]);
      const { rows } = await client.query(`SELECT *,expires_at>now() AS active
        FROM app_private.auth_challenges WHERE id=$1 AND email=$2 FOR UPDATE`, [id, email]);
      const challenge = rows[0];
      if (!challenge || !challenge.active || challenge.attempts >= 5
        || (expectedPurpose && challenge.purpose !== expectedPurpose)
        || (!expectedPurpose && !['login', 'register'].includes(challenge.purpose)))
        return { rejected: true };
      const actual = Buffer.from(codeHash(id, String(token)), 'hex'), stored = Buffer.from(challenge.code_hash, 'hex');
      if (actual.length !== stored.length || !timingSafeEqual(actual, stored)) {
        await client.query('UPDATE app_private.auth_challenges SET attempts=attempts+1 WHERE id=$1', [id]);
        return { rejected: true };
      }
      const result = await action(client, challenge);
      await client.query('DELETE FROM app_private.auth_challenges WHERE id=$1', [id]);
      return result;
    });
  }

  router.post('/otp/verify', wrap(async (req, res) => {
    const result = await consumeChallenge(req, null, async (client, challenge) => {
      let user;
      if (challenge.purpose === 'register') {
        const issue = passwordIssue(req.body.password);
        if (issue) throw error(400, 'WEAK_PASSWORD', issue);
        user = { user_id: randomUUID(), email: challenge.email };
        try { await client.query(`INSERT INTO app_private.auth_users(user_id,email,password_hash)
          VALUES($1,$2,$3)`, [user.user_id, user.email, await hashPassword(req.body.password)]); }
        catch (err) { if (err.code === '23505') throw error(409, 'EMAIL_REGISTERED', '该邮箱已注册'); throw err; }
      } else {
        const found = await client.query('SELECT user_id,email,must_change_password FROM app_private.auth_users WHERE lower(email)=$1 AND NOT disabled FOR UPDATE', [challenge.email]);
        user = found.rows[0];
        if (!user) throw error(400, 'ACCOUNT_UNAVAILABLE', '该账号暂不可用，请联系管理员');
      }
      return newSession(client, user);
    });
    if (result.rejected) return fail(res, 400, 'INVALID_OTP', '验证码不正确、已失效或尝试次数过多，请重新获取');
    setSessionCookie(res, result.token); ok(res, { session: result.session });
  }));

  router.post('/password/reset/complete', wrap(async (req, res) => {
    const issue = passwordIssue(req.body.password);
    if (issue) return fail(res, 400, 'WEAK_PASSWORD', issue);
    const result = await consumeChallenge(req, 'reset', async (client, challenge) => {
      const updated = await client.query(`UPDATE app_private.auth_users SET password_hash=$1,must_change_password=false
        WHERE lower(email)=$2 AND NOT disabled RETURNING user_id`, [await hashPassword(req.body.password), challenge.email]);
      if (!updated.rows.length) throw error(400, 'ACCOUNT_UNAVAILABLE', '该账号暂不可用，请联系管理员');
      await client.query('DELETE FROM app_private.sessions WHERE user_id=$1', [updated.rows[0].user_id]);
      await client.query('DELETE FROM app_private.login_attempts WHERE key=$1', [`password:${challenge.email}`]);
      await client.query('DELETE FROM app_private.auth_challenges WHERE email=$1', [challenge.email]);
      return { reset: true };
    });
    if (result.rejected) return fail(res, 400, 'INVALID_OTP', '验证码不正确、已失效或尝试次数过多，请重新获取');
    res.clearCookie(cookieName, cookieOptions); ok(res, result);
  }));

  return { router, requireUser, getSession };
}

export function registerAuth(app, options) {
  const auth = createAuth(options); app.use('/api/auth', auth.router); return auth;
}

export function authenticate(options) { return createAuth(options).requireUser; }
