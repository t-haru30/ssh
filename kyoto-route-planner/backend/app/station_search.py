"""Explicit lookup: https://docs.ekispert.com/v1/api/station/light.html
and https://docs.ekispert.com/v1/api/station.html.

At most five candidates are enriched, using their codes (never their names).
Coordinates are requested in WGS84. At most six GETs; no retries. Line names
are unavailable from these endpoints, so lines stays empty rather than adding
five more provider calls. No provider responses or keys are logged.
"""
import os
import ssl
import unicodedata

import httpx
from fastapi import HTTPException
from pydantic import Field, ValidationError

from app.ekispert import API_BASE_URL, _as_list, _normalize_station_name, _text
from app.http_client import provider_timeout
from app.models import Origin

MAX_CANDIDATES = 5


class StationCandidate(Origin):
    code: str = Field(min_length=1, max_length=30)
    prefecture: str = Field(default="", max_length=30)
    lines: list[str] = Field(default_factory=list, max_length=30)


async def _get(client: httpx.AsyncClient, path: str, key: str, **params) -> dict:
    try:
        response = await client.get(f"{API_BASE_URL}/{path}", params={"key": key, **params})
        if response.status_code == 403:
            raise HTTPException(502, "駅検索の認証に失敗しました。APIキーと登録ドメインを確認してください。")
        if response.is_error:
            raise HTTPException(502, "駅すぱあとAPIで駅を検索できませんでした。時間をおいて再度お試しください。")
        payload = response.json()
        result = payload.get("ResultSet") if isinstance(payload, dict) else None
        if not isinstance(result, dict) or "Error" in result:
            raise ValueError("invalid provider result")
        return result
    except httpx.TimeoutException as error:
        raise HTTPException(504, "駅検索がタイムアウトしました。再度お試しください。") from error
    except (httpx.RequestError, ValueError) as error:
        raise HTTPException(502, "駅検索のデータを取得できませんでした。再度お試しください。") from error


async def search_stations(query: str, prefecture_code: str | None = None) -> list[StationCandidate]:
    query = unicodedata.normalize("NFKC", query).strip()
    if not query or len(query) > 80:
        raise HTTPException(422, "駅名は1〜80文字で入力してください。")
    if query.endswith("駅"):
        query = query[:-1].strip()
    if not query:
        raise HTTPException(422, "検索する駅名を入力してください。")
    key = os.getenv("EKISPERT_API_KEY", "").strip()
    if not key:
        raise HTTPException(503, "駅検索には駅すぱあとAPIキーの設定が必要です。")
    referer = os.getenv("EKISPERT_APPLICATION_URL", "http://127.0.0.1:8000").strip()
    async with httpx.AsyncClient(timeout=provider_timeout(8), follow_redirects=False, trust_env=False, verify=ssl.create_default_context(),
                                 headers={"Referer": referer} if referer else {}) as client:
        light = await _get(client, "station/light", key, name=query, nameMatchType="partial", type="train",
                           **({"prefectureCode": str(int(prefecture_code))} if prefecture_code else {}))
        candidates = []
        seen = set()
        points = _as_list(light.get("Point"))
        for point in points[:30]:
            if prefecture_code and str(point.get("Prefecture", {}).get("code", "")).zfill(2) != prefecture_code:
                continue
            station = point.get("Station", {})
            if not isinstance(station, dict) or _text(station.get("Type")) != "train":
                continue
            code = str(station.get("code", ""))
            if not code.isdigit() or code in seen:
                continue
            seen.add(code)
            detail = await _get(client, "station", key, code=code, gcs="wgs84")
            matching = [p for p in _as_list(detail.get("Point"))
                        if isinstance(p.get("Station"), dict) and str(p["Station"].get("code")) == code]
            if len(matching) != 1:
                raise HTTPException(502, "駅の位置を確認できませんでした。駅名を詳しくして再検索してください。")
            full = matching[0]
            try:
                geo = full["GeoPoint"]
                if not isinstance(geo, dict) or geo.get("gcs") != "wgs84":
                    raise ValueError("unexpected coordinate system")
                candidates.append(StationCandidate(
                    name=_normalize_station_name(full["Station"]["Name"], "train"), code=code,
                    latitude=float(geo["lati_d"]), longitude=float(geo["longi_d"]),
                    prefecture=full.get("Prefecture", {}).get("Name", ""), lines=[]))
            except (KeyError, TypeError, ValueError, ValidationError) as error:
                raise HTTPException(502, "駅の位置データが不正なため選択できませんでした。") from error
            if len(candidates) >= MAX_CANDIDATES:
                break
        return candidates
