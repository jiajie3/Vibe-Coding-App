# Drain inspection system

Two connected applications for scheduling, carrying out and reviewing drain inspections.

| | | |
|---|---|---|
| **[CFPI](cfpi/)** | React Native + Expo SDK 54 | Field app. Inspectors walk the drain while GPS verifies coverage, fill a checklist, take photos. |
| **[FRCDE](frcde/)** | React + Vite + Express | Console. Decides what needs inspecting, dispatches jobs, reviews results. |

Everything runs locally — no cloud, no accounts, no API keys.

## Run it

```bash
cd frcde && npm install && npm run dev     # API :4000, console :5173
cd cfpi  && npm install && npm start       # Metro, Expo Go mode
```

Open <http://localhost:5173> for the console. Scan the CFPI QR code with your iPhone
**Camera app** (Expo Go on iOS has no scanner). Both machines must be on the same Wi-Fi.

### Accounts

| Where | Username | Password | |
|---|---|---|---|
| Console | `supervisor` | `supervisor` | approves work, schedules drains |
| App | `inspector` | `inspector` | walks drains |
| App | `siti` | `siti` | second inspector |

The console is supervisor-only and the server enforces it, not just the UI. On the phone,
the server address and sign-in are on one screen — on a fresh handset both are unset, and
signing in against no server achieves nothing. Jobs download on success.

Per-project detail is in [cfpi/README.md](cfpi/README.md) and
[frcde/README.md](frcde/README.md).

## How they fit together

```
FRCDE                                  CFPI
  │                                      │
  │  GET /v1/jobs ─────────────────────▶ │  only jobs needing inspection
  │                                      │  (cached to disk; works offline)
  │                                      │
  │  ◀── heartbeat ──────────────────────│  ~100 bytes: "47%, paused"
  │                                      │
  │  ◀── start · track · photos ─────────│  queued in an outbox,
  │  ◀── complete ───────────────────────│  drains when signal returns
  │                                      │
  │  reviewer approves ─────────────────▶│  job disappears
  │       └─ next due set from the       │
  │          asset's own cycle, then     │
  │          re-queued automatically     │
  │  reviewer rejects ──────────────────▶│  job returns, with the reason
  │  reviewer raises work order          │
```

**FRCDE is the brain.** It holds the whole asset register and decides what is due;
CFPI receives only actionable jobs and never sees the rest.

**CFPI owns work in progress.** A part-walked inspection — coverage, draft answers,
photos — lives on the handset, so an inspector can pause at a locked gate and resume
three days later with no signal at all. FRCDE gets a small heartbeat so a supervisor can
still see progress. Reasoning and the trade-off: [frcde/README.md](frcde/README.md).

**The server has the final say on coverage.** CFPI's percentage drives its own live map,
but on submission FRCDE recomputes coverage from the raw GPS points — using the very same
engine, imported directly from `cfpi/src/core/` so the two cannot drift apart.

## The contract

[docs/api-contract.md](docs/api-contract.md) is the spec both sides build against —
job lifecycle, offline sync rules, coverage semantics, and the reasoning behind each.
[contracts/openapi.yaml](contracts/openapi.yaml) is the machine-readable version.

Worth reading first if you are picking this up cold. The design principles in §1
(client-generated IDs, idempotent writes, server-authoritative coverage) explain most of
what looks unusual elsewhere.

## Where the drain data comes from

Real PUB drain centrelines are confidential, so development data is **OpenStreetMap** —
about 2,400 mapped waterway centrelines across Singapore. Genuine alignments for Pelton
Canal, Bukit Timah 1st Diversion Canal, Sungei Ulu Pandan and others.

```bash
python tools/seed_from_osm.py --count 40
```

Structurally identical to what a real asset register supplies (GeoJSON `LineString`,
WGS84), so swapping in production geometry changes an ingestion adapter and nothing else.
ODbL-licensed: fine for development, needs attribution if shown publicly, must not become
the production register.

## Tests

```bash
cd cfpi  && npm run test:core   # 39 tests — coverage, checklist and uuid engines
cd frcde && npm run e2e         # full contract round-trip against a running server
```

`cfpi/src/core/` is free of React and Expo imports on purpose. The parts that decide
whether an inspection counts are tested exhaustively against real Singapore geometry in
milliseconds, with no device or emulator.

The e2e walks accept → start → track → photo → complete → review, and asserts the
lifecycle end to end: a submitted job leaves the handset, a rejected one comes back with
its reason, an approved one is gone for good, and a client claiming 100% coverage against
a 93.5% track is flagged.

## Status

**Built.** Authentication with roles; job dispatch and lifecycle; GPS coverage
verification with server-side recomputation; pause and resume across days; server-driven
checklists; photo capture, album import and upload; an offline outbox with retry and
dead-lettering; coverage override with a recorded reason and evidence; review, approval
and re-inspection; remediation work orders; automatic scheduling from per-asset
inspection cycles.

**Not built.** Tunnel handling — roughly 40% of Singapore's mapped drains are
underground, where GPS cannot verify coverage at all. Also: delta sync, real signature
capture, reporting and export, an audit trail, and offline basemap tiles.

**Known shortcuts, deliberately visible rather than half-hidden.** Passwords are stored
in plain text and tokens are opaque random strings, not signed JWTs — production needs
argon2id and a real identity provider. The console keeps its token in `localStorage`
rather than an httpOnly cookie.

This is a mock-up. Before any production use, settle data retention and written
disclosure for continuous employee location tracking — regulated under PDPA in Singapore
and GDPR in the EU.
