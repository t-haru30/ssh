import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, time as datetime_time, timedelta
from math import asin, cos, radians, sin, sqrt
import os
from pathlib import Path
import random
import time
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.database import database_path, initialize_database
from app.copywriting import generate_route_copywriting
from app.ekispert import (
    estimate_route_fare,
    find_nearby_stations,
    find_nearest_train_station,
    search_route,
)
from app.fallback_ideas import load_fallback_ideas, select_fallback_ideas
from app.idea_service import generate_idea_from_places
from app.itinerary import plan_itinerary, plan_overnight_itinerary
from app.poi_search import get_yahoo_search_status, search_yahoo_catalog
from app.models import (
    ItineraryRequest,
    ItinerarySuggestion,
    Origin,
    OvernightItineraryRequest,
    OvernightItinerarySuggestion,
    Place,
    PlaceSearchHit,
    PlaceSearchRequest,
    PlaceSearchResponse,
    RouteLeg,
    RoutePreviewRequest,
    RouteSuggestion,
    RouteTimelineItem,
    RouteTimelineSpot,
    RouteTimelineTransit,
    RouteSuggestions,
    RouteSuggestionRequest,
    RouteIdeaResponse,
    RouteIdeaBatchResponse,
    Theme,
)

from app.places import choose_place_sets, list_origins, resolve_origin


logger = logging.getLogger(__name__)
DAY_TRIP_RETURN_BY = datetime_time(19, 0)


def _format_timeline_time(total_minutes: int) -> str:
    minutes_in_day = total_minutes % (24 * 60)
    return f"{minutes_in_day // 60:02d}:{minutes_in_day % 60:02d}"


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


def _build_route_timeline(
    origin: Origin,
    places: list[Place],
    departure_time: str,
    total_minutes: int | None,
) -> list[RouteTimelineItem]:
    departure = datetime_time.fromisoformat(departure_time)
    current_minutes = departure.hour * 60 + departure.minute
    timeline: list[RouteTimelineItem] = [
        RouteTimelineSpot(
            role="start",
            name=origin.name,
            category="出発地",
            time=_format_timeline_time(current_minutes),
        )
    ]
    points = [
        (origin.latitude, origin.longitude),
        *((place.latitude, place.longitude) for place in places),
        (origin.latitude, origin.longitude),
    ]
    distances = [
        _distance_km(start, end)
        for start, end in zip(points, points[1:])
    ]
    duration_total = max(0, total_minutes or 0)
    distance_total = sum(distances)
    if distance_total > 0:
        durations = [
            int(duration_total * distance / distance_total)
            for distance in distances
        ]
    else:
        durations = [duration_total // len(distances)] * len(distances)
    if durations:
        durations[-1] += duration_total - sum(durations)

    for index, place in enumerate(places):
        duration = durations[index] if total_minutes is not None else None
        transit_start = _format_timeline_time(current_minutes)
        if duration is not None:
            current_minutes += duration
        transit_end = (
            _format_timeline_time(current_minutes)
            if duration is not None
            else None
        )
        timeline.append(
            RouteTimelineTransit(
                from_name=origin.name if index == 0 else places[index - 1].name,
                to_name=place.name,
                transit_line="公共交通機関",
                start_time=transit_start if duration is not None else None,
                end_time=transit_end,
                duration_minutes=duration,
            )
        )
        timeline.append(
            RouteTimelineSpot(
                role="stop",
                place_id=place.id,
                name=place.name,
                category=place.category,
                time=(
                    _format_timeline_time(current_minutes)
                    if total_minutes is not None
                    else None
                ),
                stay_minutes=ROUTE_STOP_STAY_MINUTES,
            )
        )
        current_minutes += ROUTE_STOP_STAY_MINUTES

    return_duration = durations[-1] if total_minutes is not None else None
    return_start = _format_timeline_time(current_minutes)
    if return_duration is not None:
        current_minutes += return_duration
    timeline.append(
        RouteTimelineTransit(
            from_name=places[-1].name if places else origin.name,
            to_name=origin.name,
            transit_line="公共交通機関",
            start_time=return_start if return_duration is not None else None,
            end_time=(
                _format_timeline_time(current_minutes)
                if return_duration is not None
                else None
            ),
            duration_minutes=return_duration,
        )
    )
    timeline.append(
        RouteTimelineSpot(
            role="finish",
            name=origin.name,
            category="帰着",
            time=(
                _format_timeline_time(current_minutes)
                if total_minutes is not None
                else None
            ),
        )
    )
    return timeline


def _clock_minutes(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = datetime_time.fromisoformat(value)
    except ValueError:
        return None
    return parsed.hour * 60 + parsed.minute


def _duration_between(start: str | None, end: str | None) -> int | None:
    start_minutes = _clock_minutes(start)
    end_minutes = _clock_minutes(end)
    if start_minutes is None or end_minutes is None:
        return None
    return (end_minutes - start_minutes) % (24 * 60)


async def _search_route_segment(
    from_point: str,
    to_point: str,
    departure_date: str,
    departure_time: str,
) -> tuple[list[RouteLeg], int | None, str | None, str | None]:
    return await search_route(
        via_points=[from_point, to_point],
        departure_date=departure_date,
        departure_time=departure_time,
    )


async def _correct_route_timeline(
    timeline: list[RouteTimelineItem],
    origin: Origin,
    places: list[Place],
    departure_date: str,
    *,
    timeout: float,
) -> list[RouteTimelineItem]:
    transits = [item for item in timeline if isinstance(item, RouteTimelineTransit)]
    if not transits:
        return timeline

    origin_point = f"{origin.latitude},{origin.longitude}"
    point_names = [origin_point]
    point_names.extend(
        f"{place.latitude},{place.longitude}" for place in places
    )
    point_names.append(origin_point)
    requests = [
        _search_route_segment(
            point_names[index],
            point_names[index + 1],
            departure_date,
            transit.start_time or "00:00",
        )
        for index, transit in enumerate(transits)
    ]

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*requests, return_exceptions=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.warning("Ekispert per-segment route correction timed out")
        return timeline

    corrected: list[RouteTimelineItem] = []
    transit_index = 0
    for item in timeline:
        if not isinstance(item, RouteTimelineTransit):
            corrected.append(item)
            continue

        result = results[transit_index]
        transit_index += 1
        if isinstance(result, HTTPException):
            logger.warning(
                "Ekispert route correction failed for one segment: status=%d",
                result.status_code,
            )
            corrected.append(item)
            continue
        if isinstance(result, Exception):
            raise result

        legs, total_minutes, departure, arrival = result
        line_names = list(dict.fromkeys(
            leg.line_name.strip() for leg in legs if leg.line_name.strip()
        ))
        actual_departure = departure or item.start_time
        actual_arrival = arrival or item.end_time
        if not line_names and actual_departure == item.start_time and actual_arrival == item.end_time:
            corrected.append(item)
            continue
        corrected.append(item.model_copy(update={
            "transit_line": " / ".join(line_names) or "公共交通機関",
            "start_time": actual_departure,
            "end_time": actual_arrival,
            "duration_minutes": (
                _duration_between(actual_departure, actual_arrival)
                if actual_departure and actual_arrival
                else total_minutes if total_minutes is not None
                else item.duration_minutes
            ),
            "is_estimate": not bool(departure and arrival),
        }))

    synchronized: list[RouteTimelineItem] = []
    latest_arrival: str | None = None
    first_departure = next(
        (
            item.start_time
            for item in corrected
            if isinstance(item, RouteTimelineTransit) and item.start_time
        ),
        None,
    )
    for item in corrected:
        if isinstance(item, RouteTimelineTransit):
            latest_arrival = item.end_time
            synchronized.append(item)
        elif isinstance(item, RouteTimelineSpot):
            spot_time = (
                first_departure
                if item.role == "start"
                else latest_arrival or item.time
            )
            synchronized.append(item.model_copy(update={"time": spot_time}))
        else:
            synchronized.append(item)
    return synchronized


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    _app.state.fallback_ideas = load_fallback_ideas()
    yield


RATE_LIMIT_STORAGE_URI = os.getenv("RATE_LIMIT_STORAGE_URI", "memory://").strip()
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=RATE_LIMIT_STORAGE_URI,
    swallow_errors=False,
)
app = FastAPI(title="京都よりみちルート", version="1.0.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(GZipMiddleware, minimum_size=1024)
ROUTE_REQUEST_BUDGET_SECONDS = 55.0
ROUTE_STOP_STAY_MINUTES = 90
ROUTE_TIMELINE_VERSION = 1
MAX_REALTIME_IDEAS_PER_REQUEST = 2
REALTIME_IDEA_TIMEOUT_SECONDS = 8.0
RANDOM_ROUTE_THEMES = ("history", "nature", "food")
ROUTE_SEARCH_QUERIES: dict[Theme, str] = {
    "all": "観光",
    "history": "歴史 史跡",
    "temple": "神社 寺",
    "nature": "公園 自然 景色",
    "food": "グルメ 食事",
}
ROUTE_GENRE_CODES: dict[Theme, tuple[str, ...]] = {
    "all": (
        "0424001", "0424002", "0305002", "0305003", "0305007",
        "0303002", "0303003", "0303004",
    ),
    "history": ("0424001", "0424002", "0305002", "0305003"),
    "temple": ("0424001", "0424002"),
    "nature": ("0305007", "0303002", "0303003", "0303004"),
    "food": ("01",),
}
ROUTE_PRIORITY_LANDMARKS = {
    "清水寺": "0424001",
    "平安神宮": "0424002",
}
IDEA_THEME_LABELS: dict[Theme, str] = {
    "all": "気ままな旅",
    "history": "歴史と文化",
    "temple": "神社と寺院",
    "nature": "自然と景色",
    "food": "食と街歩き",
}


def _route_themes(name: str, category: str, genre_code: str = "") -> list[Theme]:
    text = f"{name} {category}".casefold()
    themes: set[Theme] = set()
    if genre_code.startswith("0424") or any(
        term in text
        for term in ("神社", "寺", "寺院", "temple", "shrine", "place_of_worship")
    ):
        themes.update(("temple", "history"))
    if genre_code.startswith(("0305002", "0305003")) or any(
        term in text
        for term in (
            "歴史", "史跡", "文化財", "城", "博物館", "美術館", "名所",
            "historic", "museum", "castle", "attraction",
        )
    ):
        themes.add("history")
    if genre_code.startswith(("0305007", "0303002", "0303003", "0303004")) or any(
        term in text
        for term in (
            "公園", "庭園", "自然", "山", "川", "森林", "植物園",
            "park", "garden", "nature", "mountain", "forest",
        )
    ):
        themes.add("nature")
    if genre_code.startswith("01") or any(
        term in text
        for term in (
            "飲食", "レストラン", "カフェ", "食堂", "市場", "商店街", "パン",
            "restaurant", "cafe", "food", "market", "bakery",
        )
    ):
        themes.add("food")
    return sorted(themes)


def _route_place_from_search_hit(hit: PlaceSearchHit) -> Place:
    catalog_place = hit.place
    return Place(
        id=catalog_place.id,
        name=catalog_place.name,
        category=catalog_place.category,
        description=catalog_place.description,
        access_point="座標から経路検索",
        latitude=catalog_place.latitude,
        longitude=catalog_place.longitude,
        themes=_route_themes(
            catalog_place.name,
            catalog_place.category,
            catalog_place.genre_code,
        ),
        address=catalog_place.address,
        tags={"yahoo_genre_code": catalog_place.genre_code},
    )


async def _route_candidates(
    theme: Theme,
    origin: Origin | None = None,
) -> tuple[list[Place], str]:
    query = ROUTE_SEARCH_QUERIES[theme] if origin else "京都"
    search = await search_yahoo_catalog(
        query,
        limit=100,
        genre_codes=ROUTE_GENRE_CODES[theme],
        **(
            {"center": (origin.latitude, origin.longitude), "radius_m": 20_000}
            if origin else {}
        ),
    )
    additional_hits: list[PlaceSearchHit] = []
    near_kyoto = origin is None or _distance_km(
        (origin.latitude, origin.longitude),
        (34.98585, 135.75877),
    ) <= 30
    if near_kyoto and theme in {"all", "history", "temple"}:
        for name, genre_code in ROUTE_PRIORITY_LANDMARKS.items():
            if any(hit.place.name == name for hit in search.results):
                continue
            landmark_search = await search_yahoo_catalog(
                name,
                limit=100,
                genre_codes=(genre_code,),
            )
            additional_hits.extend(
                hit for hit in landmark_search.results if hit.place.name == name
            )
    candidates = [
        _route_place_from_search_hit(hit)
        for hit in (*search.results, *additional_hits)
        if theme == "all"
        or theme
        in _route_themes(
            hit.place.name,
            hit.place.category,
            hit.place.genre_code,
        )
    ]
    logger.info("Route candidate provider selected: Yahoo Local Search (%d results)", len(candidates))
    if not candidates:
        raise HTTPException(
            status_code=404,
            detail=search.note or "Yahoo!ローカルサーチで条件に合う候補が見つかりませんでした。",
        )
    return candidates, f"候補地検索: {search.note}"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "route_timeline_version": str(ROUTE_TIMELINE_VERSION),
    }


@app.get("/api/places")
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("20/minute")
async def places(request: Request, keyword: str = "京都 観光", category: str | None = None):
    """Yahoo!ローカルサーチAPIの候補地のみを返す。"""
    query = f"{keyword} {category}" if category else keyword
    result = await search_yahoo_catalog(query, limit=60)
    return [_route_place_from_search_hit(hit) for hit in result.results]


@app.get("/api/origins")
def origins():
    return list_origins()


@app.get("/api/origins/nearest", response_model=Origin)
async def nearest_origin(
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
) -> Origin:
    name, station_latitude, station_longitude = await find_nearest_train_station(
        latitude,
        longitude,
    )
    return Origin(
        name=name,
        latitude=station_latitude,
        longitude=station_longitude,
    )


@app.get("/api/nearby-stations", response_model=list[Origin])
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("10/minute")
async def nearby_stations(
    request: Request,
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
) -> list[Origin]:
    return await find_nearby_stations(latitude, longitude)


@app.get("/api/places/status")
def places_status():
    return get_yahoo_search_status()


@app.post("/api/search/places", response_model=PlaceSearchResponse)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("10/minute")
async def search_place_catalog(
    request: Request,
    payload: PlaceSearchRequest,
) -> PlaceSearchResponse:
    return await search_yahoo_catalog(payload.query)


@app.post("/api/itineraries", response_model=ItinerarySuggestion)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_itinerary(
    request: Request,
    payload: ItineraryRequest,
) -> ItinerarySuggestion:
    return await plan_itinerary(payload)


@app.post("/api/itineraries/overnight", response_model=OvernightItinerarySuggestion)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("2/minute")
async def recommend_overnight_itinerary(
    request: Request,
    payload: OvernightItineraryRequest,
) -> OvernightItinerarySuggestion:
    return await plan_overnight_itinerary(payload)



@app.post("/api/routes", response_model=RouteSuggestions)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("10/minute")
async def recommend_route(
    request: Request,
    payload: RouteSuggestionRequest,
) -> RouteSuggestions:
    return await _recommend_routes(payload)


@app.post("/api/routes/preview", response_model=RouteSuggestion)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("10/minute")
async def preview_route(
    request: Request,
    payload: RoutePreviewRequest,
) -> RouteSuggestion:
    deadline = time.monotonic() + ROUTE_REQUEST_BUDGET_SECONDS
    departure_time = payload.departure_time.strftime("%H:%M")
    via_points = [
        f"{payload.origin.latitude},{payload.origin.longitude}",
        *(f"{place.latitude},{place.longitude}" for place in payload.places),
        f"{payload.origin.latitude},{payload.origin.longitude}",
    ]
    try:
        legs, total_minutes, actual_departure, actual_arrival = await asyncio.wait_for(
            search_route(
                via_points=via_points,
                departure_date=payload.departure_date.isoformat(),
                departure_time=departure_time,
            ),
            timeout=max(0.001, deadline - time.monotonic()),
        )
    except asyncio.TimeoutError as error:
        raise HTTPException(
            status_code=504,
            detail="経路検索がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error

    timeline = _build_route_timeline(
        payload.origin,
        payload.places,
        actual_departure or departure_time,
        total_minutes,
    )
    remaining_seconds = deadline - time.monotonic()
    if remaining_seconds > 0:
        timeline = await _correct_route_timeline(
            timeline,
            payload.origin,
            payload.places,
            payload.departure_date.isoformat(),
            timeout=remaining_seconds,
        )
    else:
        logger.warning(
            "Ekispert preview correction skipped: request budget exhausted"
        )

    return RouteSuggestion(
        places=payload.places,
        origin=payload.origin,
        legs=legs,
        total_minutes=total_minutes,
        departure_time=actual_departure or departure_time,
        arrival_time=actual_arrival,
        timeline=timeline,
        coordinates=[
            [payload.origin.latitude, payload.origin.longitude],
            *[[place.latitude, place.longitude] for place in payload.places],
            [payload.origin.latitude, payload.origin.longitude],
        ],
        note=(
            "区間ごとの路線名・発着時刻は駅すぱあとAPIの検索結果です。"
            "区間検索で経路が見つからない場合は時刻の目安を表示します。"
        ),
    )


@app.get("/api/routes/random", response_model=RouteSuggestions)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_random_route(
    request: Request,
    origin: str = Query(default="京都駅", min_length=1, max_length=80),
    origin_latitude: float | None = Query(default=None, ge=-90, le=90),
    origin_longitude: float | None = Query(default=None, ge=-180, le=180),
) -> RouteSuggestions:
    departure = datetime.now().replace(second=0, microsecond=0)
    random_request = RouteSuggestionRequest(
        origin=origin,
        origin_latitude=origin_latitude,
        origin_longitude=origin_longitude,
        theme=random.choice(RANDOM_ROUTE_THEMES),
        stop_count=random.randint(1, 3),
        departure_date=departure.date(),
        departure_time=departure.time(),
        variation=random.randint(1, 2_147_483_647),
    )
    return await _recommend_routes(random_request, max_routes=1)


@app.get("/api/ideas/random", response_model=RouteIdeaResponse)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_random_idea(
    request: Request,
    theme: Theme | None = None,
    spot_count: int | None = Query(default=None, ge=2, le=3),
    use_fallback: bool = False,
    prefecture_code: str | None = Query(
        default=None,
        pattern=r"^(0[1-9]|[1-3][0-9]|4[0-7])$",
    ),
    exclude: list[Annotated[str, Field(min_length=1, max_length=600)]] = Query(
        default=[],
        max_length=50,
    ),
) -> RouteIdeaResponse:
    """Return one live idea when available, falling back to the local dataset."""
    selected_theme = theme or random.choice(RANDOM_ROUTE_THEMES)
    batch = await _provide_idea_batch(
        request=request,
        theme=selected_theme,
        count=1,
        spot_count=spot_count,
        use_fallback=use_fallback,
        exclude=exclude,
        prefecture_code=prefecture_code,
    )
    return batch.ideas[0]


@app.get("/api/ideas", response_model=RouteIdeaBatchResponse)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_ideas(
    request: Request,
    theme: Theme | None = None,
    count: int = Query(default=5, ge=1, le=10),
    spot_count: int | None = Query(default=None, ge=2, le=3),
    use_fallback: bool = False,
    prefecture_code: str | None = Query(
        default=None,
        pattern=r"^(0[1-9]|[1-3][0-9]|4[0-7])$",
    ),
    exclude: list[Annotated[str, Field(min_length=1, max_length=600)]] = Query(
        default=[],
        max_length=50,
    ),
) -> RouteIdeaBatchResponse:
    """Return a batch of ideas and use local cards to fill any live-generation gaps."""
    selected_theme = theme or random.choice(RANDOM_ROUTE_THEMES)
    return await _provide_idea_batch(
        request=request,
        theme=selected_theme,
        count=count,
        spot_count=spot_count,
        use_fallback=use_fallback,
        exclude=exclude,
        prefecture_code=prefecture_code,
    )


async def _provide_idea_batch(
    request: Request,
    theme: Theme,
    count: int,
    spot_count: int | None,
    use_fallback: bool,
    exclude: list[str],
    prefecture_code: str | None = None,
) -> RouteIdeaBatchResponse:
    live_ideas: list[RouteIdeaResponse] = []
    excluded_signatures = {
        tuple(sorted(signature.split("|")))
        for signature in exclude
        if 2 <= len(signature.split("|")) <= 3
        and all(signature_part for signature_part in signature.split("|"))
    }
    fallback_pool = getattr(request.app.state, "fallback_ideas", [])
    if not use_fallback and prefecture_code is None:
        deadline = time.monotonic() + REALTIME_IDEA_TIMEOUT_SECONDS
        try:
            candidates, candidate_note = await asyncio.wait_for(
                _route_candidates(theme),
                timeout=max(0.001, deadline - time.monotonic()),
            )
            if len(candidates) < 2:
                raise HTTPException(
                    status_code=404,
                    detail="アイデア提案には2件以上のスポットが必要です。",
                )
            realtime_count = min(count, MAX_REALTIME_IDEAS_PER_REQUEST)
            attempted: set[tuple[str, ...]] = set()
            for _ in range(realtime_count * 3):
                if len(live_ideas) >= realtime_count:
                    break
                places = random.sample(
                    candidates,
                    min(spot_count or random.randint(2, 3), len(candidates)),
                )
                signature = tuple(sorted(place.id for place in places))
                if signature in attempted or signature in excluded_signatures:
                    continue
                attempted.add(signature)
                remaining_seconds = deadline - time.monotonic()
                if remaining_seconds <= 0:
                    raise asyncio.TimeoutError
                idea = await asyncio.wait_for(
                    generate_idea_from_places(
                        places=places,
                        theme=theme,
                        theme_label=IDEA_THEME_LABELS[theme],
                        candidate_note=candidate_note,
                    ),
                    timeout=remaining_seconds,
                )
                live_ideas.append(idea)
                excluded_signatures.add(signature)
        except asyncio.TimeoutError:
            logger.warning("Live swipe idea generation timed out; using local fallback cards")
        except HTTPException as error:
            logger.warning(
                "Live swipe idea generation failed; using local fallback cards: status=%d",
                error.status_code,
            )

    fallback_ideas = select_fallback_ideas(
        fallback_pool,
        count - len(live_ideas),
        theme,
        excluded_signatures,
        prefecture_code,
    )
    for idea in fallback_ideas:
        live_ideas.append(idea.model_copy(update={
            "note": f"{idea.note} 事前生成済みのローカルデータから提案しています。".strip(),
        }))

    if not live_ideas:
        raise HTTPException(
            status_code=503,
            detail="利用できる提案がありません。事前データセットを生成するか、時間をおいて再度お試しください。",
        )
    if len(live_ideas) < count:
        logger.warning(
            "Only %d of %d requested swipe ideas are available; the fallback pool is exhausted",
            len(live_ideas),
            count,
        )
    return RouteIdeaBatchResponse(
        ideas=live_ideas,
        requested_count=count,
        shortfall=count - len(live_ideas),
        used_fallback=bool(fallback_ideas),
        fallback_count=len(fallback_ideas),
    )


async def _recommend_routes(
    request: RouteSuggestionRequest,
    max_routes: int = 1,
) -> RouteSuggestions:
    deadline = time.monotonic() + ROUTE_REQUEST_BUDGET_SECONDS
    try:
        origin = resolve_origin(
            request.origin,
            request.origin_latitude,
            request.origin_longitude,
        )
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise asyncio.TimeoutError
        candidates, candidate_note = await asyncio.wait_for(
            _route_candidates(request.theme, origin),
            timeout=remaining_seconds,
        )
        effective_stop_count = min(request.stop_count, len(candidates))
        selected_sets = choose_place_sets(
            request.theme,
            effective_stop_count,
            request.origin,
            candidates,
            max_routes=max_routes,
            database=database_path(),
            variation=request.variation,
            origin_coordinates=(origin.latitude, origin.longitude),
        )
    except (StopIteration, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error) or "出発駅を選び直してください。") from error
    except asyncio.TimeoutError as error:
        raise HTTPException(
            status_code=504,
            detail="ルート候補の取得がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error

    suggestions: list[RouteSuggestion] = []
    timed_out = False
    transient_error: HTTPException | None = None
    for selected in selected_sets[:max_routes]:
        last_error: HTTPException | None = None
        for stop_count in range(len(selected), 0, -1):
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                timed_out = True
                break
            chosen = selected[:stop_count]
            via_points = [
                origin.name.removesuffix("駅"),
                *(f"{place.latitude},{place.longitude}" for place in chosen),
                origin.name.removesuffix("駅"),
            ]
            try:
                legs, total_minutes, departure_time, arrival_time = await asyncio.wait_for(
                    search_route(
                        via_points=via_points,
                        departure_date=request.departure_date.isoformat(),
                        departure_time=request.departure_time.strftime("%H:%M"),
                    ),
                    timeout=remaining_seconds,
                )
                estimated_return = (
                    datetime.combine(request.departure_date, request.departure_time)
                    + timedelta(minutes=total_minutes)
                    if total_minutes is not None
                    else None
                )
                if estimated_return is not None and estimated_return.time() > DAY_TRIP_RETURN_BY:
                    last_error = HTTPException(
                        status_code=422,
                        detail="19:00までに出発駅へ戻れるルートが見つかりませんでした。",
                    )
                    continue
                timeline = _build_route_timeline(
                    origin,
                    chosen,
                    departure_time or request.departure_time.strftime("%H:%M"),
                    total_minutes,
                )
                remaining_seconds = deadline - time.monotonic()
                if remaining_seconds > 0:
                    timeline = await _correct_route_timeline(
                        timeline,
                        origin,
                        chosen,
                        request.departure_date.isoformat(),
                        timeout=remaining_seconds,
                    )
                else:
                    logger.warning(
                        "Ekispert per-segment route correction skipped: request budget exhausted"
                    )
                suggestions.append(
                    RouteSuggestion(
                        places=chosen,
                        origin=origin,
                        legs=legs,
                        total_minutes=total_minutes,
                        departure_time=departure_time or request.departure_time.strftime("%H:%M"),
                        arrival_time=arrival_time or None,
                        timeline=timeline,
                        coordinates=[
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ],
                        note=(
                            "スポットの順番は近接性にもとづく候補です。公共交通の経路・時刻は駅すぱあとAPIの検索結果です。"
                            "タイムラインの区間別発着時刻・路線名は区間ごとの駅すぱあとAPI検索結果で補正し、"
                            "経路が見つからない区間は総移動時間を直線距離で按分した目安を表示します。滞在時間は各90分です。"
                            "地点から最寄り駅までのアクセス時間は直線距離からの概算で、実際の徒歩道順ではありません。"
                            f"{candidate_note}"
                        ),
                    )
                )
                break
            except asyncio.TimeoutError:
                timed_out = True
                break
            except HTTPException as error:
                if error.status_code != 404:
                    if error.status_code in {502, 504}:
                        transient_error = error
                        break
                    raise
                last_error = error
                if stop_count == 1:
                    break
        if timed_out:
            break
        if transient_error is not None:
            break
        if last_error is not None and last_error.status_code != 404:
            raise last_error

    if not suggestions:
        if timed_out:
            raise HTTPException(
                status_code=504,
                detail="ルート検索がタイムアウトしました。時間をおいて再度お試しください。",
            )
        if transient_error is not None:
            raise transient_error
        raise HTTPException(status_code=404, detail="指定した条件の経路を見つけられませんでした。")
    for suggestion in suggestions:
        fare_via_points = [
            suggestion.origin.name.removesuffix("駅"),
            *(
                f"{place.latitude},{place.longitude}"
                for place in suggestion.places
            ),
            suggestion.origin.name.removesuffix("駅"),
        ]
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds > 0:
            try:
                suggestion.fare_yen = await asyncio.wait_for(
                    estimate_route_fare(fare_via_points),
                    timeout=remaining_seconds,
                )
            except asyncio.TimeoutError:
                logger.warning("Ekispert fare estimate timed out")
            except HTTPException as error:
                logger.warning(
                    "Ekispert fare estimate failed: status=%d",
                    error.status_code,
                )
        else:
            logger.warning("Ekispert fare estimate skipped: request budget exhausted")

        try:
            copywriting = await generate_route_copywriting(suggestion.places, request.theme)
        except HTTPException as error:
            logger.warning(
                "Gemini route copywriting failed; using fallback copy: status=%s",
                error.status_code,
            )
            copywriting = None
            suggestion.note += (
                " Geminiを利用できなかったため、スポット名から簡易タイトルと説明を作成しました。"
            )

        if copywriting is None:
            place_names = "と".join(place.name for place in suggestion.places)
            theme_label = IDEA_THEME_LABELS[request.theme]
            suggestion.title = f"{place_names}で楽しむ、{theme_label}"
            suggestion.story = (
                f"{theme_label}をテーマに、{place_names}を巡るルートです。"
            )
            if not os.getenv("GEMINI_API_KEY", "").strip():
                suggestion.note += " GEMINI_API_KEY未設定のため、簡易タイトルと説明を使用しています。"
        else:
            suggestion.title = copywriting.title
            suggestion.story = copywriting.story
    return RouteSuggestions(routes=suggestions)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
