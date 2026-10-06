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
    while remaining and len(selected) < stop_count:
        closest = min(
            remaining,
            key=lambda place: _distance_km(
                current,
                (place.latitude, place.longitude),
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