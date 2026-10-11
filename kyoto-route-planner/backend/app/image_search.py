import logging
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from app.cache import TTLCache
from app.http_client import provider_timeout, request_with_retry

WIKIPEDIA_API_URL = "https://ja.wikipedia.org/w/api.php"
WIKIMEDIA_USER_AGENT = "KyotoYorimichiRoute/1.0 (https://github.com/t-haru30/ssh)"
IMAGE_SEARCH_TIMEOUT_SECONDS = 4.0
IMAGE_SEARCH_CACHE_TTL_SECONDS = 300.0
_image_cache: TTLCache[str, "CommercialImage | None"] = TTLCache(
    ttl_seconds=IMAGE_SEARCH_CACHE_TTL_SECONDS,
    max_entries=512,
)
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CommercialImage:
    image_url: str
    author_name: str
    source_url: str
    license_name: str
    license_url: str


class _VisibleTextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if text:
            self.parts.append(text)


def _metadata_text(value: object) -> str:
    if isinstance(value, dict):
        value = value.get("value")
    if not isinstance(value, str):
        return ""
    parser = _VisibleTextParser()
    try:
        parser.feed(value)
        parser.close()
    except ValueError:
        return ""
    return " ".join(" ".join(parser.parts).split())


def _is_https_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def _query_pages(payload: object) -> list[object]:
    if not isinstance(payload, dict):
        return []
    query = payload.get("query")
    if not isinstance(query, dict):
        return []
    pages = query.get("pages", [])
    if isinstance(pages, dict):
        return list(pages.values())
    return pages if isinstance(pages, list) else []


def _wikipedia_license(metadata: dict) -> tuple[str, str] | None:
    short_name = _metadata_text(metadata.get("LicenseShortName"))
    license_url = _metadata_text(metadata.get("LicenseUrl"))
    normalized_url = license_url.casefold()
    normalized_name = short_name.casefold()
    if "creativecommons.org/licenses/by-sa/" in normalized_url:
        return short_name, license_url
    if "creativecommons.org/licenses/by/" in normalized_url:
        return short_name, license_url
    if (
        "creativecommons.org/publicdomain/zero/" in normalized_url
        or "creativecommons.org/publicdomain/mark/" in normalized_url
        or "public domain" in normalized_name
    ):
        return short_name or "Public domain", license_url
    return None


async def _search_wikipedia(client: httpx.AsyncClient, query: str) -> CommercialImage | None:
    response = await request_with_retry(
        client,
        "GET",
        WIKIPEDIA_API_URL,
        params={
            "action": "query",
            "generator": "search",
            "gsrsearch": query[:200],
            "gsrnamespace": 0,
            "gsrlimit": 5,
            "prop": "pageimages",
            "piprop": "thumbnail|name",
            "pithumbsize": 800,
            "pilicense": "free",
            "maxlag": 5,
            "format": "json",
            "formatversion": 2,
        },
    )
    if response.status_code >= 400:
        logger.warning(
            "Wikipedia image search returned HTTP %d (server=%s); check Wikimedia's "
            "robot policy and whether the outbound network permits this API",
            response.status_code,
            response.headers.get("server", "unknown"),
        )
        return None
    try:
        payload = response.json()
    except ValueError:
        logger.warning("Wikipedia image search returned invalid JSON")
        return None
    page_images = [
        page["pageimage"]
        for page in _query_pages(payload)
        if isinstance(page, dict)
        and isinstance(page.get("pageimage"), str)
        and page["pageimage"]
    ]
    if not page_images:
        return None

    image_response = await request_with_retry(
        client,
        "GET",
        WIKIPEDIA_API_URL,
        params={
            "action": "query",
            "prop": "imageinfo",
            "titles": "|".join(f"File:{page_image}" for page_image in page_images),
            "iiprop": "url|extmetadata",
            "iiurlwidth": 800,
            "maxlag": 5,
            "format": "json",
            "formatversion": 2,
        },
    )
    if image_response.status_code >= 400:
        logger.warning(
            "Wikipedia image metadata lookup returned HTTP %d (server=%s)",
            image_response.status_code,
            image_response.headers.get("server", "unknown"),
        )
        return None
    try:
        image_payload = image_response.json()
    except ValueError:
        logger.warning("Wikipedia image metadata lookup returned invalid JSON")
        return None
    for image_page in _query_pages(image_payload):
        if not isinstance(image_page, dict):
            continue
        image_info = image_page.get("imageinfo")
        if not isinstance(image_info, list) or not image_info or not isinstance(image_info[0], dict):
            continue
        info = image_info[0]
        metadata = info.get("extmetadata")
        if not isinstance(metadata, dict):
            continue
        license_details = _wikipedia_license(metadata)
        image_url = info.get("thumburl") or info.get("url")
        source_url = info.get("descriptionurl")
        author_name = (
            _metadata_text(metadata.get("Artist"))
            or _metadata_text(metadata.get("Credit"))
        )
        if (
            license_details is None
            or not _is_https_url(image_url)
            or not _is_https_url(source_url)
            or not author_name
            or not license_details[0]
            or not _is_https_url(license_details[1])
        ):
            continue
        return CommercialImage(
            image_url=image_url,
            author_name=author_name,
            source_url=source_url,
            license_name=license_details[0],
            license_url=license_details[1],
        )
    return None


async def search_commercial_image(query: str) -> CommercialImage | None:
    normalized_query = " ".join(query.casefold().split())[:200]
    if not normalized_query:
        return None
    cache_hit, cached_image = _image_cache.get(normalized_query)
    if cache_hit:
        return cached_image

    try:
        async with httpx.AsyncClient(
            timeout=provider_timeout(IMAGE_SEARCH_TIMEOUT_SECONDS),
            headers={"User-Agent": WIKIMEDIA_USER_AGENT},
        ) as client:
            try:
                image = await _search_wikipedia(client, normalized_query)
            except httpx.HTTPError as error:
                logger.warning("Wikipedia image search failed: %s", type(error).__name__)
                image = None
    except httpx.HTTPError as error:
        logger.warning("Commercial image search failed: %s", type(error).__name__)
        return None

    _image_cache.set(normalized_query, image)
    return image
