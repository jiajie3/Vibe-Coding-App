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
 * Why an inbound request was refused, in words worth showing.
 *
 * Slack reports any non-200 as "your URL responded with an HTTP error", so the
 * detail we return is the only clue anyone gets while setting the app up. The
 * two causes need telling apart: a server with no secret configured can never
 * verify anything, and no amount of retrying in Slack will change that.
 *
 * This is said to an unauthenticated caller deliberately. It reveals only
 * whether an integration is configured, which is not a secret and not
 * exploitable — and withholding it costs an hour of guessing every time.
 */
export function rejectionReason(): string {
  return signingSecret().length === 0
    ? 'This server has no SLACK_SIGNING_SECRET configured, so it cannot verify ' +
        'that a request came from Slack. Set it on the service and try again.'
    : 'The signature did not match. Check that SLACK_SIGNING_SECRET is the ' +
        'signing secret of this same Slack app.';
}

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
  /** How many photographs have come back. Gates the Completed button. */
  completion_photos?: number;
  /**
   * Where to stand, as something tappable.
   *
   * "84 m along the drain" is exact and useless to a crew at a road junction.
   * The alignment and the distance are both known here, so the coordinates are
   * a projection away — and a map link is what actually gets them there.
   */
  map?: { url: string; label: string };
}

export interface PostedCase {
  channel: string;
  ts: string;
  simulated: boolean;
  /** As the supervisor asked for it, `#nea`, for showing in the console. */
  name?: string;
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


/**
 * The case as it appears in the channel.
 *
 * Written so someone can act without opening anything: what, where on the drain,
 * how urgent, by when. A card that only says "Work order 4f2a" forces a click
 * before the reader knows whether it is theirs.
 */
export function caseBlocks(c: CaseView): unknown[] {
  const closed = c.status === 'done' || c.status === 'cancelled';
  const photos = c.completion_photos ?? 0;

  const status = closed
    ? `:white_check_mark: *Closed* — ${c.closing_note || 'no note given'}`
    : c.acknowledged_at
          ? photos > 0
            ? `:camera: *Acknowledged* — ${photos} photo${photos === 1 ? '' : 's'} received, ready to close`
            : ':eyes: *Acknowledged* — post a photograph in this thread when the work is done'
          : ':bell: *Awaiting acknowledgement*';

  /**
   * The finding, and nothing else.
   *
   * The card used to open with a grid of the inspection reference, who it was
   * routed to, the distance along the drain and a case id. A contractor reading
   * a channel needs to know what to fix and where — the distance is in the
   * description already, the channel is who it went to, and the reference and
   * case id are our filing, not theirs.
   */
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${c.asset_name} — follow-up`, emoji: true },
    },
  ];

  // Directly under the heading, before the detail: where it is comes before
  // what is wrong with it, because that is the order someone reads a case in.
  if (c.map) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:round_pushpin: <${c.map.url}|${c.map.label}>` }],
    });
  }

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c.detail.slice(0, 2900) } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: status }] });

  if (!closed) {
    /**
     * Acknowledge first, and only then the two ways of finishing.
     *
     * Offering all three at once let a case be closed by someone who never said
     * they had picked it up, which loses the one measurement that shows whether
     * routing works at all: how long a case sits before anybody looks. It also
     * made "acknowledged" meaningless — a status no one had to pass through.
     *
     * The buttons are withheld rather than disabled because Slack has no
     * disabled state for them; a greyed-out look is not available, so the honest
     * option is to not show a control that would be refused.
     */
    blocks.push(
      c.acknowledged_at
        ? {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'case_done',
                value: c.id,
                style: 'primary',
                text: {
                  type: 'plain_text',
                  text: photos > 0 ? 'Completed' : 'Completed (photo needed)',
                },
              },
            ],
          }
        : {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'case_ack',
                value: c.id,
                style: 'primary',
                text: { type: 'plain_text', text: 'Acknowledge' },
              },
            ],
          },
    );
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: c.acknowledged_at
            ? photos > 0
              ? 'Photographs are filed against the case. Post more here if needed.'
              : 'Post a photograph of the completed work in this thread — it is required before the case can be closed, and is filed against the record.'
            : 'Acknowledge to pick this up. The options to close it appear after that.',
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
    return { channel, name: channel, ts: `sim-${Date.now()}`, simulated: true };
  }
  const r = await call<{ channel: string; ts: string }>('chat.postMessage', {
    channel,
    text,
    blocks: caseBlocks(c),
    // No preview card. Slack expands any link it recognises, and a map link
    // turns into a "google.com — find local businesses" advertisement below the
    // case, taller than the case itself. The coordinates are already the link.
    unfurl_links: false,
    unfurl_media: false,
  });
  // Both: the id is what every later API call needs, and the name is the only
  // one of the two worth showing anybody. Slack answers with the id alone, so
  // the name has to be carried over from what was asked for.
  return { channel: r.channel, name: channel, ts: r.ts, simulated: false };
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

/**
 * Put the inspection's photographs in the case thread.
 *
 * The bytes are uploaded to Slack rather than linked. Linking was tried first
 * and does not work here: Slack fetches an `image_url` itself, and the file it
 * would fetch lives on Render's disk, which is wiped on every deploy. A URL
 * that resolves today is a 404 next week, and the failure is invisible —
 * Slack simply renders nothing.
 *
 * Uploading also stops inspection photographs being readable by anyone holding
 * the URL, which linking required.
 *
 * Three calls, which is Slack's own flow: ask where to put it, put it there,
 * then say which channel and thread it belongs to.
 */
export async function postThreadImages(
  channel: string,
  ts: string,
  images: { bytes: Buffer; filename: string; caption: string }[],
  heading: string,
): Promise<void> {
  if (images.length === 0) return;
  if (!isConfigured() || ts.startsWith('sim-')) {
    // The heading too, not just the count. It carries the coordinates of every
    // photograph, and a demo run with no workspace attached is the only chance
    // to see what would have been posted.
    console.log(
      `[slack] (simulated) would upload ${images.length} photo(s) to ${channel}/${ts}\n` +
        heading.replace(/^/gm, '  | '),
    );
    return;
  }

  const uploaded: { id: string; title: string }[] = [];
  for (const img of images.slice(0, 8)) {
    // 1. Where to put it. Form-encoded, not JSON — this endpoint predates the
    //    rest and rejects a JSON body.
    const q = new URLSearchParams({
      filename: img.filename,
      length: String(img.bytes.length),
    });
    const slot = await fetch(`${API}/files.getUploadURLExternal?${q}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${botToken()}` },
    }).then((r) => r.json() as Promise<{ ok: boolean; error?: string; upload_url?: string; file_id?: string }>);
    if (!slot.ok || !slot.upload_url || !slot.file_id) {
      throw new Error(`slack files.getUploadURLExternal: ${slot.error ?? 'no upload url'}`);
    }

    // 2. The bytes themselves, to the one-off URL. No bearer token here.
    const put = await fetch(slot.upload_url, { method: 'POST', body: new Uint8Array(img.bytes) });
    if (!put.ok) throw new Error(`slack upload failed: ${put.status}`);

    uploaded.push({ id: slot.file_id, title: img.caption.slice(0, 150) || 'Inspection photograph' });
  }

  // 3. Where it belongs. Sharing every file in one call keeps them together in
  //    the thread rather than arriving as separate messages.
  await call('files.completeUploadExternal', {
    files: uploaded,
    channel_id: channel,
    thread_ts: ts,
    initial_comment: heading,
  });
}

/** Reply in the case thread, so the audit trail stays where the contractor is. */
export async function replyInThread(channel: string, ts: string, text: string): Promise<void> {
  if (!isConfigured() || ts.startsWith('sim-')) {
    console.log(`[slack] (simulated) would reply in ${channel}/${ts}: ${text}`);
    return;
  }
  await call('chat.postMessage', {
    channel,
    thread_ts: ts,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
}

/* --------------------------------------------------------------- modals */

/**
 * Ask for a note before closing.
 *
 * A one-click "Completed" produces a closed case nobody can audit. The modal is
 * one field, and it is the difference between a record and a rumour.
 */
export function closeModal(caseId: string): unknown {
  return {
    type: 'modal',
    callback_id: 'case_done_submit',
    private_metadata: caseId,
    title: { type: 'plain_text', text: 'Close the case' },
    submit: { type: 'plain_text', text: 'Mark completed' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'note',
        label: { type: 'plain_text', text: 'What was done?' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Photographs go in the case thread, not here.' },
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

/**
 * Our own bot's user id, so we can recognise our own messages.
 *
 * `event.bot_id` is not enough. A file shared through
 * `files.completeUploadExternal` is posted *as the bot user*, and that message
 * carries no `bot_id` at all — so the photographs we send with a case come
 * straight back in as photographs the contractor returned, and appear twice.
 *
 * `auth.test` needs no scope beyond the token itself. Cached because the answer
 * cannot change without the token changing.
 */
let botUserId: string | null | undefined;

/**
 * A Slack user id turned into the name their colleagues see.
 *
 * Needs `users:read`. Without it the lookup fails and the caller falls back to
 * something generic — a missing scope should cost a name, not a message.
 */
const names = new Map<string, string>();

/**
 * Why the last name lookup failed, if it did.
 *
 * Kept so the console can say *why* a message reads "Slack member" instead of
 * a person. `missing_scope` is a two-minute fix in the Slack app, and silence
 * about it has now cost several rounds of guessing.
 */
let lastNameError: string | null = null;
export const nameLookupError = (): string | null => lastNameError;

/**
 * A name Slack has already given us, without asking again.
 *
 * Synchronous on purpose: the console serialises stored messages on every poll,
 * and a name learned today should correct the ones stored yesterday rather than
 * leaving them frozen at whatever was known when they arrived.
 */
export function cachedName(id?: string | null): string | null {
  return (id && names.get(id)) || null;
}

/**
 * Remember a name Slack handed us for free.
 *
 * Interaction payloads carry `user.username` with no scope required, so the
 * moment somebody presses Acknowledged or Completed we know who they are — and
 * that is almost always the same person who has been typing in the thread.
 */
export function remember(id?: string | null, name?: string | null): void {
  const n = (name ?? '').trim();
  if (id && n) names.set(id, n);
}

/**
 * Take the name straight off the event when Slack included one.
 *
 * Message events often carry `user_profile`, which costs no API call and needs
 * no scope at all. `users.info` exists here only for when they do not.
 */
export function learnFromEvent(event: Record<string, any>): string | null {
  const id = String(event?.user ?? '');
  const p = event?.user_profile ?? {};
  const n = String(p.display_name || p.real_name || p.name || '').trim();
  if (!id || !n) return null;
  names.set(id, n);
  return n;
}

interface UserInfo {
  ok: boolean;
  error?: string;
  user?: { profile?: { display_name?: string; real_name?: string }; name?: string };
}

/**
 * `users.info`, as its own function so the diagnostic can report what it said.
 *
 * GET with query parameters, not a JSON body. It is one of the older
 * form-encoded methods and answers `invalid_arguments` to JSON, which looks
 * exactly like a missing scope from the outside and is not.
 */
async function lookup(id: string): Promise<{ res: UserInfo | null; scopes: string | null }> {
  const r = await fetch(`${API}/users.info?${new URLSearchParams({ user: id })}`, {
    headers: { authorization: `Bearer ${botToken()}` },
  }).catch(() => null);
  if (!r) return { res: null, scopes: null };
  const res = (await r.json().catch(() => null)) as UserInfo | null;
  return { res, scopes: r.headers.get('x-oauth-scopes') };
}

/**
 * What the bot can and cannot see, in one answer.
 *
 * Names falling back to the organisation has now been diagnosed twice by
 * reasoning about it, both times wrongly. The token's granted scopes come back
 * in a response header, so the question "does this app have `users:read`" has a
 * factual answer — this endpoint fetches it instead of guessing.
 */
export async function diagnose(probe?: string): Promise<Record<string, unknown>> {
  if (!isConfigured()) return { configured: false };

  const r = await fetch(`${API}/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken()}` },
  }).catch(() => null);
  const auth = ((await r?.json().catch(() => null)) ?? {}) as Record<string, any>;
  const scopes = (r?.headers.get('x-oauth-scopes') ?? '').split(',').filter(Boolean);

  const id = probe || String(auth.user_id ?? '');
  const { res, scopes: viaLookup } = id ? await lookup(id) : { res: null, scopes: null };
  const granted = scopes.length ? scopes : (viaLookup ?? '').split(',').filter(Boolean);

  return {
    configured: true,
    bot_ok: auth.ok === true,
    bot_error: auth.error ?? null,
    workspace: auth.team ?? null,
    scopes: granted,
    has_users_read: granted.includes('users:read'),
    probe: {
      user: id || null,
      ok: res?.ok === true,
      error: res?.error ?? null,
      name:
        res?.user?.profile?.display_name?.trim() ||
        res?.user?.profile?.real_name?.trim() ||
        res?.user?.name?.trim() ||
        null,
    },
  };
}

export async function userName(id: string): Promise<string | null> {
  if (!id || !isConfigured()) return null;
  const cached = names.get(id);
  if (cached) return cached;

  const { res } = await lookup(id);

  lastNameError = res?.ok ? null : (res?.error ?? 'request failed');

  if (!res?.ok) {
    // Said once per name rather than swallowed: `missing_scope` here is a
    // one-line fix in the Slack app, and invisible otherwise — the console just
    // keeps showing the organisation instead of the person.
    console.warn(
      `[slack] could not resolve ${id}: ${res?.error ?? 'request failed'}` +
        ` — check /v1/console/slack/check`,
    );
    return null;
  }

  const n =
    res.user?.profile?.display_name?.trim() ||
    res.user?.profile?.real_name?.trim() ||
    res.user?.name?.trim() ||
    null;
  if (n) names.set(id, n);
  return n;
}

export async function selfUserId(): Promise<string | null> {
  if (botUserId !== undefined) return botUserId;
  if (!isConfigured()) return (botUserId = null);
  try {
    const r = await call<{ user_id?: string }>('auth.test', {});
    botUserId = r.user_id ?? null;
  } catch {
    botUserId = null;
  }
  return botUserId;
}

/* ------------------------------------------------------------ inbound */

export interface Interaction {
  type: string;
  actionId?: string;
  caseId?: string;
  triggerId?: string;
  /** Where to send a message only this user sees, in reply to their click. */
  responseUrl?: string;
  userName?: string;
  /** Their Slack id, so the name on this payload can be reused elsewhere. */
  userId?: string;
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
      userId: p.user?.id,
        value: values?.note?.value?.value ?? '',
      };
    }

    const action = Array.isArray(p.actions) ? p.actions[0] : undefined;
    return {
      type: p.type,
      actionId: action?.action_id,
      caseId: action?.value,
      triggerId: p.trigger_id,
      responseUrl: p.response_url,
      userName: p.user?.username ?? p.user?.name,
      userId: p.user?.id,
      channel: p.channel?.id,
      messageTs: p.message?.ts,
    };
  } catch {
    return null;
  }
}

/**
 * Say something only the person who clicked will see.
 *
 * A refusal has to reach them somehow, and the alternatives are both wrong:
 * editing the card shouts at the channel, and staying silent reads as the
 * button being broken. `response_url` needs no token and works for 30 minutes.
 */
export async function respondEphemeral(url: string | undefined, text: string): Promise<void> {
  if (!url) return;
  if (!isConfigured()) {
    console.log(`[slack] (simulated) would reply privately: ${text}`);
    return;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
  });
}

/**
 * A stand-in image, used only when no workspace is configured.
 *
 * The rest of this module simulates rather than skips, and the completion path
 * has to as well: without a photograph the case can never be completed, so
 * returning nothing here would make the whole flow undemonstrable and
 * untestable without a live Slack app. A 1×1 JPEG is a real image file, and the
 * caption filed alongside says plainly that it is not a real photograph.
 */
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z',
  'base64',
);

/** Download a file a contractor posted in a case thread. */
export async function downloadFile(url: string): Promise<Buffer | null> {
  if (!isConfigured()) {
    console.log('[slack] (simulated) would download', url);
    return PLACEHOLDER_JPEG;
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${botToken()}` } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
