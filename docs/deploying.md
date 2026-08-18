# Deploying and sharing

How to put FRCDE on the internet and get CFPI onto a colleague's phone. Both
free.

The short version:

```
FRCDE  →  Render, one service serving the console and the API
CFPI   →  that URL baked in, published via EAS Update, opened in Expo Go
```

---

## 1. FRCDE on Render

The repository has a [`render.yaml`](../render.yaml) blueprint, so this is
mostly clicking.

1. Push the repository to GitHub.
2. On [render.com](https://render.com) → **New → Blueprint** → pick the repo.
   It reads `render.yaml` and configures the service itself.
3. Deploy. First build takes a few minutes.

Render assigns the service its own address, shown at the top of the service page
in the dashboard. It serves the console at `/` and the API under `/v1`.

**Check it worked:** open `/v1/healthz` on that address — for this deployment,
<https://frcde.onrender.com/v1/healthz> — and it should return
`{"ok":true,"jobs":40,...}`. Give it a minute if the service has been idle; see
sleeping, below.

### Two things about the free plan

**It sleeps.** After ~15 minutes with no traffic Render stops the container. The
next request restarts it, which takes 30–60 seconds — so the first person to
open it after a quiet spell waits, and everyone after them does not. Warm it up
before a demo by opening the URL a minute early.

CFPI handles this without help: a request to a sleeping server hits the outbox's
15-second timeout, which is classified transient, so it backs off and retries
once the server is awake. The inspector sees nothing. That retry logic was built
for patchy signal in a culvert and covers this for free.

**There is no persistent disk.** `data/db.json` and uploaded photographs are
wiped on every deploy and restart, and the store reseeds to five due drains. A
tidy reset rather than a broken one — but colleagues' inspections do not
survive. Attach a disk on a paid plan if they need to.

### Passwords

Stored as **scrypt** hashes (`scrypt$N$r$p$salt$hash`), never in plain text. A
database written before hashing existed still signs in, and is upgraded on the
next successful attempt — no migration to run.

The seeded demo passwords are published in the README, which is fine on a laptop
and not on a public URL. `render.yaml` therefore sets three environment
variables with `generateValue: true`, so Render mints random ones and shows them
in the dashboard:

```
FRCDE_SUPERVISOR_PASSWORD
FRCDE_INSPECTOR_PASSWORD
FRCDE_SITI_PASSWORD
```

Read them from **Render → your service → Environment** and hand them to
colleagues. Swap `generateValue: true` for `value: something-you-chose` if you
would rather pick.

They are applied when the database is seeded — which on the free plan, with no
persistent disk, is every deploy.

---

## 2. CFPI to a colleague's phone

### Point the app at the deployed server

Already done — [`cfpi/app.json`](../cfpi/app.json) carries the deployed address:

```json
"extra": { "frcdeUrl": "https://frcde.onrender.com" }
```

No trailing slash: it would turn every request path into a double slash, which
proxies do not all treat alike. Change this if the service is ever redeployed
under a different name.

Now the app arrives already pointed at the server and a colleague only signs in.
**Settings still overrides it**, which is what keeps local development working.

### Publish

```bash
cd cfpi
npx eas login          # free Expo account
npx eas update --branch demo --message "Demo build"
```

That prints a link. A colleague installs **Expo Go** from their app store, opens
the link, and CFPI runs — on iPhone or Android, with no Apple Developer account.

**One catch:** since 12 May 2026, Expo Go only loads projects you own or that an
organisation you belong to owns. Colleagues need free Expo accounts, invited to
your Expo organisation. A one-time step, not a payment.

### Android without any accounts

```bash
npx eas build -p android --profile preview
```

Produces a downloadable `.apk`. Send the link; they install it. No Expo account,
no Google account, no store. Android only.

---

## 3. Demo mode

The sign-in screen offers **"Try the demo — no account needed"**. It runs on the
40 bundled Singapore drains with the Simulate button, and syncs nothing.

It exists for three real situations: a colleague opening a link before they have
an account, the free-tier server still waking up, and — if CFPI is ever
submitted to the App Store — an Apple reviewer, who under
[guideline 2.1(a)](https://developer.apple.com/app-store/review/guidelines/)
must be able to reach the app's functionality without credentials you cannot
hand out.

The outbox is deliberately held shut in demo mode. Queuing work against a server
that was never signed into would strand it in a dead-letter queue nobody is
watching.

---

## What this does not cover

**iPhone outside Expo Go** needs the $99/year Apple Developer Program. With it,
TestFlight internal testing reaches 100 colleagues with no review; external
testing gives a public link but requires Beta App Review.

**Map tiles** still come from OpenStreetMap's public servers. Their usage policy
covers a single developer machine, not a shared deployment. More than a handful
of users means a proper provider — MapTiler's free tier is ample.

**Real data.** The drains are OpenStreetMap (ODbL), not PUB's asset register.
Fine for a demo, with attribution; not something to present as authoritative.
