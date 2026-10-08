import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from app.models import (
    CatalogPlace,
    PlaceSearchHit,
    PlaceSearchResponse,
)
from app.poi_search import (
    YAHOO_GEOCODER_URL,
    YAHOO_LOCAL_SEARCH_URL,
    _geocoder_query,
    _local_search_params,
    _merge_results,
    _parse_yahoo_places,
    search_places_with_fallback,
)
from app.search import parse_place_query


def yahoo_feature(
    name: str = "京都の神社",
    category: str = "神社",
    coordinates: str = "135.759,34.986",
    address: str = "京都府京都市",
) -> dict:
    return {
        "Id": "1234",
        "Name": name,
        "Geometry": {"Type": "point", "Coordinates": coordinates},
        "Category": "",
        "Description": "Yahooの説明",
        "Property": {
            "Address": address,
            "GovernmentCode": "26100",
            "Genre": {"Code": "123", "Name": category} if category else {},
        },
    }


def yahoo_payload(*features: dict) -> dict:
    return {
        "YDF": {
            "ResultInfo": {"Status": 200, "Count": len(features)},
            "Feature": list(features),
        }
    }


def hit(
    place_id: str,
    name: str,
    category: str = "神社",
    address: str = "",
    description: str = "",
    latitude: float = 35.002,
    longitude: float = 135.768,
) -> PlaceSearchHit:
    return PlaceSearchHit(
        place=CatalogPlace(
            id=place_id,
            name=name,
            category=category,
            region="京都府",
            address=address,
            latitude=latitude,
            longitude=longitude,
            description=description,
        ),
        score=0.8,
    )


def response(*hits: PlaceSearchHit) -> PlaceSearchResponse:
    return PlaceSearchResponse(
        query=parse_place_query("京都駅周辺の神社"),
        results=list(hits),
        note="",
    )


class YahooPrioritySearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dotenv_patcher = patch("app.poi_search.load_dotenv")
        self.dotenv_patcher.start()

    def tearDown(self):
        self.dotenv_patcher.stop()

    async def test_complete_yahoo_results_skip_overpass(self):
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200,
            json=yahoo_payload(yahoo_feature()),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch("app.poi_search.search_osm_places", new_callable=AsyncMock) as osm_search,
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(len(result.results), 1)
        self.assertEqual(result.results[0].place.id, "yahoo-1234")
        self.assertEqual(result.results[0].place.category, "神社")
        self.assertEqual(
            client.get.await_args.args[0],
            YAHOO_LOCAL_SEARCH_URL,
        )
        params = client.get.await_args.kwargs["params"]
        self.assertEqual(params["lat"], 34.98585)
        self.assertEqual(params["lon"], 135.75877)
        self.assertEqual(params["query"], "神社")
        osm_search.assert_not_awaited()

    async def test_incomplete_yahoo_results_are_enriched_and_prioritized(self):
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200,
            json=yahoo_payload(yahoo_feature(category="", address="")),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        osm_response = response(
            hit(
                "osm-1",
                "京都の神社",
                address="京都市東山区",
                description="OSMの補完説明",
                latitude=34.986,
                longitude=135.759,
            ),
            hit("osm-2", "近くの寺院", latitude=35.01, longitude=135.77),
        )

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                return_value=osm_response,
            ) as osm_search,
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual([item.place.id for item in result.results], ["yahoo-1234", "osm-2"])
        self.assertEqual(result.results[0].place.category, "神社")
        self.assertEqual(result.results[0].place.address, "京都市東山区")
        self.assertEqual(result.results[0].place.description, "Yahooの説明")
        osm_search.assert_awaited_once()
        self.assertIn("Overpass", result.note)

    async def test_yahoo_failure_uses_overpass_and_both_fail_return_no_results(self):
        client = AsyncMock()
        client.get.side_effect = httpx.ReadTimeout("request timed out")
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                return_value=response(hit("osm-1", "京都の神社")),
            ),
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(result.results[0].place.id, "osm-1")
        self.assertIn("Overpass", result.note)

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                side_effect=HTTPException(status_code=502, detail="Overpass unavailable"),
            ),
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(result.results, [])
        self.assertIn("取得できません", result.note)

    async def test_empty_yahoo_result_uses_overpass(self):
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200,
            json=yahoo_payload(),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                return_value=response(hit("osm-1", "京都の神社")),
            ) as osm_search,
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(result.results[0].place.id, "osm-1")
        osm_search.assert_awaited_once()

    async def test_yahoo_result_without_coordinates_triggers_overpass(self):
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200,
            json=yahoo_payload(yahoo_feature(coordinates="")),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                return_value=response(hit("osm-1", "京都の神社")),
            ) as osm_search,
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(result.results[0].place.id, "osm-1")
        osm_search.assert_awaited_once()

    async def test_unconfigured_yahoo_app_id_falls_back_without_network_call(self):
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.poi_search.httpx.AsyncClient") as client_factory,
            patch(
                "app.poi_search.search_osm_places",
                new_callable=AsyncMock,
                return_value=response(hit("osm-1", "京都の神社")),
            ),
        ):
            result = await search_places_with_fallback("京都駅周辺の神社")

        self.assertEqual(result.results[0].place.id, "osm-1")
        client_factory.assert_not_called()

    async def test_unregistered_station_is_geocoded_before_local_search(self):
        geocoder_response = httpx.Response(
            200,
            json=yahoo_payload(
                {
                    "Geometry": {
                        "Type": "point",
                        "Coordinates": "137.726,34.710",
                    }
                }
            ),
            request=httpx.Request("GET", YAHOO_GEOCODER_URL),
        )
        local_search_response = httpx.Response(
            200,
            json=yahoo_payload(yahoo_feature()),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client = AsyncMock()
        client.get.side_effect = [geocoder_response, local_search_response]
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch.dict("os.environ", {"YAHOO_APP_ID": "test-app-id"}),
            patch("app.poi_search.httpx.AsyncClient", return_value=client_context),
            patch("app.poi_search.search_osm_places", new_callable=AsyncMock),
        ):
            await search_places_with_fallback("浜松駅周辺の神社")

        geocode_params = client.get.await_args_list[0].kwargs["params"]
        local_params = client.get.await_args_list[1].kwargs["params"]
        self.assertEqual(geocode_params["query"], "浜松")
        self.assertEqual(local_params["lat"], 34.71)
        self.assertEqual(local_params["lon"], 137.726)

    def test_yahoo_distance_filter_is_applied_exactly_after_api_search(self):
        intent = parse_place_query("京都駅周辺の神社を半径100m以内")
        intent.center_latitude = 34.98585
        intent.center_longitude = 135.75877
        inside = yahoo_feature(coordinates="135.75900,34.98600")
        outside = yahoo_feature(
            name="遠い神社",
            coordinates="135.77000,35.00000",
        )

        results, incomplete = _parse_yahoo_places(
            yahoo_payload(inside, outside),
            intent,
            20,
        )

        self.assertFalse(incomplete)
        self.assertEqual([item.place.name for item in results], ["京都の神社"])
        params = _local_search_params(
            "京都駅周辺の神社",
            intent,
            "test-app-id",
            20,
            (intent.center_latitude, intent.center_longitude),
            None,
        )
        self.assertEqual(params["dist"], 0.1)
        self.assertEqual(params["sort"], "geo")

    def test_prefecture_search_uses_address_code_without_geocoding_or_geo_sort(self):
        intent = parse_place_query("東京都のラーメン")

        self.assertIsNone(_geocoder_query("東京都のラーメン", intent))
        params = _local_search_params(
            "東京都のラーメン",
            intent,
            "test-app-id",
            20,
            None,
            None,
        )
        self.assertEqual(params["ac"], "13")
        self.assertNotIn("sort", params)
        self.assertNotIn("dist", params)

    def test_distance_without_resolved_center_does_not_assume_kyoto(self):
        intent = parse_place_query("半径2km以内でラーメン")
        params = _local_search_params(
            "半径2km以内でラーメン",
            intent,
            "test-app-id",
            20,
            None,
            None,
        )

        self.assertTrue(intent.location_unresolved)
        self.assertNotIn("lat", params)
        self.assertNotIn("lon", params)
        self.assertNotIn("dist", params)

    def test_duplicate_names_at_distinct_locations_are_preserved(self):
        yahoo_hit = hit(
            "yahoo-1",
            "ローソン",
            latitude=34.986,
            longitude=135.759,
        )
        nearby_osm_hit = hit(
            "osm-near",
            "ローソン",
            address="京都市",
            latitude=34.98601,
            longitude=135.75901,
        )
        distant_osm_hit = hit(
            "osm-far",
            "ローソン",
            latitude=35.01,
            longitude=135.71,
        )

        merged = _merge_results([yahoo_hit], [nearby_osm_hit, distant_osm_hit], 10)

        self.assertEqual([item.place.id for item in merged], ["yahoo-1", "osm-far"])
        self.assertEqual(merged[0].place.address, "京都市")

    def test_missing_region_metadata_is_not_mislabeled_as_kyoto(self):
        feature = yahoo_feature(address="")
        feature["Property"]["GovernmentCode"] = ""
        results, incomplete = _parse_yahoo_places(
            yahoo_payload(feature),
            parse_place_query("浜松駅周辺の神社"),
            20,
        )

        self.assertFalse(incomplete)
        self.assertEqual(results[0].place.region, "")


if __name__ == "__main__":
    unittest.main()
