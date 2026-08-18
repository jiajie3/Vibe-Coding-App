/**
 * Geodesy for coverage tracking.
 *
 * Everything here runs on every GPS fix (a few times per second during an
 * inspection) so it is deliberately allocation-light and dependency-free.
 *
 * Projection choice: a local equirectangular ("flat earth") projection anchored at
 * the alignment's mean latitude. Over a single drain — at most ~1 km — the error
 * versus a proper geodesic is on the order of millimetres, against a corridor
 * tolerance of 20 m. Turf.js or a full UTM transform would be strictly heavier for
 * no measurable gain here.
 */

import type { LineString } from './types.ts';

const EARTH_R = 6_371_008.8;
const DEG = Math.PI / 180;

/** Planar metres, origin at the alignment's first vertex. */
interface Planar {
  x: number;
  y: number;
}

export interface Alignment {
  /** Planar vertices, index-aligned with the source coordinates. */
  pts: Planar[];
  /** Cumulative chainage at each vertex; cum[0] === 0. */
  cum: number[];
  /** Total centreline length in metres. */
  length_m: number;
  /** Projection anchor. */
  lat0: number;
  lon0: number;
  /** Original lon/lat, kept so we can convert chainage back to a map coordinate. */
  coords: [number, number][];
}

export function haversine(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/**
 * Precompute an alignment from a GeoJSON LineString.
 *
 * Do this once when a job is opened, never per fix — it is O(n) and the result is
 * reused for the life of the inspection.
 */
export function buildAlignment(geometry: LineString): Alignment {
  const coords = geometry.coordinates;
  if (coords.length < 2) {
    throw new Error('Alignment needs at least 2 coordinates');
  }

  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const lon0 = coords[0][0];
  const kx = EARTH_R * DEG * Math.cos(lat0 * DEG);
  const ky = EARTH_R * DEG;

  const pts: Planar[] = coords.map(([lon, lat]) => ({
    x: (lon - lon0) * kx,
    y: (lat - lat0) * ky,
  }));

  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }

  return { pts, cum, length_m: cum[cum.length - 1], lat0, lon0, coords };
}

export interface Projection {
  /** Distance along the centreline from its start, metres. */
  chainage_m: number;
  /** Perpendicular distance from the centreline, metres. */
  offset_m: number;
  /** Index of the polyline leg the fix projected onto. */
  leg: number;
}

/**
 * Project a lat/lon onto the alignment, returning the nearest point along it.
 *
 * Scans every leg. For a 900 m drain densified to 25 m spacing that is ~36 legs,
 * i.e. trivial at GPS sample rates. If alignments ever grow to thousands of
 * vertices, add a bounding-box index — but measure first.
 */
export function project(align: Alignment, lat: number, lon: number): Projection {
  const kx = EARTH_R * DEG * Math.cos(align.lat0 * DEG);
  const ky = EARTH_R * DEG;
  const px = (lon - align.lon0) * kx;
  const py = (lat - align.lat0) * ky;

  let best: Projection = { chainage_m: 0, offset_m: Infinity, leg: 0 };

  for (let i = 0; i < align.pts.length - 1; i++) {
    const a = align.pts[i];
    const b = align.pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const legLen2 = vx * vx + vy * vy;

    // Degenerate leg (duplicate vertices happen in real OSM/GIS data).
    let t = legLen2 === 0 ? 0 : ((px - a.x) * vx + (py - a.y) * vy) / legLen2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;

    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    const off = Math.hypot(px - cx, py - cy);

    if (off < best.offset_m) {
      best = {
        chainage_m: align.cum[i] + t * Math.sqrt(legLen2),
        offset_m: off,
        leg: i,
      };
    }
  }

  return best;
}

/** Convert a chainage back to a map coordinate — used to draw coverage overlays. */
export function chainageToLatLon(
  align: Alignment,
  chainage: number,
): { lat: number; lon: number } {
  const c = Math.max(0, Math.min(chainage, align.length_m));

  let i = 0;
  while (i < align.cum.length - 2 && align.cum[i + 1] < c) i++;

  const legLen = align.cum[i + 1] - align.cum[i];
  const t = legLen === 0 ? 0 : (c - align.cum[i]) / legLen;

  const [aLon, aLat] = align.coords[i];
  const [bLon, bLat] = align.coords[i + 1];
  return { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t };
}

/**
 * Slice the alignment between two chainages, returned as map coordinates.
 *
 * This is what lets the map draw a covered stretch as its own green polyline
 * following the real drain shape, rather than a straight line between endpoints.
 */
export function sliceAlignment(
  align: Alignment,
  from: number,
  to: number,
): { lat: number; lon: number }[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(align.length_m, Math.max(from, to));
  const out = [chainageToLatLon(align, lo)];

  for (let i = 0; i < align.cum.length; i++) {
    if (align.cum[i] > lo && align.cum[i] < hi) {
      out.push({ lat: align.coords[i][1], lon: align.coords[i][0] });
    }
  }

  out.push(chainageToLatLon(align, hi));
  return out;
}

/** GeoJSON is [lon, lat]; react-native-maps wants {latitude, longitude}. */
export function toLatLng(
  coords: [number, number][],
): { latitude: number; longitude: number }[] {
  return coords.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
}
