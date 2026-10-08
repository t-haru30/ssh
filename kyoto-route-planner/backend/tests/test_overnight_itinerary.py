import unittest
from datetime import date, datetime, time
from unittest.mock import AsyncMock, patch

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


class OvernightItineraryTests(unittest.IsolatedAsyncioTestCase):
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
            patch("app.itinerary.search_places_with_fallback", new=search),
            patch("app.itinerary.search_route", new=route_search),
        ):
            result = await plan_overnight_itinerary(request)

        self.assertEqual(result.hotel.name, "京都温泉旅館")
        self.assertEqual([day.places[0].name for day in result.days], ["静かな庭園", "京料理店"])
        self.assertEqual(len(result.days), 2)
        self.assertEqual(result.route_search_calls, 2)
        self.assertEqual(result.days[0].schedule[0].start_time, "09:00")
        self.assertEqual(result.days[0].schedule[-1].kind, "hotel")
        self.assertEqual(result.days[1].schedule[0].title, "ホテルを出発")
        self.assertEqual(result.days[1].schedule[0].start_time, "10:00")
        self.assertIn("温泉でのんびり", search.await_args_list[0].args[0])
        self.assertEqual(search.await_args_list[1].args[0], request.query)


if __name__ == "__main__":
    unittest.main()
