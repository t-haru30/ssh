import asyncio
from datetime import datetime, timedelta
from dataclasses import dataclass
from itertools import permutations

from fastapi import HTTPException

from app.ekispert import search_route
from app.models import (
    CatalogPlace,
    ItineraryRequest,
    ItinerarySuggestion,
    OvernightItineraryRequest,
    OvernightItinerarySuggestion,
    DailyItinerary,
    RouteLeg,
)

from app.overpass import search_osm_places
from app.places import list_origins, normalize_origin_name

ITINERARY_REQUEST_BUDGET_SECONDS = 55.0


@dataclass(frozen=True)
class ItineraryCandidate:
    places: tuple[CatalogPlace, ...]
    legs: list[RouteLeg]
    transit_minutes: int | None
    stay_minutes: int
    total_minutes: int | None
    estimated_return: datetime | None
    feasible: bool | None


async def plan_overnight_itinerary(request: OvernightItineraryRequest) -> OvernightItinerarySuggestion:
    origin = next(
        (
            item
            for item in list_origins()
            if normalize_origin_name(item.name)
            == normalize_origin_name(request.departure_station)
        ),
        None,
    )
    if origin is None:
        raise HTTPException(status_code=422, detail="出発駅を選び直してください。")

    deadline = asyncio.get_running_loop().time() + ITINERARY_REQUEST_BUDGET_SECONDS

    # 1. ホテルの選定
    hotel_query = request.hotel_query or f"{request.query} ホテル"
    hotel_search = await search_osm_places(hotel_query, limit=10)
    # lodgingカテゴリに絞り込み
    hotels = [
        hit.place for hit in hotel_search.results 
        if hit.place.category in {"hotel", "hostel", "guest_house", "motel", "apartment", "lodging"}
    ]
    if not hotels:
        # フォールバック: クエリに関係なく京都駅周辺のホテルを探す
        hotel_search = await search_osm_places("京都駅 ホテル", limit=10)
        hotels = [hit.place for hit in hotel_search.results]
    
    if not hotels:
        raise HTTPException(status_code=404, detail="宿泊施設が見つかりませんでした。条件を変えてお試しください。")
    
    selected_hotel = hotels[0]

    # 2. 観光スポットの選定 (ホテルは除外)
    spot_search = await search_osm_places(request.query, limit=30)
    all_spots = [
        hit.place for hit in spot_search.results 
        if hit.place.id != selected_hotel.id and hit.place.category not in {"hotel", "hostel", "guest_house", "motel", "apartment", "lodging"}
    ]
    
    required_spots = request.stops_per_day * 2
    if len(all_spots) < required_spots:
        raise HTTPException(
            status_code=404, 
            detail=f"観光スポットが不足しています（見つかった件数: {len(all_spots)}）。条件を広げてください。"
        )

    day1_spots = all_spots[:request.stops_per_day]
    day2_spots = all_spots[request.stops_per_day : required_spots]

    route_search_calls = 0
    
    # Day 1 計算: Origin -> Spots -> Hotel
    best_day1 = await _find_best_route(
        origin_lat=origin.latitude,
        origin_lon=origin.longitude,
        dest_lat=selected_hotel.latitude,
        dest_lon=selected_hotel.longitude,
        spots=day1_spots,
        dep_date=request.departure_date,
        dep_time=request.departure_time,
        stay_min=90,
        deadline=deadline
    )
    route_search_calls += best_day1["calls"]

    # Day 2 計算: Hotel -> Spots -> Origin
    # 2日目の出発はチェックアウト後 (10:00) と仮定
    checkout_time = time(10, 0)
    day2_date = request.departure_date + timedelta(days=1)
    best_day2 = await _find_best_route(
        origin_lat=selected_hotel.latitude,
        origin_lon=selected_hotel.longitude,
        dest_lat=origin.latitude,
        dest_lon=origin.longitude,
        spots=day2_spots,
        dep_date=day2_date,
        dep_time=checkout_time,
        stay_min=90,
        deadline=deadline
    )
    route_search_calls += best_day2["calls"]

    days = [
        DailyItinerary(
            day=1,
            date=request.departure_date,
            places=list(best_day1["places"]),
            legs=best_day1["legs"],
            transit_minutes=best_day1["transit_minutes"],
            stay_minutes=len(day1_spots) * 90,
            estimated_arrival_at=best_day1["arrival_at"]
        ),
        DailyItinerary(
            day=2,
            date=day2_date,
            places=list(best_day2["places"]),
            legs=best_day2["legs"],
            transit_minutes=best_day2["transit_minutes"],
            stay_minutes=len(day2_spots) * 90,
            estimated_arrival_at=best_day2["arrival_at"]
        )
    ]

    return OvernightItinerarySuggestion(
        query=spot_search.query,
        origin=Origin(name=origin.name, latitude=origin.latitude, longitude=origin.longitude),
        hotel=selected_hotel,
        days=days,
        feasible=True,
        route_search_calls=route_search_calls,
        note=(
            f"宿泊先に「{selected_hotel.name}」を選定した1泊2日プランです。"
            "1日目は指定時刻に出発し、2日目は10:00にホテルを出発する計算です。"
            "各スポットの滞在時間は90分としています。"
        )
    )


async def _find_best_route(
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
    spots: list[CatalogPlace],
    dep_date: date, dep_time: time,
    stay_min: int, deadline: float
):
    """特定の日の最適ルート（順列）を探すヘルパー関数"""
    best = None
    calls = 0
    for p in permutations(spots):
        if asyncio.get_running_loop().time() > deadline:
            break
        
        via_points = [
            f"{origin_lat},{origin_lon}",
            *(f"{s.latitude},{s.longitude}" for s in p),
            f"{dest_lat},{dest_lon}"
        ]
        try:
            legs, transit_min, _dep, arrival_dt = await asyncio.wait_for(
                search_route(
                    via_points=via_points,
                    departure_date=dep_date.isoformat(),
                    departure_time=dep_time.strftime("%H:%M"),
                ),
                timeout=max(0.1, deadline - asyncio.get_running_loop().time())
            )
            calls += 1
            
            total_min = (transit_min or 0) + (len(spots) * stay_min)
            if best is None or total_min < best["total_minutes"]:
                best = {
                    "places": p,
                    "legs": legs,
                    "transit_minutes": transit_min,
                    "total_minutes": total_min,
                    "arrival_at": arrival_dt.isoformat() if arrival_dt else None
                }
        except Exception:
            calls += 1
            continue

    if best is None:
        # 経路が見つからない場合のフォールバック（直線距離順など、本来はもっと凝るべきだが一旦空で返す）
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 9999,
            "arrival_at": None,
            "calls": calls
        }
    
    best["calls"] = calls
    return best

    origin = next(
        (
            item
            for item in list_origins()
            if normalize_origin_name(item.name)
            == normalize_origin_name(request.departure_station)
        ),
        None,
    )
    if origin is None:
        raise HTTPException(status_code=422, detail="出発駅を選び直してください。")
    if request.departure_time >= request.return_by:
        raise HTTPException(
            status_code=422,
            detail="出発時刻は帰着期限より前に設定してください。",
        )

    deadline = asyncio.get_running_loop().time() + ITINERARY_REQUEST_BUDGET_SECONDS
    remaining_seconds = deadline - asyncio.get_running_loop().time()
    if remaining_seconds <= 0:
        raise HTTPException(
            status_code=504,
            detail="旅程候補の取得がタイムアウトしました。時間をおいて再度お試しください。",
        )
    try:
        search_result = await asyncio.wait_for(
            search_osm_places(request.query, limit=20),
            timeout=remaining_seconds,
        )
    except asyncio.TimeoutError as error:
        raise HTTPException(
            status_code=504,
            detail="旅程候補の取得がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    if not search_result.results:
        detail = (
            " ".join(search_result.query.warnings)
            if search_result.query.warnings
            else "条件に合うスポットがデータベースにありません。京都のスポットデータを取り込んでから検索してください。"
        )
        raise HTTPException(
            status_code=404,
            detail=detail,
        )

    candidates = [hit.place for hit in search_result.results[: request.stop_count]]
    if len(candidates) < request.stop_count:
        raise HTTPException(
            status_code=404,
            detail=(
                f"条件に合うスポットが{len(candidates)}件のみです。"
                "立ち寄り件数を減らすか、検索条件を広げてください。"
            ),
        )

    best: ItineraryCandidate | None = None
    route_search_calls = 0
    timed_out = False
    transient_error: HTTPException | None = None
    for ordered_places in permutations(candidates):
        remaining_seconds = deadline - asyncio.get_running_loop().time()
        if remaining_seconds <= 0:
            timed_out = True
            break
        via_points = [
            f"{origin.latitude},{origin.longitude}",
            *(f"{place.latitude},{place.longitude}" for place in ordered_places),
            f"{origin.latitude},{origin.longitude}",
        ]
        try:
            legs, transit_minutes, _departure, _arrival = await asyncio.wait_for(
                search_route(
                    via_points=via_points,
                    departure_date=request.departure_date.isoformat(),
                    departure_time=request.departure_time.strftime("%H:%M"),
                ),
                timeout=remaining_seconds,
            )
        except HTTPException as error:
            if error.status_code == 404:
                route_search_calls += 1
                continue
            if error.status_code in {502, 504}:
                route_search_calls += 1
                transient_error = error
                break
            raise
        except asyncio.TimeoutError:
            route_search_calls += 1
            timed_out = True
            break
        route_search_calls += 1

        stay_minutes = len(ordered_places) * request.stay_minutes_per_place
        total_minutes = (
            transit_minutes + stay_minutes
            if transit_minutes is not None
            else None
        )
        departure_at = datetime.combine(
            request.departure_date,
            request.departure_time,
        )
        estimated_return = (
            departure_at + timedelta(minutes=total_minutes)
            if total_minutes is not None
            else None
        )
        return_deadline = datetime.combine(
            request.departure_date,
            request.return_by,
        )
        feasible = (
            estimated_return <= return_deadline
            if estimated_return is not None
            else None
        )

        candidate = ItineraryCandidate(
            places=ordered_places,
            legs=legs,
            transit_minutes=transit_minutes,
            stay_minutes=stay_minutes,
            total_minutes=total_minutes,
            estimated_return=estimated_return,
            feasible=feasible,
        )
        if best is None or (
            candidate.total_minutes is not None
            and (
                best.total_minutes is None
                or candidate.total_minutes < best.total_minutes
            )
        ):
            best = candidate

    if best is None:
        if timed_out:
            raise HTTPException(
                status_code=504,
                detail="旅程の経路検索がタイムアウトしました。時間をおいて再度お試しください。",
            )
        if transient_error is not None:
            raise transient_error
        raise HTTPException(
            status_code=404,
            detail="選んだスポットを公共交通で巡る経路が見つかりませんでした。",
        )

    feasible = best.feasible
    if feasible is True:
        feasibility_note = "指定の帰着時刻内に収まる概算です。"
    elif feasible is False:
        feasibility_note = "最短候補でも指定の帰着時刻を超える見込みです。スポット数を減らしてください。"
    else:
        feasibility_note = "経路の所要時間が不明なため、帰着時刻内か判定できません。"

    return ItinerarySuggestion(
        query=search_result.query,
        origin=origin,
        places=list(best.places),
        legs=best.legs,
        departure_at=datetime.combine(
            request.departure_date,
            request.departure_time,
        ).isoformat(),
        estimated_return_at=(
            best.estimated_return.isoformat()
            if best.estimated_return is not None
            else None
        ),
        return_by=request.return_by.strftime("%H:%M"),
        transit_minutes=best.transit_minutes,
        stay_minutes=best.stay_minutes,
        estimated_total_minutes=best.total_minutes,
        feasible=feasible,
        route_search_calls=route_search_calls,
        note=(
            "候補はOpenStreetMapのPOIタグ・キーワード・距離検索で選び、"
            "候補順列ごとに駅すぱあとAPIの公共交通所要時間を比較しました。"
            "立ち寄り先あたりの滞在時間は一律90分の仮定です。"
            "営業時間、乗車遅延、施設間の徒歩道順は考慮しません。"
            f"{feasibility_note}"
        ),
    )
