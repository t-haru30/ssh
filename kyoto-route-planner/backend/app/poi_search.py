import logging
import os
import re
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

from app.models import (
    CatalogPlace,
    ParsedPlaceQuery,
    PlaceSearchHit,
    PlaceSearchResponse,
)
from app.overpass import search_osm_places
from app.search import PREFECTURE_NAMES, parse_place_query

YAHOO_LOCAL_SEARCH_URL = "https://map.yahooapis.jp/search/local/V1/localSearch"
YAHOO_GEOCODER_URL = "https://map.yahooapis.jp/geocode/V1/geoCoder"
DEFAULT_CENTER = (34.98585, 135.75877)
DEFAULT_RADIUS_M = 5_000
logger = logging.getLogger(__name__)


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
) -> tuple[list[PlaceSearchHit], bool]:
    features = _features(payload)
    results: list[PlaceSearchHit] = []
    incomplete = False
    for feature in features:
        name = _text(feature.get("Name"))
        coordinate = _coordinate(feature)
        category = _category(feature)
        if not name or coordinate is None or not category:
            incomplete = True
        if not name or coordinate is None:
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
                ),
                score=1.0,
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
) -> dict[str, str | int | float]:
    search_terms = " ".join(intent.keywords).strip() or query.strip()
    if geocode_query and center is None:
        search_terms = f"{geocode_query} {search_terms}".strip()
    params: dict[str, str | int | float] = {
        "appid": app_id,
        "query": search_terms,
        "output": "json",
        "results": min(max(limit, 1), 100),
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
) -> tuple[list[PlaceSearchHit], bool]:
    location_query = _geocoder_query(query, intent)
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

        response = await client.get(
            YAHOO_LOCAL_SEARCH_URL,
            params=_local_search_params(
                query,
                intent,
                app_id,
                limit,
                center,
                location_query,
            ),
        )
        if response.is_error:
            raise YahooAPIError(f"Yahoo local search returned HTTP {response.status_code}.")
        return _parse_yahoo_places(response.json(), intent, limit)


def _normalize_name(value: str) -> str:
    return re.sub(r"[\s　]+", "", value).casefold()


def _is_duplicate(first: PlaceSearchHit, second: PlaceSearchHit) -> bool:
    first_name = _normalize_name(first.place.name)
    second_name = _normalize_name(second.place.name)
    distance = _distance_m(
        first.place.latitude,
        first.place.longitude,
        second.place.latitude,
        second.place.longitude,
    )
    if first_name == second_name:
        return distance <= 30
    return (
        min(len(first_name), len(second_name)) >= 4
        and (first_name in second_name or second_name in first_name)
        and distance <= 80
    )


def _merge_results(
    yahoo_results: list[PlaceSearchHit],
    osm_results: list[PlaceSearchHit],
    limit: int,
) -> list[PlaceSearchHit]:
    merged = list(yahoo_results)
    for osm_hit in osm_results:
        duplicate_index = next(
            (
                index
                for index, yahoo_hit in enumerate(merged)
                if _is_duplicate(yahoo_hit, osm_hit)
            ),
            None,
        )
        if duplicate_index is None:
            merged.append(osm_hit)
            continue

        yahoo_hit = merged[duplicate_index]
        yahoo_place = yahoo_hit.place
        osm_place = osm_hit.place
        merged[duplicate_index] = yahoo_hit.model_copy(
            update={
                "place": yahoo_place.model_copy(
                    update={
                        "category": yahoo_place.category or osm_place.category,
                        "address": yahoo_place.address or osm_place.address,
                        "description": yahoo_place.description or osm_place.description,
                    }
                )
            }
        )
    return merged[:limit]


async def search_places_with_fallback(
    query_text: str,
    limit: int = 20,
) -> PlaceSearchResponse:
    if limit < 1:
        raise ValueError("limit must be positive")
    intent = parse_place_query(query_text)
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    yahoo_results: list[PlaceSearchHit] = []
    yahoo_incomplete = True
    yahoo_error: str | None = None
    app_id = os.getenv("YAHOO_APP_ID", "").strip()
    if not app_id:
        yahoo_error = "YAHOO_APP_ID is not configured."
    else:
        try:
            yahoo_results, yahoo_incomplete = await _search_yahoo(
                query_text,
                intent,
                limit,
                app_id,
            )
        except (
            httpx.HTTPError,
            ValueError,
            YahooAPIError,
        ) as error:
            yahoo_error = (
                str(error) if isinstance(error, YahooAPIError) else type(error).__name__
            )

    if yahoo_results and not yahoo_incomplete:
        logger.info("POI search provider selected: Yahoo Local Search (%d results)", len(yahoo_results))
        return PlaceSearchResponse(
            query=intent,
            results=yahoo_results,
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )

    if yahoo_error:
        logger.warning("Yahoo Local Search failed; falling back to Overpass: %s", yahoo_error)
    osm_results: list[PlaceSearchHit] = []
    osm_error: str | None = None
    try:
        osm_response = await search_osm_places(query_text, limit=limit)
        osm_results = osm_response.results
    except HTTPException as error:
        osm_error = error.detail
        logger.warning("Overpass fallback search failed: %s", error.detail)

    results = _merge_results(yahoo_results, osm_results, limit)
    if yahoo_results and osm_results:
        provider = "Yahoo Local Search + Overpass"
        note = "Yahoo!ローカルサーチAPIを優先し、Overpass APIの情報で不足を補完しました。"
    elif yahoo_results:
        provider = "Yahoo Local Search"
        note = "Yahoo!ローカルサーチAPIの結果を表示しています。"
        if osm_error:
            note += " Overpass APIによる補完は利用できませんでした。"
    elif osm_results:
        provider = "Overpass"
        note = "Yahoo APIの結果を取得できなかったため、Overpass APIの結果を表示しています。"
    else:
        provider = "none"
        note = "Yahoo APIとOverpass APIで検索結果を取得できませんでした。"
    logger.info("POI search provider selected: %s (%d results)", provider, len(results))
    return PlaceSearchResponse(query=intent, results=results, note=note)
