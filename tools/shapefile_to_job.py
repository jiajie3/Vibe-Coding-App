"""
Add a drain to the seed register from a shapefile.

The sibling of `seed_from_osm.py`: that one invents a register from public
geometry, this one takes a single real alignment somebody surveyed and files it
as one more job. Both end at the same place — `contracts/examples/seed-jobs.json`
— because a drain that is in there is a drain FRCDE, CFPI, the coverage engine
and the scheduler already know how to handle. Nothing downstream learns about
shapefiles.

    python tools/shapefile_to_job.py yishun/alignment.shp --name "Yishun Trial Drain"
    python tools/shapefile_to_job.py x.shp --name X --dry-run     # look first

Reads the .shp alone. A shapefile is really a set — .shp geometry, .dbf
attributes, .prj coordinate system — and the geometry is the only part needed
here, so a bare .shp is enough. It does mean no name comes with the file, which
is why --name is required.

COORDINATE SYSTEM. Without a .prj nothing states it, so it is inferred from
magnitude: Singapore data is either WGS84 degrees (~1.4, ~103.8) or SVY21 metres
on the national grid (~30000, ~40000), and those are not mistakable for each
other. Read SVY21 as degrees and the drain lands near the North Pole, so the
guess fails loudly rather than quietly. Pass --crs to override.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import struct
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEED = ROOT / "contracts" / "examples" / "seed-jobs.json"

SEGMENT_M = 10

# ----------------------------------------------------------------- SVY21

# SVY21 (EPSG:3414) is a transverse Mercator on the WGS84 ellipsoid.
_A = 6378137.0
_F = 1 / 298.257223563
_B = _A * (1 - _F)
_E2 = (_A * _A - _B * _B) / (_A * _A)
_E4, _E6 = _E2 * _E2, _E2 * _E2 * _E2

_LAT0 = math.radians(1.366666666666667)  # 1°22'N
_LON0 = math.radians(103.8333333333333)  # 103°50'E
_FALSE_E, _FALSE_N = 28001.642, 38744.572

_A0 = 1 - _E2 / 4 - 3 * _E4 / 64 - 5 * _E6 / 256
_A2 = (3 / 8) * (_E2 + _E4 / 4 + 15 * _E6 / 128)
_A4 = (15 / 256) * (_E4 + 3 * _E6 / 4)
_A6 = 35 * _E6 / 3072


def _meridian(lat: float) -> float:
    return _A * (
        _A0 * lat
        - _A2 * math.sin(2 * lat)
        + _A4 * math.sin(4 * lat)
        - _A6 * math.sin(6 * lat)
    )


def svy21_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    """(easting, northing) metres -> (lat, lon) degrees."""
    n_prime = (northing - _FALSE_N) + _meridian(_LAT0)

    lat = n_prime / (_A * _A0)
    for _ in range(12):
        lat += (n_prime - _meridian(lat)) / (_A * _A0)

    s, c, t = math.sin(lat), math.cos(lat), math.tan(lat)
    t2, t4, t6 = t * t, t**4, t**6
    rho = _A * (1 - _E2) / (1 - _E2 * s * s) ** 1.5
    v = _A / math.sqrt(1 - _E2 * s * s)
    psi = v / rho
    psi2, psi3, psi4 = psi * psi, psi**3, psi**4

    de = easting - _FALSE_E
    x = de / v
    lat_out = lat + (t / rho) * (
        -(x * de / 2)
        + (de * x**3 / 24) * (-4 * psi2 + 9 * psi * (1 - t2) + 12 * t2)
        - (de * x**5 / 720)
        * (
            8 * psi4 * (11 - 24 * t2)
            - 12 * psi3 * (21 - 71 * t2)
            + 15 * psi2 * (15 - 98 * t2 + 15 * t4)
            + 180 * psi * (5 * t2 - 3 * t4)
            + 360 * t4
        )
        + (de * x**7 / 40320) * (1385 + 3633 * t2 + 4095 * t4 + 1575 * t6)
    )
    lon_out = _LON0 + (
        x
        - (x**3 / 6) * (psi + 2 * t2)
        + (x**5 / 120)
        * (-4 * psi3 * (1 - 6 * t2) + psi2 * (9 - 68 * t2) + 72 * psi * t2 + 24 * t4)
        - (x**7 / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6)
    ) / c
    return math.degrees(lat_out), math.degrees(lon_out)


# ------------------------------------------------------------- shapefile


def read_polyline(path: pathlib.Path) -> list[tuple[float, float]]:
    """The first polyline in a .shp, as raw (x, y) in whatever CRS it is in."""
    raw = path.read_bytes()
    if struct.unpack(">i", raw[0:4])[0] != 9994:
        raise SystemExit(f"{path} is not a shapefile")

    off = 100
    found = []
    while off + 8 <= len(raw):
        _, words = struct.unpack(">ii", raw[off : off + 8])
        off += 8
        body = raw[off : off + words * 2]
        off += words * 2
        (kind,) = struct.unpack("<i", body[0:4])
        if kind not in (3, 13, 23):  # PolyLine, PolyLineZ, PolyLineM
            continue
        n_parts, n_points = struct.unpack("<ii", body[36:44])
        p = 44 + 4 * n_parts
        c = struct.unpack(f"<{2 * n_points}d", body[p : p + 16 * n_points])
        found.append([(c[i], c[i + 1]) for i in range(0, len(c), 2)])

    if not found:
        raise SystemExit("no polyline in the shapefile")
    if len(found) > 1:
        print(f"note: {len(found)} polylines, using the first", file=sys.stderr)
    return found[0]


def detect_crs(points: list[tuple[float, float]]) -> str:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if max(abs(x) for x in xs) <= 180 and max(abs(y) for y in ys) <= 90:
        return "wgs84"
    return "svy21"


# ------------------------------------------------------------------ geo


def haversine(a: list[float], b: list[float]) -> float:
    """Metres between two [lon, lat] pairs."""
    r = 6371000.0
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("shapefile", type=pathlib.Path)
    ap.add_argument("--name", required=True, help="what the drain is called")
    ap.add_argument(
        "--type",
        default="open_concrete_drain",
        choices=["canal", "open_concrete_drain", "closed_box_culvert", "earth_drain", "roadside_scupper"],
    )
    ap.add_argument("--crs", choices=["auto", "svy21", "wgs84"], default="auto")
    ap.add_argument("--access-notes", default="Confirm access on site.")
    ap.add_argument(
        "--queue",
        action="store_true",
        help="put it first, so the register treats it as due and it can be walked",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    raw = read_polyline(args.shapefile)
    crs = detect_crs(raw) if args.crs == "auto" else args.crs
    print(f"coordinate system: {crs}" + (" (inferred from magnitude)" if args.crs == "auto" else ""))

    if crs == "svy21":
        wgs = [svy21_to_wgs84(x, y) for x, y in raw]
    else:
        wgs = [(y, x) for x, y in raw]  # shapefiles store x=lon, y=lat

    coords = [[round(lon, 7), round(lat, 7)] for lat, lon in wgs]
    length = round(sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1)), 1)

    lats = [c[1] for c in coords]
    lons = [c[0] for c in coords]
    in_sg = 1.15 < min(lats) and max(lats) < 1.48 and 103.6 < min(lons) and max(lons) < 104.1

    print(f"points    {len(coords)}")
    print(f"length    {length} m")
    print(f"starts    {coords[0][1]:.6f}, {coords[0][0]:.6f}")
    print(f"in Singapore: {in_sg}")
    print(f"check     https://www.google.com/maps/search/?api=1&query={coords[0][1]:.6f},{coords[0][0]:.6f}")
    if not in_sg:
        print("\nthat is not in Singapore — wrong coordinate system? try --crs", file=sys.stderr)
        raise SystemExit(1)

    # A boundary every 10 m, with the last at the true end. The coverage engine
    # counts these, so a final boundary past the end makes 100% unreachable.
    bounds = [float(x) for x in range(0, int(length), SEGMENT_M)] + [length]

    jobs = json.loads(SEED.read_text(encoding="utf-8"))
    n = max(int(j["asset"]["id"].split("-")[1]) for j in jobs) + 1

    job = {
        "id": str(uuid.uuid4()),
        "reference": f"INS-2026-{n - 76000:06d}",
        "status": "available",
        "version": 1,
        "priority": "normal",
        "due_at": "2026-10-09T01:00:00.000+00:00",
        "assigned_inspector_id": None,
        "asset": {
            "id": f"DRN-{n}",
            "name": args.name,
            "type": args.type,
            "length_m": length,
            "geometry": {"type": "LineString", "coordinates": coords},
            "segment_boundaries_m": bounds,
            "access_notes": args.access_notes,
            "hazards": [],
        },
        "inspection_rules": dict(jobs[0]["inspection_rules"]),
        "checklist_template": {"id": "tpl_open_drain", "version": 7},
        "rejection_reason": None,
        "updated_at": "2026-10-06T12:00:00.000+00:00",
    }

    if args.dry_run:
        print(f"\n--dry-run: would add {job['reference']} ({job['asset']['id']})")
        return

    # Position decides everything: the store queues the first few drains in this
    # file and treats the rest as closed, on a cycle months out. A drain added to
    # be looked at has to be at the front or it cannot be walked at all.
    jobs.insert(0, job) if args.queue else jobs.append(job)
    SEED.write_text(json.dumps(jobs, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"\nadded {job['reference']} — {args.name} ({job['asset']['id']})")
    print(f"{len(jobs)} drains in the register")
    print("\nnow run:  cd cfpi && npm run sync:assets")


if __name__ == "__main__":
    main()
