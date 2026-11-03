import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, hashTemporaryPassword, verifyPassword, passwordIssue } from '../server/password.mjs';

test('password hashes use individual salts and verify correct passwords only', async () => {
  const first = await hashPassword('Strong-demo-918');
  const second = await hashPassword('Strong-demo-918');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('Strong-demo-918', first), true);
  assert.equal(await verifyPassword('Wrong-demo-918', first), false);
  assert.equal(await verifyPassword('Strong-demo-918', 'invalid-format'), false);
  assert.equal(await verifyPassword('Strong-demo-918', first.replace('$32768$', '$1073741824$')), false);
  for (const value of ['384629', '12345678', 'lettersOnly', '中文密码六个字', '------', 'x'.repeat(128)])
    assert.equal(passwordIssue(value), null);
  for (const value of [null, 384629, '', 'short', 'x'.repeat(129)])
    assert.notEqual(passwordIssue(value), null);
  await assert.rejects(hashPassword('short'));
  const numeric = await hashPassword('384629');
  assert.equal(await verifyPassword('384629', numeric), true);
  assert.equal(await verifyPassword('384628', numeric), false);
  const temporary = await hashTemporaryPassword('384629');
  assert.equal(await verifyPassword('384629', temporary), true);
  assert.notEqual(numeric, temporary);
  await assert.rejects(hashTemporaryPassword('short'));
});
