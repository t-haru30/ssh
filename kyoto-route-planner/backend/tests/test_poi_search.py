import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.poi_search import (
    YAHOO_GEOCODER_URL,
    YAHOO_LOCAL_SEARCH_URL,
    _geocoder_query,
    _local_search_params,
    _parse_yahoo_places,
    get_yahoo_search_status,
    search_yahoo_catalog,
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


class YahooOnlySearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dotenv_patcher = patch("app.poi_search.load_dotenv")
        self.dotenv_patcher.start()
        self.environment_patcher = patch.dict(os.environ, {"YAHOO_APP_ID": "test-app-id"})
        self.environment_patcher.start()

    def tearDown(self):
        self.environment_patcher.stop()
        self.dotenv_patcher.stop()

    async def _search_with_response(self, payload: dict):
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        with patch("app.poi_search.httpx.AsyncClient", return_value=client_context):
            result = await search_yahoo_catalog("京都駅周辺の神社")
        return result, client

    async def test_valid_yahoo_results_are_returned(self):
        result, client = await self._search_with_response(yahoo_payload(yahoo_feature()))

        self.assertEqual([hit.place.id for hit in result.results], ["yahoo-1234"])
        self.assertEqual(result.results[0].place.category, "神社")
        self.assertEqual(result.results[0].place.address, "京都府京都市")
        self.assertEqual(client.get.await_args.args[0], YAHOO_LOCAL_SEARCH_URL)
        params = client.get.await_args.kwargs["params"]
        self.assertEqual(params["appid"], "test-app-id")
        self.assertEqual(params["query"], "神社")
        self.assertEqual(get_yahoo_search_status()["source"], "Yahoo! Local Search")
        self.assertEqual(get_yahoo_search_status()["state"], "success")
        self.assertNotIn("using_fallback", get_yahoo_search_status())

    async def test_no_results_return_empty_without_any_backup_provider(self):
        result, _ = await self._search_with_response(yahoo_payload())

        self.assertEqual(result.results, [])
        self.assertIn("見つかりません", result.note)
        self.assertEqual(get_yahoo_search_status()["state"], "error")

    async def test_incomplete_results_are_kept_with_warning(self):
        result, _ = await self._search_with_response(
            yahoo_payload(yahoo_feature(category="", address=""))
        )

        self.assertEqual(len(result.results), 1)
        self.assertEqual(result.results[0].place.id, "yahoo-1234")
        self.assertIn("不足", result.note)

    async def test_yahoo_failure_returns_empty_without_backup_provider(self):
        client = AsyncMock()
        client.get.side_effect = httpx.ReadTimeout("request timed out")
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        with patch("app.poi_search.httpx.AsyncClient", return_value=client_context):
            result = await search_yahoo_catalog("京都駅周辺の神社")

        self.assertEqual(result.results, [])
        self.assertIn("接続に失敗", result.note)
        self.assertEqual(get_yahoo_search_status()["state"], "error")

    async def test_missing_api_id_returns_empty_without_network_call(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("app.poi_search.httpx.AsyncClient") as client_factory,
        ):
            result = await search_yahoo_catalog("京都駅周辺の神社")

        self.assertEqual(result.results, [])
        self.assertIn("YAHOO_APP_ID", result.note)
        client_factory.assert_not_called()

    async def test_unregistered_station_is_geocoded_before_local_search(self):
        geocoder_response = httpx.Response(
            200,
            json=yahoo_payload(
                {"Geometry": {"Type": "point", "Coordinates": "137.726,34.710"}}
            ),
            request=httpx.Request("GET", YAHOO_GEOCODER_URL),
        )
        local_response = httpx.Response(
            200,
            json=yahoo_payload(yahoo_feature()),
            request=httpx.Request("GET", YAHOO_LOCAL_SEARCH_URL),
        )
        client = AsyncMock()
        client.get.side_effect = [geocoder_response, local_response]
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        with patch("app.poi_search.httpx.AsyncClient", return_value=client_context):
            await search_yahoo_catalog("浜松駅周辺の神社")

        self.assertEqual(client.get.await_args_list[0].kwargs["params"]["query"], "浜松")
        local_params = client.get.await_args_list[1].kwargs["params"]
        self.assertEqual(local_params["lat"], 34.71)
        self.assertEqual(local_params["lon"], 137.726)


class YahooParsingTests(unittest.TestCase):
    def test_distance_filter_is_applied_after_api_search(self):
        intent = parse_place_query("京都駅周辺の神社を半径100m以内")
        intent.center_latitude = 34.98585
        intent.center_longitude = 135.75877
        results, incomplete = _parse_yahoo_places(
            yahoo_payload(
                yahoo_feature(coordinates="135.75900,34.98600"),
                yahoo_feature(name="遠い神社", coordinates="135.77000,35.00000"),
            ),
            intent,
            20,
        )

        self.assertFalse(incomplete)
        self.assertEqual([hit.place.name for hit in results], ["京都の神社"])
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

    def test_prefecture_filter_does_not_use_default_center(self):
        intent = parse_place_query("東京都のラーメン")

        self.assertIsNone(_geocoder_query("東京都のラーメン", intent))
        params = _local_search_params("東京都のラーメン", intent, "test-app-id", 20, None, None)
        self.assertEqual(params["ac"], "13")
        self.assertNotIn("lat", params)
        self.assertNotIn("dist", params)

    def test_unresolved_radius_does_not_assume_kyoto(self):
        intent = parse_place_query("半径2km以内でラーメン")
        params = _local_search_params(
            "半径2km以内でラーメン", intent, "test-app-id", 20, None, None
        )

        self.assertTrue(intent.location_unresolved)
        self.assertNotIn("lat", params)
        self.assertNotIn("lon", params)
        self.assertNotIn("dist", params)

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
