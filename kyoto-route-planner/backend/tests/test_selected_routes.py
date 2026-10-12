import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app, limiter
from app.models import ParsedPlaceQuery, PlaceSearchResponse


def selected_places():
    return [dict(id=f"selected-{i}", name=f"選んだ施設{i}", category="公園", description="", access_point="",
                 latitude=35.7 + i * .01, longitude=139.77, themes=["nature"]) for i in [3, 1, 4, 2]]


class SelectedRouteTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        self.client = TestClient(app)
        self.payload = dict(origin="東京都・エリア中心", origin_latitude=35.68, origin_longitude=139.76,
                            theme="nature", stop_count=1, departure_date="2026-10-12", departure_time="09:00",
                            selected_places=selected_places())

    def test_exact_places_and_order_survive_without_candidate_or_ai_generation(self):
        with patch("app.main.search_route", new=AsyncMock(return_value=([], 40, "09:00", "09:40"))) as route, \
             patch("app.main.estimate_route_fare", new=AsyncMock(return_value=600)), \
             patch("app.main._route_candidates", new=AsyncMock()) as candidates, \
             patch("app.main.generate_route_copywriting", new=AsyncMock()) as ai:
            response = self.client.post("/api/routes", json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["routes"][0]
        self.assertEqual([p["id"] for p in result["places"]], [p["id"] for p in self.payload["selected_places"]])
        self.assertEqual(route.await_count, 6)  # Whole route plus five timetable segments.
        self.assertEqual(route.await_args_list[0].kwargs["via_points"], ["35.68,139.76", *[f"{p['latitude']},{p['longitude']}" for p in self.payload["selected_places"]], "35.68,139.76"])
        candidates.assert_not_awaited()
        ai.assert_not_awaited()

    def test_route_failure_never_drops_a_selected_place_and_retries_a_smaller_set(self):
        with patch("app.main.search_route", new=AsyncMock(side_effect=HTTPException(404, "経路なし"))) as route:
            response = self.client.post("/api/routes", json=self.payload)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(route.await_count, 1)

    def test_known_station_rounding_uses_station_name_without_overriding_another_area(self):
        from app.main import _selected_origin_point
        from app.models import Origin
        self.assertEqual(_selected_origin_point(Origin(name="京都駅", latitude=34.985849, longitude=135.758766)), "京都")
        self.assertEqual(_selected_origin_point(Origin(name="京都駅", latitude=35.68, longitude=139.76)), "35.68,139.76")

    def test_duplicate_and_invalid_selected_places_are_rejected(self):
        duplicate = {**self.payload, "selected_places": [selected_places()[0]] * 2}
        self.assertEqual(self.client.post("/api/routes", json=duplicate).status_code, 422)
        invalid = {**self.payload, "selected_places": [{**selected_places()[0], "latitude": 999}]}
        self.assertEqual(self.client.post("/api/routes", json=invalid).status_code, 422)

    def test_partial_edit_search_uses_the_current_area(self):
        with patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=PlaceSearchResponse(query=ParsedPlaceQuery(), results=[], note="候補なし"))) as search:
            response = self.client.post("/api/search/places", json={"query": "公園", "center_latitude": 35.68, "center_longitude": 139.76})
        self.assertEqual(response.status_code, 200)
        search.assert_awaited_once_with("公園", center=(35.68, 139.76), radius_m=20_000)
        self.assertEqual(self.client.post("/api/search/places", json={"query": "公園", "center_latitude": 35.68}).status_code, 422)
