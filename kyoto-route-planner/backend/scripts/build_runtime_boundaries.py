"""Rebuild compact ODbL runtime polygons from the documented geoBoundaries input."""
import json
from pathlib import Path

from shapely.geometry import mapping, shape
from scripts.generate_prefecture_routes import AREAS, BOUNDARIES_PATH


def main():
    source = json.loads(BOUNDARIES_PATH.read_text(encoding="utf-8"))
    features = {row["properties"]["shapeISO"]: row["geometry"] for row in source["features"]}
    areas = {}
    for area in AREAS:
        geometry = shape(features[area.code])
        parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        polygon = max(parts, key=lambda part: part.area).simplify(0.00005, preserve_topology=True)
        geometry = mapping(polygon)
        geometry["coordinates"] = [[[round(value, 6) for value in point] for point in ring] for ring in geometry["coordinates"]]
        areas[area.id] = geometry
    target = Path(__file__).resolve().parents[1] / "app/data/prefecture_boundaries.json"
    target.write_text(json.dumps({"version": 1,
        "source": "https://github.com/wmgeolab/geoBoundaries/blob/9469f09/releaseData/gbOpen/JPN/ADM1/geoBoundaries-JPN-ADM1.geojson",
        "license": "ODbL-1.0", "modification": "Largest landmass per prefecture; simplified at 0.00005 degrees.",
        "areas": areas}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Bundled {len(areas)} prefectures: {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
