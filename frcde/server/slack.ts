/**
 * Slack integration.
 *
 * FRCDE opens a follow-up case in a Slack channel; the contractor acknowledges
 * and closes it there; the outcome comes back here. Slack is the doorbell and
 * the input surface — the case itself never stops living in FRCDE, because a
 * status derived from someone typing "done lah" in a channel cannot be queried,
 * chased or reported on.
 *
 * Unconfigured, every send is simulated and logged rather than skipped. The
 * console then behaves identically with and without a workspace, which is what
 * lets the whole flow be demonstrated — and what stops "it posted nothing" from
 * being indistinguishable from "it failed".
 *
 * Configure with:
 *   SLACK_BOT_TOKEN       xoxb-…   chat:write, files:read
 *   SLACK_SIGNING_SECRET  …        verifies inbound requests really are Slack's
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://slack.com/api';

export const botToken = () => process.env.SLACK_BOT_TOKEN ?? '';
export const signingSecret = () => process.env.SLACK_SIGNING_SECRET ?? '';

/** True when Slack can actually be reached. False means everything is simulated. */
export const isConfigured = () => botToken().length > 0 && signingSecret().length > 0;

/**
 * Slack rejects a request older than five minutes, and so do we.
 *
 * Without it a captured request stays valid for ever: its signature is correct,
 * so replaying it would let anyone close a case at any point in the future.
 */
const MAX_SKEW_S = 60 * 5;

/**
 * Verify that a request genuinely came from Slack.
 *
 * The interactions endpoint is public and unauthenticated by necessity — Slack
 * has no way to hold a session — so this signature is the *only* thing standing
 * between the internet and the ability to close work orders. It fails closed on
 * anything unexpected.
 *
 * @param raw The unparsed request body. Parsing and re-serialising it changes
 *   the bytes and the signature will never match.
 */
export function verifyRequest(
  raw: Buffer | string,
  timestamp: string | undefined,
  signature: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const secret = signingSecret();
  if (!secret || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > MAX_SKEW_S) return false;

  const body = typeof raw === 'string' ? raw : raw.toString('utf8');
  const expected =
    'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which would be a 500 rather
  // than a rejection — and the length is not a secret anyway.
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- outbound */

export interface CaseView {
  id: string;
  title: string;
  detail: string;
  assigned_to: string;
  severity: number;
  due_at: string | null;
  chainage_m: number | null;
  asset_name: string;
  reference: string;
  status: string;
  acknowledged_at?: string | null;
  closing_note?: string;
  blocked_reason?: string;
}

export interface PostedCase {
  channel: string;
  ts: string;
  simulated: boolean;
}

async function call<T>(method: string, payload: unknown): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${botToken()}`,
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!body.ok) throw new Error(`slack ${method}: ${body.error ?? res.status}`);
  return body;
}

const severityWord = (n: number) =>
  n >= 5 ? 'Critical' : n >= 4 ? 'High' : n >= 3 ? 'Moderate' : n >= 2 ? 'Low' : 'Minor';

const dueWord = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) : 'not set';

/**
 * The case as it appears in the channel.
 *
 * Written so someone can act without opening anything: what, where on the drain,
 * how urgent, by when. A card that only says "Work order 4f2a" forces a click
 * before the reader knows whether it is theirs.
 */
export function caseBlocks(c: CaseView): unknown[] {
  const closed = c.status === 'done' || c.status === 'cancelled';
  const blocked = c.status === 'blocked';

  const status = closed
    ? `:white_check_mark: *Closed* — ${c.closing_note || 'no note given'}`
    : blocked
      ? `:warning: *Cannot complete* — ${c.blocked_reason || 'no reason given'}`
      : c.acknowledged_at
        ? ':eyes: *Acknowledged* — awaiting completion'
        : ':bell: *Awaiting acknowledgement*';

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${c.asset_name} — follow-up`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Inspection*\n${c.reference}` },
        { type: 'mrkdwn', text: `*Routed to*\n${c.assigned_to}` },
        {
          type: 'mrkdwn',
          text: `*Location*\n${c.chainage_m == null ? 'along the drain' : `chainage ${Math.round(c.chainage_m)} m`}`,
        },
        { type: 'mrkdwn', text: `*Severity*\n${severityWord(c.severity)} (${c.severity}/5)` },
        { type: 'mrkdwn', text: `*Due*\n${dueWord(c.due_at)}` },
        { type: 'mrkdwn', text: `*Case*\n\`${c.id.slice(0, 8)}\`` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: c.detail.slice(0, 2900) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: status }] },
  ];

  if (!closed && !blocked) {
    blocks.push({
      type: 'actions',
      elements: [
        !c.acknowledged_at && {
          type: 'button',
          action_id: 'case_ack',
          value: c.id,
          text: { type: 'plain_text', text: 'Acknowledge' },
        },
        {
          type: 'button',
          action_id: 'case_done',
          value: c.id,
          style: 'primary',
          text: { type: 'plain_text', text: 'Completed' },
        },
        {
          type: 'button',
          action_id: 'case_blocked',
          value: c.id,
          style: 'danger',
          text: { type: 'plain_text', text: 'Cannot complete' },
        },
      ].filter(Boolean),
    });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Post photographs in this thread — they are filed against the case.',
        },
      ],
    });
  }

  return blocks;
}

export async function postCase(channel: string, c: CaseView): Promise<PostedCase> {
  const text = `Follow-up on ${c.asset_name}: ${c.title}`;
  if (!isConfigured()) {
    console.log(`[slack] (simulated) would post to ${channel}: ${text}`);
    return { channel, ts: `sim-${Date.now()}`, simulated: true };
  }
  const r = await call<{ channel: string; ts: string }>('chat.postMessage', {
    channel,
    text,
    blocks: caseBlocks(c),
  });
  return { channel: r.channel, ts: r.ts, simulated: false };
}

/** Repaint the original message so the channel shows the current state. */
export async function updateCase(channel: string, ts: string, c: CaseView): Promise<void> {
  if (!isConfigured() || ts.startsWith('sim-')) {
    console.log(`[slack] (simulated) would update ${channel}/${ts} → ${c.status}`);
    return;
  }
  await call('chat.update', {
    channel,
    ts,
    text: `Follow-up on ${c.asset_name}: ${c.title}`,
    blocks: caseBlocks(c),
  });
}

/** Reply in the case thread, so the audit trail stays where the contractor is. */
export async function replyInThread(channel: string, ts: string, text: string): Promise<void> {
  if (!isConfigured() || ts.startsWith('sim-')) {
    console.log(`[slack] (simulated) would reply in ${channel}/${ts}: ${text}`);
    return;
  }
  await call('chat.postMessage', { channel, thread_ts: ts, text });
}

/* --------------------------------------------------------------- modals */

/**
 * Ask for a note before closing.
 *
 * A one-click "Completed" produces a closed case nobody can audit. The modal is
 * one field, and it is the difference between a record and a rumour.
 */
export function closeModal(kind: 'done' | 'blocked', caseId: string): unknown {
  const done = kind === 'done';
  return {
    type: 'modal',
    callback_id: done ? 'case_done_submit' : 'case_blocked_submit',
    private_metadata: caseId,
    title: { type: 'plain_text', text: done ? 'Close the case' : 'Cannot complete' },
    submit: { type: 'plain_text', text: done ? 'Mark completed' : 'Send reason' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'note',
        label: {
          type: 'plain_text',
          text: done ? 'What was done?' : 'Why can it not be done?',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: done
              ? 'Jetted and silt removed, approx 0.4 m³ carted away.'
              : 'No access — gate locked, key held by the town council.',
          },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: done
              ? 'Photographs go in the case thread, not here.'
              : 'This reopens the case for the supervisor to look at.',
          },
        ],
      },
    ],
  };
}

export async function openModal(triggerId: string, view: unknown): Promise<void> {
  if (!isConfigured()) {
    console.log('[slack] (simulated) would open a modal');
    return;
  }
  await call('views.open', { trigger_id: triggerId, view });
}

/* ------------------------------------------------------------ inbound */

export interface Interaction {
  type: string;
  actionId?: string;
  caseId?: string;
  triggerId?: string;
  userName?: string;
  channel?: string;
  messageTs?: string;
  callbackId?: string;
  value?: string;
}

/**
 * Normalise an interaction payload.
 *
 * Slack posts these form-encoded with the JSON hidden in a `payload` field —
 * a shape worth flattening once here rather than at every use.
 */
export function parseInteraction(raw: string): Interaction | null {
  try {
    const encoded = new URLSearchParams(raw).get('payload');
    if (!encoded) return null;
    const p = JSON.parse(encoded) as Record<string, any>;

    if (p.type === 'view_submission') {
      const values = p.view?.state?.values ?? {};
      return {
        type: p.type,
        callbackId: p.view?.callback_id,
        caseId: p.view?.private_metadata,
        userName: p.user?.username ?? p.user?.name,
        value: values?.note?.value?.value ?? '',
      };
    }

    const action = Array.isArray(p.actions) ? p.actions[0] : undefined;
    return {
      type: p.type,
      actionId: action?.action_id,
      caseId: action?.value,
      triggerId: p.trigger_id,
      userName: p.user?.username ?? p.user?.name,
      channel: p.channel?.id,
      messageTs: p.message?.ts,
    };
  } catch {
    return null;
  }
}

/** Download a file a contractor posted in a case thread. */
export async function downloadFile(url: string): Promise<Buffer | null> {
  if (!isConfigured()) return null;
  const res = await fetch(url, { headers: { authorization: `Bearer ${botToken()}` } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
