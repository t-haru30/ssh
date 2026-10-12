"""Validate generated prefecture route datasets."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
from scripts.generate_prefecture_routes import AREAS, STATIONS, _distance, _lunch_radius, build_legs, course_for, on_main_landmass


def validate_dataset(path: Path) -> dict[str, object]:
    data = json.loads(path.read_text(encoding="utf-8"))
    config = next(area for area in AREAS if area.id == data["area"])
    errors: list[str] = []
    routes = data.get("routes", [])
    if len(routes) != 5:
        errors.append(f"route_count={len(routes)}")
    if sum(route.get("pattern") == "half_day" for route in routes) != 3:
        errors.append("half_day_count")
    if sum(route.get("pattern") == "full_day" for route in routes) != 2:
        errors.append("full_day_count")
    seen: set[str] = set()
    for route in routes:
        spots = route.get("spots", [])
        coordinates = route.get("coordinates", [])
        if len(spots) != len(coordinates) or any([spot["lat"], spot["lng"]] != coordinate for spot, coordinate in zip(spots, coordinates)):
            errors.append(f"{route.get('id')}:coordinates")
        if route.get("id") in seen:
            errors.append(f"{route.get('id')}:duplicate_id")
        seen.add(route.get("id"))
        for spot in spots:
            if not (24 <= spot["lat"] <= 46.5 and 122 <= spot["lng"] <= 146.5):
                errors.append(f"{route.get('id')}:{spot['name']}:japan_bounds")
            elif not on_main_landmass(config.code, spot["lat"], spot["lng"]):
                errors.append(f"{route.get('id')}:{spot['name']}:off_main_landmass")
        for first, second in zip(spots, spots[1:]):
            distance = _distance((first["lat"], first["lng"]), (second["lat"], second["lng"]))
            if distance > config.max_leg_km:
                errors.append(f"{route.get('id')}:leg={distance:.2f}km")
        start = route.get("start")
        if not isinstance(start, dict) or start.get("name") != STATIONS[config.id][0]:
            errors.append(f"{route.get('id')}:start")
        elif spots:
            origin = (start["lat"], start["lng"])
            to_first = _distance(origin, (spots[0]["lat"], spots[0]["lng"]))
            from_last = _distance((spots[-1]["lat"], spots[-1]["lng"]), origin)
            if max(to_first, from_last) > data.get("start_radius_km", 0) + 0.05:
                errors.append(f"{route.get('id')}:start_distance={max(to_first, from_last):.1f}km")
        legs = route.get("legs", [])
        if legs != build_legs(config, STATIONS[config.id], spots):
            errors.append(f"{route.get('id')}:legs")
        expected = sum(spot["stay_minutes"] for spot in spots) + sum(leg["minutes"] for leg in legs)
        if route.get("estimated_minutes") != expected:
            errors.append(f"{route.get('id')}:estimated_minutes")
        if route.get("course") != course_for(route.get("pattern", ""), expected):
            errors.append(f"{route.get('id')}:course")
        lunches = [index for index, spot in enumerate(spots) if spot.get("role") == "lunch"]
        if route.get("pattern") == "full_day":
            if lunches != [2]:
                errors.append(f"{route.get('id')}:lunch_position")
            elif any(_distance((spots[lunches[0]]["lat"], spots[lunches[0]]["lng"]), (spots[index]["lat"], spots[index]["lng"])) > _lunch_radius(config) for index in (1, 3)):
                errors.append(f"{route.get('id')}:lunch_distance")
        elif lunches:
            errors.append(f"{route.get('id')}:unexpected_lunch")
    spot_sets = [set(spot["place_id"] for spot in route["spots"]) for route in routes]
    for index, first in enumerate(spot_sets):
        for second in spot_sets[index + 1:]:
            if len(first & second) > 1:
                errors.append(f"overlap={len(first & second)}")
    return {"area": data.get("area"), "routes": len(routes), "ok": not errors, "errors": errors}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    results = [validate_dataset(path) for path in sorted(args.directory.glob("*.json")) if path.name != "index.json"]
    report = {"ok": all(result["ok"] for result in results), "datasets": results}
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    print(output, end="")
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
