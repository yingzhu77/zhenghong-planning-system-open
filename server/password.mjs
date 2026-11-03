import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function passwordIssue(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 128)
    return '密码须为 6 至 128 个字符';
  return null;
}

export async function hashPassword(password) {
  const issue = passwordIssue(password);
  if (issue) throw new Error(issue);
  return encodePassword(password);
}

// Retained for controlled roster tooling. The caller explicitly chooses whether
// the account must change its password; hashing never changes account state.
export async function hashTemporaryPassword(password) {
  return hashPassword(password);
}

async function encodePassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, OPTIONS);
  return ['scrypt', OPTIONS.N, OPTIONS.r, OPTIONS.p, salt.toString('hex'), key.toString('hex')].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const [scheme, n, r, p, salt, key, extra] = encoded.split('$');
  if (scheme !== 'scrypt' || extra || n !== '32768' || r !== '8' || p !== '1'
      || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(key || '')) return false;
  const actual = await derive(password, Buffer.from(salt, 'hex'), 64, OPTIONS);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
