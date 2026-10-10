import argparse
import asyncio
from datetime import UTC, datetime
from itertools import combinations
import json
import logging
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.models import Place, PlaceSearchHit, RouteIdeaResponse
from app.poi_search import search_yahoo_catalog
from app.search import PREFECTURE_NAMES

OUTPUT_PATH = BACKEND_DIR / "data" / "fallback_dataset.json"
GENRE_CODES = ("0424001", "0424002", "0305003", "0305007", "01")
ROUTES_PER_PREFECTURE = 5
logger = logging.getLogger("national_fallback_dataset")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate five offline swipe ideas for each Japanese prefecture."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_PATH,
        help="Output JSON path (defaults to backend/data/fallback_dataset.json).",
    )
    return parser.parse_args()


def _distance_km(first: Place, second: Place) -> float:
    latitude_delta = radians(second.latitude - first.latitude)
    longitude_delta = radians(second.longitude - first.longitude)
    haversine = (
        sin(latitude_delta / 2) ** 2
        + cos(radians(first.latitude))
        * cos(radians(second.latitude))
        * sin(longitude_delta / 2) ** 2
    )
    return 6371.0 * 2 * asin(sqrt(haversine))


def _place_themes(hit: PlaceSearchHit) -> list[str]:
    text = f"{hit.place.name} {hit.place.category}".casefold()
    themes: set[str] = set()
    if hit.place.genre_code.startswith("0424") or any(
        term in text for term in ("寺", "神社", "寺院", "shrine", "temple")
    ):
        themes.update(("temple", "history"))
    if hit.place.genre_code.startswith("0305003") or any(
        term in text for term in ("歴史", "博物館", "文化財", "museum", "historic")
    ):
        themes.add("history")
    if hit.place.genre_code.startswith("0305007") or any(
        term in text for term in ("自然", "公園", "庭園", "park", "nature")
    ):
        themes.add("nature")
    if hit.place.genre_code.startswith("01") or any(
        term in text for term in ("飲食", "レストラン", "カフェ", "市場", "food", "cafe")
    ):
        themes.add("food")
    return sorted(themes)


def _to_place(hit: PlaceSearchHit, prefecture_code: str, prefecture_name: str) -> Place:
    source = hit.place
    return Place(
        id=source.id,
        name=source.name,
        category=source.category,
        description=source.description,
        access_point="座標から経路検索",
        latitude=source.latitude,
        longitude=source.longitude,
        themes=_place_themes(hit),
        address=source.address,
        tags={
            **source.tags,
            "yahoo_genre_code": source.genre_code,
            "prefecture_code": prefecture_code,
            "prefecture_name": prefecture_name,
        },
    )


def _ideas_for_prefecture(
    prefecture_code: str,
    prefecture_name: str,
    hits: list[PlaceSearchHit],
) -> list[RouteIdeaResponse]:
    unique_hits = list({hit.place.id: hit for hit in hits}.values())
    places = [_to_place(hit, prefecture_code, prefecture_name) for hit in unique_hits]
    place_by_id = {place.id: place for place in places}
    pairs = sorted(
        (
            (_distance_km(first, second), first.id, second.id)
            for first, second in combinations(places, 2)
        ),
        key=lambda pair: (pair[0], pair[1], pair[2]),
    )
    selected_pairs: list[tuple[str, str]] = []
    seen_signatures: set[tuple[str, str]] = set()
    for distance, first_id, second_id in pairs:
        if distance > 25:
            continue
        signature = tuple(sorted((first_id, second_id)))
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        selected_pairs.append((first_id, second_id))
        if len(selected_pairs) == ROUTES_PER_PREFECTURE:
            break
    if len(selected_pairs) != ROUTES_PER_PREFECTURE:
        raise RuntimeError(
            f"{prefecture_name} ({prefecture_code}) has only {len(selected_pairs)} "
            "distinct nearby spot pairs; dataset was not written."
        )

    ideas = []
    for first_id, second_id in selected_pairs:
        first = place_by_id[first_id]
        second = place_by_id[second_id]
        ideas.append(
            RouteIdeaResponse(
                theme="all",
                prefecture_code=prefecture_code,
                prefecture_name=prefecture_name,
                title=f"{first.name}から{second.name}へ、{prefecture_name}のよりみち",
                story=f"{prefecture_name}の{first.category}「{first.name}」と"
                f"{second.category}「{second.name}」を巡るルートです。",
                places=[first, second],
                copywriting_source="fallback",
                note="Yahoo! Local Searchの施設情報をもとに事前生成したサンプルです。"
                "営業状況・施設間の実際の徒歩経路は各施設の公式情報をご確認ください。",
            )
        )
    return ideas


async def _generate_ideas() -> list[RouteIdeaResponse]:
    ideas: list[RouteIdeaResponse] = []
    for index, prefecture_name in enumerate(PREFECTURE_NAMES, start=1):
        prefecture_code = f"{index:02d}"
        query = prefecture_name
        result = await search_yahoo_catalog(query, limit=100, genre_codes=GENRE_CODES)
        prefecture_hits = [
            hit
            for hit in result.results
            if hit.place.region == prefecture_name
            or hit.place.address.startswith(prefecture_name)
        ]
        if len(prefecture_hits) < 4:
            raise RuntimeError(
                f"{prefecture_name} ({prefecture_code}) returned too few matching "
                f"Yahoo! Local Search results ({len(prefecture_hits)}); dataset was not written."
            )
        prefecture_ideas = _ideas_for_prefecture(
            prefecture_code,
            prefecture_name,
            prefecture_hits,
        )
        ideas.extend(prefecture_ideas)
        logger.info(
            "%s (%s): created %d/%d ideas",
            prefecture_name,
            prefecture_code,
            len(prefecture_ideas),
            ROUTES_PER_PREFECTURE,
        )
    return ideas


async def main() -> None:
    args = _arguments()
    ideas = await _generate_ideas()
    expected_count = len(PREFECTURE_NAMES) * ROUTES_PER_PREFECTURE
    if len(ideas) != expected_count:
        raise RuntimeError(f"Expected {expected_count} ideas, generated {len(ideas)}.")
    payload = {
        "version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "ideas": [idea.model_dump(mode="json") for idea in ideas],
    }
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f"{output.name}.tmp")
    temporary_output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_output.replace(output)
    logger.info("Saved %d cards for all 47 prefectures to %s", len(ideas), output)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        asyncio.run(main())
    except (OSError, RuntimeError) as error:
        logger.error("%s", error)
        raise SystemExit(1) from error
