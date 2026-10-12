"""The latest main's enrichment/filtering must preserve offline provider behavior."""
import unittest
from unittest.mock import AsyncMock, patch

from app.main import _route_candidates
from app.models import CatalogPlace, Origin, ParsedPlaceQuery, PlaceSearchHit, PlaceSearchResponse


class RouteCandidateIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def response(self):
        return PlaceSearchResponse(
            query=ParsedPlaceQuery(), note="fixture",
            results=[PlaceSearchHit(place=CatalogPlace(
                id=identifier, name=name, category="公園", region="東京都", address="東京都",
                latitude=36, longitude=139.7, description=""), score=1)
                for identifier, name in (("park", "市民公園"), ("cemetery", "市営墓園"), ("hospital", "市立病院"))],
        )

    async def test_public_mode_filters_candidates_without_fame_network_lookup(self):
        search = AsyncMock(return_value=self.response())
        enrichment = AsyncMock()
        with patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "public_catalog", "YAHOO_APP_ID": "fixture"}), \
             patch("app.main.search_yahoo_catalog", new=search), \
             patch("app.main.enrich_places_with_fame", new=enrichment):
            candidates, _ = await _route_candidates("all", Origin(name="駅", latitude=36, longitude=139.7), 5)
        enrichment.assert_not_awaited()
        self.assertEqual([place.id for place in candidates], ["park"])
        self.assertEqual(search.await_count, 1)

    async def test_live_yahoo_mode_keeps_main_fame_enrichment(self):
        enrichment = AsyncMock(side_effect=lambda places: places)
        with patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "yahoo", "YAHOO_APP_ID": "fixture"}), \
             patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=self.response())), \
             patch("app.main.enrich_places_with_fame", new=enrichment):
            candidates, _ = await _route_candidates("all", Origin(name="駅", latitude=36, longitude=139.7), 5)
        enrichment.assert_awaited_once()
        self.assertEqual([place.id for place in candidates], ["park"])
