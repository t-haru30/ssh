import sqlite3
import asyncio
from math import asin, cos, radians, sin, sqrt
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
from urllib.parse import quote

import httpx

from app.database import database_path, initialize_database
from app.models import Place, Theme

WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
WIKIMEDIA_PAGEVIEWS_URL = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
POPULARITY_SCORE_VERSION = "v5"
WIKIDATA_TTL = timedelta(days=7)
logger = logging.getLogger(__name__)
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


def _yahoo_places_sparql_query(places: list[Place]) -> str:
    values = "\n".join(
        "("
        f"{json.dumps(place.id, ensure_ascii=False)} "
        f"{json.dumps(place.name, ensure_ascii=False)}@ja"
        ")"
        for place in places
    )
    return f"""
SELECT ?placeId ?item ?sitelinks ?jaTitle ?enTitle ?point WHERE {{
  VALUES (?placeId ?candidateLabel) {{
    {values}
  }}
  ?item rdfs:label ?candidateLabel ;
        wdt:P625 ?point ;
        wikibase:sitelinks ?sitelinks .
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
ORDER BY ?placeId
"""


def _coordinates_from_wkt(value: str) -> tuple[float, float] | None:
    if not value.startswith("Point(") or not value.endswith(")"):
        return None
    coordinates = value[6:-1].split()
    if len(coordinates) != 2:
        return None
    try:
        longitude, latitude = map(float, coordinates)
    except ValueError:
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return latitude, longitude


def _distance_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    latitude_delta = radians(second[0] - first[0])
    longitude_delta = radians(second[1] - first[1])
    haversine = (
        sin(latitude_delta / 2) ** 2
        + cos(radians(first[0]))
        * cos(radians(second[0]))
        * sin(longitude_delta / 2) ** 2
    )
    return 6371.0 * 2 * asin(sqrt(haversine))


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


async def _fetch_yahoo_wikidata(
    client: httpx.AsyncClient,
    places: list[Place],
) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    wikidata: dict[str, dict[str, str]] = {}
    place_qids: dict[str, str] = {}
    matched_distances: dict[str, float] = {}
    places_by_id = {place.id: place for place in places}
    for offset in range(0, len(places), 25):
        batch = places[offset : offset + 25]
        response = await _get_with_backoff(
            client,
            WIKIDATA_SPARQL_URL,
            params={
                "query": _yahoo_places_sparql_query(batch),
                "format": "json",
            },
            headers={"Accept": "application/sparql-results+json"},
        )
        response.raise_for_status()
        for row in _sparql_rows(response.json()):
            place_id = row.get("placeId", "")
            qid = row.get("item", "").rsplit("/", 1)[-1]
            place = places_by_id.get(place_id)
            coordinates = _coordinates_from_wkt(row.get("point", ""))
            if not place or not qid or coordinates is None:
                continue
            distance = _distance_km(
                (place.latitude, place.longitude),
                coordinates,
            )
            if distance > 1.0 or distance >= matched_distances.get(place_id, float("inf")):
                continue
            matched_distances[place_id] = distance
            place_qids[place_id] = qid
            wikidata[qid] = row
    return wikidata, place_qids


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
    source_status: str = "ok",
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(place_id) DO UPDATE SET
                    wikidata_id=excluded.wikidata_id,
                    wikipedia_ja_title=excluded.wikipedia_ja_title,
                    wikipedia_en_title=excluded.wikipedia_en_title,
                    wikipedia_sitelink_count=excluded.wikipedia_sitelink_count,
                    wikipedia_pageviews_30d=excluded.wikipedia_pageviews_30d,
                    has_japanese_wikipedia=excluded.has_japanese_wikipedia,
                    has_english_wikipedia=excluded.has_english_wikipedia,
                    source_fetched_at=excluded.source_fetched_at,
                    source_status=excluded.source_status,
                    open_data_match=excluded.open_data_match
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
                    source_status,
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

    response = await search_yahoo_catalog("京都", limit=100)
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
            tags={"yahoo_genre_code": hit.place.genre_code},
        )
        for hit in response.results
    ]
    if not places:
        return 0
    target_path = path or database_path()
    if _cached_popularity_is_fresh(target_path, places):
        return len(places)
    async with httpx.AsyncClient(timeout=30.0, headers={"User-Agent": POPULARITY_USER_AGENT}) as client:
        source_status = "ok"
        try:
            wikidata, place_qids = await _fetch_yahoo_wikidata(client, places)
        except (httpx.HTTPError, ValueError) as error:
            logger.warning(
                "Yahoo candidate Wikidata enrichment failed: %s",
                type(error).__name__,
            )
            wikidata = {}
            place_qids = {}
            source_status = "partial"
        places = [
            place.model_copy(
                update={
                    "tags": {
                        **place.tags,
                        **(
                            {
                                "wikidata": place_qids[place.id],
                                "wikipedia": (
                                    f"ja:{wikidata[place_qids[place.id]]['jaTitle']}"
                                    if wikidata[place_qids[place.id]].get("jaTitle")
                                    else ""
                                ),
                                    }
                            if place.id in place_qids
                            else {}
                        ),
                    }
                }
            )
            for place in places
        ]
        pageviews: dict[str, int] = {}
        for place in places:
            row = wikidata.get(_wikidata_id(place) or "", {})
            title = row.get("jaTitle") or _wikipedia_title(place, "ja")
            if title:
                try:
                    pageviews[place.id] = await _fetch_pageviews(client, title, "ja")
                except (httpx.HTTPError, ValueError):
                    pageviews[place.id] = _cached_pageview(target_path, place.id)
                    source_status = "partial"
                    logger.warning(
                        "Wikipedia pageview refresh failed for Yahoo place %s",
                        place.id,
                    )
    _upsert_results(target_path, places, wikidata, pageviews, source_status)
    return len(places)


def _cached_popularity_is_fresh(path: Path, places: list[Place]) -> bool:
    if not places:
        return True
    target = initialize_database(path)
    cutoff = _now() - WIKIDATA_TTL
    with closing(sqlite3.connect(target)) as connection:
        rows = connection.execute(
            """
            SELECT popularity.place_id, popularity.source_fetched_at,
                   popularity.source_status, scores.score_version
            FROM place_popularity AS popularity
            LEFT JOIN place_scores AS scores USING (place_id)
            """
        ).fetchall()
    fetched: dict[str, tuple[datetime, str, str | None]] = {}
    for place_id, timestamp, source_status, score_version in rows:
        try:
            fetched[place_id] = (
                datetime.fromisoformat(timestamp),
                source_status,
                score_version,
            )
        except ValueError:
            continue
    return all(
        place.id in fetched
        and fetched[place.id][0] >= cutoff
        and fetched[place.id][1] == "ok"
        and fetched[place.id][2] == POPULARITY_SCORE_VERSION
        for place in places
    )


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
        rows = connection.execute(
            """
            SELECT scores.place_id, scores.total_score
            FROM place_scores AS scores
            JOIN place_popularity AS popularity USING (place_id)
            WHERE scores.score_version = ? AND popularity.source_status = 'ok'
            """,
            (POPULARITY_SCORE_VERSION,),
        ).fetchall()
    return {place_id: float(score) for place_id, score in rows}
