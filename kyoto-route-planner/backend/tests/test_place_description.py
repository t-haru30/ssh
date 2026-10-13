import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from app.main import app, limiter
from app.models import Place
from app.official_place_info import OfficialPlaceInfo
from app.place_description import (
    DESCRIPTION_CACHE_TTL_SECONDS,
    DESCRIPTION_TIMEOUT_SECONDS,
    DESCRIPTION_TOTAL_TIMEOUT_SECONDS,
    PlaceDescription,
    _description_cache,
    fetch_place_description,
)


def sample_place(**overrides):
    return Place(**({"id": "kiyomizu", "name": "清水寺", "category": "寺院", "description": "",
                    "access_point": "", "latitude": 34.9949, "longitude": 135.785, "themes": ["temple"]} | overrides))


def article_payload(**overrides):
    return {"query": {"pages": [{"pageid": 123, "ns": 0, "title": "清水寺",
                                  "coordinates": [{"lat": 34.9949, "lon": 135.785, "globe": "earth"}],
                                  "extract": "清水寺は京都市にある寺院です。参拝客が訪れます。", **overrides}]}}


def official_info(**overrides):
    return OfficialPlaceInfo(**({
        "url": "https://www.kiyomizudera.or.jp/", "title": "清水寺 公式案内", "description": None,
        "opening_hours": "6:00〜18:00", "closed_days": None, "admission": None,
        "description_source_url": "https://www.kiyomizudera.or.jp/", "highlights": ["境内の文化財"],
        "checked_at": "2026-10-12T09:00:00+00:00", "status": "verified", "note": "公式案内を確認しました。",
    } | overrides))


class PlaceDescriptionApiTests(unittest.TestCase):
    def setUp(self):
        official = patch("app.place_description.fetch_official_place_info", new=AsyncMock(return_value=None))
        official.start()
        self.addCleanup(official.stop)
        _description_cache.clear()
        limiter.reset()
        self.client = TestClient(app, client=("198.51.100.71", 12345))

    def tearDown(self):
        _description_cache.clear()
        limiter.reset()

    def post(self, **overrides):
        return self.client.post("/api/places/description", json=sample_place(**overrides).model_dump())

    def assert_unavailable(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"description", "source_url", "source_title", "license_name", "license_url", "note", "official"})
        self.assertIsNone(response.json()["official"])
        for field in ("description", "source_url", "source_title", "license_name", "license_url"):
            self.assertIsNone(response.json()[field])
        self.assertTrue(response.json()["note"])

    def test_exact_name_and_nearby_coordinates_return_attributed_plain_text_in_one_call(self):
        text = "<b>清水寺</b>は京都市にある寺院です。\n" + "公開情報の説明です。" * 60
        with (
            patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload(extract=text)))) as get,
            patch("app.main.fetch_venue_evidence", new=AsyncMock()) as paid_evidence,
        ):
            response = self.post()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["description"].startswith("清水寺 は京都市"))
        self.assertNotIn("<", data["description"])
        self.assertGreaterEqual(len(data["description"]), 300)
        self.assertLessEqual(len(data["description"]), 500)
        self.assertEqual(data["source_title"], "清水寺")
        self.assertEqual(data["source_url"], "https://ja.wikipedia.org/wiki/%E6%B8%85%E6%B0%B4%E5%AF%BA")
        self.assertEqual(data["license_name"], "CC BY-SA 4.0")
        self.assertEqual(data["license_url"], "https://creativecommons.org/licenses/by-sa/4.0/")
        self.assertIn("Wikipediaの寄稿者", data["note"])
        paid_evidence.assert_not_awaited()
        get.assert_awaited_once()
        params = get.call_args.kwargs["params"]
        self.assertEqual(params["titles"], "清水寺")
        self.assertEqual(params["redirects"], 1)
        self.assertEqual(params["prop"], "extracts|coordinates|pageprops")
        self.assertEqual(params["explaintext"], 1)
        self.assertNotIn("search", params)
        self.assertNotIn("generator", params)

    def test_explicit_redirect_chain_is_accepted_only_with_matching_coordinates(self):
        payload = article_payload(title="清水寺 (京都市)")
        payload["query"]["redirects"] = [{"from": "清水寺", "to": "清水寺 (京都市)"}]
        with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=payload))) as get:
            response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["source_title"], "清水寺 (京都市)")
        get.assert_awaited_once()

    def test_name_mismatch_is_not_accepted_even_at_the_same_coordinates(self):
        with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload(title="別の寺院")))):
            self.assert_unavailable(self.post())

    def test_unrelated_redirect_or_section_redirect_is_not_identity_proof(self):
        for redirects in ([{"from": "別の寺院", "to": "清水寺 (京都市)"}],
                          [{"from": "清水寺", "to": "清水寺 (京都市)", "tofragment": "境内の施設"}]):
            with self.subTest(redirects=redirects):
                _description_cache.clear()
                payload = article_payload(title="清水寺 (京都市)")
                payload["query"]["redirects"] = redirects
                with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=payload))):
                    self.assert_unavailable(self.post())

    def test_missing_far_or_invalid_coordinates_are_rejected(self):
        cases = [[], [{"lat": 35.1, "lon": 135.785}], [{"lat": True, "lon": 135.785}],
                 [{"lat": 999, "lon": 135.785}], [{"lat": "34.9949", "lon": 135.785}],
                 [{"lat": 34.9949, "lon": 135.785, "globe": "moon"}]]
        for coordinates in cases:
            with self.subTest(coordinates=coordinates):
                _description_cache.clear()
                with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload(coordinates=coordinates)))):
                    self.assert_unavailable(self.post())

    def test_missing_disambiguation_and_empty_articles_are_rejected(self):
        cases = [{"missing": True}, {"pageprops": {"disambiguation": ""}}, {"extract": ""}, {"ns": 14}]
        for changes in cases:
            with self.subTest(changes=changes):
                _description_cache.clear()
                with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload(**changes)))):
                    self.assert_unavailable(self.post())

    def test_http_errors_and_invalid_payloads_return_200_without_retry(self):
        responses = [httpx.Response(429), httpx.Response(503), httpx.Response(302),
                     httpx.Response(200, text="not json"), httpx.Response(200, json={"error": {"code": "maxlag"}})]
        for upstream in responses:
            with self.subTest(status=upstream.status_code):
                _description_cache.clear()
                with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=upstream)) as get:
                    self.assert_unavailable(self.post())
                get.assert_awaited_once()

    def test_http_timeout_returns_200_with_no_description(self):
        with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=httpx.ReadTimeout("fixture"))) as get:
            self.assert_unavailable(self.post())
        get.assert_awaited_once()

    def test_multi_title_input_never_triggers_an_outbound_request(self):
        with patch("httpx.AsyncClient.get", new=AsyncMock()) as get:
            self.assert_unavailable(self.post(name="清水寺|別の寺"))
        get.assert_not_awaited()

    def test_thirty_requests_per_minute_are_allowed_and_the_next_is_limited(self):
        with patch("app.main.fetch_place_description", new=AsyncMock(return_value=PlaceDescription(note="fixture"))) as fetch:
            responses = [self.post() for _ in range(31)]
        self.assertTrue(all(r.status_code == 200 for r in responses[:30]))
        self.assertEqual(responses[30].status_code, 429)
        self.assertEqual(fetch.await_count, 30)

    def test_api_returns_verified_official_guidance_even_without_wikipedia_description(self):
        official = official_info()
        with (
            patch("app.place_description._fetch_wikipedia_description", new=AsyncMock(return_value=PlaceDescription(note="記事なし"))),
            patch("app.place_description.fetch_official_place_info", new=AsyncMock(return_value=official)),
        ):
            response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["description"])
        self.assertEqual(response.json()["official"], official.model_dump(mode="json"))


class PlaceDescriptionCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        official = patch("app.place_description.fetch_official_place_info", new=AsyncMock(return_value=None))
        official.start()
        self.addCleanup(official.stop)
        _description_cache.clear()

    def tearDown(self):
        _description_cache.clear()

    async def test_success_is_cached_for_24_hours_by_name_and_coordinates(self):
        self.assertEqual(DESCRIPTION_CACHE_TTL_SECONDS, 86400)
        with (
            patch("app.cache.monotonic", return_value=100) as clock,
            patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload()))) as get,
        ):
            first = await fetch_place_description(sample_place())
            clock.return_value = 100 + 86400 - 1
            cached = await fetch_place_description(sample_place(id="another-catalog-id"))
            self.assertEqual(cached, first)
            self.assertEqual(get.await_count, 1)
            clock.return_value = 100 + 86400
            await fetch_place_description(sample_place())
            self.assertEqual(get.await_count, 2)

    async def test_same_name_at_a_different_location_does_not_reuse_the_description(self):
        with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload()))) as get:
            first = await fetch_place_description(sample_place())
            other = await fetch_place_description(sample_place(latitude=36))
            renamed = await fetch_place_description(sample_place(name="別の寺院"))
        self.assertIsNotNone(first.description)
        self.assertIsNone(other.description)
        self.assertIsNone(renamed.description)
        self.assertEqual(get.await_count, 3)

    async def test_unmatched_result_is_also_cached(self):
        with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload(title="別の寺院")))) as get:
            first = await fetch_place_description(sample_place())
            second = await fetch_place_description(sample_place())
        self.assertIsNone(first.description)
        self.assertEqual(first, second)
        get.assert_awaited_once()

    async def test_transient_failures_are_not_cached_and_next_click_can_recover(self):
        failures = [httpx.Response(429), httpx.Response(503), httpx.Response(302),
                    httpx.ReadTimeout("fixture"), httpx.ConnectError("fixture"),
                    httpx.Response(200, text="not json"),
                    httpx.Response(200, json={"error": {"code": "maxlag"}}),
                    httpx.Response(200, json={"query": {"pages": []}}),
                    httpx.Response(200, json={"query": {"pages": [{"title": "清水寺"}]}})]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__, status=getattr(failure, "status_code", None)):
                _description_cache.clear()
                with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=[
                    failure, httpx.Response(200, json=article_payload()),
                ])) as get:
                    first = await fetch_place_description(sample_place())
                    recovered = await fetch_place_description(sample_place())
                    cached = await fetch_place_description(sample_place())
                self.assertIsNone(first.description)
                self.assertIsNotNone(recovered.description)
                self.assertEqual(cached, recovered)
                self.assertEqual(get.await_count, 2)

    async def test_total_deadline_cancels_a_slow_http_request(self):
        self.assertLessEqual(DESCRIPTION_TIMEOUT_SECONDS, 6)
        cancelled = False

        async def slow_get(*_args, **_kwargs):
            nonlocal cancelled
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                cancelled = True
                raise

        with (patch("app.place_description.DESCRIPTION_TIMEOUT_SECONDS", .05),
              patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=slow_get)) as get):
            result = await fetch_place_description(sample_place())
        self.assertIsNone(result.description)
        self.assertTrue(cancelled)
        get.assert_awaited_once()
        with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload()))) as retry:
            recovered = await fetch_place_description(sample_place())
        self.assertIsNotNone(recovered.description)
        retry.assert_awaited_once()


class PlaceDescriptionIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _description_cache.clear()

    def tearDown(self):
        _description_cache.clear()

    async def test_both_providers_start_concurrently(self):
        started = asyncio.Event()
        wikipedia = PlaceDescription(description="施設説明", note="Wikipedia抜粋")
        official = official_info()

        async def wiki_provider(_place):
            await started.wait()
            return wikipedia

        async def official_provider(_place):
            started.set()
            return official

        with (
            patch("app.place_description._fetch_wikipedia_description", side_effect=wiki_provider),
            patch("app.place_description.fetch_official_place_info", side_effect=official_provider),
            patch("app.place_description.DESCRIPTION_TOTAL_TIMEOUT_SECONDS", .2),
        ):
            result = await fetch_place_description(sample_place())
        self.assertEqual(result.description, wikipedia.description)
        self.assertEqual(result.official, official)

    async def test_missing_or_failed_official_provider_preserves_wikipedia(self):
        wikipedia = PlaceDescription(description="施設説明", note="Wikipedia抜粋")
        for official_result in (None, RuntimeError("fixture"), official_info(status="unavailable", url=None, opening_hours=None)):
            with self.subTest(official_result=type(official_result).__name__):
                with (
                    patch("app.place_description._fetch_wikipedia_description", new=AsyncMock(return_value=wikipedia)),
                    patch("app.place_description.fetch_official_place_info", new=AsyncMock(side_effect=[official_result])),
                ):
                    result = await fetch_place_description(sample_place())
                self.assertEqual(result.description, wikipedia.description)
                self.assertEqual(result.official, official_result if isinstance(official_result, OfficialPlaceInfo) else None)

    async def test_failed_wikipedia_provider_preserves_official_guidance(self):
        official = official_info()
        with (
            patch("app.place_description._fetch_wikipedia_description", new=AsyncMock(side_effect=RuntimeError("fixture"))),
            patch("app.place_description.fetch_official_place_info", new=AsyncMock(return_value=official)),
        ):
            result = await fetch_place_description(sample_place())
        self.assertIsNone(result.description)
        self.assertTrue(result.note)
        self.assertEqual(result.official, official)

    async def test_total_deadline_cancels_slow_provider_and_preserves_completed_provider(self):
        self.assertLessEqual(DESCRIPTION_TOTAL_TIMEOUT_SECONDS, 15)
        wikipedia = PlaceDescription(description="施設説明", note="Wikipedia抜粋")
        official = official_info()
        for slow_provider in ("official", "wikipedia"):
            with self.subTest(slow_provider=slow_provider):
                cancelled = False

                async def slow(_place):
                    nonlocal cancelled
                    try:
                        await asyncio.sleep(1)
                    except asyncio.CancelledError:
                        cancelled = True
                        raise

                wiki_mock = AsyncMock(side_effect=slow) if slow_provider == "wikipedia" else AsyncMock(return_value=wikipedia)
                official_mock = AsyncMock(side_effect=slow) if slow_provider == "official" else AsyncMock(return_value=official)
                with (
                    patch("app.place_description._fetch_wikipedia_description", new=wiki_mock),
                    patch("app.place_description.fetch_official_place_info", new=official_mock),
                    patch("app.place_description.DESCRIPTION_TOTAL_TIMEOUT_SECONDS", .02),
                ):
                    result = await fetch_place_description(sample_place())
                self.assertTrue(cancelled)
                self.assertEqual(result.description, wikipedia.description if slow_provider == "official" else None)
                self.assertEqual(result.official, official if slow_provider == "wikipedia" else None)
                wiki_mock.assert_awaited_once()
                official_mock.assert_awaited_once()

    async def test_wikipedia_cache_does_not_freeze_official_information(self):
        first_official = official_info(opening_hours="6:00〜18:00")
        refreshed_official = official_info(opening_hours="6:00〜17:00")
        with (
            patch("httpx.AsyncClient.get", new=AsyncMock(return_value=httpx.Response(200, json=article_payload()))) as wiki_get,
            patch("app.place_description.fetch_official_place_info", new=AsyncMock(side_effect=[first_official, refreshed_official])) as official,
        ):
            first = await fetch_place_description(sample_place())
            second = await fetch_place_description(sample_place())
        self.assertEqual(first.description, second.description)
        self.assertEqual(first.official.opening_hours, "6:00〜18:00")
        self.assertEqual(second.official.opening_hours, "6:00〜17:00")
        wiki_get.assert_awaited_once()
        self.assertEqual(official.await_count, 2)
