/**
 * The inspection currently in progress.
 *
 * Module-level rather than React context because the session outlives any one
 * screen: it is created on the map, added to in the camera, completed in the
 * checklist. Threading it through navigation params would mean serialising the
 * whole thing on every hop.
 *
 * In production this is a thin cache over SQLite. For the mockup it is memory
 * only — a force-close loses the session, which the coverage engine's
 * serialise/restore is designed to prevent once persistence lands.
 */

import { useSyncExternalStore } from 'react';

import type {
  Answers,
  CoverageFlag,
  CoverageSummary,
  Job,
} from '../core/types.ts';

export interface PhotoRecord {
  id: string;
  /** Local file URI. Uploaded to object storage via presigned URL (contract §7). */
  uri: string;
  /**
   * Which checklist field the photograph belongs to.
   *
   * In practice the template's photo field, always. Kept as a field rather than
   * assumed, because the checklist is served by FRCDE and a future template can
   * name that section whatever it likes.
   */
  field_id: string | null;
  captured_at: string;
  lat: number | null;
  lon: number | null;
  /** Distance along the drain — lets FRCDE place the photo on the right stretch. */
  chainage_m: number | null;
  sha256: string;
  byte_size: number;
  caption?: string;
}

export interface SessionState {
  job: Job | null;
  inspection_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  coverage: CoverageSummary | null;
  flags: CoverageFlag[];
  answers: Answers;
  photos: PhotoRecord[];
  /** Last accepted position, so photos can be tagged without re-projecting. */
  last_position: { lat: number; lon: number; chainage_m: number | null } | null;
}

const EMPTY: SessionState = {
  job: null,
  inspection_id: null,
  started_at: null,
  ended_at: null,
  coverage: null,
  flags: [],
  answers: {},
  photos: [],
  last_position: null,
};

let state: SessionState = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getSession(): SessionState {
  return state;
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSession,
    getSession,
  );
}

// ------------------------------------------------------------- mutations

export function beginSession(job: Job, inspectionId: string) {
  state = {
    ...EMPTY,
    job,
    inspection_id: inspectionId,
    started_at: new Date().toISOString(),
  };
  listeners.forEach((l) => l());
}

/**
 * Live coverage, updated while the inspector walks.
 *
 * The checklist is reachable mid-inspection, and its submit button is gated on
 * coverage — so the figure has to be current, not only written at the end.
 */
export function setCoverage(coverage: CoverageSummary, flags: CoverageFlag[]) {
  set({ coverage, flags });
}

/**
 * Stamp the moment the inspection was submitted.
 *
 * Called at submission rather than at pause: an inspection paused on Monday and
 * finished on Thursday ended on Thursday. Nothing was setting this at all, so
 * every submission reached FRCDE with a null end time — no submitted timestamp
 * and no time on site.
 */
export function finishSession() {
  set({ ended_at: new Date().toISOString() });
}

/**
 * Restore a session saved on a previous day.
 *
 * `started_at` is deliberately kept from the original record: an inspection
 * spread over three visits started on the first of them, and the elapsed span is
 * something FRCDE may want to see.
 */
export function hydrateSession(
  job: Job,
  restored: {
    inspection_id: string;
    started_at: string;
    answers: Answers;
    photos: PhotoRecord[];
    coverage: CoverageSummary | null;
    flags: CoverageFlag[];
  },
) {
  state = {
    ...EMPTY,
    job,
    inspection_id: restored.inspection_id,
    started_at: restored.started_at,
    answers: restored.answers,
    photos: restored.photos,
    coverage: restored.coverage,
    flags: restored.flags,
  };
  listeners.forEach((l) => l());
}

export function setPosition(lat: number, lon: number, chainage_m: number | null) {
  set({ last_position: { lat, lon, chainage_m } });
}

export function setAnswer(fieldId: string, value: Answers[string]) {
  set({ answers: { ...state.answers, [fieldId]: value } });
}

export function addPhoto(photo: PhotoRecord) {
  set({ photos: [...state.photos, photo] });
}

export function removePhoto(id: string) {
  set({ photos: state.photos.filter((p) => p.id !== id) });
}

/** How many photos are attached to each field — the shape validate() wants. */
export function photoCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of state.photos) {
    if (p.field_id) counts[p.field_id] = (counts[p.field_id] ?? 0) + 1;
  }
  return counts;
}

export function resetSession() {
  state = EMPTY;
  listeners.forEach((l) => l());
}
