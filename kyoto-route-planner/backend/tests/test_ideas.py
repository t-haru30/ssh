import unittest
from fastapi import HTTPException
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.copywriting import RouteCopywriting
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
            patch("app.main.search_route", new=AsyncMock()) as route_search,
        ):
            response = client.get("/api/ideas/random?theme=nature&spot_count=2")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["theme"], "nature")
        self.assertEqual(payload["copywriting_source"], "fallback")
        self.assertTrue(payload["title"])
        self.assertTrue(payload["story"])
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
            patch("app.main.search_route", new=AsyncMock()) as route_search,
        ):
            response = client.get("/api/ideas/random?theme=all&spot_count=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["copywriting_source"], "gemini")
        self.assertEqual(payload["title"], "Gemini title")
        self.assertEqual(payload["story"], "Gemini story")
        self.assertEqual(len(payload["places"]), 3)
        generate_copy.assert_awaited_once()
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
        ):
            response = TestClient(app).get("/api/ideas/random?theme=nature&spot_count=2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["copywriting_source"], "fallback")
        self.assertIn("Geminiを利用できなかった", response.json()["note"])


if __name__ == "__main__":
    unittest.main()
