import unittest
from datetime import date, datetime, time
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.itinerary import plan_overnight_itinerary
from app.models import (
    CatalogPlace,
    OvernightItineraryRequest,
    ParsedPlaceQuery,
    PlaceSearchHit,
    PlaceSearchResponse,
    RouteLeg,
)


def search_response(*places: CatalogPlace) -> PlaceSearchResponse:
    return PlaceSearchResponse(
        query=ParsedPlaceQuery(region="京都府"),
        results=[PlaceSearchHit(place=place, score=1.0) for place in places],
        note="test search",
    )


def catalog_place(place_id: str, name: str, category: str) -> CatalogPlace:
    return CatalogPlace(
        id=place_id,
        name=name,
        category=category,
        region="京都府",
        address="京都市",
        latitude=35.0,
        longitude=135.7,
        description="",
    )


def lunch_place(place_id: str = "lunch-1") -> CatalogPlace:
    return CatalogPlace(
        id=place_id,
        name="京の昼食処",
        category="カフェ",
        region="京都府",
        address="京都市",
        latitude=35.0,
        longitude=135.7,
        description="京料理とおばんざい",
        genre_code="01",
    )


class OvernightItineraryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fare_estimate = AsyncMock(side_effect=[500, 800])
        fare_patch = patch(
            "app.itinerary.estimate_route_fare",
            new=self.fare_estimate,
        )
        fare_patch.start()
        self.addCleanup(fare_patch.stop)

    async def test_mood_generates_hotel_spots_and_timed_two_day_schedule(self):
        hotel = catalog_place("hotel-1", "京都温泉旅館", "旅館")
        day_one = catalog_place("place-1", "静かな庭園", "庭園")
        day_two = catalog_place("place-2", "京料理店", "飲食店")
        search = AsyncMock(side_effect=[
            search_response(hotel),
            search_response(hotel, day_one, day_two),
        ])
        route_search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="庭園",
                line_name="市バス",
                mode="bus",
                duration_minutes=20,
            )],
            60,
            "09:00",
            datetime(2026, 10, 9, 12, 0),
        ))
        request = OvernightItineraryRequest(
            query="温泉でのんびり、静かな場所で美味しいものを食べたい",
            departure_station="京都駅",
            departure_date=date(2026, 10, 9),
            departure_time=time(9, 0),
            stops_per_day=1,
        )

        with (
            patch("app.itinerary.search_yahoo_catalog", new=search),
            patch("app.itinerary.search_route", new=route_search),
        ):
            result = await plan_overnight_itinerary(request)

        self.assertEqual(result.hotel.name, "京都温泉旅館")
        self.assertEqual([day.places[0].name for day in result.days], ["静かな庭園", "京料理店"])
        self.assertEqual(len(result.days), 2)
        self.assertEqual(result.route_search_calls, 2)
        self.assertEqual([day.fare_yen for day in result.days], [500, 800])
        self.assertEqual(result.fare_yen, 1300)
        self.assertEqual(self.fare_estimate.await_count, 2)
        for index, day in enumerate(result.days):
            self.assertEqual(
                self.fare_estimate.await_args_list[index].args[0],
                [f"{latitude},{longitude}" for latitude, longitude in day.coordinates],
            )
        self.assertEqual(result.days[0].schedule[0].start_time, "09:00")
        self.assertEqual(result.days[0].schedule[-1].kind, "hotel")
        self.assertEqual(result.days[1].schedule[0].title, "ホテルを出発")
        self.assertEqual(result.days[1].schedule[0].start_time, "10:00")
        self.assertIsNone(result.days[0].lunch.place)
        self.assertIn("要検討", result.days[0].lunch.reason)
        self.assertIn("温泉でのんびり", search.await_args_list[0].args[0])
        self.assertEqual(search.await_args_list[1].args[0], request.query)

    async def test_each_day_includes_a_lunch_plan_between_sightseeing(self):
        hotel = catalog_place("hotel-1", "京都温泉旅館", "旅館")
        morning = catalog_place("place-1", "静かな庭園", "庭園")
        afternoon = catalog_place("place-2", "歴史資料館", "博物館")
        lunch = lunch_place()
        search = AsyncMock(side_effect=[
            search_response(hotel),
            search_response(hotel, morning, afternoon),
            search_response(lunch),
            search_response(lunch),
        ])
        route_search = AsyncMock(return_value=(
            [],
            60,
            "09:00",
            datetime(2026, 10, 9, 12, 0),
        ))
        request = OvernightItineraryRequest(
            query="京都の歴史を楽しみたい",
            departure_station="京都駅",
            departure_date=date(2026, 10, 9),
            stops_per_day=1,
        )

        with (
            patch("app.itinerary.search_yahoo_catalog", new=search),
            patch("app.itinerary.search_route", new=route_search),
        ):
            result = await plan_overnight_itinerary(request)

        self.assertEqual(len(result.days), 2)
        for day in result.days:
            self.assertEqual(day.lunch.type, "lunch")
            self.assertIsNotNone(day.lunch.place)
            self.assertEqual(day.lunch.place.category, "カフェ")
            self.assertEqual((day.lunch.start_time, day.lunch.end_time), ("12:00", "13:00"))
            self.assertTrue(any(item.kind == "lunch" for item in day.schedule))

    async def test_overall_fare_is_unavailable_if_either_day_fails(self):
        hotel = catalog_place("hotel-1", "京都温泉旅館", "旅館")
        day_one = catalog_place("place-1", "静かな庭園", "庭園")
        day_two = catalog_place("place-2", "京料理店", "飲食店")
        self.fare_estimate.side_effect = [
            500,
            HTTPException(502, "fare unavailable"),
        ]
        search = AsyncMock(side_effect=[
            search_response(hotel),
            search_response(hotel, day_one, day_two),
            search_response(),
            search_response(),
        ])
        request = OvernightItineraryRequest(
            query="京都の観光",
            departure_station="京都駅",
            departure_date=date(2026, 10, 9),
            stops_per_day=1,
        )

        with (
            patch("app.itinerary.search_yahoo_catalog", new=search),
            patch(
                "app.itinerary.search_route",
                new=AsyncMock(return_value=(
                    [],
                    60,
                    "09:00",
                    datetime(2026, 10, 9, 12, 0),
                )),
            ),
        ):
            result = await plan_overnight_itinerary(request)

        self.assertEqual(result.days[0].fare_yen, 500)
        self.assertIsNone(result.days[1].fare_yen)
        self.assertIsNone(result.fare_yen)


if __name__ == "__main__":
    unittest.main()
