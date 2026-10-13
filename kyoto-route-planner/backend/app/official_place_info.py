"""Conservative, bounded official-site information; never infer missing facts."""

import asyncio
from datetime import date, datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import re
import socket
from typing import Literal
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, Field

from app.cache import TTLCache
from app.models import Place
from app.official_html import parse_document
from app.official_sources import normalize as _normalize, nearby as _nearby, osm_element, wikidata_website, wikipedia_website
from app.official_transport import compatible_fetch, verified_context
from app.official_notices import closure_notice

MAX_BODY_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 4.0
TOTAL_TIMEOUT_SECONDS = 12.0
MAX_FETCHES = 8  # Identity lookup, URL migration and up to two visitor-guide pages.
MAX_REDIRECTS = 3
FIELDS = ("opening_hours", "closed_days", "admission")
SEED_PATH = Path(__file__).with_name("data") / "official_place_sources.json"
_cache: TTLCache[tuple, "OfficialPlaceInfo"] = TTLCache(6 * 60 * 60, 1024)


class ClosureNotice(BaseModel):
    text: str
    url: str
    starts_on: date
    ends_on: date


class OfficialPlaceInfo(BaseModel):
    url: str | None = None
    title: str | None = None
    description: str | None = None
    description_source_url: str | None = None
    highlights: list[str] = Field(default_factory=list)
    opening_hours: str | None = None
    closed_days: str | None = None
    admission: str | None = None
    field_sources: dict[str, str] = Field(default_factory=dict)
    notices: list[ClosureNotice] = Field(default_factory=list)
    checked_at: str | None = None
    status: Literal["verified", "link_only", "unavailable"] = "unavailable"
    note: str


class UnsafeURL(ValueError):
    pass


class FetchFailure(ValueError):
    pass


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
    try:
        return await _fetch_httpx(pinned, headers, original.host)
    except httpx.ConnectError:
        return await compatible_fetch(url, address, headers, max_bytes=MAX_BODY_BYTES, timeout=REQUEST_TIMEOUT_SECONDS)


async def _fetch_httpx(pinned: httpx.URL, headers: dict, hostname: str) -> tuple[int, dict[str, str], bytes]:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False, trust_env=False, verify=verified_context(hostname)) as client:
        async with client.stream("GET", pinned, headers=headers, extensions={"sni_hostname": hostname}) as response:
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
    element = osm_element(payload, place, kind, identifier)
    if element:
        for key in ("website", "contact:website", "url"):
            if element["tags"].get(key):
                return _basic_url(element["tags"][key])
    return None


def _guide_priority(label: str) -> int:
    label = _normalize(label)
    if any(term in label for term in ("添乗員", "通訳", "ボランティア", "通信販売")):
        return 99
    for index, terms in enumerate((("利用案内", "来館案内", "拝観案内"),
                                   ("開館時間", "営業時間", "開園時間", "参拝時間", "料金"),
                                   ("アクセス", "経路案内", "access", "visitorinformation"))):
        if any(term in label for term in terms):
            return index
    return 99


def _extract_page(body: bytes, headers: dict, url: str, place: Place, guides: list[str] | None = None) -> OfficialPlaceInfo:
    content_type = headers.get("content-type", "")
    if "text/html" not in content_type.casefold() and "application/xhtml+xml" not in content_type.casefold():
        raise FetchFailure("Not an HTML page")
    document = parse_document(body, headers)
    name = _normalize(place.name)
    # Navigation/footer links listing a different museum are not its identity.
    identity = document.title + " " + document.meta + " " + " ".join(document.lines)
    if len(name) < 2 or name not in _normalize(identity):
        return OfficialPlaceInfo(url=url, status="link_only", note="施設名を公式ページ内で照合できませんでした。公式サイトで確認してください。")
    if guides is not None:
        candidates = []
        for href, label in document.links:
            rank = _guide_priority(label)
            if rank == 99:
                continue
            try:
                candidate = _basic_url(urljoin(url, href))
            except UnsafeURL:
                continue
            if urlsplit(candidate).hostname == urlsplit(url).hostname and candidate != url:
                candidates.append((rank, candidate))
        guides.extend(dict.fromkeys(candidate for _, candidate in sorted(candidates, key=lambda item: item[0])))
    description = document.meta[:300] if len(document.meta) >= 20 else None
    facts = {field: getattr(document, field) for field in FIELDS}
    complete = all(facts.values())
    return OfficialPlaceInfo(url=url, title=document.title[:300] or None, description=description,
        description_source_url=url if description else None, **facts,
        field_sources={field: url for field, value in facts.items() if value},
        checked_at=datetime.now(timezone.utc).isoformat(),
        status="verified" if any(facts.values()) or description else "link_only",
        note="公式ページの記載を確認しました。臨時変更や最新情報は公式サイトで確認してください。" if complete else
             "公式ページに確認できない項目があります。開館時間・休館日・料金の最新情報は公式サイトで確認してください。")


def _merge_pages(previous: OfficialPlaceInfo | None, current: OfficialPlaceInfo) -> OfficialPlaceInfo:
    if previous is None:
        return current
    if not current.checked_at:
        return previous
    if not any(getattr(current, field) for field in FIELDS) and any(getattr(previous, field) for field in FIELDS):
        return previous
    updates = {field: getattr(previous, field) for field in
               (*FIELDS, "description", "description_source_url")
               if getattr(current, field) is None and getattr(previous, field) is not None}
    updates["field_sources"] = {**previous.field_sources, **current.field_sources}
    merged = current.model_copy(update=updates)
    if any(getattr(merged, field) for field in FIELDS) or merged.description:
        merged.status = "verified"
    if all(getattr(merged, field) for field in FIELDS):
        merged.note = "公式ページの記載を確認しました。臨時変更や最新情報は公式サイトで確認してください。"
    return merged


async def _load(place: Place, state: dict) -> OfficialPlaceInfo:
    seed = _seed_entry(place)
    url = seed["url"] if seed else None
    if seed:
        state["seed"] = seed
    calls = 0
    wikipedia_tried = False
    async def fetch(target):
        nonlocal calls
        if calls >= MAX_FETCHES:
            raise FetchFailure("Request limit")
        calls += 1
        return await asyncio.wait_for(_fetch_url(target), REQUEST_TIMEOUT_SECONDS)

    async def wiki_url():
        nonlocal wikipedia_tried
        if wikipedia_tried or calls >= MAX_FETCHES:
            return None
        wikipedia_tried = True
        query = urlencode({"action": "query", "titles": place.name, "redirects": 1,
            "prop": "coordinates|pageprops|revisions", "ppprop": "disambiguation", "coprimary": "primary", "colimit": 1,
            "rvprop": "content", "rvslots": "main", "format": "json", "formatversion": 2})
        try:
            status, _, body = await fetch("https://ja.wikipedia.org/w/api.php?" + query)
            candidate = wikipedia_website(json.loads(body), place) if status == 200 else None
            return _basic_url(candidate) if candidate else None
        except (httpx.HTTPError, OSError, ValueError, TypeError):
            return None

    if not url:
        match = re.fullmatch(r"osm-(node|way|relation)-([1-9][0-9]{0,19})", place.id)
        if not match:
            return OfficialPlaceInfo(note="公式サイトを確認できませんでした。施設の公式情報をご確認ください。")
        kind, identifier = match.group(1), int(match.group(2))
        suffix = ".json" if kind == "node" else "/full.json"
        status, _, body = await fetch(f"https://api.openstreetmap.org/api/0.6/{kind}/{identifier}" + suffix)
        if status != 200:
            raise FetchFailure("OSM request failed")
        payload = json.loads(body)
        element = osm_element(payload, place, kind, identifier)
        if element is None:
            return OfficialPlaceInfo(note="名称と位置が一致する施設を確認できませんでした。")
        url = _osm_url(payload, place, kind, identifier)
        if not url:
            article = element["tags"].get("wikipedia", "")
            if isinstance(article, str) and article.startswith("ja:") and _normalize(article[3:]) == _normalize(place.name):
                url = await wiki_url()
            item = element["tags"].get("wikidata", "")
            if not url and isinstance(item, str) and re.fullmatch(r"Q[1-9][0-9]{0,12}", item):
                try:
                    status, _, body = await fetch(f"https://www.wikidata.org/wiki/Special:EntityData/{item}.json")
                    candidate = wikidata_website(json.loads(body), item, place) if status == 200 else None
                    url = _basic_url(candidate) if candidate else None
                except (httpx.HTTPError, OSError, ValueError, TypeError):
                    pass
            if not url:
                url = await wiki_url()
    if not url:
        return OfficialPlaceInfo(note="名称と位置が一致する施設の公式URLを確認できませんでした。")
    visited = set()
    redirects = 0
    followed_guides = 0
    pending_guides = []
    pending_notices = []
    notice_indexes = []
    result = None

    async def notice_page(target):
        nonlocal redirects
        seen = set()
        host = urlsplit(target).hostname
        while calls < MAX_FETCHES and target not in seen:
            seen.add(target)
            status, headers, body = await fetch(target)
            if status in (301, 302, 303, 307, 308) and headers.get("location") and redirects < MAX_REDIRECTS:
                destination = _basic_url(urljoin(target, headers["location"]))
                if urlsplit(destination).hostname != host:
                    return None
                redirects += 1
                target = destination
                continue
            if status == 200 and "html" in headers.get("content-type", "").casefold():
                return target, parse_document(body, headers)
            return None
        return None

    async def finish(completed):
        state["result"] = completed
        if not pending_notices and notice_indexes and calls < MAX_FETCHES:
            state["notice_failed"] = True
            try:
                indexed = await notice_page(notice_indexes[0])
                if indexed:
                    state["notice_failed"] = False
                    collect_notice_links(indexed[1], indexed[0])
            except (httpx.HTTPError, OSError, ValueError, TypeError):
                pass
        if pending_notices and calls < MAX_FETCHES:
            state["notice_failed"] = True
            target = pending_notices[0]
            try:
                fetched_notice = await notice_page(target)
                if fetched_notice:
                    state["notice_failed"] = False
                    target, document = fetched_notice
                    today = datetime.now(timezone(timedelta(hours=9))).date()
                    notice = closure_notice(document, place.name, today)
                    if notice:
                        completed = completed.model_copy(update={"notices": [ClosureNotice(url=target, **notice)]})
                        state["result"] = completed
            except (httpx.HTTPError, OSError, ValueError, TypeError):
                pass
        return _with_seed(completed, seed)

    def collect_notice_links(document, source_url):
        for href, label in document.links:
            normalized = _normalize(label)
            if _normalize(place.name) not in normalized or "臨時休館" not in normalized:
                continue
            try:
                candidate = _basic_url(urljoin(source_url, href))
            except UnsafeURL:
                continue
            if urlsplit(candidate).hostname == urlsplit(source_url).hostname and candidate not in pending_notices:
                pending_notices.append(candidate)

    while calls < MAX_FETCHES:
        if url in visited:
            break
        visited.add(url)
        state["url"] = url
        retired = False
        try:
            status, headers, body = await fetch(url)
            if status in {301, 302, 303, 307, 308}:
                if redirects >= MAX_REDIRECTS or not headers.get("location"):
                    raise FetchFailure("Redirect limit")
                url = _basic_url(urljoin(url, headers["location"]))
                redirects += 1
                continue
            if status != 200:
                retired = status in (404, 410)
                raise FetchFailure("Official page request failed")
            if "html" in headers.get("content-type", "").casefold():
                document = parse_document(body, headers)
                refresh = getattr(document, "redirect_url", None)
                if refresh:
                    if redirects >= MAX_REDIRECTS:
                        raise FetchFailure("Redirect limit")
                    url = _basic_url(urljoin(url, refresh))
                    redirects += 1
                    continue
            guides = []
            page = _extract_page(body, headers, url, place, guides)
            result = _merge_pages(result, page)
            state["result"] = result
            if page.checked_at:
                collect_notice_links(document, url)
                for href, label in document.links:
                    if not any(term in _normalize(label) for term in ("新着情報", "お知らせ", "information")):
                        continue
                    try:
                        candidate = _basic_url(urljoin(url, href))
                    except UnsafeURL:
                        continue
                    if urlsplit(candidate).hostname == urlsplit(url).hostname and candidate not in visited and candidate not in notice_indexes:
                        notice_indexes.append(candidate)
            if all(getattr(result, field) for field in FIELDS):
                return await finish(result)
            if page.checked_at:
                pending_guides.extend(candidate for candidate in guides if candidate not in visited and candidate not in pending_guides)
            if followed_guides < 2 and pending_guides:
                url = pending_guides.pop(0)
                followed_guides += 1
                continue
            return await finish(result)
        except UnsafeURL:
            raise
        except (httpx.HTTPError, OSError, ValueError, TypeError) as error:
            # A retired official URL need not end discovery. An exact-title and
            # coordinate-matched article may link to the migrated official site.
            if result is None and not seed and (retired or isinstance(error, (httpx.HTTPError, OSError))):
                candidate = await wiki_url()
                if candidate and candidate not in visited:
                    url = candidate
                    continue
            if result is not None and result.checked_at:
                return await finish(result)
            raise
    if result is not None:
        return await finish(result)
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
    if hit and cached is not None and all(getattr(cached, field) for field in FIELDS):
        return cached
    state: dict = {}
    try:
        result = await asyncio.wait_for(_load(place, state), TOTAL_TIMEOUT_SECONDS)
    except UnsafeURL:
        return OfficialPlaceInfo(note="公開された安全な公式URLを確認できませんでした。施設の公式情報をご確認ください。")
    except (asyncio.TimeoutError, httpx.HTTPError, OSError, ValueError, TypeError):
        partial = state.get("result")
        if partial and partial.checked_at:
            return _with_seed(partial, state.get("seed"))
        url = state.get("url")
        return _with_seed(OfficialPlaceInfo(url=url, status="link_only" if url else "unavailable", note="公式情報を取得・検証できませんでした。公式サイトで開館時間・休館日・料金を確認してください。"), state.get("seed"))
    # A completed, name-verified HTML response may be cached. Network failures,
    # unknown identities, and missing URLs are deliberately retried next time.
    if result.checked_at and not state.get("notice_failed"):
        _cache.set(key, result)
    return result


def known_official_url(place: Place) -> str | None:
    """Only previously checked page/seed metadata, never model output."""
    key = (place.id, _normalize(place.name), place.latitude, place.longitude)
    hit, cached = _cache.get(key)
    if hit and cached and cached.checked_at:
        return cached.url
    seed = _seed_entry(place)
    return seed["url"] if seed else None
