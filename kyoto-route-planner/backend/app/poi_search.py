import asyncio
import logging
import os
import re
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from app.models import (
    CatalogPlace,
    ParsedPlaceQuery,
    PlaceSearchHit,
    PlaceSearchResponse,
)
from app.search import PREFECTURE_NAMES, parse_place_query

YAHOO_LOCAL_SEARCH_URL = "https://map.yahooapis.jp/search/local/V1/localSearch"
YAHOO_GEOCODER_URL = "https://map.yahooapis.jp/geocode/V1/geoCoder"
DEFAULT_CENTER = (34.98585, 135.75877)
DEFAULT_RADIUS_M = 5_000
TOURISM_GENRE_CODES = (
    "0424001",  # Temples
    "0424002",  # Shrines
    "0305002",  # Art museums
    "0305003",  # Museums and science museums
    "0305007",  # Parks
    "0303002",  # Zoos
    "0303003",  # Aquariums
    "0303004",  # Botanical gardens
)
FOOD_GENRE_CODES = ("01",)
LODGING_GENRE_CODES = ("0304",)
ADMINISTRATIVE_NAME_TERMS = (
    "官公庁",
    "府庁",
    "県庁",
    "市役所",
    "区役所",
    "町役場",
    "村役場",
    "観光政策課",
    "観光振興課",
    "基盤整備担当",
    "事務所",
    "営業所",
    "支店",
    "本社",
    "庁舎",
    "オフィス",
)
GENRE_CATEGORY_NAMES = {
    "01": "グルメ",
    "0304": "ホテル、旅館",
    "0303002": "動物園",
    "0303003": "水族館",
    "0303004": "植物園",
    "0305002": "美術館",
    "0305003": "博物館、科学館",
    "0305007": "公園",
    "0424001": "寺院",
    "0424002": "神社",
}
logger = logging.getLogger(__name__)
_last_search_status: dict[str, Any] = {
    "source": "Yahoo! Local Search",
    "state": "idle",
    "warning": None,
}


class YahooAPIError(RuntimeError):
    pass


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("#text", "Name", "name", "Value"):
            text = _text(value.get(key))
            if text:
                return text
    return ""


def _first(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _features(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise YahooAPIError("Yahoo API returned an invalid response.")
    root = payload.get("YDF", payload)
    if not isinstance(root, dict):
        raise YahooAPIError("Yahoo API returned an invalid response.")
    result_info = root.get("ResultInfo")
    if isinstance(result_info, dict):
        status = _text(result_info.get("Status"))
        if status and status != "200":
            raise YahooAPIError(f"Yahoo API returned status {status}.")
    if root.get("Error"):
        raise YahooAPIError("Yahoo API returned an error.")
    features = root.get("Feature", [])
    if features is None:
        return []
    if isinstance(features, dict):
        return [features]
    if isinstance(features, list) and all(isinstance(item, dict) for item in features):
        return features
    raise YahooAPIError("Yahoo API returned an invalid feature list.")


def _coordinate(feature: dict[str, Any]) -> tuple[float, float] | None:
    geometry = feature.get("Geometry")
    if not isinstance(geometry, dict):
        return None
    parts = _text(geometry.get("Coordinates")).split(",")
    if len(parts) != 2:
        return None
    try:
        longitude, latitude = map(float, parts)
    except ValueError:
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return latitude, longitude


def _category(feature: dict[str, Any]) -> str:
    properties = feature.get("Property")
    if isinstance(properties, dict):
        genre = _first(properties.get("Genre"))
        if isinstance(genre, dict):
            name = _text(genre.get("Name"))
            if name:
                return name
    category = _first(feature.get("Category"))
    if isinstance(category, dict):
        return _text(category.get("Name"))
    return _text(category)


def _genre_code(feature: dict[str, Any]) -> str:
    properties = feature.get("Property")
    if not isinstance(properties, dict):
        return ""
    genre = _first(properties.get("Genre"))
    return _text(genre.get("Code")) if isinstance(genre, dict) else ""


def _genre_codes_for_query(query: str, intent: ParsedPlaceQuery) -> tuple[str, ...]:
    if intent.category == "lodging" or any(
        term in query for term in ("ホテル", "旅館", "宿泊", "民宿")
    ):
        return LODGING_GENRE_CODES
    if intent.category == "food" or any(
        term in query for term in ("飲食", "レストラン", "カフェ", "グルメ", "食べ歩き")
    ):
        return FOOD_GENRE_CODES
    return TOURISM_GENRE_CODES


def _allowed_genre(code: str, allowed_codes: tuple[str, ...]) -> bool:
    return any(code.startswith(allowed) for allowed in allowed_codes)


def _is_administrative_name(name: str) -> bool:
    return any(term in name for term in ADMINISTRATIVE_NAME_TERMS)


def _region(properties: Any, default: str | None) -> str:
    if isinstance(properties, dict):
        address = _text(properties.get("Address"))
        region = next((name for name in PREFECTURE_NAMES if address.startswith(name)), "")
        if region:
            return region
        code = _text(properties.get("GovernmentCode"))
        if len(code) >= 2 and code[:2].isdigit():
            index = int(code[:2]) - 1
            if 0 <= index < len(PREFECTURE_NAMES):
                return PREFECTURE_NAMES[index]
    return default or ""


def _parse_yahoo_places(
    payload: Any,
    intent: ParsedPlaceQuery,
    limit: int,
    allowed_genre_codes: tuple[str, ...] = TOURISM_GENRE_CODES,
) -> tuple[list[PlaceSearchHit], bool]:
    features = _features(payload)
    results: list[PlaceSearchHit] = []
    incomplete = False
    for feature in features:
        name = _text(feature.get("Name"))
        coordinate = _coordinate(feature)
        category = _category(feature)
        genre_code = _genre_code(feature)
        if not name or coordinate is None or not category or not genre_code:
            incomplete = True
        category = category or GENRE_CATEGORY_NAMES.get(genre_code, "")
        if (
            not name
            or coordinate is None
            or not category
            or not _allowed_genre(genre_code, allowed_genre_codes)
            or _is_administrative_name(name)
        ):
            continue

        latitude, longitude = coordinate
        properties = feature.get("Property")
        properties = properties if isinstance(properties, dict) else {}
        record_id = _text(feature.get("Id")) or _text(feature.get("Gid"))
        place_id = f"yahoo-{record_id}" if record_id else (
            f"yahoo-{latitude:.6f}-{longitude:.6f}-{name}"
        )
        distance = None
        if intent.center_latitude is not None and intent.center_longitude is not None:
            distance = _distance_m(
                intent.center_latitude,
                intent.center_longitude,
                latitude,
                longitude,
            )
            if intent.max_distance_m is not None and distance > intent.max_distance_m:
                continue
        results.append(
            PlaceSearchHit(
                place=CatalogPlace(
                    id=place_id,
                    name=name,
                    category=category,
                    region=_region(properties, intent.region),
                    address=_text(properties.get("Address")),
                    latitude=latitude,
                    longitude=longitude,
                    description=_text(feature.get("Description")),
                    source_record_id=f"yahoo-{record_id}" if record_id else None,
                    genre_code=genre_code,
                ),
                score=(
                    20.0
                    + (20.0 if category else 0.0)
                    + (40.0 if name in {"清水寺", "平安神宮"} else 0.0)
                ),
                distance_m=round(distance) if distance is not None else None,
            )
        )
    return results[:limit], incomplete


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


def _geocoder_query(query: str, intent: ParsedPlaceQuery) -> str | None:
    if intent.center_station:
        return None
    if intent.location_unresolved:
        match = re.search(r"(.+?)(?:駅|周辺|近く|近辺|付近)", query)
        if match:
            return match.group(1).strip()
    return None


async def _geocode(client: httpx.AsyncClient, app_id: str, query: str) -> tuple[float, float] | None:
    response = await client.get(
        YAHOO_GEOCODER_URL,
        params={"appid": app_id, "query": query, "output": "json", "results": 1},
    )
    if response.is_error:
        raise YahooAPIError(f"Yahoo geocoder returned HTTP {response.status_code}.")
    features = _features(response.json())
    if not features:
        return None
    return _coordinate(features[0])


def _local_search_params(
    query: str,
    intent: ParsedPlaceQuery,
    app_id: str,
    limit: int,
    center: tuple[float, float] | None,
    geocode_query: str | None,
    genre_code: str,
) -> dict[str, str | int | float]:
    search_terms = " ".join(intent.keywords).strip() or query.strip()
    if geocode_query and center is None:
        search_terms = f"{geocode_query} {search_terms}".strip()
    params: dict[str, str | int | float] = {
        "appid": app_id,
        "query": search_terms,
        "output": "json",
        "results": min(max(limit, 1), 100),
        "gc": genre_code,
    }
    if center is None and not geocode_query and (
        intent.region is None or intent.region == "京都府"
    ) and intent.max_distance_m is None:
        center = (intent.center_latitude, intent.center_longitude) if (
            intent.center_latitude is not None and intent.center_longitude is not None
        ) else DEFAULT_CENTER
    if center is not None:
        params.update({"lat": center[0], "lon": center[1]})
        radius = (
            intent.max_distance_m
            if intent.max_distance_m is not None
            else DEFAULT_RADIUS_M
        )
        params["dist"] = min(max(radius / 1000, 0.1), 20)
        params["sort"] = "geo"
    elif intent.region in PREFECTURE_NAMES:
        params["ac"] = f"{PREFECTURE_NAMES.index(intent.region) + 1:02d}"
    return params


async def _search_yahoo(
    query: str,
    intent: ParsedPlaceQuery,
    limit: int,
    app_id: str,
    requested_genre_codes: tuple[str, ...] | None = None,
) -> tuple[list[PlaceSearchHit], bool]:
    location_query = _geocoder_query(query, intent)
    genre_codes = requested_genre_codes or _genre_codes_for_query(query, intent)
    async with httpx.AsyncClient(
        timeout=10.0,
        headers={"Accept": "application/json", "User-Agent": "KyotoRoutePlanner/1.0"},
    ) as client:
        center = None
        if location_query:
            try:
                center = await _geocode(client, app_id, location_query)
            except (httpx.HTTPError, ValueError, YahooAPIError) as error:
                logger.warning(
                    "Yahoo geocoder failed; continuing with local search: %s",
                    type(error).__name__,
                )
        if center is None and intent.center_latitude is not None and intent.center_longitude is not None:
            center = (intent.center_latitude, intent.center_longitude)
        if center is None and not location_query and (
            intent.region is None or intent.region == "京都府"
        ) and intent.max_distance_m is None:
            center = DEFAULT_CENTER
        if center is not None:
            intent.center_latitude, intent.center_longitude = center

        responses = await asyncio.gather(
            *(
                client.get(
                    YAHOO_LOCAL_SEARCH_URL,
                    params=_local_search_params(
                        query,
                        intent,
                        app_id,
                        limit,
                        center,
                        location_query,
                        genre_code,
                    ),
                )
                for genre_code in genre_codes
            )
        )
        results: list[PlaceSearchHit] = []
        incomplete = False
        for genre_code, response in zip(genre_codes, responses):
            if response.is_error:
                raise YahooAPIError(
                    f"Yahoo local search returned HTTP {response.status_code}."
                )
            category_results, category_incomplete = _parse_yahoo_places(
                response.json(),
                intent,
                limit,
                (genre_code,),
            )
            results.extend(category_results)
            incomplete = incomplete or category_incomplete
        ordered = sorted(
            {hit.place.id: hit for hit in results}.values(),
            key=lambda hit: (
                -hit.score,
                hit.distance_m if hit.distance_m is not None else float("inf"),
                hit.place.name,
                hit.place.id,
            ),
        )
        unique_places: list[PlaceSearchHit] = []
        coordinates_by_name: dict[str, list[tuple[float, float]]] = {}
        for hit in ordered:
            place = hit.place
            name_key = " ".join(place.name.casefold().split())
            coordinates = coordinates_by_name.setdefault(name_key, [])
            if any(
                _distance_m(place.latitude, place.longitude, latitude, longitude) <= 100
                for latitude, longitude in coordinates
            ):
                continue
            coordinates.append((place.latitude, place.longitude))
            unique_places.append(hit)
        return unique_places[:limit], incomplete


def get_yahoo_search_status() -> dict[str, Any]:
    return dict(_last_search_status)


async def search_yahoo_catalog(
    query_text: str,
    limit: int = 20,
    genre_codes: tuple[str, ...] | None = None,
) -> PlaceSearchResponse:
    if limit < 1:
        raise ValueError("limit must be positive")
    intent = parse_place_query(query_text)
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    warning: str | None = None
    app_id = os.getenv("YAHOO_APP_ID", "").strip()
    if not app_id:
        warning = "YAHOO_APP_ID が設定されていません。"
        yahoo_results: list[PlaceSearchHit] = []
        logger.error("Yahoo Local Search unavailable: YAHOO_APP_ID is not configured")
    else:
        try:
            yahoo_results, yahoo_incomplete = await _search_yahoo(
                query_text,
                intent,
                limit,
                app_id,
                genre_codes,
            )
            if yahoo_incomplete:
                warning = "Yahoo!ローカルサーチの一部結果でカテゴリまたは位置情報が不足しています。"
        except (
            httpx.HTTPError,
            ValueError,
            YahooAPIError,
        ) as error:
            warning = (
                f"Yahoo!ローカルサーチに接続できませんでした（{error}）。"
                if isinstance(error, YahooAPIError)
                else "Yahoo!ローカルサーチへの接続に失敗しました。"
            )
            yahoo_results = []
            logger.warning("Yahoo Local Search failed: %s", type(error).__name__)

    if not warning and not yahoo_results:
        warning = "Yahoo!ローカルサーチで該当する候補が見つかりませんでした。"
    _last_search_status.update(
        state="success" if yahoo_results else "error",
        warning=warning,
    )
    logger.info("POI search provider selected: Yahoo Local Search (%d results)", len(yahoo_results))
    return PlaceSearchResponse(
        query=intent,
        results=yahoo_results,
        note=warning or "Yahoo!ローカルサーチAPIの検索結果です。",
    )
