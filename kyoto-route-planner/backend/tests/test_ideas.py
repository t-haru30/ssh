import os
import unittest
from fastapi import HTTPException
from unittest.mock import AsyncMock, Mock, patch

import httpx

from fastapi.testclient import TestClient

from app.copywriting import RouteCopywriting
from app.image_search import (
    FLICKR_COMMERCIAL_LICENSES,
    FLICKR_API_URL,
    WIKIPEDIA_API_URL,
    WIKIMEDIA_USER_AGENT,
    CommercialImage,
    _image_cache,
    search_commercial_image,
)
from app.main import app
from app.models import Place, RouteIdeaResponse


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
    @classmethod
    def setUpClass(cls):
        cls._limiter_patch = patch("app.main.limiter.enabled", False)
        cls._limiter_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls._limiter_patch.stop()

    def test_random_idea_returns_two_spots_and_fallback_copy_without_route_search(self):
        client = TestClient(app)
        candidates = sample_places()
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(candidates, "Yahoo test candidates")),
            ),
            patch("app.idea_service.generate_route_copywriting", new=AsyncMock(return_value=None)),
            patch("app.idea_service.search_commercial_image", new=AsyncMock(return_value=None)),
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
                "app.idea_service.generate_route_copywriting",
                new=AsyncMock(return_value=RouteCopywriting("Gemini title", "Gemini story")),
            ) as generate_copy,
            patch(
                "app.idea_service.search_commercial_image",
                new=AsyncMock(return_value=CommercialImage(
                    image_url="https://upload.wikimedia.org/example.jpg",
                    author_name="Test photographer",
                    source_url="https://commons.wikimedia.org/wiki/File:Example.jpg",
                    license_name="CC BY-SA 4.0",
                    license_url="https://creativecommons.org/licenses/by-sa/4.0/",
                )),
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
        self.assertEqual(payload["image_url"], "https://upload.wikimedia.org/example.jpg")
        self.assertEqual(payload["author_name"], "Test photographer")
        self.assertEqual(payload["source_url"], "https://commons.wikimedia.org/wiki/File:Example.jpg")
        self.assertEqual(payload["license_name"], "CC BY-SA 4.0")
        self.assertEqual(payload["license_url"], "https://creativecommons.org/licenses/by-sa/4.0/")
        generate_copy.assert_awaited_once()
        search_image.assert_awaited_once_with(payload["places"][0]["name"])
        route_search.assert_not_awaited()

    def test_random_idea_rejects_invalid_spot_count(self):
        response = TestClient(app).get("/api/ideas/random?spot_count=1")
        self.assertEqual(response.status_code, 422)

    def test_random_idea_uses_local_cards_when_live_candidates_are_insufficient(self):
        with patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(sample_places()[:1], "Yahoo result")),
        ):
            response = TestClient(app).get("/api/ideas/random?theme=nature")

        self.assertEqual(response.status_code, 200)
        self.assertIn("ローカルデータ", response.json()["note"])

    def test_gemini_failure_uses_local_copy_fallback(self):
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(sample_places(), "Yahoo test candidates")),
            ),
            patch(
                "app.idea_service.generate_route_copywriting",
                new=AsyncMock(side_effect=HTTPException(502, "Gemini unavailable")),
            ),
            patch("app.idea_service.search_commercial_image", new=AsyncMock(return_value=None)),
        ):
            response = TestClient(app).get("/api/ideas/random?theme=nature&spot_count=2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["copywriting_source"], "fallback")
        self.assertIn("Geminiを利用できなかった", response.json()["note"])

    def test_commercial_image_failure_does_not_fail_idea_response(self):
        with (
            patch(
                "app.main._route_candidates",
                new=AsyncMock(return_value=(sample_places(), "Yahoo test candidates")),
            ),
            patch("app.idea_service.generate_route_copywriting", new=AsyncMock(return_value=None)),
            patch("app.idea_service.search_commercial_image", new=AsyncMock(return_value=None)),
        ):
            response = TestClient(app).get(
                "/api/ideas/random?theme=nature&spot_count=2",
            )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["image_url"])

    def test_idea_response_rejects_images_without_complete_https_attribution(self):
        with self.assertRaises(ValueError):
            RouteIdeaResponse(
                theme="nature",
                title="Test",
                story="Test story",
                places=sample_places()[:2],
                image_url="https://upload.wikimedia.org/example.jpg",
                copywriting_source="fallback",
                note="",
            )

        with self.assertRaises(ValueError):
            RouteIdeaResponse(
                theme="nature",
                title="Test",
                story="Test story",
                places=sample_places()[:2],
                image_url="https://upload.wikimedia.org/example.jpg",
                author_name="Photographer",
                source_url="http://commons.wikimedia.org/wiki/File:Example.jpg",
                license_name="CC BY 4.0",
                license_url="https://creativecommons.org/licenses/by/4.0/",
                copywriting_source="fallback",
                note="",
            )


class CommercialImageSearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _image_cache.clear()

    @staticmethod
    def _response(payload: dict, status_code: int = 200):
        response = Mock()
        response.status_code = status_code
        response.json.return_value = payload
        return response

    @staticmethod
    def _client_context(*responses):
        client = AsyncMock()
        client.get.side_effect = list(responses)
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        return client, client_context

    def _wikipedia_responses(self):
        return (
            self._response({
                "query": {"pages": [{"pageimage": "Kiyomizu-dera.jpg"}]},
            }),
            self._response({
                "query": {
                    "pages": [{
                        "imageinfo": [{
                            "thumburl": "https://upload.wikimedia.org/thumb.jpg",
                            "url": "https://upload.wikimedia.org/original.jpg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Kiyomizu-dera.jpg",
                            "extmetadata": {
                                "Artist": {"value": '<a href="/wiki/User:A">Alice</a>'},
                                "LicenseShortName": {"value": "CC BY-SA 4.0"},
                                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"},
                            },
                        }],
                    }],
                },
            }),
        )

    async def test_wikipedia_image_is_used_first_with_license_and_author(self):
        client, client_context = self._client_context(*self._wikipedia_responses())
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": "flickr-key"}),
            patch(
                "app.image_search.httpx.AsyncClient",
                return_value=client_context,
            ) as async_client,
        ):
            image = await search_commercial_image("清水寺")

        self.assertEqual(image, CommercialImage(
            image_url="https://upload.wikimedia.org/thumb.jpg",
            author_name="Alice",
            source_url="https://commons.wikimedia.org/wiki/File:Kiyomizu-dera.jpg",
            license_name="CC BY-SA 4.0",
            license_url="https://creativecommons.org/licenses/by-sa/4.0/",
        ))
        self.assertEqual(client.get.await_count, 2)
        first_call = client.get.await_args_list[0]
        self.assertEqual(first_call.args[0], WIKIPEDIA_API_URL)
        self.assertEqual(first_call.kwargs["params"]["pilicense"], "free")
        self.assertEqual(first_call.kwargs["params"]["piprop"], "thumbnail|name")
        self.assertEqual(first_call.kwargs["params"]["maxlag"], 5)
        self.assertEqual(
            async_client.call_args.kwargs["headers"]["User-Agent"],
            WIKIMEDIA_USER_AGENT,
        )

    async def test_wikipedia_image_metadata_is_fetched_in_one_batched_request(self):
        page_response = self._response({
            "query": {"pages": [
                {"pageimage": "Kiyomizu-dera.jpg"},
                {"pageimage": "Kyoto-temple.jpg"},
            ]},
        })
        image_response = self._wikipedia_responses()[1]
        client, client_context = self._client_context(page_response, image_response)
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("京都の寺院")

        self.assertIsNotNone(image)
        self.assertEqual(client.get.await_count, 2)
        metadata_call = client.get.await_args_list[1]
        self.assertEqual(
            metadata_call.kwargs["params"]["titles"],
            "File:Kiyomizu-dera.jpg|File:Kyoto-temple.jpg",
        )
        self.assertEqual(metadata_call.kwargs["params"]["maxlag"], 5)

    async def test_flickr_is_used_only_after_wikipedia_and_excludes_noncommercial_hits(self):
        flickr_payload = {
            "stat": "ok",
            "photos": {
                "photo": [
                    {
                        "id": "100",
                        "owner": "owner-nc",
                        "ownername": "Noncommercial photographer",
                        "license": "2",
                        "url_l": "https://live.staticflickr.com/nc.jpg",
                    },
                    {
                        "id": "101",
                        "owner": "owner-cc",
                        "ownername": "Commercial photographer",
                        "license": "5",
                        "url_l": "https://live.staticflickr.com/cc.jpg",
                    },
                ],
            },
        }
        client, client_context = self._client_context(
            self._response({"query": {"pages": []}}),
            self._response(flickr_payload),
        )
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": "flickr-key"}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("東福寺")

        self.assertEqual(image, CommercialImage(
            image_url="https://live.staticflickr.com/cc.jpg",
            author_name="Commercial photographer",
            source_url="https://www.flickr.com/photos/owner-cc/101",
            license_name="CC BY-SA 2.0",
            license_url="https://creativecommons.org/licenses/by-sa/2.0/",
        ))
        flickr_call = client.get.await_args_list[1]
        self.assertEqual(flickr_call.args[0], FLICKR_API_URL)
        self.assertEqual(
            set(flickr_call.kwargs["params"]["license"].split(",")),
            FLICKR_COMMERCIAL_LICENSES,
        )
        self.assertEqual(
            flickr_call.kwargs["params"]["license"],
            "4,5,6,7,8,9,10",
        )

    async def test_wikipedia_noncommercial_and_unattributed_images_are_rejected(self):
        page_response, image_response = self._wikipedia_responses()
        image_payload = image_response.json.return_value
        metadata = image_payload["query"]["pages"][0]["imageinfo"][0]["extmetadata"]
        metadata["Artist"] = {"value": ""}
        metadata["LicenseShortName"] = {"value": "CC BY-NC-SA 4.0"}
        metadata["LicenseUrl"] = {
            "value": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        }
        client, client_context = self._client_context(
            page_response,
            image_response,
            self._response({"query": {"pages": []}}),
        )
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("ライセンス確認")

        self.assertIsNone(image)
        self.assertEqual(client.get.await_count, 2)

    async def test_flickr_is_not_called_without_key_or_free_wikipedia_image(self):
        client, client_context = self._client_context(
            self._response({"query": {"pages": []}}),
        )
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("画像なし")

        self.assertIsNone(image)
        client.get.assert_awaited_once()

    async def test_malformed_wikipedia_payload_falls_back_safely(self):
        client, client_context = self._client_context(
            self._response({"query": None}),
            self._response({"stat": "ok", "photos": {"photo": []}}),
        )
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": "flickr-key"}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("不正応答")

        self.assertIsNone(image)
        self.assertEqual(client.get.await_count, 2)

    async def test_commercial_image_result_is_cached(self):
        client, client_context = self._client_context(*self._wikipedia_responses())
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            first_result = await search_commercial_image("cache fixture")
            second_result = await search_commercial_image(" cache   fixture ")

        self.assertEqual(first_result, second_result)
        self.assertEqual(client.get.await_count, 2)

    async def test_provider_network_failure_returns_none(self):
        client, client_context = self._client_context()
        client.get.side_effect = httpx.ConnectError("provider unavailable")
        with (
            patch("app.image_search.load_dotenv"),
            patch.dict(os.environ, {"FLICKR_API_KEY": ""}),
            patch("app.image_search.httpx.AsyncClient", return_value=client_context),
        ):
            image = await search_commercial_image("京都")

        self.assertIsNone(image)


if __name__ == "__main__":
    unittest.main()
