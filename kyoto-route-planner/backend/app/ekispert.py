import json
import logging
import os
from pathlib import Path
import re
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

from app.http_client import provider_timeout, request_with_retry
from app.models import Origin, RouteLeg
from app.places import list_origins

API_BASE_URL = "https://api.ekispert.jp/v1/json"
logger = logging.getLogger(__name__)
GEO_STATION_URL = f"{API_BASE_URL}/geo/station"
NEARBY_SEARCH_RADIUS_M = 5_000
MAX_NEARBY_STATIONS = 10


async def find_nearest_train_station(latitude: float, longitude: float) -> tuple[str, float, float]:
    points = await _fetch_geo_station_points(
        latitude,
        longitude,
        radius_m=20_000,
        station_count=10,
        transport_type="train",
    )

    stations: list[tuple[float, str, float, float]] = []
    for point in points:
        station = point.get("Station")
        geo_point = point.get("GeoPoint")
        if not isinstance(station, dict) or not isinstance(geo_point, dict):
            continue
        if _text(station.get("Type")) != "train":
            continue
        name = station.get("Name")
        try:
            station_latitude = float(geo_point["lati_d"])
            station_longitude = float(geo_point["longi_d"])
            distance = float(point.get("Distance", float("inf")))
        except (KeyError, TypeError, ValueError):
            continue
        if isinstance(name, str) and name.strip():
            stations.append(
                (distance, name.strip(), station_latitude, station_longitude)
            )

    if not stations:
        raise HTTPException(
            status_code=404,
            detail="現在地から20km以内に列車駅が見つかりませんでした。",
        )
    _distance, name, station_latitude, station_longitude = min(stations)
    return (
        _normalize_station_name(name, "train"),
        station_latitude,
        station_longitude,
    )


async def find_nearby_stations(
    latitude: float,
    longitude: float,
) -> list[Origin]:
    points = await _fetch_geo_station_points(
        latitude,
        longitude,
        radius_m=NEARBY_SEARCH_RADIUS_M,
        station_count=MAX_NEARBY_STATIONS,
    )

    candidates: list[tuple[float, Origin]] = []
    for point in points:
        station = point.get("Station")
        geo_point = point.get("GeoPoint")
        if not isinstance(station, dict) or not isinstance(geo_point, dict):
            continue
        name = station.get("Name")
        station_type = station.get("Type")
        try:
            station_latitude = float(geo_point["lati_d"])
            station_longitude = float(geo_point["longi_d"])
            distance = float(point["Distance"])
        except (KeyError, TypeError, ValueError):
            continue
        if not isinstance(name, str) or not name.strip():
            continue

        normalized_name = _normalize_station_name(name.strip(), station_type)
        candidates.append((
            distance,
            Origin(
                name=normalized_name,
                latitude=station_latitude,
                longitude=station_longitude,
            ),
        ))

    if not candidates:
        raise HTTPException(
            status_code=404,
            detail="現在地から5km以内に駅・停留所が見つかりませんでした。",
        )
    candidates.sort(key=lambda candidate: candidate[0])
    unique_candidates: list[Origin] = []
    seen_names: set[str] = set()
    for _, origin in candidates:
        if origin.name in seen_names:
            continue
        seen_names.add(origin.name)
        unique_candidates.append(origin)
        if len(unique_candidates) == MAX_NEARBY_STATIONS:
            break
    return unique_candidates


async def _fetch_geo_station_points(
    latitude: float,
    longitude: float,
    *,
    radius_m: int,
    station_count: int,
    transport_type: str | None = None,
) -> list[dict[str, object]]:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.getenv("EKISPERT_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="駅すぱあとAPIキーが設定されていません。環境変数 EKISPERT_API_KEY を設定してください。",
        )

    params = {
        "key": key,
        "geoPoint": f"{latitude},{longitude},wgs84,{radius_m}",
        "stationCount": str(station_count),
        "gcs": "wgs84",
    }
    if transport_type:
        params["type"] = transport_type
    referer = os.getenv(
        "EKISPERT_APPLICATION_URL",
        "http://127.0.0.1:8000",
    ).strip()
    try:
        async with httpx.AsyncClient(
            timeout=provider_timeout(10.0),
            headers={"Referer": referer} if referer else {},
        ) as client:
            response = await request_with_retry(
                client,
                "GET",
                GEO_STATION_URL,
                params=params,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail="駅・停留所の検索がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIに接続できず、駅・停留所を検索できませんでした。",
        ) from error

    if response.status_code == 403:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIの認証に失敗しました。APIキーと登録ドメインを確認してください。",
        )
    if response.is_error:
        raise HTTPException(
            status_code=502,
            detail=f"駅すぱあとAPIで駅・停留所を検索できませんでした（HTTP {response.status_code}）。",
        )
    try:
        payload = response.json()
    except ValueError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIから不正な形式の駅・停留所データが返されました。",
        ) from error

    provider_error = _provider_error(payload)
    if provider_error:
        raise HTTPException(status_code=502, detail=provider_error)
    result_set = payload.get("ResultSet") if isinstance(payload, dict) else None
    points = result_set.get("Point") if isinstance(result_set, dict) else None
    if isinstance(points, dict):
        points = [points]
    if not isinstance(points, list):
        points = []
    return [point for point in points if isinstance(point, dict)]


_PREFECTURE_SUFFIX = re.compile(r"[都道府県]$")
_PARENTHESES = re.compile(r"[(（]([^)）]*)[)）]")


def _normalize_station_name(name: str, station_type: object = "train") -> str:
    # 「(東京メトロ)」等の事業者・路線注記は除き、同名駅を区別する「(東京都)」は残す。
    cleaned = _PARENTHESES.sub(
        lambda match: match.group(0) if _PREFECTURE_SUFFIX.search(match.group(1)) else "",
        name,
    ).strip()
    cleaned = cleaned or name.strip()
    if cleaned.endswith(("駅", ")", "）")):
        return cleaned
    return f"{cleaned}駅" if _text(station_type) == "train" else cleaned


def _station_via_points(via_points: list[str]) -> list[str]:
    # 駅の座標はEkispertで経路が見つからない場合があるため、登録済みの出発駅は駅名で検索する。
    names = {
        f"{origin.latitude},{origin.longitude}": origin.name.removesuffix("駅")
        for origin in list_origins()
    }
    return [names.get(point, point) for point in via_points]
_QUERY_KEY_PATTERN = re.compile(r"([?&]key=)[^&\s]+", re.IGNORECASE)


def _redact_access_key(url: str) -> str:
    return _QUERY_KEY_PATTERN.sub(r"\1[REDACTED]", url)


def _as_list(value: object) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _text(value: object) -> str:
    if isinstance(value, str | int | float):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "name", "value"):
            nested = value.get(key)
            if isinstance(nested, str | int | float):
                return str(nested)
    return ""


def _integer(value: object) -> int | None:
    try:
        return int(_text(value))
    except (TypeError, ValueError):
        return None


def _course_list(payload: object) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    result_set = payload.get("ResultSet", payload)
    if not isinstance(result_set, dict):
        return []
    courses = result_set.get("Course")
    if isinstance(courses, list):
        return [item for item in courses if isinstance(item, dict)]
    if isinstance(courses, dict):
        return [courses]
    return []


def _parse_legs(course: dict) -> tuple[list[RouteLeg], int | None]:
    route = course.get("Route")
    if not isinstance(route, dict):
        return [], None

    points = _as_list(route.get("Point"))
    lines = _as_list(route.get("Line"))
    legs: list[RouteLeg] = []
    for index, line in enumerate(lines):
        if index + 1 >= len(points):
            break
        start = points[index].get("Station", points[index])
        end = points[index + 1].get("Station", points[index + 1])
        if not isinstance(start, dict) or not isinstance(end, dict):
            continue
        legs.append(
            RouteLeg(
                from_name=_text(start.get("Name")) or "出発地",
                to_name=_text(end.get("Name")) or "到着地",
                line_name=_text(line.get("Name")) or "移動",
                mode=_text(line.get("Type")) or "other",
                duration_minutes=_integer(line.get("timeOnBoard")),
            )
        )

    total_minutes = _integer(route.get("timeOnBoard"))
    if total_minutes is not None:
        total_minutes += _integer(route.get("timeOther")) or 0
    if total_minutes == 0:
        leg_minutes = [
            leg.duration_minutes
            for leg in legs
            if leg.duration_minutes is not None and leg.duration_minutes > 0
        ]
        if leg_minutes:
            total_minutes = sum(leg_minutes)
    return legs, total_minutes


def _provider_error(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    result_set = payload.get("ResultSet", payload)
    if not isinstance(result_set, dict):
        return None
    error = result_set.get("Error")
    if not isinstance(error, dict):
        return None
    return _text(error.get("Message")) or "駅すぱあとAPIが経路を返しませんでした。"


def _make_url(params: dict[str, str]) -> str:
    # Ekispert requires colon-delimited viaList values; leave those separators unescaped.
    return f"{API_BASE_URL}/search/course/extreme?{urlencode(params, safe=':')}"


def _parse_fare_yen(course: dict) -> int | None:
    prices = _as_list(course.get("Price"))
    fare_summary = next(
        (price for price in prices if price.get("kind") == "FareSummary"),
        None,
    )
    if fare_summary is None:
        return None
    fare_yen = _integer(fare_summary.get("Oneway"))
    if fare_yen is None or fare_yen < 0:
        return None

    charge_summary = next(
        (price for price in prices if price.get("kind") == "ChargeSummary"),
        None,
    )
    if charge_summary is not None:
        charge_yen = _integer(charge_summary.get("Oneway"))
        if charge_yen is None or charge_yen < 0:
            return None
        fare_yen += charge_yen
    return fare_yen


async def search_route(
    via_points: list[str],
    departure_date: str,
    departure_time: str,
) -> tuple[list[RouteLeg], int | None, str | None, str | None]:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.getenv("EKISPERT_API_KEY")
    if not key:
        raise HTTPException(
            status_code=503,
            detail="駅すぱあとAPIキーが設定されていません。環境変数 EKISPERT_API_KEY を設定してください。",
        )

    referer = os.getenv("EKISPERT_APPLICATION_URL", "http://127.0.0.1:8000").strip()
    params = {
        "key": key,
        "viaList": ":".join(_station_via_points(via_points)),
        "date": departure_date.replace("-", ""),
        "time": departure_time.replace(":", ""),
        "searchType": "departure",
        "answerCount": "1",
        "gcs": "wgs84",
    }
    logger.debug("Requesting Ekispert route: %s", _redact_access_key(_make_url(params)))

    try:
        async with httpx.AsyncClient(timeout=provider_timeout(15.0)) as client:
            response = await request_with_retry(
                client,
                "GET",
                _make_url(params),
                headers={"Referer": referer} if referer else {},
            )
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail="駅すぱあとAPIへの接続がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIに接続できませんでした。",
        ) from error

    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIからJSON形式でない応答が返されました。",
        ) from error

    provider_error = _provider_error(payload)
    if response.status_code >= 400 or provider_error:
        if response.status_code == 403:
            detail = "駅すぱあとAPIの認証に失敗しました。APIキーと登録ドメインを確認してください。"
        else:
            detail = provider_error or f"駅すぱあとAPIで経路を検索できませんでした（HTTP {response.status_code}）。"
        raise HTTPException(status_code=502, detail=detail)

    courses = _course_list(payload)
    if not courses:
        raise HTTPException(
            status_code=404,
            detail="指定した出発駅と候補地を結ぶ経路が見つかりませんでした。",
        )

    course = courses[0]
    legs, total_minutes = _parse_legs(course)
    return (
        legs,
        total_minutes,
        _text(course.get("departureState")),
        _text(course.get("arrivalState")),
    )


async def estimate_route_fare(via_points: list[str]) -> int | None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    key = os.getenv("EKISPERT_API_KEY")
    if not key:
        raise HTTPException(
            status_code=503,
            detail="駅すぱあとAPIキーが設定されていません。環境変数 EKISPERT_API_KEY を設定してください。",
        )

    referer = os.getenv("EKISPERT_APPLICATION_URL", "http://127.0.0.1:8000").strip()
    params = {
        "key": key,
        "viaList": ":".join(_station_via_points(via_points)),
        "searchType": "plain",
        "answerCount": "1",
        "gcs": "wgs84",
    }
    url = _make_url(params)
    logger.debug("Requesting Ekispert fare estimate: %s", _redact_access_key(url))

    try:
        async with httpx.AsyncClient(timeout=provider_timeout(15.0)) as client:
            response = await request_with_retry(
                client,
                "GET",
                url,
                headers={"Referer": referer} if referer else {},
            )
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail="駅すぱあとAPIの運賃概算取得がタイムアウトしました。",
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIから運賃概算を取得できませんでした。",
        ) from error

    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail="駅すぱあとAPIからJSON形式でない運賃応答が返されました。",
        ) from error

    provider_error = _provider_error(payload)
    if response.status_code >= 400 or provider_error:
        if response.status_code == 403:
            detail = "駅すぱあとAPIの運賃検索認証に失敗しました。"
        else:
            detail = provider_error or (
                f"駅すぱあとAPIで運賃を検索できませんでした（HTTP {response.status_code}）。"
            )
        raise HTTPException(status_code=502, detail=detail)

    courses = _course_list(payload)
    if not courses:
        raise HTTPException(
            status_code=404,
            detail="指定した経由地の運賃情報が見つかりませんでした。",
        )
    return _parse_fare_yen(courses[0])
