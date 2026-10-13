"""Discover facilities with bounded AI selection and deterministic route constraints.

Transport is searched only after adoption. The finite catalog is not exhaustive.
"""
import asyncio
import os
import re
import unicodedata
from typing import Literal
from fastapi import HTTPException
from hashlib import sha256
from math import asin, cos, radians, sin, sqrt, ceil

from pydantic import BaseModel, Field

from app.models import CatalogPlace, Origin, Theme
from app.places import is_unsuitable_place
from app.public_catalog import load_public_places


PACE_SETTINGS = {"relaxed": (2, 75, 120), "standard": (3, 60, 105), "packed": (4, 45, 75)}
PACE_LABELS = {"relaxed": "ゆったり", "standard": "標準", "packed": "たくさん巡る"}


class Traveler(BaseModel):
    pace: Literal["relaxed", "standard", "packed"] = "standard"
    age_group: Literal["unspecified", "under_18", "18_29", "30_49", "50_64", "65_plus"] = "unspecified"
    gender: Literal["unspecified", "female", "male", "other"] = "unspecified"
    companion: Literal["unspecified", "family", "friends", "couple", "solo"] = "unspecified"


class DiscoverRequest(BaseModel):
    area: str = Field(pattern=r"^[a-z]{1,30}$")
    prefecture_name: str = Field(min_length=1, max_length=10)
    origin: Origin
    theme: Theme = "all"
    course: str = Field(default="all", pattern=r"^(all|half_day|full_day)$")
    radius_km: int = Field(default=30, ge=1, le=20000)
    cross_prefecture: bool = True
    variation: int = Field(default=0, ge=0, le=10000)
    count: int = Field(default=12, ge=1, le=20)
    traveler: Traveler | None = None
    preference_text: str = Field(default="", max_length=600)


def traveler_pace(request: DiscoverRequest) -> str:
    return request.traveler.pace if request.traveler else "standard"


def stay_minutes(request: DiscoverRequest) -> int:
    settings = PACE_SETTINGS[traveler_pace(request)]
    return settings[2] if request.course == "full_day" else settings[1]


def max_stops(request: DiscoverRequest) -> int:
    return PACE_SETTINGS[traveler_pace(request)][0]


def recommendation_reason(request: DiscoverRequest, ordered: list[CatalogPlace]) -> str:
    categories = "・".join(dict.fromkeys(p.category for p in ordered))
    reason = f"{PACE_LABELS[traveler_pace(request)]}ペースで{len(ordered)}か所、各{stay_minutes(request)}分滞在（目安）。{categories}を巡ります。"
    if request.traveler and any(traveler_priority(request, p) for p in ordered):
        label = {"family": "家族", "friends": "友人", "couple": "カップル", "solo": "ひとり旅"}[request.traveler.companion]
        matched = "・".join(dict.fromkeys(p.category for p in ordered if traveler_priority(request, p)))
        reason += f"{label}で巡る候補として、{matched}を選びました。"
    return reason


def traveler_priority(request: DiscoverRequest, place: CatalogPlace) -> int:
    """Soft category preferences only; never infer accessibility or gender tastes."""
    companion = request.traveler.companion if request.traveler else "unspecified"
    words = {
        "family": ("公園", "動物", "水族", "科学", "博物館", "植物"),
        "friends": ("市場", "商店街", "飲食", "グルメ", "公園", "博物館"),
        "couple": ("庭園", "展望", "美術館", "カフェ", "植物"),
        "solo": ("博物館", "美術館", "寺", "神社", "記念"),
    }.get(companion, ())
    return int(any(word in place.name + " " + place.category for word in words))


def distance_km(a, b) -> float:
    dlat, dlon = radians(b.latitude - a.latitude), radians(b.longitude - a.longitude)
    h = sin(dlat / 2) ** 2 + cos(radians(a.latitude)) * cos(radians(b.latitude)) * sin(dlon / 2) ** 2
    return 6371 * 2 * asin(sqrt(min(1, h)))


def place_themes(place: CatalogPlace) -> list[Theme]:
    text = place.name + " " + place.category
    themes: set[Theme] = set()
    if any(word in text for word in ("寺", "神社", "神宮", "大社", "観音", "教会")):
        themes.update(("temple", "history"))
    if any(word in text for word in ("歴史", "史跡", "城", "博物館", "美術館", "文化", "記念", "遺跡")):
        themes.add("history")
    if any(word in text for word in ("自然", "公園", "庭園", "山", "海", "湖", "滝", "展望", "植物", "動物", "水族")):
        themes.add("nature")
    if any(word in text for word in ("グルメ", "飲食", "レストラン", "カフェ", "食堂", "料理", "喫茶", "市場", "商店街")):
        themes.add("food")
    for prefix, inferred in (("0424001", ("temple", "history")), ("0424002", ("temple", "history")), ("0305002", ("history",)), ("0305003", ("history",)), ("0305007", ("nature",)), ("030300", ("nature",)), ("01", ("food",))):
        if place.genre_code.startswith(prefix):
            themes.update(inferred)
    return sorted(themes)


def venue_name(name: str) -> str:
    name = unicodedata.normalize("NFKC", name).strip()
    name = re.sub(r"^[東西南北]+から見た(.+)の眺め$", r"\1", name)
    return re.sub(r"\s+", "", name).lower()


def distinct_venues(places: list[CatalogPlace]) -> list[CatalogPlace]:
    """Conservative identity for automatic composition, never saved itineraries."""
    result: list[CatalogPlace] = []
    for place in places:
        if not any(venue_name(place.name) == venue_name(other.name)
                   and distance_km(place, other) <= 0.3 for other in result):
            result.append(place)
    return result


def eligible_candidates(request: DiscoverRequest, places: tuple[CatalogPlace, ...]) -> list[CatalogPlace]:
    """Apply all hard constraints before exposing any facility to the agent."""
    candidates = sorted((place for place in places
        if (request.cross_prefecture or place.region == request.prefecture_name)
        and (request.theme == "all" or request.theme in place_themes(place))
        and not any(word in place.category for word in ("ホテル", "旅館", "宿泊"))
        and not is_unsuitable_place(place)
        and distance_km(request.origin, place) <= request.radius_km),
        key=lambda place: (distance_km(request.origin, place), place.id))
    candidates = distinct_venues(candidates)
    return candidates


def assemble_route(request: DiscoverRequest, ordered: list[CatalogPlace],
                   reasons: dict[str, str] | None = None, *, source: str = "rules") -> dict | None:
    """Compute a round trip independently; reject AI selections over the time cap."""
    if not ordered or len(ordered) > max_stops(request):
        return None
    stay = stay_minutes(request)
    points = [request.origin, *ordered, request.origin]
    legs = [{"from": a.name, "to": b.name, "distance_km": round(distance_km(a, b), 2),
             "mode": "public_transport", "minutes": ceil(distance_km(a, b) / 25 * 60) + 10}
            for a, b in zip(points, points[1:])]
    minutes = sum(leg["minutes"] for leg in legs) + stay * len(ordered)
    if minutes > (300 if request.course == "half_day" else 600):
        return None
    course = "full_day" if request.course == "full_day" or minutes > 300 else "half_day"
    reasons = reasons or {p.id: f"{p.category}の候補で、出発地から直線約{distance_km(request.origin, p):.1f}kmです。" for p in ordered}
    return {"id": "dynamic-" + sha256((request.area + str(stay) + "|".join(p.id for p in ordered)).encode()).hexdigest()[:16],
            "area": request.area, "pattern": course, "course": course, "theme": request.theme,
            "title": ordered[0].name + "から、" + {"all": "街歩き", "history": "歴史と文化", "temple": "寺社めぐり", "nature": "自然と景色", "food": "食のひととき"}[request.theme] + "を楽しむ旅",
            "estimated_minutes": minutes, "legs": legs,
            "start": {"name": request.origin.name, "lat": request.origin.latitude, "lng": request.origin.longitude,
                      "to_first_km": legs[0]["distance_km"], "from_last_km": legs[-1]["distance_km"]},
            "total_score": len(ordered), "center": [request.origin.latitude, request.origin.longitude],
            "recommendation_source": source,
            "recommendation_reason": recommendation_reason(request, ordered),
            "spots": [{"place_id": p.id, "name": p.name, "category": p.category, "lat": p.latitude, "lng": p.longitude,
                       "address": p.address, "tags": p.tags,
                       "stay_minutes": stay, "score": 1, "role": "stop", "reason": reasons[p.id]} for p in ordered],
            "coordinates": [[p.latitude, p.longitude] for p in points]}


def build_discover_routes(request: DiscoverRequest, places: tuple[CatalogPlace, ...] | None = None) -> dict:
    try:
        pool = places if places is not None else load_public_places()
    except (OSError, ValueError, KeyError):
        return {"routes": [], "note": "施設候補データを読み込めませんでした。", "source": "OpenStreetMap"}
    candidates = eligible_candidates(request, pool)
    # Search the nearest neighbourhood first, then widen only within the user's cap.
    radii = sorted({min(5, request.radius_km), min(20, request.radius_km), request.radius_km})
    effective_radius = radii[-1]
    for radius in radii:
        nearby = [place for place in candidates if distance_km(request.origin, place) <= radius]
        if len(nearby) >= 6:
            candidates, effective_radius = nearby, radius
            break
    candidates.sort(key=lambda p: (-traveler_priority(request, p), distance_km(request.origin, p), p.id))
    routes, seen = [], set()
    for index in range(min(len(candidates), 80)):
        seed = candidates[(index + request.variation) % len(candidates)]
        ordered, remaining, cursor = [seed], [p for p in candidates if p.id != seed.id], seed
        while remaining and len(ordered) < max_stops(request):
            nearest = min(remaining, key=lambda p: (distance_km(cursor, p) - 0.5 * traveler_priority(request, p), p.id))
            ordered.append(nearest)
            remaining.remove(nearest)
            cursor = nearest
        while ordered and assemble_route(request, ordered) is None:
            ordered.pop()
        signature = tuple(sorted(p.id for p in ordered))
        if not ordered or signature in seen:
            continue
        seen.add(signature)
        routes.append(assemble_route(request, ordered))
        if len(routes) >= request.count:
            break
    note = f"OpenStreetMapの施設候補から条件に合わせて作成しました。検索半径 {effective_radius}km（上限 {request.radius_km}km）。"
    if effective_radius > radii[0]:
        note += "候補が少ないため検索範囲を広げました。"
    if len(candidates) < 3:
        note += "候補が少ないため、見つかったスポット数で提案しています。"
    note += f"{PACE_LABELS[traveler_pace(request)]}ペースで最大{max_stops(request)}か所、各{stay_minutes(request)}分の滞在です。"
    return {"routes": routes, "note": note + "移動時間は推定です。", "source": "OpenStreetMap"}


async def _base_discover_catalog(request: DiscoverRequest) -> tuple[dict, tuple[CatalogPlace, ...]]:
    """Use one live facility search when configured, with a bounded local fallback."""
    if os.getenv("PLACE_SEARCH_PROVIDER") == "public_catalog" or not os.getenv("YAHOO_APP_ID", "").strip():
        try:
            pool = load_public_places()
        except (OSError, ValueError, KeyError):
            pool = ()
        result = build_discover_routes(request, pool)
        result["note"] += "同梱の施設候補のみが対象で、地域の全施設を網羅していません。"
        return result, pool
    from app.poi_search import search_yahoo_catalog
    genres = {
        "all": ("0424001", "0424002", "0305002", "0305003", "0305007", "0303002", "0303003", "0303004", "01"),
        "history": ("0424001", "0424002", "0305002", "0305003"),
        "temple": ("0424001", "0424002"),
        "nature": ("0305007", "0303002", "0303003", "0303004"),
        "food": ("01",),
    }
    try:
        search = await asyncio.wait_for(search_yahoo_catalog("グルメ" if request.theme == "food" else "観光",
            limit=100, genre_codes=genres[request.theme],
            center=(request.origin.latitude, request.origin.longitude), radius_m=min(20, request.radius_km) * 1000), timeout=12)
    except (asyncio.TimeoutError, HTTPException):
        try:
            pool = load_public_places()
        except (OSError, ValueError, KeyError):
            pool = ()
        result = build_discover_routes(request, pool)
        result["note"] += "施設検索を取得できなかったため、同梱の有限の候補から提案しています。"
        return result, pool
    live = {hit.place.id: hit.place for hit in search.results}
    pool = dict(live)
    if len(live) < 6 or request.radius_km > 20:
        try:
            pool.update({p.id: p for p in load_public_places() if p.id not in pool})
        except (OSError, ValueError, KeyError):
            pass
    result = build_discover_routes(request, tuple(pool.values()))
    if live:
        result["source"] = "Yahoo!ローカルサーチ / OpenStreetMap" if len(pool) > len(live) else "Yahoo!ローカルサーチ"
        result["note"] = result["note"].replace("OpenStreetMapの施設候補", result["source"] + "の施設候補")
        result["note"] += "ライブ施設検索は最大20kmです。候補不足時や範囲外は同梱候補で補います。"
    else:
        result["note"] += "ライブ候補がないため、同梱の有限の候補から提案しています。"
    return result, tuple(pool.values())


async def _discover_catalog(request: DiscoverRequest) -> tuple[dict, tuple[CatalogPlace, ...]]:
    from app.openpoi import enrich_candidates
    fallback, base = await _base_discover_catalog(request)
    pool, status = await enrich_candidates(request, base)
    added = sum(p.id.startswith("openpoi-") for p in pool)
    if added:
        fallback = build_discover_routes(request, pool)
        fallback["source"] = "OpenStreetMap / OpenPOI API"
        fallback["note"] = ("OSMの登録施設と、分類・検索範囲・住所と座標の町域整合性を確認したOpenPOI候補を使用しています。"
                            "重複は既存施設を優先。入口の正確な位置・営業状況は未確認で、移動時間は推定です。")
    elif status != "disabled":
        fallback["note"] += "OpenPOIで追加可能な施設を確認できなかったため、既存の候補を使用しています。"
    fallback["catalog"] = {"openpoi_status": status, "openpoi_added": added, "base_count": len(base)}
    return fallback, pool


async def discover_routes(request: DiscoverRequest) -> dict:
    """A catalog lookup plus at most three bounded Gemini function-calling turns."""
    from app.discovery_agent import recommend_routes
    fallback, pool = await _discover_catalog(request)
    result = await recommend_routes(request, eligible_candidates(request, pool), fallback)
    result["catalog"] = fallback["catalog"]
    return result
