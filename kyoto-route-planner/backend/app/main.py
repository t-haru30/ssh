import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import random
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from app.database import database_path, initialize_database
from app.copywriting import generate_route_copywriting
from app.ekispert import search_route
from app.osrm import fetch_detailed_polyline
from app.itinerary import plan_itinerary, plan_overnight_itinerary
from app.yahoo_local import (
    get_yahoo_status,
    search_yahoo_place_catalog,
    search_yahoo_places,
)
from app.models import (
    ItineraryRequest,
    ItinerarySuggestion,
    OvernightItineraryRequest,
    OvernightItinerarySuggestion,
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
app.add_middleware(GZipMiddleware, minimum_size=1024)
ROUTE_REQUEST_BUDGET_SECONDS = 55.0
RANDOM_ROUTE_THEMES = ("history", "nature", "food")
YAHOO_THEME_QUERIES = {
    "all": "京都 観光",
    "history": "京都 歴史 文化",
    "temple": "京都 神社 寺院",
    "nature": "京都 自然 景色",
    "food": "京都 食 グルメ",
}


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
    return await search_yahoo_place_catalog(request.query)


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
        candidates = await asyncio.wait_for(
            search_yahoo_places(
                YAHOO_THEME_QUERIES[request.theme],
                latitude=origin.latitude,
                longitude=origin.longitude,
                distance_m=10_000,
                limit=60,
            ),
            timeout=remaining_seconds,
        )
        selected_sets = choose_place_sets(
            request.theme,
            request.stop_count,
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
            except asyncio.TimeoutError:
                timed_out = True
                break
            suggestions.append(
                    RouteSuggestion(
                        places=chosen,
                        origin=origin,
                        legs=legs,
                        total_minutes=total_minutes,
                        departure_time=departure_time or request.departure_time.strftime("%H:%M"),
                                                arrival_time=arrival_time or None,
                        coordinates=await fetch_detailed_polyline([
                            [origin.latitude, origin.longitude],
                            *[[p.latitude, p.longitude] for p in chosen],
                            [origin.latitude, origin.longitude],
                        ]),
                        note=(
                            "スポットの順番は近接性にもとづく候補です。公共交通の経路・時刻は駅すぱあとAPIの検索結果です。"
                            "地点から最寄り駅までのアクセス時間は直線距離からの概算で、実際の徒歩道順ではありません。"
                        ),
                    ),
                )


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
            except asyncio.TimeoutError:
                timed_out = True
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
