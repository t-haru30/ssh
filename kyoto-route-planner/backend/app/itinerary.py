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
    ParsedPlaceQuery,
    PlaceSearchHit,
    PlaceSearchResponse,
    LunchPlan,
    RouteLeg,
)
from app.poi_search import search_yahoo_catalog
from app.places import list_origins, normalize_origin_name
from app.search import parse_place_query

ITINERARY_REQUEST_BUDGET_SECONDS = 55.0


LODGING_CATEGORIES = {
    "hotel", "hostel", "guest_house", "motel", "apartment", "lodging", "ryokan",
}

LUNCH_CATEGORIES = (
    "レストラン", "食堂", "カフェ", "飲食", "料理", "グルメ", "restaurant",
    "cafe", "dining", "food",
)
LUNCH_GENRE_PREFIX = "01"
LUNCH_DISTANCE_KM = 1.0
LUNCH_STAY_MINUTES = 60
LUNCH_SCORE_WEIGHTS = {
    "midday_hours": 20.0,
    "address": 5.0,
    "description": 5.0,
    "rating": 20.0,
    "proximity": 20.0,
    "theme": 20.0,
    "local_specialty": 15.0,
    "duplicate_category": -10.0,
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


def _is_lunch(place: CatalogPlace) -> bool:
    text = f"{place.category} {place.name}".casefold()
    return place.genre_code.startswith(LUNCH_GENRE_PREFIX) or any(
        term.casefold() in text for term in LUNCH_CATEGORIES
    )


def _distance_km(first: CatalogPlace | Origin, second: CatalogPlace | Origin) -> float:
    from math import asin, cos, radians, sin, sqrt

    latitude_delta = radians(second.latitude - first.latitude)
    longitude_delta = radians(second.longitude - first.longitude)
    value = (
        sin(latitude_delta / 2) ** 2
        + cos(radians(first.latitude))
        * cos(radians(second.latitude))
        * sin(longitude_delta / 2) ** 2
    )
    return 6371.0 * 2 * asin(sqrt(value))


def _lunch_score(
        place: CatalogPlace,
        anchors: tuple[CatalogPlace, CatalogPlace | Origin],
        query: str,
        used_categories: set[str],
) -> float:
    tags = place.tags
    score = 0.0
    if tags.get("hours_lunch") == "true":
        score += LUNCH_SCORE_WEIGHTS["midday_hours"]
    if place.address.strip():
        score += LUNCH_SCORE_WEIGHTS["address"]
    if place.description.strip() or tags.get("review"):
        score += LUNCH_SCORE_WEIGHTS["description"]
    try:
        rating = float(tags.get("rating", "0"))
    except ValueError:
        rating = 0.0
    score += min(max(rating / 5.0, 0.0), 1.0) * LUNCH_SCORE_WEIGHTS["rating"]
    nearest_distance = min(_distance_km(place, anchor) for anchor in anchors)
    score += max(0.0, 1.0 - nearest_distance / LUNCH_DISTANCE_KM) * LUNCH_SCORE_WEIGHTS["proximity"]
    query_text = query.casefold()
    if any(term in query_text for term in ("グルメ", "和食", "食", "料理", "ランチ")):
        score += LUNCH_SCORE_WEIGHTS["theme"]
    if any(term in f"{place.name} {place.category} {place.description}" for term in ("京料理", "湯豆腐", "おばんざい", "抹茶")):
        score += LUNCH_SCORE_WEIGHTS["local_specialty"]
    if place.category in used_categories:
        score += LUNCH_SCORE_WEIGHTS["duplicate_category"]
    return score


async def _select_lunch(
        query: str,
        morning_last: CatalogPlace,
        afternoon_first: CatalogPlace | Origin,
        deadline: float,
) -> LunchPlan:
    search_queries = (
        f"{morning_last.name} ランチ レストラン",
        f"{afternoon_first.name} ランチ レストラン",
        "京都 ランチ レストラン",
    )
    candidates: list[CatalogPlace] = []
    for search_query in search_queries:
        remaining = deadline - time_module.monotonic()
        if remaining <= 0:
            break
        try:
            result = await asyncio.wait_for(
                search_yahoo_catalog(search_query, limit=30),
                timeout=min(10.0, remaining),
            )
        except (asyncio.TimeoutError, HTTPException, StopAsyncIteration):
            continue
        candidates.extend(hit.place for hit in result.results if _is_lunch(hit.place))
        nearby = [
            place for place in candidates
            if min(_distance_km(place, morning_last), _distance_km(place, afternoon_first))
            <= LUNCH_DISTANCE_KM
        ]
        if nearby:
            break

    nearby = {
        place.id: place
        for place in candidates
        if min(_distance_km(place, morning_last), _distance_km(place, afternoon_first))
        <= LUNCH_DISTANCE_KM
    }
    if not nearby:
        return LunchPlan(reason="徒歩10分・1km以内の飲食店候補が見つからないため、昼食は要検討です。")
    selected = max(
        nearby.values(),
        key=lambda place: _lunch_score(
            place, (morning_last, afternoon_first), query, set()
        ),
    )
    distance = min(_distance_km(selected, morning_last), _distance_km(selected, afternoon_first))
    return LunchPlan(
        place=selected,
        reason=(
            f"午前・午後のスポットから最短約{distance * 1000:.0f}mの飲食店で、"
            "昼食時間帯と店舗情報を考慮して選定しました。"
        ),
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
    lunch: LunchPlan | None = None,
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
    lunch_index = max(1, len(places) // 2)
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
        if lunch is not None and index + 1 == lunch_index:
            schedule.append(ItineraryScheduleItem(
                start_time=lunch.start_time,
                end_time=lunch.start_time,
                title=f"{lunch.place.name if lunch.place else '昼食'}へ移動",
                detail="昼食候補への移動時間は前後の経路に含まれる目安です。",
                kind="travel",
            ))
            schedule.append(ItineraryScheduleItem(
                start_time=lunch.start_time,
                end_time=lunch.end_time,
                title=lunch.place.name if lunch.place else "昼食: 要検討",
                detail=lunch.reason,
                kind="lunch",
            ))
            current = datetime.combine(current.date(), time(13, 0))

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

    day1_split = max(1, len(best_day1["places"]) // 2)
    day2_split = max(1, len(best_day2["places"]) // 2)
    day1_lunch = await _select_lunch(
        request.query,
        best_day1["places"][day1_split - 1],
        best_day1["places"][day1_split] if day1_split < len(best_day1["places"]) else selected_hotel,
        deadline,
    )
    day2_lunch = await _select_lunch(
        request.query,
        best_day2["places"][day2_split - 1],
        best_day2["places"][day2_split] if day2_split < len(best_day2["places"]) else origin,
        deadline,
    )
    best_day1 = await _add_lunch_to_route(
        best_day1, list(best_day1["places"]), day1_lunch,
        origin.latitude, origin.longitude,
        selected_hotel.latitude, selected_hotel.longitude,
        request.departure_date, request.departure_time, deadline,
    )
    best_day2 = await _add_lunch_to_route(
        best_day2, list(best_day2["places"]), day2_lunch,
        selected_hotel.latitude, selected_hotel.longitude,
        origin.latitude, origin.longitude,
        day2_date, checkout_time, deadline,
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
                lunch=day1_lunch,
            ),
            lunch=day1_lunch,
            transit_minutes=best_day1["transit_minutes"],
            stay_minutes=len(best_day1["places"]) * 90 + LUNCH_STAY_MINUTES,
            estimated_arrival_at=best_day1["arrival_at"],
            coordinates=[
                [origin.latitude, origin.longitude],
                *[[place.latitude, place.longitude] for place in best_day1["places"][:day1_split]],
                *([[day1_lunch.place.latitude, day1_lunch.place.longitude]] if day1_lunch.place else []),
                *[[place.latitude, place.longitude] for place in best_day1["places"][day1_split:]],
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
                lunch=day2_lunch,
            ),
            lunch=day2_lunch,
            transit_minutes=best_day2["transit_minutes"],
            stay_minutes=len(best_day2["places"]) * 90 + LUNCH_STAY_MINUTES,
            estimated_arrival_at=best_day2["arrival_at"],
            coordinates=[
                [selected_hotel.latitude, selected_hotel.longitude],
                *[[place.latitude, place.longitude] for place in best_day2["places"][:day2_split]],
                *([[day2_lunch.place.latitude, day2_lunch.place.longitude]] if day2_lunch.place else []),
                *[[place.latitude, place.longitude] for place in best_day2["places"][day2_split:]],
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
        except (asyncio.TimeoutError, HTTPException, StopAsyncIteration):
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


async def _add_lunch_to_route(
    route: dict,
    places: list[CatalogPlace],
    lunch: LunchPlan,
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
    dep_date: date,
    dep_time: time,
    deadline: float,
) -> dict:
    if lunch.place is None:
        return route
    lunch_index = max(1, len(places) // 2)
    ordered = list(places)
    via_places = ordered[:lunch_index] + [lunch.place] + ordered[lunch_index:]
    via_points = [
        f"{origin_lat},{origin_lon}",
        *(f"{place.latitude},{place.longitude}" for place in via_places),
        f"{dest_lat},{dest_lon}",
    ]
    remaining = deadline - time_module.monotonic()
    if remaining <= 0:
        return route
    try:
        legs, transit_min, _departure, arrival_dt = await asyncio.wait_for(
            search_route(
                via_points=via_points,
                departure_date=dep_date.isoformat(),
                departure_time=dep_time.strftime("%H:%M"),
            ),
            timeout=min(15.0, remaining),
        )
    except (asyncio.TimeoutError, HTTPException):
        return route
    if transit_min is not None:
        route.update({
            "legs": legs,
            "transit_minutes": transit_min,
            "total_minutes": (transit_min or 0) + len(places) * 90 + LUNCH_STAY_MINUTES,
            "arrival_at": arrival_dt.isoformat() if arrival_dt else None,
            "calls": route.get("calls", 0) + 1,
        })
    return route

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
    if request.selected_places is not None:
        search_result = PlaceSearchResponse(
            query=parse_place_query(request.query),
            results=[
                PlaceSearchHit(place=place, score=1.0)
                for place in request.selected_places
            ],
            note="スワイプで選択したスポットです。",
        )
    else:
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
