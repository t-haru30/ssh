"""Request-bounded cafe discovery from independently licensed OSM data."""
import asyncio
from collections import OrderedDict
from types import SimpleNamespace
from math import asin, cos, radians, sin, sqrt
from time import monotonic

import httpx
from app import openpoi

ENDPOINTS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")
_cache = OrderedDict()


async def openpoi_cafes(client, centers):
    """Filter to cafe before the existing independent neighbourhood checks."""
    semaphore = asyncio.Semaphore(3)
    async def search(center):
        async with semaphore:
            response = await client.get(openpoi.SEARCH_URL, params={"center": f"{center[1]},{center[0]}", "radius": 1800, "limit": 200}, timeout=4)
            response.raise_for_status()
            if len(response.content) > 2_000_000:
                return []
            data = response.json()
            request = SimpleNamespace(origin=SimpleNamespace(latitude=center[0], longitude=center[1]), radius_km=1.8, cross_prefecture=True)
            return [p for row in data.get("results", [])[:200] if isinstance(row, dict)
                    and openpoi.classification(row) == ("カフェ", "01")
                    and (p := openpoi.parse_candidate(row, request)) is not None]
    try:
        async with asyncio.timeout(12):
            groups = await asyncio.gather(*(search(c) for c in centers), return_exceptions=True)
            selected = {}
            # Round-robin prevents one area consuming all position checks.
            for i in range(12):
                for group in groups:
                    if isinstance(group, list) and len(group) > i:
                        selected[group[i].id] = group[i]
            municipalities = await openpoi._load_municipalities(client)
            verified = await asyncio.gather(*(openpoi._verified(client, p, municipalities, semaphore) for p in list(selected.values())[:18]))
            return [dict(id=p.id, name=p.name, category="カフェ", latitude=p.latitude, longitude=p.longitude,
                         address=p.address, description="OpenPOIのカフェ登録。国土地理院で住所と座標の町域を照合。営業時間・営業状況は未確認です。",
                         access_point="", themes=["food"], tags={**p.tags, "venue_type": "cafe"}) for p in verified if p is not None]
    except (TimeoutError, httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
        return []


def km(a, b):
    x = sin(radians(a[0] - b[0]) / 2) ** 2 + cos(radians(a[0])) * cos(radians(b[0])) * sin(radians(a[1] - b[1]) / 2) ** 2
    return 12742 * asin(sqrt(min(1, x)))


def parse_cafes(data, centers):
    found = {}
    for item in data.get("elements", [])[:400]:
        if not isinstance(item, dict):
            continue
        tags = item.get("tags", {})
        if not isinstance(tags, dict) or tags.get("amenity") != "cafe" or any(tags.get(k) in {"yes", "cafe"} for k in ("disused", "abandoned", "disused:amenity", "abandoned:amenity")):
            continue
        name = tags.get("name:ja") or tags.get("name")
        center = item.get("center") or item
        lat, lon = center.get("lat"), center.get("lon")
        kind, number = item.get("type"), item.get("id")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200 or kind not in {"node", "way", "relation"} or type(number) is not int or number <= 0:
            continue
        if type(lat) not in (float, int) or type(lon) not in (float, int) or not 20 <= lat <= 46 or not 122 <= lon <= 154:
            continue
        if not any(km((lat, lon), c) <= 1.8 for c in centers):
            continue
        identifier = f"osm-cafe-{kind}-{number}"
        found[identifier] = dict(id=identifier, name=name.strip(), category="カフェ", latitude=lat, longitude=lon,
            description="OpenStreetMapでカフェとして登録されている施設。営業時間・営業状況は未確認です。", access_point="", themes=["food"],
            tags={"source": "OpenStreetMap", "source_url": f"https://www.openstreetmap.org/{kind}/{number}",
                  "amenity": "cafe", "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"})
    return list(found.values())


async def nearby_cafes(client, points):
    centers = tuple(dict.fromkeys((round(p.latitude, 5), round(p.longitude, 5)) for p in points))[:8]
    now = monotonic()
    cached = _cache.get(centers)
    if cached and now - cached[0] < 600:
        return cached[1], cached[2] + "（10分以内の取得結果）"
    found = await openpoi_cafes(client, centers)
    if found:
        note = "OpenPOIのカフェ登録と住所・座標の町域を照合（営業状況は未確認）"
        _cache[centers] = (now, found, note)
        while len(_cache) > 32:
            _cache.popitem(last=False)
        return found, note
    clauses = "".join(f'nwr(around:1800,{lat},{lon})["amenity"="cafe"]["name"];' for lat, lon in centers)
    query = f"[out:json][timeout:6];({clauses});out center tags 400;"
    for endpoint in ENDPOINTS:
        try:
            response = await client.post(endpoint, data={"data": query}, timeout=9,
                headers={"User-Agent": "ConcierGO/1.0 (itinerary cafe search)"})
            response.raise_for_status()
            if len(response.content) > 2_000_000:
                continue
            data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("elements"), list) or data.get("remark"):
                continue
            found = parse_cafes(data, centers)
            note = "OSMのカフェ登録を取得（営業状況・営業時間は未確認）"
            _cache[centers] = (now, found, note)
            while len(_cache) > 32:
                _cache.popitem(last=False)
            return found, note
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            continue
    return [], "近隣カフェの取得に失敗しました。既存候補だけで検討します。"
