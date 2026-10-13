"""Bounded, extractive facility highlights with official page provenance.

No generated claims or search snippets are accepted. Official URL discovery and
network requests reuse the visitor-information module's identity/SSRF checks.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import re
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import BaseModel, Field

from app.cache import TTLCache
from app.models import Place
from app.official_html import Document, parse_document
from app import official_place_info as official
from app.official_sources import normalize

MAX_PLACES = 12
MAX_CONCURRENCY = 4
TOTAL_TIMEOUT_SECONDS = 19.0
MAX_FETCHES = 5
MAX_FACTS = 3
_cache: TTLCache = TTLCache(6 * 60 * 60, 1024)
_negative_cache: TTLCache = TTLCache(60, 1024)
_inflight: dict[tuple, asyncio.Task] = {}
_partial: dict[tuple, OfficialAttractions] = {}


class AttractionFact(BaseModel):
    text: str
    source_url: str


class OfficialAttractions(BaseModel):
    place_id: str
    facts: list[AttractionFact] = Field(default_factory=list)
    checked_at: str | None = None
    reviewed_at: str | None = None


# Require concrete subject matter beyond a category, proximity or sales pitch.
_SUBJECT = re.compile(r"国宝|重要文化財|文化財|本尊|本堂|仏像|阿弥陀|如来|菩薩|天守|石垣|城跡|城郭|庭園|枯山水|作庭|築城|建立|創建|建築|再建|復元|移築|収蔵|所蔵|展示|蒐集|コレクション|作品|工芸|絵画|彫刻|車両|蒸気機関車|運転シミュレータ|体験|出土|遺跡|史跡|江戸|明治|大正|昭和|平安|鎌倉|室町|真田|親鸞|善光寺|桜|紅葉|眺望|滝|巨木|湿原|collection|architecture|exhibit|historic|garden", re.I)
_BOILERPLATE = re.compile(r"公式(?:サイト|ホームページ)|オフィシャル|ホームページへ|サイトマップ|プライバシー|cookie|copyright|無断転載|ご利用(?:ください|下さい)|お問い合わせ|アクセス方法|開館時間|営業時間|休館日|入館料|入場料|拝観料|最新情報|お知らせ|予約受付|お申し込み|団体|ご希望|御希望|ご予約|御予約|解説を|クリック|おすすめスポット|観光情報サイト|周辺の|徒歩\d|バスで\d", re.I)
_DETAIL_LINK = re.compile(r"について|とは$|概要|沿革|歴史|見どころ|見所|みどころ|境内|堂宇|文化財|庭園|コレクション|収蔵|所蔵|常設|車両紹介|展示紹介|資料館紹介|館紹介|about|collection|highlight", re.I)
_TEMPORARY = re.compile(r"特別展|企画展|開催(?:中|予定|します|いたします)|\d{1,2}月\d{1,2}日.*(?:まで|から)")


def _sentences(document: Document) -> list[str]:
    candidates = []
    for line in [*document.lines, document.meta]:
        for sentence in re.findall(r"[^。！？!?]+[。！？!?]|[^。！？!?]+$", line):
            sentence = sentence.strip()
            if not 24 <= len(sentence) <= 260 or _BOILERPLATE.search(sentence) or _TEMPORARY.search(sentence):
                continue
            if not _SUBJECT.search(sentence):
                continue
            # Discard short keyword lists, headings, search descriptions and links.
            if not re.search(r"です|ます|である|され|して|した|する|でき|れる|られ|誇る|残る|伝え|建つ|有す|\b(?:is|are|has|houses|features|built)\b", sentence, re.I):
                continue
            if any(normalize(sentence) in normalize(old) or normalize(old) in normalize(sentence) for old in candidates):
                continue
            candidates.append(sentence)
    return candidates


def _identity(document: Document, place: Place) -> bool:
    # Chrome links mentioning the target do not establish page identity.
    name = normalize(place.name)
    return len(name) >= 2 and name in normalize(" ".join([document.title, document.meta, *document.lines]))


def _key(place: Place) -> tuple:
    return place.id, normalize(place.name), place.latitude, place.longitude


def _entry_page(url: str) -> str:
    """A guide URL can obscure About links; try its facility directory too."""
    parts = urlsplit(url)
    segments = parts.path.rstrip("/").split("/")
    if segments and "." in segments[-1]:
        segments.pop()
    while segments and re.fullmatch(r"access|guide|visitor|information|info", segments[-1], re.I):
        segments.pop()
    return parts._replace(path="/".join(segments).rstrip("/") + "/", query="", fragment="").geturl()


async def _load(place: Place, result: OfficialAttractions) -> OfficialAttractions:
    seed = official._seed_entry(place)
    # Reviewed local facts remain usable if the live official page is unavailable.
    # Their date is a review date, never represented as a fresh network check.
    if seed and isinstance(seed.get("reviewed_at"), str):
        source = seed.get("description_source_url")
        try:
            source = official._basic_url(source)
        except (ValueError, TypeError):
            source = None
        if source:
            texts = [seed.get("description", ""), *seed.get("highlights", [])]
            for text in texts:
                if isinstance(text, str) and text.strip() and len(text) <= 300:
                    result.facts.append(AttractionFact(text=text.strip(), source_url=source))
            result.facts = result.facts[:MAX_FACTS]
            if result.facts:
                result.reviewed_at = seed["reviewed_at"]
                return result
    info = await official.fetch_official_place_info(place)
    if not info.url:
        return result
    root = official._basic_url(info.url)
    host = urlsplit(root).hostname
    pending = [root]
    entry = _entry_page(root)
    if entry != root:
        pending.append(entry)
    visited = set()
    calls = 0
    while pending and calls < MAX_FETCHES and len(result.facts) < MAX_FACTS:
        target = pending.pop(0)
        if target in visited:
            continue
        visited.add(target)
        calls += 1
        try:
            status, headers, body = await asyncio.wait_for(official._fetch_url(target), official.REQUEST_TIMEOUT_SECONDS)
            if status in {301, 302, 303, 307, 308}:
                destination = official._basic_url(urljoin(target, headers.get("location", "")))
                if urlsplit(destination).hostname == host:
                    pending.insert(0, destination)
                continue
            if status != 200 or "html" not in headers.get("content-type", "").lower():
                continue
            document = parse_document(body, headers)
            if not _identity(document, place):
                continue
            result.checked_at = datetime.now(timezone.utc).isoformat()
            for text in _sentences(document):
                if not any(normalize(text) in normalize(f.text) or normalize(f.text) in normalize(text) for f in result.facts):
                    result.facts.append(AttractionFact(text=text, source_url=target))
                if len(result.facts) >= MAX_FACTS:
                    break
            if target in {root, entry}:
                detail_links = []
                for href, label in document.links:
                    if not _DETAIL_LINK.search(label):
                        continue
                    try:
                        url = official._basic_url(urljoin(target, href))
                    except ValueError:
                        continue
                    if urlsplit(url).hostname == host and url not in visited and url not in pending:
                        detail_links.append(url)
                    if len(detail_links) == 2:
                        break
                pending = detail_links + pending
        except (httpx.HTTPError, OSError, ValueError, TypeError, asyncio.TimeoutError):
            continue
    return result


async def _cached_load(place: Place) -> OfficialAttractions:
    result = OfficialAttractions(place_id=place.id)
    key = (asyncio.get_running_loop(), *_key(place))
    _partial[key] = result
    try:
        try:
            result = await asyncio.wait_for(_load(place, result), TOTAL_TIMEOUT_SECONDS)
        except (httpx.HTTPError, OSError, ValueError, TypeError, asyncio.TimeoutError):
            pass  # Keep already verified facts if a later detail page times out.
        (_cache if result.facts else _negative_cache).set(_key(place), result)
    finally:
        _partial.pop(key, None)
    return result


async def fetch_official_attractions(place: Place) -> OfficialAttractions:
    hit, cached = _cache.get(_key(place))
    if not hit:
        hit, cached = _negative_cache.get(_key(place))
    if hit:
        return cached.model_copy(deep=True)
    key = (asyncio.get_running_loop(), *_key(place))
    task = _inflight.get(key)
    if task is None:
        # Bound process work even when independent callers bypass the batch API.
        if len(_inflight) >= 32:
            return OfficialAttractions(place_id=place.id)
        task = asyncio.create_task(_cached_load(place))
        _inflight[key] = task
        task.add_done_callback(lambda completed: _inflight.pop(key, None))
    return (await asyncio.shield(task)).model_copy(deep=True)


async def enrich_official_attractions(places: list[Place]) -> dict[str, OfficialAttractions]:
    """Inspect at most twelve candidates, with four concurrent facility lookups."""
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
    results: dict[str, OfficialAttractions] = {}

    async def one(place):
        async with semaphore:
            results[place.id] = await fetch_official_attractions(place)

    tasks = [asyncio.create_task(one(p)) for p in places[:MAX_PLACES]]
    try:
        await asyncio.wait_for(asyncio.gather(*tasks), TOTAL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        for place in places[:MAX_PLACES]:
            partial = _partial.get((asyncio.get_running_loop(), *_key(place)))
            if partial is None:
                _, partial = _cache.get(_key(place))
            if place.id not in results and partial and partial.facts:
                results[place.id] = partial.model_copy(deep=True)
    return results
