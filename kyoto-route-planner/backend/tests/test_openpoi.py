"""OpenPOI validation and discovery wiring; all network boundaries are mocked."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import openpoi
from app.discovery import DiscoverRequest, discover_routes
from app.models import Origin


def request(**changes):
    return DiscoverRequest(area="kyoto", prefecture_name="京都府",
        origin=Origin(name="駅", latitude=35, longitude=135.7), **changes)


def row(**changes):
    result = dict(name="青空博物館", category="museum", prefecture="京都府",
        city="京都市中京区", address="京都府京都市中京区西ノ京町12",
        lat=35.001, lng=135.701, licenses=["CC BY 4.0"], attributions=["Example source"])
    result.update(changes)
    return result


def place(**changes):
    return openpoi.parse_candidate(row(**changes), request())


class CandidateValidationTests(unittest.TestCase):
    def test_valid_candidate_retains_license_and_attribution(self):
        candidate = place()
        self.assertIsNotNone(candidate)
        self.assertIn("CC BY 4.0", candidate.tags["licenses"])
        self.assertIn("Example source", candidate.tags["attributions"])

    def test_exact_name_outside_radius_is_rejected(self):
        self.assertIsNone(openpoi.parse_candidate(row(lat=35.2), request(radius_km=1)))

    def test_nonfinite_boolean_and_string_coordinates_rejected(self):
        for key in ("lat", "lng"):
            for value in (float("nan"), float("inf"), -float("inf"), True, False, "35", 10 ** 1000):
                with self.subTest(key=key, value=value):
                    self.assertIsNone(place(**{key: value}))

    def test_unknown_and_conflicting_categories_rejected(self):
        for fields in (dict(category="shop"), dict(category="museum", business_type="cafe"),
                       dict(category="tourism", name="青空土産店")):
            with self.subTest(fields=fields):
                self.assertIsNone(place(**fields))

    def test_missing_or_invalid_license_metadata_rejected(self):
        for key in ("licenses", "attributions"):
            for value in (None, [], "CC BY", [""], [42]):
                with self.subTest(key=key, value=value):
                    self.assertIsNone(place(**{key: value}))

    def test_city_and_neighbourhood_must_match(self):
        municipalities = {"26104": (openpoi.normalized("京都府"), openpoi.normalized("京都市中京区")),
                          "26103": (openpoi.normalized("京都府"), openpoi.normalized("京都市左京区"))}
        candidate = place()
        self.assertTrue(openpoi.address_matches(candidate, {"muniCd": "26104", "lv01Nm": "西ノ京町"}, municipalities))
        for result in ({"muniCd": "26103", "lv01Nm": "西ノ京町"},
                       {"muniCd": "26104", "lv01Nm": "別の町"},
                       {"muniCd": "26104", "lv01Nm": ""}):
            self.assertFalse(openpoi.address_matches(candidate, result, municipalities))

    def test_osm_wins_even_with_shifted_coordinates_at_same_address(self):
        osm = place().model_copy(update={"id": "osm-1"})
        shifted = place(lat=35.02)
        self.assertEqual(openpoi.merge_candidates((osm,), (shifted,)), (osm,))

    def test_same_brand_distinct_branches_are_retained(self):
        first = place(name="青空カフェ", category="cafe")
        second = place(name="青空カフェ", category="cafe", lat=35.02,
                       address="京都府京都市中京区別町10")
        self.assertEqual(openpoi.merge_candidates((first,), (second,)), (first, second))


class OpenPOIAsyncTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        async def verified_fixture(request, candidates, existing_google=()):
            return tuple(candidates), {'status':'ready'}
        gate=patch('app.facility_quality.filter_quality',side_effect=verified_fixture)
        gate.start();self.addCleanup(gate.stop)
    async def asyncSetUp(self):
        openpoi._cache.clear()
        openpoi._reverse_cache.clear()
        openpoi._municipalities.clear()
        openpoi._slots = asyncio.Semaphore(2)
        self.env = patch.dict(os.environ, {"OPENPOI_ENABLED": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.network = patch.object(httpx.AsyncClient, "get", new=AsyncMock(
            side_effect=AssertionError("Unexpected live HTTP request")))
        self.network.start()
        self.addCleanup(self.network.stop)

    async def test_timeout_and_http_failure_preserve_osm(self):
        osm = (place().model_copy(update={"id": "osm-1"}),)
        for error in (TimeoutError(), httpx.ConnectError("offline"), ValueError("bad payload")):
            with self.subTest(error=type(error).__name__), patch.object(openpoi, "_search", new=AsyncMock(side_effect=error)):
                openpoi._cache.clear()
                self.assertEqual(await openpoi.enrich_candidates(request(), osm), (osm, "unavailable"))

    async def test_municipality_javascript_is_parsed_and_cached(self):
        response = httpx.Response(200, request=httpx.Request("GET", openpoi.MUNICIPALITIES_URL),
            text='GSI.MUNI_ARRAY["26104"] = \'26,京都府,26104,京都市中京区\';')
        client = AsyncMock()
        client.get.return_value = response
        expected = {"26104": (openpoi.normalized("京都府"), openpoi.normalized("京都市中京区"))}
        self.assertEqual(await openpoi._load_municipalities(client), expected)
        self.assertEqual(await openpoi._load_municipalities(client), expected)
        client.get.assert_awaited_once_with(openpoi.MUNICIPALITIES_URL)

    async def test_search_survives_partial_api_failure_and_returns_verified_only(self):
        accepted = row()
        wrong_neighbourhood = row(name="別館博物館", lat=35.002)
        outside = row(name="遠方博物館", lat=36)

        async def fetch(client, url, params):
            if url == openpoi.SEARCH_URL:
                if params["q"] == "":
                    raise httpx.ConnectError("one search failed")
                return {"results": [accepted, wrong_neighbourhood, outside]}
            self.assertEqual(url, openpoi.REVERSE_URL)
            return {"results": {"muniCd": "26104", "lv01Nm":
                "西ノ京町" if params["lat"] == accepted["lat"] else "別の町"}}

        municipalities = {"26104": (openpoi.normalized("京都府"), openpoi.normalized("京都市中京区"))}
        with patch.object(openpoi, "_json", new=AsyncMock(side_effect=fetch)) as fetch_mock, \
             patch.object(openpoi, "_load_municipalities", new=AsyncMock(return_value=municipalities)):
            result = await openpoi._search(request())
        self.assertEqual([p.name for p in result], [accepted["name"]])
        self.assertEqual(result[0].tags["position_check"], "gsi_neighbourhood")
        search_calls = [call for call in fetch_mock.await_args_list if call.args[1] == openpoi.SEARCH_URL]
        self.assertEqual(len(search_calls), 3)
        self.assertEqual(search_calls[0].args[2]["radius"], 30000)

    async def test_cache_reuses_search_and_merges_current_osm(self):
        extra = place()
        with patch.object(openpoi, "_search", new=AsyncMock(return_value=(extra,))) as search:
            self.assertEqual(await openpoi.enrich_candidates(request(), ()), ((extra,), "ready"))
            osm = extra.model_copy(update={"id": "osm-1"})
            self.assertEqual(await openpoi.enrich_candidates(request(), (osm,)), ((osm,), "ready"))
            search.assert_awaited_once()

    async def test_reverse_mismatch_rejected_and_success_cached(self):
        candidate = place()
        municipalities = {"26104": (openpoi.normalized("京都府"), openpoi.normalized("京都市中京区"))}
        with patch.object(openpoi, "_json", new=AsyncMock(return_value={"results": {"muniCd": "26104", "lv01Nm": "西ノ京町"}})) as fetch:
            for _ in range(2):
                verified = await openpoi._verified(None, candidate, municipalities, asyncio.Semaphore(1))
                self.assertEqual(verified.tags["position_check"], "gsi_neighbourhood")
            fetch.assert_awaited_once()
        openpoi._reverse_cache.clear()
        with patch.object(openpoi, "_json", new=AsyncMock(return_value={"results": {"muniCd": "26104", "lv01Nm": "別の町"}})):
            self.assertIsNone(await openpoi._verified(None, candidate, municipalities, asyncio.Semaphore(1)))

    async def test_candidates_inserted_before_agent_selection(self):
        osm = place(name="既存博物館").model_copy(update={"id": "osm-1"})
        extra = place(lat=35.01)
        fallback = {"note": "base", "routes": []}
        async def recommend(req, candidates, result):
            self.assertEqual({p.id for p in candidates}, {osm.id, extra.id})
            self.assertEqual(result["catalog"]["openpoi_added"], 1)
            return result
        with patch("app.discovery._base_discover_catalog", new=AsyncMock(return_value=(fallback, (osm,)))), \
             patch.object(openpoi, "_search", new=AsyncMock(return_value=(extra,))), \
             patch("app.discovery_agent.recommend_routes", new=AsyncMock(side_effect=recommend)) as agent:
            result = await discover_routes(request())
        agent.assert_awaited_once()
        self.assertEqual(result["catalog"]["openpoi_status"], "ready")
        self.assertEqual(result["source"], "OpenStreetMap / OpenPOI API")


if __name__ == "__main__":
    unittest.main()
