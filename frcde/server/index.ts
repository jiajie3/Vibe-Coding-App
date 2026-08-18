/**
 * FRCDE API server.
 *
 * Implements the CFPI ↔ FRCDE contract (docs/api-contract.md) against a local
 * JSON store. Binds to 0.0.0.0 so a phone on the same Wi-Fi can reach it —
 * there is no cloud anywhere in this system.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { CoverageTracker } from '../../cfpi/src/core/coverage.ts';
import { sliceAlignment } from '../../cfpi/src/core/geo.ts';
import type { CoverageFlag } from '../../cfpi/src/core/types.ts';
import { issue, publicUser, requireAuth, rotate } from './auth.ts';
import type { AuthedRequest } from './auth.ts';
import { cycleFor, DUE_WINDOW_DAYS, load, reset, store, UPLOAD_DIR } from './store.ts';
import type { AttachmentRecord, InspectionRecord, WorkOrder } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

load();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

/**
 * Request log.
 *
 * Two systems on two devices talking over Wi-Fi is exactly the situation where
 * "it fails" is impossible to act on. Seeing the method, path and status in the
 * server terminal turns a guess into an answer.
 */
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const flag = res.statusCode >= 400 ? ' ⚠' : '';
    console.log(
      `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - started}ms)${flag}`,
    );
  });
  next();
});

/** RFC 9457 problem+json, as the contract specifies. */
function problem(
  res: express.Response,
  status: number,
  title: string,
  detail?: string,
) {
  res.status(status).type('application/problem+json').json({
    type: `https://frcde.local/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  });
}

/**
 * Recompute coverage from the raw track.
 *
 * The whole point of contract §1.4: CFPI's percentage drives its own live map,
 * but it is a number produced by a client that can be decompiled. The figure
 * that counts is derived here, from the points themselves, using the very same
 * engine the app uses — imported directly from cfpi/src/core so the two cannot
 * drift apart.
 */
function recomputeCoverage(jobId: string, track: InspectionRecord['track']) {
  const job = store.job(jobId);
  if (!job) return { pct: 0, flags: [] as CoverageFlag[] };

  const tracker = new CoverageTracker(
    job.asset.geometry,
    job.asset.segment_boundaries_m,
    job.inspection_rules,
  );
  for (const p of track) tracker.addFix(p);
  return { pct: tracker.coveragePct(), flags: tracker.activeFlags() };
}

/**
 * Liveness probe.
 *
 * Public and unauthenticated on purpose — a health check that needs a token
 * cannot tell a platform whether the process is up. It reports nothing an
 * anonymous caller could not already infer from the server answering.
 */
app.get('/v1/healthz', (_req, res) => {
  res.json({ ok: true, jobs: store.jobs().length, at: new Date().toISOString() });
});

/* ------------------------------------------------------------------- auth */

app.post('/v1/auth/token', (req, res) => {
  const { username, password, device_id } = req.body ?? {};
  const user = store.userByLogin(String(username ?? ''), String(password ?? ''));
  if (!user) {
    // One message for both wrong-username and wrong-password, so the response
    // cannot be used to enumerate accounts.
    return problem(res, 401, 'Sign in failed', 'Username or password is incorrect.');
  }
  const session = issue(user, device_id);
  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'Bearer',
    expires_in: session.expires_in,
    inspector: publicUser(user),
  });
});

app.post('/v1/auth/refresh', (req, res) => {
  const session = rotate(String(req.body?.refresh_token ?? ''));
  if (!session) {
    return problem(res, 401, 'Session expired', 'Sign in again.');
  }
  const user = store.user(session.user_id)!;
  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'Bearer',
    expires_in: session.expires_in,
    inspector: publicUser(user),
  });
});

app.post('/v1/auth/logout', (req, res) => {
  store.removeSession(String(req.body?.refresh_token ?? ''));
  res.status(204).end();
});

app.get('/v1/auth/me', requireAuth(), (req: AuthedRequest, res) => {
  res.json(publicUser(req.user!));
});

/* --------------------------------------------------------------- guards */

/**
 * Everything past this point needs a signed-in user.
 *
 * Path-mounted rather than repeated on each route, so a new endpoint is
 * protected by default instead of by remembering to add it.
 *
 * The console is supervisor-only: approving an inspection, scheduling work and
 * closing a drain are decisions, not field actions.
 */
app.use('/v1/jobs', requireAuth());
app.use('/v1/inspections', requireAuth());
app.use('/v1/checklist-templates', requireAuth());
app.use('/v1/console', requireAuth('supervisor'));

/**
 * `/v1/uploads` is deliberately NOT bearer-protected.
 *
 * It stands in for object storage, and a presigned URL is self-authenticating —
 * the capability is in the URL, which is why S3 requires you *not* to send an
 * Authorization header with it. Guarding this with a bearer token would make
 * CFPI's upload path diverge from the one it will use in production.
 *
 * Instead the presign step mints a single-use, short-lived token and the upload
 * route checks that.
 */
const uploadTokens = new Map<string, { attachment_id: string; expires_at: number }>();
const UPLOAD_TTL_MS = 60 * 60_000;

function mintUploadToken(attachmentId: string): string {
  const t = randomUUID().replace(/-/g, '');
  uploadTokens.set(t, { attachment_id: attachmentId, expires_at: Date.now() + UPLOAD_TTL_MS });
  return t;
}

function consumeUploadToken(t: string, attachmentId: string): boolean {
  const entry = uploadTokens.get(t);
  if (!entry) return false;
  if (entry.expires_at < Date.now() || entry.attachment_id !== attachmentId) {
    uploadTokens.delete(t);
    return false;
  }
  // Single use — a leaked URL cannot be replayed to overwrite the evidence.
  uploadTokens.delete(t);
  return true;
}

/* ------------------------------------------------------------------- jobs */

/**
 * Statuses an inspector can act on.
 *
 * FRCDE is the brain: it decides what needs inspecting and sends only that.
 * CFPI is a field tool, not a copy of the asset register — a drain that is
 * approved, awaiting review, cancelled or expired has no business appearing on
 * a handset, and filtering it out here rather than in the app means the app
 * cannot get it wrong.
 *
 * A rejected inspection returns its job to `accepted`, so it reappears in this
 * set automatically and lands back on the inspector's list.
 */
const DISPATCHABLE = ['available', 'accepted', 'in_progress'];

app.get('/v1/jobs', (req, res) => {
  const status = req.query.status ? String(req.query.status).split(',') : DISPATCHABLE;
  const since = req.query.updated_since ? String(req.query.updated_since) : null;

  let jobs = store.jobs().filter((j) => status.includes(j.status));
  if (since) jobs = jobs.filter((j) => j.updated_at > since);

  res.json({ data: jobs, next_cursor: new Date().toISOString() });
});

app.get('/v1/jobs/:id', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');
  res.set('ETag', `"${job.version}"`).json(job);
});

app.post('/v1/jobs/:id/accept', (req: AuthedRequest, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');
  if (job.status !== 'available') {
    return problem(res, 409, 'Already claimed', `Job is ${job.status}.`);
  }

  // Optimistic concurrency: two inspectors can tap Accept at the same instant.
  const ifMatch = req.get('If-Match')?.replace(/"/g, '');
  if (ifMatch && Number(ifMatch) !== job.version) {
    return problem(res, 409, 'Version conflict', 'This job changed — refresh and retry.');
  }

  // Assignment comes from the token, never from the request body — otherwise
  // anyone could claim a job on someone else's behalf.
  res.json(store.updateJob(job.id, { status: 'accepted', assigned_inspector_id: req.user!.id }));
});

app.post('/v1/jobs/:id/release', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');
  res.json(store.updateJob(job.id, { status: 'available', assigned_inspector_id: null }));
});

/**
 * In-progress heartbeat.
 *
 * CFPI owns the authoritative state of an unfinished inspection — it must be
 * resumable with no connectivity at all. This endpoint exists so a supervisor
 * can still see "47%, paused 3 days ago" and chase it. Best-effort by design:
 * a failed heartbeat must never block an inspector in the field.
 */
app.post('/v1/jobs/:id/heartbeat', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');

  store.updateJob(job.id, {
    status: 'in_progress',
    heartbeat: {
      inspection_id: req.body.inspection_id,
      status: req.body.status ?? 'in_progress',
      coverage_pct: Number(req.body.coverage_pct ?? 0),
      updated_at: new Date().toISOString(),
    },
  });
  res.status(204).end();
});

/* ------------------------------------------------------------ inspections */

app.post('/v1/jobs/:id/inspections', (req: AuthedRequest, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');

  // Idempotent: the CFPI outbox retries, and a replayed create must not
  // produce a second inspection (contract §1.2).
  const existing = store.inspection(req.body.id);
  if (existing) return res.status(201).json(existing);

  // A drain already awaiting review must not accept another walk. Otherwise a
  // job left visible on a handset can be inspected a second time before anyone
  // has looked at the first, producing two submitted records for one visit.
  const awaitingReview = store
    .inspectionsForJob(job.id)
    .find((i) => i.status === 'submitted');
  if (awaitingReview) {
    return problem(
      res,
      409,
      'Already submitted',
      'An inspection of this drain is awaiting review. It will come back to you if it is sent back.',
    );
  }

  // A drain can only be walked once at a time. Any earlier attempt still open
  // was superseded, not completed — leaving it `in_progress` made a single
  // inspection appear in the console as several.
  for (const prior of store.inspectionsForJob(job.id)) {
    if (prior.status === 'in_progress') {
      prior.status = 'abandoned';
      store.saveInspection(prior);
    }
  }

  const rec: InspectionRecord = {
    id: req.body.id,
    job_id: job.id,
    inspector_id: req.user!.id,
    status: 'in_progress',
    started_at: req.body.started_at,
    ended_at: null,
    received_at: new Date().toISOString(),
    supersedes_inspection_id: req.body.supersedes_inspection_id ?? null,
    track: [],
    client_coverage: null,
    server_coverage_pct: null,
    flags: [],
    checklist: null,
    attachment_ids: [],
    review: null,
    override: null,
  };
  store.saveInspection(rec);
  store.updateJob(job.id, { status: 'in_progress' });
  res.status(201).json(rec);
});

app.post('/v1/inspections/:id/track', (req, res) => {
  const insp = store.inspection(req.params.id);
  if (!insp) return problem(res, 404, 'Inspection not found');

  const seen = new Set(insp.track.map((p) => p.seq));
  let accepted = 0;
  let duplicate = 0;

  for (const p of req.body.points ?? []) {
    if (seen.has(p.seq)) {
      duplicate++; // append-only and deduped on seq, so replays are free
      continue;
    }
    insp.track.push(p);
    seen.add(p.seq);
    accepted++;
  }
  insp.track.sort((a, b) => a.seq - b.seq);

  const { pct } = recomputeCoverage(insp.job_id, insp.track);
  insp.server_coverage_pct = pct;
  store.saveInspection(insp);

  res.status(202).json({
    accepted_points: accepted,
    duplicate_points: duplicate,
    server_coverage_pct: pct,
  });
});

app.post('/v1/inspections/:id/complete', (req, res) => {
  const insp = store.inspection(req.params.id);
  if (!insp) return problem(res, 404, 'Inspection not found');
  const job = store.job(insp.job_id);
  if (!job) return problem(res, 404, 'Job not found');

  const { pct, flags } = recomputeCoverage(insp.job_id, insp.track);
  const clientPct = req.body.coverage?.client_computed_pct ?? 0;
  const allFlags: CoverageFlag[] = [...flags];

  // A client reporting materially more coverage than the raw points support is
  // the signal worth catching here.
  const mismatch = Math.abs(clientPct - pct) > 5;

  const override = req.body.override ?? null;

  if (pct < job.inspection_rules.min_coverage_pct && !override) {
    return problem(
      res,
      422,
      'Coverage below threshold',
      `Server-computed coverage ${pct.toFixed(1)}% is below the required ${job.inspection_rules.min_coverage_pct}% and no override was supplied.`,
    );
  }

  // An override is an exception on the record, not a way around the rule — so it
  // must carry a reason, and evidence if the job demands it. A gate that will
  // not open is a fact about the drain worth keeping.
  if (override) {
    if (!override.reason_code) {
      return problem(res, 422, 'Override needs a reason', 'Supply reason_code.');
    }
    if (
      job.inspection_rules.require_photo_on_override &&
      !(override.photo_ids ?? []).length
    ) {
      return problem(
        res,
        422,
        'Override needs evidence',
        'This job requires a photograph with an override.',
      );
    }
    allFlags.push('override_used' as CoverageFlag);
  }

  Object.assign(insp, {
    status: 'submitted',
    ended_at: req.body.ended_at,
    client_coverage: req.body.coverage ?? null,
    server_coverage_pct: pct,
    flags: allFlags,
    checklist: req.body.checklist ?? null,
    attachment_ids: req.body.attachment_ids ?? [],
    override,
  });
  store.saveInspection(insp);
  store.updateJob(job.id, { status: 'submitted', heartbeat: null });

  res.json({
    inspection_id: insp.id,
    job_status: 'submitted',
    server_coverage_pct: pct,
    flags: mismatch ? [...allFlags, 'coverage_mismatch'] : allFlags,
  });
});

/* ----------------------------------------------------------- attachments */

/**
 * `/attachments/presign`, not `attachments:presign`.
 *
 * A colon inside a path segment is a Google API convention that fights URL
 * parsers: it needs escaping in the Express route, and clients differ on whether
 * to percent-encode it. React Native's fetch and Node's do not agree, so the
 * same code that worked from a test script 404s from the phone. A plain path
 * segment cannot go wrong.
 */
app.post('/v1/inspections/:id/attachments/presign', (req, res) => {
  // No object storage in a local mockup, so the "presigned URL" is just this
  // server. The three-step flow is preserved so CFPI's upload path is the real
  // one and swapping in S3 later changes only what this returns.
  const t = mintUploadToken(String(req.body.id));
  res.json({
    upload_url: `${req.protocol}://${req.get('host')}/v1/uploads/${req.body.id}?t=${t}`,
    expires_at: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
  });
});

app.put(
  '/v1/uploads/:id',
  express.raw({ type: '*/*', limit: '25mb' }),
  (req, res) => {
    if (!consumeUploadToken(String(req.query.t ?? ''), req.params.id)) {
      return problem(
        res,
        403,
        'Upload link invalid',
        'This upload link has expired or has already been used.',
      );
    }
    const out = createWriteStream(resolve(UPLOAD_DIR, `${req.params.id}.jpg`));
    out.end(req.body);
    const existing = store.attachment(req.params.id);
    if (existing) store.addAttachment({ ...existing, stored: true });
    res.status(200).json({ ok: true, byte_size: req.body?.length ?? 0 });
  },
);

app.post('/v1/inspections/:id/attachments', (req, res) => {
  const rec: AttachmentRecord = {
    id: req.body.id,
    inspection_id: req.params.id,
    kind: req.body.kind,
    source: req.body.source === 'library' ? 'library' : 'camera',
    captured_at: req.body.captured_at,
    lat: req.body.location?.lat ?? req.body.lat ?? null,
    lon: req.body.location?.lon ?? req.body.lon ?? null,
    chainage_m: req.body.chainage_m ?? null,
    checklist_field_id: req.body.checklist_field_id ?? null,
    caption: req.body.caption,
    sha256: req.body.sha256,
    byte_size: req.body.byte_size,
    stored: existsSync(resolve(UPLOAD_DIR, `${req.body.id}.jpg`)),
  };
  store.addAttachment(rec);
  res.status(201).json(rec);
});

app.use('/uploads', express.static(UPLOAD_DIR));

/* ----------------------------------------------------------- checklists */

/**
 * Serve the checklist schema (contract §6).
 *
 * Both CFPI and the console need it: the app to render the form, the console to
 * label the answers and group them into the sections the inspector saw. Without
 * it a submission reads as raw keys like `silt_depth_mm`.
 */
app.get('/v1/checklist-templates/:id', (_req, res) => {
  try {
    const path = resolve(here, '../../contracts/examples/checklist-template.json');
    res.json(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    problem(res, 404, 'Template not found');
  }
});

/* ------------------------------------------------- console-only endpoints */

app.get('/v1/console/overview', (_req, res) => {
  const jobs = store.jobs();
  const inspections = store.inspections();
  const now = Date.now();

  res.json({
    jobs,
    users: store.users().map(publicUser),
    work_orders: store.workOrders(),
    // Surfaced so the console can show the automation working, rather than
    // offering a button to do its job for it.
    scheduler: lastRun,
    inspections: inspections.map((i) => ({
      ...i,
      // The track can be thousands of points; the list view never needs it.
      track: undefined,
      track_points: i.track.length,
    })),
    stats: {
      total: jobs.length,
      available: jobs.filter((j) => j.status === 'available').length,
      in_progress: jobs.filter((j) => j.status === 'in_progress').length,
      submitted: jobs.filter((j) => j.status === 'submitted').length,
      approved: jobs.filter((j) => j.status === 'approved').length,
      overdue: jobs.filter(
        (j) => Date.parse(j.due_at) < now && !['approved', 'submitted'].includes(j.status),
      ).length,
      total_km: jobs.reduce((s, j) => s + j.asset.length_m, 0) / 1000,
    },
  });
});

app.get('/v1/console/jobs/:id', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');

  const inspections = store.inspectionsForJob(job.id).map((i) => {
    const inspector = i.inspector_id ? store.user(i.inspector_id) : null;
    // Rebuild coverage here rather than trusting anything stored, and hand the
    // console real geometry — a reviewer needs to see *where* the gap was, not
    // just that coverage was 71%.
    const tracker = new CoverageTracker(
      job.asset.geometry,
      job.asset.segment_boundaries_m,
      job.inspection_rules,
    );
    for (const p of i.track) tracker.addFix(p);

    const toLine = (ranges: [number, number][]) =>
      ranges.map((r) =>
        sliceAlignment(tracker.align, r[0], r[1]).map((p) => [p.lon, p.lat]),
      );

    return {
      ...i,
      inspector_name: inspector?.name ?? null,
      attachments: store.attachmentsFor(i.id),
      server_coverage_pct: tracker.coveragePct(),
      covered_lines: toLine(tracker.coveredRanges()),
      uncovered_lines: toLine(tracker.uncoveredRanges()),
      uncovered_ranges: tracker.uncoveredRanges(),
      track_line: i.track.map((p) => [p.lon, p.lat]),
      track_points: i.track.length,
    };
  });

  res.json({ job, inspections, work_orders: store.workOrdersForJob(job.id) });
});

app.post('/v1/console/inspections/:id/review', (req: AuthedRequest, res) => {
  const insp = store.inspection(req.params.id);
  if (!insp) return problem(res, 404, 'Inspection not found');

  const decision = req.body.decision as 'approved' | 'rejected';
  insp.status = decision;
  insp.review = {
    decision,
    reason: req.body.reason,
    at: new Date().toISOString(),
    by: req.user?.id ?? null,
  };
  store.saveInspection(insp);

  const job = store.job(insp.job_id);

  if (decision === 'approved' && job) {
    // Approval completes the cycle: record when it was inspected and set the
    // next due date from the asset's own interval. That is what makes the
    // scheduler self-sustaining rather than a list somebody maintains by hand.
    const cycle = cycleFor(job.asset.type);
    const inspectedAt = insp.ended_at ?? new Date().toISOString();
    store.updateJob(job.id, {
      status: 'approved',
      last_inspected_at: inspectedAt,
      due_at: new Date(Date.parse(inspectedAt) + cycle * 86_400_000).toISOString(),
      assigned_inspector_id: null,
      rejection_reason: null,
      superseded_inspection_id: null,
      heartbeat: null,
    });
  } else {
    // Rejection returns the job to the inspector — back into DISPATCHABLE, so it
    // reappears on the handset at the next sync. The rejected inspection is kept
    // in full; its replacement is a new record linked by
    // supersedes_inspection_id, so what was first reported stays answerable.
    store.updateJob(insp.job_id, {
      status: 'accepted',
      rejection_reason: req.body.reason ?? null,
      superseded_inspection_id: insp.id,
    });
  }
  res.json(insp);
});

/**
 * Manually put a drain into, or take it out of, the inspection queue.
 *
 * FRCDE is where inspection work is decided, so that decision has to be
 * available to a person and not only to the seed script. `dispatch` puts a
 * drain in front of inspectors; `close` takes it back out.
 */
app.post('/v1/console/jobs/:id/dispatch', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');
  if (['accepted', 'in_progress', 'submitted'].includes(job.status)) {
    return problem(
      res,
      409,
      'Already in progress',
      `This drain is ${job.status.replace(/_/g, ' ')} — resolve that first.`,
    );
  }

  // Clamped to the due window. Being in the queue *is* being due for
  // inspection, so a drain scheduled three weeks out would sit there
  // contradicting the label the console gives it.
  const requested = Number(req.body?.due_in_days ?? DUE_WINDOW_DAYS);
  const days = Math.max(0, Math.min(requested, DUE_WINDOW_DAYS));

  res.json(
    store.updateJob(job.id, {
      status: 'available',
      priority: req.body?.priority ?? job.priority,
      due_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      assigned_inspector_id: null,
      rejection_reason: null,
      superseded_inspection_id: null,
      heartbeat: null,
    }),
  );
});

app.post('/v1/console/jobs/:id/close', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');

  // Anything the inspector had open is no longer wanted. Mark it abandoned
  // rather than deleting it — the walk happened and stays on the record.
  for (const insp of store.inspectionsForJob(job.id)) {
    if (insp.status === 'in_progress') {
      insp.status = 'abandoned';
      store.saveInspection(insp);
    }
  }

  // Closing schedules the next routine inspection from the asset's own cycle
  // rather than leaving a stale deadline behind — otherwise a closed drain
  // keeps reading "overdue".
  res.json(
    store.updateJob(job.id, {
      status: 'approved',
      due_at: new Date(Date.now() + cycleFor(job.asset.type) * 86_400_000).toISOString(),
      assigned_inspector_id: null,
      rejection_reason: null,
      superseded_inspection_id: null,
      heartbeat: null,
    }),
  );
});

/**
 * Edit the site knowledge attached to a drain.
 *
 * Access notes and hazards are the two fields that exist purely to reach the
 * person standing at the gate — "key from the depot before 08:00" saves a wasted
 * trip. They belong to the asset rather than to any one inspection, so they
 * persist across jobs and land on the handset at the next sync.
 *
 * `updateJob` bumps the job version, so CFPI picks the change up like any other.
 */
app.patch('/v1/console/jobs/:id/asset', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return problem(res, 404, 'Job not found');

  const asset = { ...job.asset };
  if (typeof req.body?.access_notes === 'string') {
    asset.access_notes = req.body.access_notes.trim();
  }
  if (Array.isArray(req.body?.hazards)) {
    // Normalised to lower snake_case so the same hazard typed two ways does not
    // become two tags, and deduplicated.
    asset.hazards = [
      ...new Set(
        req.body.hazards
          .map((h: unknown) => String(h).trim().toLowerCase().replace(/\s+/g, '_'))
          .filter(Boolean),
      ),
    ] as string[];
  }

  res.json(store.updateJob(job.id, { asset }));
});

/* ---------------------------------------------------------- scheduling */

/**
 * Queue every closed drain that has come due.
 *
 * This is the function that makes FRCDE a scheduler. A drain's next inspection
 * is set from its own cycle when the last one is approved; this sweeps up
 * anything that has since fallen inside the window and puts it in front of
 * inspectors — no one has to remember.
 *
 * Idempotent: running it twice queues nothing extra, so it is safe on a timer,
 * on startup, and on a button.
 */
interface SchedulerRun {
  last_run_at: string;
  queued: string[];
  checked: number;
}

let lastRun: SchedulerRun = { last_run_at: new Date(0).toISOString(), queued: [], checked: 0 };

function runScheduler(): SchedulerRun {
  const cutoff = Date.now() + DUE_WINDOW_DAYS * 86_400_000;
  const queued: string[] = [];
  let checked = 0;

  for (const job of store.jobs()) {
    if (['available', 'accepted', 'in_progress', 'submitted'].includes(job.status)) continue;
    checked++;
    if (Date.parse(job.due_at) > cutoff) continue;

    store.updateJob(job.id, {
      status: 'available',
      assigned_inspector_id: null,
      rejection_reason: null,
      superseded_inspection_id: null,
      heartbeat: null,
    });
    queued.push(job.reference);
  }

  lastRun = { last_run_at: new Date().toISOString(), queued, checked };
  if (queued.length) {
    console.log(`[scheduler] queued ${queued.length} drain(s) that came due: ${queued.join(', ')}`);
  }
  return lastRun;
}

/**
 * Sweep on a timer, not on a button.
 *
 * Hourly is far more often than needed — due dates move in days — but it is
 * effectively free at this scale and means the queue is never more than an hour
 * stale. Combined with the sweep on startup, a server that was off over a
 * weekend catches up by itself.
 */
const SCHEDULER_INTERVAL_MS = 60 * 60_000;
setInterval(runScheduler, SCHEDULER_INTERVAL_MS);

/**
 * Manual trigger, kept for tests and for the rare "I have just changed the cycle
 * policy, sweep now" case. The console does not surface it — a supervisor should
 * not have to remember to run the scheduler.
 */
app.post('/v1/console/schedule/run', (_req, res) => {
  res.json(runScheduler());
});

/* --------------------------------------------------------- work orders */

/**
 * Raise remediation off the back of an inspection.
 *
 * An inspection that finds a blockage and produces nothing but a record is how
 * inspectors learn their findings do not matter.
 */
app.post('/v1/console/work-orders', (req: AuthedRequest, res) => {
  const job = store.job(String(req.body?.job_id ?? ''));
  if (!job) return problem(res, 404, 'Job not found');

  const detail = String(req.body?.detail ?? '').trim();
  if (!detail) return problem(res, 422, 'Detail required', 'Say what needs doing.');
  if (!String(req.body?.assigned_to ?? '').trim()) {
    return problem(res, 422, 'Officer required', 'Name who this is routed to.');
  }

  // The console asks for a description, not a title — a one-line summary for
  // list views is derivable from it, and asking twice for the same thing is how
  // forms get abandoned.
  const title = String(req.body?.title ?? '').trim() || detail.split('\n')[0].slice(0, 70);

  const order: WorkOrder = {
    id: randomUUID(),
    job_id: job.id,
    inspection_id: req.body.inspection_id ?? null,
    title,
    assigned_to: String(req.body.assigned_to).trim(),
    detail,
    severity: Math.min(5, Math.max(1, Number(req.body.severity ?? 3))) as WorkOrder['severity'],
    due_at: req.body.due_at ? new Date(req.body.due_at).toISOString() : null,
    chainage_m: req.body.chainage_m == null ? null : Number(req.body.chainage_m),
    status: 'open',
    raised_by: req.user!.id,
    raised_at: new Date().toISOString(),
    closed_at: null,
    attachment_ids: Array.isArray(req.body.attachment_ids) ? req.body.attachment_ids : [],
  };
  store.saveWorkOrder(order);
  res.status(201).json(order);
});

app.patch('/v1/console/work-orders/:id', (req, res) => {
  const order = store.workOrder(req.params.id);
  if (!order) return problem(res, 404, 'Work order not found');

  const status = req.body?.status as WorkOrder['status'] | undefined;
  if (status) {
    order.status = status;
    order.closed_at =
      status === 'done' || status === 'cancelled' ? new Date().toISOString() : null;
  }
  if (typeof req.body?.closing_note === 'string') order.closing_note = req.body.closing_note;
  if (typeof req.body?.assigned_to === 'string') order.assigned_to = req.body.assigned_to.trim();
  store.saveWorkOrder(order);
  res.json(order);
});

app.get('/v1/console/work-orders', (_req, res) => {
  res.json({ data: store.workOrders() });
});

app.post('/v1/console/reset', (_req, res) => {
  reset();
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- serve */

/**
 * In production, serve the built console from this same process.
 *
 * One service, one URL, one deployment — and no CORS between the console and
 * its API. In development Vite serves the console on its own port and proxies
 * `/v1` here instead, so this block simply does not apply.
 */
const WEB_DIR = resolve(here, '../dist');
const hasBuiltWeb = existsSync(resolve(WEB_DIR, 'index.html'));

if (hasBuiltWeb) {
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));
}

/**
 * Anything that is not an API route.
 *
 * A JSON 404 for `/v1/...` — Express's default HTML error page is reported by a
 * JSON client as a bare "404", indistinguishable from a real "job not found"
 * and pointing at a completely different fix. This names the path that missed.
 *
 * Everything else falls through to the console's index.html, because the
 * console owns client-side routes like `/jobs/:id` that the server has never
 * heard of. Without this, opening a job detail page directly — or refreshing
 * one — would 404.
 */
app.use((req, res) => {
  if (req.path.startsWith('/v1') || req.path.startsWith('/uploads')) {
    console.warn(`[404] no route for ${req.method} ${req.originalUrl}`);
    return problem(
      res,
      404,
      'No such endpoint',
      `${req.method} ${req.originalUrl} does not match any route on this server.`,
    );
  }
  if (hasBuiltWeb) return res.sendFile(resolve(WEB_DIR, 'index.html'));
  problem(res, 404, 'Not found', 'The console has not been built into this server.');
});

app.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  // Sweep on startup so a server left off over a weekend catches up rather than
  // waiting for the first hourly tick.
  runScheduler();

  if (hasBuiltWeb) {
    console.log(`FRCDE  →  http://localhost:${PORT}  (console + API)`);
  } else {
    console.log(`FRCDE API  →  http://localhost:${PORT}`);
  }
  if (lan) console.log(`On your network (for CFPI)  →  http://${lan}:${PORT}`);
});
