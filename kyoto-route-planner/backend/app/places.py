import random
from math import asin, cos, radians, sin, sqrt

from fastapi import HTTPException

from app.models import Origin, Place, Theme


ORIGINS = [
    Origin(name="京都駅", latitude=34.98585, longitude=135.75877),
]


def normalize_origin_name(value: str) -> str:
    return value.strip().replace(" ", "").replace("駅", "")


def _normalize_origin_name(value: str) -> str:
    return normalize_origin_name(value)


def list_origins() -> list[Origin]:
    return ORIGINS.copy()


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


def choose_places(
    theme: Theme,
    stop_count: int,
    origin_name: str,
    candidates: list[Place],
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
        if place.themes and (theme == "all" or theme in place.themes)
    ]
    if not remaining:
        raise ValueError("OpenStreetMap\u306e\u53d6\u5f97\u30c7\u30fc\u30bf\u306b\u9078\u629e\u3057\u305f\u30c6\u30fc\u30de\u306e\u30b3\u30f3\u30c9\u304c\u3042\u308a\u307e\u305b\u3093\u3002")

    selected: list[Place] = []
    current = (origin.latitude, origin.longitude)
    rng = random.SystemRandom()
    while remaining and len(selected) < stop_count:
        ranked = sorted(
            remaining,
            key=lambda place: _distance_km(
                current,
                (place.latitude, place.longitude),
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
                f"OpenStreetMap\u306e\u53d6\u5f97\u30c7\u30fc\u30bf\u304b\u3089\u7acb\u3061\u5bc4\u308a\u5148\u304c{len(selected)}\u4ef6\u3057\u304b\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f\u3002"
                "\u7acb\u3061\u5bc4\u308a\u4ef6\u6570\u307e\u305f\u306f\u30c6\u30fc\u30de\u3092\u5909\u66f4\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
            ),
        )

    return selected


def choose_place_sets(
    theme: Theme,
    stop_count: int,
    origin_name: str,
    candidates: list[Place],
    max_routes: int = 3,
) -> list[list[Place]]:
    first_route = choose_places(theme, stop_count, origin_name, candidates)
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
        if place.themes and (theme == "all" or theme in place.themes)
    ]
    routes = [first_route]
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
            ranked = sorted(unused, key=lambda place: -origin_distance(place))
        else:
            ranked = sorted(
                unused,
                key=lambda place: abs(origin_distance(place) - midpoint),
            )

        category_options = [
            place for place in ranked
            if place.category not in used_categories
        ]
        first_pool = category_options or ranked
        selected = [random.SystemRandom().choice(first_pool[: min(5, len(first_pool))])]
        available = [place for place in ranked if place.id != selected[0].id]
        while available and len(selected) < stop_count:
            current = selected[-1]
            selected_categories = {selected_place.category for selected_place in selected}
            next_ranked = sorted(
                available,
                key=lambda place: (
                    place.category in selected_categories,
                    _distance_km(
                        (current.latitude, current.longitude),
                        (place.latitude, place.longitude),
                    ),
                ),
            )
            next_place = random.SystemRandom().choice(next_ranked[: min(5, len(next_ranked))])
            selected.append(next_place)
            available.remove(next_place)
        if len(selected) == stop_count:
            routes.append(selected)
            used_ids.update(place.id for place in selected)
            used_categories.update(place.category for place in selected)

    return routes