import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, time as datetime_time
from math import asin, cos, radians, sin, sqrt
import os
from pathlib import Path
import random
import time

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.database import database_path, initialize_database
from app.copywriting import generate_route_copywriting
from app.ekispert import search_route
from app.idea_service import generate_random_idea
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
    RouteSuggestion,
    RouteTimelineItem,
    RouteTimelineSpot,
    RouteTimelineTransit,
    RouteSuggestions,
    RouteSuggestionRequest,
    RouteIdeaResponse,
    Theme,
)

from app.places import choose_place_sets, list_origins, normalize_origin_name


logger = logging.getLogger(__name__)


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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    yield


RATE_LIMIT_STORAGE_URI = os.getenv("RATE_LIMIT_STORAGE_URI", "memory://").strip()
if os.getenv("K_SERVICE") and not RATE_LIMIT_STORAGE_URI.startswith(("redis://", "rediss://")):
    raise RuntimeError(
        "Cloud Runでは共有レート制限ストレージが必要です。"
        "RATE_LIMIT_STORAGE_URIにRedis接続URIを設定してください。"
    )

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
RANDOM_ROUTE_THEMES = ("history", "nature", "food")
ROUTE_SEARCH_QUERIES: dict[Theme, str] = {
    "all": "京都",
    "history": "京都",
    "temple": "京都",
    "nature": "京都",
    "food": "京都",
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
    "all": "気ままな京都",
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


async def _route_candidates(theme: Theme) -> tuple[list[Place], str]:
    query = ROUTE_SEARCH_QUERIES[theme]
    search = await search_yahoo_catalog(
        query,
        limit=100,
        genre_codes=ROUTE_GENRE_CODES[theme],
    )
    additional_hits: list[PlaceSearchHit] = []
    if theme in {"all", "history", "temple"}:
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


@app.get("/api/routes/random", response_model=RouteSuggestions)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_random_route(request: Request) -> RouteSuggestions:
    departure = datetime.now().replace(second=0, microsecond=0)
    request = RouteSuggestionRequest(
        origin=list_origins()[0].name,
        theme=random.choice(RANDOM_ROUTE_THEMES),
        stop_count=random.randint(1, 3),
        departure_date=departure.date(),
        departure_time=departure.time(),
        variation=random.randint(1, 2_147_483_647),
    )
    return await _recommend_routes(request, max_routes=1)


@app.get("/api/ideas/random", response_model=RouteIdeaResponse)
@limiter.shared_limit("20/minute", scope="paid-external-api")
@limiter.limit("5/minute")
async def recommend_random_idea(
    request: Request,
    theme: Theme | None = None,
    spot_count: int | None = Query(default=None, ge=2, le=3),
) -> RouteIdeaResponse:
    """Yahoo! POIと任意のGeminiコピーのみを使う軽量なスワイプ候補。"""
    selected_theme = theme or random.choice(RANDOM_ROUTE_THEMES)
    candidates, candidate_note = await _route_candidates(selected_theme)
    return await generate_random_idea(
        theme=selected_theme,
        theme_label=IDEA_THEME_LABELS[selected_theme],
        requested_count=spot_count,
        candidates=candidates,
        candidate_note=candidate_note,
    )


async def _recommend_routes(
    request: RouteSuggestionRequest,
    max_routes: int = 1,
) -> RouteSuggestions:
    deadline = time.monotonic() + ROUTE_REQUEST_BUDGET_SECONDS
    try:
        origin = next(
            (
                item
                for item in list_origins()
                if normalize_origin_name(item.name) == normalize_origin_name(request.origin)
            ),
            None,
        )
        if origin is None:
            raise ValueError("出発駅を選び直してください。")
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise asyncio.TimeoutError
        candidates, candidate_note = await asyncio.wait_for(
            _route_candidates(request.theme),
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
                f"{origin.latitude},{origin.longitude}",
                *(f"{place.latitude},{place.longitude}" for place in chosen),
                f"{origin.latitude},{origin.longitude}",
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
                suggestions.append(
                    RouteSuggestion(
                        places=chosen,
                        origin=origin,
                        legs=legs,
                        total_minutes=total_minutes,
                        departure_time=departure_time or request.departure_time.strftime("%H:%M"),
                        arrival_time=arrival_time or None,
                        timeline=_build_route_timeline(
                            origin,
                            chosen,
                            departure_time or request.departure_time.strftime("%H:%M"),
                            total_minutes,
                        ),
                        coordinates=[
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ],
                        note=(
                            "スポットの順番は近接性にもとづく候補です。公共交通の経路・時刻は駅すぱあとAPIの検索結果です。"
                            "タイムラインの区間別移動時間は総移動時間を直線距離で按分した目安で、滞在時間は各90分です。"
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
