import logging
import os
from pathlib import Path
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv

PIXABAY_API_URL = "https://pixabay.com/api/"
PIXABAY_TIMEOUT_SECONDS = 4.0
logger = logging.getLogger(__name__)


async def search_pixabay_image(query: str) -> str | None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    api_key = os.getenv("PIXABAY_API_KEY", "").strip()
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=PIXABAY_TIMEOUT_SECONDS) as client:
            response = await client.get(
                PIXABAY_API_URL,
                params={
                    "key": api_key,
                    "q": query[:100],
                    "image_type": "photo",
                    "orientation": "horizontal",
                    "safesearch": "true",
                    "per_page": 5,
                },
            )
    except httpx.HTTPError as error:
        logger.warning("Pixabay image search failed: %s", type(error).__name__)
        return None

    if response.status_code >= 400:
        logger.warning("Pixabay image search returned HTTP %d", response.status_code)
        return None

    try:
        payload = response.json()
    except ValueError:
        logger.warning("Pixabay image search returned invalid JSON")
        return None

    if not isinstance(payload, dict) or not isinstance(payload.get("hits"), list):
        return None

    for hit in payload["hits"]:
        if not isinstance(hit, dict):
            continue
        for field in ("largeImageURL", "webformatURL"):
            image_url = hit.get(field)
            if isinstance(image_url, str) and urlparse(image_url).scheme == "https":
                return image_url
    return None
