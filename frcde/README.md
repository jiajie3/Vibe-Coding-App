# FRCDE — drain inspection console

Scheduling, tracking and review for drain inspections. React + Vite console, Express API,
JSON store. Runs on your machine with no build step and no database, and deploys to
Render as a single service serving both halves, per
[docs/deploying.md](../docs/deploying.md).

Two integrations are optional and off by default. Without their keys the console behaves
identically — Slack posts are logged rather than sent, and inspections get the rule
checks without the model. See [docs/slack.md](../docs/slack.md) and
[docs/ai-review.md](../docs/ai-review.md).

## Run it

```bash
npm run dev     # API on :4000, console on :5173
```

Open <http://localhost:5173> and sign in as **`supervisor` / `supervisor`**. Both bind
`0.0.0.0`, so CFPI on your phone reaches the API at `http://192.168.0.3:4000` (whatever
the server prints on startup) over the same Wi-Fi.

The console is supervisor-only, enforced by the server rather than the UI: an inspector's
token is refused with **403, not 401**, so CFPI's outbox dead-letters it instead of
retrying for ever. Passwords are scrypt hashes with a per-user salt; tokens are opaque
random strings rather than signed JWTs — see the root README for what that deliberately
does not pretend to be.

**On Windows, if `npm` or `npx` fails with "cannot be loaded … not digitally signed",**
call the `.cmd` shim instead — `npm.cmd run dev` — or lift the policy for your own
account once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. PowerShell
refuses the unsigned `.ps1` wrappers npm installs; the `.cmd` ones are not scripts and
are unaffected.

```bash
npm run e2e         # full contract round-trip against a running server
npm run typecheck
npm run build
```

If your phone can't reach the API, your Wi-Fi is probably classified `Public` — Windows
Firewall blocks inbound there. Fix with `Set-ExecutionPolicy`-style elevation:
`Set-NetConnectionProfile -Name "<your wifi>" -NetworkCategory Private`.

## Layout

```
server/
  index.ts     Contract endpoints + console endpoints
  store.ts     JSON persistence, seeded from contracts/examples/seed-jobs.json
  auth.ts      Tokens, sessions, role guards
  password.ts  scrypt hashing
  slack.ts     Follow-up cases: posting, signature verification, thread replies
  routing.ts   Which channel a follow-up opens in, and why
  ai.ts        The automatic first pass — rule checks, then the model
config/
  slack-routing.json   Channel table. Deployment data, edited without a release.
scripts/
  e2e.ts       Accept → start → walk → complete → review, over HTTP
  slack-e2e.ts The Slack case round trip, signatures included
src/
  api.ts               Typed client, shares CFPI's contract types
  components/DrainMap  MapLibre wrapper (no API key needed)
  components/AutoReview  The first-pass panel
  pages/Dashboard      Network map, KPIs, job queue
  pages/JobDetail      Review: coverage overlay, GPS track, checklist, photos
  pages/WorkOrders     Follow-ups, including ones awaiting a photo check
data/
  db.json      The store. Delete it, or POST /v1/console/reset, to reseed.
  uploads/     Photo bytes
```

## What CFPI is sent

FRCDE holds the whole asset register — all 40 drains stay on the console map — but
`GET /v1/jobs` only dispatches jobs an inspector can act on (`available`, `accepted`,
`in_progress`). A drain that is approved, awaiting review, cancelled or expired never
reaches a handset.

Filtering here rather than in the app means the app cannot get it wrong, and it is what
makes the lifecycle work:

```
submit   → job leaves CFPI
reject   → job returns to CFPI, carrying the reviewer's reason
approve  → gone for good; both attempts kept for audit
```

`npm run e2e` asserts all three.

Which drains are due is set by `DISPATCH_PLAN` in `server/store.ts` — five by default,
spread across priorities with one already overdue. Add or remove entries to change it.

Queuing a drain by hand does **not** reschedule it. The queue is who has been sent
out; the due date is when the drain needs walking, and the two are separate. Pushing
a drain due in three weeks into the queue leaves it due in three weeks. Pass
`due_in_days` to the dispatch endpoint to set a deadline deliberately.

How loudly it reads is a separate question, and the answer is in `emphasis()` in
`src/api.ts`: **being in the queue is itself the signal.** A supervisor who put a
drain there wants it walked, so it colours as due soon whatever its date says, and
escalates to overdue only when it genuinely is. The date stays the record of when it
is owed rather than a decision about whether it needs doing. Drains not in the queue
stay quiet regardless — a closed drain rendering as "overdue by 3d" alarms about
work nobody is expected to do.

Every request is logged with its status, so a failing call from the phone is visible in
the terminal rather than having to be guessed at.

## Two decisions worth knowing

### The coverage engine is imported from CFPI, not reimplemented

`server/index.ts` imports `CoverageTracker` straight from `../../cfpi/src/core/`. The app
and the server therefore cannot disagree about what "covered" means — there is one
implementation and one set of tests.

This is what makes contract §1.4 real: CFPI's percentage drives its own live map, but on
submission the server **recomputes coverage from the raw GPS points** and its figure is
what governs. `npm run e2e` proves it — the client claims 100%, the server computes 93.5%
from the track, and the result is flagged `coverage_mismatch`.

### FRCDE stores a heartbeat, not the in-progress inspection

While an inspection is under way, the authoritative state — every covered segment, the
walked path, draft checklist answers, photos — lives **on the handset**. FRCDE receives
only:

```json
{ "inspection_id": "...", "status": "paused", "coverage_pct": 47, "updated_at": "..." }
```

Because an inspector must be able to pause at a locked gate with no signal and resume
three days later, still with no signal. If resuming needed a round trip to this server,
offline-first would collapse at the exact moment it matters. Streaming full state would
also cost battery and data to keep a server informed of something nobody is watching.

The heartbeat is what lets a supervisor see *"Bedok Drain — 47%, paused 3 days ago"* and
chase it. It is sent best-effort: a failed heartbeat must never block an inspector.

**Trade-off:** lose the phone and the partial inspection is lost. If that ever becomes
unacceptable, the answer is a periodic full-state backup on Wi-Fi — not moving the source
of truth to the server.

## Scheduling runs itself

A drain's next inspection is set from its cycle when the last one is approved — 30
days, because every drain is walked monthly. The intervals used to vary by asset type
on the reasoning that bigger drains deserve more attention; plausible, and not what
happens, and a schedule that quietly differs from the one being worked to is worse than
none. It is still a lookup (`INSPECTION_CYCLE_DAYS` in `server/store.ts`), because a
real maintenance policy does vary by asset and that is the seam where it arrives.

An hourly sweep, plus one on startup, queues anything that has come due, so a server
left off over a weekend catches up by itself.

There is deliberately **no "run scheduler" button**. A supervisor should be able to see
the automation working, not be asked to trigger it — the queue panel shows when it last
ran and what it did. `POST /v1/console/schedule/run` still exists for tests and for the
rare "policy just changed, sweep now" case.

## Work orders

Raised from a submitted inspection and pre-filled from what it found — a blockage with
260 mm of silt proposes clearing it, at the chainage of the first photograph.

A drain with an open case reads **Awaiting follow-ups**, not Awaiting review, and is
counted on its own card. Nothing a supervisor does moves it while a contractor holds
it, so leaving it in the review queue made the number they check every morning wrong
in the direction that causes chasing. When the case closes it becomes their turn again
and the label goes back on its own. Both are still `submitted` on the server — this is
a console distinction, because the two mean different things to the person reading
them and nothing to the state machine.

An inspection that finds a defect and produces nothing but a record is how inspectors
learn their findings do not matter. So a follow-up is a case with a party on the other
end of it:

```
open → in progress → done
                  ↘ cannot complete (stays in the live list)
```

Opened in a Slack channel chosen by the routing table, with the inspection's own
photographs in the thread. The contractor acknowledges before anything else is offered,
and cannot close it without posting a photograph — which comes back and is filed against
the work order. Pressing Completed closes the case.

There was a supervisor confirmation between those two, which was removed: it put a queue
of approvals in front of someone for work they had already delegated, and the photograph
arrives and is filed either way. The console shows each case as a trail — raised,
acknowledged, completed — so where one is stuck is visible without opening Slack.

Without a workspace configured all of that is logged rather than posted, and the console
is unchanged. [docs/slack.md](../docs/slack.md).

## Not built yet

- Contractor identity: anyone who can press the button in the channel can close a
  case, and what is recorded is a Slack username
- Assigning specific inspectors; everyone sees the same queue
- Delta sync (`/v1/sync/changes`) — CFPI re-fetches the full job list each time
- Reporting and export, an audit trail, bulk scheduling
- Map tiles come from OSM's public servers; fine for one machine, needs a proper
  tile provider for a team
