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
npx eas-cli@latest login    # free Expo account
npm run publish:demo
```

The package is **`eas-cli`**, not `eas` — `eas` is only the binary name it
installs, and `npx eas` fails with the unhelpful "could not determine executable
to run".

**`publish:demo` pins eas-cli to 16.12.0, and that pin is the only reason this
works.** Expo Go matches an update by runtime version `exposdk:54.0.0`; eas-cli
22 overwrites `app.json` on every publish with `runtimeVersion: { policy:
"appVersion" }`, resolving to `1.0.0`, which Expo Go never matches. Neither
deleting the field nor setting it explicitly survives — 22 rewrites it either
way. 16.12.0 honours what is in the file.

Nothing in the terminal reveals this. The publish succeeds and prints a valid
dashboard link; the update server simply answers Expo Go with `204 No Content`
and the app never appears. Check what was actually served:

```bash
npx eas-cli@16.12.0 update:list --branch demo   # expect exposdk:54.0.0, not 1.0.0
```

Do not run `eas update:configure` again. It is not idempotent: besides the
runtime version it re-applies the config plugins over an already-expanded
config, tripling the Android permission list each time.

A **channel** named `demo` must exist and point at the **branch** named `demo`,
or the server returns 404 to the phone while the dashboard looks healthy.
Already created; recreate with `npx eas-cli@16.12.0 channel:create demo`.

**On Windows** use `npx.cmd`. PowerShell here refuses npm's unsigned `.ps1`
wrappers under an `AllSigned` machine policy; the `.cmd` shims are not scripts
and are unaffected.

Unlike `expo start`, **`eas update` prints no QR code**, and the one on the EAS
dashboard is buried — Expo has been steering people off Expo Go. Generate it
locally instead:

```bash
npm run qr
```

Or hand over the link itself, which is all the QR encodes:

```
exp://u.expo.dev/d431590f-d51d-478d-abdd-18de7bbdcde2?channel-name=demo
```

A colleague installs **Expo Go** from their app store, scans or opens that, and
CFPI runs — on iPhone or Android, with no Apple Developer account. They must be
**signed in to Expo Go** under an account in the `jiajie3s-team` organisation;
signed out, it refuses the project without explaining why.

Most of the `expo-updates` API is inert under Expo Go, which costs this app
nothing: it does not use it.

**One catch:** since 12 May 2026, Expo Go only loads projects you own or that an
organisation you belong to owns. Colleagues need free Expo accounts, invited to
your Expo organisation. A one-time step, not a payment.

If publishing fails with a GraphQL error naming your SDK version, check
[status.expo.dev](https://status.expo.dev) before changing anything — that exact
failure was a service incident on 1 May 2026, fixed the same day, and it looks
identical to a project misconfiguration.

**Nothing runs on your laptop once this is published.** The bundle is hosted by
Expo and FRCDE by Render, so the link keeps working with your machine shut. That
is the difference between this and `npx expo start --tunnel`, which serves from
your laptop and dies with it.

### Build profiles

`eas.json` is validated against a strict schema that rejects unknown keys, so it
carries no `"//"` comments — the profiles are described here instead.

| Profile | What it is for |
| --- | --- |
| `preview` | A sideloadable Android `.apk`. Free, no Google Play account, installs from a link. |
| `development` | A dev build, for when Expo Go's limits get in the way — background location in particular. |
| `production` | Store builds. iOS needs a paid Apple Developer account; Android does not. |

### Android without any accounts

```bash
npx eas-cli@latest build -p android --profile preview
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
