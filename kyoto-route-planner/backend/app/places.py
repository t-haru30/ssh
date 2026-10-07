from math import asin, cos, log10, radians, sin, sqrt
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


def _has_tag(tags: dict[str, str], key: str) -> bool:
    return bool(tags.get(key, "").strip())


def _numeric_tag_score(tags: dict[str, str], key: str, maximum: float) -> float:
    try:
        value = float(tags.get(key, ""))
    except ValueError:
        return 0.0
    return min(max(value, 0.0) / maximum, 1.0) * 100


def calculate_place_score(place: Place, theme: Theme) -> float:
    """Return an OSM-only prominence proxy, not a user-review rating."""
    tags = place.tags
    score = 0.0

    score += 20 if _has_tag(tags, "wikipedia") else 0
    score += 15 if _has_tag(tags, "wikidata") else 0
    score += 8 if _has_tag(tags, "website") else 0
    score += 3 if _has_tag(tags, "name:ja") else 0
    score += 2 if _has_tag(tags, "opening_hours") else 0

    if tags.get("tourism") == "attraction":
        score += 15
    if tags.get("historic") or tags.get("heritage") or tags.get("heritage:operator"):
        score += 15
    if tags.get("historic") == "castle" or tags.get("heritage") == "2":
        score += 5

    is_food = tags.get("amenity") in {
        "restaurant",
        "cafe",
        "fast_food",
        "food_court",
        "bar",
        "pub",
    } or tags.get("shop") in {"bakery", "confectionery", "marketplace"}
    is_lodging = tags.get("tourism") in {"hotel", "guest_house", "hostel", "ryokan"}
    if is_food:
        score += 10
        score += 5 if _has_tag(tags, "cuisine") else 0
        score += 5 if _has_tag(tags, "brand") else 0
    if is_lodging:
        score += 10
        score += _numeric_tag_score(tags, "stars", 5) * 0.10
        try:
            beds = float(tags.get("beds", ""))
        except ValueError:
            beds = 0.0
        score += min(log10(max(beds, 0.0) + 1), 3) / 3 * 5

    if theme != "all" and theme in place.themes:
        score += 10
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
) -> float:
    distance = _distance_km(current, (place.latitude, place.longitude))
    proximity_score = max(0.0, 100.0 - distance / 2.0 * 100.0)
    popularity_score = cached_scores.get(place.id, calculate_place_score(place, theme))
    return popularity_score * 0.75 + proximity_score * 0.25


def choose_places(
    theme: Theme,
    stop_count: int,
    origin_name: str,
    candidates: list[Place],
    database: Path | None = None,
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
    cached_scores = load_cached_scores(database)
    current = (origin.latitude, origin.longitude)
    while remaining and len(selected) < stop_count:
        closest = min(
            remaining,
            key=lambda place: (
                -_selection_score(place, theme, current, cached_scores),
                place.id,
            ),
        )
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
    database: Path | None = None,
) -> list[list[Place]]:
    first_route = choose_places(theme, stop_count, origin_name, candidates, database)
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
                    -cached_scores.get(place.id, calculate_place_score(place, theme)),
                    -origin_distance(place),
                    place.id,
                ),
            )
        else:
            ranked = sorted(
                unused,
                key=lambda place: (
                    place.category in used_categories,
                    -cached_scores.get(place.id, calculate_place_score(place, theme)),
                    abs(origin_distance(place) - midpoint),
                    place.id,
                ),
            )

        selected = [ranked[0]]
        available = [place for place in ranked[1:] if place.id != selected[0].id]
        while available and len(selected) < stop_count:
            current = selected[-1]
            next_place = min(
                available,
                key=lambda place: (
                    place.category in {selected_place.category for selected_place in selected},
                    -cached_scores.get(place.id, calculate_place_score(place, theme)),
                    _distance_km(
                        (current.latitude, current.longitude),
                        (place.latitude, place.longitude),
                    ),
                    place.id,
                ),
            )
            selected.append(next_place)
            available.remove(next_place)
        if len(selected) == stop_count:
            routes.append(selected)
            used_ids.update(place.id for place in selected)
            used_categories.update(place.category for place in selected)

    return routes