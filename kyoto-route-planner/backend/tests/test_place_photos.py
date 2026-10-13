import asyncio
import json
import os
import ssl
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from pydantic import ValidationError

from app.models import Place
from app import image_search as images
from app import place_photos as photos


def place(name="清水寺", identifier="one"):
    return Place(id=identifier, name=name, category="寺", description="", access_point="",
                 latitude=35.0, longitude=135.7, themes=["temple"])


def image(description="清水寺の本堂を撮影した写真"):
    return images.CommercialImage(
        "https://upload.wikimedia.org/a/photo.jpg", "Alice",
        "https://commons.wikimedia.org/wiki/File:Photo.jpg", "CC BY-SA 4.0",
        "https://creativecommons.org/licenses/by-sa/4.0/", description,
        "File:Photo.jpg", "image/jpeg",
    )


class PlacePhotoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"PYTHON_DOTENV_DISABLED": "1", "GEMINI_API_KEY": "", "RECOMMENDATION_GEMINI_API_KEY": ""})
        self.environment.start()
        photos._photo_cache.clear()
        photos._negative_cache.clear()
        photos._inflight.clear()
        photos._ai_active = False
        photos._ai_used = 0

    async def asyncTearDown(self):
        tasks = list(photos._inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.environment.stop()

    async def test_no_key_strong_metadata_and_attribution_ready_without_ai_call(self):
        with patch.object(photos, "search_commercial_image", AsyncMock(return_value=image())), patch.object(photos.httpx, "AsyncClient") as network:
            result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
        self.assertEqual(result.status, "ready")
        self.assertEqual(result.place_id, "one")
        self.assertTrue(result.image_verified)
        self.assertFalse(result.ai_checked)
        self.assertEqual(result.author_name, "Alice")
        network.assert_not_called()

    async def test_ambiguous_metadata_without_ai_is_hidden(self):
        with patch.object(photos, "search_commercial_image", AsyncMock(return_value=image("地域の風景"))):
            result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
        self.assertEqual(result.status, "unavailable")
        self.assertIsNone(result.image_url)

    async def test_actual_second_place_identity_is_returned(self):
        lookup = AsyncMock(side_effect=[None, image("金閣寺の建物の写真")])
        with patch.object(photos, "search_commercial_image", lookup):
            result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place(), place("金閣寺", "two")]))
        self.assertEqual((result.place_id, result.place_name), ("two", "金閣寺"))

    async def test_success_and_negative_cache_avoid_extra_lookup(self):
        lookup = AsyncMock(side_effect=[None, image()])
        with patch.object(photos, "search_commercial_image", lookup):
            for _ in range(2):
                await photos.fetch_route_photo(photos.PhotoRequest(places=[place("不明", "unknown")]))
            for _ in range(2):
                await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
        self.assertEqual(lookup.await_count, 2)

    async def test_same_place_inflight_shared(self):
        event = asyncio.Event()
        async def lookup(*args):
            await event.wait()
            return image()
        with patch.object(photos, "search_commercial_image", AsyncMock(side_effect=lookup)) as search:
            request = photos.PhotoRequest(places=[place()])
            a = asyncio.create_task(photos.fetch_route_photo(request))
            b = asyncio.create_task(photos.fetch_route_photo(request))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            event.set()
            results = await asyncio.gather(a, b)
        self.assertTrue(all(result.status == "ready" for result in results))
        self.assertEqual(search.await_count, 1)

    async def test_one_viewer_cancellation_does_not_cancel_shared_lookup(self):
        event = asyncio.Event()
        async def lookup(*args):
            await event.wait()
            return image()
        with patch.object(photos, "search_commercial_image", AsyncMock(side_effect=lookup)):
            request = photos.PhotoRequest(places=[place()])
            a = asyncio.create_task(photos.fetch_route_photo(request))
            b = asyncio.create_task(photos.fetch_route_photo(request))
            await asyncio.sleep(0)
            a.cancel()
            await asyncio.gather(a, return_exceptions=True)
            event.set()
            self.assertEqual((await b).status, "ready")

    async def test_ai_rejection_overrides_strong_metadata(self):
        with patch.object(photos, "search_commercial_image", AsyncMock(return_value=image())), patch.object(photos, "_classify", AsyncMock(return_value=False)):
            result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
        self.assertEqual(result.status, "unavailable")

    async def test_ai_acceptance_is_marked_and_failure_falls_back(self):
        for decision, checked in ((True, True), (None, False)):
            photos._photo_cache.clear()
            with patch.object(photos, "search_commercial_image", AsyncMock(return_value=image())), patch.object(photos, "_classify", AsyncMock(return_value=decision)):
                result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
            self.assertEqual(result.status, "ready")
            self.assertEqual(result.ai_checked, checked)

    async def test_verified_provider_camera_metadata_works_without_ai(self):
        from dataclasses import replace
        candidate = replace(image("Myogyo Temple"), provider="wikidata", photo_evidence=True)
        with patch.object(photos, "search_commercial_image", AsyncMock(return_value=candidate)):
            result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
        self.assertEqual(result.status, "ready")
        self.assertEqual(result.provider, "wikidata")
        self.assertIsNone(result.failure_reason)
        self.assertFalse(result.ai_checked)

    async def test_lookup_failure_and_no_matching_licensed_photo_are_distinct_and_cached(self):
        for value, reason in ((None, "no_matching_licensed_photo"), (photos.PhotoLookupError("provider_failed"), "lookup_failed")):
            photos._negative_cache.clear()
            lookup = AsyncMock(side_effect=value) if isinstance(value, Exception) else AsyncMock(return_value=value)
            with patch.object(photos, "search_commercial_image", lookup):
                for _ in range(2):
                    result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
                    self.assertEqual(result.status, "unavailable")
                    self.assertEqual(result.failure_reason, reason)
                    self.assertIsNone(result.image_url)
            self.assertEqual(lookup.await_count, 1)

    async def test_unsafe_urls_licenses_mime_and_artwork_never_reach_ai(self):
        from dataclasses import replace
        cases = [replace(image(), image_url="https://upload.wikimedia.org.evil.test/p.jpg"),
                 replace(image(), source_url="https://commons.wikimedia.org/wiki/Other"),
                 replace(image(), filename="File:Other.jpg"), replace(image(), mime="image/svg+xml"),
                 replace(image(), author_name=""), replace(image(), license_name="CC BY-NC 4.0"),
                 replace(image(), description="清水寺の地図"), replace(image(), description="清水寺 portrait photograph"),
                 replace(image(), description="清水寺 AI-generated illustration")]
        with patch.object(photos, "_classify", AsyncMock()) as classifier:
            for candidate in cases:
                photos._negative_cache.clear()
                with patch.object(photos, "search_commercial_image", AsyncMock(return_value=candidate)):
                    result = await photos.fetch_route_photo(photos.PhotoRequest(places=[place()]))
                self.assertEqual(result.status, "unavailable")
        classifier.assert_not_awaited()

    async def test_route_deadline_and_lookup_timeout(self):
        async def never(*args):
            await asyncio.Event().wait()
        with patch.object(photos, "ROUTE_TIMEOUT", .03), patch.object(photos, "LOOKUP_TIMEOUT", .01), patch.object(photos, "search_commercial_image", AsyncMock(side_effect=never)) as lookup:
            result = await asyncio.wait_for(photos.fetch_route_photo(photos.PhotoRequest(places=[place(), place("別", "two"), place("第三", "three")])), .2)
        self.assertEqual(result.status, "unavailable")
        self.assertLessEqual(lookup.await_count, 3)

    def test_request_bounded_one_to_three_places(self):
        for places in ([], [place()] * 4):
            with self.assertRaises(ValidationError):
                photos.PhotoRequest(places=places)

    async def test_classifier_strict_json_no_search_no_image_url_sent_native_tls(self):
        response = httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"match":true}'}]}}]})
        client = AsyncMock()
        client.post.return_value = response
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(photos, "gemini_api_key", return_value="test-key"), patch.object(photos.httpx, "AsyncClient", return_value=context) as factory:
            decision = await photos._classify(place(), image(), 1)
        self.assertTrue(decision)
        self.assertEqual(photos._ai_used, 1)
        self.assertFalse(photos._ai_active)
        kwargs = factory.call_args.kwargs
        self.assertIsInstance(kwargs["verify"], ssl.SSLContext)
        self.assertFalse(kwargs["trust_env"])
        self.assertFalse(kwargs["follow_redirects"])
        body = client.post.call_args.kwargs["json"]
        self.assertNotIn("tools", body)
        self.assertNotIn("upload.wikimedia.org", json.dumps(body))

    async def test_classifier_rejects_unfinished_and_non_boolean_response(self):
        for finish, content in (("MAX_TOKENS", '{"match":true}'), ("STOP", '{"match":"true"}'), ("STOP", '{"match":true,"url":"https://evil.test"}')):
            client = AsyncMock()
            client.post.return_value = httpx.Response(200, json={"candidates": [{"finishReason": finish, "content": {"parts": [{"text": content}]}}]})
            context = AsyncMock()
            context.__aenter__.return_value = client
            with patch.object(photos, "gemini_api_key", return_value="test"), patch.object(photos.httpx, "AsyncClient", return_value=context):
                self.assertIsNone(await photos._classify(place(), image(), 1))

    async def test_classifier_budget_busy_failure_and_timeout(self):
        with patch.object(photos, "gemini_api_key", return_value="test"), patch.object(photos.httpx, "AsyncClient") as factory:
            photos._ai_used = 20
            self.assertIsNone(await photos._classify(place(), image(), 1))
            photos._ai_used = 0
            photos._ai_active = True
            self.assertIsNone(await photos._classify(place(), image(), 1))
            factory.assert_not_called()
        photos._ai_active = False
        client = AsyncMock()
        client.post.side_effect = httpx.ConnectError("secret error")
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(photos, "gemini_api_key", return_value="test"), patch.object(photos.httpx, "AsyncClient", return_value=context):
            self.assertIsNone(await photos._classify(place(), image(), 1))
        self.assertEqual(photos._ai_used, 1)
        self.assertFalse(photos._ai_active)

    async def test_classifier_actual_concurrency_rejected_and_timeout_releases_slot(self):
        entered = asyncio.Event()
        async def never(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()
        client = AsyncMock()
        client.post.side_effect = never
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(photos, "gemini_api_key", return_value="test"), patch.object(photos.httpx, "AsyncClient", return_value=context):
            first = asyncio.create_task(photos._classify(place(), image(), .05))
            await entered.wait()
            self.assertIsNone(await photos._classify(place("別", "two"), image(), 1))
            self.assertIsNone(await asyncio.wait_for(first, .3))
        self.assertEqual(client.post.await_count, 1)
        self.assertEqual(photos._ai_used, 1)
        self.assertFalse(photos._ai_active)


class WikimediaPhotoValidationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        images._image_cache.clear()
        images._negative_cache.clear()

    def payloads(self):
        metadata = {"ImageDescription": {"value": "清水寺の本堂の写真"}, "Artist": {"value": "Alice"},
                    "LicenseShortName": {"value": "CC BY-SA 4.0"}, "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"}}
        return [{"query": {"pages": [{"title": "清水寺", "coordinates": [{"lat": 35, "lon": 135.7}], "pageimage": "Photo.jpg"}]}},
                {"query": {"pages": [{"title": "File:Photo.jpg", "imageinfo": [{"url": "https://upload.wikimedia.org/a/p.jpg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:Photo.jpg", "mime": "image/jpeg", "extmetadata": metadata}]}]}}]

    async def search(self, payloads):
        client = AsyncMock()
        client.get.side_effect = [httpx.Response(200, json=data) for data in payloads]
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch.object(images.httpx, "AsyncClient", return_value=context) as factory:
            result = await images.search_commercial_image("清水寺", 35, 135.7)
        return result, client, factory

    async def test_exact_article_file_mime_and_tls(self):
        result, client, factory = await self.search(self.payloads())
        self.assertIsNotNone(result)
        self.assertEqual(client.get.await_count, 2)
        self.assertEqual(client.get.call_args.kwargs["params"]["iiprop"], "url|extmetadata|mime")
        self.assertIsInstance(factory.call_args.kwargs["verify"], ssl.SSLContext)
        self.assertFalse(factory.call_args.kwargs["trust_env"])
        self.assertFalse(factory.call_args.kwargs["follow_redirects"])

    async def test_localized_file_namespace_preserves_exact_filename(self):
        payloads = self.payloads()
        payloads[1]["query"]["pages"][0]["title"] = "ファイル:Photo.jpg"
        result, _, _ = await self.search(payloads)
        self.assertIsNotNone(result)
        self.assertTrue(photos._safe_candidate(result))

    async def test_real_manga_hall_thumb_host_and_slashless_license_shape(self):
        payloads = self.payloads()
        filename = "Saitama Saitama Municipal Manga Hall 1.JPG"
        payloads[0]["query"]["pages"][0]["pageimage"] = filename
        file = payloads[1]["query"]["pages"][0]
        file["title"] = "ファイル:" + filename
        info = file["imageinfo"][0]
        thumb = "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/71/Saitama_Saitama_Municipal_Manga_Hall_1.JPG/960px-Saitama_Saitama_Municipal_Manga_Hall_1.JPG?utm_source=ja.wikipedia.org&utm_campaign=imageinfo&utm_content=thumbnail"
        info["thumburl"] = thumb
        info["descriptionurl"] = "https://commons.wikimedia.org/wiki/File:" + filename.replace(" ", "_")
        info["extmetadata"]["LicenseShortName"]["value"] = "CC BY-SA 3.0"
        info["extmetadata"]["LicenseUrl"]["value"] = "https://creativecommons.org/licenses/by-sa/3.0"
        result, _, _ = await self.search(payloads)
        self.assertIsNotNone(result)
        self.assertEqual(result.image_url, thumb)
        self.assertEqual(result.license_url, "https://creativecommons.org/licenses/by-sa/3.0")
        self.assertTrue(photos._safe_candidate(result))

    def test_thumb_host_exactness_and_slashless_cc_resources(self):
        from dataclasses import replace
        self.assertFalse(photos._safe_candidate(replace(image(), image_url="https://thumb.wikimedia.org.evil.test/a.jpg")))
        for label, path in (("CC BY 4.0", "licenses/by/4.0"), ("CC BY-SA 3.0", "licenses/by-sa/3.0"), ("CC0", "publicdomain/zero/1.0"), ("Public domain", "publicdomain/mark/1.0")):
            for suffix in ("", "/"):
                url = "https://creativecommons.org/" + path + suffix
                self.assertEqual(images._wikipedia_license({"LicenseShortName": label, "LicenseUrl": url}), (label, url))
        for path in ("licenses/by-sa/3.0evil", "licenses/by-sa/3.0//", "licenses/by-sa/3.0/de/other", "licenses/by-sa/3.0?next=evil"):
            self.assertIsNone(images._wikipedia_license({"LicenseShortName": "CC BY-SA 3.0", "LicenseUrl": "https://creativecommons.org/" + path}))

    async def test_wrong_article_coordinates_filename_mime_and_host_rejected(self):
        for mutation in ("name", "position", "file", "mime", "host", "source", "art"):
            self.setUp()
            payloads = self.payloads()
            page = payloads[0]["query"]["pages"][0]
            file = payloads[1]["query"]["pages"][0]
            info = file["imageinfo"][0]
            if mutation == "name": page["title"] = "別の寺"
            if mutation == "position": page["coordinates"][0]["lat"] = 36
            if mutation == "file": file["title"] = "File:Other.jpg"
            if mutation == "mime": info["mime"] = "image/svg+xml"
            if mutation == "host": info["url"] = "https://evil.test/p.jpg"
            if mutation == "source": info["descriptionurl"] = "https://commons.wikimedia.org/wiki/File:Other.jpg"
            if mutation == "art": info["extmetadata"]["ImageDescription"]["value"] = "清水寺のイラスト"
            result, _, _ = await self.search(payloads)
            self.assertIsNone(result, mutation)

    def test_known_cc_http_normalized_and_restrictive_license_rejected(self):
        self.assertEqual(images._wikipedia_license({"LicenseShortName": "CC BY 4.0", "LicenseUrl": "http://creativecommons.org/licenses/by/4.0/"})[1], "https://creativecommons.org/licenses/by/4.0/")
        self.assertIsNone(images._wikipedia_license({"LicenseShortName": "Public domain", "LicenseUrl": "https://creativecommons.org/licenses/by-nc/4.0/"}))
        self.assertIsNone(images._wikipedia_license({"LicenseShortName": "CC BY-NC-SA 4.0", "LicenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/"}))
        for url in ("https://creativecommons.org:444/licenses/by/4.0/", "https://x@creativecommons.org/licenses/by/4.0/", "https://creativecommons.org/licenses/by/4.0/?x=1", "https://creativecommons.org/licenses/by/4.0/#fragment"):
            self.assertIsNone(images._wikipedia_license({"LicenseShortName": "CC BY 4.0", "LicenseUrl": url}))

    def test_nonfinite_and_boolean_coordinates_rejected(self):
        page = self.payloads()[0]["query"]["pages"][0]
        for coordinate in (True, float("nan"), float("inf"), 91):
            page["coordinates"][0]["lat"] = coordinate
            self.assertFalse(images._matches_place(page, "清水寺", 35, 135.7))
