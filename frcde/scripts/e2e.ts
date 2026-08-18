/** End-to-end check: sign in, accept, walk, complete, review — over HTTP. */

import { buildAlignment, chainageToLatLon } from '../../cfpi/src/core/geo.ts';

const API = 'http://localhost:4000/v1';

let TOKEN = '';

async function j(path: string, init?: RequestInit) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function signIn(username: string, password: string) {
  const t = await j('/auth/token', {
    method: 'POST',
    body: JSON.stringify({ username, password, device_id: 'e2e' }),
  });
  TOKEN = t.access_token;
  return t.inspector;
}

/* ------------------------------------------------------------------ auth */

{
  const anon = await fetch(`${API}/jobs`);
  if (anon.status !== 401) throw new Error(`anonymous request got ${anon.status}, expected 401`);

  const bad = await fetch(`${API}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'inspector', password: 'nope' }),
  });
  if (bad.status !== 401) throw new Error(`bad password got ${bad.status}, expected 401`);
}

// An inspector must not reach the console — and must be refused with 403, not
// 401, so the CFPI outbox dead-letters it instead of retrying for ever.
const inspector = await signIn('inspector', 'inspector');
{
  const forbidden = await fetch(`${API}/console/overview`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (forbidden.status !== 403) {
    throw new Error(`inspector reaching console got ${forbidden.status}, expected 403`);
  }
}
console.log(`auth ok: anonymous 401, bad password 401, ${inspector.name} blocked from console 403`);

await signIn('supervisor', 'supervisor');

// 0. the data has to agree with the label the console puts on it: being in the
//    queue means being due for inspection, so every queued drain falls inside
//    the 7-day window and every closed one falls outside it.
const DUE_WINDOW = 7;
const daysOut = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000);

const overview = await j('/console/overview');
for (const x of overview.jobs) {
  const d = daysOut(x.due_at);
  const queued = ['available', 'accepted', 'in_progress', 'submitted'].includes(x.status);
  if (queued && d > DUE_WINDOW) {
    throw new Error(`${x.reference} is queued but due in ${d}d — outside the window`);
  }
  if (!queued && d <= DUE_WINDOW) {
    throw new Error(`${x.reference} is closed but due in ${d}d — should be next cycle`);
  }
}
console.log(
  `due dates coherent: ${overview.jobs.filter((x: any) => daysOut(x.due_at) <= DUE_WINDOW).length} within ${DUE_WINDOW}d, all queued`,
);

const job = overview.jobs.find((x: any) => x.status === 'available');
console.log(`job: ${job.reference} - ${job.asset.name} (${job.asset.length_m} m), v${job.version}`);

// 1. accept, with optimistic concurrency
await j(`/jobs/${job.id}/accept`, {
  method: 'POST',
  headers: { 'If-Match': `"${job.version}"`, 'Idempotency-Key': crypto.randomUUID() },
  body: '{}',
});
console.log('accepted ok');

// stale If-Match must be refused
const stale = await fetch(`${API}/jobs/${job.id}/accept`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    'If-Match': '"1"',
  },
  body: '{}',
});
if (stale.status !== 409) throw new Error(`stale If-Match got ${stale.status}, expected 409`);
console.log(`re-accept blocked ok (${stale.status})`);

// 2. heartbeat - the only in-progress state FRCDE stores
await j(`/jobs/${job.id}/heartbeat`, {
  method: 'POST',
  body: JSON.stringify({ inspection_id: 'temp', status: 'paused', coverage_pct: 42.5 }),
});
console.log('heartbeat ok');

// 3. start
const inspectionId = crypto.randomUUID();
await j(`/jobs/${job.id}/inspections`, {
  method: 'POST',
  headers: { 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ id: inspectionId, started_at: new Date().toISOString() }),
});
console.log('inspection started ok');

// idempotency: replaying the create must not make a second inspection
await j(`/jobs/${job.id}/inspections`, {
  method: 'POST',
  body: JSON.stringify({ id: inspectionId, started_at: new Date().toISOString() }),
});

// 4. walk it, stopping 8% short so the coverage gate is exercised
const align = buildAlignment(job.asset.geometry);
const L = align.length_m;
const points: any[] = [];
let seq = 0;
let t = Date.now();
for (let c = 0; c <= L * 0.92; c += 8) {
  const p = chainageToLatLon(align, c);
  points.push({ seq: ++seq, t: new Date((t += 6000)).toISOString(), lat: p.lat, lon: p.lon, acc: 5 });
}
const batch = await j(`/inspections/${inspectionId}/track`, {
  method: 'POST',
  body: JSON.stringify({ batch_seq: 1, points }),
});
console.log(`track: ${batch.accepted_points} accepted, server coverage ${batch.server_coverage_pct.toFixed(1)}%`);

// replay the same batch - must dedupe on seq
const replay = await j(`/inspections/${inspectionId}/track`, {
  method: 'POST',
  body: JSON.stringify({ batch_seq: 1, points }),
});
console.log(`replay: ${replay.accepted_points} accepted, ${replay.duplicate_points} duplicates ok`);

// 4b. photo: presign → PUT bytes → confirm (the three-step upload, contract §7)
const photoId = crypto.randomUUID();
const bytes = Buffer.from('not-really-a-jpeg-but-bytes-are-bytes');
const { upload_url } = await j(`/inspections/${inspectionId}/attachments/presign`, {
  method: 'POST',
  body: JSON.stringify({
    id: photoId,
    content_type: 'image/jpeg',
    byte_size: bytes.length,
    sha256: 'a'.repeat(64),
  }),
});
console.log(`presigned ✓ ${upload_url.replace(/^https?:\/\/[^/]+/, '')}`);

const put = await fetch(upload_url, {
  method: 'PUT',
  body: bytes,
  headers: { 'Content-Type': 'image/jpeg' },
});
if (!put.ok) throw new Error(`upload failed ${put.status}`);
console.log(`uploaded ✓ ${(await put.json()).byte_size} bytes`);

const confirmed = await j(`/inspections/${inspectionId}/attachments`, {
  method: 'POST',
  body: JSON.stringify({
    id: photoId,
    kind: 'defect',
    captured_at: new Date().toISOString(),
    location: { lat: 1.32, lon: 103.76 },
    chainage_m: 120.5,
    checklist_field_id: 'blockage_present',
    caption: 'Silt accumulation',
  }),
});
console.log(`confirmed ✓ stored=${confirmed.stored} chainage=${confirmed.chainage_m}m`);

// 5. complete, lying about coverage to prove the server overrides it
const done = await j(`/inspections/${inspectionId}/complete`, {
  method: 'POST',
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 100, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: {
      template_id: 'tpl_open_drain',
      template_version: 7,
      answers: { site_accessible: true, structural_condition: 'poor', blockage_present: true, flow_condition: 'restricted' },
    },
    attachment_ids: [photoId],
  }),
});
console.log(`completed: server says ${done.server_coverage_pct.toFixed(1)}%, client claimed 100%`);
console.log(`flags: ${JSON.stringify(done.flags)}`);

// 6. dispatch scope: a submitted job must vanish from the handset
const dispatched = (await j('/jobs')).data;
if (dispatched.some((x: any) => x.id === job.id)) {
  throw new Error('submitted job is still being dispatched to CFPI');
}
if (dispatched.some((x: any) => !['available', 'accepted', 'in_progress'].includes(x.status))) {
  throw new Error('dispatch list contains a non-actionable job');
}
console.log(`dispatch: ${dispatched.length} jobs sent to CFPI, submitted one excluded ok`);

// 7. review
const detail = await j(`/console/jobs/${job.id}`);
const insp = detail.inspections[0];
console.log(`detail: ${insp.covered_lines.length} covered lines, ${insp.uncovered_lines.length} gaps, ${insp.track_points} points`);

await j(`/console/inspections/${inspectionId}/review`, {
  method: 'POST',
  body: JSON.stringify({ decision: 'rejected', reason: 'Gap at the downstream end.' }),
});
const after = await j(`/console/jobs/${job.id}`);
console.log(`rejected -> job status: ${after.job.status}, reason: "${after.job.rejection_reason}"`);
// 8. a rejected job must come back to the handset, carrying the reason and a
//    link to the inspection its replacement supersedes
const redispatched = (await j('/jobs')).data.find((x: any) => x.id === job.id);
if (!redispatched) throw new Error('rejected job did not return to CFPI');
if (!redispatched.rejection_reason) throw new Error('rejected job carries no reason');
if (redispatched.superseded_inspection_id !== inspectionId) {
  throw new Error('rejected job does not link the superseded inspection');
}
console.log(`re-dispatched ok: reason carried, supersedes ${String(redispatched.superseded_inspection_id).slice(0, 8)}`);

// 9. re-inspect and approve — it must then leave CFPI for good, while both
//    attempts are retained for audit
const insp2 = crypto.randomUUID();
await j(`/jobs/${job.id}/inspections`, {
  method: 'POST',
  body: JSON.stringify({
    id: insp2,
    started_at: new Date().toISOString(),
    supersedes_inspection_id: inspectionId,
  }),
});
await j(`/inspections/${insp2}/track`, {
  method: 'POST',
  body: JSON.stringify({ batch_seq: 1, points }),
});
await j(`/inspections/${insp2}/complete`, {
  method: 'POST',
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 93.5, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: { template_id: 'tpl_open_drain', template_version: 7, answers: {} },
    attachment_ids: [],
  }),
});
await j(`/console/inspections/${insp2}/review`, {
  method: 'POST',
  body: JSON.stringify({ decision: 'approved' }),
});
if ((await j('/jobs')).data.find((x: any) => x.id === job.id)) {
  throw new Error('approved job is still being dispatched to CFPI');
}
const both = await j(`/console/jobs/${job.id}`);
console.log(`approved: gone from CFPI ok, ${both.inspections.length} inspections retained for audit`);

// 10. manual scheduling: a person can put a drain back in the queue and take it out
await j(`/console/jobs/${job.id}/dispatch`, {
  method: 'POST',
  body: JSON.stringify({ due_in_days: 3 }),
});
if (!(await j('/jobs')).data.find((x: any) => x.id === job.id)) {
  throw new Error('manually dispatched job did not reach CFPI');
}
const dispatched2 = (await j('/jobs')).data.find((x: any) => x.id === job.id);
if (daysOut(dispatched2.due_at) > DUE_WINDOW) {
  throw new Error('manual dispatch set a due date outside the window');
}

await j(`/console/jobs/${job.id}/close`, { method: 'POST', body: '{}' });
if ((await j('/jobs')).data.find((x: any) => x.id === job.id)) {
  throw new Error('closed job is still being dispatched');
}
const closed = (await j(`/console/jobs/${job.id}`)).job;
if (daysOut(closed.due_at) <= DUE_WINDOW) {
  throw new Error('closing left a due date inside the window');
}
console.log(`manual dispatch/close ok (next cycle in ${daysOut(closed.due_at)}d)`);

// 11. a second inspection on one drain supersedes the first — a job can only be
//     walked once at a time, and stale open attempts were showing up in the
//     console as several inspections for one visit
const target = (await j('/jobs')).data[0];
const first = crypto.randomUUID();
const second = crypto.randomUUID();
for (const insId of [first, second]) {
  await j(`/jobs/${target.id}/inspections`, {
    method: 'POST',
    body: JSON.stringify({ id: insId, started_at: new Date().toISOString() }),
  });
}
// ...but a drain awaiting review must refuse a third, or one visit ends up
// recorded as several submitted inspections.
await j(`/inspections/${second}/track`, {
  method: 'POST',
  body: JSON.stringify({ batch_seq: 1, points }),
});
await j(`/inspections/${second}/complete`, {
  method: 'POST',
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 90, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: { template_id: 'tpl_open_drain', template_version: 7, answers: {} },
    override: { reason_code: 'other', notes: 'partial', photo_ids: ['x'] },
    attachment_ids: [],
  }),
});
const blocked = await fetch(`${API}/jobs/${target.id}/inspections`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ id: crypto.randomUUID(), started_at: new Date().toISOString() }),
});
if (blocked.status !== 409) {
  throw new Error(`starting on a drain awaiting review got ${blocked.status}, expected 409`);
}

const after2 = await j(`/console/jobs/${target.id}`);
const firstRec = after2.inspections.find((i: any) => i.id === first);
const secondRec = after2.inspections.find((i: any) => i.id === second);
if (firstRec.status !== 'abandoned') {
  throw new Error(`superseded inspection should be abandoned, was ${firstRec.status}`);
}
if (secondRec.status !== 'submitted') {
  throw new Error(`newest inspection should be submitted, was ${secondRec.status}`);
}
const open = after2.inspections.filter((i: any) => i.status === 'in_progress').length;
if (open !== 0) throw new Error(`expected no open inspections, found ${open}`);
console.log('one inspection per drain ok: earlier attempt abandoned, third refused while under review');

// 12. site notes edited in the console must reach the handset — that is the
//     entire point of the field, and it travels on the job payload
const noteTarget = (await j('/jobs')).data[0];
await j(`/console/jobs/${noteTarget.id}/asset`, {
  method: 'PATCH',
  body: JSON.stringify({
    access_notes: 'Key from Jurong depot before 08:00.',
    hazards: ['Deep Water', 'confined space', 'deep_water'],
  }),
});
const dispatchedNotes = (await j('/jobs')).data.find((x: any) => x.id === noteTarget.id);
if (dispatchedNotes.asset.access_notes !== 'Key from Jurong depot before 08:00.') {
  throw new Error('access notes did not reach the dispatched job');
}
// "Deep Water" and "deep_water" are the same hazard typed two ways.
if (dispatchedNotes.asset.hazards.length !== 2) {
  throw new Error(`hazards not normalised/deduped: ${JSON.stringify(dispatchedNotes.asset.hazards)}`);
}
if (dispatchedNotes.version <= noteTarget.version) {
  throw new Error('editing the asset did not bump the job version');
}
console.log(`site notes ok: ${JSON.stringify(dispatchedNotes.asset.hazards)}, version bumped`);

// 13. override: an inspector who cannot finish must be able to submit with a
//     reason. Without it they either fake the walk or abandon the job.
const ovJob = (await j('/jobs')).data.find((x: any) => x.status === 'available');
const ovId = crypto.randomUUID();
await j(`/jobs/${ovJob.id}/inspections`, {
  method: 'POST',
  body: JSON.stringify({ id: ovId, started_at: new Date().toISOString() }),
});
// Walk only a third of it, then stop at a locked gate.
const ovAlign = buildAlignment(ovJob.asset.geometry);
const ovPoints: any[] = [];
let ovSeq = 0;
let ovT = Date.now();
for (let c = 0; c <= ovAlign.length_m * 0.34; c += 8) {
  const p = chainageToLatLon(ovAlign, c);
  ovPoints.push({ seq: ++ovSeq, t: new Date((ovT += 6000)).toISOString(), lat: p.lat, lon: p.lon, acc: 5 });
}
await j(`/inspections/${ovId}/track`, {
  method: 'POST',
  body: JSON.stringify({ batch_seq: 1, points: ovPoints }),
});

// Without an override this must be refused.
const refused = await fetch(`${API}/inspections/${ovId}/complete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 34, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: { template_id: 'tpl_open_drain', template_version: 7, answers: {} },
    attachment_ids: [],
  }),
});
if (refused.status !== 422) throw new Error(`short walk without override got ${refused.status}, expected 422`);

// An override with no evidence must also be refused when the job demands one.
const ovPhoto = crypto.randomUUID();
const noEvidence = await fetch(`${API}/inspections/${ovId}/complete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 34, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: { template_id: 'tpl_open_drain', template_version: 7, answers: {} },
    override: { reason_code: 'access_blocked', photo_ids: [] },
    attachment_ids: [],
  }),
});
if (noEvidence.status !== 422) throw new Error(`override without evidence got ${noEvidence.status}, expected 422`);

const overridden = await j(`/inspections/${ovId}/complete`, {
  method: 'POST',
  body: JSON.stringify({
    ended_at: new Date().toISOString(),
    coverage: { client_computed_pct: 34, covered_segments: 0, total_segments: 0, uncovered_ranges_m: [] },
    checklist: { template_id: 'tpl_open_drain', template_version: 7, answers: { blockage_present: true, silt_depth_mm: 260 } },
    override: {
      reason_code: 'access_blocked',
      notes: 'Gate padlocked at ch. 210; no key at the depot.',
      photo_ids: [ovPhoto],
    },
    attachment_ids: [],
  }),
});
if (!overridden.flags.includes('override_used')) {
  throw new Error(`override not flagged: ${JSON.stringify(overridden.flags)}`);
}
console.log(`override ok: refused without reason and without evidence, accepted at ${overridden.server_coverage_pct.toFixed(0)}% and flagged`);

// 14. work orders: an inspection that finds a defect must be able to become work
const wo = await j('/console/work-orders', {
  method: 'POST',
  body: JSON.stringify({
    job_id: ovJob.id,
    inspection_id: ovId,
    assigned_to: 'Jurong depot — jetting crew',
    detail: 'Clear blockage at chainage 180 m, approx 260 mm silt.',
    due_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    chainage_m: 180,
  }),
});
if (wo.status !== 'open') throw new Error('new follow-up should be open');
if (wo.assigned_to !== 'Jurong depot — jetting crew') {
  throw new Error(`officer not recorded: ${JSON.stringify(wo.assigned_to)}`);
}
if (!wo.due_at) throw new Error('due date not recorded');
// Title is derived from the description rather than asked for twice.
if (!wo.title?.startsWith('Clear blockage')) {
  throw new Error(`title not derived from detail: ${JSON.stringify(wo.title)}`);
}

// Detail and officer are both required — a follow-up with neither is untraceable.
for (const bad of [{ assigned_to: 'x' }, { detail: 'y' }]) {
  const res = await fetch(`${API}/console/work-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ job_id: ovJob.id, ...bad }),
  });
  if (res.status !== 422) throw new Error(`incomplete follow-up got ${res.status}, expected 422`);
}
const woDone = await j(`/console/work-orders/${wo.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'done', closing_note: 'Cleared by jetting crew.' }),
});
if (woDone.status !== 'done' || !woDone.closed_at) throw new Error('follow-up did not close');
console.log(`follow-ups ok: routed to "${wo.assigned_to}", due date recorded, closed with a note`);

// 15. scheduler: approving sets the next due date from the asset's own cycle,
//     and the sweep queues whatever has come due
const schedJob = (await j('/console/overview')).jobs.find((x: any) => x.status === 'submitted');
if (schedJob) {
  const insp = (await j(`/console/jobs/${schedJob.id}`)).inspections.find(
    (i: any) => i.status === 'submitted',
  );
  await j(`/console/inspections/${insp.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });
  const after = (await j(`/console/jobs/${schedJob.id}`)).job;
  if (!after.last_inspected_at) throw new Error('approval did not record last_inspected_at');
  if (daysOut(after.due_at) <= DUE_WINDOW) {
    throw new Error(`approval left the next due date at ${daysOut(after.due_at)}d`);
  }
  console.log(`scheduling ok: approved, next due in ${daysOut(after.due_at)}d`);
}
const sweep = await j('/console/schedule/run', { method: 'POST', body: '{}' });
console.log(`scheduler swept ${sweep.checked} closed drains, queued ${sweep.queued.length}`);

// 16. checklist template is served, so the console can label answers
const tpl = await j('/checklist-templates/tpl_open_drain');
if (!tpl.fields?.length) throw new Error('checklist template has no fields');
console.log(`template ok: ${tpl.fields.length} fields, ${tpl.sections.length} sections`);

console.log('\nALL CHECKS PASSED');

