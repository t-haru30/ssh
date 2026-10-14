"""Bundled ODbL prefecture polygons, independent of development-only files."""
from functools import lru_cache
import json
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.prepared import prep

BOUNDARIES = Path(__file__).resolve().parent / "data" / "prefecture_boundaries.json"


@lru_cache(maxsize=1)
def _polygons():
    data = json.loads(BOUNDARIES.read_text(encoding="utf-8"))
    if data.get("version") != 1 or len(data.get("areas", {})) != 47:
        raise ValueError("Invalid bundled prefecture boundaries")
    return {area: prep(shape(geometry)) for area, geometry in data["areas"].items()}


def in_prefecture(area: str, latitude: float, longitude: float) -> bool:
    try:
        polygon = _polygons().get(area)
        return bool(polygon and polygon.covers(Point(longitude, latitude)))
    except (OSError, ValueError, TypeError, KeyError):
        return False
