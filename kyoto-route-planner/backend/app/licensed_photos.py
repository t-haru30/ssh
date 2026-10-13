"""Real photo discovery from fixed public Wikimedia APIs, without generation.

Commons search results are candidates, never identity proof on their own. Direct
files require both a subject name and file coordinates. Wikidata files require
an exact entity label/alias, Earth coordinates and that entity's P18 statement.
"""
from __future__ import annotations

import asyncio
import re
import ssl
from math import asin, cos, isfinite, radians, sin, sqrt
from time import monotonic
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.http_client import provider_timeout
from app.image_search import (
    CommercialImage, WIKIMEDIA_IMAGE_HOSTS, WIKIMEDIA_USER_AGENT, _file_name,
    _metadata_text, _normalize, _query_pages, _safe_host_url, _search_wikipedia,
    _wikipedia_license, definite_place_photo, photo_metadata_safe,
)

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
OPENVERSE_API = "https://api.openverse.org/v1/images/"
OPENVERSE_REQUESTS_PER_HOUR = 60
OPENVERSE_REQUESTS_PER_MINUTE = 5
_openverse_window = 0.0
_openverse_used = 0
_openverse_minute = 0.0
_openverse_minute_used = 0
_openverse_retry_at = 0.0
LOOKUP_SECONDS = 10.0
MAX_ACTIVE_LOOKUPS = 8
_active_lookups = 0
PD_SELF_URL = "https://commons.wikimedia.org/wiki/Template:PD-self"


class PhotoLookupError(ValueError):
    """A provider failed or admission/deadline prevented a complete lookup."""


def _near(lat: object, lon: object, latitude: object, longitude: object, radius: float) -> bool:
    values = (lat, lon, latitude, longitude)
    if any(type(v) not in (int, float) or not isfinite(v) for v in values):
        return False
    if not (-90 <= lat <= 90 and -90 <= latitude <= 90 and -180 <= lon <= 180 and -180 <= longitude <= 180):
        return False
    h = sin(radians(lat - latitude) / 2) ** 2 + cos(radians(lat)) * cos(radians(latitude)) * sin(radians(lon - longitude) / 2) ** 2
    return 6371 * 2 * asin(sqrt(min(1, h))) <= radius


async def _json(client: httpx.AsyncClient, api: str, **params) -> dict:
    # The URL is always a module constant; returned URLs are never fetched.
    response = await client.get(api, params={"format": "json", "maxlag": 5, **params})
    if response.status_code != 200 or len(response.content) > 2_000_000:
        raise PhotoLookupError("provider_response")
    try:
        data = response.json()
    except ValueError as error:
        raise PhotoLookupError("provider_json") from error
    if not isinstance(data, dict) or "error" in data:
        raise PhotoLookupError("provider_payload")
    return data


def _camera_photo(info: dict) -> bool:
    values = {item.get("name"): item.get("value") for item in info.get("metadata", []) if isinstance(item, dict)}
    return all(isinstance(values.get(key), str) and values[key].strip() for key in ("Make", "Model", "DateTimeOriginal"))


def _file_image(page: object, provider: str) -> CommercialImage | None:
    if not isinstance(page, dict) or page.get("ns") != 6:
        return None
    filename, infos = page.get("title"), page.get("imageinfo")
    if not isinstance(filename, str) or not filename.startswith("File:") or not isinstance(infos, list) or not infos or not isinstance(infos[0], dict):
        return None
    info = infos[0]
    metadata = info.get("extmetadata")
    if not isinstance(metadata, dict) or info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    description = _metadata_text(metadata.get("ImageDescription"))[:6000]
    categories = _metadata_text(metadata.get("Categories"))[:6000]
    if not photo_metadata_safe(description + " " + categories, filename):
        return None
    pd_self = (
        _metadata_text(metadata.get("LicenseShortName")) == "Public domain"
        and _metadata_text(metadata.get("License")) == "pd"
        and _metadata_text(metadata.get("Copyrighted")).casefold() == "false"
        and "PD-self" in categories.split("|")
        and _metadata_text(metadata.get("LicenseUrl")) in {"", PD_SELF_URL}
    )
    license_details = _wikipedia_license(metadata)
    if license_details and license_details[1] == PD_SELF_URL and not pd_self:
        return None
    if license_details is None and pd_self:
        # This exact declared Commons template is a source-backed rights page,
        # not an inferred Creative Commons license for a public domain file.
        license_details = ("Public domain", PD_SELF_URL)
    image_url, source_url = info.get("thumburl") or info.get("url"), info.get("descriptionurl")
    author = _metadata_text(metadata.get("Artist"))
    if not license_details or not author or not _safe_host_url(image_url, WIKIMEDIA_IMAGE_HOSTS) or not _safe_host_url(source_url, {"commons.wikimedia.org"}):
        return None
    source_path = urlparse(source_url).path
    if not source_path.startswith("/wiki/File:") or _file_name(source_path.removeprefix("/wiki/")) != _file_name(filename):
        return None
    return CommercialImage(image_url, author, source_url, *license_details, description, filename, info["mime"], provider, _camera_photo(info))


def _file_coordinates(page: dict, latitude: float, longitude: float) -> bool:
    coords = page.get("coordinates")
    return isinstance(coords, list) and bool(coords) and all(
        isinstance(c, dict) and c.get("globe") == "earth" and _near(c.get("lat"), c.get("lon"), latitude, longitude, .25)
        for c in coords
    )


def _direct_subject(name: str, description: str) -> bool:
    normalized_name, normalized_description = _normalize(name), _normalize(description)
    if normalized_name not in normalized_description:
        return False
    # A nearby camera position and a mention of the venue do not establish the
    # subject of a view *from* it or a different building *near* it.
    return not (
        re.search(re.escape(normalized_name) + r"(?:から|より|付近|の近く|周辺)", normalized_description)
        or re.search(r"(?:from|near|opposite|towards?)\b.{0,80}" + re.escape(name), description, re.I)
    )


async def _commons(client: httpx.AsyncClient, name: str, latitude: float, longitude: float, *, geo: bool) -> CommercialImage | None:
    params = {"action": "query", "formatversion": 2, "prop": "imageinfo|coordinates", "coprimary": "all", "colimit": 10,
              "iiprop": "url|extmetadata|mime|metadata", "iiurlwidth": 800}
    if geo:
        params.update(generator="geosearch", ggscoord=f"{latitude}|{longitude}", ggsradius=250, ggsnamespace=6, ggslimit=20, ggsprimary="all")
    else:
        # Strip search operators: the name is literal untrusted input.
        literal = re.sub(r'["|{}<>\\]', " ", name)[:200]
        params.update(generator="search", gsrsearch=f'"{literal}"', gsrnamespace=6, gsrlimit=10)
    data = await _json(client, COMMONS_API, **params)
    for page in _query_pages(data):
        image = _file_image(page, "commons")
        if image and _file_coordinates(page, latitude, longitude) and _direct_subject(name, image.description) and (image.photo_evidence or definite_place_photo(name, image.description)):
            return image
    return None


def _claims(entity: dict, prop: str):
    claims = entity.get("claims", {})
    if not isinstance(claims, dict) or not isinstance(claims.get(prop, []), list):
        return
    for statement in claims.get(prop, []):
        if not isinstance(statement, dict) or statement.get("rank") == "deprecated":
            continue
        snak = statement.get("mainsnak", {})
        if isinstance(snak, dict) and snak.get("snaktype") == "value" and isinstance(snak.get("datavalue"), dict):
            yield snak["datavalue"].get("value")


def _entity_matches(entity: dict, name: str, latitude: float, longitude: float) -> bool:
    names = []
    labels, aliases = entity.get("labels", {}), entity.get("aliases", {})
    if isinstance(labels, dict):
        names.extend(v.get("value") for v in labels.values() if isinstance(v, dict))
    if isinstance(aliases, dict):
        names.extend(v.get("value") for items in aliases.values() if isinstance(items, list) for v in items if isinstance(v, dict))
    if not any(isinstance(value, str) and _normalize(value) == _normalize(name) for value in names):
        return False
    coordinates = list(_claims(entity, "P625"))
    # Reject conflicting Earth coordinates instead of selecting a convenient one.
    return bool(coordinates) and all(
        isinstance(c, dict) and c.get("globe") in {"http://www.wikidata.org/entity/Q2", "https://www.wikidata.org/entity/Q2"}
        and type(c.get("precision")) in (int, float) and 0 < c["precision"] <= .001
        and _near(c.get("latitude"), c.get("longitude"), latitude, longitude, .5)
        for c in coordinates
    )


async def _wikidata(client: httpx.AsyncClient, name: str, latitude: float, longitude: float) -> CommercialImage | None:
    search = await _json(client, WIKIDATA_API, action="wbsearchentities", search=name[:200], language="ja", type="item", limit=10)
    matches = search.get("search", [])
    if not isinstance(matches, list):
        raise PhotoLookupError("entity_search_payload")
    ids = [v["id"] for v in matches if isinstance(v, dict) and isinstance(v.get("id"), str) and re.fullmatch(r"Q[1-9][0-9]{0,12}", v["id"])][:10]
    if not ids:
        return None
    data = await _json(client, WIKIDATA_API, action="wbgetentities", ids="|".join(ids), props="labels|aliases|claims", languages="ja|en")
    entities = data.get("entities")
    if not isinstance(entities, dict):
        raise PhotoLookupError("entity_payload")
    files = []
    for identifier in ids:
        entity = entities.get(identifier)
        if not isinstance(entity, dict) or entity.get("id") != identifier or not _entity_matches(entity, name, latitude, longitude):
            continue
        for value in _claims(entity, "P18"):
            if isinstance(value, str) and len(value) <= 240 and not any(c in value for c in "|\n\r"):
                files.append("File:" + value)
    files = list(dict.fromkeys(files))[:5]
    if not files:
        return None
    data = await _json(client, COMMONS_API, action="query", formatversion=2, titles="|".join(files), prop="imageinfo|coordinates", coprimary="all", colimit=10, iiprop="url|extmetadata|mime|metadata", iiurlwidth=800)
    expected = {_file_name(v) for v in files}
    for page in _query_pages(data):
        image = _file_image(page, "wikidata")
        if not image or _file_name(image.filename) not in expected:
            continue
        # File GPS, when supplied, must agree with the facility entity too.
        if page.get("coordinates") and not _file_coordinates(page, latitude, longitude):
            continue
        if image.photo_evidence or definite_place_photo(name, image.description):
            return image
    return None


async def _openverse(client: httpx.AsyncClient, name: str, latitude: float, longitude: float) -> CommercialImage | None:
    """Use Openverse for discovery, then verify the original Commons record.

    Openverse's public image schema has no coordinates. Its title, tags and
    indexed license cannot independently prove facility identity or current
    rights. Only Commons originals can currently supply that evidence without
    credentials; other sources deliberately fail closed.
    """
    global _openverse_window, _openverse_used, _openverse_retry_at, _openverse_minute, _openverse_minute_used
    now = monotonic()
    if now - _openverse_window >= 3600:
        _openverse_window, _openverse_used = now, 0
    if now - _openverse_minute >= 60:
        _openverse_minute, _openverse_minute_used = now, 0
    if (now < _openverse_retry_at or _openverse_used >= OPENVERSE_REQUESTS_PER_HOUR
            or _openverse_minute_used >= OPENVERSE_REQUESTS_PER_MINUTE):
        return None
    _openverse_used += 1
    _openverse_minute_used += 1
    response = await client.get(OPENVERSE_API, params={
        "q": name[:200], "source": "wikimedia", "license": "by,by-sa,cc0,pdm",
        "page_size": 10, "mature": "false",
    })
    if response.status_code == 429:
        retry = response.headers.get("Retry-After", "")
        seconds = int(retry) if retry.isascii() and retry.isdigit() and len(retry) <= 8 else 3600
        _openverse_retry_at = monotonic() + max(60, min(seconds, 86400))
        raise PhotoLookupError("openverse_rate_limit")
    if response.status_code != 200 or len(response.content) > 2_000_000:
        raise PhotoLookupError("openverse_response")
    try:
        payload = response.json()
    except ValueError as error:
        raise PhotoLookupError("openverse_json") from error
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        raise PhotoLookupError("openverse_payload")
    files = {}
    pageids = {}
    for item in results[:10]:
        if not isinstance(item, dict) or item.get("source") != "wikimedia" or item.get("mature") is not False:
            continue
        source = item.get("foreign_landing_url")
        if not _safe_host_url(source, {"commons.wikimedia.org"}):
            continue
        parsed = urlparse(source)
        filename = unquote(parsed.path.removeprefix("/wiki/"))
        query = parse_qs(parsed.query)
        pageid = query.get("curid", [""])[0]
        by_id = parsed.path == "/w/index.php" and set(query) == {"curid"} and re.fullmatch(r"[1-9][0-9]{0,12}", pageid)
        by_file = parsed.path.startswith("/wiki/File:") and not parsed.query and len(filename) <= 240 and not any(c in filename for c in "|\r\n")
        if parsed.fragment or not (by_id or by_file):
            continue
        # Require a supported indexed license as well as original rights below.
        license_name = {"by": "CC BY", "by-sa": "CC BY-SA", "cc0": "CC0", "pdm": "Public domain"}.get(item.get("license"))
        if not license_name or not _wikipedia_license({"LicenseShortName": license_name, "LicenseUrl": item.get("license_url")}):
            continue
        license_path = urlparse(item["license_url"]).path.rstrip("/").casefold()
        if by_id:
            pageids[pageid] = license_path
        else:
            files[_file_name(filename)] = license_path
    for field, expected in (("pageids", pageids), ("titles", files)):
        expected = dict(list(expected.items())[:5])
        if not expected:
            continue
        original = await _json(client, COMMONS_API, action="query", formatversion=2, **{field: "|".join(expected)},
                               prop="imageinfo|coordinates", coprimary="all", colimit=10,
                               iiprop="url|extmetadata|mime|metadata", iiurlwidth=800)
        for page in _query_pages(original):
            image = _file_image(page, "openverse")
            if not image:
                continue
            identity = str(page.get("pageid")) if field == "pageids" else _file_name(image.filename)
            if (identity in expected and urlparse(image.license_url).path.rstrip("/").casefold() == expected[identity]
                    and _file_coordinates(page, latitude, longitude) and _direct_subject(name, image.description)
                    and (image.photo_evidence or definite_place_photo(name, image.description))):
                return image
    return None


async def search_verified_place_image(name: str, latitude: float | None, longitude: float | None) -> CommercialImage | None:
    global _active_lookups
    if not name.strip() or not _near(latitude, longitude, latitude, longitude, 0):
        return None
    if _active_lookups >= MAX_ACTIVE_LOOKUPS:
        raise PhotoLookupError("lookup_busy")
    _active_lookups += 1
    tasks = []
    failed = False
    try:
        async with asyncio.timeout(LOOKUP_SECONDS), httpx.AsyncClient(
            timeout=provider_timeout(LOOKUP_SECONDS), headers={"User-Agent": WIKIMEDIA_USER_AGENT},
            verify=ssl.create_default_context(), trust_env=False, follow_redirects=False,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=4),
        ) as client:
            tasks = [asyncio.create_task(call) for call in (
                _search_wikipedia(client, name, latitude, longitude, strict_errors=True),
                _commons(client, name, latitude, longitude, geo=False),
                _commons(client, name, latitude, longitude, geo=True),
                _wikidata(client, name, latitude, longitude),
                _openverse(client, name, latitude, longitude),
            )]
            for completed in asyncio.as_completed(tasks):
                try:
                    result = await completed
                    if result is not None:
                        return result
                except (httpx.HTTPError, ValueError, TypeError, KeyError):
                    failed = True
    except (httpx.HTTPError, TimeoutError) as error:
        raise PhotoLookupError("lookup_deadline") from error
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        _active_lookups -= 1
    if failed:
        raise PhotoLookupError("provider_failed")
    return None
