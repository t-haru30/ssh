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
GENERATOR_VERSION = "osm-deterministic-v1"
EARTH_RADIUS_KM = 6371.0
LUNCH_RADIUS_BY_MODE = {"car": 8.0, "public_transport": 5.0, "walk": 2.0}
GRID_ROWS = 4
GRID_COLUMNS = 4


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


def _route(config: AreaConfig, index: int, pattern: str, ordered: list[dict[str, Any]], spots: list[dict[str, Any]]) -> dict[str, Any]:
    travel = sum(
        _travel_minutes(
            _distance((first["lat"], first["lng"]), (second["lat"], second["lng"])),
            config.mode,
        )
        for first, second in zip(spots, spots[1:])
    )
    stay = sum(spot["stay_minutes"] for spot in spots)
    theme = max(
        (item["place"].themes[0] for item in ordered),
        key=lambda value: (sum(value == item["place"].themes[0] for item in ordered), value),
    )
    theme_label = {"nature": "自然", "history": "歴史", "temple": "寺社", "food": "グルメ", "all": "名所"}[theme]
    title = f"{config.name}の{theme_label}スポットをめぐる{('半日' if pattern == 'half_day' else '一日')}ルート"
    center = (
        round(sum(spot["lat"] for spot in spots) / len(spots), 6),
        round(sum(spot["lng"] for spot in spots) / len(spots), 6),
    )
    return {
        "id": f"osm-{config.id}-{index + 1:02d}",
        "area": config.id,
        "pattern": pattern,
        "theme": theme,
        "title": title,
        "estimated_minutes": stay + travel,
        "total_score": round(sum(spot["score"] for spot in spots) / len(spots), 1),
        "center": list(center),
        "spots": spots,
        "coordinates": [[spot["lat"], spot["lng"]] for spot in spots],
    }


def generate_area(config: AreaConfig) -> dict[str, Any]:
    tourism_elements, food_elements = _fetch_area(config)
    candidates = _dedupe([item for element in tourism_elements if (item := _to_candidate(element)) is not None])
    foods = _dedupe([item for element in food_elements if (item := _to_candidate(element, True)) is not None])
    # Rank by score and trim so selection stays fast on dense prefectures (e.g. Tokyo).
    candidates = sorted(candidates, key=lambda item: (-item["score"], item["place"].id))[:MAX_TOURISM_CANDIDATES]
    foods = sorted(foods, key=lambda item: (-item["score"], item["place"].id))[:MAX_FOOD_CANDIDATES]
    routes = _select_routes(config, candidates, foods)
    return {
        "version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "area": config.id,
        "generator_version": GENERATOR_VERSION,
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
