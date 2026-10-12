"""Generate deterministic, OSM-backed sample routes for all Japanese prefectures."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
FRONTEND_DATA_DIR = PROJECT_DIR / "frontend" / "src" / "data" / "routes"
CACHE_DIR = BACKEND_DIR / "data" / "osm_cache"
sys.path.insert(0, str(BACKEND_DIR))

from app.models import Place
from app.places import calculate_place_score

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
GENERATOR_VERSION = "osm-deterministic-v4"
# Legs up to this straight-line distance are walked (about 15 minutes).
WALK_MAX_KM = 0.8
# Routes depart at 09:00; one that returns after 14:00 is shown as a full-day course.
DEPARTURE_MINUTES = 9 * 60
FULL_DAY_RETURN_MINUTES = 14 * 60


def course_for(pattern: str, estimated_minutes: int) -> str:
    if pattern == "full_day" or DEPARTURE_MINUTES + estimated_minutes > FULL_DAY_RETURN_MINUTES:
        return "full_day"
    return "half_day"
BOUNDARIES_PATH = BACKEND_DIR / "data" / "boundaries" / "jpn-adm1.geojson"
EARTH_RADIUS_KM = 6371.0
LUNCH_RADIUS_BY_MODE = {"car": 8.0, "public_transport": 5.0, "walk": 2.0}
GRID_ROWS = 4
GRID_COLUMNS = 4
# Every route starts and ends at the central station of the prefectural capital.
# Candidates must lie within this radius; it widens stepwise only when a prefecture cannot fill five routes.
START_RADIUS_KM = {"car": 60.0, "public_transport": 20.0, "walk": 5.0}
START_RADIUS_STEPS = (1.0, 1.5, 2.0, 3.0)

# area id -> (station name, latitude, longitude)
STATIONS: dict[str, tuple[str, float, float]] = {
    "hokkaido": ("札幌駅", 43.0686, 141.3508),
    "aomori": ("青森駅", 40.82887, 140.73357),
    "iwate": ("盛岡駅", 39.7013, 141.1363),
    "miyagi": ("仙台駅", 38.2606, 140.8824),
    "akita": ("秋田駅", 39.7173, 140.1288),
    "yamagata": ("山形駅", 38.2485, 140.3277),
    "fukushima": ("福島駅", 37.7541, 140.4592),
    "ibaraki": ("水戸駅", 36.3711, 140.4764),
    "tochigi": ("宇都宮駅", 36.5592, 139.8985),
    "gunma": ("前橋駅", 36.38321, 139.07264),
    "saitama": ("大宮駅", 35.9065, 139.6240),
    "chiba": ("千葉駅", 35.6130, 140.1135),
    "tokyo": ("東京駅", 35.6812, 139.7671),
    "kanagawa": ("横浜駅", 35.4658, 139.6224),
    "niigata": ("新潟駅", 37.9122, 139.0617),
    "toyama": ("富山駅", 36.7012, 137.2132),
    "ishikawa": ("金沢駅", 36.5781, 136.6478),
    "fukui": ("福井駅", 36.0620, 136.2227),
    "yamanashi": ("甲府駅", 35.6670, 138.5686),
    "nagano": ("長野駅", 36.6430, 138.1884),
    "gifu": ("岐阜駅", 35.4097, 136.7564),
    "shizuoka": ("静岡駅", 34.9718, 138.3890),
    "aichi": ("名古屋駅", 35.1709, 136.8815),
    "mie": ("津駅", 34.73399, 136.51026),
    "shiga": ("大津駅", 35.00376, 135.86411),
    "kyoto": ("京都駅", 34.9858, 135.7588),
    "osaka": ("大阪駅", 34.7025, 135.4959),
    "hyogo": ("三ノ宮駅", 34.6945, 135.1953),
    "nara": ("奈良駅", 34.6815, 135.8190),
    "wakayama": ("和歌山駅", 34.23221, 135.19158),
    "tottori": ("鳥取駅", 35.49399, 134.22594),
    "shimane": ("松江駅", 35.46418, 133.06285),
    "okayama": ("岡山駅", 34.6666, 133.9181),
    "hiroshima": ("広島駅", 34.3977, 132.4753),
    "yamaguchi": ("山口駅", 34.17261, 131.48083),
    "tokushima": ("徳島駅", 34.0742, 134.5517),
    "kagawa": ("高松駅", 34.3505, 134.0467),
    "ehime": ("松山駅", 33.83993, 132.75074),
    "kochi": ("高知駅", 33.5675, 133.5436),
    "fukuoka": ("博多駅", 33.5897, 130.4207),
    "saga": ("佐賀駅", 33.26418, 130.29736),
    "nagasaki": ("長崎駅", 32.75239, 129.86892),
    "kumamoto": ("熊本駅", 32.7900, 130.6890),
    "oita": ("大分駅", 33.2336, 131.6065),
    "miyazaki": ("宮崎駅", 31.91575, 131.43195),
    "kagoshima": ("鹿児島中央駅", 31.5840, 130.5414),
    "okinawa": ("旭橋駅", 26.21185, 127.67546),
}


@dataclass(frozen=True)
class AreaConfig:
    id: str
    code: str
    name: str
    center: tuple[float, float]
    max_leg_km: float
    mode: str


AREAS = (
    AreaConfig("hokkaido", "JP-01", "北海道", (0, 0), 30.0, "car"),
    AreaConfig("aomori", "JP-02", "青森県", (0, 0), 20.0, "car"),
    AreaConfig("iwate", "JP-03", "岩手県", (0, 0), 20.0, "car"),
    AreaConfig("miyagi", "JP-04", "宮城県", (0, 0), 15.0, "car"),
    AreaConfig("akita", "JP-05", "秋田県", (0, 0), 20.0, "car"),
    AreaConfig("yamagata", "JP-06", "山形県", (0, 0), 20.0, "car"),
    AreaConfig("fukushima", "JP-07", "福島県", (0, 0), 20.0, "car"),
    AreaConfig("ibaraki", "JP-08", "茨城県", (0, 0), 15.0, "car"),
    AreaConfig("tochigi", "JP-09", "栃木県", (0, 0), 15.0, "car"),
    AreaConfig("gunma", "JP-10", "群馬県", (0, 0), 15.0, "car"),
    AreaConfig("saitama", "JP-11", "埼玉県", (0, 0), 8.0, "public_transport"),
    AreaConfig("chiba", "JP-12", "千葉県", (0, 0), 10.0, "public_transport"),
    AreaConfig("tokyo", "JP-13", "東京都", (0, 0), 4.0, "public_transport"),
    AreaConfig("kanagawa", "JP-14", "神奈川県", (0, 0), 6.0, "public_transport"),
    AreaConfig("niigata", "JP-15", "新潟県", (0, 0), 15.0, "car"),
    AreaConfig("toyama", "JP-16", "富山県", (0, 0), 12.0, "car"),
    AreaConfig("ishikawa", "JP-17", "石川県", (0, 0), 10.0, "public_transport"),
    AreaConfig("fukui", "JP-18", "福井県", (0, 0), 15.0, "car"),
    AreaConfig("yamanashi", "JP-19", "山梨県", (0, 0), 15.0, "car"),
    AreaConfig("nagano", "JP-20", "長野県", (0, 0), 20.0, "car"),
    AreaConfig("gifu", "JP-21", "岐阜県", (0, 0), 15.0, "car"),
    AreaConfig("shizuoka", "JP-22", "静岡県", (0, 0), 15.0, "car"),
    AreaConfig("aichi", "JP-23", "愛知県", (0, 0), 8.0, "public_transport"),
    AreaConfig("mie", "JP-24", "三重県", (0, 0), 15.0, "car"),
    AreaConfig("shiga", "JP-25", "滋賀県", (0, 0), 10.0, "car"),
    AreaConfig("kyoto", "JP-26", "京都府", (0, 0), 5.0, "public_transport"),
    AreaConfig("osaka", "JP-27", "大阪府", (0, 0), 5.0, "public_transport"),
    AreaConfig("hyogo", "JP-28", "兵庫県", (0, 0), 12.0, "car"),
    AreaConfig("nara", "JP-29", "奈良県", (0, 0), 8.0, "public_transport"),
    AreaConfig("wakayama", "JP-30", "和歌山県", (0, 0), 15.0, "car"),
    AreaConfig("tottori", "JP-31", "鳥取県", (0, 0), 15.0, "car"),
    AreaConfig("shimane", "JP-32", "島根県", (0, 0), 15.0, "car"),
    AreaConfig("okayama", "JP-33", "岡山県", (0, 0), 10.0, "car"),
    AreaConfig("hiroshima", "JP-34", "広島県", (0, 0), 10.0, "public_transport"),
    AreaConfig("yamaguchi", "JP-35", "山口県", (0, 0), 15.0, "car"),
    AreaConfig("tokushima", "JP-36", "徳島県", (0, 0), 12.0, "car"),
    AreaConfig("kagawa", "JP-37", "香川県", (0, 0), 10.0, "car"),
    AreaConfig("ehime", "JP-38", "愛媛県", (0, 0), 12.0, "car"),
    AreaConfig("kochi", "JP-39", "高知県", (0, 0), 15.0, "car"),
    AreaConfig("fukuoka", "JP-40", "福岡県", (0, 0), 5.0, "public_transport"),
    AreaConfig("saga", "JP-41", "佐賀県", (0, 0), 12.0, "car"),
    AreaConfig("nagasaki", "JP-42", "長崎県", (0, 0), 12.0, "car"),
    AreaConfig("kumamoto", "JP-43", "熊本県", (0, 0), 12.0, "car"),
    AreaConfig("oita", "JP-44", "大分県", (0, 0), 12.0, "car"),
    AreaConfig("miyazaki", "JP-45", "宮崎県", (0, 0), 15.0, "car"),
    AreaConfig("kagoshima", "JP-46", "鹿児島県", (0, 0), 15.0, "car"),
    AreaConfig("okinawa", "JP-47", "沖縄県", (0, 0), 8.0, "car"),
)

# One request per tag category, each with a small output limit.
CATEGORY_SELECTORS: dict[str, str] = {
    "tourism": 'node["tourism"~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|aquarium|picnic_site)$"]["name"]',
    "worship": 'node["amenity"="place_of_worship"]["name"]',
    "historic": 'node["historic"~"^(castle|monument|archaeological_site|memorial|ruins)$"]["name"]',
    "food": 'node["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"]',
}
EXTRACT_DIR = Path(__file__).resolve().parents[1] / "data" / "osm_extract"
FOOD_AMENITIES = {"restaurant", "cafe", "fast_food", "food_court"}
OUTPUT_LIMIT = 100
MAX_TOURISM_CANDIDATES = 300
MAX_FOOD_CANDIDATES = 600
REQUEST_TIMEOUT_SECONDS = 25
MAX_SPLIT_DEPTH = 4
RETRIES = 2
REQUEST_PAUSE_SECONDS = 0.5
STATUS_URL = "https://overpass-api.de/api/status"
Bbox = tuple[float, float, float, float]


class _CappedError(Exception):
    """The tile returned OUTPUT_LIMIT elements, so it may be incomplete."""


def _wait_for_slot() -> None:
    # Poll /api/status so we do not queue behind a busy server.
    for _ in range(12):
        try:
            request = urllib.request.Request(STATUS_URL, headers={"User-Agent": "KyotoRoutePlanner/1.0"})
            with urllib.request.urlopen(request, timeout=10) as response:
                text = response.read().decode("utf-8", "replace")
        except Exception:
            time.sleep(5)
            return
        if "slots available now" in text and not text.split("slots available now")[0].strip().endswith("0"):
            return
        time.sleep(5)


def _overpass(selector: str, bbox: Bbox) -> list[dict[str, Any]]:
    query = (
        f"[out:json][timeout:{REQUEST_TIMEOUT_SECONDS}];"
        f"{selector}({bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f});"
        f"out center tags {OUTPUT_LIMIT};"
    )
    cache_path = CACHE_DIR / f"{hashlib.sha256(query.encode()).hexdigest()}.json"
    if cache_path.exists():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        elements = cached.get("elements") if isinstance(cached, dict) else None
        if isinstance(elements, list):
            return _checked(elements)
    request = urllib.request.Request(
        f"{OVERPASS_URL}?{urllib.parse.urlencode({'data': query})}",
        headers={"User-Agent": "KyotoRoutePlanner/1.0"},
    )
    last_error: Exception | None = None
    for attempt in range(RETRIES + 1):
        _wait_for_slot()
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS + 15) as response:
                payload = json.load(response)
            elements = payload.get("elements")
            # A 200 with a remark means the query was aborted server-side; never cache it.
            if not isinstance(elements, list) or payload.get("remark"):
                raise RuntimeError(f"incomplete response: {payload.get('remark', 'no elements')}")
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            time.sleep(REQUEST_PAUSE_SECONDS)
            return _checked(elements)
        except _CappedError:
            raise
        except Exception as error:
            last_error = error
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass request failed: {last_error}")


def _checked(elements: list[Any]) -> list[dict[str, Any]]:
    items = [item for item in elements if isinstance(item, dict)]
    if len(items) >= OUTPUT_LIMIT:
        raise _CappedError
    return items


def _nominatim_bbox(name: str, code: str) -> tuple[float, float, float, float]:
    queries = (f"{code} Japan", f"{name.replace('県', '').replace('府', '').replace('都', '')} Prefecture, Japan")
    payload: list[dict[str, Any]] = []
    for query_name in queries:
        request = urllib.request.Request(
            f"{NOMINATIM_URL}?{urllib.parse.urlencode({'q': query_name, 'format': 'jsonv2', 'limit': 1})}",
            headers={"User-Agent": "KyotoRoutePlanner/1.0"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        if payload:
            break
    if not payload or not isinstance(payload[0], dict):
        raise RuntimeError(f"Nominatim returned no boundary for {name}")
    item = payload[0]
    box = item.get("boundingbox")
    if not isinstance(box, list) or len(box) != 4:
        raise RuntimeError(f"Nominatim returned no bounding box for {name}")
    return float(box[0]), float(box[2]), float(box[1]), float(box[3])


def _overpass_subdivided(selector: str, bbox: Bbox, depth: int = 0) -> list[dict[str, Any]]:
    # Split a tile in four when it is capped (too many results) or keeps failing.
    try:
        return _overpass(selector, bbox)
    except (_CappedError, RuntimeError) as error:
        if depth >= MAX_SPLIT_DEPTH:
            if isinstance(error, _CappedError):
                # Dense tile at the finest level: keep the capped (real) subset.
                return _overpass_capped(selector, bbox)
            print(f"warning: skipped tile {bbox}: {error}", file=sys.stderr)
            return []
        south, west, north, east = bbox
        latitude_step = (north - south) / 2
        longitude_step = (east - west) / 2
        elements: list[dict[str, Any]] = []
        for row in range(2):
            for column in range(2):
                cell = (
                    south + row * latitude_step,
                    west + column * longitude_step,
                    south + (row + 1) * latitude_step,
                    west + (column + 1) * longitude_step,
                )
                elements.extend(_overpass_subdivided(selector, cell, depth + 1))
        return elements


def _overpass_capped(selector: str, bbox: Bbox) -> list[dict[str, Any]]:
    global OUTPUT_LIMIT
    original = OUTPUT_LIMIT
    OUTPUT_LIMIT = original + 1
    try:
        return _overpass(selector, bbox)[:original]
    except (_CappedError, RuntimeError):
        return []
    finally:
        OUTPUT_LIMIT = original


def _overpass_grid(selector: str, bbox: Bbox) -> list[dict[str, Any]]:
    south, west, north, east = bbox
    latitude_step = (north - south) / GRID_ROWS
    longitude_step = (east - west) / GRID_COLUMNS
    elements: list[dict[str, Any]] = []
    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            cell = (
                south + row * latitude_step,
                west + column * longitude_step,
                south + (row + 1) * latitude_step,
                west + (column + 1) * longitude_step,
            )
            elements.extend(_overpass_subdivided(selector, cell))
    return elements


def _fetch_area(config: AreaConfig) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    extract_path = EXTRACT_DIR / f"{config.code}.json"
    if extract_path.exists():
        # Offline source: nodes extracted from the Geofabrik PBF (see extract_osm_pbf.py).
        elements = json.loads(extract_path.read_text(encoding="utf-8"))["elements"]
        food = [item for item in elements if item["tags"].get("amenity") in FOOD_AMENITIES]
        tourism = [item for item in elements if item["tags"].get("amenity") not in FOOD_AMENITIES]
        return tourism, food
    bbox = _nominatim_bbox(config.name, config.code)
    tourism: list[dict[str, Any]] = []
    for name in ("tourism", "worship", "historic"):
        tourism.extend(_overpass_grid(CATEGORY_SELECTORS[name], bbox))
    food = _overpass_grid(CATEGORY_SELECTORS["food"], bbox)
    return tourism, food


def _coordinates(element: dict[str, Any]) -> tuple[float, float] | None:
    if isinstance(element.get("lat"), (int, float)) and isinstance(element.get("lon"), (int, float)):
        return float(element["lat"]), float(element["lon"])
    center = element.get("center")
    if isinstance(center, dict) and isinstance(center.get("lat"), (int, float)) and isinstance(center.get("lon"), (int, float)):
        return float(center["lat"]), float(center["lon"])
    return None


def _theme(tags: dict[str, str], category: str) -> str:
    value = f"{tags.get('tourism', '')} {tags.get('historic', '')} {category}".lower()
    if any(word in value for word in ("museum", "castle", "monument", "memorial", "historic")):
        return "history"
    if any(word in value for word in ("park", "viewpoint", "picnic", "nature", "zoo", "aquarium")):
        return "nature"
    if any(word in value for word in ("temple", "shrine", "wayside")):
        return "temple"
    return "all"


def _category(tags: dict[str, str], food: bool = False) -> str:
    if food:
        return "飲食店"
    if tags.get("historic"):
        return "史跡"
    mapping = {
        "museum": "博物館",
        "gallery": "美術館",
        "viewpoint": "展望地",
        "zoo": "動物園",
        "aquarium": "水族館",
        "theme_park": "テーマパーク",
        "attraction": "観光名所",
        "picnic_site": "自然",
    }
    return mapping.get(tags.get("tourism", ""), "観光名所")


def _to_candidate(element: dict[str, Any], food: bool = False) -> dict[str, Any] | None:
    tags = element.get("tags")
    point = _coordinates(element)
    if not isinstance(tags, dict) or point is None:
        return None
    name = tags.get("name:ja") or tags.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    kind = str(element.get("type", "element"))
    identifier = element.get("id")
    if not isinstance(identifier, int):
        return None
    category = _category(tags, food)
    themes = ["food"] if food else [_theme(tags, category)]
    place = Place(
        id=f"osm-{kind}-{identifier}",
        name=name.strip(),
        category=category,
        description="OpenStreetMap掲載スポット",
        access_point="座標から経路検索",
        latitude=point[0],
        longitude=point[1],
        themes=themes,
        tags={key: str(value) for key, value in tags.items() if key in {"tourism", "historic", "wikidata", "wikipedia"}},
    )
    return {"place": place, "score": calculate_place_score(place, themes[0])}


def _distance(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, first)
    lat2, lon2 = map(math.radians, second)
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


def _travel_minutes(distance_km: float, mode: str) -> int:
    speed = {"car": 35.0, "public_transport": 20.0, "walk": 4.0}[mode]
    detour = {"car": 1.3, "public_transport": 1.5, "walk": 1.25}[mode]
    return math.ceil(distance_km * detour / speed * 60)


def _lunch_radius(config: AreaConfig) -> float:
    return LUNCH_RADIUS_BY_MODE[config.mode]


_MAIN_LANDMASS_CACHE: dict[str, Any] = {}
_BOUNDARY_FEATURES: dict[str, Any] = {}


def _boundary_features() -> dict[str, Any]:
    if not _BOUNDARY_FEATURES:
        if not BOUNDARIES_PATH.exists():
            raise RuntimeError(f"prefecture boundaries not found: {BOUNDARIES_PATH}")
        data = json.loads(BOUNDARIES_PATH.read_text(encoding="utf-8"))
        _BOUNDARY_FEATURES.update({item["properties"]["shapeISO"]: item["geometry"] for item in data["features"]})
    return _BOUNDARY_FEATURES


def main_landmass(code: str) -> Any:
    """Prepared geometry of the prefecture's largest contiguous landmass.

    Islands and detached parts are excluded so that no leg needs a ferry or flight,
    which the distance-based travel time cannot represent.
    """
    if code not in _MAIN_LANDMASS_CACHE:
        from shapely.geometry import shape
        from shapely.prepared import prep

        features = _boundary_features()
        if code not in features:
            raise RuntimeError(f"{code}: no boundary polygon")
        geometry = shape(features[code])
        parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
        _MAIN_LANDMASS_CACHE[code] = prep(max(parts, key=lambda part: part.area))
    return _MAIN_LANDMASS_CACHE[code]


def on_main_landmass(code: str, latitude: float, longitude: float) -> bool:
    from shapely.geometry import Point

    return bool(main_landmass(code).covers(Point(longitude, latitude)))


def _restrict_to_main_landmass(config: AreaConfig, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        item for item in candidates
        if on_main_landmass(config.code, item["place"].latitude, item["place"].longitude)
    ]


def _dedupe(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, int, int]] = set()
    result = []
    for candidate in sorted(candidates, key=lambda item: (item["place"].name, item["place"].id)):
        place = candidate["place"]
        key = (place.name, round(place.latitude * 10000), round(place.longitude * 10000))
        if key not in seen:
            seen.add(key)
            result.append(candidate)
    return result


def _select_routes(config: AreaConfig, candidates: list[dict[str, Any]], foods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(candidates) < 16:
        raise RuntimeError(f"{config.id}: only {len(candidates)} tourism candidates were returned")
    remaining = candidates[:]
    routes: list[dict[str, Any]] = []
    for route_index, (pattern, count) in enumerate((("half_day", 3), ("half_day", 3), ("half_day", 3), ("full_day", 4), ("full_day", 4))):
        if pattern == "full_day":
            lunch_options = []
            for food in foods:
                nearby = [
                    item for item in remaining
                    if _distance(
                        (food["place"].latitude, food["place"].longitude),
                        (item["place"].latitude, item["place"].longitude),
                    ) <= config.max_leg_km
                ]
                close = [
                    item for item in nearby
                    if _distance(
                        (food["place"].latitude, food["place"].longitude),
                        (item["place"].latitude, item["place"].longitude),
                    ) <= _lunch_radius(config)
                ]
                if len(nearby) >= count and len(close) >= 3:
                    lunch_options.append((food, nearby, close))
            if not lunch_options:
                raise RuntimeError(f"{config.id}: no lunch cluster with four tourism candidates")
            lunch, nearby, close = min(lunch_options, key=lambda option: (-option[0]["score"], option[0]["place"].id))
            ranked_close = sorted(close, key=lambda item: (-item["score"], item["place"].id))
            first = ranked_close[0]
            second_options = [
                item for item in ranked_close[1:]
                if _distance((first["place"].latitude, first["place"].longitude), (item["place"].latitude, item["place"].longitude)) <= config.max_leg_km
            ]
            if not second_options:
                raise RuntimeError(f"{config.id}: lunch cluster has no morning pair within the leg limit")
            second = second_options[0]
            third = next(item for item in ranked_close if item is not first and item is not second)
            ordered = [first, second, third]
            remaining_nearby = [item for item in nearby if item not in ordered]
            while len(ordered) < count:
                current = ordered[-1]["place"]
                options = [
                    item for item in remaining_nearby
                    if _distance((current.latitude, current.longitude), (item["place"].latitude, item["place"].longitude)) <= config.max_leg_km
                ]
                if not options:
                    raise RuntimeError(f"{config.id}: could not complete lunch cluster")
                next_item = min(options, key=lambda item: (-item["score"], item["place"].id))
                ordered.append(next_item)
                remaining_nearby.remove(next_item)
            for item in ordered:
                if item in remaining:
                    remaining.remove(item)
            spots = [_spot(ordered[0], "stop"), _spot(ordered[1], "stop"), _spot(lunch, "lunch"), _spot(ordered[2], "stop"), _spot(ordered[3], "stop")]
            routes.append(_route(config, route_index, pattern, ordered, spots))
            continue
        if pattern == "full_day":
            lunch_ready = [
                item for item in remaining
                if any(
                    _distance(
                        (item["place"].latitude, item["place"].longitude),
                        (food["place"].latitude, food["place"].longitude),
                    ) <= _lunch_radius(config)
                    for food in foods
                )
            ]
            if not lunch_ready:
                raise RuntimeError(f"{config.id}: no tourism candidate near a lunch candidate")
            seed = min(lunch_ready, key=lambda item: (-item["score"], item["place"].id))
        else:
            seed = remaining[0]
        selected: list[dict[str, Any]] = []
        for seed in ([seed] if pattern == "full_day" else remaining[:]):
            chain = [seed]
            pool = [item for item in remaining if item is not seed]
            while len(chain) < count:
                current = chain[-1]["place"]
                options = [
                    item for item in pool
                    if _distance((current.latitude, current.longitude), (item["place"].latitude, item["place"].longitude)) <= config.max_leg_km
                ]
                if not options:
                    break
                next_item = min(options, key=lambda item: (-item["score"], item["place"].id))
                chain.append(next_item)
                pool.remove(next_item)
            if len(chain) == count:
                selected = chain
                break
        if not selected:
            raise RuntimeError(f"{config.id}: could not build route {route_index + 1} within distance limits")
        for item in selected:
            remaining.remove(item)
        # Keep chain order: every consecutive leg was already checked against max_leg_km.
        ordered = selected
        spots = [_spot(item, "stop") for item in ordered]
        if pattern == "full_day":
            lunch_anchor = (ordered[1]["place"], ordered[2]["place"])
            lunch_candidates = [
                item for item in foods
                if _distance((item["place"].latitude, item["place"].longitude), (lunch_anchor[0].latitude, lunch_anchor[0].longitude)) <= _lunch_radius(config)
                and _distance((item["place"].latitude, item["place"].longitude), (lunch_anchor[1].latitude, lunch_anchor[1].longitude)) <= _lunch_radius(config)
            ]
            if not lunch_candidates:
                raise RuntimeError(f"{config.id}: no lunch candidate near route {route_index + 1}")
            lunch = min(lunch_candidates, key=lambda item: (-item["score"], item["place"].id))
            spots.insert(2, _spot(lunch, "lunch"))
        routes.append(_route(config, route_index, pattern, ordered, spots))
    return routes


def _spot(candidate: dict[str, Any], role: str) -> dict[str, Any]:
    place = candidate["place"]
    return {
        "place_id": place.id,
        "name": place.name,
        "category": place.category,
        "lat": place.latitude,
        "lng": place.longitude,
        "stay_minutes": 60 if role == "lunch" else 45,
        "score": round(candidate["score"], 1),
        "role": role,
    }


def _leg_mode(distance_km: float, mode: str) -> str:
    return "walk" if distance_km <= WALK_MAX_KM else mode


def build_legs(config: AreaConfig, station: tuple[str, float, float], spots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Legs of one route: station -> first spot, spot -> spot, last spot -> station."""
    points = [(station[0], station[1], station[2])]
    points += [(spot["name"], spot["lat"], spot["lng"]) for spot in spots]
    points.append(points[0])
    legs = []
    for first, second in zip(points, points[1:]):
        distance = _distance((first[1], first[2]), (second[1], second[2]))
        mode = _leg_mode(distance, config.mode)
        legs.append({
            "from": first[0],
            "to": second[0],
            "distance_km": round(distance, 2),
            "mode": mode,
            "minutes": _travel_minutes(distance, mode),
        })
    return legs


def _route(config: AreaConfig, index: int, pattern: str, ordered: list[dict[str, Any]], spots: list[dict[str, Any]]) -> dict[str, Any]:
    station_name, station_lat, station_lng = STATIONS[config.id]
    to_first_km = _distance((station_lat, station_lng), (spots[0]["lat"], spots[0]["lng"]))
    from_last_km = _distance((spots[-1]["lat"], spots[-1]["lng"]), (station_lat, station_lng))
    legs = build_legs(config, STATIONS[config.id], spots)
    travel = sum(leg["minutes"] for leg in legs)
    stay = sum(spot["stay_minutes"] for spot in spots)
    course = course_for(pattern, stay + travel)
    theme = max(
        (item["place"].themes[0] for item in ordered),
        key=lambda value: (sum(value == item["place"].themes[0] for item in ordered), value),
    )
    theme_label = {"nature": "自然", "history": "歴史", "temple": "寺社", "food": "グルメ", "all": "名所"}[theme]
    title = f"{config.name}の{theme_label}スポットをめぐる{('一日' if course == 'full_day' else '半日')}ルート"
    center = (
        round(sum(spot["lat"] for spot in spots) / len(spots), 6),
        round(sum(spot["lng"] for spot in spots) / len(spots), 6),
    )
    return {
        "id": f"osm-{config.id}-{index + 1:02d}",
        "area": config.id,
        "pattern": pattern,
        "course": course,
        "title": title,
        "estimated_minutes": stay + travel,
        "legs": legs,
        "start": {
            "name": station_name,
            "lat": station_lat,
            "lng": station_lng,
            "to_first_km": round(to_first_km, 1),
            "from_last_km": round(from_last_km, 1),
        },
        "total_score": round(sum(spot["score"] for spot in spots) / len(spots), 1),
        "center": list(center),
        "spots": spots,
        "coordinates": [[spot["lat"], spot["lng"]] for spot in spots],
    }


def generate_area(config: AreaConfig) -> dict[str, Any]:
    tourism_elements, food_elements = _fetch_area(config)
    candidates = _dedupe([item for element in tourism_elements if (item := _to_candidate(element)) is not None])
    foods = _dedupe([item for element in food_elements if (item := _to_candidate(element, True)) is not None])
    candidates = _restrict_to_main_landmass(config, candidates)
    foods = _restrict_to_main_landmass(config, foods)
    _, station_lat, station_lng = STATIONS[config.id]
    base_radius = START_RADIUS_KM[config.mode]
    last_error: RuntimeError | None = None
    for step in START_RADIUS_STEPS:
        radius = base_radius * step
        near = [c for c in candidates if _distance((station_lat, station_lng), (c["place"].latitude, c["place"].longitude)) <= radius]
        near_foods = [f for f in foods if _distance((station_lat, station_lng), (f["place"].latitude, f["place"].longitude)) <= radius]
        # Rank by score and trim so selection stays fast on dense prefectures (e.g. Tokyo).
        near = sorted(near, key=lambda item: (-item["score"], item["place"].id))[:MAX_TOURISM_CANDIDATES]
        near_foods = sorted(near_foods, key=lambda item: (-item["score"], item["place"].id))[:MAX_FOOD_CANDIDATES]
        try:
            routes = _select_routes(config, near, near_foods)
        except RuntimeError as error:
            last_error = error
            continue
        if step > 1.0:
            print(f"note: {config.id}: start radius widened to {radius:.0f} km", file=sys.stderr)
        break
    else:
        raise RuntimeError(f"{config.id}: no routes within {base_radius * START_RADIUS_STEPS[-1]:.0f} km of the station: {last_error}")
    return {
        "version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "area": config.id,
        "generator_version": GENERATOR_VERSION,
        "start_radius_km": radius,
        "routes": routes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=FRONTEND_DATA_DIR)
    parser.add_argument("--areas", nargs="+", choices=[area.id for area in AREAS], default=[area.id for area in AREAS])
    parser.add_argument("--index-only", action="store_true", help="Rebuild index.json from existing datasets without API access.")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    configs = [area for area in AREAS if area.id in args.areas]
    if not args.index_only:
        for config in configs:
            dataset = generate_area(config)
            path = args.output / f"{config.id}.json"
            path.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    entries = []
    for path in sorted(args.output.glob("*.json")):
        if path.name == "index.json":
            continue
        dataset = json.loads(path.read_text(encoding="utf-8"))
        config = next((area for area in AREAS if area.id == dataset.get("area")), None)
        routes = dataset.get("routes", [])
        if config is None or not routes:
            continue
        route_centers = [route["center"] for route in routes]
        entries.append({
            "id": config.id,
            "prefecture_code": config.code.removeprefix("JP-"),
            "name": config.name,
            "center": [
                round(sum(center[0] for center in route_centers) / len(route_centers), 6),
                round(sum(center[1] for center in route_centers) / len(route_centers), 6),
            ],
            "route_count": len(routes),
            "file": path.name,
        })
    entries.sort(key=lambda entry: entry["prefecture_code"])
    index = {"version": 1, "generated_at": datetime.now(UTC).isoformat(), "prefectures": entries}
    (args.output / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
