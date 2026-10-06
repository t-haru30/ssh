import unittest
import asyncio
from datetime import date, time
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.itinerary import plan_itinerary
from app.models import (
    CatalogPlace,
    ItineraryRequest,
    PlaceSearchHit,
    PlaceSearchResponse,
    ParsedPlaceQuery,
    RouteLeg,
)


def catalog_place(
    place_id: str,
    name: str,
    latitude: float,
    longitude: float,
) -> CatalogPlace:
    return CatalogPlace(
        id=place_id,
        name=name,
        category="tourism",
        region="京都府",
        address="京都府京都市",
        latitude=latitude,
        longitude=longitude,
        description="",
    )


class ItineraryPlanningTests(unittest.IsolatedAsyncioTestCase):
    async def test_times_out_when_place_search_exceeds_request_budget(self):
        request = ItineraryRequest(
            query="京都府の観光地",
            departure_station="京都駅",
            departure_date=date(2026, 10, 5),
            departure_time=time(9, 0),
            stop_count=1,
        )

        async def slow_search(*_args, **_kwargs):
            raise asyncio.TimeoutError

        with patch("app.itinerary.search_osm_places", new=slow_search):
            with self.assertRaisesRegex(HTTPException, "候補.*タイムアウト"):
                await plan_itinerary(request)

    async def test_times_out_when_route_search_exceeds_budget(self):
        place = catalog_place("a", "スポットA", 35.0, 135.7)
        search_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[PlaceSearchHit(place=place, score=1)],
            note="",
        )
        request = ItineraryRequest(
            query="京都府の観光地",
            departure_station="京都駅",
            departure_date=date(2026, 10, 5),
            departure_time=time(9, 0),
            stop_count=1,
        )

        async def slow_search(**_kwargs):
            raise asyncio.TimeoutError

        with (
            patch("app.itinerary.search_osm_places", new=AsyncMock(return_value=search_response)),
            patch("app.itinerary.search_route", new=slow_search),
        ):
            with self.assertRaisesRegex(HTTPException, "タイムアウト"):
                await plan_itinerary(request)

    async def test_keeps_successful_route_when_another_route_temporarily_fails(self):
        places = [
            catalog_place("a", "スポットA", 35.0, 135.7),
            catalog_place("b", "スポットB", 35.01, 135.71),
        ]
        search_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[PlaceSearchHit(place=place, score=0.8) for place in places],
            note="",
        )
        request = ItineraryRequest(
            query="京都府の観光地",
            departure_station="京都駅",
            departure_date=date(2026, 10, 5),
            departure_time=time(9, 0),
            stop_count=2,
        )
        search = AsyncMock(side_effect=[
            ([], 30, "09:00", "09:30"),
            HTTPException(504, "temporary outage"),
        ])

        with (
            patch("app.itinerary.search_osm_places", new=AsyncMock(return_value=search_response)),
            patch("app.itinerary.search_route", new=search),
        ):
            result = await plan_itinerary(request)

        self.assertEqual(result.route_search_calls, 2)
        self.assertEqual(result.estimated_total_minutes, 210)

    async def test_compares_all_three_stop_orders_and_chooses_fastest_feasible_route(self):
        places = [
            catalog_place("a", "スポットA", 35.0, 135.7),
            catalog_place("b", "スポットB", 35.01, 135.71),
            catalog_place("c", "スポットC", 35.02, 135.72),
        ]
        search_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(place=place, score=0.8)
                for place in places
            ],
            note="",
        )
        durations = {
            ("a", "b", "c"): 180,
            ("a", "c", "b"): 170,
            ("b", "a", "c"): 160,
            ("b", "c", "a"): 140,
            ("c", "a", "b"): 150,
            ("c", "b", "a"): 130,
        }

        async def fake_search_route(via_points, departure_date, departure_time):
            del departure_date, departure_time
            order = tuple(
                next(place.id for place in places if f"{place.latitude},{place.longitude}" == point)
                for point in via_points[1:-1]
            )
            return (
                [
                    RouteLeg(
                        from_name="京都",
                        to_name="スポット",
                        line_name="公共交通",
                        mode="train",
                        duration_minutes=durations[order],
                    )
                ],
                durations[order],
                "09:00",
                "12:00",
            )

        route_search = AsyncMock(side_effect=fake_search_route)
        request = ItineraryRequest(
            query="京都府の自然スポット",
            departure_station="京都駅",
            departure_date=date(2026, 10, 5),
            departure_time=time(9, 0),
            stop_count=3,
        )

        with (
            patch("app.itinerary.search_osm_places", new=AsyncMock(return_value=search_response)),
            patch("app.itinerary.search_route", route_search),
        ):
            result = await plan_itinerary(request)

        self.assertEqual(route_search.await_count, 6)
        self.assertEqual([place.id for place in result.places], ["c", "b", "a"])
        self.assertEqual(result.route_search_calls, 6)
        self.assertEqual(result.stay_minutes, 270)
        self.assertEqual(result.estimated_total_minutes, 400)
        self.assertEqual(result.estimated_return_at, "2026-10-05T15:40:00")
        self.assertTrue(result.feasible)

    async def test_marks_route_infeasible_when_return_time_exceeds_limit(self):
        place = catalog_place("a", "スポットA", 35.0, 135.7)
        search_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[PlaceSearchHit(place=place, score=1)],
            note="",
        )
        request = ItineraryRequest(
            query="京都府の観光地",
            departure_station="京都駅",
            departure_date=date(2026, 10, 5),
            departure_time=time(16, 0),
            stop_count=1,
        )

        with (
            patch("app.itinerary.search_osm_places", new=AsyncMock(return_value=search_response)),
            patch(
                "app.itinerary.search_route",
                new=AsyncMock(return_value=([], 60, "16:00", "17:00")),
            ),
        ):
            result = await plan_itinerary(request)

        self.assertFalse(result.feasible)
        self.assertEqual(result.estimated_return_at, "2026-10-05T18:30:00")
        self.assertIn("超える見込み", result.note)


if __name__ == "__main__":
    unittest.main()
