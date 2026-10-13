"""On-demand Google photos. No Google content or photo names are cached/stored."""
import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import sqlite3
import ssl
import unicodedata
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field
from app.models import Place, Origin
from app.discovery import distance_km

BASE = "https://places.googleapis.com/v1"
QUOTA_DB = Path(os.getenv("GOOGLE_PHOTO_QUOTA_PATH", str(Path(__file__).resolve().parents[1] / "data" / "google_photo_quota.sqlite3")))


class PhotoAuthor(BaseModel):
    name: str
    url: str


class GooglePhoto(BaseModel):
    status: str = "unavailable"
    place_id: str | None = None
    image_url: str | None = None
    source_url: str | None = None
    authors: list[PhotoAuthor] = Field(default_factory=list)
    note: str = "一致する施設写真を取得できませんでした。"


def safe_url(value, image=False):
    if not isinstance(value, str) or len(value) > 8192:
        return None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        valid = (host.endswith(".googleusercontent.com") or host == "googleusercontent.com") if image else host in {"www.google.com", "google.com", "maps.google.com", "maps.app.goo.gl"}
        return value if url.scheme == "https" and valid and not url.username and not url.password and not url.port and "key=" not in url.query.lower() else None
    except ValueError:
        return None


def reserve_lookup():
    """Persist counters only; a restart cannot reset this local monthly ceiling."""
    try:
        limit = min(10000, max(0, int(os.getenv("GOOGLE_PLACES_MONTHLY_LIMIT", "300"))))
        QUOTA_DB.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(QUOTA_DB, timeout=1)
        try:
            with db:
                db.execute("CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, used INTEGER NOT NULL)")
                db.execute("BEGIN IMMEDIATE")
                month = datetime.now(timezone.utc).strftime("%Y-%m")
                db.execute("INSERT OR IGNORE INTO usage VALUES (?,0)", (month,))
                return db.execute("UPDATE usage SET used=used+1 WHERE month=? AND used<?", (month, limit)).rowcount == 1
        finally:
            db.close()
    except (ValueError, OSError, sqlite3.Error):
        return False


def normalized(name):
    return re.sub(r"[\s・･]", "", unicodedata.normalize("NFKC", name)).casefold()


async def fetch_google_photo(place: Place):
    key = os.getenv("GOOGLE_PLACES_API_KEY", "").strip()
    if not key:
        return GooglePhoto(note="Google Places Photosは未設定です。")
    if not reserve_lookup():
        return GooglePhoto(note="Google写真の利用上限に達したか、利用回数を確認できませんでした。")
    try:
        async with asyncio.timeout(8), httpx.AsyncClient(timeout=6, follow_redirects=False, trust_env=False, verify=ssl.create_default_context()) as client:
            response = await client.post(BASE + "/places:searchText", headers={"X-Goog-Api-Key":key,
                "X-Goog-FieldMask":"places.id,places.displayName,places.location,places.photos,places.googleMapsUri"},
                json={"textQuery":place.name + " " + (place.address or ""), "languageCode":"ja", "pageSize":3,
                      "locationBias":{"circle":{"center":{"latitude":place.latitude,"longitude":place.longitude},"radius":500.0}}})
            if response.status_code != 200:
                return GooglePhoto()
            matches = []
            for candidate in response.json().get("places", [])[:3]:
                if normalized(candidate.get("displayName", {}).get("text", "")) != normalized(place.name):
                    continue
                location = Origin(name=place.name, **candidate["location"])
                if distance_km(place, location) <= .3 and candidate.get("photos"):
                    matches.append(candidate)
            # Ambiguous same-name branches are not interchangeable.
            if len(matches) != 1:
                return GooglePhoto()
            candidate = matches[0]
            photo = candidate["photos"][0]
            name = photo.get("name", "")
            if not re.fullmatch(r"places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+", name) or name.split("/")[1] != candidate["id"]:
                return GooglePhoto()
            source = safe_url(photo.get("googleMapsUri")) or safe_url(candidate.get("googleMapsUri"))
            if not source:
                return GooglePhoto()
            authors = []
            for author in photo.get("authorAttributions", []):
                url = safe_url(author.get("uri"))
                if not url or not isinstance(author.get("displayName"), str):
                    return GooglePhoto()
                authors.append(PhotoAuthor(name=author["displayName"], url=url))
            media = await client.get(BASE + "/" + name + "/media", headers={"X-Goog-Api-Key":key},
                                     params={"maxWidthPx":1000,"skipHttpRedirect":"true"})
            if media.status_code != 200:
                return GooglePhoto()
            image = safe_url(media.json().get("photoUri"), image=True)
            if not image:
                return GooglePhoto()
            return GooglePhoto(status="ready",place_id=place.id,image_url=image,source_url=source,authors=authors,
                               note="施設名と位置を照合したGoogle Mapsの写真です。")
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        return GooglePhoto()
