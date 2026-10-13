import asyncio
import unittest
from datetime import date, datetime, time
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from app.discovery import DiscoverRequest, build_discover_routes, discover_routes
from app.image_search import _matches_place, _wikipedia_license
from app.itinerary import _build_day_schedule, _catalog_with_deadline, plan_overnight_itinerary
from app.models import CatalogPlace, Origin, OvernightItineraryRequest, PlaceSearchResponse, ParsedPlaceQuery, PlaceSearchHit, LunchPlan


def place(identifier, latitude=35.0, category="庭園", name=None):
    return CatalogPlace(id=identifier, name=name or identifier, category=category, region="京都府", address="京都", latitude=latitude, longitude=135.7, description="")


def response(*places):
    return PlaceSearchResponse(query=ParsedPlaceQuery(), results=[PlaceSearchHit(place=p, score=1) for p in places], note="fixture")


class DiscoveryBoundsTests(unittest.TestCase):
    def test_full_day_stays_fit_duration_and_exclude_outside_radius_and_hotels(self):
        origin = Origin(name="駅", latitude=35, longitude=135.7)
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=origin, radius_km=5, course="full_day")
        result = build_discover_routes(request, tuple([place(str(i), 35 + i / 1000) for i in range(10)] + [place("far", 36), place("hotel", category="ホテル")]))
        self.assertTrue(result["routes"])
        for route in result["routes"]:
            self.assertLessEqual(route["estimated_minutes"], 600)
            self.assertEqual(route["estimated_minutes"], sum(p["stay_minutes"] for p in route["spots"]) + sum(p["minutes"] for p in route["legs"]))
            self.assertTrue(all(p["place_id"] not in {"far", "hotel"} for p in route["spots"]))

    def test_sparse_theme_returns_only_matching_facility(self):
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7), theme="history")
        routes = build_discover_routes(request, (place("museum", category="博物館"), place("park", category="公園")))["routes"]
        self.assertEqual([p["place_id"] for p in routes[0]["spots"]], ["museum"])

    def test_discovery_applies_main_exclusions_and_keeps_notable_exception(self):
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7))
        pool = (place("park", category="公園"), place("cemetery", category="公園", name="市営墓園"),
                place("hospital", category="病院"), place("notable", category="墓地", name="高野山奥の院墓地"))
        routes = build_discover_routes(request, pool)["routes"]
        self.assertTrue(routes)
        self.assertEqual({spot["place_id"] for route in routes for spot in route["spots"]}, {"park", "notable"})

    def test_strict_photo_identity_requires_name_and_nearby_coordinates(self):
        page = {"title": "清水寺", "coordinates": [{"lat": 35, "lon": 135.7}]}
        self.assertTrue(_matches_place(page, "清水寺", 35, 135.7))
        self.assertFalse(_matches_place(page, "別の寺", 35, 135.7))
        self.assertFalse(_matches_place(page, "清水寺", 36, 135.7))
        self.assertFalse(_matches_place(page, "清水寺", None, None))
        self.assertFalse(_matches_place({"title": "清水寺"}, "清水寺", 35, 135.7))

    def test_license_spoof_host_is_rejected(self):
        self.assertIsNone(_wikipedia_license({"LicenseShortName": {"value": "CC BY"}, "LicenseUrl": {"value": "https://evil.example/creativecommons.org/licenses/by/4.0/"}}))

    def test_late_lunch_and_checkin_never_reverse_time(self):
        schedule = _build_day_schedule([place("one"), place("two")], datetime(2026, 10, 12, 12), "hotel", 180, 90, lunch=LunchPlan(reason="fixture"), hotel_destination=True)
        times = [item.start_time for item in schedule if item.start_time]
        self.assertEqual(times, sorted(times))
        self.assertGreaterEqual(schedule[-1].start_time, schedule[-2].end_time)


class OvernightBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_timeout_is_part_of_shared_budget(self):
        async def slow(*args, **kwargs):
            await asyncio.sleep(1)
        # Replace the application's module reference, not time.monotonic itself:
        # asyncio's selector loop uses that shared clock to expire its timers.
        with patch("app.itinerary.search_yahoo_catalog", side_effect=slow), patch("app.itinerary.time_module") as clock:
            clock.monotonic.return_value = 10
            with self.assertRaises(HTTPException) as error:
                await _catalog_with_deadline("query", 10.01)
        self.assertEqual(error.exception.status_code, 504)

    async def test_three_nights_use_unique_bounded_spots_and_linear_paid_calls(self):
        hotel = place("hotel", category="ホテル")
        spots = [place(str(i), 35 + i / 1000) for i in range(8)]
        search = AsyncMock(side_effect=[response(hotel), response(*spots, place("far", 36), place("cemetery", name="市営墓園"))])
        route = AsyncMock(return_value=([], 60, None, None))
        fare = AsyncMock(return_value=500)
        request = OvernightItineraryRequest(query="自然", departure_station="京都駅", origin_latitude=35, origin_longitude=135.7, departure_date=date(2026, 10, 12), nights=3, stops_per_day=2, radius_km=5)
        with patch("app.itinerary.search_yahoo_catalog", new=search), patch("app.itinerary.search_route", new=route), patch("app.itinerary.estimate_route_fare", new=fare), patch("app.itinerary._select_lunch", new=AsyncMock(return_value=LunchPlan(reason="fixture"))):
            result = await plan_overnight_itinerary(request)
        ids = [p.id for day in result.days for p in day.places]
        self.assertEqual(len(result.days), 4)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("far", ids)
        self.assertNotIn("cemetery", ids)
        self.assertEqual(route.await_count, 4)
        self.assertEqual(fare.await_count, 4)
        self.assertEqual(search.await_count, 2)
        self.assertTrue(all(call.kwargs["radius_m"] == 5000 for call in search.await_args_list))

    async def test_outside_hotels_cannot_override_requested_radius(self):
        search = AsyncMock(return_value=response(place("hotel", 36, "ホテル")))
        request = OvernightItineraryRequest(query="自然", departure_station="京都駅", origin_latitude=35, origin_longitude=135.7, departure_date=date(2026, 10, 12), radius_km=5)
        with patch("app.itinerary.search_yahoo_catalog", new=search):
            with self.assertRaises(HTTPException) as error:
                await plan_overnight_itinerary(request)
        self.assertEqual(error.exception.status_code, 404)


class LiveDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_mode_never_calls_external_provider(self):
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7))
        provider = AsyncMock()
        with patch.dict("os.environ", {"OPENPOI_ENABLED": "0", "PLACE_SEARCH_PROVIDER": "public_catalog", "YAHOO_APP_ID": "fixture"}), patch("app.poi_search.search_yahoo_catalog", new=provider), patch("app.discovery.load_public_places", return_value=(place("museum", category="博物館"),)):
            result = await discover_routes(request)
        provider.assert_not_awaited()
        self.assertIn("網羅", result["note"])

    async def test_live_candidates_are_filtered_after_one_bounded_search(self):
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7), theme="history", radius_km=5)
        provider = AsyncMock(return_value=response(place("museum", category="博物館"), place("far", 36, "博物館"), place("park", category="公園")))
        with patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "yahoo", "YAHOO_APP_ID": "fixture"}), patch("app.poi_search.search_yahoo_catalog", new=provider), patch("app.discovery.load_public_places", return_value=()):
            result = await discover_routes(request)
        self.assertEqual(provider.await_count, 1)
        self.assertEqual(provider.await_args.kwargs["radius_m"], 5000)
        self.assertEqual(result["routes"][0]["spots"][0]["place_id"], "museum")
        self.assertEqual(len(result["routes"][0]["spots"]), 1)


    async def test_wide_radius_supplements_even_abundant_live_candidates(self):
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7), radius_km=50, cross_prefecture=True)
        live = [place("live-" + str(i), 35 + i / 1000) for i in range(6)]
        across_border = place("border", 35.25).model_copy(update={"region": "滋賀県"})
        provider = AsyncMock(return_value=response(*live))
        with patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "yahoo", "YAHOO_APP_ID": "fixture"}), patch("app.poi_search.search_yahoo_catalog", new=provider), patch("app.discovery.load_public_places", return_value=(across_border,)), patch("app.discovery.build_discover_routes", wraps=build_discover_routes) as build:
            result = await discover_routes(request)
        self.assertEqual(provider.await_count, 1)
        self.assertEqual(provider.await_args.kwargs["radius_m"], 20000)
        self.assertIn("border", [p.id for p in build.call_args.args[1]])
        self.assertIn("OpenStreetMap", result["source"])
        self.assertTrue(result["routes"])


class DiscoveryEndpointTests(unittest.TestCase):
    def test_endpoint_returns_dynamic_response_and_rejects_invalid_radius(self):
        from fastapi.testclient import TestClient
        from app.main import app, limiter
        limiter.reset()
        payload = {"area": "kyoto", "prefecture_name": "京都府", "origin": {"name": "駅", "latitude": 35, "longitude": 135.7}, "radius_km": 5}
        with patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "public_catalog"}), patch("app.discovery.load_public_places", return_value=(place("garden"),)):
            client = TestClient(app)
            result = client.post("/api/discover", json=payload)
            invalid = client.post("/api/discover", json={**payload, "radius_km": 20001})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(set(result.json()), {"routes", "note", "source", "agent", "catalog", "review"})
        report = result.json()["review"]
        self.assertEqual(report["status"], "passed")
        self.assertEqual(client.post(f"/api/discover/reviews/{report['id']}/decision", params={"decision":"keep"}).status_code, 200)
        self.assertEqual(client.post(f"/api/discover/reviews/{report['id']}/decision", params={"decision":"adopt:dynamic-0000000000000000"}).status_code, 404)
        client.close()
        route = result.json()["routes"][0]
        self.assertTrue(route["id"].startswith("dynamic-"))
        self.assertEqual(route["spots"][0]["place_id"], "garden")
        self.assertEqual(invalid.status_code, 422)
