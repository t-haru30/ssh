import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from app.models import CatalogPlace, PlaceSearchHit, PlaceSearchRequest, PlaceSearchResponse
from app.place_search_service import search_catalog
from app.search import parse_place_query


def place(identifier, name, category="神社", region="京都府", latitude=35):
    return CatalogPlace(id=identifier, name=name, category=category, region=region,
                        address=region, latitude=latitude, longitude=135, description="")


def kyoto_source_catalog():
    # Test real committed OSM sources, without requiring a prior frontend build
    # or the developer's ignored backend/data directory in a clean CI checkout.
    source = Path(__file__).resolve().parents[2] / "frontend/src/data/routes/kyoto.json"
    rows = {spot["place_id"]: spot for route in json.loads(source.read_text(encoding="utf-8"))["routes"]
            for spot in route["spots"] if spot["place_id"].startswith("osm-")}
    return tuple(CatalogPlace(id=row["place_id"], name=row["name"], category=row["category"],
        region="京都府", address="京都府", latitude=row["lat"], longitude=row["lng"], description="") for row in rows.values())


class PlaceSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_external_supplement_respects_semantics_region_and_radius(self):
        base = PlaceSearchResponse(query=parse_place_query("京都 神社"), results=[], note="登録候補")
        pool = (place("shrine", "試験神宮", "観光名所"), place("cafe", "喫茶店", "カフェ"),
                place("osaka", "大阪神社", region="大阪府"), place("far", "遠方神社", latitude=37))
        with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "public_catalog"}), \
             patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(return_value=base)), \
             patch("app.openpoi.enrich_candidates", new=AsyncMock(return_value=(pool, "ready"))):
            result = await search_catalog(PlaceSearchRequest(query="京都 神社", center_latitude=35, center_longitude=135))
        self.assertEqual([hit.place.id for hit in result.results], ["shrine"])
        self.assertEqual(result.related_results, [])
        self.assertTrue(result.suggestions)

    async def test_related_temple_candidates_require_opt_in_and_remain_separate(self):
        shrine = place("shrine", "試験神宮", "神宮")
        temple = place("temple", "試験寺院", "寺院")
        base = PlaceSearchResponse(query=parse_place_query("京都 神社"),
            results=[PlaceSearchHit(place=shrine, score=50)], note="登録候補")
        extra = PlaceSearchResponse(query=parse_place_query("京都 寺院"),
            results=[PlaceSearchHit(place=temple, score=50)], note="登録候補")
        with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "public_catalog"}), \
             patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(side_effect=[base, extra])) as search, \
             patch("app.openpoi.enrich_candidates", new=AsyncMock(return_value=((shrine,), "ready"))):
            result = await search_catalog(PlaceSearchRequest(query="京都 神社", center_latitude=35,
                                                            center_longitude=135, include_related=True))
        self.assertEqual([hit.place.id for hit in result.results], ["shrine"])
        self.assertEqual([hit.place.id for hit in result.related_results], ["temple"])
        self.assertIn("条件を広げた", result.related_note)
        self.assertEqual(search.await_args.kwargs["genre_codes"], ("0424001", "0424002"))

    async def test_related_groups_work_for_both_providers_and_do_not_mutate_cache(self):
        for provider in ("public_catalog", "yahoo"):
            for query, category, expected in (("京都 カフェ", "カフェ", ("01",)),
                    ("京都 博物館", "美術館", ("0305002", "0305003")),
                    ("京都 自然", "庭園", ("0305007", "0303004"))):
                with self.subTest(provider=provider, query=query):
                    base = PlaceSearchResponse(query=parse_place_query(query), results=[], note="登録候補")
                    valid = place("related", "近隣施設", category)
                    wrong = place("wrong", "無関係", "ホテル")
                    extra = PlaceSearchResponse(query=parse_place_query("観光"), results=[
                        PlaceSearchHit(place=valid, score=50), PlaceSearchHit(place=wrong, score=50),
                        PlaceSearchHit(place=place("far", "遠方", category, latitude=37), score=50),
                        PlaceSearchHit(place=place("osaka", "別府県", category, region="大阪府"), score=50)], note="候補")
                    with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": provider}), \
                         patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(side_effect=[base, extra])) as search, \
                         patch("app.openpoi.enrich_candidates", new=AsyncMock(return_value=((), "ready"))):
                        result = await search_catalog(PlaceSearchRequest(query=query, center_latitude=35,
                            center_longitude=135, include_related=True))
                    self.assertTrue(result.related_available)
                    self.assertEqual([hit.place.id for hit in result.related_results], ["related"])
                    self.assertEqual(search.await_args.kwargs["genre_codes"], expected)
                    self.assertEqual(base.related_results, [])

    async def test_named_venue_infers_related_group_but_unknown_query_does_not(self):
        for results, available in (([PlaceSearchHit(place=place("named", "試験施設", "博物館"), score=100)], True), ([], False)):
            base = PlaceSearchResponse(query=parse_place_query("試験施設"), results=results, note="候補")
            with patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "yahoo"}), \
                 patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(return_value=base)) as search:
                result = await search_catalog(PlaceSearchRequest(query="試験施設", center_latitude=35, center_longitude=135))
            self.assertEqual(result.related_available, available)
            self.assertEqual(result.related_results, [])
            search.assert_awaited_once()

    async def test_yahoo_failure_uses_actual_kyoto_shrine_catalog_without_broadening(self):
        base = PlaceSearchResponse(query=parse_place_query("京都 神社"), results=[], note="Yahoo接続失敗")
        with patch("app.public_catalog.load_public_places", return_value=kyoto_source_catalog()), \
             patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "yahoo"}), \
             patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(return_value=base)):
            result = await search_catalog(PlaceSearchRequest(query="京都 神社"))
        self.assertGreater(len(result.results), 0)
        self.assertTrue(all(hit.place.region == "京都府" for hit in result.results))
        self.assertTrue(all(hit.place.genre_code == "0424002" for hit in result.results))
        self.assertTrue(all(hit.place.id.startswith("osm-") for hit in result.results))
        self.assertIn("OpenStreetMap", result.note)
        self.assertEqual(base.results, [])

    async def test_empty_related_provider_uses_bundled_nearby_genre_candidates(self):
        base = PlaceSearchResponse(query=parse_place_query("京都 神社"), results=[], note="Yahoo接続失敗")
        empty = PlaceSearchResponse(query=parse_place_query("京都 観光"), results=[], note="Yahoo接続失敗")
        with patch("app.public_catalog.load_public_places", return_value=kyoto_source_catalog()), \
             patch.dict(os.environ, {"PLACE_SEARCH_PROVIDER": "yahoo"}), \
             patch("app.place_search_service.search_yahoo_catalog", new=AsyncMock(side_effect=[base, empty])):
            result = await search_catalog(PlaceSearchRequest(query="京都 神社", center_latitude=35.01,
                center_longitude=135.76, include_related=True))
        self.assertGreater(len(result.related_results), 0)
        self.assertTrue(all(hit.place.region == "京都府" and hit.distance_m <= 20000
            and hit.place.genre_code in ("0424001", "0424002") for hit in result.related_results))
        self.assertFalse({hit.place.id for hit in result.results} & {hit.place.id for hit in result.related_results})
