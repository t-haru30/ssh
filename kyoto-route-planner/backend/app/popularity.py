import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

from app.database import database_path, initialize_database
from app.models import Place, Theme

WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
WIKIMEDIA_PAGEVIEWS_URL = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
POPULARITY_SCORE_VERSION = "v2"
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
    response = await client.get(
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
    response = await client.get(url, headers={"User-Agent": POPULARITY_USER_AGENT})
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


def _upsert_results(
    path: Path,
    places: list[Place],
    wikidata: dict[str, dict[str, str]],
    pageviews: dict[str, int],
) -> None:
    target = initialize_database(path)
    fetched_at = _now().isoformat()
    with closing(sqlite3.connect(target)) as connection:
        for place in places:
            qid = _wikidata_id(place)
            row = wikidata.get(qid or "", {})
            ja_title = row.get("jaTitle") or _wikipedia_title(place, "ja")
            en_title = row.get("enTitle") or _wikipedia_title(place, "en")
            views = pageviews.get(place.id, 0)
            osm_score = _osm_score(place)
            wikidata_score = _wikidata_score(row)
            total_score = osm_score * 0.35 + wikidata_score * 0.25 + _log_score(views) * 0.20
            connection.execute(
                """
                INSERT INTO place_popularity (
                    place_id, wikidata_id, wikipedia_ja_title, wikipedia_en_title,
                    wikipedia_sitelink_count, wikipedia_pageviews_30d,
                    has_japanese_wikipedia, has_english_wikipedia,
                    source_fetched_at, source_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')
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
                """,
                (
                    place.id,
                    qid,
                    ja_title,
                    en_title,
                    int(row.get("sitelinks", "0") or 0),
                    views,
                    int(bool(ja_title)),
                    int(bool(en_title)),
                    fetched_at,
                ),
            )
            connection.execute(
                """
                INSERT INTO place_scores (
                    place_id, osm_score, wikidata_score, pageview_score,
                    total_score, score_version, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(place_id) DO UPDATE SET
                    osm_score=excluded.osm_score,
                    wikidata_score=excluded.wikidata_score,
                    pageview_score=excluded.pageview_score,
                    total_score=excluded.total_score,
                    score_version=excluded.score_version,
                    calculated_at=excluded.calculated_at
                """,
                (place.id, osm_score, wikidata_score, _log_score(views), total_score, POPULARITY_SCORE_VERSION, fetched_at),
            )
        connection.commit()


def _osm_score(place: Place) -> float:
    from app.places import calculate_place_score

    return calculate_place_score(place, "all")


async def sync_popularity(path: Path | None = None) -> int:
    from app.overpass import list_osm_places

    places = await list_osm_places(path)
    qids = sorted({qid for place in places if (qid := _wikidata_id(place))})
    async with httpx.AsyncClient(timeout=30.0, headers={"User-Agent": POPULARITY_USER_AGENT}) as client:
        wikidata = await _fetch_wikidata(client, qids)
        pageviews: dict[str, int] = {}
        for place in places:
            row = wikidata.get(_wikidata_id(place) or "", {})
            title = row.get("jaTitle") or _wikipedia_title(place, "ja")
            if title:
                pageviews[place.id] = await _fetch_pageviews(client, title, "ja")
    _upsert_results(path or database_path(), places, wikidata, pageviews)
    return len(places)


def load_cached_scores(path: Path | None = None) -> dict[str, float]:
    target = initialize_database(path or database_path())
    with closing(sqlite3.connect(target)) as connection:
        rows = connection.execute("SELECT place_id, total_score FROM place_scores").fetchall()
    return {place_id: float(score) for place_id, score in rows}
