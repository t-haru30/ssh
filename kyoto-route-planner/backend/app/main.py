import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import random
import time

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from app.database import initialize_database
from app.ekispert import search_route
from app.itinerary import plan_itinerary
from app.overpass import (
    get_osm_status,
    list_osm_places,
    search_osm_places,
)
from app.models import (
    ItineraryRequest,
    ItinerarySuggestion,
    PlaceSearchRequest,
    PlaceSearchResponse,
    RouteSuggestion,
    RouteSuggestions,
    RouteSuggestionRequest,
)
from app.places import choose_place_sets, list_origins, normalize_origin_name


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    yield


app = FastAPI(title="京都よりみちルート", version="1.0.0", lifespan=lifespan)
ROUTE_SEARCH_BUDGET_SECONDS = 45.0
RANDOM_ROUTE_THEMES = ("history", "nature", "food")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/places")
async def places():
    return [
        place
        for place in await list_osm_places()
        if place.themes
    ][:60]


@app.get("/api/origins")
def origins():
    return list_origins()


@app.get("/api/places/status")
def places_status():
    return get_osm_status()


@app.post("/api/search/places", response_model=PlaceSearchResponse)
async def search_place_catalog(request: PlaceSearchRequest) -> PlaceSearchResponse:
    return await search_osm_places(request.query)


@app.post("/api/itineraries", response_model=ItinerarySuggestion)
async def recommend_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
    return await plan_itinerary(request)


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
    )
    return await _recommend_routes(request, max_routes=1)


async def _recommend_routes(
    request: RouteSuggestionRequest,
    max_routes: int = 3,
) -> RouteSuggestions:
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
        candidates = await list_osm_places()
        selected_sets = choose_place_sets(
            request.theme,
            request.stop_count,
            request.origin,
            candidates,
            max_routes=max_routes,
        )
    except (StopIteration, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error) or "出発駅を選び直してください。") from error

    suggestions: list[RouteSuggestion] = []
    deadline = time.monotonic() + ROUTE_SEARCH_BUDGET_SECONDS
    timed_out = False
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
                        note=(
                            "スポットの順番は近接性にもとづく候補です。公共交通の経路・時刻は駅すぱあとAPIの検索結果です。"
                            "地点から最寄り駅までのアクセス時間は直線距離からの概算で、実際の徒歩道順ではありません。"
                        ),
                    ),
                )
                break
            except HTTPException as error:
                last_error = error
                if error.status_code != 404:
                    raise
                if stop_count == 1:
                    break
            except asyncio.TimeoutError:
                timed_out = True
                break
        if timed_out:
            break
        if last_error is not None and last_error.status_code != 404:
            raise last_error

    if not suggestions:
        if timed_out:
            raise HTTPException(
                status_code=504,
                detail="複数ルートの検索がタイムアウトしました。時間をおいて再度お試しください。",
            )
        raise HTTPException(status_code=404, detail="指定した条件の経路を見つけられませんでした。")
    return RouteSuggestions(routes=suggestions)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
