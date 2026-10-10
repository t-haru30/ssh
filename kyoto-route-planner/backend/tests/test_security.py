import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.copywriting import generate_route_copywriting
from app.main import app, limiter
from app.models import Place


class FakeGeminiClient:
    def __init__(self, **_kwargs):
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, **kwargs):
        self.request = (url, kwargs)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {"title": "京都の旅", "story": "静かな旅です。"}
                                    )
                                }
                            ]
                        }
                    }
                ]
            },
        )


class SecurityTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()

    def test_gemini_api_key_is_sent_in_header_not_query(self):
        client = FakeGeminiClient()
        place = Place(
            id="place-1",
            name="清水寺",
            category="寺院",
            description="",
            access_point="",
            latitude=35.0,
            longitude=135.7,
            themes=["history", "temple"],
        )
        with (
            patch.dict("os.environ", {"GEMINI_API_KEY": "secret-gemini-key"}, clear=True),
            patch("app.copywriting.load_dotenv"),
            patch("app.copywriting.httpx.AsyncClient", return_value=client),
        ):
            result = asyncio.run(generate_route_copywriting([place], "temple"))

        self.assertIsNotNone(result)
        self.assertNotIn("key", client.request[1].get("params", {}))
        self.assertEqual(
            client.request[1]["headers"]["x-goog-api-key"],
            "secret-gemini-key",
        )

    def test_route_endpoint_returns_429_after_per_ip_limit(self):
        client = TestClient(app, client=("198.51.100.42", 12345))
        route_request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-09",
            "departure_time": "09:00",
        }
        with patch(
            "app.main._recommend_routes",
            new=AsyncMock(side_effect=HTTPException(status_code=503, detail="test")),
        ) as recommend:
            responses = [
                client.post("/api/routes", json=route_request)
                for _ in range(11)
            ]

        self.assertTrue(all(response.status_code == 503 for response in responses[:10]))
        self.assertEqual(responses[10].status_code, 429)
        self.assertEqual(recommend.await_count, 10)

    def test_random_idea_endpoint_returns_429_after_per_ip_limit(self):
        client = TestClient(app, client=("198.51.100.43", 12345))
        places = [
            Place(
                id=f"place-{index}",
                name=f"スポット{index}",
                category="公園",
                description="",
                access_point="",
                latitude=35.0 + index / 100,
                longitude=135.0 + index / 100,
                themes=["nature"],
            )
            for index in range(2)
        ]
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(places, "test candidates")),
            ) as candidates,
            patch("app.idea_service.generate_route_copywriting", new=AsyncMock(return_value=None)),
            patch("app.idea_service.search_commercial_image", new=AsyncMock(return_value=None)),
        ):
            responses = [
                client.get("/api/ideas/random?theme=nature&spot_count=2")
                for _ in range(6)
            ]

        self.assertTrue(all(response.status_code == 200 for response in responses[:5]))
        self.assertEqual(responses[5].status_code, 429)
        self.assertEqual(candidates.await_count, 5)
