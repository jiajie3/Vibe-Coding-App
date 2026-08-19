/**
 * Slack round trip, over HTTP, against a running server.
 *
 * The unit tests cover routing and signature verification in isolation. What
 * they cannot cover is the part that actually breaks: whether a signed payload
 * survives Express's body handling intact. The signature is computed over the
 * raw bytes, so any middleware that parses and re-serialises the body silently
 * invalidates every request Slack ever sends — and the only symptom is a 401
 * that looks like a misconfigured secret.
 *
 * Run against a server started with SLACK_SIGNING_SECRET set:
 *
 *   SLACK_SIGNING_SECRET=test-secret npm start
 *   SLACK_SIGNING_SECRET=test-secret npm run slack:e2e
 */

import { createHmac } from 'node:crypto';

const BASE = process.env.FRCDE_URL ?? 'http://127.0.0.1:4000';
const SECRET = process.env.SLACK_SIGNING_SECRET ?? 'test-secret';
const USER = process.env.FRCDE_SUPERVISOR ?? 'supervisor';
const PASS = process.env.FRCDE_SUPERVISOR_PASSWORD ?? 'supervisor';

let step = 0;
const ok = (msg: string) => console.log(`  ${++step}. ✓ ${msg}`);
const die = (msg: string): never => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

/** Sign exactly as Slack does: over the raw body bytes. */
function slackHeaders(body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': ts,
    'x-slack-signature':
      'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex'),
  };
}

const form = (payload: unknown) => 'payload=' + encodeURIComponent(JSON.stringify(payload));

async function main() {
  console.log(`\nSlack round trip against ${BASE}\n`);

  /* ---------------------------------------------------------- sign in */

  const auth = await fetch(`${BASE}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, device_id: 'slack-e2e' }),
  });
  if (!auth.ok) die(`could not sign in as ${USER} (${auth.status})`);
  const { access_token } = (await auth.json()) as { access_token: string };
  const bearer = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  ok('signed in as supervisor');

  /* ------------------------------------------------------- a job to use */

  const overview = await (await fetch(`${BASE}/v1/console/overview`, { headers: bearer })).json();
  const job = overview.jobs?.[0];
  if (!job) die('no jobs in the store');
  ok(`picked ${job.reference} — ${job.asset.name}`);

  /* ------------------------------------------------- the routing suggestion */

  const suggested = await (
    await fetch(`${BASE}/v1/console/slack/suggest`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({ job_id: job.id, assigned_to: 'NEA vector control', severity: 4 }),
    })
  ).json();
  // Asserted against the deployed table, not a fixture: this run is checking
  // that the channels FRCDE will really post to are the ones configured.
  if (suggested.suggestion?.channel !== '#nea') {
    die(`expected #nea, got ${suggested.suggestion?.channel}`);
  }
  if (suggested.suggestion.confidence !== 'high') die('a named party should be high confidence');
  if (!Array.isArray(suggested.channels) || suggested.channels.length === 0) {
    die('the override list came back empty');
  }
  ok(`suggested ${suggested.suggestion.channel} (${suggested.suggestion.confidence})`);

  /* ------------------------------------------------------- open the case */

  const created = await fetch(`${BASE}/v1/console/work-orders`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({
      job_id: job.id,
      detail: 'Blockage at the downstream end — approx 260 mm silt. Jetting required.',
      assigned_to: 'NEA vector control',
      severity: 4,
      slack_channel: suggested.suggestion.channel,
    }),
  });
  if (created.status !== 201) die(`work order not created (${created.status})`);
  const order = await created.json();
  if (!order.slack?.ts) die('the case was not opened in Slack');
  if (order.slack.channel !== '#nea') die('opened in the wrong channel');
  if (order.acknowledged_at !== null) die('a new case cannot already be acknowledged');
  ok(`case opened in ${order.slack.channel}`);

  /* ------------------------------------------------ reject forged requests */

  const body = form({
    type: 'block_actions',
    user: { username: 'contractor.lim' },
    actions: [{ action_id: 'case_ack', value: order.id }],
  });

  const forged = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=' + 'f'.repeat(64),
    },
    body,
  });
  if (forged.status !== 401) die(`an unsigned request was accepted (${forged.status})`);
  ok('a forged signature is refused with 401');

  const tampered = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(body),
    body: body + '&tampered=1',
  });
  if (tampered.status !== 401) die(`a tampered body was accepted (${tampered.status})`);
  ok('a tampered body is refused with 401');

  /* -------------------------------------------------------- acknowledge */

  const ack = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  if (!ack.ok) die(`a genuine signed request was refused (${ack.status})`);
  ok('a genuine signed request is accepted');

  const afterAck = await readOrder(order.id);
  if (!afterAck.acknowledged_at) die('acknowledgement was not recorded');
  if (afterAck.status !== 'in_progress') die(`status is ${afterAck.status}, expected in_progress`);
  ok('acknowledgement reached FRCDE, status is in progress');

  /* ------------------------------------------------- cannot complete */

  const blockedBody = form({
    type: 'view_submission',
    user: { username: 'contractor.lim' },
    view: {
      callback_id: 'case_blocked_submit',
      private_metadata: order.id,
      state: { values: { note: { value: { value: 'No access — gate locked, key with the TC.' } } } },
    },
  });
  const blocked = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(blockedBody),
    body: blockedBody,
  });
  if (!blocked.ok) die(`blocked submission refused (${blocked.status})`);

  const afterBlocked = await readOrder(order.id);
  if (afterBlocked.status !== 'blocked') die(`status is ${afterBlocked.status}, expected blocked`);
  if (!afterBlocked.blocked_reason?.includes('gate locked')) die('the reason was not kept');
  if (afterBlocked.closed_at !== null) die('a blocked case must not count as closed');
  ok('cannot-complete came back with its reason, and did not close the case');

  /* ------------------------------------------------------------ complete */

  const doneBody = form({
    type: 'view_submission',
    user: { username: 'contractor.lim' },
    view: {
      callback_id: 'case_done_submit',
      private_metadata: order.id,
      state: { values: { note: { value: { value: 'Jetted and cleared, 0.4 m3 carted away.' } } } },
    },
  });
  const done = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(doneBody),
    body: doneBody,
  });
  if (!done.ok) die(`completion refused (${done.status})`);

  const afterDone = await readOrder(order.id);
  if (afterDone.status !== 'done') die(`status is ${afterDone.status}, expected done`);
  if (!afterDone.closed_at) die('closed_at was not stamped');
  if (!afterDone.closing_note?.includes('0.4 m3')) die('the closing note was not kept');
  ok('completion closed the case, with its note');

  /* --------------------------------------------- a case that no longer exists */

  const orphanBody = form({
    type: 'block_actions',
    user: { username: 'contractor.lim' },
    actions: [{ action_id: 'case_ack', value: 'no-such-work-order' }],
  });
  const orphan = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(orphanBody),
    body: orphanBody,
  });
  // 200, not 404: buttons outlive the case, and Slack renders an error as a
  // scary red failure for something the contractor cannot fix.
  if (orphan.status !== 200) die(`a stale button gave ${orphan.status}, expected 200`);
  ok('a button on a deleted case answers politely rather than erroring');

  console.log('\n  All good.\n');
}

async function readOrder(id: string) {
  const auth = await fetch(`${BASE}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, device_id: 'slack-e2e' }),
  });
  const { access_token } = (await auth.json()) as { access_token: string };
  const res = await fetch(`${BASE}/v1/console/work-orders`, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  const { data } = (await res.json()) as { data: Record<string, any>[] };
  const found = data.find((w) => w.id === id);
  if (!found) die(`work order ${id} vanished`);
  return found;
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
