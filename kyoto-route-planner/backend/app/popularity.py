import sqlite3
import asyncio
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

from app.database import database_path, initialize_database
from app.models import Place, Theme

WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
WIKIMEDIA_PAGEVIEWS_URL = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
POPULARITY_SCORE_VERSION = "v4"
WIKIDATA_TTL = timedelta(days=7)
POPULARITY_USER_AGENT = (
    "KyotoRoutePlanner/1.0 (local non-commercial application; "
    "https://www.mediawiki.org/wiki/API:Etiquette)"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _wikidata_id(place: Place) -> str | None:
    value = place.tags.get("wikidata", "").strip()
    return value if value.startswith("Q") and value[1:].isdigit() else None


def _wikipedia_title(place: Place, language: str) -> str | None:
    value = place.tags.get("wikipedia", "").strip()
    prefix = f"{language}:"
    if value.startswith(prefix) and value[len(prefix):].strip():
        return value[len(prefix):].strip()
    return None


def _sparql_query(qids: list[str]) -> str:
    values = " ".join(f"wd:{qid}" for qid in qids)
    return f"""
SELECT ?item ?sitelinks ?jaArticle ?jaTitle ?enArticle ?enTitle WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wikibase:sitelinks ?sitelinks. }}
  OPTIONAL {{
    ?jaArticle schema:about ?item ;
      schema:isPartOf <https://ja.wikipedia.org/> ;
      schema:name ?jaTitle .
  }}
  OPTIONAL {{
    ?enArticle schema:about ?item ;
      schema:isPartOf <https://en.wikipedia.org/> ;
      schema:name ?enTitle .
  }}
}}
"""


def _sparql_rows(payload: object) -> list[dict[str, str]]:
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, dict) or not isinstance(results.get("bindings"), list):
        return []
    rows: list[dict[str, str]] = []
    for binding in results["bindings"]:
        if not isinstance(binding, dict):
            continue
        row = {
            key: value["value"]
            for key, value in binding.items()
            if isinstance(value, dict) and isinstance(value.get("value"), str)
        }
        if row:
            rows.append(row)
    return rows


async def _fetch_wikidata(client: httpx.AsyncClient, qids: list[str]) -> dict[str, dict[str, str]]:
    if not qids:
        return {}
    response = await _get_with_backoff(
        client,
        WIKIDATA_SPARQL_URL,
        params={"query": _sparql_query(qids), "format": "json"},
        headers={"Accept": "application/sparql-results+json"},
    )
    response.raise_for_status()
    payload = response.json()
    result: dict[str, dict[str, str]] = {}
    for row in _sparql_rows(payload):
        item = row.get("item", "").rsplit("/", 1)[-1]
        if item:
            result[item] = row
    return result


async def _fetch_pageviews(
    client: httpx.AsyncClient,
    title: str,
    language: str,
) -> int:
    end = _now().date()
    start = end - timedelta(days=30)
    article = quote(title.replace(" ", "_"), safe="")
    url = (
        f"{WIKIMEDIA_PAGEVIEWS_URL}/{language}.wikipedia/all-access/user/"
        f"{article}/daily/{start:%Y%m%d}/{end:%Y%m%d}"
    )
    response = await _get_with_backoff(
        client,
        url,
        headers={"User-Agent": POPULARITY_USER_AGENT},
    )
    if response.status_code == 404:
        return 0
    response.raise_for_status()
    payload = response.json()
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return sum(
        int(item.get("views", 0))
        for item in items
        if isinstance(item, dict) and isinstance(item.get("views"), int)
    )


async def _get_with_backoff(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 3,
) -> httpx.Response:
    for attempt in range(attempts):
        response = await client.get(url, params=params, headers=headers)
        if response.status_code != 429 and response.status_code < 500:
            return response
        if attempt == attempts - 1:
            return response
        retry_after = response.headers.get("Retry-After")
        try:
            delay = min(float(retry_after), 30.0) if retry_after else 2**attempt
        except ValueError:
            delay = 2**attempt
        await asyncio.sleep(delay)
    raise RuntimeError("外部APIリクエストの再試行に失敗しました。")


def _log_score(pageviews: int) -> float:
    import math

    return min(100.0, math.log10(pageviews + 1) / 6 * 100)


def _wikidata_score(row: dict[str, str]) -> float:
    score = 0.0
    score += 20 if row.get("sitelinks") else 0
    score += 15 if row.get("jaTitle") else 0
    score += 10 if row.get("enTitle") else 0
    try:
        score += min(int(row.get("sitelinks", "0")) / 100, 1) * 55
    except ValueError:
        pass
    return min(score, 100.0)


def _open_data_matches(
    connection: sqlite3.Connection,
    places: list[Place],
) -> dict[str, bool]:
    matches: dict[str, bool] = {}
    for place in places:
        row = connection.execute(
            """
            SELECT 1
            FROM places
            WHERE dataset_id LIKE 'ksj-p12-%'
              AND (
                name = ?
                OR (
                    ABS(latitude - ?) < 0.001
                    AND ABS(longitude - ?) < 0.001
                )
              )
            LIMIT 1
            """,
            (place.name, place.latitude, place.longitude),
        ).fetchone()
        matches[place.id] = row is not None
    return matches


def _upsert_results(
    path: Path,
    places: list[Place],
    wikidata: dict[str, dict[str, str]],
    pageviews: dict[str, int],
) -> None:
    target = initialize_database(path)
    fetched_at = _now().isoformat()
    with closing(sqlite3.connect(target)) as connection:
        open_data_matches = _open_data_matches(connection, places)
        for place in places:
            qid = _wikidata_id(place)
            row = wikidata.get(qid or "", {})
            previous = connection.execute(
                """
                SELECT wikidata_id, wikipedia_ja_title, wikipedia_en_title,
                       wikipedia_sitelink_count, wikipedia_pageviews_30d
                FROM place_popularity
                WHERE place_id = ?
                """,
                (place.id,),
            ).fetchone()
            ja_title = row.get("jaTitle") or _wikipedia_title(place, "ja")
            en_title = row.get("enTitle") or _wikipedia_title(place, "en")
            if previous:
                ja_title = ja_title or previous[1]
                en_title = en_title or previous[2]
            sitelinks = row.get("sitelinks")
            if not sitelinks and previous:
                sitelinks = str(previous[3])
            views = pageviews.get(place.id)
            if views is None:
                views = int(previous[4]) if previous else 0
            osm_score = _place_score(place)
            wikidata_score = _wikidata_score(row)
            if not row and previous:
                wikidata_score = _wikidata_score({
                    "sitelinks": str(previous[3]),
                    "jaTitle": previous[1] or "",
                    "enTitle": previous[2] or "",
                })
            total_score = osm_score * 0.35 + wikidata_score * 0.25 + _log_score(views) * 0.20
            open_data_score = 100.0 if open_data_matches.get(place.id) else 0.0
            total_score += open_data_score * 0.20
            connection.execute(
                """
                INSERT INTO place_popularity (
                    place_id, wikidata_id, wikipedia_ja_title, wikipedia_en_title,
                    wikipedia_sitelink_count, wikipedia_pageviews_30d,
                    has_japanese_wikipedia, has_english_wikipedia,
                    source_fetched_at, source_status, open_data_match
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
                ON CONFLICT(place_id) DO UPDATE SET
                    wikidata_id=excluded.wikidata_id,
                    wikipedia_ja_title=excluded.wikipedia_ja_title,
                    wikipedia_en_title=excluded.wikipedia_en_title,
                    wikipedia_sitelink_count=excluded.wikipedia_sitelink_count,
                    wikipedia_pageviews_30d=excluded.wikipedia_pageviews_30d,
                    has_japanese_wikipedia=excluded.has_japanese_wikipedia,
                    has_english_wikipedia=excluded.has_english_wikipedia,
                    source_fetched_at=excluded.source_fetched_at,
                    source_status=excluded.source_status
                    ,open_data_match=excluded.open_data_match
                """,
                (
                    place.id,
                    qid,
                    ja_title,
                    en_title,
                    int(sitelinks or 0),
                    views,
                    int(bool(ja_title)),
                    int(bool(en_title)),
                    fetched_at,
                    int(open_data_matches.get(place.id, False)),
                ),
            )
            connection.execute(
                """
                INSERT INTO place_scores (
                    place_id, osm_score, wikidata_score, pageview_score,
                    open_data_score, total_score, score_version, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(place_id) DO UPDATE SET
                    osm_score=excluded.osm_score,
                    wikidata_score=excluded.wikidata_score,
                    pageview_score=excluded.pageview_score,
                    open_data_score=excluded.open_data_score,
                    total_score=excluded.total_score,
                    score_version=excluded.score_version,
                    calculated_at=excluded.calculated_at
                """,
                (place.id, osm_score, wikidata_score, _log_score(views), open_data_score, total_score, POPULARITY_SCORE_VERSION, fetched_at),
            )
        connection.commit()


def _place_score(place: Place) -> float:
    from app.places import calculate_place_score

    return calculate_place_score(place, "all")


async def sync_popularity(path: Path | None = None) -> int:
    from app.poi_search import search_yahoo_catalog

    response = await search_yahoo_catalog("京都 観光", limit=100)
    places = [
        Place(
            id=hit.place.id,
            name=hit.place.name,
            category=hit.place.category,
            description=hit.place.description,
            access_point="",
            latitude=hit.place.latitude,
            longitude=hit.place.longitude,
            themes=[],
            address=hit.place.address,
        )
        for hit in response.results
    ]
    if not places:
        return 0
    target_path = path or database_path()
    if _cached_popularity_is_fresh(target_path, places):
        return len(places)
    qids = sorted({qid for place in places if (qid := _wikidata_id(place))})
    async with httpx.AsyncClient(timeout=30.0, headers={"User-Agent": POPULARITY_USER_AGENT}) as client:
        try:
            wikidata = await _fetch_wikidata(client, qids)
        except (httpx.HTTPError, ValueError):
            wikidata = {}
        pageviews: dict[str, int] = {}
        for place in places:
            row = wikidata.get(_wikidata_id(place) or "", {})
            title = row.get("jaTitle") or _wikipedia_title(place, "ja")
            if title:
                try:
                    pageviews[place.id] = await _fetch_pageviews(client, title, "ja")
                except (httpx.HTTPError, ValueError):
                    pageviews[place.id] = _cached_pageview(target_path, place.id)
    _upsert_results(target_path, places, wikidata, pageviews)
    return len(places)


def _cached_popularity_is_fresh(path: Path, places: list[Place]) -> bool:
    if not places:
        return True
    target = initialize_database(path)
    cutoff = _now() - WIKIDATA_TTL
    with closing(sqlite3.connect(target)) as connection:
        rows = connection.execute(
            "SELECT place_id, source_fetched_at FROM place_popularity"
        ).fetchall()
    fetched: dict[str, datetime] = {}
    for place_id, timestamp in rows:
        try:
            fetched[place_id] = datetime.fromisoformat(timestamp)
        except ValueError:
            continue
    return all(fetched.get(place.id, datetime.min.replace(tzinfo=timezone.utc)) >= cutoff for place in places)


def _cached_pageview(path: Path, place_id: str) -> int:
    target = initialize_database(path)
    with closing(sqlite3.connect(target)) as connection:
        row = connection.execute(
            "SELECT wikipedia_pageviews_30d FROM place_popularity WHERE place_id = ?",
            (place_id,),
        ).fetchone()
    return int(row[0]) if row else 0


def load_cached_scores(path: Path | None = None) -> dict[str, float]:
    target = initialize_database(path or database_path())
    with closing(sqlite3.connect(target)) as connection:
        rows = connection.execute("SELECT place_id, total_score FROM place_scores").fetchall()
    return {place_id: float(score) for place_id, score in rows}
