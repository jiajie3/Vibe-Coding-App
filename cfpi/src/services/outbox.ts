/**
 * Sync outbox (contract §8).
 *
 * Every write CFPI makes goes in here first and reaches FRCDE later. The app is
 * never blocked on the network: an inspector completes a job in a culvert, walks
 * back to the van, and the queue drains itself.
 *
 * Two rules do most of the work:
 *
 *  1. **Order is a hard dependency.** `complete` references attachment ids that
 *     must already exist server-side, and both reference an inspection that must
 *     have been created. So the queue drains strictly in order and stops at the
 *     first transient failure rather than skipping ahead.
 *
 *  2. **Permanent failures must not be retried.** A 400 will fail identically
 *     forever; a naive retry loop spins until the battery dies. Those items move
 *     to a dead-letter state, stay visible in the sync screen, and wait for a
 *     human. Nothing is ever silently discarded — losing a finished inspection
 *     means someone drives back to the site.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { uuidv7 } from '../core/uuid.ts';
import { ApiError, api, uploadBytes } from './api.ts';
import { isSignedIn } from './auth.ts';
import { isConfigured } from './config.ts';

export type OutboxKind = 'start' | 'track' | 'attachment' | 'complete';

export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  job_id: string;
  inspection_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  /** Epoch ms; the item is not eligible before this. */
  next_attempt_at: number;
  last_error?: string;
  state: 'pending' | 'dead';
}

const MAX_BACKOFF_MS = 5 * 60_000;

let queue: OutboxItem[] = [];
let loaded = false;
let draining = false;

const listeners = new Set<() => void>();
export function onOutboxChange(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const notify = () => listeners.forEach((l) => l());

/* ------------------------------------------------------------ persistence */

function file(): File {
  const dir = new Directory(Paths.document, 'outbox');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, 'queue.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const f = file();
    queue = f.exists ? (JSON.parse(f.textSync()) as OutboxItem[]) : [];
  } catch {
    queue = [];
  }
}

function save(): void {
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(queue));
  } catch (e) {
    console.warn('[outbox] save failed', e);
  }
  notify();
}

/* ------------------------------------------------------------------ enqueue */

export function enqueue(
  kind: OutboxKind,
  jobId: string,
  inspectionId: string,
  payload: Record<string, unknown>,
): OutboxItem {
  load();
  const item: OutboxItem = {
    // Stable id doubles as the idempotency key: a retry after a lost response
    // must not create a second inspection (contract §1.2).
    id: uuidv7(),
    kind,
    job_id: jobId,
    inspection_id: inspectionId,
    payload,
    created_at: new Date().toISOString(),
    attempts: 0,
    next_attempt_at: 0,
    state: 'pending',
  };
  queue.push(item);
  save();
  void drain();
  return item;
}

/* -------------------------------------------------------------- inspection */

export function stats() {
  load();
  return {
    pending: queue.filter((i) => i.state === 'pending').length,
    dead: queue.filter((i) => i.state === 'dead').length,
    total: queue.length,
  };
}

export function items(): OutboxItem[] {
  load();
  return [...queue];
}

/**
 * Is anything still waiting to reach FRCDE for this job?
 *
 * Dead items count: the work exists and has not been delivered, so the device is
 * still ahead of the server. Used to decide whether a locally-set job status is
 * still protecting something real.
 */
export function hasQueuedWork(jobId: string): boolean {
  load();
  return queue.some((i) => i.job_id === jobId);
}

/** Put dead-lettered items back in the queue — after the cause has been fixed. */
export function retryDead(): void {
  load();
  for (const i of queue) {
    if (i.state === 'dead') {
      i.state = 'pending';
      i.attempts = 0;
      i.next_attempt_at = 0;
    }
  }
  save();
  void drain();
}

export function clearDead(): void {
  load();
  queue = queue.filter((i) => i.state !== 'dead');
  save();
}

/* --------------------------------------------------------------- draining */

async function send(item: OutboxItem): Promise<void> {
  switch (item.kind) {
    case 'start':
      await api.startInspection(item.job_id, item.payload);
      return;

    case 'track':
      await api.postTrack(item.inspection_id, item.payload);
      return;

    case 'attachment': {
      // Three steps, one queue item: presign, PUT the bytes, confirm. Splitting
      // them across items would let `complete` overtake a half-uploaded photo.
      const p = item.payload as {
        id: string;
        uri: string;
        byte_size: number;
        sha256: string;
        meta: Record<string, unknown>;
      };
      const { upload_url } = await api.presign(item.inspection_id, {
        id: p.id,
        content_type: 'image/jpeg',
        byte_size: p.byte_size,
        sha256: p.sha256,
      });
      await uploadBytes(upload_url, p.uri);
      await api.confirmAttachment(item.inspection_id, { id: p.id, ...p.meta });
      return;
    }

    case 'complete':
      await api.complete(item.inspection_id, item.payload);
      return;
  }
}

export async function drain(): Promise<{ sent: number; failed: number }> {
  load();
  if (draining || !isConfigured() || !isSignedIn()) return { sent: 0, failed: 0 };
  draining = true;

  let sent = 0;
  let failed = 0;

  try {
    while (true) {
      const item = queue.find((i) => i.state === 'pending');
      if (!item) break;
      if (Date.now() < item.next_attempt_at) break; // backing off; preserve order

      try {
        await send(item);
        queue = queue.filter((i) => i.id !== item.id);
        sent++;
        save();
      } catch (e) {
        item.attempts++;
        // Keep the HTTP status: "404 Job not found" and "422 Coverage below
        // threshold" need completely different fixes, and a bare message hides
        // which one you are looking at.
        item.last_error =
          e instanceof ApiError
            ? `${e.status || 'network'}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        failed++;

        const kind = e instanceof ApiError ? e.kind : 'transient';

        // Nobody is signed in. The work is fine; hold the whole queue and let it
        // drain after sign-in rather than dead-lettering an inspector's day
        // because their token lapsed overnight.
        if (kind === 'auth') {
          item.next_attempt_at = Date.now() + 30_000;
          save();
          break;
        }

        if (kind === 'permanent' || kind === 'conflict') {
          // Will never succeed as-is. Park it where a human can see it.
          item.state = 'dead';

          // Everything queued behind it for the same inspection depends on it —
          // a `track` or `complete` for an inspection that was never created
          // will 404 forever. Fail them together with an honest reason rather
          // than letting the real cause scroll off the top of the list.
          if (item.kind === 'start') {
            for (const dep of queue) {
              if (dep.inspection_id === item.inspection_id && dep.id !== item.id) {
                dep.state = 'dead';
                dep.last_error = 'Blocked: the inspection was never created on FRCDE';
              }
            }
          }
          save();
          continue; // the next item may be for a different inspection
        }

        // Exponential backoff with jitter, capped.
        const backoff = Math.min(2 ** item.attempts * 1000, MAX_BACKOFF_MS);
        item.next_attempt_at = Date.now() + backoff + Math.random() * 1000;
        save();
        break; // stop here — later items may depend on this one
      }
    }
  } finally {
    draining = false;
  }

  return { sent, failed };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Periodic drain, so a queue that backed off eventually gets another go. */
export function startAutoDrain(intervalMs = 20_000): () => void {
  if (timer) return () => {};
  timer = setInterval(() => {
    if (stats().pending > 0) void drain();
  }, intervalMs);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
