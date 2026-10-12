import random
from math import asin, cos, log10, radians, sin, sqrt
from pathlib import Path
import re

from fastapi import HTTPException

from app.models import Origin, Place, Theme
from app.popularity import load_cached_scores


ORIGINS = [
    Origin(name="京都駅", latitude=34.98585, longitude=135.75877),
    Origin(name="大阪駅", latitude=34.70248, longitude=135.49595),
    Origin(name="新大阪駅", latitude=34.73342, longitude=135.50002),
    Origin(name="三ノ宮駅", latitude=34.69491, longitude=135.19557),
    Origin(name="奈良駅", latitude=34.68169, longitude=135.81963),
    Origin(name="名古屋駅", latitude=35.17090, longitude=136.88170),
    Origin(name="東京駅", latitude=35.68123, longitude=139.76712),
]
PROMINENT_LANDMARKS = {
    "清水寺": 45.0,
    "平安神宮": 45.0,
    "伏見稲荷大社": 45.0,
    "金閣寺": 45.0,
    "鹿苑寺": 45.0,
    "銀閣寺": 45.0,
    "東寺": 40.0,
    "二条城": 45.0,
    "京都御所": 40.0,
}


def normalize_origin_name(value: str) -> str:
    return value.strip().replace(" ", "").replace("駅", "")


def _normalize_origin_name(value: str) -> str:
    return normalize_origin_name(value)


def list_origins() -> list[Origin]:
    return ORIGINS.copy()


def resolve_origin(
    name: str,
    latitude: float | None = None,
    longitude: float | None = None,
) -> Origin:
    if latitude is not None and longitude is not None:
        return Origin(name=name, latitude=latitude, longitude=longitude)
    origin = next(
        (
            item for item in ORIGINS
            if _normalize_origin_name(item.name) == _normalize_origin_name(name)
        ),
        None,
    )
    if origin is None:
        raise ValueError("出発駅を選び直してください。")
    return origin


UNSUITABLE_PLACE_PATTERN = re.compile(
    "墓園|墓地|霊園|霊苑|斎場|斎苑|火葬場|葬祭|葬儀|納骨|"
    "工場|工業団地|病院|医院|クリニック|診療所|発電所|処理場|清掃センター"
)
FAMOUS_GRAVEYARD_NAMES = ("奥の院", "奥之院")
FAME_EXCEPTION_SITELINKS = 10
NEUTRAL_FAME = 10.0
LINKED_FAME = 40.0
FAME_WEIGHT = 0.6
TOURISM_GENRE_PREFIXES = ("0424", "0305002", "0305003", "0303")
LANDMARK_SCORE_FLOOR = {45.0: 90.0, 40.0: 85.0}


def _sitelinks(place: Place) -> int | None:
    try:
        return int(place.tags["sitelinks"])
    except (KeyError, ValueError):
        return None


def is_unsuitable_place(place: Place) -> bool:
    """Exclude places that are not sightseeing destinations before scoring."""
    if not UNSUITABLE_PLACE_PATTERN.search(f"{place.name} {place.category}"):
        return False
    if any(name in place.name for name in FAMOUS_GRAVEYARD_NAMES):
        return False
    return (_sitelinks(place) or 0) < FAME_EXCEPTION_SITELINKS


def _fame_score(place: Place) -> tuple[float, bool]:
    """Return (0-100 fame, whether it came from measured signals)."""
    parts: list[float] = []
    sitelinks = _sitelinks(place)
    if sitelinks is not None:
        parts.append(min(100.0, log10(sitelinks + 1) / log10(101) * 100))
    try:
        pageviews = int(place.tags["pageviews_30d"])
    except (KeyError, ValueError):
        pageviews = None
    if pageviews is not None:
        parts.append(min(100.0, log10(pageviews + 1) / 6 * 100))
    if parts:
        return sum(parts) / len(parts), True
    if place.tags.get("wikidata", "").startswith("Q") or place.tags.get("wikipedia", "").strip():
        return LINKED_FAME, True
    # Unknown (e.g. external API failure) must not be treated as "unpopular".
    return NEUTRAL_FAME, False


def _landmark_boost(place: Place) -> float:
    normalized_name = re.sub(r"[\s　・]+", "", place.name)
    return max(
        (
            boost
            for landmark, boost in PROMINENT_LANDMARKS.items()
            if re.sub(r"[\s　・]+", "", landmark) in normalized_name
        ),
        default=0.0,
    )


def place_confidence(place: Place) -> float:
    """Information completeness (0-1). Not part of the tourism score."""
    filled = sum(
        bool(value.strip()) for value in (place.category, place.address, place.description)
    )
    return round(filled / 3 * 0.7 + (0.3 if _fame_score(place)[1] else 0.0), 3)


def score_breakdown(place: Place, theme: Theme) -> dict[str, float]:
    genre_code = place.tags.get("yahoo_genre_code", "")
    genre_fit = 25.0 if genre_code.startswith(TOURISM_GENRE_PREFIXES) else 15.0
    if theme != "all" and theme in place.themes:
        theme_fit = 20.0
    elif theme == "all" and place.themes:
        theme_fit = 8.0
    else:
        theme_fit = 0.0
    fame, fame_known = _fame_score(place)
    fame_points = fame * FAME_WEIGHT
    subtotal = genre_fit + theme_fit + fame_points
    boost = _landmark_boost(place)
    floor = LANDMARK_SCORE_FLOOR.get(boost, 0.0)
    landmark_adjustment = max(0.0, floor - subtotal)
    return {
        "genre_fit": round(genre_fit, 1),
        "theme_fit": round(theme_fit, 1),
        "fame": round(fame_points, 1),
        "landmark_floor": round(landmark_adjustment, 1),
        "total": round(min(subtotal + landmark_adjustment, 100.0), 1),
        "fame_measured": 1.0 if fame_known else 0.0,
        "confidence": place_confidence(place),
    }


def calculate_place_score(place: Place, theme: Theme) -> float:
    """Score by genre/theme fit and nationwide fame (Wikidata sitelinks, pageviews)."""
    return score_breakdown(place, theme)["total"]


def _distance_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    latitude_delta = radians(second[0] - first[0])
    longitude_delta = radians(second[1] - first[1])
    first_latitude = radians(first[0])
    second_latitude = radians(second[0])
    haversine = (
        sin(latitude_delta / 2) ** 2
        + cos(first_latitude) * cos(second_latitude) * sin(longitude_delta / 2) ** 2
    )
    return 6371.0 * 2 * asin(sqrt(haversine))


def _selection_score(
    place: Place,
    theme: Theme,
    current: tuple[float, float],
    cached_scores: dict[str, float],
    variation: int = 0,
) -> float:
    distance = _distance_km(current, (place.latitude, place.longitude))
    proximity_score = max(0.0, 100.0 - distance / 2.0 * 100.0)
    popularity_score = cached_scores.get(place.id, calculate_place_score(place, theme))
    base_score = popularity_score * 0.75 + proximity_score * 0.25
    if variation == 0:
        return base_score
    jitter = random.Random(f"{variation}:{place.id}").uniform(-7.0, 7.0)
    return base_score + jitter


def choose_places(
    theme: Theme,
    stop_count: int,
    origin_name: str,
    candidates: list[Place],
    database: Path | None = None,
    variation: int = 0,
    origin_coordinates: tuple[float, float] | None = None,
) -> list[Place]:
    origin = next(
        (
            item
            for item in ORIGINS
            if item.name == origin_name
            or _normalize_origin_name(item.name) == _normalize_origin_name(origin_name)
        ),
        None,
    )
    if origin is None and origin_coordinates is not None:
        origin = Origin(
            name=origin_name,
            latitude=origin_coordinates[0],
            longitude=origin_coordinates[1],
        )
    if origin is None:
        raise ValueError("出発駅を選び直してください。")

    remaining_by_id: dict[str, Place] = {}
    for place in candidates:
        if is_unsuitable_place(place):
            continue
        if theme == "all" or theme in place.themes:
            remaining_by_id.setdefault(place.id, place)
    remaining = list(remaining_by_id.values())
    if not remaining:
        raise ValueError("Yahoo!検索候補に選択したテーマのスポットがありません。")

    selected: list[Place] = []
    cached_scores = load_cached_scores(database)
    current = (origin.latitude, origin.longitude)
    while remaining and len(selected) < stop_count:
        ranked = sorted(
            remaining,
            key=lambda place: (
                -_selection_score(place, theme, current, cached_scores, variation),
                -place_confidence(place),
                place.id,
            ),
        )
        closest = ranked[0]
        selected.append(closest.model_copy(update={"score_breakdown": score_breakdown(closest, theme)}))
        remaining.remove(closest)
        current = (closest.latitude, closest.longitude)

    if len(selected) < stop_count:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Yahoo!検索で立ち寄り先が{len(selected)}件しか見つかりませんでした。"
                "立ち寄り件数またはテーマを変更してください。"
            ),
        )

    return selected


def choose_place_sets(
    theme: Theme,
    stop_count: int,
    origin_name: str,
    candidates: list[Place],
    max_routes: int = 3,
    database: Path | None = None,
    variation: int = 0,
    origin_coordinates: tuple[float, float] | None = None,
) -> list[list[Place]]:
    first_route = choose_places(
        theme,
        stop_count,
        origin_name,
        candidates,
        database,
        variation,
        origin_coordinates,
    )
    origin = next(
        (
            item
            for item in ORIGINS
            if item.name == origin_name
            or _normalize_origin_name(item.name) == _normalize_origin_name(origin_name)
        ),
        None,
    )
    if origin is None and origin_coordinates is not None:
        origin = Origin(
            name=origin_name,
            latitude=origin_coordinates[0],
            longitude=origin_coordinates[1],
        )
    if origin is None:
        raise ValueError("出発駅を選び直してください。")

    remaining = [
        place
        for place in candidates
        if not is_unsuitable_place(place)
        and (theme == "all" or theme in place.themes)
    ]
    routes = [first_route]
    rng = random.SystemRandom()
    cached_scores = load_cached_scores(database)
    used_ids = {place.id for place in first_route}
    used_categories = {place.category for place in first_route}
    route_targets = ("far", "middle")

    for target in route_targets[: max_routes - 1]:
        unused = [place for place in remaining if place.id not in used_ids]
        if len(unused) < stop_count:
            unused = remaining
        if len(unused) < stop_count:
            break

        def origin_distance(place: Place) -> float:
            return _distance_km(
                (origin.latitude, origin.longitude),
                (place.latitude, place.longitude),
            )

        distances = sorted(origin_distance(place) for place in unused)
        midpoint = distances[len(distances) // 2]
        if target == "far":
            ranked = sorted(
                unused,
                key=lambda place: (
                    place.category in used_categories,
                    -cached_scores.get(place.id, calculate_place_score(place, theme))
                    + random.Random(f"{variation}:{place.id}").uniform(-7.0, 7.0),
                    -origin_distance(place),
                    place.id,
                ),
            )
        else:
            ranked = sorted(
                unused,
                key=lambda place: (
                    place.category in used_categories,
                    -cached_scores.get(place.id, calculate_place_score(place, theme))
                    + random.Random(f"{variation}:{place.id}").uniform(-7.0, 7.0),
                    abs(origin_distance(place) - midpoint),
                    place.id,
                ),
            )

        category_options = [
            place for place in ranked
            if place.category not in used_categories
        ]
        first_pool = category_options or ranked
        selected = [rng.choice(first_pool[: min(5, len(first_pool))])]
        available = [place for place in ranked if place.id != selected[0].id]
        while available and len(selected) < stop_count:
            current = selected[-1]
            selected_categories = {selected_place.category for selected_place in selected}
            next_ranked = sorted(
                available,
                key=lambda place: (
                    place.category in selected_categories,
                    -cached_scores.get(place.id, calculate_place_score(place, theme))
                    + random.Random(f"{variation}:{place.id}").uniform(-7.0, 7.0),
                    _distance_km(
                        (current.latitude, current.longitude),
                        (place.latitude, place.longitude),
                    ),
                    place.id,
                ),
            )
            next_place = rng.choice(next_ranked[: min(5, len(next_ranked))])
            selected.append(next_place)
            available.remove(next_place)
        if len(selected) == stop_count:
            routes.append(selected)
            used_ids.update(place.id for place in selected)
            used_categories.update(place.category for place in selected)

    return [
        [
            place
            if place.score_breakdown is not None
            else place.model_copy(update={"score_breakdown": score_breakdown(place, theme)})
            for place in route
        ]
        for route in routes
    ]