# CFPI — field inspection app

React Native + **Expo SDK 54**. Inspectors receive drain inspection jobs from FRCDE, walk
the drain while CFPI verifies coverage by GPS, complete a checklist, and sync results back.

> **Why SDK 54 and not the latest?** The App Store build of Expo Go is 54.0.2 and only
> runs SDK 54 apps. Expo's route to a newer Expo Go on a physical iPhone is
> `eas go` → TestFlight, which needs a paid Apple Developer account. Pinning to 54 is
> what keeps this runnable on an iPhone for free. Check whether the App Store has moved
> past 54.x before upgrading.

## Run it

```bash
npm run test:core     # coverage, checklist and uuid engines — 39 tests, no device
npm run typecheck
npm start             # Metro, in Expo Go mode
```

**On iPhone, scan the QR with the built-in Camera app** — Expo Go on iOS has no scanner
of its own. On Android, use Expo Go's scanner.

`npm start` passes `--go` deliberately. Because `expo-dev-client` is installed, plain
`expo start` defaults to development-build mode and emits a `cfpi://` QR that the iPhone
Camera reports as "no usable data found". Use `npm run start:devclient` when you do want
a dev build.

### Signing in

Start FRCDE first (`npm run dev` in `../frcde`) and note the address it prints. The
sign-in screen asks for that address and your credentials together — on a fresh handset
both are unset, and signing in against no server achieves nothing. Jobs download on
success. Both devices must be on the same Wi-Fi.

Demo accounts: `inspector` / `inspector`, or `siti` / `siti`.

Tokens are kept in the Keychain / Android Keystore via expo-secure-store, not in the
plain JSON the rest of the device state uses — they are credentials. The access token
lasts 30 minutes and refreshes silently; the app stays usable offline for the full
60-day refresh window, since only *sync* needs a live token.

Without a server address the app falls back to bundled demo data so the screens still
work, and says so on the job list.

### Expo Go's one real limitation

Background location is not available in Expo Go — Expo's docs are explicit for both
platforms. CFPI detects this at runtime (`IS_EXPO_GO`) and falls back to
`Location.watchPositionAsync`, which Expo Go does support. Both paths feed the same
emitter, so the coverage engine, hook and map are identical either way.

In practice: tracking runs only while CFPI is open and the screen is unlocked. Lock the
phone mid-walk and you get a coverage gap. The inspection screen says so. Fine for
evaluating the app; not fine for a real shift — that needs a development build.

## Testing without going outside

An emulator reports one static coordinate, which makes the whole coverage flow
untestable indoors. In development the inspection screen shows a **Simulate** button that
replays fixes along the real drain alignment at walking pace, with GPS jitter. It goes
through exactly the same path as a real start, so it produces a real inspection on the
server rather than a local-only one.

## Layout

```
src/
  core/          Pure TypeScript. No React, no Expo — runs under `node --test`.
    types.ts       Contract types, field names identical to the API
    geo.ts         Projection, chainage, alignment slicing
    coverage.ts    The coverage engine
    checklist.ts   Visibility, photo gating, validation, pruning
    uuid.ts        UUIDv7 — entity ids and idempotency keys
  services/
    locationTask.ts  Background location + Android foreground service
    api.ts           HTTP client; classifies failures transient/permanent/conflict
    outbox.ts        Ordered, retrying, dead-lettering sync queue
    persistence.ts   Inspections that survive app restarts
    photos.ts        Capture → resize → hash → queue upload
    config.ts        Server address
    reset.ts         Wipe local data
  state/
    session.ts           The inspection in progress
    activeInspection.ts  Lets other screens end the walk
  hooks/useInspection.ts Binds the engine to GPS, React and disk
  screens/               Jobs · Inspection · Checklist · Camera · Submitted · Settings
  data/                  Job repository and checklist templates
assets/
  seed-jobs.json         40 drains, bundled so the app works before its first sync
  checklist-template.json  The open-drain form, likewise
```

Both files under `assets/` are copies of `contracts/examples/`, bundled so a handset
that has never reached a server still has drains to walk and a form to fill. Refresh
them with `npm run sync:assets` after the contract examples change — the checklist copy
drifted silently for a while because only the seed data was being copied.

`src/core` is deliberately free of React and Expo imports. That is what lets the parts
which decide whether an inspection counts be tested exhaustively against real geometry
in milliseconds, with no device or emulator.

## How coverage works

See [docs/api-contract.md](../docs/api-contract.md) §4–5. In short:

1. FRCDE publishes the drain as a GeoJSON `LineString` plus precomputed 10 m segment
   boundaries.
2. Each GPS fix is projected perpendicular onto the centreline, giving a **chainage**
   (distance along the drain) and an **offset** (distance from it).
3. A fix is accepted if offset < 20 m and accuracy < 25 m. Both are per-job values from
   `inspection_rules`, tunable server-side.
4. Everything between the previous accepted fix and this one is marked covered — capped
   at 50 m, so a GPS dropout or a drive-past is not credited.
5. Covered stretches repaint green immediately. The inspector finds out about a gap while
   standing there, not from FRCDE the next morning.
6. Submission is gated at 90%.

The client figure is advisory. FRCDE recomputes from the raw track and its number
governs — assume the APK gets decompiled.

### When the walk cannot be finished

Locked gate, flooding, a contractor's compound across the alignment. Below the gate the
checklist offers **"Can't complete the walk? Submit with a reason"** — a reason code,
notes, and a photograph of whatever stopped you.

That is an exception on the record, not a way around the rule: the server enforces the
same requirements, and the inspection reaches review flagged `override_used` with the
reason shown. Without it an inspector has two options, walking the drain badly to game
the percentage or leaving the job open — both worse than an honest 62% with a photo of
the padlock.

## Photographs

**Take a photo** sits beside Checklist & submit on the map screen. Every photograph is
taken there and then, resized to 1600 px, hashed and queued for upload — and placed at
your position on the drain, with the distance along it recorded. They appear in the
checklist under **General condition photographs**, tagged with that distance.

There is no way to add one from the camera roll, and that is the point. A picture from
the album proves nothing about where or when it was taken, so everyone downstream — the
reviewer, the automated check, the contractor sent to the spot — had to carry the doubt.
Removing the option is what makes a photograph here evidence rather than an image.

The checklist no longer takes photographs of its own. Answering "surcharged", "critical"
or "blockage present" still **requires** one, but it is satisfied from the general
photographs: a surcharged drain is a condition of the whole stretch, not of the dropdown
that asked about it, and asking for the same picture three times is how an inspector
learns to game a form.

## Offline behaviour

An inspection is not a single sitting. Pause at a locked gate, come back three days
later, and the coverage, checklist answers and photos are still there — held on the
device, not the server, so resuming needs no signal at all.

Every write to FRCDE queues in the outbox first and drains when connectivity returns, in
order, with idempotency keys. Permanent failures dead-letter and stay visible in
**⚙ Settings** rather than being retried forever or silently dropped.

## Not built yet

- **Tunnel handling.** Roughly 40% of Singapore's mapped drains are underground, where
  GPS cannot verify coverage at all — every fix is rejected, and an inspector who did
  everything right fails the gate. Unverifiable stretches need removing from the coverage
  denominator.
- Real signature capture (currently a tap-to-sign placeholder)
- Delta sync — the app re-fetches the full job list each time
- Offline basemap tiles, for culverts and rural sites
- Battery-optimisation exemption prompt for Xiaomi/Oppo/Samsung
