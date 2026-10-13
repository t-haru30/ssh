import unittest
from unittest.mock import AsyncMock, patch
from starlette.requests import Request
from app.main import search_place_catalog
from app.models import CatalogPlace, ParsedPlaceQuery, PlaceSearchRequest, PlaceSearchResponse, Origin
from app.ekispert import _station_via_points
from app.discovery import DiscoverRequest
from app import openpoi


class EditorSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_named_search_returns_a_spot_outside_the_bundled_deck(self):
        extra = CatalogPlace(id='openpoi-extra', name='青空博物館', category='博物館', genre_code='0305003',
            region='京都府', address='京都府京都市中京区西ノ京町12', latitude=35.001, longitude=135.701,
            description='', tags={'source': 'OpenPOI API', 'licenses': '["CC BY 4.0"]'})
        base = PlaceSearchResponse(query=ParsedPlaceQuery(), results=[], note='local empty')
        request = Request({'type':'http', 'method':'POST', 'path':'/api/search/places', 'headers':[], 'client':('127.0.0.1',1234)})
        with patch.dict('os.environ', {'PLACE_SEARCH_PROVIDER':'public_catalog'}), patch('app.main.search_yahoo_catalog', new=AsyncMock(return_value=base)), patch('app.openpoi.enrich_candidates', new=AsyncMock(return_value=((extra,), 'ready'))) as enrich:
            endpoint = search_place_catalog
            while hasattr(endpoint, '__wrapped__'):
                endpoint = endpoint.__wrapped__
            result = await endpoint(request, PlaceSearchRequest(query='青空博物館', center_latitude=35, center_longitude=135.7))
        self.assertEqual(result.results[0].place.id, 'openpoi-extra')
        self.assertEqual(result.results[0].place.tags['licenses'], '["CC BY 4.0"]')
        self.assertEqual(enrich.await_args.kwargs['query'], '青空博物館')

    async def test_direct_search_cache_is_isolated_by_keyword(self):
        openpoi._cache.clear()
        scope = DiscoverRequest(area='editor', prefecture_name='全国', origin=Origin(name='起点',latitude=35,longitude=135.7))
        with patch.dict('os.environ', {'OPENPOI_ENABLED':'1'}), patch('app.openpoi._search', new=AsyncMock(return_value=())) as search:
            await openpoi.enrich_candidates(scope, (), query='博物館')
            await openpoi.enrich_candidates(scope, (), query='公園')
            self.assertEqual(search.await_count, 2)
        openpoi._cache.clear()

    def test_coordinate_route_search_includes_nearby_station_alternatives(self):
        self.assertEqual(_station_via_points(['35.123,135.456','東京']), ['35.123,135.456,wgs84,1000','東京'])
