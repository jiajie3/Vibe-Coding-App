/**
 * Wipe everything CFPI has stored on this device.
 *
 * Resetting FRCDE alone is not enough: the handset keeps its own cached job
 * list, part-finished inspections, queued outbox items and photo files. Left
 * behind, they point at jobs the server no longer recognises and produce 404s
 * that look like a broken integration rather than stale state.
 *
 * The server address is deliberately kept — having to retype an IP after every
 * reset is exactly the friction that stops people resetting when they should.
 */

import { Directory, Paths } from 'expo-file-system';

import { clearJobCache } from '../data/jobs.ts';
import { resetSession } from '../state/session.ts';

const DIRS = ['cache', 'inspections', 'outbox', 'inspection-photos'];

export interface ResetReport {
  removed: string[];
  failed: string[];
}

export function resetLocalData(): ResetReport {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const name of DIRS) {
    try {
      const dir = new Directory(Paths.document, name);
      if (dir.exists) {
        dir.delete();
        removed.push(name);
      }
    } catch (e) {
      console.warn(`[reset] could not delete ${name}`, e);
      failed.push(name);
    }
  }

  // In-memory state has to go too, or the next render serves what we just
  // deleted from disk.
  clearJobCache();
  resetSession();

  return { removed, failed };
}
