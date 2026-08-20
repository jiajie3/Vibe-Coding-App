/**
 * FRCDE API server.
 *
 * Implements the CFPI ↔ FRCDE contract (docs/api-contract.md) against a local
 * JSON store. Binds to 0.0.0.0 so a phone on the same Wi-Fi can reach it, and
 * deploys as a single service serving both the API and the console.
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
import * as ai from './ai.ts';
import { hashPassword, hashPasswordSync, needsRehash, verifyPassword } from './password.ts';
import { knownChannels, partyForChannel, suggestChannel } from './routing.ts';
import * as slack from './slack.ts';
import { cycleFor, DUE_WINDOW_DAYS, load, reset, store, UPLOAD_DIR } from './store.ts';
import type { AttachmentRecord, InspectionRecord, WorkOrder } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

/**
 * Verified against when the username does not exist, so a sign-in attempt costs
 * the same either way. Without it, response timing distinguishes a real account
 * from an unknown one and hands an attacker a user list.
 */
const DUMMY_HASH = hashPasswordSync('unused-placeholder');

load();

const app = express();
app.use(cors());

/**
 * Slack signs the raw bytes of its requests, so this must be mounted before the
 * JSON parser. Parsing and re-serialising changes the bytes — whitespace, key
 * order, unicode escaping — and the signature then never matches, which reads
 * as "Slack is broken" rather than "we destroyed the evidence".
 */
app.use('/v1/slack', express.raw({ type: '*/*', limit: '2mb' }));
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

app.post('/v1/auth/token', async (req, res) => {
  const { username, password, device_id } = req.body ?? {};
  const user = store.userByUsername(String(username ?? ''));

  // One message for both wrong-username and wrong-password, so the response
  // cannot be used to enumerate accounts. The hash is still computed when the
  // username is unknown, so the two cases take the same time.
  const deny = () =>
    problem(res, 401, 'Sign in failed', 'Username or password is incorrect.');

  const ok = await verifyPassword(
    String(password ?? ''),
    user?.password ?? DUMMY_HASH,
  );
  if (!user || !ok) return deny();

  // Upgrade a record written before hashing existed, or under weaker cost
  // parameters. Doing it here means the migration happens without anyone
  // running one, and only for accounts actually in use.
  if (needsRehash(user.password)) {
    store.setPassword(user.id, await hashPassword(String(password)));
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

/* ------------------------------------------------------------ ai review */

/** Load the checklist template, so answers can be labelled rather than keyed. */
function checklistTemplate(): {
  sections?: {
    fields?: {
      id: string;
      label?: string;
      type: string;
      options?: { value: string; label: string }[];
    }[];
  }[];
} | null {
  try {
    return JSON.parse(
      readFileSync(resolve(here, '../../contracts/examples/checklist-template.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

/**
 * Assemble what the reviewer gets to see.
 *
 * The coverage figures come from `recomputeCoverage`, not from anything the
 * handset claimed — the model is shown the number that governs, and told not to
 * dispute it.
 */
function reviewInputFor(insp: InspectionRecord): ai.ReviewInput | null {
  const job = store.job(insp.job_id);
  if (!job) return null;

  const tmpl = checklistTemplate();
  const fields = new Map<
    string,
    { label?: string; type: string; options?: { value: string; label: string }[] }
  >();
  for (const sec of tmpl?.sections ?? []) {
    for (const f of sec.fields ?? []) {
      fields.set(f.id, { label: f.label, type: f.type, options: f.options });
    }
  }

  const answers = insp.checklist?.answers ?? {};
  const checklist: ai.ChecklistAnswer[] = Object.entries(answers).map(([id, answer]) => ({
    id,
    label: fields.get(id)?.label ?? id.replace(/_/g, ' '),
    type: fields.get(id)?.type ?? 'text',
    answer,
    options: fields.get(id)?.options,
  }));

  const tracker = new CoverageTracker(
    job.asset.geometry,
    job.asset.segment_boundaries_m,
    job.inspection_rules,
  );
  for (const p of insp.track) tracker.addFix(p);

  /** The answer a photograph was filed against, in the words the form used. */
  const answerFor = (fieldId?: string | null): string | undefined => {
    if (!fieldId) return undefined;
    const raw = (answers as Record<string, unknown>)[fieldId];
    if (raw === undefined) return undefined;
    const f = fields.get(fieldId);
    const label = (v: unknown) => f?.options?.find((o) => o.value === v)?.label ?? String(v);
    if (Array.isArray(raw)) return raw.length ? raw.map(label).join(', ') : 'none selected';
    if (raw === true) return 'Yes';
    if (raw === false) return 'No';
    return label(raw);
  };

  const photos = (insp.attachment_ids ?? [])
    .map((id) => store.attachment(id))
    .filter((a): a is AttachmentRecord => Boolean(a?.stored))
    .map((a) => ({
      id: a.id,
      caption: a.caption,
      chainage_m: a.chainage_m,
      path: resolve(UPLOAD_DIR, `${a.id}.jpg`),
      source: a.source,
      field_label: a.checklist_field_id
        ? fields.get(a.checklist_field_id)?.label ?? a.checklist_field_id
        : undefined,
      field_answer: answerFor(a.checklist_field_id),
    }));

  return {
    reference: job.reference,
    asset: { name: job.asset.name, type: job.asset.type },
    min_coverage_pct: job.inspection_rules.min_coverage_pct,
    coverage: {
      server_pct: insp.server_coverage_pct ?? 0,
      client_pct: insp.client_coverage?.client_computed_pct ?? null,
      flags: insp.flags ?? [],
      uncovered_ranges: tracker.uncoveredRanges().map(
        ([a, b]) => [Number(a.toFixed(0)), Number(b.toFixed(0))] as [number, number],
      ),
    },
    checklist,
    photos,
    override_reason: (insp as { override?: { note?: string } }).override?.note ?? null,
  };
}

/**
 * Run the check and keep the result.
 *
 * Only ever on request. Reviewing every submission automatically spent money on
 * inspections nobody had opened yet, and put a verdict in front of a supervisor
 * before they had formed their own — which is the wrong order for something
 * advisory. A reviewer asks for it when they want a second opinion.
 *
 * Stored rather than recomputed, so it costs one call and can still be
 * explained later by the model and prompt version recorded with it.
 */
async function runAiReview(inspectionId: string): Promise<void> {
  const insp = store.inspection(inspectionId);
  if (!insp) return;
  const input = reviewInputFor(insp);
  if (!input) return;
  try {
    const review = await ai.reviewInspection(input);
    const fresh = store.inspection(inspectionId);
    if (!fresh) return;
    fresh.ai_review = review;
    store.saveInspection(fresh);
    console.log(`[ai] ${input.reference}: ${review.verdict}`);
  } catch (e) {
    console.warn('[ai] review failed outright:', (e as Error).message);
  }
}

/**
 * Re-run a review by hand.
 *
 * For when the key arrives after the inspection did, or the prompt changes and
 * an old verdict is worth redoing. Supervisor-only, like everything under
 * /v1/console.
 */
app.post('/v1/console/inspections/:id/ai-review', async (req, res) => {
  const insp = store.inspection(req.params.id);
  if (!insp) return problem(res, 404, 'Inspection not found');
  await runAiReview(insp.id);
  res.json(store.inspection(insp.id)?.ai_review ?? null);
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
app.post('/v1/console/work-orders', async (req: AuthedRequest, res) => {
  const job = store.job(String(req.body?.job_id ?? ''));
  if (!job) return problem(res, 404, 'Job not found');

  const detail = String(req.body?.detail ?? '').trim();
  if (!detail) return problem(res, 422, 'Detail required', 'Say what needs doing.');

  /**
   * Who this went to, derived from the channel when it was not typed.
   *
   * The console asks for a channel rather than a name now: picking `#nea` says
   * the same thing as typing "NEA", and asking for both invites them to
   * disagree. The stored name still reads as an organisation so the follow-up
   * list does not turn into a column of channel handles.
   */
  const channel = String(req.body?.slack_channel ?? '').trim();
  const assignedTo =
    String(req.body?.assigned_to ?? '').trim() ||
    partyForChannel(channel) ||
    channel ||
    '';
  if (!assignedTo) {
    return problem(
      res,
      422,
      'Nowhere to route',
      'Choose a channel to open the case in, or name who it goes to.',
    );
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
    assigned_to: assignedTo,
    detail,
    severity: Math.min(5, Math.max(1, Number(req.body.severity ?? 3))) as WorkOrder['severity'],
    due_at: req.body.due_at ? new Date(req.body.due_at).toISOString() : null,
    chainage_m: req.body.chainage_m == null ? null : Number(req.body.chainage_m),
    status: 'open',
    raised_by: req.user!.id,
    raised_at: new Date().toISOString(),
    closed_at: null,
    acknowledged_at: null,
    attachment_ids: Array.isArray(req.body.attachment_ids) ? req.body.attachment_ids : [],
  };

  // Open the case in Slack before replying, so the console can show the channel
  // it actually landed in. A failure here must not lose the work order — the
  // record is the point, and Slack is a notification.
  if (channel) {
    try {
      const view = caseView(order);
      if (view) {
        const posted = await slack.postCase(channel, view);
        order.slack = { channel: posted.channel, ts: posted.ts };
        await postEvidence(order, publicBase(req));
      }
    } catch (e) {
      console.warn('[slack] could not open the case:', (e as Error).message);
    }
  }

  store.saveWorkOrder(order);
  res.status(201).json(order);
});

app.patch('/v1/console/work-orders/:id', (req, res) => {
  const order = store.workOrder(req.params.id);
  if (!order) return problem(res, 404, 'Work order not found');

  const was = order.status;
  const status = req.body?.status as WorkOrder['status'] | undefined;

  /**
   * Rejecting a reported-complete case, as opposed to merely starting work.
   *
   * The same status change means two different things depending on where it
   * came from, and only one of them is news the contractor needs.
   */
  const sendingBack = was === 'awaiting_verification' && status === 'in_progress';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (sendingBack) {
    if (!note) {
      return problem(
        res,
        422,
        'Say why',
        'Sending work back without a reason leaves them guessing, and the usual '
          + 'result is the same work reported complete again.',
      );
    }
    order.sent_back_note = note;
    // It is no longer complete. Leaving the timestamp would have the follow-up
    // list claim it was finished on a date it was not.
    order.completed_at = null;
  }
  if (status) {
    order.status = status;
    order.closed_at =
      status === 'done' || status === 'cancelled' ? new Date().toISOString() : null;
    // Record who signed it off. "Closed" with nobody's name against it is the
    // kind of record that cannot answer a question a year later.
    if (status === 'done') {
      order.verified_by = (req as AuthedRequest).user?.name ?? 'the supervisor';
    }
  }
  if (typeof req.body?.closing_note === 'string') order.closing_note = req.body.closing_note;
  if (typeof req.body?.assigned_to === 'string') order.assigned_to = req.body.assigned_to.trim();
  store.saveWorkOrder(order);
  // A channel still showing buttons on a case closed from the console invites
  // someone to close it a second time.
  void syncCase(order);
  // Tell the contractor too. Being checked and signed off — or told what was
  // wrong — is the half of the loop they otherwise never see.
  if (order.slack) {
    if (status === 'done') {
      void slack
        .replyInThread(
          order.slack.channel,
          order.slack.ts,
          `Checked and closed by ${order.verified_by}. Thanks.`,
        )
        .catch(() => {});
    } else if (sendingBack) {
      void slack
        .replyInThread(
          order.slack.channel,
          order.slack.ts,
          `:leftwards_arrow_with_hook: *Sent back* — ${order.sent_back_note}`,
        )
        .catch(() => {});
    }
  }
  res.json(order);
});

app.get('/v1/console/work-orders', (_req, res) => {
  res.json({ data: store.workOrders() });
});

app.post('/v1/console/reset', (_req, res) => {
  reset();
  res.json({ ok: true });
});


/* --------------------------------------------------------------- slack */

/**
 * A work order as Slack needs to see it.
 *
 * Slack is given the asset and the inspection reference, not just an id: the
 * person reading the channel does not have FRCDE open, and should not need to
 * click anything to know whether the case is theirs.
 */
function caseView(order: WorkOrder): slack.CaseView | null {
  const job = store.job(order.job_id);
  if (!job) return null;
  return {
    id: order.id,
    title: order.title,
    detail: order.detail,
    assigned_to: order.assigned_to,
    severity: order.severity,
    due_at: order.due_at,
    chainage_m: order.chainage_m,
    asset_name: job.asset.name,
    reference: job.reference,
    status: order.status,
    acknowledged_at: order.acknowledged_at,
    closing_note: order.closing_note,
    blocked_reason: order.blocked_reason,
    completion_photos: order.completion_attachment_ids?.length ?? 0,
  };
}

/**
 * Where Slack should fetch photographs from.
 *
 * Slack renders an image by fetching the URL itself, so this has to be an
 * address reachable from the internet — `localhost` silently renders nothing.
 * Set FRCDE_PUBLIC_URL on any deployment; the request's own host is the right
 * guess everywhere else.
 */
function publicBase(req: express.Request): string {
  const configured = (process.env.FRCDE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

/**
 * Send the inspector's own photographs into the case thread.
 *
 * The contractor is being asked to fix something they never saw. "Approx 260 mm
 * silt" is a good deal less useful than the photograph of it, and attaching them
 * up front saves the round of messages that otherwise asks for them.
 */
async function postEvidence(order: WorkOrder, base: string): Promise<void> {
  if (!order.slack) return;
  const shots = (order.attachment_ids ?? [])
    .map((id) => store.attachment(id))
    .filter((a): a is AttachmentRecord => Boolean(a?.stored));
  if (shots.length === 0) return;

  try {
    await slack.postThreadImages(
      order.slack.channel,
      order.slack.ts,
      shots.map((a) => ({
        url: `${base}/uploads/${a.id}.jpg`,
        caption:
          a.caption ||
          (a.chainage_m != null ? `Chainage ${Math.round(a.chainage_m)} m` : 'From the inspection'),
      })),
      `*From the inspection* — ${shots.length} photograph${shots.length === 1 ? '' : 's'}.`,
    );
  } catch (e) {
    console.warn('[slack] could not attach inspection photos:', (e as Error).message);
  }
}

/** Repaint the posted card. Never throws — Slack being down is not our outage. */
async function syncCase(order: WorkOrder): Promise<void> {
  if (!order.slack) return;
  const view = caseView(order);
  if (!view) return;
  try {
    await slack.updateCase(order.slack.channel, order.slack.ts, view);
  } catch (e) {
    console.warn('[slack] could not repaint the case:', (e as Error).message);
  }
}

/**
 * Which channel should this go to?
 *
 * Asked while the supervisor is still filling in the form, so the answer can be
 * shown before they commit to it. Returns the reasoning and the alternatives
 * rather than a bare channel — see routing.ts for why.
 */
app.post('/v1/console/slack/suggest', (req, res) => {
  const job = store.job(String(req.body?.job_id ?? ''));
  res.json({
    suggestion: suggestChannel({
      assigned_to: String(req.body?.assigned_to ?? ''),
      severity: Number(req.body?.severity ?? 3),
      geometry: job?.asset.geometry ?? null,
      asset_name: job?.asset.name,
    }),
    channels: knownChannels(),
    // The name each channel will be recorded under. Sent so the console shows
    // the same words the work order will store, rather than deriving something
    // similar from the channel handle and quietly disagreeing with it.
    labels: Object.fromEntries(
      knownChannels().map((c) => [c, partyForChannel(c) ?? c.replace(/^#/, '')]),
    ),
    slack_configured: slack.isConfigured(),
  });
});

/**
 * Everything Slack sends back.
 *
 * Public by necessity — Slack holds no session — so the signature is the entire
 * access control, and it is checked before the body is even looked at.
 *
 * Slack gives an app three seconds before showing the user a timeout, so this
 * answers immediately and does the work afterwards. The alternative is a
 * contractor being told an action failed when it in fact succeeded, and
 * pressing the button again.
 */
app.post('/v1/slack/interactions', (req, res) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (
    !slack.verifyRequest(
      raw,
      req.header('x-slack-request-timestamp'),
      req.header('x-slack-signature'),
    )
  ) {
    return problem(res, 401, 'Bad signature', slack.rejectionReason());
  }

  const i = slack.parseInteraction(raw.toString('utf8'));
  if (!i) return problem(res, 400, 'Unreadable payload');

  const order = i.caseId ? store.workOrder(i.caseId) : null;
  if (!order) {
    // 200 regardless: a case removed from FRCDE leaves its buttons behind in the
    // channel, and an error renders in Slack as an alarming failure for
    // something the contractor can do nothing about.
    res.status(200).json({ text: 'That case no longer exists in FRCDE.' });
    return;
  }

  const who = i.userName ?? 'someone';
  const now = new Date().toISOString();

  if (i.type === 'block_actions') {
    if (i.actionId === 'case_ack') {
      res.status(200).end();
      if (order.acknowledged_at) return; // already acknowledged, nothing to record
      order.acknowledged_at = now;
      if (order.status === 'open') order.status = 'in_progress';
      store.saveWorkOrder(order);
      void syncCase(order);
      if (order.slack) {
        void slack
          .replyInThread(order.slack.channel, order.slack.ts, `Acknowledged by ${who}.`)
          .catch(() => {});
      }
      return;
    }

    if (i.actionId === 'case_done' || i.actionId === 'case_blocked') {
      res.status(200).end();

      /**
       * Acknowledgement is enforced here, not only by withholding the buttons.
       *
       * Cards already posted keep whatever buttons they were rendered with, so a
       * message from before the case was picked up — or from before this rule
       * existed — still carries a working Completed. Repainting makes those
       * stale buttons disappear, which is both the refusal and the explanation.
       */
      if (!order.acknowledged_at) {
        void syncCase(order);
        void slack
          .respondEphemeral(i.responseUrl, 'Acknowledge this case before closing it.')
          .catch(() => {});
        return;
      }

      /**
       * Completion needs evidence, and the evidence has to arrive first.
       *
       * Slack modals cannot take a file, so the photograph comes in as a thread
       * message and is filed by the events handler. Refusing here — rather than
       * accepting a bare note — is what stops a case being closed on an
       * assertion, which is the whole reason a supervisor still checks it.
       */
      if (i.actionId === 'case_done' && (order.completion_attachment_ids?.length ?? 0) === 0) {
        void slack
          .respondEphemeral(
            i.responseUrl,
            'Post a photograph of the completed work in this thread first, then press Completed again.',
          )
          .catch(() => {});
        return;
      }

      const kind = i.actionId === 'case_done' ? 'done' : 'blocked';
      void slack
        .openModal(i.triggerId ?? '', slack.closeModal(kind, order.id))
        .catch((e) => console.warn('[slack] modal failed:', (e as Error).message));
      return;
    }

    res.status(200).end();
    return;
  }

  if (i.type === 'view_submission') {
    /**
     * Both rules again at submission, not only on the button.
     *
     * The modal is opened by one request and submitted by another, and anything
     * can happen in between — the case can be sent back, or the modal can have
     * been sitting open since before the photograph requirement applied.
     * Checking only where the modal is opened guards the door and leaves the
     * window open.
     */
    if (
      i.callbackId === 'case_done_submit' &&
      (order.completion_attachment_ids?.length ?? 0) === 0
    ) {
      res.status(200).json({
        response_action: 'errors',
        errors: { note: 'Post a photograph of the completed work in this thread first.' },
      });
      void syncCase(order);
      return;
    }

    if (!order.acknowledged_at) {
      // `response_action: errors` keeps the modal open and shows this against
      // the field, which is the only way to say anything to someone mid-modal.
      res.status(200).json({
        response_action: 'errors',
        errors: { note: 'Acknowledge this case before closing it.' },
      });
      void syncCase(order);
      return;
    }

    // An empty 200 is what closes the modal; anything else leaves it hanging.
    res.status(200).json({});

    const note = (i.value ?? '').trim();
    let reply: string;

    if (i.callbackId === 'case_done_submit') {
      /**
       * Finished, but not closed.
       *
       * A work order on public infrastructure closed on the word of the party
       * paid to do the work is not a record anyone can stand behind. The
       * contractor says they are done and sends the photographs; FRCDE holds it
       * until a supervisor has looked.
       */
      order.status = 'awaiting_verification';
      order.completed_at = now;
      order.closed_at = null;
      order.closing_note = note || `Reported complete in Slack by ${who}.`;
      const n = order.completion_attachment_ids?.length ?? 0;
      reply =
        `Marked complete by ${who} with ${n} photograph${n === 1 ? '' : 's'}. ` +
        'Now with the supervisor to check.';
    } else if (i.callbackId === 'case_blocked_submit') {
      // Not a closed case. Someone still has to act, so it stays in the console
      // follow-up list rather than quietly disappearing from it.
      order.status = 'blocked';
      order.closed_at = null;
      order.blocked_reason = note || `Reported blocked in Slack by ${who}.`;
      reply = `${who} cannot complete this: ${order.blocked_reason}`;
    } else {
      return;
    }

    store.saveWorkOrder(order);
    void syncCase(order);
    // The card repaints in place, which is easy to miss in a busy channel. The
    // thread is where the conversation is, and where a notification lands.
    if (order.slack) {
      void slack.replyInThread(order.slack.channel, order.slack.ts, reply).catch(() => {});
    }
    return;
  }

  res.status(200).end();
});

/**
 * Events — subscribed to for one thing: photographs posted in a case thread.
 *
 * Completion evidence has to end up in FRCDE. Left in Slack it lives under the
 * workspace retention policy, which on the free plan discards history after 90
 * days, and evidence of works on public infrastructure should outlive a chat
 * subscription.
 */
app.post('/v1/slack/events', (req, res) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (
    !slack.verifyRequest(
      raw,
      req.header('x-slack-request-timestamp'),
      req.header('x-slack-signature'),
    )
  ) {
    return problem(res, 401, 'Bad signature', slack.rejectionReason());
  }

  let body: { type?: string; challenge?: string; event?: Record<string, any> };
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return problem(res, 400, 'Unreadable payload');
  }

  // Slack proves the endpoint is ours by asking it to echo a challenge.
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  res.status(200).end();

  const event = body.event;
  if (!event || event.type !== 'message' || event.bot_id) return;
  const files: Record<string, any>[] = Array.isArray(event.files) ? event.files : [];
  if (files.length === 0 || !event.thread_ts) return;

  const order = store.workOrders().find((w) => w.slack?.ts === event.thread_ts);
  if (!order) return;

  void (async () => {
    for (const f of files) {
      try {
        const bytes = await slack.downloadFile(f.url_private_download ?? f.url_private);
        if (!bytes) continue;
        const id = randomUUID();
        createWriteStream(resolve(UPLOAD_DIR, `${id}.jpg`)).end(bytes);
        const rec: AttachmentRecord = {
          id,
          inspection_id: order.inspection_id ?? '',
          kind: 'completion',
          source: 'library',
          captured_at: new Date(
            (Number(event.ts) || Date.now() / 1000) * 1000,
          ).toISOString(),
          lat: null,
          lon: null,
          chainage_m: order.chainage_m,
          caption: slack.isConfigured()
            ? String(f.title ?? 'Posted in the Slack case thread')
            : 'Simulated — no Slack workspace is connected',
          byte_size: bytes.length,
          stored: true,
        };
        store.addAttachment(rec);
        order.completion_attachment_ids = [
          ...(order.completion_attachment_ids ?? []),
          id,
        ];
      } catch (e) {
        console.warn('[slack] could not file an attachment:', (e as Error).message);
      }
    }
    store.saveWorkOrder(order);
  })();
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
