"""Optional, attributed facility introductions from a single public Wikipedia query."""

import asyncio
import logging
from math import isfinite
import unicodedata
from urllib.parse import quote

import httpx
from pydantic import BaseModel

from app.cache import TTLCache
from app.http_client import provider_timeout
from app.image_search import WIKIPEDIA_API_URL, WIKIMEDIA_USER_AGENT, _matches_place, _metadata_text, _query_pages
from app.models import Place
from app.official_place_info import OfficialPlaceInfo, fetch_official_place_info

DESCRIPTION_TIMEOUT_SECONDS = 6.0
DESCRIPTION_TOTAL_TIMEOUT_SECONDS = 15.0
DESCRIPTION_CACHE_TTL_SECONDS = 24 * 60 * 60
DESCRIPTION_MAX_CHARS = 500
_description_cache: TTLCache[tuple[str, float, float], "PlaceDescription"] = TTLCache(
    ttl_seconds=DESCRIPTION_CACHE_TTL_SECONDS, max_entries=2048,
)
logger = logging.getLogger(__name__)


class PlaceDescription(BaseModel):
    description: str | None = None
    source_url: str | None = None
    source_title: str | None = None
    license_name: str | None = None
    license_url: str | None = None
    note: str
    official: OfficialPlaceInfo | None = None


def _normalize_title(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).replace("_", " ").casefold().split())


def _resolved_title(payload: dict, name: str) -> str:
    """Follow only the API's explicit redirect chain, never search results or aliases."""
    title = _normalize_title(name)
    redirects = payload.get("query", {}).get("redirects", [])
    if not isinstance(redirects, list):
        return ""
    visited: set[str] = set()
    for _ in range(len(redirects) + 1):
        if title in visited:
            return ""
        visited.add(title)
        redirect = next((r for r in redirects if isinstance(r, dict)
                         and isinstance(r.get("from"), str) and _normalize_title(r["from"]) == title), None)
        if redirect is None:
            return title
        if redirect.get("tofragment") or not isinstance(redirect.get("to"), str):
            return ""
        title = _normalize_title(redirect["to"])
    return ""


def _extract_description(payload: object, place: Place) -> PlaceDescription:
    unavailable = PlaceDescription(note="名称と位置が一致するWikipediaの施設説明を確認できませんでした。")
    if not isinstance(payload, dict) or not isinstance(payload.get("query"), dict):
        return unavailable
    pages = _query_pages(payload)
    if len(pages) != 1 or not isinstance(pages[0], dict):
        return unavailable
    page = pages[0]
    title = page.get("title")
    if (not isinstance(title, str) or not title or page.get("ns") != 0
            or "missing" in page or "invalid" in page or "redirect" in page
            or not isinstance(page.get("pageid"), int) or page["pageid"] <= 0):
        return unavailable
    properties = page.get("pageprops", {})
    if not isinstance(properties, dict) or "disambiguation" in properties:
        return unavailable
    if _normalize_title(title) != _resolved_title(payload, place.name):
        return unavailable
    coordinates = page.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) != 1 or not isinstance(coordinates[0], dict):
        return unavailable
    coordinate = coordinates[0]
    lat, lon = coordinate.get("lat"), coordinate.get("lon")
    if (type(lat) not in (float, int) or type(lon) not in (float, int)
            or not isfinite(lat) or not isfinite(lon) or abs(lat) > 90 or abs(lon) > 180
            or coordinate.get("globe", "earth") != "earth"):
        return unavailable
    # The shared image identity helper checks the same 500 m bound. The name
    # has already been checked against either the exact title or a redirect.
    if not _matches_place(page, title, place.latitude, place.longitude):
        return unavailable
    extract = page.get("extract")
    if not isinstance(extract, str):
        return unavailable
    text = _metadata_text(extract)
    if not text:
        return unavailable
    description = text[:DESCRIPTION_MAX_CHARS]
    if len(text) > DESCRIPTION_MAX_CHARS:
        sentence = description.rfind("。", 299)
        if sentence >= 299:
            description = description[:sentence + 1]
    return PlaceDescription(
        description=description,
        source_url=f"https://ja.wikipedia.org/wiki/{quote(title.replace(' ', '_'), safe='')}",
        source_title=title,
        license_name="CC BY-SA 4.0",
        license_url="https://creativecommons.org/licenses/by-sa/4.0/",
        note="Wikipediaの寄稿者による記事の冒頭を抜粋しています。営業時間や料金などの最新情報は施設の公式案内をご確認ください。",
    )


async def _fetch_wikipedia_description(place: Place) -> PlaceDescription:
    name = place.name.strip()
    key = (_normalize_title(name), place.latitude, place.longitude)
    hit, cached = _description_cache.get(key)
    if hit and cached is not None:
        return cached
    unavailable = PlaceDescription(note="Wikipediaの施設説明を取得できませんでした。時間をおいてご確認ください。")
    # Pipes request multiple titles and fragments refer to sections, not facilities.
    if not name or any(c in name for c in "|#\r\n"):
        return PlaceDescription(note="施設名に対応するWikipediaの記事を確認できませんでした。")
    try:
        async with asyncio.timeout(DESCRIPTION_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                timeout=provider_timeout(DESCRIPTION_TIMEOUT_SECONDS),
                headers={"User-Agent": WIKIMEDIA_USER_AGENT}, follow_redirects=False,
            ) as client:
                # Deliberately no request_with_retry: at most one outbound call per click.
                response = await client.get(WIKIPEDIA_API_URL, params={
                    "action": "query", "titles": name, "redirects": 1,
                    "prop": "extracts|coordinates|pageprops", "ppprop": "disambiguation",
                    "coprimary": "primary", "colimit": 1,
                    "exintro": 1, "explaintext": 1, "exchars": DESCRIPTION_MAX_CHARS, "exlimit": 1,
                    "maxlag": 5, "format": "json", "formatversion": 2,
                })
                if response.status_code != 200:
                    return unavailable
                payload = response.json()
                # API-level errors (e.g. maxlag) can arrive with HTTP 200.
                # Malformed responses are not evidence of a missing facility.
                if (not isinstance(payload, dict) or "error" in payload
                        or not isinstance(payload.get("query"), dict)):
                    return unavailable
                pages = _query_pages(payload)
                if (len(pages) != 1 or not isinstance(pages[0], dict)
                        or not isinstance(pages[0].get("title"), str)):
                    return unavailable
                page = pages[0]
                if ("missing" not in page and "invalid" not in page
                        and (type(page.get("pageid")) is not int or page["pageid"] <= 0
                             or type(page.get("ns")) is not int)):
                    return unavailable
                result = _extract_description(payload, place)
    except (httpx.HTTPError, TimeoutError, ValueError):
        logger.info("Wikipedia facility description unavailable")
        return unavailable
    _description_cache.set(key, result)
    return result


async def fetch_place_description(place: Place) -> PlaceDescription:
    """Keep provider caches separate and preserve a completed result on timeout."""
    wikipedia_task = asyncio.create_task(_fetch_wikipedia_description(place))
    official_task = asyncio.create_task(fetch_official_place_info(place))
    try:
        async with asyncio.timeout(DESCRIPTION_TOTAL_TIMEOUT_SECONDS):
            await asyncio.gather(wikipedia_task, official_task, return_exceptions=True)
    except TimeoutError:
        logger.info("Facility information deadline reached")

    def completed(task: asyncio.Task):
        if task.cancelled() or not task.done() or task.exception() is not None:
            return None
        return task.result()

    wikipedia = completed(wikipedia_task)
    official = completed(official_task)
    if not isinstance(wikipedia, PlaceDescription):
        wikipedia = PlaceDescription(note="Wikipediaの施設説明を取得できませんでした。時間をおいてご確認ください。")
    return wikipedia.model_copy(update={"official": official if isinstance(official, OfficialPlaceInfo) else None})
