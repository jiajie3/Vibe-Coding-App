/**
 * Handle on the inspection currently open.
 *
 * There is exactly one at a time — that is a domain invariant, not an
 * implementation shortcut — so a module-level registry is honest here.
 *
 * It exists because the checklist and submission screens need to end the walk
 * (stop GPS, flush the remaining track) but do not own the hook that can. The
 * alternative, passing callbacks through navigation params, serialises badly and
 * breaks the moment a screen is restored.
 */

export interface InspectionController {
  /** Queue any track points not yet handed to the outbox. */
  flushTrack: () => void;
  /** Stop GPS, flush, persist. Safe to call when already paused. */
  pause: () => Promise<void>;
  isRunning: () => boolean;
  /**
   * Distance along the drain for an arbitrary coordinate, or null if it falls
   * outside the corridor.
   *
   * Needed for photographs chosen from the album: those were taken somewhere
   * else, at some other time, so the inspector's *current* position is the wrong
   * answer. If the file carries GPS EXIF we can place it properly instead.
   */
  chainageAt: (lat: number, lon: number) => number | null;
}

let controller: InspectionController | null = null;

export function registerController(c: InspectionController): () => void {
  controller = c;
  return () => {
    if (controller === c) controller = null;
  };
}

export function getController(): InspectionController | null {
  return controller;
}

/**
 * End the walk before submitting.
 *
 * Submission must not race the tracker. Without this, an inspector who fills in
 * the checklist mid-walk and taps Submit sends a `complete` while the last
 * batch of GPS points is still sitting on the device — the server then
 * recomputes coverage from an incomplete track, finds it below the threshold,
 * and rejects the whole inspection with a 422.
 */
export async function finaliseForSubmit(): Promise<void> {
  const c = controller;
  if (!c) return;
  if (c.isRunning()) await c.pause();
  else c.flushTrack();
}
