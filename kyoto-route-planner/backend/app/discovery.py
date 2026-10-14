"""Discover facilities with bounded AI selection and deterministic route constraints.

Transport is searched only after adoption. The finite catalog is not exhaustive.
"""
import asyncio
import os
import re
import unicodedata
from typing import Annotated, Literal
from datetime import date, datetime, timedelta, timezone
from itertools import permutations
from fastapi import HTTPException
from hashlib import sha256
from math import asin, cos, radians, sin, sqrt, ceil

from pydantic import BaseModel, Field, PrivateAttr, model_validator

from app.models import CatalogPlace, Origin, Theme
from app.places import is_unsuitable_place
from app.public_catalog import load_public_places
from app.regional_food import regional_score
from app.travel_wishes import wish_score
from app.venue_hours import visit_fits


PACE_SETTINGS = {"relaxed": (2, 75, 120), "standard": (3, 60, 105), "packed": (4, 45, 75)}
PACE_LABELS = {"relaxed": "ゆったり", "standard": "標準", "packed": "たくさん巡る"}


class Traveler(BaseModel):
    pace: Literal["relaxed", "standard", "packed"] = "standard"
    age_group: Literal["unspecified", "under_18", "18_29", "30_49", "50_64", "65_plus"] = "unspecified"
    gender: Literal["unspecified", "female", "male", "other"] = "unspecified"
    companion: Literal["unspecified", "family", "friends", "couple", "solo"] = "unspecified"


class MealChoice(BaseModel):
    kind: Literal["breakfast", "lunch", "dinner"]
    time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class DiscoverRequest(BaseModel):
    departure_date: date = Field(default_factory=lambda:datetime.now(timezone(timedelta(hours=9))).date())
    _venue_hours: dict = PrivateAttr(default_factory=dict)
    area: str = Field(pattern=r"^[a-z]{1,30}$")
    prefecture_name: str = Field(min_length=1, max_length=10)
    origin: Origin
    theme: Theme = "all"
    themes: list[Theme] = Field(default_factory=list, max_length=4)
    meals: list[MealChoice] | None = Field(default=None, max_length=3)

    @model_validator(mode="after")
    def unique_meals(self):
        if self.meals and len({m.kind for m in self.meals}) != len(self.meals):
            raise ValueError("食事は朝・昼・夜それぞれ1回まで選べます。")
        return self
    course: str = Field(default="all", pattern=r"^(all|half_day|full_day)$")
    radius_km: int = Field(default=30, ge=1, le=20000)
    cross_prefecture: bool = True
    variation: int = Field(default=0, ge=0, le=10000)
    count: int = Field(default=12, ge=1, le=20)
    traveler: Traveler | None = None
    preference_text: str = Field(default="", max_length=600)
    priority_text: str = Field(default="", max_length=500)
    viewed_dining_ids: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=list, max_length=60)


def traveler_pace(request: DiscoverRequest) -> str:
    return request.traveler.pace if request.traveler else "standard"


def stay_minutes(request: DiscoverRequest) -> int:
    settings = PACE_SETTINGS[traveler_pace(request)]
    return settings[2] if request.course == "full_day" else settings[1]


def max_stops(request: DiscoverRequest) -> int:
    return PACE_SETTINGS[traveler_pace(request)][0] + (2 if request.course == "full_day" else 0)


def selected_themes(request: DiscoverRequest) -> set[str]:
    return set(request.themes or [request.theme]) - {"all"}


def dinner_place(place: CatalogPlace) -> bool:
    if any(word in place.name + place.category for word in ("アイスクリーム", "ソフトクリーム", "和菓子", "洋菓子", "口福堂", "ドーナツ", "コンビニ", "セブンイレブン", "セブンーイレブン", "ファミリーマート", "ローソン", "キヨスク", "KIOSK")):
        return False
    if re.search(r"カフェ|喫茶|caf[eé]",place.name,re.I) and not any(word in place.name + place.category for word in ("レストラン", "食堂", "定食")):
        return False
    return "food" in place_themes(place) and (place.genre_code.startswith("01") or any(
        word in place.name + place.category for word in ("飲食", "レストラン", "食堂", "料理", "冷麺", "そば", "麺", "寿司", "焼肉", "グルメ"))) and not any(
        word in place.category for word in ("カフェ", "喫茶", "市場", "商店街"))


def preserves_choices(request: DiscoverRequest, nearby, available) -> bool:
    if any(wish_score(request.priority_text, p) for p in available) and not any(wish_score(request.priority_text, p) for p in nearby):
        return False
    required_meals = len(request.meals) if request.meals is not None else int(request.course == "full_day")
    if sum(dinner_place(p) for p in nearby) < required_meals:
        return False
    available_themes = selected_themes(request) & {theme for p in available for theme in place_themes(p)}
    return available_themes <= {theme for p in nearby for theme in place_themes(p)}


def arrange_meals(request, places):
    defaults = {"breakfast": "08:30", "lunch": "12:00", "dinner": "18:00"}
    choices = sorted(request.meals, key=lambda m: list(defaults).index(m.kind))
    venues = [p for p in places if dinner_place(p)]
    pending = [p for p in places if not dinner_place(p)]
    if len(venues) != len(choices):
        return None
    def minute(m):
        h, n = (m.time or defaults[m.kind]).split(":")
        return int(h) * 60 + int(n)
    if any(minute(b) < minute(a) + 90 for a, b in zip(choices, choices[1:])):
        return None
    start = max(0, min(540, minute(choices[0]) - 30)) if choices else 540
    if request.course == "half_day" and choices:
        start = max(0, minute(choices[0]) - (30 if choices[0].kind == "breakfast" else 120))
    elif request.course == "all" and choices:
        start = max(0, minute(choices[0]) - (30 if choices[0].kind == "breakfast" else 120))
    if request.course == "full_day" and choices:
        finish = minute(choices[-1]) + min(stay_minutes(request), 75) + ceil(distance_km(venues[-1], request.origin) / 25 * 60) + 10
        start = max(start, ceil((finish - 720) / 15) * 15)
    now, cursor, ordered, roles, anchors = start, request.origin, [], {}, {}
    def travel(a, b): return ceil(distance_km(a, b) / 25 * 60) + 10
    def dwell(p): return min(stay_minutes(request), 75) if "food" in place_themes(p) else stay_minutes(request)
    for meal, venue in zip(choices, venues):
        target = minute(meal)
        while pending and now + travel(cursor, pending[0]) + dwell(pending[0]) + travel(pending[0], venue) <= target:
            p = pending.pop(0)
            now += travel(cursor, p) + dwell(p)
            ordered.append(p)
            cursor = p
        arrival = now + travel(cursor, venue)
        if arrival > target + (0 if meal.time else 90):
            return None
        at = max(arrival, target)
        if not meal.time:
            at=next((candidate for candidate in range(at,target+91) if visit_fits(venue,request.departure_date,candidate,dwell(venue),request._venue_hours.get(venue.id))),at)
        if not visit_fits(venue,request.departure_date,at,dwell(venue),request._venue_hours.get(venue.id)):
            return None
        roles[venue.id], anchors[venue.id] = meal.kind, f"{at // 60:02}:{at % 60:02}"
        ordered.append(venue)
        now, cursor = at + dwell(venue), venue
    for p in pending:
        now += travel(cursor, p) + dwell(p)
        ordered.append(p)
        cursor = p
    return ordered, roles, anchors, f"{start // 60:02}:{start % 60:02}", now + travel(cursor, request.origin) - start


def recommendation_reason(request: DiscoverRequest, ordered: list[CatalogPlace]) -> str:
    categories = "・".join(dict.fromkeys(p.category for p in ordered))
    reason = f"{PACE_LABELS[traveler_pace(request)]}ペースで{len(ordered)}か所、観光は各{stay_minutes(request)}分、食事は最大75分（目安）。{categories}を巡ります。"
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
    if any(word in text for word in ("グルメ", "飲食", "レストラン", "カフェ", "食堂", "料理", "喫茶", "市場", "商店街", "冷麺", "そば", "じゃじゃ麺", "寿司", "焼肉")):
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


def scenic_priority(place):
    if 'nature' not in place_themes(place):return 0
    return int(bool(place.tags.get('wikidata') or place.tags.get('wikipedia') or place.tags.get('website')))+2*int(bool(re.search(r'庭園|国立|県立|植物園|渓谷|滝|湖|海岸|展望台|自然公園|名勝',place.name+place.category)))

def eligible_candidates(request: DiscoverRequest, places: tuple[CatalogPlace, ...]) -> list[CatalogPlace]:
    """Apply all hard constraints before exposing any facility to the agent."""
    candidates = sorted((place for place in places
        if (request.cross_prefecture or place.region == request.prefecture_name)
        and (not selected_themes(request) or bool(selected_themes(request) & set(place_themes(place)))
             or wish_score(request.priority_text, place) > 0
             or request.theme == "food" or (request.meals or request.meals is None and request.course == "full_day") and dinner_place(place))
        and (request.meals != [] or not dinner_place(place))
        and not any(word in place.category for word in ("ホテル", "旅館", "宿泊"))
        and not is_unsuitable_place(place)
        and distance_km(request.origin, place) <= request.radius_km),
        key=lambda place: (place.region != request.prefecture_name, -wish_score(request.priority_text, place), -regional_score(request.origin, place) if request.theme == "food" else 0, distance_km(request.origin, place), place.id))
    candidates = distinct_venues(candidates)
    local = [p for p in candidates if p.region == request.prefecture_name]
    if len(local) >= max_stops(request) and preserves_choices(request, local, candidates) and (request.theme != "food" or any("food" in place_themes(p) for p in local)):
        candidates = local
    return candidates


def assemble_route(request: DiscoverRequest, ordered: list[CatalogPlace],
                   reasons: dict[str, str] | None = None, *, source: str = "rules") -> dict | None:
    """Compute a round trip independently; reject AI selections over the time cap."""
    if not ordered or len(ordered) > max_stops(request):
        return None
    ordered = list(ordered)
    meal_plan = next((plan for venues in permutations([p for p in ordered if dinner_place(p)])
        if (plan:=arrange_meals(request,[*[p for p in ordered if not dinner_place(p)],*venues])) is not None),None) if request.meals is not None else None
    if request.meals is not None and meal_plan is None:
        return None
    if meal_plan:
        ordered = meal_plan[0]
    dinner = next((p for p in reversed(ordered) if dinner_place(p)), None) if request.course == "full_day" and request.meals is None else None
    if request.course == "full_day" and request.meals is None:
        if dinner is None:
            return None
        ordered.remove(dinner)
        other_meals = [p for p in ordered if "food" in place_themes(p)]
        ordered = [p for p in ordered if p not in other_meals]
        ordered[1:1] = other_meals
        ordered.append(dinner)
    food = [p for p in ordered if "food" in place_themes(p)]
    meal_limit = max(2, len(request.meals or []))
    if request.theme == "food" and (not food or len(food) > meal_limit):
        return None
    if request.course == "full_day" and (len(ordered) < 4 or len(food) > meal_limit):
        return None
    stay = stay_minutes(request)
    stays = [min(stay, 75) if "food" in place_themes(p) else stay for p in ordered]
    points = [request.origin, *ordered, request.origin]
    legs = [{"from": a.name, "to": b.name, "distance_km": round(distance_km(a, b), 2),
             "mode": "public_transport", "minutes": ceil(distance_km(a, b) / 25 * 60) + 10}
            for a, b in zip(points, points[1:])]
    minutes = sum(leg["minutes"] for leg in legs) + sum(stays)
    if meal_plan:
        minutes = meal_plan[4]
    if dinner:
        # Start at 09:00; free time before dinner is waiting, never inflated visit duration.
        arrival = minutes - stays[-1] - legs[-1]["minutes"]
        minutes += max(0, 9 * 60 - arrival)
    clock=int((meal_plan[3] if meal_plan else '09:00')[:2])*60+int((meal_plan[3] if meal_plan else '09:00')[3:])
    for index,place in enumerate(ordered):
        clock+=legs[index]['minutes']
        anchor=meal_plan[2].get(place.id) if meal_plan else '18:00' if place==dinner else None
        if anchor:clock=max(clock,int(anchor[:2])*60+int(anchor[3:]))
        if not visit_fits(place,request.departure_date,clock,stays[index],request._venue_hours.get(place.id)):return None
        clock+=stays[index]
    if minutes > (300 if request.course == "half_day" else 720 if request.course == "full_day" or request.meals else 600) or (request.course == "full_day" and minutes < 360):
        return None
    course = "full_day" if request.course == "full_day" or minutes > 300 else "half_day"
    reasons = reasons or {p.id: f"{p.category}の候補で、出発地から直線約{distance_km(request.origin, p):.1f}kmです。" for p in ordered}
    return {"id": "dynamic-" + sha256((request.area + str(stay) + "|".join(p.id for p in ordered)).encode()).hexdigest()[:16],
            "area": request.area, "pattern": course, "course": course, "theme": request.theme,
            "title": ordered[0].name + "から、" + {"all": "街歩き", "history": "歴史と文化", "temple": "寺社めぐり", "nature": "自然と景色", "food": "食のひととき"}[request.theme] + "を楽しむ旅",
            "estimated_minutes": minutes, "legs": legs, "departure_time": meal_plan[3] if meal_plan else "09:00",
            "start": {"name": request.origin.name, "lat": request.origin.latitude, "lng": request.origin.longitude,
                      "to_first_km": legs[0]["distance_km"], "from_last_km": legs[-1]["distance_km"]},
            "total_score": len(ordered), "center": [request.origin.latitude, request.origin.longitude],
            "recommendation_source": source,
            "recommendation_reason": recommendation_reason(request, ordered),
            "spots": [{"place_id": p.id, "name": p.name, "category": p.category, "lat": p.latitude, "lng": p.longitude,
                       "address": p.address, "tags": p.tags,
                       "stay_minutes": stays[index], "score": 1, "role": meal_plan[1].get(p.id, "stop") if meal_plan else "dinner" if p == dinner else "stop", "reason": reasons[p.id],
                       **({"meal_time": meal_plan[2][p.id]} if meal_plan and p.id in meal_plan[2] else {})} for index, p in enumerate(ordered)],
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
        if len(nearby) >= max(6, max_stops(request)) and preserves_choices(request, nearby, candidates) and (request.theme != "food" or any("food" in place_themes(p) for p in nearby)) and not any((regional_score(request.origin, p) or wish_score(request.priority_text, p)) and p not in nearby for p in candidates):
            candidates, effective_radius = nearby, radius
            break
    candidates.sort(key=lambda p: (-wish_score(request.priority_text, p), -regional_score(request.origin, p) if request.theme == "food" else 0, -scenic_priority(p) if 'nature' in selected_themes(request) else 0, -traveler_priority(request, p), distance_km(request.origin, p), p.id))
    routes, seen, venue_use = [], set(), {}
    for index in range(min(len(candidates), 80)):
        seed = candidates[(index + request.variation) % len(candidates)]
        ordered, remaining, cursor = [seed], [p for p in candidates if p.id != seed.id], seed
        # Vary dining venues across the deck, retaining local-specialty priority.
        dining = sorted(candidates, key=lambda p: (8 * venue_use.get(p.id, 0) - 10 * wish_score(request.priority_text, p) - (2 * regional_score(request.origin, p) if request.theme == "food" else 0),
                        distance_km(seed, p), p.id))
        if request.meals is not None:
            defaults={'breakfast':'08:30','lunch':'12:00','dinner':'18:00'}
            assigned=set();possible=True
            for choice in sorted(request.meals,key=lambda m:list(defaults).index(m.kind)):
                target=choice.time or defaults[choice.kind];minute=int(target[:2])*60+int(target[3:])
                def suitable(p):
                    return dinner_place(p) and p.id not in assigned and any(visit_fits(p,request.departure_date,minute+delay,min(stay_minutes(request),75),request._venue_hours.get(p.id)) for delay in (range(0,91,15) if not choice.time else [0]))
                venue=next((p for p in ordered if suitable(p)),None) or next((p for p in dining if p not in ordered and suitable(p)),None)
                if not venue:possible=False;break
                assigned.add(venue.id)
                if venue not in ordered:ordered.append(venue);remaining.remove(venue)
            if not possible or any(dinner_place(p) and p.id not in assigned for p in ordered):continue
        if request.course == "full_day" and request.meals is None and not dinner_place(seed):
            meal = next((p for p in dining if dinner_place(p)), None)
            if meal:
                ordered.append(meal)
                remaining.remove(meal)
        if request.theme == "food":
            preferred = next((p for p in dining if "food" in place_themes(p)), None)
            if preferred and preferred not in ordered:
                foods = [p for p in ordered if "food" in place_themes(p)]
                if not foods:
                    ordered.append(preferred)
                    remaining.remove(preferred)
                    cursor = preferred
                elif regional_score(request.origin, preferred) > max(regional_score(request.origin, p) for p in foods):
                    replaced = foods[0]
                    ordered[ordered.index(replaced)] = preferred
                    remaining.remove(preferred)
                    remaining.append(replaced)
                    cursor = preferred
        while remaining and len(ordered) < max_stops(request):
            options = [p for p in remaining if (request.meals is None or not dinner_place(p)) and ("food" not in place_themes(p) or (sum("food" in place_themes(q) for q in ordered) < max(2, len(request.meals or [])) and "food" not in place_themes(cursor)))]
            if not options:
                break
            missing = selected_themes(request) - {t for q in ordered for t in place_themes(q)}
            nearest = min(options, key=lambda p: (-wish_score(request.priority_text, p), -len(missing & set(place_themes(p))), -scenic_priority(p) if 'nature' in selected_themes(request) else 0, distance_km(cursor, p) - 0.5 * traveler_priority(request, p), p.id))
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
        for p in ordered:
            venue_use[p.id] = venue_use.get(p.id, 0) + 1
        if len(routes) >= request.count:
            break
    note = f"OpenStreetMapの施設候補から条件に合わせて作成しました。検索半径 {effective_radius}km（上限 {request.radius_km}km）。"
    if effective_radius > radii[0]:
        note += "候補が少ないため検索範囲を広げました。"
    if len(candidates) < 3:
        note += "候補が少ないため、見つかったスポット数で提案しています。"
    if not routes and request.course == "full_day":
        note += "希望の食事・時刻に合う1日コース（4か所以上・最大12時間）を組める候補が不足しています。食事や時間の条件、観光範囲を見直してください。"
    note += f"{PACE_LABELS[traveler_pace(request)]}ペースで最大{max_stops(request)}か所、観光は各{stay_minutes(request)}分、食事は最大75分の滞在です。"
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
            limit=100, genre_codes=genres["all" if request.meals or request.theme == "food" or len(selected_themes(request)) > 1 or request.course == "full_day" else request.theme],
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
    from app.openpoi import enrich_candidates, merge_candidates
    from app.restaurant_discovery import discover_restaurants, match_independent_restaurants
    (fallback, base), restaurants, (extra, status) = await asyncio.gather(
        _base_discover_catalog(request), discover_restaurants(request), enrich_candidates(request, ()))
    pool = merge_candidates(base, extra)
    restaurants = match_independent_restaurants(restaurants, eligible_candidates(request, pool))
    from app.google_place_photos import same_google_venue
    for place in [*pool,*restaurants.places]:
        matched={p.get('id'):p for p in restaurants.google_results if same_google_venue(place,p)}
        if len(matched)==1:
            hours=next(iter(matched.values())).get('regularOpeningHours')
            if isinstance(hours,dict):request._venue_hours[place.id]=hours
    added = sum(p.id.startswith("openpoi-") for p in pool)
    if added:
        fallback = build_discover_routes(request, pool)
        fallback["source"] = "OpenStreetMap / OpenPOI API"
        fallback["note"] = ("OSMの登録施設と、分類・検索範囲・住所と座標の町域整合性を確認したOpenPOI候補を使用しています。"
                            "重複は既存施設を優先。入口の正確な位置・営業状況は未確認で、移動時間は推定です。")
    elif status != "disabled":
        fallback["note"] += "OpenPOIで追加可能な施設を確認できなかったため、既存の候補を使用しています。"
    blocked = set(restaurants.blocked_ids)
    merged = {p.id:p for p in pool if p.id not in blocked}
    before = len(merged)
    for place in restaurants.places:
        merged.setdefault(place.id,place)
    pool = tuple(distinct_venues(list(merged.values())))
    restaurant_added = max(0,len(pool) - before)
    if restaurants.places or blocked or request._venue_hours:
        previous_source = fallback["source"]
        fallback = build_discover_routes(request, pool)
        if restaurants.status == "osm_only_unconfirmed":
            fallback["source"] = previous_source
            fallback["note"] = "周辺の飲食店をOpenStreetMapの候補で補っています。営業状況・営業時間・メニューは未確認です。"
        else:
            fallback["source"] = previous_source + " / Google Places"
            fallback["note"] = "周辺の飲食店とご当地料理をPlacesでも検索し、OSM・OpenPOIの店名・位置と照合しています。営業時間・メニューは訪問前にご確認ください。"
    fallback["catalog"] = {"openpoi_status": status, "openpoi_added": added, "base_count": len(base),
        "availability_checked":bool(request._venue_hours or blocked),
        "restaurants_status":restaurants.status,"restaurants_found":len(restaurants.places),"restaurants_added":restaurant_added,
        "restaurants_verified":restaurants.verified_count,
        "verified_dining_ids":[p.id for p in restaurants.places] if restaurants.verified_count else [],
        "local_dining_ids":list(restaurants.local_match_ids)}
    return fallback, pool


async def discover_routes(request: DiscoverRequest) -> dict:
    """A catalog lookup plus at most three bounded Gemini function-calling turns."""
    fallback, pool = await _discover_catalog(request)
    return await _select_discover_routes(request, fallback, pool)


async def discover_route_events(request: DiscoverRequest):
    """Deliver feasible catalog routes before waiting for AI selection.

    One catalog lookup and one shared AI job serve the whole stream. Neither
    polling nor a second provider search is needed to receive the final deck.
    """
    fallback, pool = await _discover_catalog(request)
    yield {"stage": "initial", "result": fallback}
    result = await _select_discover_routes(request, fallback, pool)
    yield {"stage": "complete", "result": result}


async def _select_discover_routes(request, fallback, pool):
    from app.discovery_agent import recommend_routes
    result = await recommend_routes(request, eligible_candidates(request, pool), fallback)
    result["catalog"] = fallback["catalog"]
    by_id = {p.id: p for p in pool}
    def route_wish_score(route):
        return sum(wish_score(request.priority_text, by_id[spot["place_id"]])
                   for spot in route["spots"] if spot["place_id"] in by_id)
    if request.priority_text:
        # A model omission must not erase a feasible explicit wish already found
        # by the bounded deterministic composer.
        choices = sorted([*result["routes"], *(r for r in fallback["routes"] if route_wish_score(r))], key=lambda r: -route_wish_score(r))
        unique = {}
        for route in choices:
            unique.setdefault(tuple(sorted(s["place_id"] for s in route["spots"])), route)
        result["routes"] = list(unique.values())[:request.count]
    result["routes"] = diversify_dining_routes(request,result["routes"],pool,
        set(fallback["catalog"].get("local_dining_ids",[])),set(fallback["catalog"].get("verified_dining_ids",[])))
    result["routes"].sort(key=lambda route: -route_wish_score(route))
    from app.discovery_review import review_journeys
    result["review"] = await review_journeys(request, result, pool)
    return result


def diversify_dining_routes(request, routes: list[dict], pool, preferred_ids: set[str] | None = None, verified_ids: set[str] | None = None) -> list[dict]:
    """Balance meal reuse after AI selection, rechecking every resulting route.

    Regional search matches are a ranking hint, not proof of a particular menu.
    Display facts and saved identities remain with the independent catalog providers.
    """
    if request.meals == []:
        return routes
    allowed = {p.id:p for p in eligible_candidates(request,tuple(pool))}
    dining = [p for p in allowed.values() if dinner_place(p)]
    if len(dining) < 2:
        return routes
    used, seen, result = {p.id:1 for p in dining if p.id in request.viewed_dining_ids}, set(), []
    brand = lambda p: p.tags.get("brand:wikidata") or p.tags.get("brand")
    used_brands: dict[str,int] = {}
    for p in dining:
        if p.id in request.viewed_dining_ids and brand(p): used_brands[brand(p)] = 1
    preferred_ids = preferred_ids or set()
    prefer_verified = len(verified_ids or ()) >= 3
    for original in routes:
        if any(s["place_id"] not in allowed for s in original["spots"]):
            result.append(original)
            continue
        places = [allowed[s["place_id"]] for s in original["spots"]]
        changed = False
        for index, current in enumerate(list(places)):
            if not dinner_place(current):
                continue
            others = {p.id for i,p in enumerate(places) if i != index}
            priority = lambda p: 10 * wish_score(request.priority_text, p) + 2 * regional_score(request.origin,p) + 3 * int(p.id in preferred_ids)
            ranked = sorted((p for p in dining if p.id not in others), key=lambda p: (
                -wish_score(request.priority_text, p),
                prefer_verified and p.id not in verified_ids,
                8 * (used.get(p.id,0) + used_brands.get(brand(p),0)) - priority(p), distance_km(current,p), p.id))
            for choice in ranked:
                proposed = [*places[:index],choice,*places[index+1:]]
                signature = tuple(sorted(p.id for p in proposed))
                if signature in seen or assemble_route(request,proposed) is None:
                    continue
                places, changed = proposed, changed or choice.id != current.id
                break
        route = assemble_route(request,places) if changed else original
        if route is None:
            route = original
        if changed:
            previous = {s["place_id"]:s for s in original["spots"]}
            for spot in route["spots"]:
                if spot["place_id"] in previous:
                    for key in ("reason","reason_sources"):
                        if key in previous[spot["place_id"]]: spot[key] = previous[spot["place_id"]][key]
            sources = [source for spot in route["spots"] for source in spot.get("reason_sources",[])]
            if sources: route["reason_sources"] = list({s["url"]:s for s in sources}.values())
        signature = tuple(sorted(s["place_id"] for s in route["spots"]))
        if signature in seen:
            continue
        seen.add(signature)
        result.append(route)
        for p in places:
            if dinner_place(p):
                used[p.id] = used.get(p.id,0) + 1
                if brand(p): used_brands[brand(p)] = used_brands.get(brand(p),0) + 1
    return result
