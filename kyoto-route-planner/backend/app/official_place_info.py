"""Conservative, bounded official-site information; never infer missing facts."""

import asyncio
from datetime import datetime, timezone
from html.parser import HTMLParser
import ipaddress
import json
from math import asin, cos, isfinite, radians, sin, sqrt
from pathlib import Path
import re
import socket
import ssl
from typing import Literal
import unicodedata
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, Field

from app.cache import TTLCache
from app.models import Place

MAX_BODY_BYTES = 512 * 1024
REQUEST_TIMEOUT_SECONDS = 8.0
TOTAL_TIMEOUT_SECONDS = 12.0
MAX_FETCHES = 4  # OSM + legacy-domain redirect + official home + visitor guide.
SEED_PATH = Path(__file__).with_name("data") / "official_place_sources.json"
_cache: TTLCache[tuple, "OfficialPlaceInfo"] = TTLCache(6 * 60 * 60, 1024)


class OfficialPlaceInfo(BaseModel):
    url: str | None = None
    title: str | None = None
    description: str | None = None
    description_source_url: str | None = None
    highlights: list[str] = Field(default_factory=list)
    opening_hours: str | None = None
    closed_days: str | None = None
    admission: str | None = None
    checked_at: str | None = None
    status: Literal["verified", "link_only", "unavailable"] = "unavailable"
    note: str


class UnsafeURL(ValueError):
    pass


class FetchFailure(ValueError):
    pass


def _normalize(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def _nearby(place: Place, latitude, longitude) -> bool:
    if type(latitude) not in (int, float) or type(longitude) not in (int, float):
        return False
    if not isfinite(latitude) or not isfinite(longitude) or abs(latitude) > 90 or abs(longitude) > 180:
        return False
    h = sin(radians(latitude - place.latitude) / 2) ** 2 + cos(radians(latitude)) * cos(radians(place.latitude)) * sin(radians(longitude - place.longitude) / 2) ** 2
    return 6371000 * 2 * asin(sqrt(min(1, h))) <= 500


def _basic_url(url: str) -> str:
    if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise UnsafeURL("Invalid URL")
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise UnsafeURL("Only public HTTP(S) URLs are allowed")
        if parts.port not in {None, 80, 443}:
            raise UnsafeURL("Unexpected port")
        host = parts.hostname.rstrip(".").casefold()
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")) or "%" in host or "\\" in url:
            raise UnsafeURL("Non-public host")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            if not address.is_global:
                raise UnsafeURL("Non-public address")
        return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))
    except ValueError as error:
        raise UnsafeURL("Invalid URL") from error


async def _resolve_public(url: str) -> tuple[str, str]:
    url = _basic_url(url)
    parts = urlsplit(url)
    answers = await asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
    addresses = {answer[4][0] for answer in answers}
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise UnsafeURL("DNS returned a non-public address")
    return url, sorted(addresses, key=lambda address: (ipaddress.ip_address(address).version != 4, address))[0]


async def _fetch_url(url: str) -> tuple[int, dict[str, str], bytes]:
    """Pin the validated address so HTTP cannot resolve a second, private address."""
    url, address = await _resolve_public(url)
    original = httpx.URL(url)
    pinned = original.copy_with(host=address)
    headers = {"Host": original.netloc.decode("ascii"), "User-Agent": "ConcierGO/1.0 (official facility information)", "Accept": "text/html,application/json;q=0.9"}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False, trust_env=False, verify=ssl.create_default_context()) as client:
        async with client.stream("GET", pinned, headers=headers, extensions={"sni_hostname": original.host}) as response:
            try:
                length = int(response.headers.get("content-length", "0"))
            except ValueError:
                length = 0
            if length > MAX_BODY_BYTES:
                raise FetchFailure("Response too large")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BODY_BYTES:
                    raise FetchFailure("Response too large")
            return response.status_code, dict(response.headers), bytes(body)


def _seed_entry(place: Place) -> dict | None:
    try:
        payload = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        entries = payload.get("places", []) if payload.get("version") == 1 else []
        for entry in entries:
            if isinstance(entry, dict) and entry.get("id") == place.id and isinstance(entry.get("name"), str) and _normalize(entry["name"]) == _normalize(place.name) and _nearby(place, entry.get("latitude"), entry.get("longitude")):
                return {**entry, "url": _basic_url(entry.get("url"))}
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None


def _osm_url(payload: object, place: Place, kind: str, identifier: int) -> str | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        return None
    for element in payload["elements"]:
        if not isinstance(element, dict) or element.get("type") != kind or element.get("id") != identifier:
            continue
        tags = element.get("tags")
        if not isinstance(tags, dict) or not any(isinstance(tags.get(key), str) and _normalize(tags[key]) == _normalize(place.name) for key in ("name", "name:ja", "official_name")):
            continue
        # Standard way/relation responses often omit their geometry. Do not
        # spend extra calls or trust a name without verifiable coordinates.
        center = element.get("center", element)
        if not isinstance(center, dict) or not _nearby(place, center.get("lat"), center.get("lon")):
            continue
        for key in ("website", "contact:website"):
            if tags.get(key):
                return _basic_url(tags[key])
    return None


class _PageText(HTMLParser):
    IGNORED = {"script", "style", "nav", "footer", "header", "noscript", "template", "svg"}
    BREAKS = {"p", "div", "section", "article", "li", "dt", "dd", "tr", "br", "h1", "h2", "h3", "h4"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self.meta = ""
        self.ignored: list[str] = []
        self.in_title = False
        self.links: list[tuple[str, str]] = []
        self.anchor: tuple[str, list[str]] | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and attrs.get("href"):
            self.anchor = (attrs["href"], [])
        if tag == "img" and self.anchor and attrs.get("alt"):
            self.anchor[1].append(attrs["alt"])
        if tag in self.IGNORED:
            self.ignored.append(tag)
        if self.ignored:
            return
        if tag == "title":
            self.in_title = True
        if tag == "meta" and (attrs.get("name", "").casefold() == "description" or attrs.get("property", "").casefold() == "og:description"):
            self.meta = attrs.get("content", "")
        if tag in self.BREAKS:
            self.parts.append("\n")
        if tag == "img" and attrs.get("alt"):
            self.parts.append(attrs["alt"] + " ")
        if tag in {"td", "th"}:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor:
            self.links.append((self.anchor[0], "".join(self.anchor[1])))
            self.anchor = None
        if self.ignored:
            if tag == self.ignored[-1]:
                self.ignored.pop()
            return
        if tag == "title":
            self.in_title = False
        if tag in self.BREAKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.anchor:
            self.anchor[1].append(data)
        if not self.ignored:
            if self.in_title:
                self.title_parts.append(data)
            else:
                self.parts.append(data)


def _field(lines: list[str], labels: tuple[str, ...]) -> str | None:
    groups = (("開館時間", "営業時間", "入館受付", "開園時間", "拝観時間", "参拝時間", "最終入館", "受付時間"), ("休館日", "休業日", "定休日", "休園日"), ("観覧料", "入館料", "入場料", "拝観料", "利用料金", "料金"))
    other_labels = [label for group in groups if group != labels for label in group]
    patterns = {
        "開館時間": r"\d{1,2}\s*(?::\d{2}|時)",
        "休館日": r"[月火水木金土日]曜|年末|年始|祝日|無休|不定休|臨時休館|展示替|\d+月\d+日|ありません|なし",
        "観覧料": r"\d[\d,]*\s*円|無料",
    }
    for index, line in enumerate(lines):
        if not any(label in line for label in labels):
            continue
        pieces = [line]
        for next_line in lines[index + 1:index + 11]:
            if any(label in next_line for label in other_labels) or re.match(r"(?:アクセス|所在地|交通案内|地図情報|この記事について|お問い合わせ)", next_line):
                break
            pieces.append(next_line)
            if len(" ".join(pieces)) >= 300:
                break
        value = " ".join(pieces).strip()[:300]
        if re.search(patterns[labels[0]], unicodedata.normalize("NFKC", value)):
            return value
    return None


def _extract_page(body: bytes, headers: dict, url: str, place: Place, guides: list[str] | None = None) -> OfficialPlaceInfo:
    content_type = headers.get("content-type", "")
    if "text/html" not in content_type.casefold() and "application/xhtml+xml" not in content_type.casefold():
        raise FetchFailure("Not an HTML page")
    encoding_match = re.search(r"charset=[\"']?([\w-]+)", content_type, re.I)
    if not encoding_match:
        encoding_match = re.search(br"charset\s*=\s*[\"']?([\w-]+)", body[:8192], re.I)
    encoding = encoding_match.group(1) if encoding_match else "utf-8"
    if isinstance(encoding, bytes):
        encoding = encoding.decode("ascii", errors="ignore")
    try:
        html = body.decode(encoding, errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")
    parser = _PageText()
    parser.feed(html)
    title = " ".join("".join(parser.title_parts).split())[:300]
    text = "".join(parser.parts)
    name = _normalize(place.name)
    if len(name) < 2 or name not in _normalize(title + " " + text + " " + parser.meta):
        return OfficialPlaceInfo(url=url, status="link_only", note="施設名を公式ページ内で照合できませんでした。公式サイトで確認してください。")
    if guides is not None:
        for href, label in parser.links:
            if not any(term in label for term in ("ご利用案内", "利用案内", "開館時間", "営業時間", "アクセス", "拝観案内", "開園時間", "参拝時間")):
                continue
            try:
                candidate = _basic_url(urljoin(url, href))
            except UnsafeURL:
                continue
            if urlsplit(candidate).hostname == urlsplit(url).hostname and candidate != url:
                guides.append(candidate)
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    opening_hours = _field(lines, ("開館時間", "営業時間", "入館受付", "開園時間", "拝観時間", "参拝時間", "最終入館", "受付時間"))
    closed_days = _field(lines, ("休館日", "休業日", "定休日", "休園日"))
    admission = _field(lines, ("観覧料", "入館料", "入場料", "拝観料", "利用料金", "料金"))
    description = " ".join(parser.meta.split())[:300]
    # Municipality CMS pages often use only "利用案内" as meta description.
    # A navigation label must not replace an actual facility introduction.
    description = description if len(description) >= 20 else None
    has_facts = any((opening_hours, closed_days, admission, description))
    note = "公式ページの記載を確認しました。臨時変更や最新情報は公式サイトで確認してください。"
    if not all((opening_hours, closed_days, admission)):
        note = "公式ページに確認できない項目があります。開館時間・休館日・料金の最新情報は公式サイトで確認してください。"
    return OfficialPlaceInfo(url=url, title=title or None, description=description, description_source_url=url if description else None, opening_hours=opening_hours, closed_days=closed_days, admission=admission, checked_at=datetime.now(timezone.utc).isoformat(), status="verified" if has_facts else "link_only", note=note)


async def _load(place: Place, state: dict) -> OfficialPlaceInfo:
    seed = _seed_entry(place)
    url = seed["url"] if seed else None
    if seed:
        state["seed"] = seed
    if not url:
        match = re.fullmatch(r"osm-(node|way|relation)-([1-9][0-9]{0,19})", place.id)
        if not match:
            return OfficialPlaceInfo(note="公式サイトを確認できませんでした。施設の公式情報をご確認ください。")
        kind, identifier = match.group(1), int(match.group(2))
        status, _headers, body = await asyncio.wait_for(_fetch_url(f"https://api.openstreetmap.org/api/0.6/{kind}/{identifier}.json"), REQUEST_TIMEOUT_SECONDS)
        if status != 200:
            raise FetchFailure("OSM request failed")
        url = _osm_url(json.loads(body), place, kind, identifier)
    if not url:
        return OfficialPlaceInfo(note="名称と位置が一致する施設の公式URLを確認できませんでした。")
    state["url"] = url
    calls = 0 if seed else 1
    redirected = False
    followed_guide = False
    first_result = None
    while calls < MAX_FETCHES:
        status, headers, body = await asyncio.wait_for(_fetch_url(url), REQUEST_TIMEOUT_SECONDS)
        calls += 1
        if status in {301, 302, 303, 307, 308}:
            if redirected or not headers.get("location"):
                raise FetchFailure("Redirect limit")
            url = _basic_url(urljoin(url, headers["location"]))
            redirected = True
            continue
        if status != 200:
            raise FetchFailure("Official page request failed")
        guides: list[str] = []
        result = _extract_page(body, headers, url, place, guides)
        if not first_result:
            first_result = result
        if (not followed_guide and calls < MAX_FETCHES and guides and result.checked_at
                and not all((result.opening_hours, result.closed_days, result.admission))):
            url = guides[0]
            followed_guide = True
            continue
        if followed_guide and not result.checked_at:
            result = first_result
        elif followed_guide and first_result:
            result = result.model_copy(update={field: getattr(first_result, field) for field in
                ("description", "description_source_url", "opening_hours", "closed_days", "admission")
                if getattr(result, field) is None and getattr(first_result, field) is not None})
        return _with_seed(result, seed)
    if first_result:
        return _with_seed(first_result, seed)
    raise FetchFailure("No final page")


def _with_seed(result: OfficialPlaceInfo, seed: dict | None) -> OfficialPlaceInfo:
    if not seed:
        return result
    description = seed.get("description")
    source = seed.get("description_source_url")
    if isinstance(description, str) and description.strip() and isinstance(source, str):
        try:
            result.description_source_url = _basic_url(source)
        except UnsafeURL:
            return result
        result.description = description.strip()[:300]
    highlights = seed.get("highlights", [])
    if isinstance(highlights, list):
        result.highlights = [text.strip()[:300] for text in highlights if isinstance(text, str) and text.strip()][:5]
    reviewed = seed.get("reviewed_at")
    if isinstance(reviewed, str):
        result.note += f" 紹介文の公式出典確認日: {reviewed[:30]}。"
    return result


async def fetch_official_place_info(place: Place) -> OfficialPlaceInfo:
    key = (place.id, _normalize(place.name), place.latitude, place.longitude)
    hit, cached = _cache.get(key)
    if hit and cached is not None:
        return cached
    state: dict = {}
    try:
        result = await asyncio.wait_for(_load(place, state), TOTAL_TIMEOUT_SECONDS)
    except UnsafeURL:
        return OfficialPlaceInfo(note="公開された安全な公式URLを確認できませんでした。施設の公式情報をご確認ください。")
    except (asyncio.TimeoutError, httpx.HTTPError, OSError, ValueError, TypeError):
        url = state.get("url")
        return _with_seed(OfficialPlaceInfo(url=url, status="link_only" if url else "unavailable", note="公式情報を取得・検証できませんでした。公式サイトで開館時間・休館日・料金を確認してください。"), state.get("seed"))
    # A completed, name-verified HTML response may be cached. Network failures,
    # unknown identities, and missing URLs are deliberately retried next time.
    if result.checked_at:
        _cache.set(key, result)
    return result
