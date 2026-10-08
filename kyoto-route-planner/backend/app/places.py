import random
from math import asin, cos, radians, sin, sqrt
from pathlib import Path

from fastapi import HTTPException

from app.models import Origin, Place, Theme
from app.popularity import load_cached_scores


ORIGINS = [
    Origin(name="京都駅", latitude=34.98585, longitude=135.75877),
]


def normalize_origin_name(value: str) -> str:
    return value.strip().replace(" ", "").replace("駅", "")


def _normalize_origin_name(value: str) -> str:
    return normalize_origin_name(value)


def list_origins() -> list[Origin]:
    return ORIGINS.copy()


def calculate_place_score(place: Place, theme: Theme) -> float:
    """Rank Yahoo-sourced places by available details and theme relevance."""
    score = 0.0
    score += 10 if place.category.strip() else 0
    score += 10 if place.address.strip() else 0
    score += 10 if place.description.strip() else 0
    if theme != "all" and theme in place.themes:
        score += 40
    elif theme == "all" and place.themes:
        score += 20
    return min(score, 100.0)


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
    if origin is None:
        raise ValueError("出発駅を選び直してください。")

    remaining = [
        place
        for place in candidates
        if theme == "all" or theme in place.themes
    ]
    if not remaining:
        raise ValueError("Yahoo!検索候補に選択したテーマのスポットがありません。")

    selected: list[Place] = []
    cached_scores = load_cached_scores(database)
    current = (origin.latitude, origin.longitude)
    rng = random.SystemRandom()
    while remaining and len(selected) < stop_count:
        ranked = sorted(
            remaining,
            key=lambda place: (
                -_selection_score(place, theme, current, cached_scores, variation),
                place.id,
            ),
        )
        closest = rng.choice(ranked[: min(5, len(ranked))])
        selected.append(closest)
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
) -> list[list[Place]]:
    first_route = choose_places(
        theme, stop_count, origin_name, candidates, database, variation
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
    if origin is None:
        raise ValueError("出発駅を選び直してください。")

    remaining = [
        place
        for place in candidates
        if theme == "all" or theme in place.themes
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

    return routes