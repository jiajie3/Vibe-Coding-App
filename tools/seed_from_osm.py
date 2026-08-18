"""
Generate a realistic FRCDE seed dataset of drain inspection jobs from OpenStreetMap.

Real PUB drain centrelines are confidential, but OSM has ~3,300 mapped waterway
centrelines across Singapore (drains, canals, ditches) as LineStrings — structurally
identical to what FRCDE will ingest in production. Swapping in the real asset register
later is a data-source change, not a code change.

Licence: OpenStreetMap data is ODbL. Fine for development and internal demos;
attribute "© OpenStreetMap contributors" anywhere it is shown publicly.

Usage:
    python tools/seed_from_osm.py --count 40 --out contracts/examples/seed-jobs.json

No third-party dependencies — stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

SG_BBOX = (1.20, 103.60, 1.48, 104.10)  # south, west, north, east
OVERPASS = "https://overpass-api.de/api/interpreter"

# An inspection stretch should be a walkable length. Ways outside this get
# dropped (too short to be a job) or split into chunks (too long for one shift).
MIN_JOB_M = 120
MAX_JOB_M = 900
TARGET_CHUNK_M = 600

SEGMENT_LEN_M = 10  # must match inspection_rules.segment_length_m

ASSET_TYPE = {
    "drain": "open_concrete_drain",
    "ditch": "earth_drain",
    "canal": "canal",
}

HAZARDS = [
    ["deep_water", "steep_batter"],
    ["vehicular_traffic"],
    ["confined_space", "deep_water"],
    ["slippery_surface"],
    ["vegetation_overgrowth", "wildlife"],
    [],
]

ACCESS_NOTES = [
    "Access via service road; gate key held at depot.",
    "Roadside access only — park on the verge, hazard lights on.",
    "Entry through the park connector. No vehicle access.",
    "Locked gate at the upstream end. Collect key before 08:00.",
    "Open access from the footpath along the full stretch.",
]


# --------------------------------------------------------------------- geometry

def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in metres between two (lon, lat) points."""
    r = 6_371_008.8
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def line_length_m(coords: list[list[float]]) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def densify(coords: list[list[float]], max_step_m: float = 25.0) -> list[list[float]]:
    """
    Insert intermediate vertices so no leg exceeds max_step_m.

    OSM ways are often drawn with very sparse vertices — 'Sungei Ulu Pandan' comes
    back as a 2-point line covering hundreds of metres. Coverage tracking projects
    GPS fixes onto the centreline, which stays correct with sparse vertices, but the
    map polyline looks wrong on curves and per-segment colouring gets chunky.
    Densifying makes the mock data behave like a surveyed alignment.
    """
    out: list[list[float]] = [coords[0]]
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        d = haversine_m(a, b)
        n = max(1, math.ceil(d / max_step_m))
        for k in range(1, n + 1):
            t = k / n
            out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    return out


def split_line(coords: list[list[float]], chunk_m: float) -> list[list[list[float]]]:
    """Split a long line into chunks of roughly chunk_m, cutting only at vertices."""
    chunks, current, acc = [], [coords[0]], 0.0
    for i in range(len(coords) - 1):
        acc += haversine_m(coords[i], coords[i + 1])
        current.append(coords[i + 1])
        if acc >= chunk_m:
            chunks.append(current)
            current, acc = [coords[i + 1]], 0.0
    if len(current) > 1:
        if chunks and line_length_m(current) < MIN_JOB_M:
            chunks[-1].extend(current[1:])  # absorb a stubby tail
        else:
            chunks.append(current)
    return chunks


def segment_boundaries(length_m: float, step: float = SEGMENT_LEN_M) -> list[float]:
    """
    Chainage boundaries FRCDE and CFPI both measure coverage against.

    Precomputed server-side on purpose: if each side derived its own partition,
    floating-point drift would produce off-by-one coverage disputes nobody can settle.
    """
    bounds = [round(x * step, 2) for x in range(int(length_m // step) + 1)]
    if bounds[-1] < length_m:
        bounds.append(round(length_m, 2))
    return bounds


# ------------------------------------------------------------------ osm fetch

def fetch_ways(bbox: tuple[float, float, float, float]) -> list[dict]:
    s, w, n, e = bbox
    query = f"""
    [out:json][timeout:120];
    (
      way["waterway"~"^(drain|ditch|canal)$"]({s},{w},{n},{e});
    );
    out geom;
    """
    req = urllib.request.Request(
        OVERPASS,
        data=("data=" + urllib.parse.quote(query)).encode(),
        headers={"User-Agent": "frcde-seed/1.0 (dev)"},
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.load(resp)["elements"]


# ------------------------------------------------------------------ job build

def build_job(name: str, waterway: str, coords: list[list[float]],
              idx: int, rng: random.Random, now: datetime) -> dict:
    length = round(line_length_m(coords), 1)
    status = rng.choices(
        ["available", "accepted", "in_progress", "submitted", "approved"],
        weights=[55, 15, 5, 15, 10],
    )[0]
    return {
        "id": str(uuid.uuid4()),
        "reference": f"INS-2026-{4000 + idx:06d}"[:15],
        "status": status,
        "version": rng.randint(1, 5),
        "priority": rng.choices(["low", "normal", "high", "urgent"],
                                weights=[15, 55, 25, 5])[0],
        "due_at": (now + timedelta(days=rng.randint(-3, 21),
                                   hours=rng.randint(0, 8))).isoformat(timespec="milliseconds"),
        "assigned_inspector_id": (str(uuid.uuid4())
                                  if status not in ("available",) else None),
        "asset": {
            "id": f"DRN-{80000 + idx:05d}",
            "name": name,
            "type": ASSET_TYPE.get(waterway, "open_concrete_drain"),
            "length_m": length,
            "geometry": {"type": "LineString", "coordinates": coords},
            "segment_boundaries_m": segment_boundaries(length),
            "access_notes": rng.choice(ACCESS_NOTES),
            "hazards": rng.choice(HAZARDS),
        },
        "inspection_rules": {
            "segment_length_m": SEGMENT_LEN_M,
            "corridor_tolerance_m": 20,
            "max_accuracy_m": 25,
            "min_coverage_pct": 90,
            "max_speed_mps": 3.0,
            "allow_override": True,
            "require_photo_on_override": True,
        },
        "checklist_template": {
            "id": "tpl_open_drain" if waterway != "canal" else "tpl_canal",
            "version": 7,
        },
        "rejection_reason": None,
        "updated_at": now.isoformat(timespec="milliseconds"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=40)
    ap.add_argument("--out", default="contracts/examples/seed-jobs.json")
    ap.add_argument("--geojson", default="contracts/examples/seed-jobs.geojson",
                    help="Companion file — drag onto geojson.io to eyeball the data.")
    ap.add_argument("--seed", type=int, default=42, help="Deterministic output.")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    now = datetime.now(timezone.utc)

    print("Querying Overpass for Singapore drains/canals/ditches …")
    ways = fetch_ways(SG_BBOX)
    print(f"  {len(ways)} ways returned")

    # Named ways first — 'Pelton Canal' reads better in a demo than 'way/48211903',
    # and it makes the map screen look like a real asset register.
    named = [w for w in ways if w.get("tags", {}).get("name") and w.get("geometry")]
    unnamed = [w for w in ways if not w.get("tags", {}).get("name") and w.get("geometry")]
    rng.shuffle(named)
    rng.shuffle(unnamed)

    jobs: list[dict] = []
    for way in named + unnamed:
        if len(jobs) >= args.count:
            break
        coords = [[round(p["lon"], 7), round(p["lat"], 7)] for p in way["geometry"]]
        if len(coords) < 2:
            continue
        coords = densify(coords)
        total = line_length_m(coords)
        if total < MIN_JOB_M:
            continue

        pieces = split_line(coords, TARGET_CHUNK_M) if total > MAX_JOB_M else [coords]
        base = way["tags"].get("name") or f"Unnamed Drain (OSM {way['id']})"
        waterway = way["tags"].get("waterway", "drain")

        for n, piece in enumerate(pieces):
            if len(jobs) >= args.count or line_length_m(piece) < MIN_JOB_M:
                continue
            label = base if len(pieces) == 1 else f"{base} — Segment {n + 1:02d}"
            jobs.append(build_job(label, waterway, piece, len(jobs) + 1, rng, now))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(jobs, indent=2), encoding="utf-8")

    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": j["asset"]["geometry"],
                "properties": {
                    "reference": j["reference"],
                    "name": j["asset"]["name"],
                    "status": j["status"],
                    "priority": j["priority"],
                    "length_m": j["asset"]["length_m"],
                },
            }
            for j in jobs
        ],
    }
    Path(args.geojson).write_text(json.dumps(fc), encoding="utf-8")

    lengths = [j["asset"]["length_m"] for j in jobs]
    print(f"\nWrote {len(jobs)} jobs → {args.out}")
    print(f"       preview  → {args.geojson}")
    print(f"  length: min {min(lengths):.0f} m  median {sorted(lengths)[len(lengths)//2]:.0f} m  max {max(lengths):.0f} m")
    print(f"  total centreline: {sum(lengths)/1000:.1f} km")


if __name__ == "__main__":
    main()
