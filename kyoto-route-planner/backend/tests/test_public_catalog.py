import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app import public_catalog
from app.models import CatalogPlace, ParsedPlaceQuery
from app.poi_search import get_yahoo_search_status, search_yahoo_catalog


class PublicCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "public_places.json"
        self.places = [
            CatalogPlace(id="osm-node-1", name="試験寺院", category="寺院", region="京都府", address="京都府",
                         latitude=35, longitude=135, description=""),
            CatalogPlace(id="osm-node-2", name="試験カフェ", category="カフェ", region="京都府", address="京都府",
                         latitude=35.001, longitude=135, description=""),
            CatalogPlace(id="osm-node-3", name="東京の公園", category="公園", region="東京都", address="東京都",
                         latitude=35.68, longitude=139.76, description=""),
        ]
        self.path.write_text(json.dumps({"version": 1, "license": {"name": "ODbL-1.0"},
                                         "places": [place.model_dump() for place in self.places]}), encoding="utf-8")
        self.patch = patch.object(public_catalog, "PUBLIC_CATALOG_PATH", self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        public_catalog.load_public_places.cache_clear()
        self.addCleanup(public_catalog.load_public_places.cache_clear)

    def test_public_provider_never_calls_yahoo_even_with_a_configured_key(self):
        with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "public_catalog", "YAHOO_APP_ID": "unused"}), \
             patch("app.poi_search._search_yahoo", new=AsyncMock()) as yahoo, \
             patch("app.poi_search.load_dotenv") as dotenv:
            result = asyncio.run(search_yahoo_catalog("カフェ", center=(35, 135), radius_m=1000))
            self.assertEqual([hit.place.id for hit in result.results], ["osm-node-2"])
            self.assertEqual(get_yahoo_search_status()["source"], "OpenStreetMap")
            yahoo.assert_not_called()
            dotenv.assert_not_called()

    def test_explicit_radius_and_genre_exclude_other_places(self):
        query = ParsedPlaceQuery(center_latitude=35, center_longitude=135, max_distance_m=1000)
        result = public_catalog.search_public_catalog(query, "観光", 20, ("0424001",))
        self.assertEqual([hit.place.id for hit in result.results], ["osm-node-1"])
        self.assertEqual(result.results[0].distance_m, 0)

    def test_nationwide_region_search_removes_the_legacy_kyoto_warning(self):
        query = ParsedPlaceQuery(region="東京都", warnings=["この試作の検索対象は京都府内です。"])
        result = public_catalog.search_public_catalog(query, "公園", 20)
        self.assertEqual([hit.place.id for hit in result.results], ["osm-node-3"])
        self.assertEqual(result.query.warnings, [])

    def test_unknown_name_returns_empty_without_substituting_another_place(self):
        query = ParsedPlaceQuery(keywords=["未登録美術館"])
        self.assertEqual(public_catalog.search_public_catalog(query, "未登録美術館", 20).results, [])

    def test_temple_search_uses_names_when_osm_category_is_generic(self):
        self.places[0].category = "観光名所"
        self.path.write_text(json.dumps({"version": 1, "license": {"name": "ODbL-1.0"},
                                         "places": [place.model_dump() for place in self.places]}), encoding="utf-8")
        with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "public_catalog"}):
            result = asyncio.run(search_yahoo_catalog("寺院 神社", center=(35, 135),
                                 radius_m=1000, genre_codes=("0424001", "0424002")))
        self.assertEqual([hit.place.id for hit in result.results], ["osm-node-1"])
        self.assertEqual(result.results[0].place.genre_code, "0424001")

    def test_non_osm_catalog_cannot_be_loaded(self):
        self.places[0].id = "p12-private"
        self.path.write_text(json.dumps({"version": 1, "license": {"name": "ODbL-1.0"},
                                         "places": [place.model_dump() for place in self.places]}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "only OSM"):
            public_catalog.load_public_places()

    def test_nature_theme_search_includes_viewpoints_without_the_word_park(self):
        self.places[0].name = "海辺の展望台"
        self.places[0].category = "展望地"
        self.path.write_text(json.dumps({"version": 1, "license": {"name": "ODbL-1.0"},
                                         "places": [place.model_dump() for place in self.places]}), encoding="utf-8")
        with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "public_catalog"}):
            result = asyncio.run(search_yahoo_catalog("公園 自然 景色", center=(35, 135),
                                 radius_m=1000, genre_codes=("0305007",)))
        self.assertEqual([hit.place.id for hit in result.results], ["osm-node-1"])

    def test_missing_catalog_does_not_fall_back_to_a_database_or_network(self):
        self.path.unlink()
        result = public_catalog.search_public_catalog(ParsedPlaceQuery(), "観光", 20)
        self.assertEqual(result.results, [])
        self.assertIn("読み込めません", result.note)
