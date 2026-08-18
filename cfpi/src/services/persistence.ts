/**
 * On-device inspection persistence.
 *
 * An inspection is not a single sitting. An inspector can walk half a drain,
 * hit a locked gate, and come back three days later — the coverage they already
 * earned has to still be there. That means the session must survive the screen
 * unmounting, the app being killed, and the phone being rebooted.
 *
 * JSON files rather than SQLite: one small record per job, read and written
 * whole. The contract's outbox will need real tables eventually, but nothing
 * here queries across inspections, so a table would buy nothing today.
 *
 * The expo-file-system API is synchronous for these operations, which keeps the
 * call sites free of async plumbing on a hot path.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { Answers, CoverageFlag } from '../core/types.ts';
import type { PhotoRecord } from '../state/session.ts';

const DIR_NAME = 'inspections';

export interface PersistedInspection {
  /** Bump when the shape changes so stale records can be discarded, not crashed on. */
  version: 1;
  job_id: string;
  inspection_id: string;
  started_at: string;
  updated_at: string;
  status: 'in_progress' | 'paused';
  /** Exactly what CoverageTracker.serialise() produces. */
  coverage_state: {
    covered: number[];
    lastChainage: number | null;
    flags: CoverageFlag[];
  };
  coverage_pct: number;
  walked_path: { latitude: number; longitude: number }[];
  answers: Answers;
  photos: PhotoRecord[];
  seq: number;
}

function dir(): Directory {
  const d = new Directory(Paths.document, DIR_NAME);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function fileFor(jobId: string): File {
  return new File(dir(), `${jobId}.json`);
}

export function saveInspection(record: PersistedInspection): void {
  try {
    const file = fileFor(record.job_id);
    if (!file.exists) file.create();
    file.write(JSON.stringify({ ...record, updated_at: new Date().toISOString() }));
  } catch (e) {
    // Never let a failed write take down an inspection in progress — the
    // in-memory state is still correct and the next save may well succeed.
    console.warn('[persistence] save failed', e);
  }
}

export function loadInspection(jobId: string): PersistedInspection | null {
  try {
    const file = fileFor(jobId);
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as PersistedInspection;
    // A record written by an older build may not match the current shape.
    // Discarding it loses work; crashing on it loses the app.
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (e) {
    console.warn('[persistence] load failed', e);
    return null;
  }
}

export function deleteInspection(jobId: string): void {
  try {
    const file = fileFor(jobId);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn('[persistence] delete failed', e);
  }
}

/** Every unfinished inspection, for the "resume" badges on the job list. */
export function listInspections(): PersistedInspection[] {
  try {
    return dir()
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.json'))
      .map((f) => {
        try {
          const parsed = JSON.parse(f.textSync()) as PersistedInspection;
          return parsed.version === 1 ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter((r): r is PersistedInspection => r !== null);
  } catch {
    return [];
  }
}
