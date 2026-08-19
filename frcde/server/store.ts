/**
 * FRCDE data store.
 *
 * A JSON file, loaded into memory and written back on change. Deliberately not a
 * database: this is a local mockup, nothing queries across inspections, and a
 * file you can open in an editor is far easier to reason about while the schema
 * is still moving. The seam is narrow enough that swapping in Postgres later
 * touches only this module.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { hashPasswordSync } from './password.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Answers,
  CoverageFlag,
  CoverageSummary,
  Job,
  TrackPoint,
} from '../../cfpi/src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../data');
const DB_PATH = resolve(DATA_DIR, 'db.json');
const SEED_PATH = resolve(here, '../../contracts/examples/seed-jobs.json');

export const UPLOAD_DIR = resolve(DATA_DIR, 'uploads');

/**
 * What CFPI reports about an inspection still in progress.
 *
 * Deliberately tiny. The full coverage state — every covered segment, the walked
 * path, draft answers — lives on the handset and is never streamed here: the
 * inspector must be able to pause and resume with no signal at all, and writing
 * every GPS fix to a server nobody is watching would cost battery for nothing.
 * This is roughly 100 bytes, sent best-effort, purely so a supervisor can see
 * that a job is part-done and chase it.
 */
export interface Heartbeat {
  inspection_id: string;
  status: 'in_progress' | 'paused';
  coverage_pct: number;
  updated_at: string;
}

export interface AttachmentRecord {
  id: string;
  inspection_id: string;
  kind?: string;
  /**
   * `camera` was taken during the inspection; `library` was chosen from the
   * phone's album and carries only whatever EXIF it came with. Both are valid
   * evidence — they are not equally self-proving, so a reviewer is told which.
   */
  source?: 'camera' | 'library';
  captured_at: string;
  lat: number | null;
  lon: number | null;
  chainage_m: number | null;
  checklist_field_id?: string | null;
  caption?: string;
  sha256?: string;
  byte_size?: number;
  /** Set once the bytes have actually landed in uploads/. */
  stored: boolean;
}

export interface InspectionRecord {
  id: string;
  job_id: string;
  /** Who walked it. An inspection is evidence, and evidence needs an author. */
  inspector_id: string | null;
  /**
   * `abandoned` is set when a newer inspection opens on the same job. A drain
   * can only be walked once at a time, so an older attempt that never reached
   * submission was superseded rather than completed — keeping it as
   * `in_progress` forever made the console show one real inspection as several.
   */
  status: 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'abandoned';
  started_at: string;
  ended_at: string | null;
  received_at: string;
  supersedes_inspection_id: string | null;
  track: TrackPoint[];
  /** As reported by CFPI — advisory only. */
  client_coverage: CoverageSummary | null;
  /** Recomputed here from the raw track. This is the figure that governs. */
  server_coverage_pct: number | null;
  flags: CoverageFlag[];
  checklist: {
    template_id: string;
    template_version: number;
    answers: Answers;
  } | null;
  attachment_ids: string[];
  review: {
    decision: 'approved' | 'rejected';
    reason?: string;
    at: string;
    by: string | null;
  } | null;
  /**
   * Set when an inspector submits below the coverage threshold with a reason.
   * Real field work has locked gates and flooding; without a recorded exception
   * they either fake the walk or abandon the job.
   */
  override: {
    reason_code: string;
    notes?: string;
    photo_ids: string[];
  } | null;
}

export interface JobRecord extends Job {
  heartbeat: Heartbeat | null;
  /**
   * Set when a reviewer sends an inspection back. CFPI links its replacement to
   * it via `supersedes_inspection_id`, so both attempts stay auditable.
   */
  superseded_inspection_id?: string | null;
  /** When this drain was last inspected and approved — drives the next due date. */
  last_inspected_at?: string | null;
}

/* --------------------------------------------------------------- people */

export type Role = 'inspector' | 'supervisor';

export interface User {
  id: string;
  username: string;
  /**
   * scrypt hash, in the self-describing form produced by `password.ts`.
   *
   * Records written before hashing existed hold plain text; they still verify,
   * and are upgraded on the next successful sign-in.
   */
  password: string;
  name: string;
  role: Role;
  depot: string;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  user_id: string;
  /** Epoch ms. */
  expires_at: number;
  device_id?: string;
  issued_at: string;
}

/* ---------------------------------------------------------- work orders */

/**
 * `awaiting_verification` sits between the contractor saying they are finished
 * and FRCDE agreeing. Work on public infrastructure closed on the word of the
 * party paid to do it is not a record anyone can stand behind; a supervisor
 * looks at the photographs first.
 */
export type WorkOrderStatus =
  | 'open'
  | 'in_progress'
  | 'awaiting_verification'
  | 'done'
  | 'blocked'
  | 'cancelled';

/**
 * Remediation raised off the back of an inspection.
 *
 * Without this an inspection is a record of a problem that nobody is obliged to
 * fix — and inspectors notice when their findings go nowhere.
 */
export interface WorkOrder {
  id: string;
  job_id: string;
  inspection_id: string | null;
  title: string;
  /**
   * Who it has been routed to.
   *
   * Free text rather than a user id: the officer who fixes a drain is often not
   * a CFPI account — a contractor, a town council, another department. Naming
   * them beats forcing the choice into a list that does not contain them.
   */
  assigned_to: string;
  detail: string;
  severity: 1 | 2 | 3 | 4 | 5;
  /** When it needs to be done by. Drives the ordering of the follow-up list. */
  due_at: string | null;
  /** Where on the drain, so the crew can find it. */
  chainage_m: number | null;
  status: WorkOrderStatus;
  raised_by: string;
  raised_at: string;
  closed_at: string | null;
  closing_note?: string;
  /** Photos from the inspection that evidence the defect. */
  attachment_ids: string[];

  /**
   * When the party it was routed to said they had seen it.
   *
   * Separate from `status` because "nobody has looked at this" and "someone is
   * working on it" are the two states a chaser needs to tell apart, and the
   * gap between raising and acknowledgement is the number that shows whether
   * routing works at all.
   */
  acknowledged_at: string | null;

  /** Why it cannot be done. Set with status `blocked`, which needs a human. */
  blocked_reason?: string;

  /**
   * Where the case was opened in Slack.
   *
   * Kept so the message can be repainted when the status changes — a channel
   * still showing buttons on a case closed a week ago invites someone to close
   * it twice.
   */
  slack?: { channel: string; ts: string };

  /** Evidence the contractor posted in the case thread, as attachment ids. */
  completion_attachment_ids?: string[];

  /** When the contractor said it was finished. Distinct from `closed_at`. */
  completed_at?: string | null;
  /** Who signed it off in FRCDE, and when. */
  verified_by?: string;

  /**
   * Why it was last sent back for more work.
   *
   * Only the most recent one is kept here. The full back-and-forth lives in the
   * Slack thread, which is where the contractor is reading it — this exists so
   * the console can show why a case is round again without opening Slack.
   */
  sent_back_note?: string;
}

interface Db {
  jobs: JobRecord[];
  inspections: InspectionRecord[];
  attachments: AttachmentRecord[];
  users: User[];
  sessions: Session[];
  work_orders: WorkOrder[];
}

let db: Db;

const DAY = 86_400_000;

/**
 * The window that defines "due for inspection". Must match FLAG_WITHIN_DAYS in
 * the console — a drain in the queue but due in three weeks contradicts the
 * label the console puts on it.
 */
export const DUE_WINDOW_DAYS = 7;

/**
 * How often each kind of drain is inspected, in days.
 *
 * This is what makes FRCDE a scheduler rather than a list someone maintains by
 * hand: closing an inspection sets the next due date from the asset's own cycle,
 * and anything falling due inside the window is queued automatically.
 *
 * Real intervals would come from PUB's maintenance policy; these are plausible
 * stand-ins — bigger, more consequential assets are seen more often.
 */
export const INSPECTION_CYCLE_DAYS: Record<string, number> = {
  canal: 60,
  open_concrete_drain: 90,
  closed_box_culvert: 120,
  earth_drain: 120,
  roadside_scupper: 180,
};
export const DEFAULT_CYCLE_DAYS = 90;

export function cycleFor(assetType: string): number {
  return INSPECTION_CYCLE_DAYS[assetType] ?? DEFAULT_CYCLE_DAYS;
}

/**
 * When the queued drains fall due, in days from now.
 *
 * Every entry sits inside the due window, because being in the queue *means*
 * being due. One is already overdue and the rest spread across the week, so the
 * console's red/amber/grey states and its counters all have something real to
 * show.
 *
 * Add or remove entries to change how many drains reach the handset.
 */
const DISPATCH_DUE_DAYS = [-2, 0, 2, 4, 6];

/** Closed drains sit on a routine cycle, comfortably beyond the due window. */
const NEXT_CYCLE_MIN_DAYS = 21;
const NEXT_CYCLE_SPREAD_DAYS = 160;

/** Priority is derived from the deadline rather than invented separately. */
function priorityFor(days: number): Job['priority'] {
  if (days < 0) return 'urgent';
  if (days <= 2) return 'high';
  if (days <= DUE_WINDOW_DAYS) return 'normal';
  return 'low';
}

/**
 * Demo accounts.
 *
 * Passwords are hashed when the database is seeded, never stored as written
 * here. They are documented in the README because a demo nobody can sign into
 * is useless — but a public deployment should override them, which is what the
 * environment variables are for. Renaming or removing these is a one-line
 * change once real accounts exist.
 */
const SEED_ACCOUNTS: (Omit<User, 'password'> & { defaultPassword: string; envVar: string })[] = [
  {
    id: '018f0000-0000-7000-8000-000000000001',
    username: 'inspector',
    defaultPassword: 'inspector',
    envVar: 'FRCDE_INSPECTOR_PASSWORD',
    name: 'Field Inspector',
    role: 'inspector',
    depot: 'Jurong',
  },
  {
    id: '018f0000-0000-7000-8000-000000000002',
    username: 'siti',
    defaultPassword: 'siti',
    envVar: 'FRCDE_SITI_PASSWORD',
    name: 'Siti Rahmah',
    role: 'inspector',
    depot: 'Bedok',
  },
  {
    id: '018f0000-0000-7000-8000-000000000003',
    username: 'supervisor',
    defaultPassword: 'supervisor',
    envVar: 'FRCDE_SUPERVISOR_PASSWORD',
    name: 'Ops Supervisor',
    role: 'supervisor',
    depot: 'HQ',
  },
];

function seedUsers(): User[] {
  return SEED_ACCOUNTS.map(({ defaultPassword, envVar, ...rest }) => ({
    ...rest,
    password: hashPasswordSync(process.env[envVar]?.trim() || defaultPassword),
  }));
}

function seed(): Db {
  const jobs = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Job[];
  const now = Date.now();

  return {
    users: seedUsers(),
    sessions: [],
    work_orders: [],
    jobs: jobs.map((j, i) => {
      const queued = i < DISPATCH_DUE_DAYS.length;

      // Queued drains are due inside the window; closed ones are due beyond it.
      // The seed file's own dates are discarded — they were random, so a closed
      // drain could read "overdue by 3d", which is a deadline nobody owes.
      const days = queued
        ? DISPATCH_DUE_DAYS[i]
        : NEXT_CYCLE_MIN_DAYS +
          ((i * 37) % NEXT_CYCLE_SPREAD_DAYS); // deterministic, evenly spread

      return {
        ...j,
        status: queued ? ('available' as const) : ('approved' as const),
        priority: priorityFor(days),
        due_at: new Date(now + days * DAY).toISOString(),
        // Back-dated one full cycle before the due date, so the scheduler has a
        // coherent history to work from rather than every drain looking new.
        last_inspected_at: new Date(
          now + days * DAY - cycleFor(j.asset.type) * DAY,
        ).toISOString(),
        assigned_inspector_id: null,
        rejection_reason: null,
        superseded_inspection_id: null,
        heartbeat: null,
        version: 1,
        updated_at: new Date(now).toISOString(),
      };
    }),
    inspections: [],
    attachments: [],
  };
}

export function load(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });

  if (existsSync(DB_PATH)) {
    try {
      const loaded = JSON.parse(readFileSync(DB_PATH, 'utf8')) as Partial<Db>;
      // Tolerate a file written before these collections existed, rather than
      // discarding a demo's worth of inspections over a missing array.
      db = {
        jobs: loaded.jobs ?? [],
        inspections: loaded.inspections ?? [],
        attachments: loaded.attachments ?? [],
        users: loaded.users?.length ? loaded.users : seedUsers(),
        sessions: loaded.sessions ?? [],
        work_orders: loaded.work_orders ?? [],
      };
      if (db.jobs.length > 0) return;
    } catch {
      console.warn('[store] db.json unreadable, reseeding');
    }
  }
  db = seed();
  persist();
}

export function persist(): void {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

/** Wipe back to seed. Handy when a demo goes sideways. */
/**
 * Wipe the demo data back to seed.
 *
 * Sessions and users survive deliberately. Reseeding them signed out whoever
 * pressed the button, and the console reported the resulting 401 as "cannot
 * reach the API" — so a routine reset looked like the server had died.
 */
export function reset(): void {
  const sessions = db?.sessions ?? [];
  const users = db?.users ?? [];
  db = seed();
  db.sessions = sessions;
  if (users.length) db.users = users;
  persist();
}

export const store = {
  jobs: () => db.jobs,
  job: (id: string) => db.jobs.find((j) => j.id === id),

  /* ------------------------------------------------------------- people */
  users: () => db.users,
  user: (id: string) => db.users.find((u) => u.id === id),
  /**
   * Look up by username only. Verifying the password is the caller's job,
   * because doing it properly is asynchronous and must not block the loop.
   */
  userByUsername: (username: string) =>
    db.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase()),

  /** Replace a stored hash — used to upgrade legacy or weakly-parameterised ones. */
  setPassword(userId: string, hash: string) {
    const user = db.users.find((u) => u.id === userId);
    if (!user) return;
    user.password = hash;
    persist();
  },

  session: (accessToken: string) => db.sessions.find((s) => s.access_token === accessToken),
  sessionByRefresh: (refreshToken: string) =>
    db.sessions.find((s) => s.refresh_token === refreshToken),
  addSession(s: Session) {
    // Expired sessions are pruned lazily; nothing here runs a scheduler.
    db.sessions = db.sessions.filter((x) => x.expires_at > Date.now() - 60 * 86_400_000);
    db.sessions.push(s);
    persist();
  },
  removeSession(refreshToken: string) {
    db.sessions = db.sessions.filter((s) => s.refresh_token !== refreshToken);
    persist();
  },

  /* -------------------------------------------------------- work orders */
  workOrders: () => db.work_orders,
  workOrder: (id: string) => db.work_orders.find((w) => w.id === id),
  workOrdersForJob: (jobId: string) => db.work_orders.filter((w) => w.job_id === jobId),
  saveWorkOrder(w: WorkOrder) {
    const i = db.work_orders.findIndex((x) => x.id === w.id);
    if (i >= 0) db.work_orders[i] = w;
    else db.work_orders.push(w);
    persist();
  },
  inspections: () => db.inspections,
  inspection: (id: string) => db.inspections.find((i) => i.id === id),
  inspectionsForJob: (jobId: string) =>
    db.inspections.filter((i) => i.job_id === jobId),
  attachments: () => db.attachments,
  attachment: (id: string) => db.attachments.find((a) => a.id === id),
  attachmentsFor: (inspectionId: string) =>
    db.attachments.filter((a) => a.inspection_id === inspectionId),

  /**
   * Upsert by id.
   *
   * Named `addInspection` originally and used for updates as well as creates —
   * so every track batch, completion and review appended another copy of the
   * same record, and one inspection appeared in the console as several. The
   * name invited the mistake; `save` says what it does.
   */
  saveInspection(rec: InspectionRecord) {
    const i = db.inspections.findIndex((x) => x.id === rec.id);
    if (i >= 0) db.inspections[i] = rec;
    else db.inspections.push(rec);
    persist();
  },
  addAttachment(rec: AttachmentRecord) {
    const i = db.attachments.findIndex((a) => a.id === rec.id);
    if (i >= 0) db.attachments[i] = rec;
    else db.attachments.push(rec);
    persist();
  },
  /**
   * Mutate a job and bump its version.
   *
   * The version is the optimistic-concurrency token CFPI echoes back in
   * `If-Match` when claiming a job, so it must move on every write.
   */
  updateJob(id: string, patch: Partial<JobRecord>) {
    const job = db.jobs.find((j) => j.id === id);
    if (!job) return undefined;
    Object.assign(job, patch, {
      version: job.version + 1,
      updated_at: new Date().toISOString(),
    });
    persist();
    return job;
  },
};
