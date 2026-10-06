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
