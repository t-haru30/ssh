import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.station_search import StationCandidate, search_stations


class StationSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_name_is_enriched_by_code_and_wgs84(self):
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.path.endswith('/light'):
                self.assertEqual(request.url.params['name'], '中野')
                self.assertEqual(request.url.params['nameMatchType'], 'partial')
                return httpx.Response(200, json={'ResultSet': {'Point': [
                    {'Station': {'code': code, 'Name': '中野', 'Type': 'train'}} for code in ['1', '2']]}})
            code = request.url.params['code']
            self.assertEqual(request.url.params['gcs'], 'wgs84')
            return httpx.Response(200, json={'ResultSet': {'Point': {
                'Station': {'code': code, 'Name': '中野'}, 'Prefecture': {'Name': '県' + code},
                'GeoPoint': {'gcs': 'wgs84', 'lati_d': str(34 + int(code)), 'longi_d': '135'}}}})
        client = httpx.AsyncClient
        with patch.dict(os.environ, {'EKISPERT_API_KEY': 'test-only'}), patch(
            'app.station_search.httpx.AsyncClient',
            side_effect=lambda **kw: client(transport=httpx.MockTransport(handler), **kw),
        ):
            results = await search_stations(' 中野駅 ')
        self.assertEqual([r.code for r in results], ['1', '2'])
        self.assertEqual([r.latitude for r in results], [35, 36])
        self.assertEqual([r.prefecture for r in results], ['県1', '県2'])
        self.assertEqual(results[1].lines, [])
        self.assertEqual(results[0].name, '中野駅')
        self.assertEqual(len(requests), 3)

    async def test_query_and_missing_key(self):
        with patch.dict(os.environ, {'EKISPERT_API_KEY': ''}):
            for query, status in [('', 422), ('駅', 422), ('x' * 81, 422), ('京都', 503)]:
                with self.subTest(query=query), self.assertRaises(HTTPException) as error:
                    await search_stations(query)
                self.assertEqual(error.exception.status_code, status)

    async def test_provider_failure_never_becomes_empty_or_exposes_key(self):
        client = httpx.AsyncClient
        with patch.dict(os.environ, {'EKISPERT_API_KEY': 'private-test-key'}), patch(
            'app.station_search.httpx.AsyncClient',
            side_effect=lambda **kw: client(transport=httpx.MockTransport(lambda request: httpx.Response(403)), **kw),
        ):
            with self.assertRaises(HTTPException) as error:
                await search_stations('京都')
        self.assertEqual(error.exception.status_code, 502)
        self.assertNotIn('private-test-key', error.exception.detail)


class StationSearchEndpointTests(unittest.TestCase):
    def setUp(self):
        from app.main import app, limiter
        limiter.reset()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()

    def test_same_name_candidates_keep_distinct_metadata_and_coordinates(self):
        candidates = [
            StationCandidate(name="中野駅", code="1", prefecture="東京都", latitude=35, longitude=139),
            StationCandidate(name="中野駅", code="2", prefecture="長野県", latitude=36, longitude=138),
        ]
        with patch("app.main.search_stations", new=AsyncMock(return_value=candidates)) as search:
            response = self.client.get("/api/stations/search", params={"q": "中野"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [station.model_dump() for station in candidates])
        search.assert_awaited_once_with("中野")

    def test_empty_query_rejected_before_provider(self):
        with patch("app.main.search_stations", new=AsyncMock()) as search:
            response = self.client.get("/api/stations/search", params={"q": ""})
        self.assertEqual(response.status_code, 422)
        search.assert_not_awaited()

    def test_timeout_returns_504(self):
        with patch("app.main.search_stations", new=AsyncMock(side_effect=TimeoutError)) as search:
            response = self.client.get("/api/stations/search", params={"q": "京都"})
        self.assertEqual(response.status_code, 504)
        self.assertIn("タイムアウト", response.json()["detail"])
        search.assert_awaited_once_with("京都")
