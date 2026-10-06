import asyncio
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

from app.database import database_path, initialize_database
from app.models import (
    CatalogPlace,
    Place,
    PlaceSearchHit,
    PlaceSearchResponse,
)
from app.search import parse_place_query

API_URL = "https://overpass-api.de/api/interpreter"
CACHE_KEY = "kyoto-overpass-v2"
CACHE_TTL = timedelta(hours=24)
RATE_LIMIT_PAUSE = timedelta(hours=1)
OUTAGE_PAUSE = timedelta(minutes=15)
QUERY_CENTER = (34.98585, 135.75877)
QUERY_BUFFER_METERS = 5_000
_request_lock = asyncio.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _cache_database(path: Path | None = None) -> Path:
    return initialize_database(path or database_path())


def _cache_entry(path: Path | None = None) -> sqlite3.Row | None:
    target = _cache_database(path)
    with closing(sqlite3.connect(target)) as connection:
        connection.row_factory = sqlite3.Row
        return connection.execute(
            """
            SELECT fetched_at, payload_json, rate_limited, retry_after
            FROM osm_places_cache WHERE cache_key = ?
            """,
            (CACHE_KEY,),
        ).fetchone()


def _cached_places(entry: sqlite3.Row | None) -> list[Place] | None:
    if entry is None:
        return []
    try:
        return _parse_places(json.loads(entry["payload_json"]))
    except (HTTPException, TypeError, ValueError, json.JSONDecodeError):
        return None


def _remove_cache_entry(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute(
            "DELETE FROM osm_places_cache WHERE cache_key = ?",
            (CACHE_KEY,),
        )
        connection.commit()


def _parse_places(elements: Any) -> list[Place]:
    if not isinstance(elements, list):
        raise HTTPException(
            status_code=502,
            detail="Overpass APIからスポット一覧を含まない応答が返されました。",
        )

    places: list[Place] = []
    seen: set[str] = set()
    for element in elements:
        if not isinstance(element, dict):
            continue
        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue
        location = element if "lat" in element and "lon" in element else element.get("center")
        if not isinstance(location, dict):
            continue
        latitude, longitude = location.get("lat"), location.get("lon")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue
        latitude, longitude = float(latitude), float(longitude)
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            continue

        normalized_tags = {
            str(key): str(value)
            for key, value in tags.items()
            if isinstance(value, (str, int, float))
        }

        themes: set[str] = set()
        amenity = str(tags.get("amenity", "")).casefold()
        religion = str(tags.get("religion", "")).casefold()
        historic = str(tags.get("historic", "")).casefold()
        natural = str(tags.get("natural", "")).casefold()
        leisure = str(tags.get("leisure", "")).casefold()
        shop = str(tags.get("shop", "")).casefold()
        if (
            historic in {"temple", "monastery", "church"}
            or tags.get("amenity") == "place_of_worship"
        ):
            themes.add("temple")
        if religion in {"buddhist", "shinto"}:
            themes.add("temple")
        tourism = str(tags.get("tourism", "")).casefold()
        if historic or tourism in {
            "museum",
            "gallery",
            "artwork",
            "attraction",
            "viewpoint",
        }:
            themes.add("history")
        if natural or leisure in {"park", "garden", "nature_reserve"}:
            themes.add("nature")
        if amenity in {"restaurant", "cafe", "fast_food", "food_court", "bar", "pub"}:
            themes.add("food")
        if shop in {
            "convenience",
            "supermarket",
            "marketplace",
            "bakery",
            "butcher",
            "cheese",
            "confectionery",
            "greengrocer",
            "seafood",
            "wine",
        }:
            themes.add("food")

        name = next(
            (
                value.strip()
                for value in (tags.get("name:ja"), tags.get("name"), tags.get("name:en"))
                if isinstance(value, str) and value.strip()
            ),
            "",
        )
        if not name:
            continue

        category_name = next(
            (
                normalized_tags[key]
                for key in ("tourism", "historic", "amenity", "leisure", "natural", "shop")
                if normalized_tags.get(key)
            ),
            "観光スポット",
        )
        osm_type = element.get("type")
        osm_id = element.get("id")
        place_id = f"osm-{osm_type}-{osm_id}" if osm_type is not None and osm_id is not None else ""
        if not place_id:
            place_id = f"osm-{latitude:.6f}-{longitude:.6f}-{name}"
        if place_id in seen:
            continue
        seen.add(place_id)

        address_parts = [
            normalized_tags[key].strip()
            for key in (
                "addr:province",
                "addr:city",
                "addr:suburb",
                "addr:street",
                "addr:housenumber",
            )
            if normalized_tags.get(key, "").strip()
        ]
        places.append(
            Place(
                id=place_id,
                name=name,
                category=category_name,
                description=normalized_tags.get("description", ""),
                access_point="座標から経路検索",
                latitude=latitude,
                longitude=longitude,
                themes=sorted(themes),
                address="".join(address_parts),
                tags=normalized_tags,
            )
        )

    return places


def _retry_after(headers: httpx.Headers) -> str | None:
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        seconds = max(0, int(value))
        return (_now() + timedelta(seconds=seconds)).isoformat()
    except ValueError:
        try:
            reset_at = parsedate_to_datetime(value)
            return reset_at.astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError, OverflowError):
            return None


def _rate_limit_pause(entry: sqlite3.Row) -> bool:
    retry_after = entry["retry_after"]
    if not entry["rate_limited"]:
        return False
    if not retry_after:
        return True
    try:
        return _now() < datetime.fromisoformat(retry_after)
    except ValueError:
        return True


def get_osm_status(path: Path | None = None) -> dict[str, Any]:
    entry = _cache_entry(path)
    if entry is None:
        return {
            "cached_until": None,
            "warning": None,
            "requests_paused": False,
        }

    fetched_at = datetime.fromisoformat(entry["fetched_at"])
    cached_until = fetched_at + CACHE_TTL
    paused = _rate_limit_pause(entry)
    cached_places = _cached_places(entry) or []
    is_stale = _now() >= cached_until
    warning = None
    if paused and is_stale and cached_places:
        warning = (
            "Overpass APIが利用できないため、取得から24時間以上経過した"
            f"キャッシュを代わりに表示しています（取得日時: {fetched_at.astimezone().strftime('%Y-%m-%d %H:%M')}）。"
        )
    elif paused:
        warning = "Overpass APIが利用できないため、追加検索を一時停止しています。"
    return {
        "cached_until": cached_until.isoformat(),
        "warning": warning,
        "requests_paused": paused,
        "using_stale_cache": bool(paused and is_stale and cached_places),
    }


def _build_query() -> str:
    latitude, longitude = QUERY_CENTER
    radius = QUERY_BUFFER_METERS
    selectors = (
        f'nwr(around:{radius},{latitude},{longitude})[name][tourism];',
        f'nwr(around:{radius},{latitude},{longitude})[name][historic];',
        f'nwr(around:{radius},{latitude},{longitude})[name][natural];',
        f'nwr(around:{radius},{latitude},{longitude})[name][leisure~"^(park|garden|nature_reserve)$"];',
        f'nwr(around:{radius},{latitude},{longitude})[name][amenity~"^(restaurant|cafe|fast_food|food_court|bar|pub|place_of_worship)$"];',
        f'nwr(around:{radius},{latitude},{longitude})[name][shop~"^(convenience|supermarket|marketplace|bakery|butcher|cheese|confectionery|greengrocer|seafood|wine)$"];',
    )
    return "[out:json][timeout:25];\n(\n" + "\n".join(selectors) + "\n);\nout center tags;"


async def _load_osm_places(path: Path | None = None) -> list[Place]:
    target = _cache_database(path)
    entry = _cache_entry(target)
    now = _now()
    if entry is not None:
        fetched_at = datetime.fromisoformat(entry["fetched_at"])
        places = _cached_places(entry)
        if entry is not None and places is None:
            _remove_cache_entry(target)
            entry = None
            places = []
        cache_is_fresh = now - fetched_at < CACHE_TTL
        if cache_is_fresh and places:
            return places
        if entry is not None and _rate_limit_pause(entry):
            if places:
                return places
            raise HTTPException(
                status_code=429,
                detail=get_osm_status(target)["warning"]
                or "Overpass APIへの追加検索を一時停止しています。",
            )
        if entry is not None and cache_is_fresh:
            return places

    try:
        async with httpx.AsyncClient(timeout=35.0) as client:
            response = await client.post(
                API_URL,
                data={"data": _build_query()},
                headers={
                    "Accept": "application/json",
                    "User-Agent": "KyotoRoutePlanner/1.0 (non-commercial local app)",
                },
            )
    except httpx.TimeoutException as error:
        stale_places = _record_provider_failure(
            target,
            entry,
            now,
            now + OUTAGE_PAUSE,
        )
        if stale_places:
            return stale_places
        raise HTTPException(
            status_code=504,
            detail="Overpass APIの検索がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    except httpx.RequestError as error:
        stale_places = _record_provider_failure(
            target,
            entry,
            now,
            now + OUTAGE_PAUSE,
        )
        if stale_places:
            return stale_places
        raise HTTPException(
            status_code=502,
            detail="Overpass APIに接続できませんでした。",
        ) from error

    if response.status_code == 429:
        stale_places = _record_provider_failure(
            target,
            entry,
            now,
            _retry_after(response.headers)
            or (now + RATE_LIMIT_PAUSE).isoformat(),
        )
        if stale_places:
            return stale_places
        raise HTTPException(
            status_code=429,
            detail=(
                "Overpass APIからリクエスト制限が返されました。"
                "連続アクセスを避けるため、1時間程度おいて再試行してください。"
            ),
        )
    if response.status_code >= 400:
        if response.status_code in (502, 503, 504):
            stale_places = _record_provider_failure(
                target,
                entry,
                now,
                now + OUTAGE_PAUSE,
            )
            if stale_places:
                return stale_places
            raise HTTPException(
                status_code=503,
                detail="Overpass APIが一時的に利用できません。時間をおいて再試行してください。",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Overpass APIがHTTP {response.status_code}を返しました。",
        )
    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail="Overpass APIからJSON形式でない応答が返されました。",
        ) from error
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail="Overpass APIの応答形式が不正です。",
        )
    places = _parse_places(payload.get("elements"))
    if not places:
        raise HTTPException(
            status_code=502,
            detail="Overpass APIから有効な名称・位置情報が返されませんでした。",
        )

    fetched_at = _now().isoformat()
    with closing(sqlite3.connect(target)) as connection:
        connection.execute(
            """
            INSERT INTO osm_places_cache (
                cache_key, fetched_at, payload_json,
                rate_limited, retry_after
            ) VALUES (?, ?, ?, 0, NULL)
            ON CONFLICT(cache_key) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                payload_json = excluded.payload_json,
                rate_limited = 0,
                retry_after = NULL
            """,
            (
                CACHE_KEY,
                fetched_at,
                json.dumps(payload["elements"], ensure_ascii=False),
            ),
        )
        connection.commit()
    return places


def _record_provider_failure(
    target: Path,
    entry: sqlite3.Row | None,
    now: datetime,
    retry_after: datetime | str,
) -> list[Place]:
    cached_payload = entry["payload_json"] if entry is not None else "[]"
    cached_fetched_at = (
        entry["fetched_at"]
        if entry is not None
        else (now - CACHE_TTL).isoformat()
    )
    retry_after_value = (
        retry_after.isoformat() if isinstance(retry_after, datetime) else retry_after
    )
    with closing(sqlite3.connect(target)) as connection:
        connection.execute(
            """
            INSERT INTO osm_places_cache (
                cache_key, fetched_at, payload_json, rate_limited, retry_after
            ) VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                rate_limited = 1,
                retry_after = excluded.retry_after
            """,
            (CACHE_KEY, cached_fetched_at, cached_payload, retry_after_value),
        )
        connection.commit()
    return _parse_places(json.loads(cached_payload))


async def list_osm_places(path: Path | None = None) -> list[Place]:
    async with _request_lock:
        return await _load_osm_places(path)


def _distance_m(
    first_latitude: float,
    first_longitude: float,
    second_latitude: float,
    second_longitude: float,
) -> float:
    latitude_delta = radians(second_latitude - first_latitude)
    longitude_delta = radians(second_longitude - first_longitude)
    value = (
        sin(latitude_delta / 2) ** 2
        + cos(radians(first_latitude))
        * cos(radians(second_latitude))
        * sin(longitude_delta / 2) ** 2
    )
    return 6_371_000 * 2 * asin(sqrt(value))


def _matches_preference(place: Place, label_type: str, label: str) -> bool:
    tags = {key.casefold(): value.casefold() for key, value in place.tags.items()}
    if label_type == "atmosphere":
        if label == "自然豊か":
            return "nature" in place.themes
        if label == "歴史的":
            return "history" in place.themes
        if label == "都会的":
            return tags.get("landuse") in {"commercial", "retail"}
    if label_type == "target_audience":
        if label == "ファミリー":
            return any(
                tags.get(key) in {"yes", "designated"}
                for key in ("kids_area", "playground", "children")
            ) or tags.get("leisure") == "playground"
        if label == "シニア":
            return tags.get("wheelchair") in {"yes", "limited"}
    if label_type == "activity_type":
        if label == "食べ歩き":
            return "food" in place.themes
        if label == "鑑賞":
            return bool(
                tags.get("tourism") in {"museum", "gallery", "viewpoint", "attraction"}
                or tags.get("amenity") in {"arts_centre", "theatre"}
            )
        if label == "アクティブ":
            return bool(
                tags.get("sport")
                or tags.get("leisure") in {"sports_centre", "fitness_centre"}
            )
        if label == "リラックス":
            return bool("nature" in place.themes or tags.get("leisure") == "spa")
    return False


def _matches_category(place: Place, category: str | None) -> bool:
    if category is None or category == "tourism":
        return True
    tags = {key.casefold(): value.casefold() for key, value in place.tags.items()}
    if category == "food":
        return "food" in place.themes
    if category == "lodging":
        return tags.get("tourism") in {
            "hotel",
            "hostel",
            "guest_house",
            "motel",
            "apartment",
            "camp_site",
        }
    if category == "transport":
        return tags.get("public_transport") in {"station", "stop_position"}
    return False


async def search_osm_places(
    query_text: str,
    path: Path | None = None,
    limit: int = 20,
) -> PlaceSearchResponse:
    intent = parse_place_query(query_text)
    if intent.location_unresolved or (intent.region and intent.region != "京都府"):
        return PlaceSearchResponse(
            query=intent,
            results=[],
            note="検索地点を京都府のOverpass取得範囲内で解決できませんでした。",
        )

    candidates = await list_osm_places(path)
    ranked: list[tuple[float, float, Place]] = []
    for place in candidates:
        if not _matches_category(place, intent.category):
            continue
        if any(
            not _matches_preference(place, preference.label_type, preference.label)
            for preference in intent.preferences
        ):
            continue

        distance = None
        if intent.center_latitude is not None and intent.center_longitude is not None:
            distance = _distance_m(
                intent.center_latitude,
                intent.center_longitude,
                place.latitude,
                place.longitude,
            )
            if intent.max_distance_m is not None and distance > intent.max_distance_m:
                continue

        searchable_text = " ".join(
            (place.name, place.category, place.description, place.address, *place.tags.values())
        ).casefold()
        keyword_matches = sum(keyword.casefold() in searchable_text for keyword in intent.keywords)
        semantic_matches = sum(
            (
                keyword == "神社" or keyword == "寺"
            )
            and "temple" in place.themes
            or keyword == "自然" and "nature" in place.themes
            or keyword == "歴史" and "history" in place.themes
            for keyword in intent.keywords
        )
        keyword_score = (
            min(1.0, (keyword_matches + semantic_matches) / len(intent.keywords))
            if intent.keywords
            else 0.0
        )
        distance_score = (
            1 / (1 + distance / 1000)
            if distance is not None
            else 0.0
        )
        parts: list[tuple[float, float]] = []
        if intent.keywords:
            parts.append((0.65, keyword_score))
        if intent.center_station:
            parts.append((0.35, distance_score))
        score = (
            sum(weight * value for weight, value in parts) / sum(weight for weight, _ in parts)
            if parts
            else 0.0
        )
        ranked.append((score, distance if distance is not None else float("inf"), place))

    ranked.sort(key=lambda item: (-item[0], item[1], item[2].name))
    results = [
        PlaceSearchHit(
            place=CatalogPlace(
                id=place.id,
                name=place.name,
                category=place.category,
                region="京都府",
                address=place.address,
                latitude=place.latitude,
                longitude=place.longitude,
                description=place.description,
                source_record_id=place.id,
            ),
            score=round(score, 4),
            distance_m=round(distance) if distance != float("inf") else None,
        )
        for score, distance, place in ranked[:limit]
    ]
    return PlaceSearchResponse(
        query=intent,
        results=results,
        note=(
            "OpenStreetMapのPOIタグを使ったキーワード・カテゴリ・距離検索です。"
            "ベクトル検索や営業時間の確認は行っていません。"
        ),
    )
