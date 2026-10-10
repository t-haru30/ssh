import unittest
from unittest.mock import AsyncMock

import httpx

from app.http_client import provider_timeout, request_with_retry


def response(status_code: int, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(
        status_code,
        headers=headers,
        request=httpx.Request("GET", "https://provider.example/api"),
    )


class ProviderHttpClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_server_errors_once(self):
        client = AsyncMock()
        client.get.side_effect = [response(503), response(200)]
        sleep = AsyncMock()

        result = await request_with_retry(
            client,
            "GET",
            "https://provider.example/api",
            sleep=sleep,
        )

        self.assertEqual(result.status_code, 200)
        self.assertEqual(client.get.await_count, 2)
        sleep.assert_awaited_once()

    async def test_does_not_retry_client_errors(self):
        client = AsyncMock()
        client.get.return_value = response(401)
        sleep = AsyncMock()

        result = await request_with_retry(
            client,
            "GET",
            "https://provider.example/api",
            sleep=sleep,
        )

        self.assertEqual(result.status_code, 401)
        client.get.assert_awaited_once()
        sleep.assert_not_awaited()

    async def test_retries_rate_limit_and_caps_retry_after(self):
        client = AsyncMock()
        client.get.side_effect = [
            response(429, {"Retry-After": "30"}),
            response(200),
        ]
        sleep = AsyncMock()

        await request_with_retry(
            client,
            "GET",
            "https://provider.example/api",
            sleep=sleep,
        )

        self.assertEqual(sleep.await_args.args[0], 1.5)

    async def test_retries_transport_errors(self):
        client = AsyncMock()
        client.get.side_effect = [
            httpx.ConnectError("connection reset"),
            response(200),
        ]
        sleep = AsyncMock()

        result = await request_with_retry(
            client,
            "GET",
            "https://provider.example/api",
            sleep=sleep,
        )

        self.assertEqual(result.status_code, 200)
        self.assertEqual(client.get.await_count, 2)

    async def test_raises_after_transport_retries_are_exhausted(self):
        client = AsyncMock()
        error = httpx.ConnectError("connection reset")
        client.get.side_effect = error

        with self.assertRaises(httpx.ConnectError):
            await request_with_retry(
                client,
                "GET",
                "https://provider.example/api",
                sleep=AsyncMock(),
            )

        self.assertEqual(client.get.await_count, 2)

    def test_provider_timeout_has_separate_connection_and_pool_bounds(self):
        timeout = provider_timeout(12)

        self.assertEqual(timeout.connect, 3)
        self.assertEqual(timeout.pool, 3)
        self.assertEqual(timeout.read, 12)
        self.assertEqual(timeout.write, 5)
