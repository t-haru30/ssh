"""Station and lodging suggestions from OSM, ranked with request-local Places.

Only independent OSM records leave this module or enter its bounded cache.
Google names, coordinates and status are used for matching, never saved.
"""
import asyncio
from hashlib import sha256
import json
from math import cos, radians
from pathlib import Path
import ssl
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.cache import TTLCache
from app.discovery import distance_km
from app.google_place_photos import BASE, google_api_key, reserve_lookup, same_google_venue
from app.models import CatalogPlace, Origin
from app.prefecture_boundary import BOUNDARIES, in_prefecture
from app.station_search import search_stations

_osm_cache = TTLCache(21600, 64)
_station_cache = TTLCache(21600, 96)
_slots = asyncio.Semaphore(2)
ENDPOINTS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")
SEEDS_PATH = Path(__file__).resolve().parent / "data" / "osm_travel_candidate_seeds.json"


class TravelCandidatesRequest(BaseModel):
    origin: Origin
    area: str | None = Field(default=None, pattern=r"^[a-z]{1,30}$")
    expanded: bool = False


async def independent_stations(origin, area, expanded):
    """Use the existing station provider even when the Google budget is exhausted."""
    hints = json.loads((SEEDS_PATH.parent / 'station_gateway_hints.json').read_text(encoding='utf-8'))
    entry = hints.get(area)
    if not entry:
        return []
    queries = entry['queries'] if expanded else [origin.name.removesuffix('駅').split('（')[0]]
    cache_key = json.dumps([area, queries])
    hit, stations = _station_cache.get(cache_key)
    if hit:
        return stations
    async def resolve(query):
        try:
            found = await asyncio.wait_for(search_stations(query, entry['code']), timeout=8)
        except (HTTPException, TimeoutError, ValueError, httpx.HTTPError):
            return []
        return [CatalogPlace(id=f'ekispert-station-{s.code}',name=s.name,category='駅',region=s.prefecture,address=s.prefecture,
            latitude=s.latitude,longitude=s.longitude,description='',tags={'source':'駅すぱあと','station_code':s.code,'source_url':'https://ekispert.com/'})
            for s in found if in_prefecture(area,s.latitude,s.longitude) and (expanded or distance_km(origin,s)<=12)]
    result = [p for group in await asyncio.gather(*(resolve(q) for q in queries[:2])) for p in group]
    if result:
        _station_cache.set(cache_key,result)
    return result


def area_at(origin, area=None):
    if area:
        return area
    return next((key for key in json.loads(BOUNDARIES.read_text(encoding="utf-8"))["areas"]
                 if in_prefecture(key, origin.latitude, origin.longitude)), "")


def parse_place(row, origin, area, kind, radius):
    if not isinstance(row, dict) or row.get("type") not in {"node", "way", "relation"} or type(row.get("id")) is not int:
        return None
    tags, point = row.get("tags", {}), row.get("center", row)
    if not isinstance(tags, dict) or not isinstance(point, dict):
        return None
    if tags.get("access") == "private" or any(key.startswith(("disused:", "abandoned:", "demolished:")) for key in tags):
        return None
    valid = tags.get("railway") in {"station", "halt"} if kind == "station" else tags.get("tourism") in {"hotel", "guest_house", "hostel", "motel"}
    name = tags.get("name:ja") or tags.get("name")
    if not valid or not isinstance(name, str) or not name.strip():
        return None
    try:
        kept = {key: value for key, value in tags.items() if key in {"name", "name:ja", "name:en", "official_name", "website", "contact:website", "addr:full", "addr:city", "addr:street"}
                and isinstance(value, str) and len(value) <= 500}
        place = CatalogPlace(id=f"osm-{row['type']}-{row['id']}", name=name.strip(),
            category="駅" if kind == "station" else "宿泊施設", region="", address=tags.get("addr:full", ""),
            latitude=point["lat"], longitude=point["lon"], description="", genre_code="" if kind == "station" else "0304",
            tags={**kept, "area": area, "source": "OpenStreetMap", "license": "ODbL-1.0",
                  "source_url": f"https://www.openstreetmap.org/{row['type']}/{row['id']}"})
    except (ValueError, KeyError, TypeError):
        return None
    if not in_prefecture(area, place.latitude, place.longitude) or distance_km(origin, place) > radius:
        return None
    return place


async def osm_candidates(client, origin, area, kind, radius):
    cache_key = sha256(json.dumps([origin.latitude, origin.longitude, area, kind, radius]).encode()).hexdigest()
    hit, records = _osm_cache.get(cache_key)
    if hit:
        return records
    # Independently acquired small OSM extracts keep common arrival areas usable
    # when public Overpass endpoints are overloaded. Google is still live.
    try:
        seeds = json.loads(SEEDS_PATH.read_text(encoding="utf-8"))
        if seeds.get("license") == "ODbL-1.0":
            records = [p for row in seeds.get("elements", []) if (p := parse_place(row, origin, area, kind, radius))]
            if records:
                _osm_cache.set(cache_key, records)
                return records
    except (OSError, ValueError, TypeError):
        pass
    dlat, dlon = radius / 110, radius / max(1, 110 * cos(radians(origin.latitude)))
    box = f"{max(-90,origin.latitude-dlat):.5f},{max(-180,origin.longitude-dlon):.5f},{min(90,origin.latitude+dlat):.5f},{min(180,origin.longitude+dlon):.5f}"
    selector = '["railway"~"^(station|halt)$"]' if kind == "station" else '["tourism"~"^(hotel|guest_house|hostel|motel)$"]'
    query = f'[out:json][timeout:8];nwr{selector}["name"]({box});out center tags 300;'
    for endpoint in ENDPOINTS:
        try:
            response = await client.get(endpoint, params={"data": query}, timeout=6)
            if response.status_code != 200 or len(response.content) > 1_000_000:
                continue
            data = response.json()
            if not isinstance(data, dict) or "remark" in data or not isinstance(data.get("elements"), list):
                continue
            records = [place for row in data["elements"][:300] if (place := parse_place(row, origin, area, kind, radius))]
            if records:
                _osm_cache.set(cache_key, records)
                return records
        except (httpx.HTTPError, ValueError, TypeError):
            continue
    return []


async def google_candidates(client, origin, kind, radius):
    key = google_api_key()
    if not key or not reserve_lookup():
        return []
    try:
        response = await client.post(BASE + "/places:searchNearby", timeout=6,
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.businessStatus"},
            json={"includedTypes": ["train_station", "subway_station"] if kind == "station" else ["hotel", "lodging"],
                  "maxResultCount": 20, "languageCode": "ja", "rankPreference": "POPULARITY",
                  "locationRestriction": {"circle": {"center": {"latitude": origin.latitude, "longitude": origin.longitude}, "radius": radius * 1000}}})
        data = response.json() if response.status_code == 200 else {}
        return data.get("places", [])[:20] if isinstance(data, dict) and isinstance(data.get("places", []), list) else []
    except (httpx.HTTPError, ValueError, TypeError):
        return []


async def extra_stations(google, independent, origin, area, radius):
    """Resolve up to two Google discoveries independently through Ekispert."""
    names = {p.name.removesuffix("駅") for p in independent}
    queries = []
    for item in google:
        if not isinstance(item, dict) or not isinstance(item.get("displayName"), dict):
            continue
        name = item["displayName"].get("text", "")
        if not isinstance(name, str) or not 1 <= len(name) <= 80 or name.removesuffix("駅") in names:
            continue
        names.add(name.removesuffix("駅")); queries.append((name, item))
        if len(queries) == 2:
            break
    async def resolve(name, item):
        try:
            stations = await asyncio.wait_for(search_stations(name), timeout=8)
        except (HTTPException, TimeoutError, ValueError, httpx.HTTPError):
            return []
        result = []
        for station in stations:
            place = CatalogPlace(id=f"ekispert-station-{station.code}", name=station.name, category="駅", region=station.prefecture,
                address=station.prefecture, description="", latitude=station.latitude, longitude=station.longitude,
                tags={"source":"駅すぱあと", "source_url":"https://ekispert.com/", "station_code":station.code})
            if in_prefecture(area, place.latitude, place.longitude) and distance_km(origin, place) <= radius and same_google_venue(place, item):
                result.append(place)
        return result
    results = await asyncio.gather(*(resolve(name, item) for name, item in queries))
    return [p for group in results for p in group]


async def suggest_travel_candidates(payload: TravelCandidatesRequest, kind: Literal["station", "lodging"]):
    area = area_at(payload.origin, payload.area)
    if not area:
        return {"places": [], "note": "地域を確認できませんでした。行き先を選び直してください。"}
    radius = (50 if payload.expanded else 12) if kind == "station" else 5
    async with _slots, asyncio.timeout(24), httpx.AsyncClient(trust_env=False, verify=ssl.create_default_context(), follow_redirects=False,
            headers={"User-Agent":"ConcierGO/1.0 (facility lookup)", "Accept":"application/json"}) as client:
        independent, google, station_records = await asyncio.gather(osm_candidates(client, payload.origin, area, kind, radius),
            google_candidates(client, payload.origin, kind, radius),
            independent_stations(payload.origin, area, payload.expanded) if kind == "station" else asyncio.sleep(0, result=[]))
        if kind == "station":
            # Additional candidates are an actual new prefecture-scoped lookup,
            # rather than reopening the same short list.
            independent = [*independent, *station_records]
            independent = [*independent, *await extra_stations(google, independent, payload.origin, area, radius)]
    def match(place):
        matches = []
        for item in google:
            try:
                if kind == "station":
                    probe = place.model_copy(update={"name": place.name.removesuffix("駅")})
                    item = {**item, "displayName": {"text": item["displayName"]["text"].removesuffix("駅")}}
                else:
                    probe = place
                if same_google_venue(probe, item):
                    matches.append(item)
            except (KeyError, TypeError, AttributeError, ValueError):
                continue
        return matches[0] if len(matches) == 1 else None
    eligible = []
    for place in independent:
        item = match(place)
        if item and item.get("businessStatus") in {"CLOSED_PERMANENTLY", "CLOSED_TEMPORARILY"}:
            continue
        eligible.append((place, bool(item)))
    eligible.sort(key=lambda row: (not row[1], distance_km(payload.origin, row[0]), row[0].name))
    result, seen = [], set()
    for place, _ in eligible:
        name = place.name.replace("駅", "").replace(" ", "")
        if name in seen:
            continue
        seen.add(name)
        result.append(place.model_dump())
        if len(result) == (12 if kind == "station" else 3):
            break
    return {"places": result, "note": "駅候補：OpenStreetMap・駅すぱあと。" if kind == "station" else "宿泊候補：OpenStreetMap。空室・料金・チェックイン時刻は予約先で確認してください。"}
