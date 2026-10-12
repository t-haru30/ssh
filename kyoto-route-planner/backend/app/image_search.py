import asyncio
import logging
import re
import ssl
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import unquote, urlparse
import unicodedata
from math import asin, cos, isfinite, radians, sin, sqrt

import httpx

from app.cache import TTLCache
from app.http_client import provider_timeout, request_with_retry

WIKIPEDIA_API_URL = "https://ja.wikipedia.org/w/api.php"
WIKIMEDIA_USER_AGENT = "ConcierGO/1.0 (https://github.com/t-haru30/ssh)"
WIKIMEDIA_IMAGE_HOSTS = {"upload.wikimedia.org", "thumb.wikimedia.org"}
IMAGE_SEARCH_TIMEOUT_SECONDS = 6.0
IMAGE_SEARCH_CACHE_TTL_SECONDS = 21600.0
_image_cache: TTLCache[str, "CommercialImage | None"] = TTLCache(
    ttl_seconds=IMAGE_SEARCH_CACHE_TTL_SECONDS,
    max_entries=512,
)
logger = logging.getLogger(__name__)
_negative_cache = TTLCache(ttl_seconds=60, max_entries=512)


@dataclass(frozen=True)
class CommercialImage:
    image_url: str
    author_name: str
    source_url: str
    license_name: str
    license_url: str
    description: str = field(default="", compare=False)
    filename: str = field(default="", compare=False)
    mime: str = field(default="", compare=False)


def _normalize(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def _safe_host_url(value: object, hosts: set[str]) -> bool:
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value) or "\\" in value:
        return False
    try:
        parsed = urlparse(value)
        return parsed.scheme == "https" and parsed.hostname in hosts and not parsed.username and not parsed.password and parsed.port in (None, 443)
    except ValueError:
        return False


def _file_name(value: str) -> str:
    value = unicodedata.normalize("NFC", unquote(value).replace("_", " "))
    # Japanese Wikipedia localizes the namespace of an English File: request.
    # Normalize only the namespace; keep the actual filename case-sensitive.
    return re.sub(r"^(?:ファイル|画像|Image|File):", "File:", value)


def photo_metadata_safe(description: str, filename: str) -> bool:
    text = unicodedata.normalize("NFKC", description + " " + filename).casefold()
    forbidden = ("logo", "locator", "portrait", "illustration", "drawing", "painting", "rendering", "ai-generated", "ai generated", "地図", "ロゴ", "肖像", "イラスト", "絵画", "想像図", "生成画像", "鳥瞰図", ".svg", ".gif")
    return bool(description.strip()) and not any(word in text for word in forbidden) and not re.search(r"\bmap\b|\bdiagram\b|\bsketch\b", text)


def definite_place_photo(name: str, description: str) -> bool:
    """Conservative fallback; metadata alone cannot establish visual authenticity."""
    return _normalize(name) in _normalize(description) and bool(re.search(r"写真|撮影|photo(?:graph)?|view|外観|本堂|境内|建物|庭園|景観|入口|展示室|interior|exterior|building|landscape", description, re.I))


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
    try:
        parsed_license = urlparse(license_url)
        if parsed_license.username or parsed_license.password or parsed_license.query or parsed_license.fragment or parsed_license.port not in (None, 80 if parsed_license.scheme == "http" else 443):
            return None
    except ValueError:
        return None
    if parsed_license.scheme == "http" and parsed_license.hostname in {"creativecommons.org", "www.creativecommons.org"} and not parsed_license.username and not parsed_license.password and parsed_license.port in (None, 80):
        license_url = "https://" + parsed_license.hostname + parsed_license.path
        parsed_license = urlparse(license_url)
    if parsed_license.scheme != "https" or parsed_license.hostname not in {"creativecommons.org", "www.creativecommons.org"}:
        return None
    normalized_url = parsed_license.path.casefold()
    normalized_name = short_name.casefold()
    if re.fullmatch(r"/licenses/by-sa/\d+(?:\.\d+)?(?:/[a-z-]+)?/?", normalized_url) and normalized_name.startswith("cc by-sa"):
        return short_name, license_url
    if re.fullmatch(r"/licenses/by/\d+(?:\.\d+)?(?:/[a-z-]+)?/?", normalized_url) and normalized_name.startswith("cc by") and "nc" not in normalized_name and "nd" not in normalized_name:
        return short_name, license_url
    if (
        re.fullmatch(r"/publicdomain/(?:zero|mark)/\d+(?:\.\d+)?/?", normalized_url)
        and ("public domain" in normalized_name or normalized_name in {"cc0", "cc0 1.0", "pd", "pdm 1.0"})
    ):
        return short_name or "Public domain", license_url
    return None


async def _search_wikipedia(client: httpx.AsyncClient, query: str, latitude: float | None, longitude: float | None) -> CommercialImage | None:
    response = await request_with_retry(
        client,
        "GET",
        WIKIPEDIA_API_URL,
        attempts=1,
        params={
            "action": "query",
            "titles": query[:200],
            "prop": "pageimages|coordinates",
            "coprimary": "primary",
            "colimit": 1,
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
        and _matches_place(page, query, latitude, longitude)
    ]
    if not page_images:
        return None

    image_response = await request_with_retry(
        client,
        "GET",
        WIKIPEDIA_API_URL,
        attempts=1,
        params={
            "action": "query",
            "prop": "imageinfo",
            "titles": "|".join(f"File:{page_image}" for page_image in page_images),
            "iiprop": "url|extmetadata|mime",
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
        filename = image_page.get("title")
        expected_files = {_file_name("File:" + value) for value in page_images}
        if not isinstance(filename, str) or _file_name(filename) not in expected_files:
            continue
        if info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}:
            continue
        metadata = info.get("extmetadata")
        if not isinstance(metadata, dict):
            continue
        description = _metadata_text(metadata.get("ImageDescription"))[:6000]
        if not photo_metadata_safe(description, filename):
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
            or not _safe_host_url(image_url, WIKIMEDIA_IMAGE_HOSTS)
            or not _safe_host_url(source_url, {"ja.wikipedia.org", "commons.wikimedia.org"})
            or not author_name
            or not license_details[0]
            or not _is_https_url(license_details[1])
        ):
            continue
        if _file_name(urlparse(source_url).path.removeprefix("/wiki/")) != _file_name(filename):
            continue
        return CommercialImage(
            image_url=image_url,
            author_name=author_name,
            source_url=source_url,
            license_name=license_details[0],
            license_url=license_details[1],
            description=description,
            filename=filename,
            mime=info["mime"],
        )
    return None


def _matches_place(page: dict, name: str, latitude: float | None, longitude: float | None) -> bool:
    if not isinstance(page.get("title"), str) or _normalize(page["title"]) != _normalize(name):
        return False
    if latitude is None or longitude is None:
        return False
    coordinates = page.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates or not isinstance(coordinates[0], dict):
        return False
    lat, lon = coordinates[0].get("lat"), coordinates[0].get("lon")
    if type(lat) not in (float, int) or type(lon) not in (float, int) or type(latitude) not in (float, int) or type(longitude) not in (float, int):
        return False
    if not all(isfinite(value) for value in (lat, lon, latitude, longitude)) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return False
    h = sin(radians(lat - latitude) / 2) ** 2 + cos(radians(lat)) * cos(radians(latitude)) * sin(radians(lon - longitude) / 2) ** 2
    return 6371 * 2 * asin(sqrt(min(1, h))) <= 0.5


async def search_commercial_image(query: str, latitude: float | None = None, longitude: float | None = None) -> CommercialImage | None:
    normalized_query = " ".join(query.casefold().split())[:200]
    if not normalized_query:
        return None
    cache_key = f"{normalized_query}:{latitude}:{longitude}"
    cache_hit, cached_image = _image_cache.get(cache_key)
    if cache_hit:
        return cached_image
    if _negative_cache.get(cache_key)[0]:
        return None

    try:
        async with asyncio.timeout(IMAGE_SEARCH_TIMEOUT_SECONDS), httpx.AsyncClient(
            timeout=provider_timeout(IMAGE_SEARCH_TIMEOUT_SECONDS),
            headers={"User-Agent": WIKIMEDIA_USER_AGENT},
            verify=ssl.create_default_context(),
            trust_env=False,
            follow_redirects=False,
        ) as client:
            try:
                image = await _search_wikipedia(client, normalized_query, latitude, longitude)
            except httpx.HTTPError as error:
                logger.warning("Wikipedia image search failed: %s", type(error).__name__)
                image = None
    except (httpx.HTTPError, TimeoutError) as error:
        logger.warning("Commercial image search failed: %s", type(error).__name__)
        return None

    if image is not None:
        _image_cache.set(cache_key, image)
    else:
        _negative_cache.set(cache_key, True)
    return image
