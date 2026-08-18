/**
 * Job repository.
 *
 * Three layers, in priority order:
 *
 *   1. Jobs synced from FRCDE and cached on disk — the real data.
 *   2. The bundled OSM seed file — so a fresh install with no server configured
 *      still shows something to look at.
 *
 * The cache is what makes the app usable in a culvert: jobs are downloaded
 * before the inspector leaves and read from disk thereafter. Nothing in the UI
 * knows or cares which layer it got.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { Job } from '../core/types.ts';
import { api } from '../services/api.ts';
import { isConfigured } from '../services/config.ts';
import { hasQueuedWork } from '../services/outbox.ts';
import seed from '../../assets/seed-jobs.json';

const BUNDLED = seed as unknown as Job[];

let memo: Job[] | null = null;

function cacheFile(): File {
  const dir = new Directory(Paths.document, 'cache');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, 'jobs.json');
}

function readCache(): Job[] | null {
  try {
    const f = cacheFile();
    if (!f.exists) return null;
    const parsed = JSON.parse(f.textSync()) as Job[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(jobs: Job[]): void {
  try {
    const f = cacheFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(jobs));
  } catch (e) {
    console.warn('[jobs] cache write failed', e);
  }
}

/**
 * Statuses this device has set but the server has not yet confirmed.
 *
 * The device can legitimately be ahead of the server: an inspection submitted
 * with no signal sits in the outbox for hours while FRCDE still reports the job
 * as `accepted`. Believing the server there would put the job back in the
 * inspector's list and invite them to walk the same drain twice.
 *
 * Only statuses *this device produced* count. An earlier version compared
 * against whatever was in the local cache, which on a fresh install is the
 * bundled demo seed — so jobs marked `approved` in that file silently
 * outranked the server's `available` and vanished from the list.
 */
type Overrides = Record<string, string>;
let overrides: Overrides | null = null;

const RANK: Record<string, number> = {
  available: 0,
  accepted: 1,
  in_progress: 2,
  submitted: 3,
  approved: 4,
  rejected: 4,
  cancelled: 5,
  expired: 5,
};

function overrideFile(): File {
  const dir = new Directory(Paths.document, 'cache');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, 'status-overrides.json');
}

function getOverrides(): Overrides {
  if (overrides) return overrides;
  try {
    const f = overrideFile();
    overrides = f.exists ? (JSON.parse(f.textSync()) as Overrides) : {};
  } catch {
    overrides = {};
  }
  return overrides;
}

function saveOverrides(next: Overrides): void {
  overrides = next;
  try {
    const f = overrideFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(next));
  } catch (e) {
    console.warn('[jobs] override save failed', e);
  }
}

function mergeWithLocal(remote: Job): Job {
  const ov = getOverrides();
  const pending = ov[remote.id];
  if (!pending) return remote;

  // An override protects work still sitting in the outbox. Two things end that:
  // the server catching up, or there being no queued work left for the job.
  //
  // The second condition matters more than it looks. Rank alone assumes the
  // server only ever moves forward — but it can move backwards, when FRCDE is
  // reset or a job is reopened. An override written before such a move would
  // otherwise never clear, and the job would stay invisible on the handset
  // forever with nothing to explain why.
  const serverCaughtUp = (RANK[remote.status] ?? 0) >= (RANK[pending] ?? 0);
  if (serverCaughtUp || !hasQueuedWork(remote.id)) {
    const next = { ...ov };
    delete next[remote.id];
    saveOverrides(next);
    return remote;
  }
  return { ...remote, status: pending as Job['status'] };
}

export function getJobs(): Job[] {
  if (memo) return memo;
  memo = readCache() ?? BUNDLED;
  return memo;
}

/** Drop the in-memory copy so the next read comes from disk (or the bundle). */
export function clearJobCache(): void {
  memo = null;
  overrides = null;
}

/** True when we are showing bundled demo data rather than anything from FRCDE. */
export function isUsingBundledData(): boolean {
  return readCache() === null;
}

/**
 * Pull the current job list from FRCDE.
 *
 * Failure is not an error condition — it is the normal state in the field. The
 * cached list stays in place and the caller decides whether to mention it.
 */
export async function syncJobs(): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!isConfigured()) return { ok: false, count: 0, error: 'No server configured' };
  try {
    const { data } = await api.listJobs();
    const merged = data.map(mergeWithLocal);
    writeCache(merged);
    memo = merged;
    return { ok: true, count: merged.length };
  } catch (e) {
    return {
      ok: false,
      count: getJobs().length,
      error: e instanceof Error ? e.message : 'Sync failed',
    };
  }
}

export function getJob(id: string): Job | undefined {
  return getJobs().find((j) => j.id === id);
}

/** Locally record a status change, so the UI reacts before the server confirms. */
export function patchJob(id: string, patch: Partial<Job>): void {
  const jobs = getJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return;
  jobs[i] = { ...jobs[i], ...patch };
  memo = [...jobs];
  writeCache(memo);

  // Remember that *we* set this, so the next sync does not undo it while the
  // change is still queued in the outbox.
  if (patch.status) saveOverrides({ ...getOverrides(), [id]: patch.status });
}

/** Jobs an inspector can act on, most urgent first. */
export function actionableJobs(): Job[] {
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return getJobs()
    .filter((j) => ['available', 'accepted', 'in_progress'].includes(j.status))
    .sort(
      (a, b) =>
        rank[a.priority] - rank[b.priority] ||
        Date.parse(a.due_at) - Date.parse(b.due_at),
    );
}
