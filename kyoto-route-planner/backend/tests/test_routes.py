import unittest
import asyncio
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from fastapi import HTTPException

from app.ekispert import _make_url, _parse_legs
from app.main import app
from app.models import (
    CatalogPlace,
    ParsedPlaceQuery,
    Place,
    PlaceSearchHit,
    PlaceSearchResponse,
    RouteLeg,
)
from app.places import choose_place_sets, choose_places


def sample_places() -> list[Place]:
    return [
        Place(
            id="osm-1-1",
            name="京都自然公園",
            category="park",
            description="",
            access_point="座標から経路検索",
            latitude=35.01,
            longitude=135.76,
            themes=["nature"],
        ),
        Place(
            id="osm-1-2",
            name="京都寺院",
            category="place_of_worship",
            description="",
            access_point="座標から経路検索",
            latitude=35.02,
            longitude=135.77,
            themes=["history", "temple"],
        ),
        Place(
            id="osm-1-3",
            name="京都の市場",
            category="marketplace",
            description="",
            access_point="座標から経路検索",
            latitude=35.03,
            longitude=135.78,
            themes=["food"],
        ),
    ]


class RoutePlannerTests(unittest.TestCase):
    def test_health_and_origins_remain_available_when_overpass_is_unavailable(self):
        client = TestClient(app)

        self.assertEqual(client.get("/api/health").json(), {"status": "ok"})
        self.assertEqual(
            [origin["name"] for origin in client.get("/api/origins").json()],
            ["京都駅"],
        )
        with patch("app.main.list_osm_places", side_effect=HTTPException(503, "Overpass unavailable")):
            self.assertEqual(client.get("/api/places").status_code, 503)
        self.assertFalse(client.get("/api/places/status").json()["requests_paused"])

    def test_natural_language_search_endpoint_uses_overpass_search(self):
        client = TestClient(app)
        result = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="osm-1-123",
                        name="京都の神社",
                        category="place_of_worship",
                        region="京都府",
                        address="",
                        latitude=35.0,
                        longitude=135.7,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="OpenStreetMap",
        )
        search = AsyncMock(return_value=result)
        with patch("app.main.search_osm_places", search):
            response = client.post(
                "/api/search/places",
                json={"query": "京都の神社"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"][0]["place"]["id"], "osm-1-123")
        search.assert_awaited_once_with("京都の神社")

    def test_itinerary_uses_selected_theme_and_stop_limit(self):
        places = choose_places("nature", 1, "京都駅", sample_places())

        self.assertEqual(len(places), 1)
        self.assertTrue(all("nature" in place.themes for place in places))

    def test_unknown_origin_is_rejected(self):
        with self.assertRaises(ValueError):
            choose_places("all", 2, "知らない駅", sample_places())

    def test_equivalent_origin_names_are_treated_as_the_same_station(self):
        selected = choose_places("all", 2, "京都", sample_places())
        self.assertEqual(len(selected), 2)

    def test_access_points_use_ekispert_station_names_not_bus_stop_names(self):
        selected = choose_places("all", 3, "京都駅", sample_places())
        self.assertTrue(all(place.access_point == "座標から経路検索" for place in selected))

    def test_route_search_url_keeps_via_delimiters_unescaped(self):
        url = _make_url({"key": "safe-test-key", "viaList": "京都:稲荷:京都"})

        self.assertIn("viaList=%E4%BA%AC%E9%83%BD:%E7%A8%B2%E8%8D%B7:%E4%BA%AC%E9%83%BD", url)

    def test_ekispert_course_is_normalized_to_segments(self):
        course = {
            "Route": {
                "timeOnBoard": "25",
                "timeOther": "10",
                "Point": [
                    {"Station": {"Name": "京都"}},
                    {"Station": {"Name": "稲荷"}},
                ],
                "Line": [
                    {
                        "Name": "JR奈良線",
                        "Type": "train",
                        "timeOnBoard": "25",
                    }
                ],
            }
        }

        legs, total_minutes = _parse_legs(course)

        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0].from_name, "京都")
        self.assertEqual(legs[0].to_name, "稲荷")
        self.assertEqual(legs[0].line_name, "JR奈良線")
        self.assertEqual(total_minutes, 35)

    def test_zero_route_total_falls_back_to_positive_segment_durations(self):
        course = {
            "Route": {
                "timeOnBoard": "0",
                "timeOther": "0",
                "Point": [
                    {"Station": {"Name": "京都"}},
                    {"Station": {"Name": "稲荷"}},
                    {"Station": {"Name": "京都"}},
                ],
                "Line": [
                    {"Name": "移動", "Type": "other", "timeOnBoard": "1"},
                    {"Name": "移動", "Type": "other", "timeOnBoard": "1"},
                ],
            }
        }

        legs, total_minutes = _parse_legs(course)

        self.assertEqual(len(legs), 2)
        self.assertEqual(total_minutes, 2)

    def test_route_search_reports_missing_api_key(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.ekispert.load_dotenv"),
            patch("app.main.list_osm_places", new=AsyncMock(return_value=sample_places())),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 503)
        self.assertIn("EKISPERT_API_KEY", response.json()["detail"])

    def test_route_suggestion_returns_up_to_three_route_options(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 3,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))

        candidates = sample_places()
        with patch("app.main.search_route", search), patch(
            "app.main.list_osm_places",
            new=AsyncMock(return_value=candidates),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["routes"]), 3)
        self.assertEqual(body["routes"][0]["legs"][0]["line_name"], "JR奈良線")
        self.assertEqual(body["routes"][0]["total_minutes"], 35)
        self.assertEqual(search.await_count, 3)
        self.assertEqual(len(choose_place_sets("all", 3, "京都駅", candidates)), 3)

    def test_route_suggestion_retries_with_fewer_stops_when_exact_route_is_unavailable(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 3,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        candidates = sample_places()
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(side_effect=[
            HTTPException(404, "no route for three points"),
            success,
            success,
            success,
        ])

        with patch("app.main.search_route", search), patch(
            "app.main.list_osm_places",
            new=AsyncMock(return_value=candidates),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 3)
        self.assertEqual(len(response.json()["routes"][0]["places"]), 2)
        self.assertEqual(search.await_count, 4)

    def test_route_suggestion_returns_partial_results_when_some_variants_have_no_route(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(side_effect=[
            success,
            success,
            HTTPException(404, "no route for this variant"),
            HTTPException(404, "no route for this variant"),
            HTTPException(404, "no route for this variant"),
        ])

        with patch("app.main.search_route", search), patch(
            "app.main.list_osm_places",
            new=AsyncMock(return_value=sample_places()),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 2)

    def test_route_suggestion_keeps_successful_routes_after_temporary_provider_failure(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(side_effect=[
            success,
            HTTPException(504, "temporary outage"),
        ])

        with patch("app.main.search_route", search), patch(
            "app.main.list_osm_places",
            new=AsyncMock(return_value=sample_places()),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 1)
        self.assertEqual(search.await_count, 2)

    def test_route_suggestion_returns_timeout_when_no_route_finishes_in_budget(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }

        async def slow_search(**_kwargs):
            raise asyncio.TimeoutError

        with patch("app.main.search_route", new=slow_search), patch(
            "app.main.list_osm_places",
            new=AsyncMock(return_value=sample_places()),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 504)

    def test_route_suggestion_returns_timeout_when_place_loading_exceeds_budget(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }

        async def slow_places():
            raise asyncio.TimeoutError

        with patch("app.main.list_osm_places", new=slow_places):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 504)
        self.assertIn("候補", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
