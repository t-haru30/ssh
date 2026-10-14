"""Discover dining options through Places, retaining independently sourced OSM facts.

Google responses live only for this request. Only OSM name/location/cuisine data
is returned to the route composer, AI, saved journeys and facility catalog.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
from dataclasses import dataclass, field
from hashlib import sha256
import json
import logging
from math import cos, radians
import os
from pathlib import Path
import sqlite3
import ssl
import time

import httpx

from app.models import CatalogPlace
from app.discovery import distance_km, distinct_venues, selected_themes
from app.google_place_photos import BASE, google_api_key, reserve_lookup, same_google_venue
from app.regional_food import specialty_queries, regional_score

OVERPASS_URLS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")
OSM_CACHE_PATH = Path(os.getenv("OSM_RESTAURANTS_CACHE_PATH", str(Path(__file__).resolve().parents[1] / "data" / "osm_restaurants.sqlite3")))
OSM_TAGS = {"name", "name:ja", "name:en", "official_name", "amenity", "cuisine", "website", "contact:website", "opening_hours", "addr:full", "addr:province", "addr:city", "addr:suburb", "addr:street", "addr:housenumber", "brand", "brand:wikidata"}
_slots = asyncio.Semaphore(2)
logger = logging.getLogger(__name__)
OSM_SEEDS_PATH = Path(__file__).resolve().parent / "data" / "osm_restaurant_seeds.json"
NON_MEAL_TYPES = {"cafe", "coffee_shop", "bar", "bakery", "ice_cream_shop", "confectionery", "dessert_shop", "dessert_restaurant", "donut_shop", "tea_house", "candy_store", "chocolate_shop"}
MEAL_TYPES = {"restaurant", "food_court", "bar_and_grill", "diner", "steak_house", "sandwich_shop", "noodle_shop", "soba_noodle_shop", "udon_noodle_shop", "meal_takeaway", "meal_delivery"}


def meal_type(kind):
    return isinstance(kind,str) and kind not in NON_MEAL_TYPES and (kind in MEAL_TYPES or kind.endswith("_restaurant"))


@dataclass
class RestaurantDiscovery:
    places: tuple[CatalogPlace, ...] = ()
    blocked_ids: tuple[str, ...] = ()
    status: str = "unavailable"
    result_count: int = 0
    local_match_ids: tuple[str, ...] = ()
    verified_count: int = 0
    # Request-local matching material only. Never serialized into the response,
    # cached, passed to AI or copied into independently sourced facility fields.
    google_results: tuple[dict, ...] = field(default=(), repr=False)
    regional_google_ids: frozenset[str] = field(default_factory=frozenset, repr=False)


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
    # Common arrival areas already have independent OSM extracts. Use those
    # immediately instead of waiting for two public Overpass timeouts. Google
    # still checks operational status and identity for the current request.
    seeds = _seed_restaurants(request, radius)
    if seeds:
        _osm_cache(request, radius, seeds)
        return seeds
    # Bounding-box indexes are cheaper than Overpass's around geometry query.
    # The exact radius and prefecture are still checked on every returned row.
    lat, lon = request.origin.latitude, request.origin.longitude
    dlat, dlon = radius / 110, radius / max(1,110 * cos(radians(lat)))
    box = f"{max(-90,lat-dlat):.5f},{max(-180,lon-dlon):.5f},{min(90,lat+dlat):.5f},{min(180,lon+dlon):.5f}"
    query = (f'[out:json][timeout:10];nwr["amenity"~"^(restaurant|fast_food|food_court)$"]["name"]({box});out center tags 2500;')
    for endpoint in OVERPASS_URLS:
        try:
            response = await client.get(endpoint, params={"data":query}, timeout=6)
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


def _seed_restaurants(request, radius):
    try:
        data = json.loads(OSM_SEEDS_PATH.read_text(encoding="utf-8"))
        if data.get("license") != "ODbL-1.0":
            return ()
        places = tuple(CatalogPlace.model_validate(row) for row in data["places"])
        places = tuple(p for p in places if p.tags.get("source") == "OpenStreetMap"
            and p.id.startswith(("osm-node-","osm-way-","osm-relation-"))
            and distance_km(request.origin,p) <= radius and _in_prefecture(request,p.latitude,p.longitude))
        return places
    except (OSError, ValueError, TypeError, KeyError):
        return ()


async def _google_candidates(client, request, radius, key):
    center = {"latitude":request.origin.latitude,"longitude":request.origin.longitude}
    nearby = {"includedTypes":["restaurant"],"maxResultCount":20,"rankPreference":"POPULARITY","languageCode":"ja",
              "locationRestriction":{"circle":{"center":center,"radius":radius * 1000}}}
    close = {**nearby,"locationRestriction":{"circle":{"center":center,"radius":min(radius,1.5)*1000}}}
    # Separate dishes, rotating only when the user requests a new variation.
    queries = specialty_queries(request.origin, request.variation)
    def text(word):
        return {"textQuery":f"{request.prefecture_name} {request.origin.name} {word}","includedType":"restaurant","strictTypeFiltering":True,"pageSize":20,"languageCode":"ja",
                "locationBias":{"circle":{"center":center,"radius":radius * 1000}}}
    async def search(method, body):
        if not reserve_lookup():
            return []
        try:
            response = await client.post(BASE + method, headers={"X-Goog-Api-Key":key,
                "X-Goog-FieldMask":"places.id,places.displayName,places.location,places.primaryType,places.businessStatus,places.regularOpeningHours"}, json=body, timeout=7)
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
    if not google:
        logger.warning("Dining lookup: Google candidates unavailable; independent OSM candidates=%d",len(osm))
        # Independent OSM facilities can still form a draft. Do not claim that
        # Google verified them; business status must be checked before departure.
        # Bound the composition pool before its pairwise identity checks. A large
        # city may return thousands of restaurants and must not block other pages.
        seen=set(request.viewed_dining_ids)
        ranked=sorted(osm,key=lambda p:(p.id in seen,-regional_score(request.origin,p),distance_km(request.origin,p),p.id))
        bounded=distinct_venues(ranked[:80])[:60]
        return RestaurantDiscovery(places=tuple(bounded),status="osm_only_unconfirmed",result_count=len(osm))
    result = RestaurantDiscovery(status="osm_unavailable", google_results=tuple(google),
        regional_google_ids=frozenset(item["id"] for item in local if isinstance(item.get("id"),str)))
    return match_independent_restaurants(result, osm)


def match_independent_restaurants(result: RestaurantDiscovery, candidates) -> RestaurantDiscovery:
    """Also check existing licensed providers if Overpass could not supply OSM.

    Keep OSM as the database base; the existing OpenPOI supplement retains its own
    identity, location and attribution. Google supplies no savable facility facts.
    """
    from app.discovery import dinner_place
    if not result.google_results:
        return result
    google = result.google_results
    local_google_ids = result.regional_google_ids
    independent = distinct_venues([*result.places, *(p for p in candidates
        if p.tags.get("source") in {"OpenStreetMap", "OpenPOI API"} and dinner_place(p))])
    found, blocked, local_ids, used_google = [], [], [], set()
    def matches(place, item):
        try:
            return isinstance(item.get("id"),str) and same_google_venue(place,item)
        except (ValueError, TypeError, KeyError, AttributeError):
            return False
    for place in independent:
        matched = {item["id"]:item for item in google if matches(place,item)}
        if len(matched) != 1:
            continue
        match = next(iter(matched.values()))
        if match.get("businessStatus") in {"CLOSED_PERMANENTLY","CLOSED_TEMPORARILY"} or isinstance(match.get("primaryType"),str) and not meal_type(match["primaryType"]):
            blocked.append(place.id)
        elif match["id"] not in used_google and match.get("businessStatus") == "OPERATIONAL" and meal_type(match.get("primaryType")):
            found.append(place)
            used_google.add(match["id"])
            if match["id"] in local_google_ids:
                local_ids.append(place.id)
    # Unmatched OSM rows may have old positions/names. They are not added merely
    # to inflate the deck; use the original catalog if live confirmation fails.
    places = tuple(distinct_venues(found))
    ids = {p.id for p in places}
    return RestaurantDiscovery(places,tuple(set(result.blocked_ids) | set(blocked)),"ready" if places else "no_verified_candidates" if independent else "osm_unavailable",
        len({p.get("id") for p in google if isinstance(p.get("id"),str)}),tuple(i for i in local_ids if i in ids),len(places),
        result.google_results,result.regional_google_ids)
