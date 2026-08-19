# Slack follow-ups

Opening a follow-up case where the contractor already is, and getting the outcome
back.

Today an inspector finds a blockage, the supervisor routes it, and the actual
chasing happens over WhatsApp. FRCDE never hears what happened — a work order
reads `open` for six weeks on something cleared the same afternoon. The loop is
not merely unclosed; it is unobserved.

## What it does

```
FRCDE                                     Slack
  │
  │  supervisor routes a follow-up
  │  ──────────────────────────────────▶  case card posted in a channel
  │                                        Acknowledge · Completed · Cannot complete
  │
  │  ◀─────────────────────────────────── Acknowledge
  │     status → in_progress, acknowledged_at stamped
  │
  │  ◀─────────────────────────────────── Completed + note
  │     status → done, closing_note, closed_at
  │
  │  ◀─────────────────────────────────── Cannot complete + reason
  │     status → blocked, stays in the follow-up list
  │
  │  ◀─────────────────────────────────── photos posted in the case thread
  │     downloaded and filed against the work order
```

**The case never stops living in FRCDE.** Slack is a doorbell and an input
surface. A status derived from someone typing *done lah* in a channel cannot be
queried, chased, or reported on, and completion photographs left in Slack sit
under the workspace retention policy — 90 days on the free plan — when they are
evidence of works on public infrastructure.

## Choosing the channel

FRCDE proposes a channel and shows its reasoning; the supervisor can pick
differently. Rules are tried in order and the first match wins:

| | Matches on | Confidence |
|---|---|---|
| Party | `assigned_to` against the alias list | high |
| Zone | which zone centroid the drain sits nearest | medium |
| Default | nothing left to try | low |

Severity never changes the routing. Above the configured threshold it *adds* the
escalation channel as an alternative — a severe defect still goes to whoever does
the work, it just needs someone else to know.

The table is [`frcde/config/slack-routing.json`](../frcde/config/slack-routing.json),
deliberately config rather than code: the parties a drain gets routed to change
with contracts and reorganisations, and that should not need a deployment.

Two details in the matching are load-bearing. Aliases match whole words only, so
`pub` does not match "Republic Plaza" and `road` does not match "Broadway" —
either would post a case to a party with no idea it was coming. And the longest
matching alias wins, so a specific phrase is not beaten by a vague one.

The confidence is shown to the supervisor on purpose. A suggestion that cannot
say how sure it is invites people to accept all of them without reading.

## Setting it up

The order below is not arbitrary. Slack validates the events URL the moment you
paste it, so the secret has to be in place first, and the URL fields do not even
appear until Socket Mode is off.

At [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → *From
scratch*.

**1. Socket Mode → off.** It is on by default for new apps. While it is on, Slack
hides the Request URL fields entirely behind a note saying you will not need
them — which reads as "this step is unnecessary" rather than "you are in the
wrong mode". Socket Mode has the app hold a WebSocket open to Slack instead of
receiving HTTP callbacks: fine for a laptop, wrong for a free-tier service that
sleeps after fifteen minutes of quiet.

**2. OAuth & Permissions → Bot Token Scopes**

| Scope | For |
|---|---|
| `chat:write` | posting and updating the case card |
| `files:read` | pulling completion photos out of the thread |

Install to the workspace and copy the bot token (`xoxb-…`).

**3. Basic Information** → copy the **Signing Secret**.

**4. Render → your service → Environment**, add both, and save:

```
SLACK_BOT_TOKEN       xoxb-…
SLACK_SIGNING_SECRET  …
```

Wait for the redeploy to finish before going further.

**5. Interactivity & Shortcuts** → on → Request URL:

```
https://frcde.onrender.com/v1/slack/interactions
```

**6. Event Subscriptions** → on → Request URL:

```
https://frcde.onrender.com/v1/slack/events
```

Slack tests this one immediately by asking it to echo a challenge — and that
challenge is signed like every other request, which is why the secret had to be
set at step 4. Then subscribe to bot event `message.channels` (add
`message.groups` for private channels).

**7. Invite the bot to every channel** in the routing table: `/invite @FRCDE`. A
bot that is not in a channel cannot post to it, and the error is
`not_in_channel`, which reads like a permissions problem rather than a missing
invitation.

### When the events URL will not verify

Slack reports any non-200 as "your URL responded with an HTTP error", which says
nothing about the cause. Ask the endpoint directly:

```bash
curl -sS -X POST https://frcde.onrender.com/v1/slack/events -H 'content-type: application/json' -d '{}'
```

The `detail` distinguishes the two cases that matter: a server with no signing
secret configured, which no amount of retrying in Slack will fix, and a secret
that does not match the app. A `404` instead means the deploy predates this
integration.

## Without a workspace

Unconfigured, every outbound call is **simulated and logged** rather than
skipped. The console behaves identically, the work order records the channel it
would have gone to, and the server prints:

```
[slack] (simulated) would post to #fu-amk-town-council: Follow-up on Bayshore Canal…
```

This is what lets the whole flow be demonstrated with no Slack account at all. It
also means "it posted nothing" is never indistinguishable from "it failed".

Inbound verification needs only `SLACK_SIGNING_SECRET`, so setting that alone
gives you a server that accepts signed requests while still simulating its
replies — which is exactly what `npm run slack:e2e` exercises.

## Security

The interactions endpoint is **public**. Slack holds no session and cannot
present a token, so the request signature is the entire access control: it is the
only thing between the internet and the ability to close work orders.

- HMAC-SHA256 over `v0:{timestamp}:{raw body}`, compared in constant time.
- Requests older than five minutes are refused. Without that window a captured
  request stays valid for ever — its signature is correct, so replaying it would
  let anyone close a case at any future point.
- Every unexpected input fails closed: no secret, no headers, an unparseable
  timestamp, a signature of the wrong length.

**The raw body matters.** The signature is computed over the exact bytes Slack
sent, so `express.raw` is mounted on `/v1/slack` *before* the JSON parser. Any
middleware that parses and re-serialises the body invalidates every request Slack
will ever send, and the only symptom is a 401 that looks like a wrong secret.
`npm run slack:e2e` exists mainly to catch that, because no unit test can.

## Testing

```bash
npm test                                        # routing and signature units
SLACK_SIGNING_SECRET=test-secret npm start      # in one terminal
SLACK_SIGNING_SECRET=test-secret npm run slack:e2e
```

The round trip signs real payloads, and checks both that genuine ones are
accepted and that forged and tampered ones are refused.

## What this does not do

- **No contractor identity.** Anyone who can press the button in the channel can
  close the case, and FRCDE records the Slack username, not a verified person.
  That is the same trust model as the WhatsApp thread it replaces, but it is a
  trust model, not an authorisation check.
- **Photographs carry no location.** A photo posted in a thread has whatever EXIF
  it came with, which is usually none. It evidences that *something* was done,
  not that it was done here.
- **One channel per case, chosen once.** Rerouting a case to a different channel
  after it is opened means closing it and raising another.
- **Data residency.** Contractor personnel and infrastructure condition data
  would sit in a US-hosted service. WhatsApp is arguably worse on that count, but
  "we already do something questionable" is not a justification that survives
  review.
