import json
import os
from pathlib import Path
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException

from app.models import RouteLeg

API_BASE_URL = "https://api.ekispert.jp/v1/json"


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
        "viaList": ":".join(via_points),
        "date": departure_date.replace("-", ""),
        "time": departure_time.replace(":", ""),
        "searchType": "departure",
        "answerCount": "1",
        "gcs": "wgs84",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
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
