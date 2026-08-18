/**
 * Coverage engine tests.
 *
 * Run with:  npm run test:core
 *
 * These exercise the engine against real Singapore drain geometry pulled from
 * OpenStreetMap (contracts/examples/seed-jobs.json), not synthetic straight lines.
 * Real alignments bend, double back and contain duplicate vertices; a coverage
 * engine that only works on a straight line is worthless in the field.
 *
 * Node 24 strips TypeScript types natively, so no build step or test framework
 * beyond the stdlib is needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { CoverageTracker } from './coverage.ts';
import { buildAlignment, chainageToLatLon, project, sliceAlignment } from './geo.ts';
import type { Fix, Job } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = resolve(here, '../../../contracts/examples/seed-jobs.json');
const jobs: Job[] = JSON.parse(readFileSync(SEED, 'utf8'));

/** A long, bendy real canal — the interesting case. */
const job = jobs.reduce((a, b) => (a.asset.length_m > b.asset.length_m ? a : b));

// --------------------------------------------------------------- helpers

/** Shift a point perpendicular to the centreline by `metres` (signed). */
function offsetPoint(align: ReturnType<typeof buildAlignment>, chainage: number, metres: number) {
  const c = Math.min(chainage, align.length_m - 1);
  const p1 = chainageToLatLon(align, c);
  const p2 = chainageToLatLon(align, c + 1);
  const mPerDegLat = 110_540;
  const mPerDegLon = 111_320 * Math.cos((p1.lat * Math.PI) / 180);

  const dx = (p2.lon - p1.lon) * mPerDegLon;
  const dy = (p2.lat - p1.lat) * mPerDegLat;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular in the plane, then back to degrees.
  const px = -dy / len;
  const py = dx / len;
  return {
    lat: p1.lat + (py * metres) / mPerDegLat,
    lon: p1.lon + (px * metres) / mPerDegLon,
  };
}

interface WalkOpts {
  step?: number;
  from?: number;
  to?: number;
  acc?: number;
  offset?: number;
  speed?: number;
  startTime?: number;
}

/** Simulate an inspector walking the drain, emitting GPS fixes. */
function walk(align: ReturnType<typeof buildAlignment>, o: WalkOpts = {}): Fix[] {
  const step = o.step ?? 8;
  const from = o.from ?? 0;
  const to = o.to ?? align.length_m;
  const speed = o.speed ?? 1.2;
  let t = o.startTime ?? Date.parse('2026-08-07T09:00:00.000Z');

  const out: Fix[] = [];
  const emit = (c: number) => {
    const p = o.offset ? offsetPoint(align, c, o.offset) : chainageToLatLon(align, c);
    out.push({ lat: p.lat, lon: p.lon, acc: o.acc ?? 6, t: new Date(t).toISOString() });
    t += (step / speed) * 1000;
  };

  let c = from;
  for (; c < to; c += step) emit(c);
  // Always land on the far end. A stepped loop stops up to `step` metres short,
  // which would leave the final segment permanently uncovered and make every
  // drain fail the completion gate for a reason that has nothing to do with GPS.
  if (c - step < to) emit(to);
  return out;
}

function tracker(j: Job = job) {
  return new CoverageTracker(j.asset.geometry, j.asset.segment_boundaries_m, j.inspection_rules);
}

// ----------------------------------------------------------------- geo

test('seed data loaded', () => {
  assert.ok(jobs.length >= 20, `expected >=20 seed jobs, got ${jobs.length}`);
  assert.equal(job.asset.geometry.type, 'LineString');
});

test('alignment length matches the length FRCDE published', () => {
  for (const j of jobs.slice(0, 15)) {
    const a = buildAlignment(j.asset.geometry);
    const err = Math.abs(a.length_m - j.asset.length_m);
    assert.ok(err < 1.0, `${j.asset.name}: alignment ${a.length_m} vs published ${j.asset.length_m}`);
  }
});

test('a point on the centreline projects to ~zero offset', () => {
  const a = buildAlignment(job.asset.geometry);
  for (const c of [0, 50, 137.5, a.length_m / 2, a.length_m]) {
    const p = chainageToLatLon(a, c);
    const proj = project(a, p.lat, p.lon);
    assert.ok(proj.offset_m < 0.5, `offset ${proj.offset_m} at chainage ${c}`);
    assert.ok(Math.abs(proj.chainage_m - c) < 1.0, `chainage ${proj.chainage_m} vs ${c}`);
  }
});

test('perpendicular offset is recovered accurately', () => {
  const a = buildAlignment(job.asset.geometry);
  for (const d of [5, 15, 30, 60]) {
    const p = offsetPoint(a, 200, d);
    const proj = project(a, p.lat, p.lon);
    assert.ok(Math.abs(proj.offset_m - d) < 1.5, `expected ~${d} m, got ${proj.offset_m}`);
  }
});

test('sliceAlignment follows the real drain shape, not a straight line', () => {
  const a = buildAlignment(job.asset.geometry);
  const slice = sliceAlignment(a, 100, 300);
  assert.ok(slice.length > 2, 'slice should include intermediate vertices');
  const first = project(a, slice[0].lat, slice[0].lon);
  const last = project(a, slice[slice.length - 1].lat, slice[slice.length - 1].lon);
  assert.ok(Math.abs(first.chainage_m - 100) < 1);
  assert.ok(Math.abs(last.chainage_m - 300) < 1);
});

// ------------------------------------------------------------ coverage

test('a full walk reaches 100% and passes the completion gate', () => {
  const t = tracker();
  for (const f of walk(t.align)) t.addFix(f);
  assert.ok(t.coveragePct() > 99.5, `got ${t.coveragePct().toFixed(1)}%`);
  assert.equal(t.canComplete(), true);
  assert.deepEqual(t.uncoveredRanges(), []);
});

test('sparse sampling still yields full coverage — segments are bridged', () => {
  // 40 m between fixes, 10 m segments. Without bridging this dashes to ~25%.
  const t = tracker();
  for (const f of walk(t.align, { step: 40 })) t.addFix(f);
  assert.ok(t.coveragePct() > 99, `got ${t.coveragePct().toFixed(1)}%`);
  assert.ok(!t.activeFlags().includes('large_gap_bridged'));
});

test('a skipped middle stretch is reported as an uncovered range', () => {
  const t = tracker();
  const L = t.align.length_m;
  for (const f of walk(t.align, { to: L * 0.3 })) t.addFix(f);
  for (const f of walk(t.align, { from: L * 0.6, to: L })) t.addFix(f);

  const gaps = t.uncoveredRanges();
  assert.equal(gaps.length, 1, `expected one gap, got ${JSON.stringify(gaps)}`);
  assert.ok(gaps[0][0] > L * 0.28 && gaps[0][0] < L * 0.32, `gap starts at ${gaps[0][0]}`);
  assert.ok(gaps[0][1] > L * 0.58 && gaps[0][1] < L * 0.62, `gap ends at ${gaps[0][1]}`);
  assert.equal(t.canComplete(), false);
  assert.ok(t.coveragePct() < 75);
});

test('a jump larger than the bridge cap is not credited', () => {
  const t = tracker();
  t.addFix({ ...chainageToLatLon(t.align, 10), acc: 5, t: '2026-08-07T09:00:00.000Z' });
  // 300 m later, 4 minutes on: GPS lost in a culvert, or they drove.
  t.addFix({ ...chainageToLatLon(t.align, 310), acc: 5, t: '2026-08-07T09:04:00.000Z' });

  assert.ok(t.activeFlags().includes('large_gap_bridged'));
  assert.ok(t.coveragePct() < 10, `phantom coverage: ${t.coveragePct().toFixed(1)}%`);
  const gaps = t.uncoveredRanges();
  assert.ok(gaps.some(([a, b]) => a < 100 && b > 250), `gap not preserved: ${JSON.stringify(gaps)}`);
});

// ------------------------------------------------------------ filtering

test('fixes with poor accuracy are rejected', () => {
  const t = tracker();
  const p = chainageToLatLon(t.align, 100);
  const r = t.addFix({ ...p, acc: 60, t: '2026-08-07T09:00:00.000Z' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'poor_accuracy');
  assert.equal(t.coveragePct(), 0);
});

test('fixes with no accuracy figure are rejected', () => {
  const t = tracker();
  const p = chainageToLatLon(t.align, 100);
  const r = t.addFix({ ...p, t: '2026-08-07T09:00:00.000Z' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'no_accuracy');
});

test('walking parallel to the drain, outside the corridor, earns no coverage', () => {
  const t = tracker(); // corridor_tolerance_m = 20
  for (const f of walk(t.align, { offset: 45 })) {
    assert.equal(t.addFix(f).accepted, false);
  }
  assert.equal(t.coveragePct(), 0);
});

test('a fix just inside the corridor still counts', () => {
  const t = tracker();
  const p = offsetPoint(t.align, 150, 15);
  const r = t.addFix({ ...p, acc: 5, t: '2026-08-07T09:00:00.000Z' });
  assert.equal(r.accepted, true);
  assert.ok(r.offset_m! > 13 && r.offset_m! < 17);
});

test('driving the route flags implausible speed', () => {
  const t = tracker();
  for (const f of walk(t.align, { step: 40, speed: 14 })) t.addFix(f); // ~50 km/h
  assert.ok(t.activeFlags().includes('implausible_speed'));
  // Note: still 100% covered. Flag for review, never block in the field.
  assert.ok(t.coveragePct() > 99);
});

test('mock locations are flagged', () => {
  const t = tracker();
  const p = chainageToLatLon(t.align, 50);
  t.addFix({ ...p, acc: 5, mock: true, t: '2026-08-07T09:00:00.000Z' });
  assert.ok(t.activeFlags().includes('mock_location'));
});

// -------------------------------------------------------- persistence

test('serialise/restore survives an app kill mid-inspection', () => {
  const a = tracker();
  for (const f of walk(a.align, { to: a.align.length_m * 0.5 })) a.addFix(f);
  const before = a.coveragePct();

  const b = tracker();
  b.restore(a.serialise());

  assert.ok(Math.abs(b.coveragePct() - before) < 0.001);
  assert.deepEqual(b.uncoveredRanges(), a.uncoveredRanges());

  // Resuming from where it stopped completes the job.
  for (const f of walk(b.align, { from: b.align.length_m * 0.5 })) b.addFix(f);
  assert.ok(b.coveragePct() > 99.5, `resumed to ${b.coveragePct().toFixed(1)}%`);
});

test('summary matches the contract shape', () => {
  const t = tracker();
  for (const f of walk(t.align, { to: t.align.length_m * 0.8 })) t.addFix(f);
  const s = t.summary();

  assert.equal(s.total_segments, job.asset.segment_boundaries_m.length - 1);
  assert.ok(s.covered_segments > 0 && s.covered_segments < s.total_segments);
  assert.ok(s.client_computed_pct > 75 && s.client_computed_pct < 85);
  assert.equal(s.uncovered_ranges_m.length, 1);
});

// ------------------------------------------------- every seed job works

test('all 40 seed drains can be walked to completion', () => {
  const failures: string[] = [];
  for (const j of jobs) {
    const t = tracker(j);
    for (const f of walk(t.align, { step: 8 })) t.addFix(f);
    if (t.coveragePct() < 99) {
      failures.push(`${j.reference} ${j.asset.name}: ${t.coveragePct().toFixed(1)}%`);
    }
  }
  assert.deepEqual(failures, [], `drains that could not reach 99%:\n${failures.join('\n')}`);
});
