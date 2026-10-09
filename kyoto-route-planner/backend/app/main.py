import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
import random
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from app.database import database_path, initialize_database
from app.copywriting import generate_route_copywriting
from app.ekispert import search_route
from app.image_search import search_pixabay_image
from app.itinerary import plan_itinerary, plan_overnight_itinerary
from app.poi_search import get_yahoo_search_status, search_yahoo_catalog
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
    RouteIdeaResponse,
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
    return {"status": "ok"}


@app.get("/api/places")
async def places(keyword: str = "京都 観光", category: str | None = None):
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
async def search_place_catalog(request: PlaceSearchRequest) -> PlaceSearchResponse:
    return await search_yahoo_catalog(request.query)


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


@app.get("/api/ideas/random", response_model=RouteIdeaResponse)
async def recommend_random_idea(
    theme: Theme | None = None,
    spot_count: int | None = Query(default=None, ge=2, le=3),
) -> RouteIdeaResponse:
    """Yahoo! POIと任意のGeminiコピーのみを使う軽量なスワイプ候補。"""
    selected_theme = theme or random.choice(RANDOM_ROUTE_THEMES)
    candidates, candidate_note = await _route_candidates(selected_theme)
    if len(candidates) < 2:
        raise HTTPException(
            status_code=404,
            detail="アイデア提案には2件以上のスポットが必要です。テーマを変更してください。",
        )

    requested_count = spot_count or random.randint(2, 3)
    places = random.sample(candidates, min(requested_count, len(candidates)))
    image_url = None
    for image_query in (places[0].name, f"京都 {IDEA_THEME_LABELS[selected_theme]}", "京都"):
        image_url = await search_pixabay_image(image_query)
        if image_url:
            break
    copywriting_source = "fallback"
    copywriting_note = "GEMINI_API_KEY未設定のため、簡易タイトルとストーリーを使用しています。"
    try:
        copywriting = await generate_route_copywriting(places, selected_theme)
    except HTTPException as error:
        logger.warning(
            "Gemini idea copywriting failed; using fallback copy: status=%s",
            error.status_code,
        )
        copywriting = None
        copywriting_note = "Geminiを利用できなかったため、簡易タイトルとストーリーを使用しています。"

    if copywriting is None:
        place_names = "と".join(place.name for place in places)
        title = f"{place_names}で楽しむ、{IDEA_THEME_LABELS[selected_theme]}"
        story = (
            f"{IDEA_THEME_LABELS[selected_theme]}をテーマに、"
            f"{place_names}を巡る寄り道アイデアです。"
        )
    else:
        title = copywriting.title
        story = copywriting.story
        copywriting_source = "gemini"
        copywriting_note = "Geminiがタイトルとストーリーを生成しました。"

    return RouteIdeaResponse(
        theme=selected_theme,
        title=title,
        story=story,
        places=places,
        image_url=image_url,
        copywriting_source=copywriting_source,
        note=f"{candidate_note} {copywriting_note}",
    )


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
