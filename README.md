# Drain inspection, end to end

A working demonstration of how a drain inspection could run in Singapore, from the
moment one falls due to the moment a contractor closes off the repair.

There are three things to open, and they are connected. Something you do in one shows
up in the others.

| | What it is | Where |
|---|---|---|
| **FRCDE** | The office console. Decides which drains are due, dispatches them, reviews what comes back. | A website |
| **CFPI** | The field app. An inspector walks the drain while GPS checks they covered it. | Your phone |
| **Slack** | Where a repair gets handed to whoever fixes it. | Slack |

> **All usernames and passwords are in the submission document**, not in this file.
> Keep it open alongside — you will need three sets: one for the console, one for
> Expo Go, one for Slack.

---

## 1. FRCDE — the console

**<https://frcde.onrender.com>**

Open it and sign in with the **console** credentials from the submission.

> ⏳ **The first page may take up to a minute.** The server sleeps when nobody has
> used it for a while and has to wake up. It is only slow once — after that it is
> immediate. If the page looks stuck, give it sixty seconds before reloading.

What you are looking at: every drain in the register, on a map and in a list, with the
ones falling due pushed to the top. The counters along the top are the day's work —
how many are overdue, how many are waiting for someone to look at them.

Two pages, from the bar at the top: **Inspection Dashboard** (the drains) and
**Inspection Follow-ups** (repairs handed to someone else).

Have a click around. Nothing here is fragile — there is a **Reset** button beside the
sort box if you would like to put everything back as it was.

---

## 2. CFPI — the field app

Works on **iPhone and Android**. It runs inside a free app called Expo Go, so there is
nothing to install from an app store beyond that.

### Step 1 — Install Expo Go

Search for **Expo Go** in the App Store or Google Play and install it.

### Step 2 — Sign in to Expo Go

Open Expo Go and sign in with the **Expo account** from the submission.

> ⚠️ **This step is not optional.** The demo is shared privately with that account.
> If you skip it, the next step appears to do nothing at all.

### Step 3 — Open the app

<img src="docs/expo-go-qr.png" width="240" alt="QR code to open CFPI in Expo Go">

- **iPhone** — point your normal **Camera** app at the code and tap the banner that
  appears. (Expo Go on iPhone has no scanner of its own.)
- **Android** — open **Expo Go**, tap **Scan QR code**, and point it at the code.

Either way, it opens in Expo Go. It takes a few seconds to download the first time.

*Alternative:* once you are signed in, the project also appears under **Projects** on
the Expo Go home screen — you can tap it there instead of scanning.

### Step 4 — Sign in to the app

Use the **inspector** credentials from the submission. The server address is already
filled in for you.

You should land on a list of drains waiting to be walked.

---

## 3. Slack — where repairs get handed over

Sign in to Slack with the credentials from the submission, and look at these two
channels:

- **#nea** — cases routed to the National Environment Agency
- **#lta** — cases routed to the Land Transport Authority

This is where a problem found in the field lands as a job for someone else, with the
photographs and a map pin to the exact spot. Anything you or a colleague do in the
channel comes straight back to the console.

---

## See the whole thing in ten minutes

Do these in order and every part of the system will have done its job.

### In the app, walk a drain

1. Tap any drain in the list.
2. Tap **Simulate**. This starts the inspection and walks the drain for you, so you
   can see the whole flow without leaving your chair — watch the coverage percentage
   climb as the line on the map fills in. (**Start inspection** is the real thing,
   which needs you to actually be at the drain.)
3. While it walks, tap **Take a photo**. Photograph anything. It records where you
   were standing and how far along the drain that is.
4. Tap **Checklist & submit**. Your photograph is already there at the top. Answer the
   questions — try answering **Poor** or **Critical** for the structural condition and
   watch extra questions appear.
5. Tap **Submit inspection**.

> Try this too: open the checklist before the walk is finished. Because the drain is
> not covered yet, you cannot submit — but at the bottom there is
> **"Can't complete the walk? Submit with a reason"**. The app makes you say why and
> photograph it, then submits honestly at whatever was actually covered rather than
> pretending. That record reaches the supervisor flagged.

### In the console, review it

6. Refresh FRCDE. Your drain is now under **Awaiting review**.
7. Open it. You will see the route walked, the photographs, the answers — and an
   **automatic first pass**: a short written opinion on whether anything looks wrong,
   including whether the photographs actually match what was reported. It only
   advises; a person still decides.
8. Either **Approve** it, or **Reject** it and send it back to the inspector with a
   reason. (Rejected drains reappear in the app, with the reason attached.)

### Hand a repair to someone else

9. On the same page, press **Route to external**. Pick a channel — **#nea** or
   **#lta** — and press the button that fills in the details for you if you like.
10. Open Slack. The case is there, with the photographs, a tappable map pin and two
    buttons.
11. Press **Acknowledge**. Post a photo in the thread as though you had done the work.
    Then press **Completed**.
12. Go back to FRCDE and open **Inspection Follow-ups**. The whole conversation is there —
    who said what, the photographs, and the case now closed. It updates by itself; you
    do not need to refresh.

That is the full loop: due → dispatched → walked → reviewed → handed over → fixed →
recorded.

---

## If something does not work

| What you see | What it is |
|---|---|
| The console takes ages to load | The server was asleep. Wait up to a minute; it only happens once. |
| Scanning the QR does nothing | You are not signed in to Expo Go. Sign in with the account from the submission and scan again. |
| The app looks out of date | Close Expo Go completely — swipe it away, do not just go to the home screen — and reopen. It checks for updates only when it starts fresh. |
| "No GPS fix" when taking a photo | Expected indoors. Use **Simulate**, which walks the drain in software and gives every photograph a proper position. |
| A drain will not submit | It is short of the coverage it needs, or a required answer or photograph is missing. The message at the bottom says which. |

---

## For anyone who wants to look under the bonnet

This is a mock-up built to show the workflow, not a production system. The reasoning
behind each decision is written down rather than left implicit:

- [cfpi/README.md](cfpi/README.md) — the field app: how coverage is measured, why a
  photograph must be taken and not chosen from the camera roll
- [frcde/README.md](frcde/README.md) — the console: the job lifecycle and the scheduler
- [docs/api-contract.md](docs/api-contract.md) — the agreement the two sides are built
  against
- [docs/slack.md](docs/slack.md) — the follow-up integration
- [docs/ai-review.md](docs/ai-review.md) — what the automatic first pass does, and what
  it is deliberately not allowed to do
- [docs/deploying.md](docs/deploying.md) — how the shared demo is hosted

Drain alignments come from **OpenStreetMap** — around 2,400 real waterway centrelines
across Singapore — because PUB's own asset data is confidential. Genuine geometry for
Pelton Canal, Bukit Timah 1st Diversion Canal, Sungei Ulu Pandan and others.

Roughly 40% of Singapore's mapped drains run underground, where GPS cannot verify
anything. That case is not handled here and would need a different approach entirely.

Before anything like this ran for real, the continuous location tracking of employees
would need settled data retention and written disclosure — PDPA in Singapore, GDPR in
the EU.
