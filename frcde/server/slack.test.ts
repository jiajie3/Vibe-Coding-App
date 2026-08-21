/**
 * Slack integration tests.
 *
 * The interactions endpoint is public — Slack cannot hold a session — so the
 * request signature is the only thing between the internet and the ability to
 * close work orders. Most of this file is about that one function failing
 * closed, because every way it can wrongly return true is a way for a stranger
 * to mark drains as cleared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  caseBlocks,
  closeModal,
  isConfigured,
  parseInteraction,
  verifyRequest,
} from './slack.ts';
import type { CaseView } from './slack.ts';

const SECRET = 'test-signing-secret';
process.env.SLACK_SIGNING_SECRET = SECRET;

const NOW = Date.parse('2026-08-19T02:00:00.000Z');
const tsOf = (ms: number) => String(Math.floor(ms / 1000));

const sign = (body: string, timestamp: string, secret = SECRET) =>
  'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');

const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';

test('a genuine Slack request verifies', () => {
  const ts = tsOf(NOW);
  assert.equal(verifyRequest(BODY, ts, sign(BODY, ts), NOW), true);
});

test('a Buffer body verifies identically to a string', () => {
  const ts = tsOf(NOW);
  assert.equal(verifyRequest(Buffer.from(BODY), ts, sign(BODY, ts), NOW), true);
});

test('a signature from the wrong secret is rejected', () => {
  const ts = tsOf(NOW);
  assert.equal(verifyRequest(BODY, ts, sign(BODY, ts, 'not-the-secret'), NOW), false);
});

test('a tampered body is rejected', () => {
  const ts = tsOf(NOW);
  const sig = sign(BODY, ts);
  assert.equal(verifyRequest(BODY + '&extra=1', ts, sig, NOW), false);
});

test('a replayed request goes stale', () => {
  // Same request, correct signature, six minutes later. Without the window a
  // captured request stays valid for ever.
  const ts = tsOf(NOW);
  const sig = sign(BODY, ts);
  assert.equal(verifyRequest(BODY, ts, sig, NOW), true);
  assert.equal(verifyRequest(BODY, ts, sig, NOW + 6 * 60_000), false);
});

test('a timestamp far in the future is rejected', () => {
  const future = tsOf(NOW + 10 * 60_000);
  assert.equal(verifyRequest(BODY, future, sign(BODY, future), NOW), false);
});

test('missing or malformed headers fail closed', () => {
  const ts = tsOf(NOW);
  const sig = sign(BODY, ts);
  assert.equal(verifyRequest(BODY, undefined, sig, NOW), false);
  assert.equal(verifyRequest(BODY, ts, undefined, NOW), false);
  assert.equal(verifyRequest(BODY, 'not-a-number', sig, NOW), false);
  assert.equal(verifyRequest(BODY, ts, '', NOW), false);
});

test('a signature of the wrong length is rejected rather than throwing', () => {
  // timingSafeEqual throws on unequal lengths; that would be a 500 instead of a
  // refusal, and a crash loop is its own kind of outage.
  const ts = tsOf(NOW);
  for (const bad of ['v0=', 'v0=abc', 'garbage', 'v0=' + 'f'.repeat(63)]) {
    assert.equal(verifyRequest(BODY, ts, bad, NOW), false, `threw or accepted: ${bad}`);
  }
});

test('with no signing secret configured, nothing verifies', () => {
  const saved = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;
  try {
    const ts = tsOf(NOW);
    assert.equal(verifyRequest(BODY, ts, sign(BODY, ts), NOW), false);
    assert.equal(isConfigured(), false);
  } finally {
    process.env.SLACK_SIGNING_SECRET = saved;
  }
});

/* ---------------------------------------------------------- payloads */

test('a button press is flattened to the fields we act on', () => {
  const payload = {
    type: 'block_actions',
    user: { username: 'contractor.lim' },
    channel: { id: 'C123' },
    message: { ts: '1755.0001' },
    trigger_id: 'T999',
    actions: [{ action_id: 'case_done', value: 'wo-42' }],
  };
  const i = parseInteraction('payload=' + encodeURIComponent(JSON.stringify(payload)));
  assert.equal(i?.type, 'block_actions');
  assert.equal(i?.actionId, 'case_done');
  assert.equal(i?.caseId, 'wo-42');
  assert.equal(i?.channel, 'C123');
  assert.equal(i?.messageTs, '1755.0001');
  assert.equal(i?.userName, 'contractor.lim');
});

test('a modal submission carries the note and the case it belongs to', () => {
  const payload = {
    type: 'view_submission',
    user: { username: 'contractor.lim' },
    view: {
      callback_id: 'case_done_submit',
      private_metadata: 'wo-42',
      state: { values: { note: { value: { value: 'Jetted, 0.4 m3 removed.' } } } },
    },
  };
  const i = parseInteraction('payload=' + encodeURIComponent(JSON.stringify(payload)));
  assert.equal(i?.type, 'view_submission');
  assert.equal(i?.callbackId, 'case_done_submit');
  assert.equal(i?.caseId, 'wo-42');
  assert.equal(i?.value, 'Jetted, 0.4 m3 removed.');
});

test('junk payloads return null instead of throwing', () => {
  for (const bad of ['', 'payload=not-json', 'nothing=here', '%%%']) {
    assert.equal(parseInteraction(bad), null, `did not reject: ${bad}`);
  }
});

/* ------------------------------------------------------------ blocks */

const view = (over: Partial<CaseView> = {}): CaseView => ({
  id: '4f2a1c9e-0000-0000-0000-000000000000',
  title: 'Blockage at downstream end',
  detail: 'Approx 260 mm silt. Jetting required.',
  assigned_to: 'Ang Mo Kio Town Council',
  severity: 4,
  due_at: '2026-08-26T01:00:00.000Z',
  chainage_m: 261.4,
  asset_name: 'Sungei Whampoa',
  reference: 'INS-2026-004021',
  status: 'open',
  ...over,
});

const json = (blocks: unknown[]) => JSON.stringify(blocks);

test('an unacknowledged case offers only acknowledgement', () => {
  // Closing without acknowledging loses the one measurement that shows whether
  // routing works: how long a case sits before anybody picks it up. It also
  // makes "acknowledged" a status nothing has to pass through.
  const b = json(caseBlocks(view()));
  assert.match(b, /case_ack/);
  assert.ok(!b.includes('case_done'), 'must not offer to close before acknowledgement');
  assert.ok(!b.includes('case_blocked'), 'must not offer to block before acknowledgement');
  assert.match(b, /Awaiting acknowledgement/);
  assert.match(b, /options to close it appear after that/);
});

test('acknowledging swaps in the two ways of finishing', () => {
  const b = json(caseBlocks(view({ acknowledged_at: '2026-08-19T01:00:00.000Z' })));
  assert.ok(!b.includes('case_ack'), 'should not offer to acknowledge twice');
  assert.match(b, /case_done/);
  assert.match(b, /case_blocked/);
  assert.match(b, /Acknowledged/);
});

test('the card asks for a photograph until one arrives', () => {
  const ack = { acknowledged_at: '2026-08-19T01:00:00.000Z' };

  const none = json(caseBlocks(view({ ...ack, completion_photos: 0 })));
  assert.match(none, /Completed \(photo needed\)/);
  assert.match(none, /post a photograph in this thread/i);

  const some = json(caseBlocks(view({ ...ack, completion_photos: 2 })));
  assert.match(some, /2 photos received/);
  assert.ok(!some.includes('photo needed'), 'should stop nagging once photos arrive');
});

test('a completed case reads as closed, and offers nothing further', () => {
  // The contractor pressing Completed closes the case outright. There was a
  // supervisor confirmation between the two; it queued work in front of someone
  // who had already delegated it, and the photograph is filed either way.
  const b = json(
    caseBlocks(view({ status: 'done', closing_note: 'Jetted and cleared.', completion_photos: 1 })),
  );
  assert.match(b, /\*Closed\*/);
  assert.match(b, /Jetted and cleared/);
  assert.ok(!b.includes('case_done'), 'a closed case must not be closable again');
  assert.ok(!b.includes('case_ack'));
});

test('a closed case offers no buttons at all', () => {
  const b = json(caseBlocks(view({ status: 'done', closing_note: 'Jetted and cleared.' })));
  assert.ok(!b.includes('case_done'), 'a closed case must not be closable again');
  assert.ok(!b.includes('case_ack'));
  assert.match(b, /Jetted and cleared/);
});

test('a blocked case shows the reason and stops accepting actions', () => {
  const b = json(caseBlocks(view({ status: 'blocked', blocked_reason: 'No access — gate locked.' })));
  assert.match(b, /Cannot complete/);
  assert.match(b, /gate locked/);
  assert.ok(!b.includes('case_done'));
});

test('the card carries the drain and the finding, and nothing filed for us', () => {
  const b = json(caseBlocks(view()));
  assert.match(b, /Sungei Whampoa/);
  assert.match(b, /Approx 260 mm silt/);
  // A contractor reading a channel does not need our filing: the distance is in
  // the description, the channel is who it went to, and the inspection
  // reference and case id mean nothing to them.
  assert.ok(!b.includes('INS-2026-004021'), 'inspection reference should not be shown');
  assert.ok(!b.includes('*Routed to*'), 'the channel already says who it went to');
  assert.ok(!b.includes('*Case*'), 'the case id is our filing');
  assert.ok(!b.includes('*Location*'), 'the distance belongs in the description');
});

test('a severity nobody chose is not reported to the contractor', () => {
  // Severity is no longer captured when raising a follow-up, so printing
  // "Moderate (3/5)" would state a judgement that was never made — and a
  // contractor cannot tell a real severity from a default.
  const b = json(caseBlocks(view({ severity: 3 })));
  assert.ok(!b.includes('Severity'), 'card should not claim a severity');
  assert.ok(!/\d\/5/.test(b), 'card should not print a severity score');
});

test('a very long detail is truncated rather than rejected by Slack', () => {
  // Slack caps a section at 3000 characters and errors on more, which would
  // mean the case silently never posts.
  const b = json(caseBlocks(view({ detail: 'x'.repeat(5000) })));
  assert.ok(b.includes('x'.repeat(2900)));
  assert.ok(!b.includes('x'.repeat(3001)));
});

test('the close modal carries the case id and asks the right question', () => {
  const done = JSON.stringify(closeModal('done', 'wo-42'));
  assert.match(done, /case_done_submit/);
  assert.match(done, /wo-42/);
  assert.match(done, /What was done/);

  const blocked = JSON.stringify(closeModal('blocked', 'wo-42'));
  assert.match(blocked, /case_blocked_submit/);
  assert.match(blocked, /Why can it not be done/);
});
