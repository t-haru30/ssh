import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
import random
import re
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from app.database import database_path, initialize_database
from app.copywriting import generate_route_copywriting
from app.ekispert import search_route
from app.itinerary import plan_itinerary, plan_overnight_itinerary
from app.yahoo_local import (
    get_yahoo_status,
    search_yahoo_places,
)
from app.overpass import list_osm_places
from app.poi_search import search_places_with_fallback
from app.models import (
    ItineraryRequest,
    ItinerarySuggestion,
    OvernightItineraryRequest,
    OvernightItinerarySuggestion,
    Place,
    PlaceSearchHit,
    PlaceSearchRequest,
    PlaceSearchResponse,
    RouteSuggestion,
    RouteSuggestions,
    RouteSuggestionRequest,
    Theme,
)

from app.places import choose_place_sets, list_origins, normalize_origin_name


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    yield


app = FastAPI(title="京都よりみちルート", version="1.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)
ROUTE_REQUEST_BUDGET_SECONDS = 55.0
RANDOM_ROUTE_THEMES = ("history", "nature", "food")
ROUTE_SEARCH_QUERIES: dict[Theme, str] = {
    "all": "京都 観光",
    "history": "京都府 歴史 文化財 博物館 城",
    "temple": "京都府 神社 寺院",
    "nature": "京都府 公園 庭園 自然",
    "food": "京都府 レストラン カフェ 食",
}


def _route_themes(name: str, category: str) -> list[Theme]:
    text = f"{name} {category}".casefold()
    themes: set[Theme] = set()
    if any(
        term in text
        for term in ("神社", "寺", "寺院", "temple", "shrine", "place_of_worship")
    ):
        themes.update(("temple", "history"))
    if any(
        term in text
        for term in (
            "歴史", "史跡", "文化財", "城", "博物館", "美術館", "名所",
            "historic", "museum", "castle", "attraction",
        )
    ):
        themes.add("history")
    if any(
        term in text
        for term in (
            "公園", "庭園", "自然", "山", "川", "森林", "植物園",
            "park", "garden", "nature", "mountain", "forest",
        )
    ):
        themes.add("nature")
    if any(
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
        themes=_route_themes(catalog_place.name, catalog_place.category),
        address=catalog_place.address,
    )


def _same_route_place(first: Place, second: Place) -> bool:
    first_name = re.sub(r"[\s　]+", "", first.name).casefold()
    second_name = re.sub(r"[\s　]+", "", second.name).casefold()
    if first_name != second_name:
        return False
    lat1, lat2 = radians(first.latitude), radians(second.latitude)
    lat_delta = radians(second.latitude - first.latitude)
    lon_delta = radians(second.longitude - first.longitude)
    haversine = sin(lat_delta / 2) ** 2 + cos(lat1) * cos(lat2) * sin(lon_delta / 2) ** 2
    return 6_371_000 * 2 * asin(sqrt(min(1.0, haversine))) <= 30


def _route_provider(candidates: list[Place]) -> str:
    yahoo_count = sum(place.id.startswith("yahoo-") for place in candidates)
    osm_count = len(candidates) - yahoo_count
    if yahoo_count and osm_count:
        return "Yahoo Local Search + Overpass"
    return "Yahoo Local Search" if yahoo_count else "Overpass"


async def _route_candidates(theme: Theme, stop_count: int) -> tuple[list[Place], str]:
    query = ROUTE_SEARCH_QUERIES[theme]
    search = await search_places_with_fallback(query, limit=100)
    candidates = [
        _route_place_from_search_hit(hit)
        for hit in search.results
        if theme == "all" or theme in _route_themes(hit.place.name, hit.place.category)
    ]
    if len(candidates) >= stop_count:
        provider = _route_provider(candidates)
        logger.info("Route candidate provider selected: %s (%d results)", provider, len(candidates))
        return candidates, f"候補地検索: {search.note}"

    try:
        osm_places = await list_osm_places()
    except HTTPException as error:
        if not candidates:
            raise
        provider = _route_provider(candidates)
        logger.warning(
            "Overpass route fallback unavailable; retaining %s candidates: %s",
            provider,
            error.detail,
        )
        logger.info(
            "Route candidate provider selected: %s (%d results)",
            provider,
            len(candidates),
        )
        return candidates, (
            f"Overpass APIが利用できないため、{provider}から取得した候補地を表示しています。"
        )

    combined = list(candidates)
    for place in osm_places:
        if not place.themes or (theme != "all" and theme not in place.themes):
            continue
        if not any(_same_route_place(existing, place) for existing in combined):
            combined.append(place)

    provider = _route_provider(combined)
    logger.info("Route candidate provider selected: %s (%d results)", provider, len(combined))
    return combined, "Yahoo!検索の候補を優先し、不足分をOverpass APIで補完しました。"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/places")
async def places(keyword: str = "京都 観光", category: str | None = None):
    """Yahoo!ローカルサーチAPIを優先し、失敗時はローカルサンプルを返す。"""
    return await search_yahoo_places(keyword, category_code=category, limit=60)


@app.get("/api/origins")
def origins():
    return list_origins()


@app.get("/api/places/status")
def places_status():
    return get_yahoo_status()


@app.post("/api/search/places", response_model=PlaceSearchResponse)
async def search_place_catalog(request: PlaceSearchRequest) -> PlaceSearchResponse:
    return await search_places_with_fallback(request.query)


@app.post("/api/itineraries", response_model=ItinerarySuggestion)
async def recommend_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
    return await plan_itinerary(request)


@app.post("/api/itineraries/overnight", response_model=OvernightItinerarySuggestion)
async def recommend_overnight_itinerary(request: OvernightItineraryRequest) -> OvernightItinerarySuggestion:
    return await plan_overnight_itinerary(request)



@app.post("/api/routes", response_model=RouteSuggestions)
async def recommend_route(request: RouteSuggestionRequest) -> RouteSuggestions:
    return await _recommend_routes(request)


@app.get("/api/routes/random", response_model=RouteSuggestions)
async def recommend_random_route() -> RouteSuggestions:
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


async def _recommend_routes(
    request: RouteSuggestionRequest,
    max_routes: int = 3,
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
            _route_candidates(request.theme, request.stop_count),
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
                        coordinates=[
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ],
                        note=(
                            "スポットの順番は近接性にもとづく候補です。公共交通の経路・時刻は駅すぱあとAPIの検索結果です。"
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
                detail="複数ルートの検索がタイムアウトしました。時間をおいて再度お試しください。",
            )
        if transient_error is not None:
            raise transient_error
        raise HTTPException(status_code=404, detail="指定した条件の経路を見つけられませんでした。")
    for suggestion in suggestions:
        copywriting = await generate_route_copywriting(suggestion.places, request.theme)
        if copywriting is not None:
            suggestion.title = copywriting.title
            suggestion.story = copywriting.story
    return RouteSuggestions(routes=suggestions)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
