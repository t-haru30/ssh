"""Extract tourism/food nodes from a Geofabrik PBF and split them by prefecture.

Usage: python scripts/extract_osm_pbf.py [--pbf data/pbf/japan.osm.pbf]
Output: data/osm_extract/<JP-XX>.json  ({"elements": [...]} in Overpass node format)
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import osmium
from shapely.geometry import Point, shape
from shapely.prepared import prep

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BOUNDARIES = BACKEND_ROOT / "data" / "boundaries" / "jpn-adm1.geojson"
EXTRACT_DIR = BACKEND_ROOT / "data" / "osm_extract"

TOURISM = ("attraction", "museum", "gallery", "viewpoint", "theme_park", "zoo", "aquarium", "picnic_site")
HISTORIC = ("castle", "monument", "archaeological_site", "memorial", "ruins")
FOOD = ("restaurant", "cafe", "fast_food", "food_court")
KEPT_TAGS = {"name", "name:ja", "tourism", "historic", "amenity", "wikidata", "wikipedia"}

FILTER_PAIRS = (
    [("tourism", value) for value in TOURISM]
    + [("historic", value) for value in HISTORIC]
    + [("amenity", "place_of_worship")]
    + [("amenity", value) for value in FOOD]
)


def _load_prefectures() -> list[tuple[str, Any, Any]]:
    data = json.loads(BOUNDARIES.read_text(encoding="utf-8"))
    result = []
    for feature in data["features"]:
        geometry = shape(feature["geometry"])
        result.append((feature["properties"]["shapeISO"], geometry.bounds, prep(geometry)))
    return result


def _locate(prefectures: list[tuple[str, Any, Any]], lat: float, lon: float) -> str | None:
    point = Point(lon, lat)
    for code, (west, south, east, north), geometry in prefectures:
        if west <= lon <= east and south <= lat <= north and geometry.covers(point):
            return code
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pbf", type=Path, default=BACKEND_ROOT / "data" / "pbf" / "japan.osm.pbf")
    args = parser.parse_args()

    prefectures = _load_prefectures()
    processor = osmium.FileProcessor(str(args.pbf), osmium.osm.NODE).with_filter(
        osmium.filter.TagFilter(*FILTER_PAIRS)
    )
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unassigned = 0
    for node in processor:
        tags = {tag.k: tag.v for tag in node.tags if tag.k in KEPT_TAGS}
        if not tags.get("name") and not tags.get("name:ja"):
            continue
        if not node.location.valid():
            continue
        lat, lon = node.location.lat, node.location.lon
        code = _locate(prefectures, lat, lon)
        if code is None:
            unassigned += 1
            continue
        buckets[code].append({"type": "node", "id": node.id, "lat": lat, "lon": lon, "tags": tags})

    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    for code, elements in sorted(buckets.items()):
        elements.sort(key=lambda item: item["id"])
        (EXTRACT_DIR / f"{code}.json").write_text(
            json.dumps({"elements": elements}, ensure_ascii=False), encoding="utf-8"
        )
        print(f"{code}: {len(elements)}")
    print(f"unassigned (outside boundaries): {unassigned}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
