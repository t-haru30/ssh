"""Bounded OpenPOI discovery with independent address checks and OSM precedence.

Only fixed public endpoints are fetched. A coordinate matching its municipality
and neighbourhood is a plausibility check, not proof of an entrance or opening.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from hashlib import sha256
import json
import os
import re
import ssl
import time
import unicodedata

import httpx

from app.models import CatalogPlace

SEARCH_URL = "https://api.openpoiapi.com/v1/search"
MUNICIPALITIES_URL = "https://maps.gsi.go.jp/js/muni.js"
REVERSE_URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress"
ATTRIBUTION_URL = "https://openpoiapi.com/attribution.html"
MAX_CHECKS = 30
CATEGORIES = {
    "cafe": ("カフェ", "01"), "coffee_shop": ("カフェ", "01"),
    "restaurant": ("飲食店", "01"), "fast_food": ("飲食店", "01"),
    "museum": ("博物館", "0305003"), "art_museum": ("美術館", "0305002"),
    "art_gallery": ("美術館", "0305002"), "park": ("公園", "030300"),
    "garden": ("庭園", "0305007"), "botanical_garden": ("植物園", "0303004"),
    "zoo": ("動物園", "0303002"), "aquarium": ("水族館", "0303003"),
    "buddhist_temple": ("寺院", "0424001"), "shinto_shrine": ("神社", "0424002"),
}
_cache: OrderedDict[tuple, tuple[float, tuple[CatalogPlace, ...], str]] = OrderedDict()
_reverse_cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_municipalities: dict[str, tuple[str, str]] = {}
_slots = asyncio.Semaphore(2)


def normalized(value: str) -> str:
    return re.sub(r"[\s・･\-－ー]", "", unicodedata.normalize("NFKC", value)).casefold()


def classification(row: dict) -> tuple[str, str] | None:
    kinds = {str(row.get(k, "")).lower() for k in ("category", "business_type")}
    known = [CATEGORIES[k] for k in sorted(kinds) if k in CATEGORIES]
    if known:
        # Contradictory food/tourism types are not reliable candidates.
        return known[0] if len({genre.startswith("01") for _, genre in known}) == 1 else None
    if kinds & {"tourism", "attraction", "tourist_attraction", "historic_site"}:
        name = str(row.get("name", ""))
        # Generic tourism tags can represent shops. Require an explicit facility kind.
        for word, result in (("美術館", ("美術館", "0305002")), ("博物館", ("博物館", "0305003")),
                             ("水族館", ("水族館", "0303003")), ("動物園", ("動物園", "0303002")),
                             ("植物園", ("植物園", "0303004")), ("庭園", ("庭園", "0305007")),
                             ("公園", ("公園", "030300"))):
            if name.endswith(word):
                return result
    return None


def parse_candidate(row: object, request) -> CatalogPlace | None:
    from app.discovery import distance_km
    from app.places import is_unsuitable_place
    if not isinstance(row, dict):
        return None
    kind = classification(row)
    if not kind:
        return None
    required = ("name", "prefecture", "city", "address")
    if any(not isinstance(row.get(k), str) or not row[k].strip() for k in required):
        return None
    if len(row["name"]) > 200 or len(row["address"]) > 500 or len(row["prefecture"]) > 100 or len(row["city"]) > 100:
        return None
    if normalized(row["name"]) in {"カフェ", "レストラン", "飲食店", "公園", "cafe", "restaurant"}:
        return None
    if not normalized(row["address"]).startswith(normalized(row["prefecture"] + row["city"])):
        return None
    for key in ("licenses", "attributions"):
        if not isinstance(row.get(key), list) or not row[key] or len(row[key]) > 20:
            return None
        if any(not isinstance(v, str) or not v.strip() or len(v) > 1000 for v in row[key]):
            return None
    lat, lon = row.get("lat"), row.get("lng")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not -180 <= v <= 180 for v in (lat, lon)):
        return None
    if not (20 <= lat <= 46 and 122 <= lon <= 154):
        return None
    if not request.cross_prefecture and row["prefecture"] != request.prefecture_name:
        return None
    identity = normalized(row["name"]) + "|" + normalized(row["address"])
    place = CatalogPlace(id="openpoi-" + sha256(identity.encode()).hexdigest()[:24],
        name=row["name"].strip(), category=kind[0], genre_code=kind[1], region=row["prefecture"],
        address=row["address"], latitude=lat, longitude=lon, description="",
        tags={"source": "OpenPOI API", "source_url": ATTRIBUTION_URL, "city": row["city"],
              "licenses": json.dumps(row["licenses"], ensure_ascii=False),
              "attributions": json.dumps(row["attributions"], ensure_ascii=False),
              "upstream_source": str(row.get("source", ""))[:100]})
    if distance_km(request.origin, place) > request.radius_km or is_unsuitable_place(place):
        return None
    return place


def merge_candidates(osm: tuple[CatalogPlace, ...], extra: tuple[CatalogPlace, ...]) -> tuple[CatalogPlace, ...]:
    from app.discovery import distance_km
    result = list(osm)
    for place in extra:
        if any(normalized(place.name) == normalized(other.name) and
               (normalized(place.address) == normalized(other.address) or distance_km(place, other) <= .3)
               for other in result):
            continue
        result.append(place)
    return tuple(result)


async def _json(client, url, params):
    response = await client.get(url, params=params)
    response.raise_for_status()
    if len(response.content) > 2_000_000:
        raise ValueError("Oversized POI response")
    return response.json()


async def _load_municipalities(client):
    if _municipalities:
        return _municipalities
    response = await client.get(MUNICIPALITIES_URL)
    response.raise_for_status()
    if len(response.content) > 1_000_000:
        raise ValueError("Oversized municipalities")
    parsed = {}
    for code, value in re.findall(r'GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*\x27([^\x27]+)\x27', response.text):
        fields = value.split(",")
        if len(fields) == 4:
            parsed[code.zfill(5)] = (normalized(fields[1]), normalized(fields[3]))
    if not parsed:
        raise ValueError("Municipality table unavailable")
    _municipalities.update(parsed)
    return _municipalities


def address_matches(place: CatalogPlace, result: dict, municipalities: dict) -> bool:
    city = municipalities.get(str(result.get("muniCd", "")).zfill(5))
    if city != (normalized(place.region), normalized(place.tags["city"])):
        return False
    # Require the neighbourhood too: municipality alone can hide kilometre errors.
    neighbourhood = normalized(str(result.get("lv01Nm", "")))
    neighbourhood = re.sub(r"[0-9一二三四五六七八九十]+丁目$", "", neighbourhood)
    neighbourhood = re.sub(r"^(大字|字)", "", neighbourhood)
    rest = normalized(place.address).removeprefix(normalized(place.region + place.tags["city"]))
    return len(neighbourhood) >= 2 and neighbourhood in rest


async def _verified(client, place, municipalities, semaphore):
    async with semaphore:
        key = (place.latitude, place.longitude)
        try:
            cached = _reverse_cache.get(key)
            if cached and cached[0] > time.monotonic():
                result = cached[1]
            else:
                data = await _json(client, REVERSE_URL, {"lat": place.latitude, "lon": place.longitude})
                result = data.get("results", {}) if isinstance(data, dict) else {}
                if not isinstance(result, dict):
                    return None
                _reverse_cache[key] = (time.monotonic() + 86400, result)
                if len(_reverse_cache) > 1024:
                    _reverse_cache.popitem(last=False)
            if address_matches(place, result, municipalities):
                return place.model_copy(update={"tags": {**place.tags, "position_check": "gsi_neighbourhood"}})
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass
        return None


async def _search(request, query: str = "") -> tuple[CatalogPlace, ...]:
    from app.discovery import eligible_candidates
    async with httpx.AsyncClient(timeout=httpx.Timeout(3, connect=2), follow_redirects=False,
                                 trust_env=False, verify=ssl.create_default_context()) as client:
        # The API can return exact-name hits outside the radius; parse_candidate checks it again.
        params = {"center": f"{request.origin.longitude},{request.origin.latitude}",
                  "radius": request.radius_km * 1000, "limit": 200}
        from app.regional_food import specialties
        queries = [query] if query else [*((specialties(request.origin)[:1] or (f"{request.prefecture_name} 郷土料理",)) if request.theme == "food" else ()), "", "カフェ 喫茶 レストラン", "博物館 美術館 庭園 公園 水族館 動物園"]
        responses = await asyncio.gather(*(_json(client, SEARCH_URL, {**params, "q": q}) for q in queries), return_exceptions=True)
        pools = []
        for data in responses:
            rows = data.get("results", []) if isinstance(data, dict) else []
            if not isinstance(rows, list):
                continue
            parsed = [p for row in rows[:200] if (p := parse_candidate(row, request)) is not None]
            pools.append(eligible_candidates(request, tuple(parsed)))
        # Interleave searches so nearby restaurants cannot consume the entire inspection budget.
        selected = []
        for index in range(200):
            for pool in pools:
                if index < len(pool) and all(p.id != pool[index].id for p in selected):
                    selected.append(pool[index])
            if len(selected) >= MAX_CHECKS:
                break
        if not selected:
            return ()
        municipalities = await _load_municipalities(client)
        asyncio_slots = asyncio.Semaphore(3)
        tasks = [asyncio.create_task(_verified(client, p, municipalities, asyncio_slots)) for p in selected[:MAX_CHECKS]]
        try:
            done, _ = await asyncio.wait(tasks, timeout=5)
            return tuple(task.result() for task in tasks if task in done and not task.cancelled()
                         and task.exception() is None and isinstance(task.result(), CatalogPlace))
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def enrich_candidates(request, osm: tuple[CatalogPlace, ...], query: str = "") -> tuple[tuple[CatalogPlace, ...], str]:
    # Enable for the production public-catalog mode; explicit flag permits local integration tests.
    if os.getenv("OPENPOI_ENABLED", "1" if os.getenv("PLACE_SEARCH_PROVIDER") == "public_catalog" else "0") != "1":
        return osm, "disabled"
    key = (request.origin.latitude, request.origin.longitude, request.radius_km,
           request.prefecture_name, request.cross_prefecture, request.theme, normalized(query))
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        return merge_candidates(osm, cached[1]), cached[2]
    if _slots.locked():
        return osm, "unavailable"
    try:
        async with _slots:
            extra = await asyncio.wait_for(_search(request, query) if query else _search(request), timeout=10)
        status = "ready" if extra else "no_verified_candidates"
        _cache[key] = (time.monotonic() + (1800 if extra else 60), extra, status)
        if len(_cache) > 128:
            _cache.popitem(last=False)
        return merge_candidates(osm, extra), status
    except (TimeoutError, httpx.HTTPError, ValueError, KeyError, TypeError):
        _cache[key] = (time.monotonic() + 60, (), "unavailable")
        if len(_cache) > 128:
            _cache.popitem(last=False)
        return osm, "unavailable"
