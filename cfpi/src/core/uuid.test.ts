/**
 * uuidv7 is load-bearing: it produces both entity ids and the Idempotency-Key
 * on every mutation. A malformed or colliding id means duplicate inspections
 * server-side, so it is worth pinning down properly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uuidv7 } from './uuid.ts';

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('produces a well-formed v7 UUID', () => {
  for (let i = 0; i < 500; i++) {
    assert.match(uuidv7(), RE);
  }
});

test('sets version 7 and the RFC 4122 variant', () => {
  const id = uuidv7();
  assert.equal(id[14], '7', 'version nibble');
  assert.ok('89ab'.includes(id[19]), `variant nibble was ${id[19]}`);
});

test('encodes the timestamp in the leading 48 bits', () => {
  const when = Date.parse('2026-08-07T09:00:00.000Z');
  const id = uuidv7(when);
  const hex = id.slice(0, 8) + id.slice(9, 13);
  assert.equal(Number.parseInt(hex, 16), when);
});

test('sorts chronologically', () => {
  // The reason for v7 over v4: ids that sort by creation time keep server-side
  // indexes from fragmenting on random inserts.
  const ids = [
    uuidv7(Date.parse('2026-08-01T00:00:00.000Z')),
    uuidv7(Date.parse('2026-08-05T00:00:00.000Z')),
    uuidv7(Date.parse('2026-08-09T00:00:00.000Z')),
  ];
  assert.deepEqual([...ids].sort(), ids);
});

test('does not collide within the same millisecond', () => {
  const now = Date.now();
  const seen = new Set<string>();
  for (let i = 0; i < 20_000; i++) seen.add(uuidv7(now));
  assert.equal(seen.size, 20_000, 'collision in 20k ids at a fixed timestamp');
});
