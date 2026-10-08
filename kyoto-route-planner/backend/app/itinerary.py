import asyncio
import time as time_module
from datetime import datetime, timedelta, time, date
from dataclasses import dataclass
from itertools import permutations


from fastapi import HTTPException

from app.ekispert import search_route
from app.models import (
    CatalogPlace,
    Origin,
    ItineraryRequest,
    ItinerarySuggestion,
    OvernightItineraryRequest,
    OvernightItinerarySuggestion,
    DailyItinerary,
    ItineraryScheduleItem,
    RouteLeg,
)
from app.poi_search import search_yahoo_catalog
from app.places import list_origins, normalize_origin_name

ITINERARY_REQUEST_BUDGET_SECONDS = 55.0


LODGING_CATEGORIES = {
    "hotel", "hostel", "guest_house", "motel", "apartment", "lodging", "ryokan",
}


def _is_lodging(place: CatalogPlace) -> bool:
    text = f"{place.category} {place.name}".casefold()
    return place.category.casefold() in LODGING_CATEGORIES or any(
        term in text
        for term in (
            "ホテル", "旅館", "民宿", "宿泊", "ryokan", "hotel", "hostel",
            "guest house", "lodging",
        )
    )


def _clock(value: datetime) -> str:
    return value.strftime("%H:%M")


def _build_day_schedule(
    places: list[CatalogPlace],
    start_at: datetime,
    destination: str,
    transit_minutes: int | None,
    stay_minutes: int,
    hotel_start: bool = False,
) -> list[ItineraryScheduleItem]:
    schedule: list[ItineraryScheduleItem] = []
    current = start_at
    if hotel_start:
        schedule.append(ItineraryScheduleItem(
            start_time=_clock(current),
            end_time=_clock(current),
            title="ホテルを出発",
            detail="チェックアウト時刻は施設にご確認ください。",
            kind="hotel",
        ))

    segment_count = len(places) + 1
    base_minutes = transit_minutes // segment_count if transit_minutes is not None else None
    remainder = transit_minutes % segment_count if transit_minutes is not None else 0
    for index, place in enumerate(places):
        segment_minutes = (
            base_minutes + (1 if index < remainder else 0)
            if base_minutes is not None
            else None
        )
        arrival = current + timedelta(minutes=segment_minutes) if segment_minutes is not None else None
        schedule.append(ItineraryScheduleItem(
            start_time=_clock(current) if arrival else None,
            end_time=_clock(arrival) if arrival else None,
            title=f"{place.name}へ移動",
            detail=(
                "駅すぱあとAPIの総所要時間を区間数で按分した目安です。"
                if arrival else "経路時間を取得できなかったため時刻は未確定です。"
            ),
            kind="travel",
        ))
        if arrival is not None:
            current = arrival
        visit_end = current + timedelta(minutes=stay_minutes)
        schedule.append(ItineraryScheduleItem(
            start_time=_clock(current) if arrival else None,
            end_time=_clock(visit_end) if arrival else None,
            title=place.name,
            detail=f"滞在約{stay_minutes}分の目安です。営業時間・予約状況は施設にご確認ください。",
            kind="visit",
        ))
        current = visit_end

    segment_minutes = (
        base_minutes + (1 if len(places) < remainder else 0)
        if base_minutes is not None
        else None
    )
    arrival = current + timedelta(minutes=segment_minutes) if segment_minutes is not None else None
    schedule.append(ItineraryScheduleItem(
        start_time=_clock(current) if arrival else None,
        end_time=_clock(arrival) if arrival else None,
        title=f"{destination}へ移動",
        detail=(
            "駅すぱあとAPIの総所要時間を区間数で按分した目安です。"
            if arrival else "経路時間を取得できなかったため時刻は未確定です。"
        ),
        kind="travel",
    ))
    schedule.append(ItineraryScheduleItem(
        start_time=_clock(arrival) if arrival else None,
        end_time=_clock(arrival) if arrival else None,
        title=destination,
        detail=(
            "到着時刻の目安です。チェックイン時刻は施設にご確認ください。"
            if destination != "京都駅" else "到着時刻の目安です。"
        ),
        kind="hotel" if destination != "京都駅" else "travel",
    ))
    return schedule



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

    start_time = time_module.monotonic()
    deadline = start_time + ITINERARY_REQUEST_BUDGET_SECONDS

    # 1. ホテルの選定
    # lodgingカテゴリを含めて検索
    hotel_query = request.hotel_query or f"{request.query} ホテル 旅館"
    hotel_search = await search_yahoo_catalog(hotel_query, limit=20)

    hotels = [hit.place for hit in hotel_search.results if _is_lodging(hit.place)]

    if not hotels:
        fallback_search = await search_yahoo_catalog("京都駅 ホテル", limit=10)
        hotels = [hit.place for hit in fallback_search.results if _is_lodging(hit.place)]

    if not hotels:
        raise HTTPException(
            status_code=404,
            detail=hotel_search.note or "Yahoo!ローカルサーチで宿泊施設が見つかりませんでした。",
        )

    selected_hotel = hotels[0]

    # 2. 観光スポットの選定（宿泊施設を除外）
    spot_search = await search_yahoo_catalog(request.query, limit=40)
    all_spots = [
        hit.place for hit in spot_search.results
        if hit.place.id != selected_hotel.id and not _is_lodging(hit.place)
    ]
    
    required_spots = request.stops_per_day * 2
    if len(all_spots) < required_spots:
        if len(all_spots) < 2:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"{spot_search.note} 2日分の観光スポットが不足しています"
                    f"（{len(all_spots)}件のみ）。条件を広げてください。"
                ),
            )
        actual_stops_per_day = len(all_spots) // 2
    else:
        actual_stops_per_day = request.stops_per_day

    day1_spots = all_spots[:actual_stops_per_day]
    day2_spots = all_spots[actual_stops_per_day : actual_stops_per_day * 2]

    # Day 1: 出発駅 -> 観光地 -> ホテル
    best_day1 = await _find_best_route(
        origin_lat=origin.latitude,
        origin_lon=origin.longitude,
        dest_lat=selected_hotel.latitude,
        dest_lon=selected_hotel.longitude,
        spots=day1_spots,
        dep_date=request.departure_date,
        dep_time=request.departure_time,
        stay_min=90,
        deadline=deadline,
    )

    # Day 2: ホテル -> 観光地 -> 出発駅
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
        deadline=deadline,
    )

    days = [
        DailyItinerary(
            day=1,
            date=request.departure_date,
            places=list(best_day1["places"]),
            legs=best_day1["legs"],
            schedule=_build_day_schedule(
                places=list(best_day1["places"]),
                start_at=datetime.combine(request.departure_date, request.departure_time),
                destination=selected_hotel.name,
                transit_minutes=best_day1["transit_minutes"],
                stay_minutes=90,
            ),
            transit_minutes=best_day1["transit_minutes"],
            stay_minutes=len(best_day1["places"]) * 90,
            estimated_arrival_at=best_day1["arrival_at"],
            coordinates=[
                [origin.latitude, origin.longitude],
                *[[place.latitude, place.longitude] for place in best_day1["places"]],
                [selected_hotel.latitude, selected_hotel.longitude],
            ],
        ),
        DailyItinerary(
            day=2,
            date=day2_date,
            places=list(best_day2["places"]),
            legs=best_day2["legs"],
            schedule=_build_day_schedule(
                places=list(best_day2["places"]),
                start_at=datetime.combine(day2_date, checkout_time),
                destination=origin.name,
                transit_minutes=best_day2["transit_minutes"],
                stay_minutes=90,
                hotel_start=True,
            ),
            transit_minutes=best_day2["transit_minutes"],
            stay_minutes=len(best_day2["places"]) * 90,
            estimated_arrival_at=best_day2["arrival_at"],
            coordinates=[
                [selected_hotel.latitude, selected_hotel.longitude],
                *[[place.latitude, place.longitude] for place in best_day2["places"]],
                [origin.latitude, origin.longitude],
            ],
        )
    ]

    return OvernightItinerarySuggestion(
        query=spot_search.query,
        origin=Origin(name=origin.name, latitude=origin.latitude, longitude=origin.longitude),
        hotel=selected_hotel,
        days=days,
        feasible=best_day1["transit_minutes"] is not None and best_day2["transit_minutes"] is not None,
        route_search_calls=best_day1["calls"] + best_day2["calls"],
        note=(
            f"宿泊先に「{selected_hotel.name}」を選定した1泊2日プランです。"
            f"1日目{len(best_day1['places'])}箇所、2日目{len(best_day2['places'])}箇所のスポットを巡ります。"
            "2日目は10:00にホテルを出発する計算です。移動区間は総所要時間を均等配分した目安で、営業時間・運休・宿泊料金は確認していません。"
            f"候補地検索: {spot_search.note}"
        )
    )


async def _find_best_route(
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
    spots: list[CatalogPlace],
    dep_date: date, dep_time: time,
    stay_min: int, deadline: float
):
    best = None
    calls = 0
    
    # タイムアウトを考慮し、順列は最大6通り（3スポット分）に制限
    # 既に permutations(spots) は spots が3件以下なら最大6通り。
    for p in permutations(spots):
        now = time_module.monotonic()
        if now > deadline - 2.0: # 余裕を持って2秒前に打ち切り
            break
        
        via_points = [
            f"{origin_lat},{origin_lon}",
            *(f"{s.latitude},{s.longitude}" for s in p),
            f"{dest_lat},{dest_lon}"
        ]
        
        try:
            # 各APIリクエストに個別のタイムアウトを設定
            remaining = deadline - time_module.monotonic()
            legs, transit_min, _dep, arrival_dt = await asyncio.wait_for(
                search_route(
                    via_points=via_points,
                    departure_date=dep_date.isoformat(),
                    departure_time=dep_time.strftime("%H:%M"),
                ),
                timeout=min(15.0, max(1.0, remaining))
            )
            calls += 1
            
            total_min = (transit_min or 0) + (len(spots) * stay_min)
            if best is None or (transit_min is not None and (best["transit_minutes"] is None or total_min < best["total_minutes"])):
                best = {
                    "places": p,
                    "legs": legs,
                    "transit_minutes": transit_min,
                    "total_minutes": total_min,
                    "arrival_at": arrival_dt.isoformat() if arrival_dt else None
                }
        except (asyncio.TimeoutError, HTTPException):
            calls += 1
            continue

    if best is None:
        # 経路が見つからなかった場合、最低限スポットリストだけは保持して返す
        return {
            "places": spots,
            "legs": [],
            "transit_minutes": None,
            "total_minutes": 0,
            "arrival_at": None,
            "calls": calls
        }
    best["calls"] = calls
    return best

async def plan_itinerary(request: ItineraryRequest) -> ItinerarySuggestion:
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
            search_yahoo_catalog(request.query, limit=20),
            timeout=remaining_seconds,
        )
    except asyncio.TimeoutError as error:
        raise HTTPException(
            status_code=504,
            detail="旅程候補の取得がタイムアウトしました。時間をおいて再度お試しください。",
        ) from error
    if not search_result.results:
        detail = " ".join(
            [search_result.note, *search_result.query.warnings]
        ).strip()
        raise HTTPException(
            status_code=404,
            detail=detail or "Yahoo!ローカルサーチで条件に合うスポットが見つかりませんでした。",
        )

    candidates = [hit.place for hit in search_result.results[: request.stop_count]]
    if len(candidates) < request.stop_count:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Yahoo!ローカルサーチの候補が{len(candidates)}件のみです。"
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
            "候補はYahoo!ローカルサーチの検索結果をテーマ・距離条件で絞り込み、"
            "候補順列ごとに駅すぱあとAPIの公共交通所要時間を比較しました。"
            "立ち寄り先あたりの滞在時間は一律90分の仮定です。"
            "営業時間、乗車遅延、施設間の徒歩道順は考慮しません。"
            f"{feasibility_note}"
        ),
    )
