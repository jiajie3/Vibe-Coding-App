/**
 * Coverage engine.
 *
 * Answers the question the whole product exists to answer: did the inspector
 * actually walk this drain, end to end?
 *
 * Runs entirely on-device so the map can repaint within a frame of each GPS fix —
 * the inspector must find out about a 40 m gap while still standing there, not from
 * FRCDE the next morning. The figure it produces is advisory: FRCDE recomputes
 * coverage from the raw track and its number is authoritative (contract §1.4).
 */

import { buildAlignment, haversine, project } from './geo.ts';
import type { Alignment } from './geo.ts';
import type {
  CoverageFlag,
  CoverageSummary,
  Fix,
  FixResult,
  InspectionRules,
  LineString,
} from './types.ts';

const DEFAULT_MAX_BRIDGE_M = 50;

export class CoverageTracker {
  readonly align: Alignment;
  readonly boundaries: number[];
  readonly rules: InspectionRules;

  /** One flag per segment; index i spans boundaries[i]..boundaries[i+1]. */
  private covered: boolean[];
  private segLengths: number[];
  private totalLen: number;
  private coveredLen = 0;

  private lastChainage: number | null = null;
  private lastFix: Fix | null = null;
  private flags = new Set<CoverageFlag>();

  constructor(geometry: LineString, boundaries: number[], rules: InspectionRules) {
    if (boundaries.length < 2) {
      throw new Error('Need at least one segment (2 boundaries)');
    }
    this.align = buildAlignment(geometry);
    this.boundaries = boundaries;
    this.rules = rules;

    const n = boundaries.length - 1;
    this.covered = new Array(n).fill(false);
    this.segLengths = new Array(n);
    for (let i = 0; i < n; i++) {
      this.segLengths[i] = boundaries[i + 1] - boundaries[i];
    }
    this.totalLen = this.segLengths.reduce((a, b) => a + b, 0);
  }

  /** Segment containing a chainage. Clamped, so out-of-range never throws. */
  segmentAt(chainage: number): number {
    const n = this.covered.length;
    if (chainage <= this.boundaries[0]) return 0;
    if (chainage >= this.boundaries[n]) return n - 1;

    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.boundaries[mid] <= chainage) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Feed one GPS fix.
   *
   * Rejection is normal, not exceptional — a fix taken beside the drain rather
   * than on it, or with 60 m of accuracy under a flyover, must not count as
   * coverage. Rejected fixes are still stored and uploaded; FRCDE decides
   * independently what to do with them.
   */
  addFix(fix: Fix): FixResult {
    if (fix.mock) this.flags.add('mock_location');

    const fail = (reason: FixResult['reason']): FixResult => ({
      accepted: false,
      reason,
      newly_covered: [],
      coverage_pct: this.coveragePct(),
      flags: [...this.flags],
    });

    // No accuracy figure means we cannot judge the fix. Android occasionally
    // emits these from the network provider; treating them as good is how
    // phantom coverage appears 200 m from the drain.
    if (fix.acc == null || !Number.isFinite(fix.acc)) return fail('no_accuracy');
    if (fix.acc > this.rules.max_accuracy_m) return fail('poor_accuracy');

    const p = project(this.align, fix.lat, fix.lon);
    if (p.offset_m > this.rules.corridor_tolerance_m) return fail('outside_corridor');

    // Plausibility: derive speed from the previous accepted fix rather than
    // trusting the OS-reported value, which is often absent or smoothed.
    if (this.lastFix) {
      const dt = (Date.parse(fix.t) - Date.parse(this.lastFix.t)) / 1000;
      if (dt > 0) {
        const d = haversine(this.lastFix.lat, this.lastFix.lon, fix.lat, fix.lon);
        if (d / dt > this.rules.max_speed_mps) this.flags.add('implausible_speed');
      }
    }

    const newly = this.markUpTo(p.chainage_m);

    this.lastChainage = p.chainage_m;
    this.lastFix = fix;

    return {
      accepted: true,
      chainage_m: p.chainage_m,
      offset_m: p.offset_m,
      newly_covered: newly,
      coverage_pct: this.coveragePct(),
      flags: [...this.flags],
    };
  }

  /**
   * Mark everything between the previous accepted fix and this one.
   *
   * Marking only the segment a fix lands in would leave holes: at 10 m segments and
   * a 10 m sample distance, a normal walk produces a dashed line of coverage and
   * an inspector who did everything right still fails the 90% gate.
   *
   * The bridge is capped. A 400 m jump between fixes means GPS dropped out in a
   * culvert, or the inspector drove to the far end — either way we did not observe
   * that stretch and must not credit it. Beyond the cap only the landing segment is
   * marked, and the gap stays visibly red on the map for the inspector to walk back.
   */
  private markUpTo(chainage: number): number[] {
    const maxBridge = this.rules.max_bridge_m ?? DEFAULT_MAX_BRIDGE_M;
    const here = this.segmentAt(chainage);

    let from = here;
    let to = here;

    if (this.lastChainage != null) {
      const gap = Math.abs(chainage - this.lastChainage);
      if (gap <= maxBridge) {
        // Direction-agnostic: inspectors double back, and that still counts.
        from = this.segmentAt(Math.min(this.lastChainage, chainage));
        to = this.segmentAt(Math.max(this.lastChainage, chainage));
      } else {
        this.flags.add('large_gap_bridged');
      }
    }

    const newly: number[] = [];
    for (let i = from; i <= to; i++) {
      if (!this.covered[i]) {
        this.covered[i] = true;
        this.coveredLen += this.segLengths[i];
        newly.push(i);
      }
    }
    return newly;
  }

  coveragePct(): number {
    if (this.totalLen === 0) return 0;
    return (this.coveredLen / this.totalLen) * 100;
  }

  isCovered(i: number): boolean {
    return this.covered[i];
  }

  get segmentCount(): number {
    return this.covered.length;
  }

  /** Contiguous stretches still unwalked, as chainage ranges. Drives the map. */
  uncoveredRanges(): [number, number][] {
    const out: [number, number][] = [];
    let start: number | null = null;

    for (let i = 0; i < this.covered.length; i++) {
      if (!this.covered[i] && start === null) start = this.boundaries[i];
      if (this.covered[i] && start !== null) {
        out.push([start, this.boundaries[i]]);
        start = null;
      }
    }
    if (start !== null) out.push([start, this.boundaries[this.covered.length]]);
    return out;
  }

  coveredRanges(): [number, number][] {
    const out: [number, number][] = [];
    let start: number | null = null;

    for (let i = 0; i < this.covered.length; i++) {
      if (this.covered[i] && start === null) start = this.boundaries[i];
      if (!this.covered[i] && start !== null) {
        out.push([start, this.boundaries[i]]);
        start = null;
      }
    }
    if (start !== null) out.push([start, this.boundaries[this.covered.length]]);
    return out;
  }

  canComplete(): boolean {
    return this.coveragePct() >= this.rules.min_coverage_pct;
  }

  summary(): CoverageSummary {
    return {
      client_computed_pct: Number(this.coveragePct().toFixed(1)),
      covered_segments: this.covered.filter(Boolean).length,
      total_segments: this.covered.length,
      uncovered_ranges_m: this.uncoveredRanges().map(
        ([a, b]) => [Number(a.toFixed(1)), Number(b.toFixed(1))] as [number, number],
      ),
    };
  }

  activeFlags(): CoverageFlag[] {
    return [...this.flags];
  }

  /** Serialise for SQLite, so a mid-inspection app kill does not lose progress. */
  serialise(): { covered: number[]; lastChainage: number | null; flags: CoverageFlag[] } {
    const idx: number[] = [];
    this.covered.forEach((c, i) => c && idx.push(i));
    return { covered: idx, lastChainage: this.lastChainage, flags: [...this.flags] };
  }

  restore(state: { covered: number[]; lastChainage: number | null; flags: CoverageFlag[] }) {
    this.covered.fill(false);
    this.coveredLen = 0;
    for (const i of state.covered) {
      if (i >= 0 && i < this.covered.length && !this.covered[i]) {
        this.covered[i] = true;
        this.coveredLen += this.segLengths[i];
      }
    }
    this.lastChainage = state.lastChainage;
    this.lastFix = null; // force a fresh speed baseline after a restart
    this.flags = new Set(state.flags);
  }
}
