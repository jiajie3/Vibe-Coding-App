/**
 * Binds the coverage engine to live GPS, to React state, and to disk.
 *
 * The engine lives in a ref, not in state: it is mutated on every fix and
 * re-rendering the map on each mutation would be far too expensive. Only the
 * derived values the UI actually paints are lifted into state.
 *
 * An inspection is not a single sitting — see `pause` and the restore effect.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { CoverageTracker } from '../core/coverage.ts';
import { chainageToLatLon, project, sliceAlignment } from '../core/geo.ts';
import type { CoverageFlag, Fix, Job, TrackPoint } from '../core/types.ts';
import { uuidv7 } from '../core/uuid.ts';
import {
  beginSession,
  getSession,
  hydrateSession,
  setCoverage as setSessionCoverage,
  setPosition,
  useSession,
} from '../state/session.ts';
import {
  IS_EXPO_GO,
  onFix,
  requestPermissions,
  startTracking,
  stopTracking,
} from '../services/locationTask.ts';
import { loadInspection, saveInspection } from '../services/persistence.ts';
import { registerController } from '../state/activeInspection.ts';
import { api } from '../services/api.ts';
import { isConfigured } from '../services/config.ts';
import { enqueue } from '../services/outbox.ts';
import { patchJob } from '../data/jobs.ts';

/**
 * `paused` is a first-class state, not a variant of stopped.
 *
 * A paused inspection keeps its coverage, its answers and its photos, and can be
 * resumed days later. There is no "stopped" — an inspection either continues or
 * is submitted.
 */
export type InspectionStatus = 'idle' | 'running' | 'paused';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Persist every N accepted fixes, so a crash costs seconds of walking, not hours. */
const PERSIST_EVERY = 10;

/** Queue a track batch every N points, per contract §5.2. */
const TRACK_BATCH = 50;

export function useInspection(job: Job) {
  const trackerRef = useRef<CoverageTracker | null>(null);
  if (trackerRef.current === null) {
    trackerRef.current = new CoverageTracker(
      job.asset.geometry,
      job.asset.segment_boundaries_m,
      job.inspection_rules,
    );
  }
  const tracker = trackerRef.current;

  const seqRef = useRef(0);
  const pointsRef = useRef<TrackPoint[]>([]);
  const walkedRef = useRef<LatLng[]>([]);
  const statusRef = useRef<InspectionStatus>('idle');
  /** Handle for the dev simulator's timer. Must be cleared on pause. */
  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [status, setStatusState] = useState<InspectionStatus>('idle');
  const [coverage, setCoverage] = useState(0);
  const [coveredPaths, setCoveredPaths] = useState<LatLng[][]>([]);
  const [walkedPath, setWalkedPath] = useState<LatLng[]>([]);
  const [lastFix, setLastFix] = useState<Fix | null>(null);
  const [chainage, setChainage] = useState<number | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [flags, setFlags] = useState<CoverageFlag[]>([]);

  const session = useSession();

  const setStatus = useCallback((s: InspectionStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  /** Rebuild the green overlay polylines from the engine's covered ranges. */
  const repaint = useCallback(() => {
    setCoveredPaths(
      tracker.coveredRanges().map((r) =>
        sliceAlignment(tracker.align, r[0], r[1]).map((p) => ({
          latitude: p.lat,
          longitude: p.lon,
        })),
      ),
    );
  }, [tracker]);

  /** Index into pointsRef of the first point not yet queued for upload. */
  const syncedRef = useRef(0);
  const batchSeqRef = useRef(0);

  /**
   * Queue everything walked since the last flush.
   *
   * Batched rather than per-fix: one HTTP request per GPS point would be absurd,
   * and the server deduplicates on `seq` anyway, so a replayed batch is free.
   */
  const flushTrack = useCallback(() => {
    const s = getSession();
    if (!s.inspection_id) return;
    const pending = pointsRef.current.slice(syncedRef.current);
    if (pending.length === 0) return;

    enqueue('track', job.id, s.inspection_id, {
      batch_seq: ++batchSeqRef.current,
      points: pending,
    });
    syncedRef.current = pointsRef.current.length;
  }, [job.id]);

  /**
   * Best-effort progress ping so FRCDE can show "47%, paused 3 days ago".
   *
   * Deliberately *not* queued. A heartbeat delivered an hour late is worse than
   * none — it would overwrite a fresher figure with a stale one. If it fails,
   * it fails.
   */
  const heartbeat = useCallback(
    (state: 'in_progress' | 'paused') => {
      const s = getSession();
      if (!s.inspection_id || !isConfigured()) return;
      void api
        .heartbeat(job.id, {
          inspection_id: s.inspection_id,
          status: state,
          coverage_pct: tracker.coveragePct(),
        })
        .catch(() => {});
    },
    [job.id, tracker],
  );

  const persist = useCallback(() => {
    const s = getSession();
    if (!s.inspection_id) return;
    saveInspection({
      version: 1,
      job_id: job.id,
      inspection_id: s.inspection_id,
      started_at: s.started_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: statusRef.current === 'running' ? 'in_progress' : 'paused',
      coverage_state: tracker.serialise(),
      coverage_pct: tracker.coveragePct(),
      walked_path: walkedRef.current,
      answers: s.answers,
      photos: s.photos,
      seq: seqRef.current,
    });
  }, [job.id, tracker]);

  /* ------------------------------------------------ restore a saved session */

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    const saved = loadInspection(job.id);
    if (!saved) return;

    tracker.restore(saved.coverage_state);
    seqRef.current = saved.seq;
    walkedRef.current = saved.walked_path;

    setWalkedPath(saved.walked_path);
    setCoverage(tracker.coveragePct());
    setFlags(tracker.activeFlags());
    repaint();

    hydrateSession(job, {
      inspection_id: saved.inspection_id,
      started_at: saved.started_at,
      answers: saved.answers,
      photos: saved.photos,
      coverage: tracker.summary(),
      flags: tracker.activeFlags(),
    });

    // Restored inspections always come back paused. Resuming GPS without the
    // inspector asking would start tracking someone who may be at their desk.
    setStatus('paused');
  }, [job, tracker, repaint, setStatus]);

  /**
   * Open a new inspection, once.
   *
   * Shared by `start` and `simulate` deliberately. They used to duplicate this,
   * and the simulator's copy created the local session but never queued the
   * `start` call — so the server never learned the inspection existed and every
   * later `track` and `complete` 404'd against an id it had never seen.
   */
  const beginIfIdle = useCallback((): string | null => {
    if (statusRef.current !== 'idle') return null;

    // Client-generated, before the server has heard of it, so photos and answers
    // can reference the inspection while offline (contract §1.1).
    const inspectionId = uuidv7();
    beginSession(job, inspectionId);

    enqueue('start', job.id, inspectionId, {
      id: inspectionId,
      started_at: new Date().toISOString(),
      // Re-inspection after a rejection is a *new* record linked to the old one,
      // never an edit of it. What was reported first has to stay answerable, and
      // the two walks have separate GPS tracks that would be meaningless merged.
      supersedes_inspection_id:
        (job as { superseded_inspection_id?: string | null }).superseded_inspection_id ??
        undefined,
    });

    return inspectionId;
  }, [job]);

  /* --------------------------------------------------------- fix ingestion */

  const ingest = useCallback(
    (fix: Fix) => {
      const result = tracker.addFix(fix);

      seqRef.current += 1;
      pointsRef.current.push({ ...fix, seq: seqRef.current });

      setLastFix(fix);
      setCoverage(result.coverage_pct);
      setFlags(result.flags);
      setRejected(result.accepted ? null : (result.reason ?? null));

      if (result.accepted) {
        setChainage(result.chainage_m ?? null);
        walkedRef.current = [...walkedRef.current, { latitude: fix.lat, longitude: fix.lon }];
        setWalkedPath(walkedRef.current);
        // Photos taken from here on are tagged with this position and chainage,
        // so FRCDE can place each one at the right point along the drain.
        setPosition(fix.lat, fix.lon, result.chainage_m ?? null);

        if (result.newly_covered.length) {
          repaint();
          // The checklist is reachable mid-walk and its submit button is gated
          // on coverage, so the session's figure must track the engine's.
          setSessionCoverage(tracker.summary(), result.flags);
        }
        if (seqRef.current % PERSIST_EVERY === 0) persist();
        if (pointsRef.current.length - syncedRef.current >= TRACK_BATCH) flushTrack();
      }
    },
    [tracker, repaint, persist, flushTrack],
  );

  useEffect(() => {
    if (status !== 'running') return;
    return onFix(ingest);
  }, [status, ingest]);

  /** Answers and photos change on other screens; keep the saved record current. */
  useEffect(() => {
    if (statusRef.current === 'idle') return;
    persist();
  }, [session.answers, session.photos, persist]);

  /* -------------------------------------------------------------- controls */

  const start = useCallback(async () => {
    const perm = await requestPermissions();
    if (!perm.ok) {
      Alert.alert(
        perm.reason === 'services_disabled' ? 'Location is off' : 'Permission needed',
        perm.reason === 'services_disabled'
          ? 'Turn on location services before starting an inspection.'
          : 'CFPI cannot verify the drain was walked without location access.',
      );
      return;
    }
    if (!perm.background) {
      Alert.alert(
        'Keep the screen on',
        IS_EXPO_GO
          ? 'Expo Go cannot track location in the background. Keep CFPI open and the ' +
            'screen unlocked while you walk, or tracking will pause and leave a gap.'
          : 'Background location was not granted, so tracking will pause if you lock ' +
            'the phone. Grant "Allow all the time" in settings, or keep CFPI open.',
      );
    }

    // Claiming a job is the one write that cannot be queued — two inspectors can
    // tap Accept at the same instant and only the server can arbitrate. If it
    // fails we carry on regardless: the inspector is standing at the drain, and
    // refusing to record their work because the Wi-Fi is out would be
    // indefensible. The queued `start` reaches FRCDE either way.
    if (statusRef.current === 'idle' && job.status === 'available' && isConfigured()) {
      try {
        await api.acceptJob(job.id, job.version);
        patchJob(job.id, { status: 'accepted' });
      } catch (e) {
        console.warn('[accept] proceeding unclaimed:', e);
      }
    }

    // Only mints a session on a genuinely fresh start. Resuming keeps the
    // original inspection id, so photos taken on day one still belong to it.
    beginIfIdle();

    await startTracking(job.reference);
    setStatus('running');
    heartbeat('in_progress');
    persist();
  }, [job, setStatus, persist, heartbeat, beginIfIdle]);

  /**
   * Pause without losing anything.
   *
   * Clearing the simulator timer here is essential: it is an independent source
   * of fixes, so stopping the GPS alone would leave it happily filling in
   * coverage after the inspector pressed pause.
   */
  const pause = useCallback(async () => {
    if (simTimerRef.current !== null) {
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    await stopTracking();
    setStatus('paused');
    setSessionCoverage(tracker.summary(), tracker.activeFlags());
    flushTrack();
    heartbeat('paused');
    persist();
  }, [tracker, setStatus, persist, flushTrack, heartbeat]);

  // Stop everything if the screen goes away without an explicit pause.
  useEffect(
    () => () => {
      if (simTimerRef.current !== null) clearInterval(simTimerRef.current);
      void stopTracking();
    },
    [],
  );

  // Let the checklist and submission screens end the walk without owning this
  // hook — see finaliseForSubmit().
  useEffect(
    () =>
      registerController({
        flushTrack,
        pause,
        isRunning: () => statusRef.current === 'running',
        chainageAt: (lat, lon) => {
          const p = project(tracker.align, lat, lon);
          // Outside the corridor the projection is meaningless — a photograph
          // taken in the depot car park should not be filed at chainage 0.
          return p.offset_m <= tracker.rules.corridor_tolerance_m ? p.chainage_m : null;
        },
      }),
    [flushTrack, pause, tracker],
  );

  /**
   * Development only: walk the drain without leaving the office.
   *
   * Emulators report a single static coordinate, which makes the whole coverage
   * flow untestable indoors. This replays fixes along the real alignment at
   * walking pace so start → cover → submit can be exercised end to end.
   */
  const simulate = useCallback(
    (opts: { step?: number; skipMiddle?: boolean } = {}) => {
      if (simTimerRef.current !== null) return;

      const step = opts.step ?? 12;
      const L = tracker.align.length_m;
      // Resume from wherever the existing coverage ends, so simulating after a
      // pause continues the walk rather than restarting it.
      let c = 0;
      let t = Date.now();

      // Same path as a real start, so the simulated run produces a real
      // inspection on the server rather than a local-only one.
      beginIfIdle();

      simTimerRef.current = setInterval(() => {
        if (c > L) {
          if (simTimerRef.current !== null) clearInterval(simTimerRef.current);
          simTimerRef.current = null;
          void pause();
          return;
        }
        const skip = opts.skipMiddle && c > L * 0.35 && c < L * 0.6;
        if (!skip) {
          const p = chainageToLatLon(tracker.align, Math.min(c, L));
          ingest({
            lat: p.lat + (Math.random() - 0.5) * 0.00004, // ~±2 m of jitter
            lon: p.lon + (Math.random() - 0.5) * 0.00004,
            acc: 4 + Math.random() * 6,
            spd: 1.2,
            t: new Date((t += (step / 1.2) * 1000)).toISOString(),
          });
        }
        c += step;
      }, 120);

      setStatus('running');
    },
    [tracker, ingest, job, pause, setStatus],
  );

  return {
    status,
    coverage,
    coveredPaths,
    walkedPath,
    lastFix,
    chainage,
    rejected,
    flags,
    canSubmit: coverage >= job.inspection_rules.min_coverage_pct,
    uncoveredRanges: tracker.uncoveredRanges(),
    /** Map a chainage back to a coordinate — used to navigate to a gap. */
    pointAt: (chainage: number) => chainageToLatLon(tracker.align, chainage),
    start,
    pause,
    simulate,
  };
}
