"""Yahoo! JAPAN ローカルサーチAPIのスポット取得処理。"""

from __future__ import annotations

import asyncio
import os
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from dotenv import load_dotenv

from app.models import Place
from app.search import parse_place_query
from app.models import CatalogPlace, PlaceSearchHit, PlaceSearchResponse

YAHOO_LOCAL_SEARCH_URL = (
    "https://map.yahooapis.jp/search/local/V1/localSearch"
)
DEFAULT_CATEGORY_CODE = "0101"
DEFAULT_QUERY = "京都 観光"
DEFAULT_RESULT_LIMIT = 30
CACHE_TTL = timedelta(minutes=15)
YAHOO_NAMESPACE = {"ydf": "http://olp.yahooapis.jp/ydf/1.0"}


@dataclass(frozen=True)
class _CacheEntry:
    expires_at: datetime
    places: list[Place]


_cache: dict[tuple[Any, ...], _CacheEntry] = {}
_cache_lock = asyncio.Lock()
_last_status: dict[str, Any] = {
    "source": "Yahoo! Local Search",
    "state": "idle",
    "warning": None,
    "using_fallback": False,
    "requests_paused": False,
}
load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _text(element: ET.Element | None, path: str) -> str:
    if element is None:
        return ""
    child = element.find(path, YAHOO_NAMESPACE)
    return (child.text or "").strip() if child is not None else ""


def _themes(category: str, name: str, description: str) -> list[str]:
    text = f"{category} {name} {description}".casefold()
    themes: set[str] = set()
    if any(term in text for term in ("神社", "寺", "寺院", "shrine", "temple")):
        themes.add("temple")
    if any(term in text for term in ("歴史", "文化", "城", "museum", "historic")):
        themes.add("history")
    if any(term in text for term in ("自然", "公園", "庭園", "景", "park", "garden")):
        themes.add("nature")
    if any(term in text for term in ("食", "料理", "飲食", "restaurant", "cafe")):
        themes.add("food")
    return sorted(themes or {"history"})


def _parse_coordinates(value: str) -> tuple[float, float] | None:
    try:
        longitude, latitude = (float(item.strip()) for item in value.split(",", 1))
    except (ValueError, TypeError):
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return latitude, longitude


def _parse_response(content: bytes) -> list[Place]:
    root = ET.fromstring(content)
    places: list[Place] = []
    seen: set[str] = set()
    for feature in root.findall("ydf:Feature", YAHOO_NAMESPACE):
        place_id = _text(feature, "ydf:Id")
        name = _text(feature, "ydf:Name")
        coordinates = _parse_coordinates(_text(feature, "ydf:Geometry/ydf:Coordinates"))
        if not place_id or not name or coordinates is None or place_id in seen:
            continue
        seen.add(place_id)
        category = _text(feature, "ydf:Category") or "観光・レジャー"
        address = _text(feature, "ydf:Address")
        description = (
            _text(feature, "ydf:Description")
            or _text(feature, "ydf:Property/ydf:Comment")
        )
        phone = _text(feature, "ydf:Property/ydf:Tel1")
        tags: dict[str, str] = {"source": "Yahoo! JAPAN ローカルサーチAPI"}
        if phone:
            tags["phone"] = phone
        latitude, longitude = coordinates
        places.append(
            Place(
                id=f"yahoo-{place_id}",
                name=name,
                category=category,
                description=description or "Yahoo! JAPAN ローカルサーチAPIで取得したスポット",
                access_point="座標から経路検索",
                latitude=latitude,
                longitude=longitude,
                themes=_themes(category, name, description),
                address=address,
                tags=tags,
            )
        )
    return places


def _sample_places() -> list[Place]:
    """AppID未設定時にも画面を動かすための非外部・少数サンプル。"""
    return [
        Place(
            id="sample-kiyomizu-dera",
            name="清水寺",
            category="寺院",
            description="京都を代表する歴史・文化スポット（サンプル）",
            access_point="座標から経路検索",
            latitude=34.9949,
            longitude=135.7850,
            themes=["history", "temple"],
            address="京都府京都市東山区清水1-294",
            tags={"source": "local sample catalog"},
        ),
        Place(
            id="sample-maruyama-park",
            name="円山公園",
            category="公園",
            description="京都市東山区の自然・景観スポット（サンプル）",
            access_point="座標から経路検索",
            latitude=35.0037,
            longitude=135.7820,
            themes=["nature"],
            address="京都府京都市東山区円山町",
            tags={"source": "local sample catalog"},
        ),
    ]


async def search_yahoo_places(
    keyword: str = DEFAULT_QUERY,
    *,
    category_code: str | None = None,
    limit: int = DEFAULT_RESULT_LIMIT,
    latitude: float | None = None,
    longitude: float | None = None,
    distance_m: int | None = None,
) -> list[Place]:
    """Yahoo!ローカルサーチAPIを呼び出し、失敗時はサンプルへ戻す。

    AppIDの取得手順:
    1. https://e.developer.yahoo.co.jp/ にYahoo! JAPAN IDでログインする。
    2. アプリケーションを登録し、表示されたClient ID（AppID）を控える。
    3. `backend/.env` に `YAHOO_CLIENT_ID=取得したAppID` を設定する。
       `.env`はGit管理対象外であり、AppIDをソースコードへ直接書かない。
    """
    normalized_keyword = keyword.strip() or DEFAULT_QUERY
    category = category_code or os.getenv(
        "YAHOO_LOCAL_CATEGORY", DEFAULT_CATEGORY_CODE
    )
    result_limit = max(1, min(limit, 100))
    cache_key = (
        normalized_keyword,
        category,
        result_limit,
        round(latitude, 5) if latitude is not None else None,
        round(longitude, 5) if longitude is not None else None,
        distance_m,
    )
    async with _cache_lock:
        entry = _cache.get(cache_key)
        if entry and entry.expires_at > _now():
            return list(entry.places)

    app_id = os.getenv("YAHOO_CLIENT_ID", "").strip()
    if not app_id:
        _set_status("fallback", "Yahoo! Client ID未設定のためローカルサンプルを使用しています。", True)
        return _sample_places()

    params: dict[str, Any] = {
        "appid": app_id,
        "query": normalized_keyword,
        "gc": category,
        "results": result_limit,
    }
    if latitude is not None and longitude is not None:
        params.update({"lat": latitude, "lon": longitude, "dist": distance_m or 5000})
    _set_status("loading", None, False)
    endpoint = os.getenv("YAHOO_LOCAL_SEARCH_URL", YAHOO_LOCAL_SEARCH_URL)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(endpoint, params=params)
            response.raise_for_status()
            places = _parse_response(response.content)
    except (
        httpx.HTTPError,
        ET.ParseError,
        UnicodeDecodeError,
        ValueError,
    ):
        _set_status("fallback", "Yahoo! Local Searchに接続できないためローカルサンプルを使用しています。", True)
        return _sample_places()

    if not places:
        _set_status("fallback", "Yahoo! Local Searchの検索結果がないためローカルサンプルを使用しています。", True)
        return _sample_places()
    _set_status("success", None, False)
    async with _cache_lock:
        _cache[cache_key] = _CacheEntry(_now() + CACHE_TTL, list(places))
    return places


def clear_cache() -> None:
    """テストや設定変更時にプロセス内キャッシュを消去する。"""
    _cache.clear()


def _set_status(state: str, warning: str | None, using_fallback: bool) -> None:
    _last_status.update(
        state=state,
        warning=warning,
        using_fallback=using_fallback,
        requests_paused=False,
    )


def get_yahoo_status() -> dict[str, Any]:
    return dict(_last_status)


async def search_yahoo_place_catalog(
    keyword: str,
    *,
    latitude: float | None = None,
    longitude: float | None = None,
    distance_m: int | None = None,
    limit: int = DEFAULT_RESULT_LIMIT,
) -> PlaceSearchResponse:
    places = await search_yahoo_places(
        keyword,
        latitude=latitude,
        longitude=longitude,
        distance_m=distance_m,
        limit=limit,
    )
    results = [
        PlaceSearchHit(
            place=CatalogPlace(
                id=place.id,
                name=place.name,
                category=place.category,
                region=place.address[:3] if place.address else "",
                address=place.address,
                latitude=place.latitude,
                longitude=place.longitude,
                description=place.description,
            ),
            score=1.0,
        )
        for place in places
    ]
    return PlaceSearchResponse(
        query=parse_place_query(keyword),
        results=results,
        note="Yahoo! Local Search",
    )
