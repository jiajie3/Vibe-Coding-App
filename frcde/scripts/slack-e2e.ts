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
 * One thing this cannot reach: photographs arriving from a thread. That path
 * needs a real workspace to download from, so the run checks the *gate* — that
 * completion is refused without evidence — and the ingestion itself is only
 * exercised against a live Slack app.
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
/**
 * Annotated on the binding, not only on the arrow.
 *
 * TypeScript narrows control flow through a `never`-returning function only when
 * the *variable* carries the type. Without it every `if (!x) die(...)` fails to
 * prove `x` afterwards, and the file fills with phantom "possibly undefined".
 */
const die: (msg: string) => never = (msg) => {
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

  // No officer, no severity, no due date — the console asks for none of them.
  // The channel is the party, and the stored name comes from the routing table.
  const created = await fetch(`${BASE}/v1/console/work-orders`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({
      job_id: job.id,
      detail: 'Blockage at the downstream end — approx 260 mm silt. Jetting required.',
      slack_channel: '#nea',
    }),
  });
  if (created.status !== 201) die(`work order not created (${created.status})`);
  const order = await created.json();
  if (!order.slack?.ts) die('the case was not opened in Slack');
  if (order.slack.channel !== '#nea') die('opened in the wrong channel');
  if (order.assigned_to !== 'NEA') {
    die(`assigned_to should come from the channel, got "${order.assigned_to}"`);
  }
  if (order.due_at !== null) die('a due date was invented');
  if (order.acknowledged_at !== null) die('a new case cannot already be acknowledged');
  ok(`case opened in ${order.slack.channel}, recorded as "${order.assigned_to}"`);

  /* -------------------------------- closing before acknowledging is refused */

  // A card posted before the case was picked up still carries whatever buttons
  // it was rendered with, so withholding them in the UI is not enough.
  const earlyClose = form({
    type: 'view_submission',
    user: { username: 'contractor.lim' },
    view: {
      callback_id: 'case_done_submit',
      private_metadata: order.id,
      state: { values: { note: { value: { value: 'Sneaking this one closed.' } } } },
    },
  });
  const early = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(earlyClose),
    body: earlyClose,
  });
  const earlyBody = await early.json();
  if (earlyBody?.response_action !== 'errors') {
    die('closing an unacknowledged case was allowed');
  }
  const stillOpen = await readOrder(order.id);
  if (stillOpen.status !== 'open') die(`status became ${stillOpen.status} without acknowledgement`);
  ok('closing before acknowledging is refused, and the case stays open');

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

  /* -------------------------------- completing without evidence is refused */

  const noPhoto = form({
    type: 'block_actions',
    user: { username: 'contractor.lim' },
    actions: [{ action_id: 'case_done', value: order.id }],
  });
  const refused = await fetch(`${BASE}/v1/slack/interactions`, {
    method: 'POST',
    headers: slackHeaders(noPhoto),
    body: noPhoto,
  });
  if (!refused.ok) die(`the refusal should still answer 200 (${refused.status})`);
  const stillWorking = await readOrder(order.id);
  if (stillWorking.status !== 'in_progress') {
    die(`status became ${stillWorking.status} with no photograph`);
  }
  ok('completing with no photograph is refused, and the case stays in progress');

  /* ------------------------------------- a photograph arrives in the thread */

  const event = JSON.stringify({
    type: 'event_callback',
    event: {
      type: 'message',
      ts: String(Date.now() / 1000),
      thread_ts: order.slack.ts,
      user: 'U123',
      files: [{ id: 'F1', title: 'Cleared', url_private_download: 'https://files.slack.test/F1' }],
    },
  });
  const filed = await fetch(`${BASE}/v1/slack/events`, {
    method: 'POST',
    headers: { ...slackHeaders(event), 'content-type': 'application/json' },
    body: event,
  });
  if (!filed.ok) die(`the events endpoint refused a signed event (${filed.status})`);

  // Filing happens after the 200 — Slack allows three seconds and we do not
  // spend them on a download.
  await new Promise((r) => setTimeout(r, 300));
  const withPhoto = await readOrder(order.id);
  if ((withPhoto.completion_attachment_ids?.length ?? 0) === 0) {
    die('a photograph posted in the case thread was not filed against the case');
  }
  // And it lives in the message that carried it, not in a gallery of its own —
  // which is what made the same photograph look like two.
  const carried = (withPhoto.thread ?? []).find((m: any) => (m.photos ?? []).length > 0);
  if (!carried) die('the photograph was not attached to its own message');
  ok('a photograph in the thread is filed against the message that carried it');

  /* ------------------------------------- what is said in the thread comes back */

  const chat = JSON.stringify({
    type: 'event_callback',
    event: {
      type: 'message',
      ts: String(Date.now() / 1000),
      thread_ts: order.slack.ts,
      user: 'U123',
      text: 'Gate key is with the town council — we will be there Thursday.',
    },
  });
  const said = await fetch(`${BASE}/v1/slack/events`, {
    method: 'POST',
    headers: { ...slackHeaders(chat), 'content-type': 'application/json' },
    body: chat,
  });
  if (!said.ok) die(`the events endpoint refused a signed message (${said.status})`);
  await new Promise((r) => setTimeout(r, 200));

  const withThread = await readOrder(order.id);
  const theirs = (withThread.thread ?? []).filter((m: any) => m.from === 'them');
  if (theirs.length === 0) die('a message in the case thread was not kept');
  // By content, not by position: a photograph posted earlier is also a message
  // from them, and carries no text of its own.
  const chatted = theirs.find((m: any) => m.text.includes('town council'));
  if (!chatted) die('the message text was lost');
  if (!chatted.who) die('the message has no author');
  // Our own replies belong to the thread too, and we know them without waiting
  // for Slack to tell us about them.
  if (!(withThread.thread ?? []).some((m: any) => m.from === 'us')) {
    die('our own replies are missing from the thread');
  }
  ok('the Slack conversation reaches FRCDE, both sides of it');

  // Slack can deliver the same event twice — a retry, or two subscriptions that
  // both match. A contractor's photograph arriving twice showed up on the case
  // twice, so nothing is filed twice regardless of why it arrives again.
  const photosBefore = (withThread.completion_attachment_ids ?? []).length;
  const messagesBefore = (withThread.thread ?? []).length;
  for (const dupe of [chat, event]) {
    await fetch(`${BASE}/v1/slack/events`, {
      method: 'POST',
      headers: { ...slackHeaders(dupe), 'content-type': 'application/json' },
      body: dupe,
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  const afterDupes = await readOrder(order.id);
  if ((afterDupes.completion_attachment_ids ?? []).length !== photosBefore) {
    die(
      `a redelivered photograph was filed again: ${photosBefore} -> ${
        (afterDupes.completion_attachment_ids ?? []).length
      }`,
    );
  }
  if ((afterDupes.thread ?? []).length !== messagesBefore) {
    die('a redelivered message was appended again');
  }
  ok('the same event delivered twice is filed once');

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
  // Completed in Slack closes the case outright. There used to be a supervisor
  // confirmation in between; it queued work in front of someone who had already
  // delegated it, and the photograph is filed against the record either way.
  if (afterDone.status !== 'done') die(`status is ${afterDone.status}, expected done`);
  if (!afterDone.closed_at) die('closed_at was not stamped');
  if (!afterDone.closing_note?.includes('0.4 m3')) die('the closing note was not kept');
  ok('completing in Slack closes the case, with its note');

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
