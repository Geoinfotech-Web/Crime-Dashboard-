"""Build the LGA map layers from public files on the Humanitarian Data Exchange.

Inputs (download from data.humdata.org):
  * nga_admin_boundaries.geojson.zip
      https://data.humdata.org/dataset/cod-ab-nga  (OCHA, CC BY-IGO)
  * nga-iom-dtm-from-api-admin-0-to-2.csv
      https://data.humdata.org/dataset/nga-iom-dtm-from-api  (IOM DTM)

Run:
    python build_map_layers.py BOUNDARIES.geojson.zip DTM.csv

Writes, next to this file:
  * vendor/nigeria-lgas.geojson  - simplified outlines of the 774 local
    government areas, each with its pcode, name, state and centre point
  * displacement.json            - people displaced (IDPs) per LGA from the
    most recent IOM DTM round that covered it
"""
import csv
import json
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOLERANCE = 0.006       # degrees (~650 m): enough detail for a national map
DIGITS = 4              # coordinate precision kept (~11 m)
DTM_MAX_AGE_DAYS = 548  # ignore LGA counts older than ~18 months before the newest round

STATE_NAMES = {"Federal Capital Territory": "FCT (Abuja)", "Nassarawa": "Nasarawa"}


def simplify(points, tolerance):
    """Douglas-Peucker line simplification (iterative)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        (x1, y1), (x2, y2) = points[first], points[last]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) or 1e-18
        worst, index = 0.0, None
        for i in range(first + 1, last):
            px, py = points[i]
            t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / norm))
            ex, ey = x1 + t * dx - px, y1 + t * dy - py
            dist = ex * ex + ey * ey
            if dist > worst:
                worst, index = dist, i
        if index is not None and worst > tolerance * tolerance:
            keep[index] = True
            stack.extend([(first, index), (index, last)])
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring):
    out = simplify([tuple(p[:2]) for p in ring], TOLERANCE)
    if len(out) < 4:                      # too small to survive: keep a triangle
        out = [tuple(p[:2]) for p in ring[:: max(1, len(ring) // 3)]][:3] + [tuple(ring[0][:2])]
    return [[round(x, DIGITS), round(y, DIGITS)] for x, y in out]


def simplify_geometry(geometry):
    if geometry["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [simplify_ring(r) for r in geometry["coordinates"]]}
    polygons = [[simplify_ring(r) for r in polygon] for polygon in geometry["coordinates"]]
    return {"type": "MultiPolygon", "coordinates": polygons}


def build_boundaries(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        source = json.loads(archive.read("nga_admin2.geojson"))
    features = []
    for feature in source["features"]:
        props = feature["properties"]
        state = STATE_NAMES.get(props["adm1_name"], props["adm1_name"])
        features.append({
            "type": "Feature",
            "properties": {
                "pcode": props["adm2_pcode"], "name": props["adm2_name"], "state": state,
                "lat": round(props["center_lat"], 4), "lng": round(props["center_lon"], 4),
            },
            "geometry": simplify_geometry(feature["geometry"]),
        })
    out = ROOT / "vendor" / "nigeria-lgas.geojson"
    out.write_text(json.dumps({
        "type": "FeatureCollection",
        "source": "OCHA Common Operational Dataset, Nigeria administrative boundaries (CC BY-IGO), simplified",
        "features": features,
    }, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)}: {len(features)} LGAs, {out.stat().st_size // 1024} KB")


def build_displacement(csv_path):
    with open(csv_path, encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["adminLevel"] == "2" and row["admin2Pcode"]]
    for row in rows:
        row["_date"] = datetime.fromisoformat(row["reportingDate"][:19])
    newest = max(row["_date"] for row in rows)
    cutoff = newest - timedelta(days=DTM_MAX_AGE_DAYS)

    # Latest round per LGA and crisis operation; an LGA covered by two
    # operations adds both.
    latest = {}
    for row in rows:
        if row["_date"] < cutoff:
            continue
        key = (row["admin2Pcode"], row["operation"])
        if key not in latest or row["_date"] > latest[key]["_date"]:
            latest[key] = row
        elif row["_date"] == latest[key]["_date"] and row is not latest[key]:
            # Same round reported twice (e.g. split by displacement reason): add up.
            latest[key] = dict(latest[key], numPresentIdpInd=str(
                float(latest[key]["numPresentIdpInd"] or 0) + float(row["numPresentIdpInd"] or 0)))

    lgas = {}
    for (pcode_dtm, _operation), row in latest.items():
        pcode = "NG" + pcode_dtm[3:] if pcode_dtm.startswith("NGA") else pcode_dtm
        item = lgas.setdefault(pcode, {"idps": 0, "asOf": ""})
        item["idps"] += int(float(row["numPresentIdpInd"] or 0))
        item["asOf"] = max(item["asOf"], row["_date"].strftime("%Y-%m"))
    lgas = {pcode: item for pcode, item in lgas.items() if item["idps"] > 0}

    out = ROOT / "displacement.json"
    out.write_text(json.dumps({
        "meta": {
            "source": "IOM Displacement Tracking Matrix (DTM), via HDX",
            "sourceUrl": "https://data.humdata.org/dataset/nga-iom-dtm-from-api",
            "note": "People displaced (IDPs) present in each LGA at the most recent DTM round that covered it. DTM covers the North East, North Central and North West; other LGAs are not assessed.",
            "from": cutoff.strftime("%Y-%m"), "to": newest.strftime("%Y-%m"),
        },
        "lgas": lgas,
    }, separators=(",", ":")), encoding="utf-8")
    total = sum(item["idps"] for item in lgas.values())
    print(f"Wrote {out.name}: {len(lgas)} LGAs, {total:,} displaced people, rounds {cutoff:%b %Y} - {newest:%b %Y}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    build_boundaries(sys.argv[1])
    build_displacement(sys.argv[2])
