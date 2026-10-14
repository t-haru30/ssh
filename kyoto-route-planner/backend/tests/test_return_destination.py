import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import _build_route_timeline, app, limiter
from app.models import Origin, Place, RoutePreviewRequest, RouteSuggestion, RouteSuggestionRequest


def selected_places():
    return [
        dict(
            id=f"selected-{index}", name=f"施設{index}", category="公園",
            description="", access_point="", latitude=0, longitude=longitude,
            themes=["nature"],
        )
        for index, longitude in [(2, 1), (1, 2)]
    ]


class ReturnDestinationTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        self.client = TestClient(app)
        self.payload = dict(
            origin="出発地", origin_latitude=0, origin_longitude=0,
            departure_date="2026-10-12", departure_time="09:00",
            selected_places=selected_places(),
        )
        self.search = AsyncMock(return_value=([], 40, "09:00", "09:40"))
        self.segment_search = AsyncMock(return_value=([], None, None, None))
        self.fare = AsyncMock(return_value=600)
        for name, mock in [
            ("search_route", self.search),
            ("_search_route_segment", self.segment_search),
            ("estimate_route_fare", self.fare),
            ("_route_candidates", AsyncMock()),
            ("generate_route_copywriting", AsyncMock(return_value=None)),
        ]:
            patcher = patch(f"app.main.{name}", new=mock)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_independent_destination_reaches_route_fare_timeline_and_geometry(self):
        payload = dict(self.payload, return_to="宿泊先", return_latitude=0, return_longitude=4)
        response = self.client.post("/api/routes", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["routes"][0]
        expected = ["0.0,0.0", "0.0,1.0", "0.0,2.0", "0.0,4.0"]
        self.assertEqual(self.search.await_args_list[0].kwargs["via_points"], expected)
        self.assertEqual(self.segment_search.await_args_list[-1].args[1], "0.0,4.0")
        self.fare.assert_awaited_once_with(expected)
        self.assertEqual([place["id"] for place in result["places"]], ["selected-2", "selected-1"])
        self.assertEqual(result["return_to"], dict(name="宿泊先", latitude=0, longitude=4))
        self.assertEqual(result["coordinates"], [[0, 0], [0, 1], [0, 2], [0, 4]])
        self.assertEqual(result["timeline"][-2]["to_name"], "宿泊先")
        self.assertEqual(result["timeline"][-1]["name"], "宿泊先")
        self.assertEqual(result["timeline"][-1]["time"], "12:40")
        self.assertEqual(
            [item["duration_minutes"] for item in result["timeline"] if item["type"] == "transit"],
            [10, 10, 20],
        )

    def test_omitted_destination_keeps_round_trip_endpoints(self):
        response = self.client.post("/api/routes", json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["routes"][0]
        expected = ["0.0,0.0", "0.0,1.0", "0.0,2.0", "0.0,0.0"]
        self.assertEqual(self.search.await_args_list[0].kwargs["via_points"], expected)
        self.fare.assert_awaited_once_with(expected)
        self.assertEqual(result["return_to"], result["origin"])
        self.assertEqual(result["coordinates"][-1], result["coordinates"][0])
        self.assertEqual(result["timeline"][-1]["name"], "出発地")

    def test_destination_station_rounding_and_custom_coordinates(self):
        for latitude, longitude, expected in [
            (34.985849, 135.758766, "京都"),
            (35.68, 139.76, "35.68,139.76"),
        ]:
            with self.subTest(latitude=latitude):
                limiter.reset()
                self.search.reset_mock()
                response = self.client.post("/api/routes", json=dict(
                    self.payload, return_to="京都駅", return_latitude=latitude, return_longitude=longitude,
                ))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.search.await_args_list[0].kwargs["via_points"][-1], expected)
                self.assertEqual(self.fare.await_args.args[0][-1], expected)
                self.assertEqual(response.json()["routes"][0]["coordinates"][-1], [latitude, longitude])

    def test_named_known_destination_needs_no_coordinates(self):
        response = self.client.post("/api/routes", json=dict(self.payload, return_to="大阪駅"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.search.await_args_list[0].kwargs["via_points"][-1], "大阪")
        self.assertEqual(self.segment_search.await_args_list[-1].args[1], "34.70248,135.49595")
        self.assertEqual(response.json()["routes"][0]["return_to"]["name"], "大阪駅")

    def test_invalid_destination_name_is_rejected_before_route_search(self):
        response = self.client.post("/api/routes", json=dict(self.payload, return_to="未知の駅"))
        self.assertEqual(response.status_code, 422)
        self.assertIn("帰着地", response.json()["detail"])
        self.search.assert_not_awaited()

    def test_selected_route_failure_never_reorders_or_drops_stops(self):
        self.search.side_effect = HTTPException(404, "経路なし")
        response = self.client.post("/api/routes", json=dict(self.payload, return_to="大阪駅"))
        self.assertEqual(response.status_code, 404)
        self.search.assert_awaited_once()
        self.assertEqual(self.search.await_args.kwargs["via_points"], [
            "0.0,0.0", "0.0,1.0", "0.0,2.0", "大阪",
        ])
        self.fare.assert_not_awaited()

    def test_fallback_deadline_names_destination_and_omitted_keeps_original_message(self):
        places = [Place(**place) for place in selected_places()]
        self.search.return_value = ([], 700, "09:00", "20:40")
        payload = {key: value for key, value in self.payload.items() if key != "selected_places"}
        for return_fields, expected in [
            ({"return_to": "大阪駅"}, "大阪駅へ到着"),
            ({}, "出発駅へ戻れる"),
        ]:
            with self.subTest(return_fields=return_fields), \
                 patch("app.main._route_candidates", new=AsyncMock(return_value=(places, "候補"))), \
                 patch("app.main.choose_place_sets", return_value=[places]):
                limiter.reset()
                response = self.client.post("/api/routes", json=dict(payload, **return_fields))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn(expected, response.json()["detail"])

    def test_initial_api_candidates_use_destination_for_route_and_fare(self):
        places = [Place(**place) for place in selected_places()]
        payload = {key: value for key, value in self.payload.items() if key != "selected_places"}
        with patch("app.main._route_candidates", new=AsyncMock(return_value=(places, "候補"))), \
             patch("app.main.choose_place_sets", return_value=[places]):
            response = self.client.post("/api/routes", json=dict(payload, return_to="大阪駅"))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.search.await_args_list[0].kwargs["via_points"][-1], "大阪")
        self.assertEqual(self.fare.await_args.args[0][-1], "大阪")

    def test_destination_validation(self):
        invalid = [
            {"return_to": ""}, {"return_to": " 　"}, {"return_to": "x" * 81},
            {"return_latitude": 0, "return_longitude": 0},
            {"return_to": "宿", "return_latitude": 0},
            {"return_to": "宿", "return_longitude": 0},
            {"return_to": "宿", "return_latitude": 91, "return_longitude": 0},
            {"return_to": "宿", "return_latitude": 0, "return_longitude": 181},
            {"return_to": "宿", "return_latitude": "bad", "return_longitude": 0},
        ]
        for return_fields in invalid:
            with self.subTest(return_fields=return_fields), self.assertRaises(ValidationError):
                RouteSuggestionRequest(**dict(self.payload, **return_fields))

    def test_old_saved_response_and_timeline_signature_remain_compatible(self):
        origin = Origin(name="京都駅", latitude=34.98585, longitude=135.75877)
        saved = RouteSuggestion(places=[], origin=origin, legs=[], note="以前の保存データ")
        self.assertIsNone(saved.return_to)
        timeline = _build_route_timeline(origin, [], "09:00", None)
        self.assertEqual(timeline[-1].name, origin.name)
        self.assertIsNone(timeline[-1].time)

    def test_preview_keeps_individual_stays_and_validates_their_shape(self):
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=selected_places(),
                       departure_date="2026-10-12", departure_time="09:00", stay_minutes=[45, 60])
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        timeline = response.json()["timeline"]
        self.assertEqual([item["stay_minutes"] for item in timeline if item.get("role") == "stop"], [45, 60])
        self.assertIsNone(timeline[-1]["time"])
        for stays in ([45], [0, 60], [45, 361]):
            with self.subTest(stays=stays), self.assertRaises(ValidationError):
                RoutePreviewRequest(**dict(payload, stay_minutes=stays))

    def test_preview_preserves_independent_return_destination(self):
        destination = dict(name="宿泊先", latitude=0, longitude=4)
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), return_to=destination,
                       places=selected_places(), departure_date="2026-10-12", departure_time="09:00", stay_minutes=[45, 60])
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.search.assert_not_awaited()
        self.assertEqual(self.segment_search.await_args_list[-1].args[1], "0.0,4.0")
        self.assertEqual(result["return_to"], destination)
        self.assertEqual(result["coordinates"][-1], [0, 4])
        self.assertEqual(result["timeline"][-1]["name"], "宿泊先")

    def test_preview_retains_corrected_segment_legs_and_sums_fares(self):
        from app.ekispert import RouteSearchResult
        from app.models import RouteLeg
        leg = RouteLeg(from_name="駅A", to_name="駅B", line_name="地下鉄", mode="train", duration_minutes=10)
        async def segment(_start, _end, _date, departure):
            from datetime import datetime, timedelta
            arrival = (datetime.strptime(departure, "%H:%M") + timedelta(minutes=10)).strftime("%H:%M")
            return RouteSearchResult([leg], 10, departure, arrival, 230)
        self.segment_search.side_effect = segment
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=selected_places(),
                       departure_date="2026-10-12", departure_time="09:00")
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(len(result["legs"]), 3)
        self.assertEqual(result["fare_yen"], 690)
        self.assertEqual(result["total_minutes"], 30)

    def test_preview_via_404_still_searches_segments_after_actual_arrival_and_stay(self):
        from app.ekispert import RouteSearchResult
        from app.models import RouteLeg
        self.search.side_effect = HTTPException(status_code=404, detail="whole route unavailable")
        leg = RouteLeg(from_name="駅A", to_name="駅B", line_name="鉄道", mode="train", duration_minutes=20)
        self.segment_search.side_effect = [
            RouteSearchResult([leg], 20, "09:05", "09:25", 200),
            RouteSearchResult([leg], 20, "10:15", "10:35", 300),
            RouteSearchResult([leg], 20, "11:40", "12:00", 400),
        ]
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=selected_places(),
                       departure_date="2026-10-12", departure_time="09:00", stay_minutes=[45, 60])
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([call.args[3] for call in self.segment_search.await_args_list], ["09:00", "10:10", "11:35"])
        result = response.json()
        self.assertEqual(result["arrival_time"], "12:00")
        self.assertEqual(result["timeline"][-1]["time"], "12:00")
        self.assertEqual(result["fare_yen"], 900)

    def test_preview_unknown_leg_leaves_later_clock_times_unconfirmed(self):
        self.search.side_effect = HTTPException(status_code=404)
        self.segment_search.side_effect = [HTTPException(status_code=404), ([], 10, "10:30", "10:40"), ([], 10, "12:10", "12:20")]
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=selected_places(),
                       departure_date="2026-10-12", departure_time="09:00")
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertIsNone(result["arrival_time"])
        self.assertIsNone(result["total_minutes"])
        self.assertTrue(all(item["time"] is None for item in result["timeline"] if item.get("role") in ("stop", "finish")))

    def test_preview_same_location_is_zero_without_lookup(self):
        places = [dict(selected_places()[0], latitude=0, longitude=0)]
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=places,
                       departure_date="2026-10-12", departure_time="09:00", stay_minutes=[45])
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.segment_search.assert_not_awaited()
        self.assertEqual(response.json()["arrival_time"], "09:45")
        self.assertEqual(response.json()["fare_yen"], 0)

    def test_preview_uses_provider_dates_across_midnight(self):
        from app.ekispert import RouteSearchResult
        self.search.side_effect = HTTPException(status_code=404)
        self.segment_search.side_effect = [
            RouteSearchResult([], 20, "23:55", "00:15", 200, "2026-10-12T23:55:00+09:00", "2026-10-13T00:15:00+09:00"),
            RouteSearchResult([], 20, "00:45", "01:05", 200, "2026-10-13T00:45:00+09:00", "2026-10-13T01:05:00+09:00"),
        ]
        payload = dict(origin=dict(name="出発駅", latitude=0, longitude=0), places=selected_places()[:1],
                       departure_date="2026-10-12", departure_time="23:50", stay_minutes=[30])
        response = self.client.post("/api/routes/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.segment_search.await_args_list[1].args[2:], ("2026-10-13", "00:45"))
        self.assertEqual(response.json()["arrival_time"], "01:05")
        self.assertEqual(response.json()["total_minutes"], 45)
