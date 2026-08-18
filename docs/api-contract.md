# CFPI ↔ FRCDE API Contract (v1)

**CFPI** — mobile app (React Native + Expo) used by field inspectors.
**FRCDE** — backend + web console that schedules, tracks and reviews drain inspections. FRCDE owns the API; CFPI is a client.

This document is the spec both teams build against. The machine-readable version is
[`contracts/openapi.yaml`](../contracts/openapi.yaml); sample payloads are in [`contracts/examples/`](../contracts/examples/).

- Base URL: `https://api.frcde.example.com/v1`
- Transport: HTTPS only, TLS 1.2+. Request/response bodies gzip-encoded.
- Media type: `application/json; charset=utf-8`

---

## 1. Design principles

These six rules exist because CFPI runs offline for hours at a time. Every endpoint below obeys them.

### 1.1 The client generates IDs
Any entity CFPI can create while offline — inspection sessions, checklist submissions, attachments —
gets a **client-generated UUIDv7** at creation time. The server never assigns these IDs.

Why: an inspector can start an inspection, take 30 photos and answer a checklist with no signal.
Those records must reference each other by ID *before* the server has ever heard of them.
UUIDv7 (not v4) because it sorts by creation time, which makes server-side indexing sane.

### 1.2 Every mutation is idempotent
All `POST`/`PATCH` requests carry an `Idempotency-Key` header (a UUID, stable across retries of the
same logical operation). The server stores the key with the response for 7 days and replays the
stored response on a repeat.

Why: the CFPI outbox retries on any network failure. Without this, a retry after a response is lost
in transit creates a duplicate inspection. This is the single most common offline-sync bug.

### 1.3 Writes are append-only where possible
Track points and attachments are appended, never updated. Re-sending an already-received track batch
is a no-op, deduplicated on `(inspection_id, seq)`.

### 1.4 The server is the authority on coverage
CFPI computes coverage on-device for **live UI feedback**. It sends the raw track alongside its
computed figure. FRCDE **recomputes coverage from the raw points** and its own figure is what counts.
A mismatch beyond 5 percentage points is flagged for review.

Never trust a client-computed compliance metric. Assume the APK will be decompiled.

### 1.5 Time is recorded twice
Every timestamped record carries `recorded_at` (device clock) and receives `received_at`
(server clock). CFPI also reports `clock_skew_ms` at sync. Device clocks drift, get changed manually,
and go backwards across timezone edits.

All timestamps are **ISO 8601 UTC with milliseconds**: `2026-08-07T09:14:32.150Z`. Never local time.

### 1.6 Behaviour is server-configured
Coverage thresholds, GPS accuracy gates and checklist structure come down in the job payload
(§4) and template (§6) — not baked into the app. Changing a checklist question or tightening a
coverage rule must be a FRCDE config change, not an app-store release with a two-week review.

---

## 2. Authentication

OAuth2 password grant with refresh tokens.

```
POST /v1/auth/token          { username, password, device_id }  → access_token (30 min), refresh_token (60 days)
POST /v1/auth/refresh        { refresh_token }                  → new pair (refresh rotates)
POST /v1/auth/logout         { refresh_token }                  → revokes
```

Access token in `Authorization: Bearer <token>`.

**Offline consideration:** a 30-minute access token is useless to an inspector who has been in a
tunnel for three hours. CFPI must keep the refresh token in secure storage (`expo-secure-store` →
Keychain/Keystore) and refresh *opportunistically* whenever connectivity returns, before draining
the outbox. The app stays usable offline for the full 60-day refresh window; only sync requires a
valid token.

`device_id` is a stable install-scoped UUID. FRCDE uses it to bind a session to a handset and to
revoke a lost phone without disabling the user.

---

## 3. Job lifecycle

```
                  ┌──────────── decline ───────────┐
                  │                                ▼
  (FRCDE publish) ──▶ available ──accept──▶ accepted ──start──▶ in_progress
                          │                    │                     │
                       expired               release              complete
                     (due passed)         (back to available)         │
                                                                      ▼
                                                                  submitted
                                                                      │
                                                          ┌── approve ─┴─ reject ──┐
                                                          ▼                        ▼
                                                      approved                 accepted
                                                                          (re-inspection required)

  cancelled ◀── FRCDE may cancel from available / accepted / in_progress
```

| Status | Meaning | Set by |
|---|---|---|
| `available` | Published and unclaimed; visible to eligible inspectors on the CFPI map | FRCDE |
| `accepted` | Claimed by one inspector, not yet started | CFPI |
| `in_progress` | Inspection session open, GPS tracking active | CFPI |
| `submitted` | Checklist + track + photos uploaded, awaiting review | CFPI |
| `approved` | Reviewed and closed | FRCDE |
| `rejected` | Reviewer sent it back; returns to `accepted` for the same inspector | FRCDE |
| `cancelled` | Withdrawn by FRCDE | FRCDE |
| `expired` | Due date passed while unclaimed | FRCDE |

**Race on accept.** Two inspectors can tap "Accept" on the same job simultaneously. `POST /jobs/{id}/accept`
requires an `If-Match: <etag>` header carrying the job version CFPI last saw. A stale version returns
**`409 Conflict`** with the current job state, and CFPI shows "This job was just taken by someone else."

**Accept is the only mutation that cannot be done offline.** Everything else queues. Claiming a shared
resource requires the server to arbitrate — enforce this in the UI by disabling Accept when offline.

---

## 4. Getting jobs

```
GET /v1/jobs?status=available&bbox=103.60,1.20,104.10,1.48&updated_since=<cursor>&limit=100
GET /v1/jobs/{job_id}
```

Returns a page plus a `next_cursor`. CFPI syncs with `updated_since` and never re-downloads the world.

### FRCDE decides what CFPI sees

`status` defaults to the **dispatchable set** — `available`, `accepted`, `in_progress`.
A drain that is approved, awaiting review, cancelled or expired is never sent to a handset.

CFPI is a field tool, not a copy of the asset register. An inspector's list should be
their work, and filtering here rather than in the app means the app cannot get it wrong.
It is also what makes the lifecycle self-enforcing:

- **submitted** → the job leaves the handset
- **rejected** → the job returns to `accepted`, so it reappears at the next sync, carrying
  `rejection_reason` and `superseded_inspection_id`
- **approved** → gone for good, with every attempt retained server-side

> ⚠️ CFPI may legitimately be **ahead** of FRCDE. An inspection submitted with no signal
> sits in the outbox for hours while the server still reports the job as `accepted`.
> The app therefore keeps its own status override until the queued work is delivered —
> without it, the next sync would put the job back in the inspector's list and invite
> them to walk the same drain twice.

### In-progress state lives on the handset

FRCDE stores no coverage for an inspection still under way. The full state — every
covered segment, the walked path, draft answers, photos — is on the device, because an
inspector must be able to pause at a locked gate and resume three days later with no
connectivity. If resuming required a round trip, offline-first would collapse at exactly
the moment it matters. Streaming it would also cost battery and data to keep a server
informed of something nobody is watching.

Instead CFPI sends a **heartbeat**, roughly 100 bytes, whenever it can:

```
POST /v1/jobs/{job_id}/heartbeat
{ "inspection_id": "...", "status": "paused", "coverage_pct": 47 }
```

That is enough for a supervisor to see *"Bedok Drain — 47%, paused 3 days ago"* and chase
it. It is best-effort and never queued: a heartbeat delivered an hour late would overwrite
a fresher figure with a stale one, and a failed one must never block an inspector.

**Trade-off:** lose the phone and the partial inspection is lost. If that becomes
unacceptable, the answer is a periodic full-state backup on Wi-Fi — not moving the source
of truth to the server.

### The job payload carries the drain geometry

This is the part that makes coverage tracking possible. A job is **not** a pin on a map — it carries the
drain's alignment as a GeoJSON `LineString`.

```jsonc
{
  "id": "018f3a...",
  "reference": "INS-2026-004182",
  "status": "available",
  "version": 3,                        // → ETag, used for If-Match on accept
  "priority": "high",
  "due_at": "2026-08-14T16:00:00.000Z",
  "asset": {
    "id": "DRN-88213",
    "name": "Sungei Ulu Pandan – Segment 14B",
    "type": "open_concrete_drain",
    "length_m": 612.4,
    "geometry": {                      // GeoJSON RFC 7946, WGS84, [lon, lat]
      "type": "LineString",
      "coordinates": [[103.7612, 1.3204], [103.7618, 1.3211], ...]
    },
    "access_notes": "Gate at Clementi Rd end; key from depot.",
    "hazards": ["confined_space", "deep_water"]
  },
  "inspection_rules": {                // server-tunable, per job — see §1.6
    "segment_length_m": 10,
    "corridor_tolerance_m": 20,        // max perpendicular distance from centreline
    "max_accuracy_m": 25,              // reject fixes worse than this
    "min_coverage_pct": 90,            // completion gate
    "max_speed_mps": 3.0,              // above this = probably driving; flag
    "allow_override": true,            // permit sub-threshold submit with a reason
    "require_photo_on_override": true
  },
  "checklist_template": { "id": "tpl_open_drain", "version": 7 }
}
```

> ⚠️ **Coordinate order gotcha.** GeoJSON is `[longitude, latitude]`. `react-native-maps` wants
> `{ latitude, longitude }`. Convert at exactly one boundary in CFPI (a single `toLatLng()` helper)
> and never anywhere else. Swapped coordinates put Singapore drains in Somalia, and it is
> surprisingly easy to miss because both values are small positive numbers.

### Claiming

```
POST   /v1/jobs/{id}/accept     If-Match: "3"   → 200 job | 409 conflict
POST   /v1/jobs/{id}/decline    { reason }      → 200
POST   /v1/jobs/{id}/release    { reason }      → 200  (accepted → available)
```

---

## 5. The inspection session

### 5.1 Start

CFPI creates the session **locally first**, then syncs. The session ID is client-generated (§1.1) so
photos and checklist answers can reference it while offline.

```
POST /v1/jobs/{job_id}/inspections
Idempotency-Key: <uuid>

{
  "id": "018f3b2c-...",                  // client-generated UUIDv7
  "started_at": "2026-08-07T09:02:11.480Z",
  "start_location": { "lat": 1.3204, "lon": 103.7612, "accuracy_m": 8.2 },
  "device": { "device_id": "...", "app_version": "1.4.0", "os": "android 14",
              "clock_skew_ms": -1840 }
}
```

Job transitions to `in_progress`.

### 5.2 Streaming the track

Track points are uploaded in **append-only batches**, deduplicated on `(inspection_id, seq)`.

```
POST /v1/inspections/{id}/track
Idempotency-Key: <uuid>

{
  "batch_seq": 4,
  "points": [
    { "seq": 148, "t": "2026-08-07T09:14:32.150Z",
      "lat": 1.32118, "lon": 103.76201,
      "acc": 6.4,          // horizontal accuracy, metres
      "alt": 18.2,
      "spd": 1.12,         // m/s
      "hdg": 214.5,
      "mock": false,       // isFromMockProvider / isSimulatedBySoftware
      "src": "gps" }       // gps | fused | network
  ]
}
```

**Upload cadence:** flush every 30 seconds *or* 50 points, whichever comes first, and always on
stop. Points are written to local SQLite the instant they arrive and only deleted after the server
acknowledges them. If the app is killed mid-inspection, the track survives.

**Sampling:** distance-based, every 5–10 m — not time-based. A stationary inspector should not
generate 3,600 identical points an hour. Set `distanceFilter`, and let the motion detector idle the
GPS when genuinely still.

**Volume sanity check:** a 600 m drain at 10 m sampling ≈ 60 points ≈ 6 KB. Even a 5 km shift is
trivial. Don't prematurely optimise this into a binary format.

`mock: true` on any point flags the whole inspection for review server-side. Do not block the
inspector in the field over it — flag it and let a human decide.

### 5.3 Completing

```
POST /v1/inspections/{id}/complete
Idempotency-Key: <uuid>

{
  "ended_at": "2026-08-07T09:48:55.000Z",
  "coverage": {
    "client_computed_pct": 94.2,        // advisory only — server recomputes (§1.4)
    "covered_segments": 58,
    "total_segments": 62,
    "uncovered_ranges_m": [[210, 240], [580, 612]]
  },
  "override": null,                     // or { "reason_code": "access_blocked",
                                        //      "notes": "...", "photo_ids": [...] }
  "checklist": {
    "template_id": "tpl_open_drain",
    "template_version": 7,              // pin the version — see §6
    "answers": { "structural_condition": "fair", "blockage_present": true, ... }
  },
  "attachment_ids": ["018f3b40-...", "018f3b41-..."],
  "signature_id": "018f3b55-..."
}
```

Response returns the **server-computed** coverage and the resulting job status
(`submitted`, or `submitted` with `flags: ["coverage_mismatch"]`).

Job transitions to `submitted`.

---

## 6. Checklists are server-driven

FRCDE serves the checklist as a **versioned JSON form schema**; CFPI renders it dynamically.

```
GET /v1/checklist-templates/{id}                 → latest published version
GET /v1/checklist-templates/{id}?version=7       → a pinned version
```

Field types: `boolean`, `single_select`, `multi_select`, `number`, `text`, `photo`, `signature`,
`severity`. Fields support conditional visibility (`visible_if`), validation, and
`requires_photo_when` — so answering "blockage present = yes" can *force* a photo before the form
will submit. See [`contracts/examples/checklist-template.json`](../contracts/examples/checklist-template.json).

**Two rules that matter:**

1. **Submissions pin `template_version`.** A result recorded against v7 must stay interpretable
   after FRCDE publishes v8. Never re-map old answers onto a new schema.
2. **CFPI caches every template it may need before going to the field.** An inspector who reaches a
   site and finds the checklist won't load has wasted the trip. Prefetch templates for all accepted
   jobs at sync time, and treat a missing template as a blocker on Accept, not on Start.

---

## 7. Photos

Three steps. Photo bytes never pass through the FRCDE API server.

```
1. POST /v1/inspections/{id}/attachments/presign
   { "id": "018f3b40-...", "content_type": "image/jpeg", "byte_size": 842104, "sha256": "..." }
   → { "upload_url": "https://storage.../signed?...", "expires_at": "..." }

2. PUT <upload_url>                       (direct to object storage, retriable/resumable)

3. POST /v1/inspections/{id}/attachments  (confirm — server verifies size + sha256)
   { "id": "018f3b40-...", "kind": "defect",
     "captured_at": "2026-08-07T09:21:04.000Z",
     "location": { "lat": 1.32118, "lon": 103.76201, "accuracy_m": 6.4 },
     "chainage_m": 212.5,                // distance along the drain — links photo to a position
     "checklist_field_id": "blockage_present",
     "caption": "Silt accumulation, approx 300mm depth" }
```

**Client-side rules:**
- Resize to max 1600 px long edge, JPEG quality 80 → ~300–600 KB. A raw 12 MP photo is ~5 MB;
  30 of those per inspection is 150 MB of an inspector's mobile data per job. Unacceptable.
- **Keep GPS EXIF.** Normally you strip it for privacy — here it is evidence. Also burn a
  visible lat/lon/timestamp/inspector-ID stamp into the image corner.
- `sha256` computed before upload and verified server-side, so a truncated upload is detected
  rather than silently stored as a corrupt file.
- `chainage_m` (distance along the drain centreline) is what lets FRCDE place each photo on the
  correct part of the drain in the review UI. Compute it from the same projection used for coverage.

---

## 8. Sync protocol (CFPI outbox)

CFPI's local SQLite is the source of truth during a shift. A single ordered outbox drains to FRCDE
when connectivity returns.

**Ordering is a hard dependency**, not a preference:

```
inspection.start  →  track batches  →  attachment presign → PUT → confirm  →  inspection.complete
```

`complete` references `attachment_ids`; those attachments must exist server-side first. Process the
outbox strictly in order and stop the queue on the first hard failure for a given inspection —
don't skip ahead.

**Retry policy:** exponential backoff (2s → 4s → 8s … capped at 5 min) with jitter.
- `4xx` other than `408`/`429` → permanent failure. Move to a dead-letter queue, surface it in the
  app's sync screen, never retry blindly. A 400 will fail identically forever and will otherwise spin
  until the battery dies.
- `409` on accept → resolve as a real conflict in the UI (§3).
- `5xx`, `408`, `429`, network errors → retry. Honour `Retry-After`.

**Delta pull:** `GET /v1/sync/changes?since=<cursor>` returns jobs changed since the cursor,
including cancellations. Persist the cursor only after the batch is committed locally.

---

## 9. Errors

RFC 9457 `application/problem+json`:

```json
{
  "type": "https://api.frcde.example.com/errors/coverage-below-threshold",
  "title": "Coverage below threshold",
  "status": 422,
  "detail": "Coverage 71.4% is below the required 90% and no override was supplied.",
  "instance": "/v1/inspections/018f3b2c-.../complete",
  "errors": [{ "field": "coverage.client_computed_pct", "code": "below_minimum" }]
}
```

| Code | Meaning | CFPI behaviour |
|---|---|---|
| 401 | Token expired/invalid | Refresh, retry once, then prompt re-login. Never discard the outbox. |
| 403 | Not permitted for this inspector | Show message, dead-letter |
| 409 | Version conflict (accept race) | Refresh job, show "already taken" |
| 410 | Job cancelled | Remove from list, warn if in progress |
| 413 | Attachment too large | Re-compress and retry once |
| 422 | Validation / coverage failure | Show what's missing, keep data locally |
| 429 | Rate limited | Back off per `Retry-After` |

**Rule: no error ever destroys local data.** The outbox item moves to dead-letter and stays visible
in the sync screen until a human resolves it. Losing a completed inspection because of a bad request
means someone drives back out to the site.

---

## 10. Development data source

Real PUB drain centrelines are confidential and unavailable to this project. Development and demo
data therefore comes from **OpenStreetMap**, which has ~2,400 mapped waterway centrelines across
Singapore tagged `waterway=drain|canal|ditch` — genuine alignments for Pelton Canal, Bukit Timah
1st Diversion Canal, Sungei Ulu Pandan, Siglap Drain and others.

```
python tools/seed_from_osm.py --count 40
```

Writes [`contracts/examples/seed-jobs.json`](../contracts/examples/seed-jobs.json) (40 jobs, ~18 km
of centreline, realistic status mix) and a companion `.geojson` you can drag onto geojson.io to
eyeball. Output is deterministic for a given `--seed`.

This is a **data-source substitution, not a compromise**. OSM ways are GeoJSON `LineString`s in
WGS84 — structurally identical to what the real asset register will supply. Swapping in production
geometry later changes an ingestion adapter, nothing else.

Two caveats:
- OSM geometry is ODbL-licensed. Fine for development and internal demos; carries an attribution
  requirement if ever shown publicly. It must not ship as the production asset register.
- OSM ways are drawn sparsely — `Sungei Ulu Pandan` returns as a 2-point line spanning hundreds of
  metres. The seed script densifies to ≤25 m vertex spacing so map rendering and per-segment
  colouring behave like a surveyed alignment.

> **Why not street names from Google Maps as a proxy?** Street *names* are labels, not geometry —
> they give you no line to project GPS fixes onto, so coverage tracking cannot work at all. Road
> centrelines (via the Directions API's encoded polylines) would technically give you a line, but
> roads diverge from drains exactly where it matters — culverts, canal reserves, park connectors,
> back-of-house drains with no adjacent road. You would be building the coverage engine against
> geometry it will never see in production. OSM waterways are the real thing.

## 11. Resolved decisions

1. **Who segments the drain?** FRCDE. It precomputes `segment_boundaries_m` and returns them with
   the geometry, so both sides measure coverage against an identical partition. Otherwise
   floating-point differences produce off-by-one coverage disputes nobody can settle.
2. **Re-inspection after `rejected`** — a **new** inspection session, linked to the original via
   `supersedes_inspection_id`. See §11.1.
3. **Multi-inspector jobs** — out of scope for v1.
4. **Data retention / tracking disclosure** — deferred; this build is a mock-up. Note that
   continuous employee location tracking is regulated (PDPA in Singapore, GDPR in the EU) and
   needs written notice plus a defined retention period before any production deployment.

### 11.1 Why rejection creates a new session

When a reviewer rejects a submitted inspection, CFPI does **not** reopen and edit the original.
It creates a fresh session whose `supersedes_inspection_id` points at the rejected one.

```
Attempt 1  inspection A ──submitted──▶ rejected ("coverage gap at ch. 210–240")
Attempt 2  inspection B  (supersedes_inspection_id: A) ──submitted──▶ approved

Stored: both A and B, in full.
```

The alternative — letting the inspector edit and resubmit the original — destroys the record of
what was first reported. That matters here for three reasons:

- **The original is evidence.** If a drain later floods, "what did the inspector actually report on
  7 August, before anyone asked them to redo it?" must be answerable. An overwritten record cannot
  answer it.
- **Each attempt has its own GPS track.** They are different walks on different days. Merging two
  tracks into one session makes coverage meaningless — you would not be able to tell whether one
  visit covered the drain, or whether two half-walks were stitched together to fake it.
- **It makes review quality measurable.** Rejection rates per inspector, and what got fixed between
  attempts, are only visible if both attempts survive.

The cost is that FRCDE's review UI must show a job's inspections as a chain rather than a single
record, and CFPI must display the rejection reason prominently when the inspector reopens the job.
Cheap, and worth it.
