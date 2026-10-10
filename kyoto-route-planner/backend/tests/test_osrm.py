import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.osrm import fetch_detailed_polyline


class OSRMTests(unittest.IsolatedAsyncioTestCase):
    async def test_route_request_uses_https(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": "Ok",
            "routes": [
                {
                    "geometry": {
                        "coordinates": [[135.0, 35.0], [136.0, 36.0]],
                    },
                },
            ],
        }
        client = AsyncMock()
        client.get.return_value = response
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with patch("app.osrm.httpx.AsyncClient", return_value=client_context):
            result = await fetch_detailed_polyline([[35.0, 135.0], [36.0, 136.0]])

        self.assertEqual(result, [[35.0, 135.0], [36.0, 136.0]])
        request_url = client.get.await_args.args[0]
        self.assertTrue(request_url.startswith("https://"))
