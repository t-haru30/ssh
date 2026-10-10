import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.fallback_ideas import load_fallback_ideas, select_fallback_ideas
from app.main import app
from app.models import Place, RouteIdeaResponse


def make_live_idea(places: list[Place]) -> RouteIdeaResponse:
    return RouteIdeaResponse(
        theme="nature",
        title="Live route",
        story="A route generated in real time.",
        places=places,
        copywriting_source="fallback",
        note="Live provider results",
    )


class FallbackIdeaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._limiter_patch = patch("app.main.limiter.enabled", False)
        cls._limiter_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls._limiter_patch.stop()

    def test_bundled_dataset_loads_valid_cards(self):
        ideas = load_fallback_ideas()
        self.assertGreaterEqual(len(ideas), 5)
        self.assertTrue(all(idea.prefecture_code == "26" for idea in ideas))
        self.assertTrue(all(idea.prefecture_name == "京都府" for idea in ideas))

    def test_selection_filters_theme_and_does_not_repeat_cards(self):
        ideas = load_fallback_ideas()
        selected = select_fallback_ideas(ideas, 10, "nature")

        self.assertTrue(selected)
        self.assertTrue(all(idea.theme == "nature" for idea in selected))
        signatures = [tuple(sorted(place.id for place in idea.places)) for idea in selected]
        self.assertEqual(len(signatures), len(set(signatures)))

    def test_fallback_flag_skips_live_providers_and_returns_requested_batch(self):
        with TestClient(app) as client, patch("app.main._route_candidates", new=AsyncMock()) as live_search:
            response = client.get("/api/ideas?theme=all&count=5&use_fallback=true")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["ideas"]), 5)
        self.assertEqual(payload["requested_count"], 5)
        self.assertEqual(payload["shortfall"], 0)
        self.assertEqual(payload["fallback_count"], 5)
        self.assertTrue(payload["used_fallback"])
        self.assertTrue(all("ローカルデータ" in idea["note"] for idea in payload["ideas"]))
        live_search.assert_not_awaited()

    def test_prefecture_code_filters_fallback_cards_without_live_search(self):
        with TestClient(app) as client, patch("app.main._route_candidates", new=AsyncMock()) as live_search:
            response = client.get(
                "/api/ideas?theme=all&count=5&prefecture_code=26",
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["ideas"]), 5)
        self.assertTrue(all(idea["prefecture_code"] == "26" for idea in payload["ideas"]))
        self.assertTrue(payload["used_fallback"])
        live_search.assert_not_awaited()

    def test_invalid_prefecture_code_is_rejected(self):
        with TestClient(app) as client:
            response = client.get("/api/ideas?prefecture_code=48&use_fallback=true")

        self.assertEqual(response.status_code, 422)

    def test_provider_failure_is_filled_from_fallback_dataset(self):
        with (
            TestClient(app) as client,
            patch(
                "app.main._route_candidates",
                new=AsyncMock(side_effect=HTTPException(502, "provider unavailable")),
            ),
        ):
            response = client.get("/api/ideas?theme=all&count=5")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["fallback_count"], 5)
        self.assertEqual(len(response.json()["ideas"]), 5)

    def test_excluded_signatures_are_not_returned_again(self):
        ideas = load_fallback_ideas()
        excluded = "|".join(sorted(place.id for place in ideas[0].places))
        with TestClient(app) as client:
            response = client.get(
                "/api/ideas?theme=all&count=5&use_fallback=true"
                f"&exclude={excluded}",
            )

        self.assertEqual(response.status_code, 200)
        returned_signatures = {
            tuple(sorted(place["id"] for place in idea["places"]))
            for idea in response.json()["ideas"]
        }
        self.assertNotIn(tuple(sorted(place.id for place in ideas[0].places)), returned_signatures)

    def test_partial_live_batch_is_filled_without_repeating_live_cards(self):
        candidates = [
            Place(
                id=f"live-{index}",
                name=f"スポット{index}",
                category="公園",
                description="",
                access_point="",
                latitude=35 + index / 100,
                longitude=135 + index / 100,
                themes=["nature"],
            )
            for index in range(3)
        ]

        async def generate(places, **_kwargs):
            return make_live_idea(places)

        with (
            TestClient(app) as client,
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(candidates, "live candidates")),
            ),
            patch("app.main.generate_idea_from_places", new=AsyncMock(side_effect=generate)),
        ):
            response = client.get("/api/ideas?theme=all&count=5&spot_count=2")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["ideas"]), 5)
        self.assertEqual(payload["fallback_count"], 3)
        self.assertTrue(payload["used_fallback"])
        live_search_signatures = [
            tuple(sorted(place["id"] for place in idea["places"]))
            for idea in payload["ideas"]
            if idea["title"] == "Live route"
        ]
        self.assertEqual(len(live_search_signatures), 2)
        self.assertEqual(len(live_search_signatures), len(set(live_search_signatures)))

    def test_single_card_endpoint_also_supports_local_only_mode(self):
        with TestClient(app) as client, patch("app.main._route_candidates", new=AsyncMock()) as live_search:
            response = client.get("/api/ideas/random?theme=food&use_fallback=true")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["theme"], "food")
        self.assertIn("ローカルデータ", response.json()["note"])
        live_search.assert_not_awaited()

    def test_batch_reports_when_theme_has_fewer_local_cards_than_requested(self):
        with TestClient(app) as client:
            response = client.get("/api/ideas?theme=food&count=5&use_fallback=true")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["ideas"]), 1)
        self.assertEqual(payload["requested_count"], 5)
        self.assertEqual(payload["shortfall"], 4)

    def test_empty_fallback_and_failed_live_generation_returns_service_unavailable(self):
        with (
            TestClient(app) as client,
            patch.object(client.app.state, "fallback_ideas", []),
            patch(
                "app.main._route_candidates",
                new=AsyncMock(side_effect=HTTPException(502, "provider unavailable")),
            ),
        ):
            response = client.get("/api/ideas/random?theme=nature")

        self.assertEqual(response.status_code, 503)
        self.assertIn("利用できる提案がありません", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
