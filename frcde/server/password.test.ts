/**
 * Password hashing is the one thing here where a plausible-looking bug is
 * silently catastrophic — a verify that returns true too easily, or a stored
 * form that is not actually a hash. Worth testing directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  hashPasswordSync,
  isHashed,
  needsRehash,
  verifyPassword,
} from './password.ts';

test('a hash does not contain the password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.ok(!stored.includes('correct'));
  assert.ok(isHashed(stored));
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w+/=]+\$[\w+/=]+$/);
});

test('the right password verifies, the wrong one does not', async () => {
  const stored = await hashPassword('supervisor');
  assert.equal(await verifyPassword('supervisor', stored), true);
  assert.equal(await verifyPassword('supervisos', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword('SUPERVISOR', stored), false);
});

test('the same password hashes differently every time', async () => {
  // Per-password salt: two accounts sharing a password must not share a hash,
  // or a stolen database reveals which users to attack together.
  const a = await hashPassword('inspector');
  const b = await hashPassword('inspector');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('inspector', a), true);
  assert.equal(await verifyPassword('inspector', b), true);
});

test('sync and async hashing are interchangeable', async () => {
  const stored = hashPasswordSync('siti');
  assert.equal(await verifyPassword('siti', stored), true);
});

test('a legacy plain-text record still verifies, and is flagged for rehash', async () => {
  // Databases written before hashing existed must not lock everyone out.
  assert.equal(await verifyPassword('supervisor', 'supervisor'), true);
  assert.equal(await verifyPassword('wrong', 'supervisor'), false);
  assert.equal(needsRehash('supervisor'), true);
});

test('a current hash does not ask to be redone', async () => {
  assert.equal(needsRehash(await hashPassword('x')), false);
});

test('a corrupt record fails closed rather than accepting anything', async () => {
  // The third of these very nearly shipped as an accept-any-password hole:
  // unparseable base64 decodes to an empty buffer, scrypt returns an empty
  // derived key for a zero length, and timingSafeEqual on two empty buffers
  // reports a match.
  const corrupt = [
    'scrypt$',
    'scrypt$a$b$c$d$e',
    'scrypt$32768$8$3$!!!$!!!',
    'scrypt$32768$8$3$$',
    'scrypt$0$0$0$AAAAAAAAAAA=$AAAAAAAAAAA=',
    'scrypt$32768$8$3$AA$AA',
  ];
  for (const bad of corrupt) {
    assert.equal(await verifyPassword('anything', bad), false, `accepted: ${bad}`);
    assert.equal(await verifyPassword('', bad), false, `accepted empty for: ${bad}`);
  }
});
