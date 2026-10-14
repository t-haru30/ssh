"""Discover dining options through Places, retaining independently sourced OSM facts.

Google responses live only for this request. Only OSM name/location/cuisine data
is returned to the route composer, AI, saved journeys and facility catalog.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import ssl
import time

import httpx

from app.models import CatalogPlace
from app.discovery import distance_km, distinct_venues, selected_themes
from app.google_place_photos import BASE, google_api_key, reserve_lookup, same_google_venue
from app.regional_food import specialties

OVERPASS_URLS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")
OSM_CACHE_PATH = Path(os.getenv("OSM_RESTAURANTS_CACHE_PATH", str(Path(__file__).resolve().parents[1] / "data" / "osm_restaurants.sqlite3")))
OSM_TAGS = {"name", "name:ja", "name:en", "official_name", "amenity", "cuisine", "website", "contact:website", "opening_hours", "addr:full", "addr:province", "addr:city", "addr:suburb", "addr:street", "addr:housenumber", "brand", "brand:wikidata"}
_slots = asyncio.Semaphore(2)


@dataclass
class RestaurantDiscovery:
    places: tuple[CatalogPlace, ...] = ()
    blocked_ids: tuple[str, ...] = ()
    status: str = "unavailable"
    result_count: int = 0
    local_match_ids: tuple[str, ...] = ()
    verified_count: int = 0


def wants_restaurants(request) -> bool:
    return request.meals != [] and bool(request.meals or "food" in selected_themes(request) or request.course == "full_day")


def _cache_key(request, radius):
    return sha256(json.dumps([request.origin.latitude, request.origin.longitude, request.area, radius]).encode()).hexdigest()


def _osm_cache(request, radius, places=None):
    """OSM only, bounded to 64 entries and six hours. Never a Google cache."""
    try:
        OSM_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(OSM_CACHE_PATH, timeout=1)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS restaurants (key TEXT PRIMARY KEY, expires REAL NOT NULL, osm_payload TEXT NOT NULL)")
            db.execute("DELETE FROM restaurants WHERE expires < ?", (time.time(),))
            key = _cache_key(request, radius)
            if places is not None:
                db.execute("INSERT OR REPLACE INTO restaurants VALUES (?,?,?)", (key, time.time() + 21600, json.dumps([p.model_dump() for p in places])))
                db.execute("DELETE FROM restaurants WHERE key NOT IN (SELECT key FROM restaurants ORDER BY expires DESC LIMIT 64)")
                return places
            row = db.execute("SELECT osm_payload FROM restaurants WHERE key=?", (key,)).fetchone()
            return tuple(CatalogPlace.model_validate(p) for p in json.loads(row[0])) if row else None
    except (OSError, sqlite3.Error, ValueError, TypeError):
        return None


def _in_prefecture(request, latitude, longitude):
    # These coordinates originate in OSM, not Google. Reuse the independently
    # bundled prefecture boundary so a Gifu search never becomes Nagoya.
    from app.prefecture_boundary import in_prefecture
    return in_prefecture(request.area, latitude, longitude)


def parse_osm_restaurant(row, request, radius) -> CatalogPlace | None:
    if not isinstance(row, dict) or row.get("type") not in {"node", "way", "relation"} or type(row.get("id")) is not int or row["id"] <= 0:
        return None
    tags, point = row.get("tags"), row.get("center", row)
    if not isinstance(tags, dict) or not isinstance(point, dict) or tags.get("amenity") not in {"restaurant", "fast_food", "food_court"}:
        return None
    if any(k in tags for k in ("disused:amenity", "abandoned:amenity", "demolished:amenity")) or tags.get("access") == "private":
        return None
    name = tags.get("name:ja") or tags.get("name")
    lat, lon = point.get("lat"), point.get("lon")
    if not isinstance(name, str) or not name.strip() or type(lat) not in (float, int) or type(lon) not in (float, int):
        return None
    kept = {k:v for k,v in tags.items() if k in OSM_TAGS and isinstance(v, str) and len(v) <= 500}
    address = kept.get("addr:full") or "".join(kept.get(k, "") for k in ("addr:province", "addr:city", "addr:suburb", "addr:street", "addr:housenumber")) or request.prefecture_name
    try:
        place = CatalogPlace(id=f"osm-{row['type']}-{row['id']}", name=name.strip(), category="飲食店",
            region=request.prefecture_name, address=address, description="", latitude=lat, longitude=lon, genre_code="01",
            source_record_id=f"{row['type']}/{row['id']}", tags={**kept,"source":"OpenStreetMap",
            "source_url":f"https://www.openstreetmap.org/{row['type']}/{row['id']}","license":"ODbL-1.0"})
    except ValueError:
        return None
    if distance_km(request.origin, place) > radius or not _in_prefecture(request, lat, lon):
        return None
    return place


async def _osm_restaurants(client, request, radius):
    cached = _osm_cache(request, radius)
    if cached is not None:
        return cached
    query = (f'[out:json][timeout:10];nwr(around:{radius * 1000:.0f},{request.origin.latitude:.7f},{request.origin.longitude:.7f})'
             '["amenity"~"^(restaurant|fast_food|food_court)$"]["name"];out center tags 2500;')
    for endpoint in OVERPASS_URLS:
        try:
            response = await client.get(endpoint, params={"data":query}, timeout=12)
            if response.status_code != 200 or len(response.content) > 3_000_000:
                continue
            data = response.json()
            if not isinstance(data, dict) or "remark" in data or not isinstance(data.get("elements"), list):
                continue
            places = tuple(p for row in data["elements"][:2500] if (p := parse_osm_restaurant(row, request, radius)))
            if places:
                _osm_cache(request, radius, places)
                return places
        except (httpx.HTTPError, ValueError, TypeError):
            continue
    return ()


async def _google_candidates(client, request, radius, key):
    center = {"latitude":request.origin.latitude,"longitude":request.origin.longitude}
    nearby = {"includedTypes":["restaurant"],"maxResultCount":20,"rankPreference":"POPULARITY","languageCode":"ja",
              "locationRestriction":{"circle":{"center":center,"radius":radius * 1000}}}
    close = {**nearby,"locationRestriction":{"circle":{"center":center,"radius":min(radius,1.5)*1000}}}
    local_words = specialties(request.origin)
    # Separate dishes rather than one AND-like query which can hide useful shops.
    queries = []
    for word in local_words:
        if not any(word in previous or previous in word for previous in queries): queries.append(word)
        if len(queries) == 2: break
    queries = queries or ["郷土料理 ご当地グルメ"]
    def text(word):
        return {"textQuery":f"{request.prefecture_name} {request.origin.name} {word}","includedType":"restaurant","pageSize":20,"languageCode":"ja",
                "locationBias":{"circle":{"center":center,"radius":radius * 1000}}}
    async def search(method, body):
        if not reserve_lookup():
            return []
        try:
            response = await client.post(BASE + method, headers={"X-Goog-Api-Key":key,
                "X-Goog-FieldMask":"places.id,places.displayName,places.location,places.primaryType,places.businessStatus"}, json=body, timeout=7)
            data = response.json() if response.status_code == 200 and len(response.content) <= 120_000 else None
            return [p for p in data["places"][:20] if isinstance(p, dict)] if isinstance(data, dict) and isinstance(data.get("places"), list) else []
        except (httpx.HTTPError, ValueError, TypeError):
            return []
    results = await asyncio.gather(*(search("/places:searchText",text(word)) for word in queries),
        search("/places:searchNearby",nearby),search("/places:searchNearby",close),search("/places:searchNearby",{**close,"rankPreference":"DISTANCE"}))
    return [p for group in results[:len(queries)] for p in group], [p for group in results[len(queries):] for p in group]


async def discover_restaurants(request) -> RestaurantDiscovery:
    if not wants_restaurants(request) or os.getenv("GOOGLE_RESTAURANTS_ENABLED", "1") != "1":
        return RestaurantDiscovery(status="disabled")
    key = google_api_key()
    if not key:
        return RestaurantDiscovery(status="unconfigured")
    if _slots.locked():
        return RestaurantDiscovery(status="busy")
    # Search near the sightseeing gateway. Never expand the user's hard radius.
    radius = min(request.radius_km, 6)
    async with _slots:
        try:
            async with asyncio.timeout(25), httpx.AsyncClient(trust_env=False, follow_redirects=False, verify=ssl.create_default_context(),
                    headers={"User-Agent":"ConcierGO/1.0 (facility lookup)","Accept":"application/json"}) as client:
                groups, osm = await asyncio.gather(_google_candidates(client,request,radius,key), _osm_restaurants(client,request,radius))
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError):
            return RestaurantDiscovery()
    # Only independently sourced OSM records proceed. Google ratings, summaries,
    # hours, names and coordinates cannot enter AI prompts or saved plans here.
    local, nearby = groups
    google = [*local,*nearby]
    local_google_ids = {item.get("id") for item in local if isinstance(item.get("id"),str)}
    found, blocked, local_ids, used_google = [], [], [], set()
    def matches(place, item):
        try:
            return isinstance(item.get("id"),str) and same_google_venue(place,item)
        except (ValueError, TypeError, KeyError, AttributeError):
            return False
    for place in osm:
        matched = {item["id"]:item for item in google if matches(place,item)}
        if len(matched) != 1:
            continue
        match = next(iter(matched.values()))
        if match.get("businessStatus") in {"CLOSED_PERMANENTLY","CLOSED_TEMPORARILY"} or match.get("primaryType") in {"cafe","coffee_shop","bar"}:
            blocked.append(place.id)
        elif match["id"] not in used_google and match.get("businessStatus") == "OPERATIONAL" and match.get("primaryType") not in {"cafe","coffee_shop","bar"}:
            found.append(place)
            used_google.add(match["id"])
            if match["id"] in local_google_ids:
                local_ids.append(place.id)
    # Unmatched OSM rows may have old positions/names. They are not added merely
    # to inflate the deck; use the original catalog if live confirmation fails.
    places = tuple(distinct_venues(found))
    ids = {p.id for p in places}
    return RestaurantDiscovery(places,tuple(blocked),"ready" if places else "no_verified_candidates",
        len({p.get("id") for p in google if isinstance(p.get("id"),str)}),tuple(i for i in local_ids if i in ids),len(places))
