import unittest
import asyncio
from unittest.mock import Mock
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app, limiter
from app.ekispert import RouteSearchResult, _parse_legs, _course_endpoint_times, search_route
from app.models import RouteLeg


class TransitSegmentTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        self.client = TestClient(app)
        self.payload = {"origin": {"name": "博物館", "latitude": 35.0, "longitude": 135.0},
                        "destination": {"name": "庭園", "latitude": 35.1, "longitude": 135.1},
                        "departure_date": "2026-10-13", "departure_time": "14:30"}

    def test_same_course_fare_and_transfer_legs_are_returned(self):
        leg = RouteLeg(from_name="駅A", to_name="駅B", line_name="地下鉄", mode="train", duration_minutes=12)
        result = RouteSearchResult([leg], 20, "14:30", "14:50", 260)
        with patch("app.main.search_route", new=AsyncMock(return_value=result)) as search:
            response = self.client.post("/api/transit/segment", json=self.payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["fare_yen"], 260)
        self.assertEqual(response.json()["legs"][0]["line_name"], "地下鉄")
        self.assertFalse(response.json()["is_estimate"])
        search.assert_awaited_once_with(via_points=["35.0,135.0", "35.1,135.1"], departure_date="2026-10-13", departure_time="14:30")

    def test_same_location_is_zero_without_external_call(self):
        with patch("app.main.search_route", new=AsyncMock()) as search:
            response = self.client.post("/api/transit/segment", json={**self.payload, "destination": self.payload["origin"]})
        self.assertEqual(response.json()["fare_yen"], 0)
        search.assert_not_awaited()

    def test_unknown_fare_stays_unknown_and_invalid_coordinates_are_rejected(self):
        with patch("app.main.search_route", new=AsyncMock(return_value=([], 10, "", ""))):
            response = self.client.post("/api/transit/segment", json=self.payload)
        self.assertIsNone(response.json()["fare_yen"])
        self.assertEqual(self.client.post("/api/transit/segment", json={**self.payload,
            "origin": {**self.payload["origin"], "latitude": 999}}).status_code, 422)

    def test_duration_includes_walking_and_waiting(self):
        _, minutes = _parse_legs({"Route": {"timeOnBoard": "10", "timeOther": "5", "timeWalk": "8"}})
        self.assertEqual(minutes, 23)


class ProviderTimetableTests(unittest.TestCase):
    def test_structured_course_line_datetimes_include_access_walks(self):
        # Sanitized provider shape: Course has no top-level departureState.
        course = {"searchType": "departure", "dataType": "onTimetable", "Price": {"kind": "FareSummary", "Oneway": "450"},
            "Route": {"Point": [{"Name": "施設A"}, {"Station": {"Name": "駅A"}}, {"Name": "施設B"}],
                "Line": [
                    {"timeOnBoard": "3", "DepartureState": {"Datetime": {"text": "2026-10-14T09:00:00+09:00", "operation": "today"}},
                     "ArrivalState": {"Datetime": {"text": "2026-10-14T09:03:00+09:00", "operation": "today"}}},
                    {"Name": "鉄道", "Type": "train", "timeOnBoard": "20", "DepartureState": {"Datetime": {"text": "2026-10-14T09:03:00+09:00", "operation": "today"}},
                     "ArrivalState": {"Datetime": {"text": "2026-10-14T09:23:00+09:00", "operation": "today"}}},
                ]}}
        response = Mock(status_code=200)
        response.json.return_value = {"ResultSet": {"Course": course}}
        with patch.dict("os.environ", {"EKISPERT_API_KEY": "test-key"}), patch("app.ekispert.load_dotenv"), patch("app.ekispert.request_with_retry", AsyncMock(return_value=response)):
            result = asyncio.run(search_route(["35,135", "35.1,135.1"], "2026-10-14", "09:00"))
        self.assertEqual(result[1:4], (23, "09:00", "09:23"))
        self.assertEqual(result.fare_yen, 450)
        self.assertEqual(result.departure_at, "2026-10-14T09:00:00+09:00")
        self.assertEqual(result.arrival_at, "2026-10-14T09:23:00+09:00")

    def test_single_line_and_date_only_plain_response(self):
        self.assertEqual(_course_endpoint_times({"Route": {"Line": {
            "DepartureState": {"Datetime": "23:55:00+09:00"},
            "ArrivalState": {"Datetime": {"text": "00:15:00+09:00"}},
        }}}), ("23:55:00+09:00", "00:15:00+09:00"))
        self.assertEqual(_course_endpoint_times({"Route": {"Line": {
            "DepartureState": {"Datetime": {"text": "2026-10-14"}},
            "ArrivalState": {"Datetime": "invalid"},
        }}}), (None, None))
