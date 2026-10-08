import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.yahoo_local import clear_cache, search_yahoo_places


YAHOO_XML = """<?xml version="1.0" encoding="UTF-8"?>
<YDF xmlns="http://olp.yahooapis.jp/ydf/1.0">
  <Feature>
    <Id>123</Id>
    <Name>栗林公園</Name>
    <Geometry><Coordinates>134.0434,34.3367</Coordinates></Geometry>
    <Category>公園・庭園</Category>
    <Address>香川県高松市栗林町</Address>
    <Property><Tel1>087-833-7411</Tel1></Property>
  </Feature>
</YDF>"""


class YahooLocalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        clear_cache()

    async def test_missing_app_id_uses_local_sample_catalog(self):
        with patch.dict(os.environ, {}, clear=True):
            places = await search_yahoo_places("香川県 観光")

        self.assertEqual(places[0].id, "sample-kiyomizu-dera")

    async def test_xml_response_is_mapped_to_generic_place(self):
        response = httpx.Response(
            200,
            content=YAHOO_XML.encode("utf-8"),
            request=httpx.Request("GET", "https://example.test"),
        )
        with (
            patch.dict(os.environ, {"YAHOO_CLIENT_ID": "test-app-id"}),
            patch("app.yahoo_local.httpx.AsyncClient") as client_factory,
        ):
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=response)
            places = await search_yahoo_places("香川県 観光", category_code="0101")

        self.assertEqual(places[0].name, "栗林公園")
        self.assertEqual(places[0].address, "香川県高松市栗林町")
        self.assertEqual((places[0].latitude, places[0].longitude), (34.3367, 134.0434))
        self.assertEqual(places[0].tags["phone"], "087-833-7411")
        client.get.assert_awaited_once()
        self.assertEqual(client.get.await_args.kwargs["params"]["appid"], "test-app-id")

    async def test_transport_error_uses_local_sample_catalog(self):
        with (
            patch.dict(os.environ, {"YAHOO_CLIENT_ID": "test-app-id"}),
            patch("app.yahoo_local.httpx.AsyncClient") as client_factory,
        ):
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(side_effect=httpx.ConnectError("offline"))
            places = await search_yahoo_places("絶景")

        self.assertTrue(places)
        self.assertTrue(places[0].id.startswith("sample-"))
