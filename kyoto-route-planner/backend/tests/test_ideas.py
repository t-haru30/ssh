import os
import unittest
from fastapi import HTTPException
from unittest.mock import AsyncMock, Mock, patch

import httpx

from fastapi.testclient import TestClient

from app.copywriting import RouteCopywriting
from app.image_search import search_pixabay_image
from app.main import app
from app.models import Place


def sample_places() -> list[Place]:
    return [
        Place(
            id=f"idea-{index}",
            name=name,
            category="公園",
            description="",
            access_point="座標から経路検索",
            latitude=35.0 + index / 100,
            longitude=135.7 + index / 100,
            themes=["nature"],
        )
        for index, name in enumerate(("円山公園", "京都府立植物園", "鴨川公園"), start=1)
    ]


class RandomRouteIdeaTests(unittest.TestCase):
    def test_random_idea_returns_two_spots_and_fallback_copy_without_route_search(self):
        client = TestClient(app)
        candidates = sample_places()
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(candidates, "Yahoo test candidates")),
            ),
            patch("app.main.generate_route_copywriting", new=AsyncMock(return_value=None)),
            patch("app.main.search_pixabay_image", new=AsyncMock(return_value=None)),
            patch("app.main.search_route", new=AsyncMock()) as route_search,
        ):
            response = client.get("/api/ideas/random?theme=nature&spot_count=2")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["theme"], "nature")
        self.assertEqual(payload["copywriting_source"], "fallback")
        self.assertTrue(payload["title"])
        self.assertTrue(payload["story"])
        self.assertIsNone(payload["image_url"])
        self.assertEqual(len(payload["places"]), 2)
        route_search.assert_not_awaited()

    def test_random_idea_uses_gemini_copy_and_caps_spots_at_three(self):
        client = TestClient(app)
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(sample_places(), "Yahoo test candidates")),
            ),
            patch(
                "app.main.generate_route_copywriting",
                new=AsyncMock(return_value=RouteCopywriting("Gemini title", "Gemini story")),
            ) as generate_copy,
            patch(
                "app.main.search_pixabay_image",
                new=AsyncMock(return_value="https://pixabay.com/get/example.jpg"),
            ) as search_image,
            patch("app.main.search_route", new=AsyncMock()) as route_search,
        ):
            response = client.get("/api/ideas/random?theme=all&spot_count=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["copywriting_source"], "gemini")
        self.assertEqual(payload["title"], "Gemini title")
        self.assertEqual(payload["story"], "Gemini story")
        self.assertEqual(len(payload["places"]), 3)
        self.assertEqual(payload["image_url"], "https://pixabay.com/get/example.jpg")
        generate_copy.assert_awaited_once()
        search_image.assert_awaited_once_with(payload["places"][0]["name"])
        route_search.assert_not_awaited()

    def test_random_idea_rejects_invalid_spot_count(self):
        response = TestClient(app).get("/api/ideas/random?spot_count=1")
        self.assertEqual(response.status_code, 422)

    def test_random_idea_requires_at_least_two_candidates(self):
        with patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(sample_places()[:1], "Yahoo result")),
        ):
            response = TestClient(app).get("/api/ideas/random?theme=nature")

        self.assertEqual(response.status_code, 404)

    def test_gemini_failure_uses_local_copy_fallback(self):
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(sample_places(), "Yahoo test candidates")),
            ),
            patch(
                "app.main.generate_route_copywriting",
                new=AsyncMock(side_effect=HTTPException(502, "Gemini unavailable")),
            ),
            patch("app.main.search_pixabay_image", new=AsyncMock(return_value=None)),
        ):
            response = TestClient(app).get("/api/ideas/random?theme=nature&spot_count=2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["copywriting_source"], "fallback")
        self.assertIn("Geminiを利用できなかった", response.json()["note"])

    def test_pixabay_failure_does_not_fail_idea_response(self):
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(sample_places(), "Yahoo test candidates")),
            ),
            patch("app.main.generate_route_copywriting", new=AsyncMock(return_value=None)),
            patch("app.main.search_pixabay_image", new=AsyncMock(return_value=None)),
        ):
            response = TestClient(app).get(
                "/api/ideas/random?theme=nature&spot_count=2",
            )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["image_url"])


class PixabayImageSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_api_key_returns_none_without_request(self):
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"PIXABAY_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient") as async_client,
        ):
            image_url = await search_pixabay_image("清水寺")

        self.assertIsNone(image_url)
        async_client.assert_not_called()

    async def test_returns_large_image_url_for_first_hit(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "hits": [{"largeImageURL": "https://pixabay.com/get/large.jpg"}],
        }
        client = AsyncMock()
        client.get.return_value = response
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"PIXABAY_API_KEY": "test-key"}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image_url = await search_pixabay_image("清水寺")

        self.assertEqual(image_url, "https://pixabay.com/get/large.jpg")
        client.get.assert_awaited_once()
        self.assertEqual(client.get.await_args.kwargs["params"]["q"], "清水寺")

    async def test_network_failure_returns_none(self):
        client = AsyncMock()
        client.get.side_effect = httpx.ConnectError("Pixabay unavailable")
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client

        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"PIXABAY_API_KEY": "test-key"}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image_url = await search_pixabay_image("清水寺")

        self.assertIsNone(image_url)


if __name__ == "__main__":
    unittest.main()
