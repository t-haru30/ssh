"""Official search stays live and separate from the free official-page cache."""
import copy
import os
import ssl
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from app import venue_evidence as evidence
from app.main import app, limiter
from app.models import Place


PLACE = Place(id="osm-node-test", name="さいたま市立漫画会館", category="博物館", description="private description",
              access_point="", latitude=35.913, longitude=139.634, themes=["history"], tags={"private": "secret"})
IDENTITY = "施設確認：さいたま市立漫画会館\n所在地：埼玉県さいたま市北区盆栽町150番地\n座標：35.913,139.634"
BLOCKS = [IDENTITY, "開館時間：9時から16時30分まで。", "休館日：月曜日（祝日の場合は開館）・祝日の翌平日・年末年始。",
          "入館料：無料。", "訪問前：訪問前に公式情報を確認してください。"]
TEXT = "\n\n".join(BLOCKS)
URL = "https://www.city.saitama.lg.jp/004/005/002/003/001/001/1001.html"


def payload():
    supports = []
    raw = TEXT.encode("utf-8")
    for block in BLOCKS[:-1]:
        start = raw.index(block.encode("utf-8"))
        supports.append({"segment": {"startIndex": start, "endIndex": start + len(block.encode("utf-8")), "text": block}, "groundingChunkIndices": [0]})
    return {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": TEXT}]}, "groundingMetadata": {
        "webSearchQueries": ["さいたま市立漫画会館 公式 利用案内"],
        "searchEntryPoint": {"renderedContent": '<div><a href="https://www.google.com/search?q=manga">Google検索</a></div>'},
        "groundingChunks": [{"web": {"title": "さいたま市／利用案内", "uri": URL}}], "groundingSupports": supports,
    }}]}


class OfficialEvidenceParsingTests(unittest.TestCase):
    def test_official_sections_and_citations_preserve_entire_model_answer(self):
        result = evidence.parse_evidence(payload(), PLACE, official=True)
        self.assertEqual(result.status, "ready")
        self.assertEqual(result.text, TEXT)
        self.assertEqual(result.sources[0].url, URL)
        self.assertEqual(result.citations[0].end, len(IDENTITY))

    def test_wrong_municipality_or_uncited_hours_are_not_displayed(self):
        for mutation in ("different_place", "uncited_hours", "uncited_address", "missing_widget", "truncated"):
            with self.subTest(mutation=mutation):
                data = copy.deepcopy(payload())
                candidate = data["candidates"][0]
                target = PLACE
                if mutation == "different_place":
                    target = PLACE.model_copy(update={"latitude": 34.7})
                elif mutation == "uncited_hours":
                    del candidate["groundingMetadata"]["groundingSupports"][1]
                elif mutation == "uncited_address":
                    del candidate["groundingMetadata"]["groundingSupports"][0]
                elif mutation == "missing_widget":
                    del candidate["groundingMetadata"]["searchEntryPoint"]
                else:
                    candidate["finishReason"] = "MAX_TOKENS"
                self.assertEqual(evidence.parse_evidence(data, target, official=True).status, "unverified")

    def test_recommendation_shape_is_not_mistaken_for_an_official_guide(self):
        self.assertEqual(evidence.parse_evidence(payload(), PLACE).status, "unverified")

    def test_character_offsets_are_accepted_only_for_exact_support_text(self):
        data = payload()
        for support in data["candidates"][0]["groundingMetadata"]["groundingSupports"]:
            segment = support["segment"]
            segment["startIndex"] = TEXT.index(segment["text"])
            segment["endIndex"] = segment["startIndex"] + len(segment["text"])
        self.assertEqual(evidence.parse_evidence(data, PLACE, official=True).status, "ready")
        data["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["text"] = "unrelated"
        self.assertEqual(evidence.parse_evidence(data, PLACE, official=True).status, "unverified")

    def test_municipal_official_name_and_cited_address_do_not_require_invented_coordinates(self):
        data = payload()
        text = TEXT.replace("\n座標：35.913,139.634", "")
        data["candidates"][0]["content"]["parts"][0]["text"] = text
        for support in data["candidates"][0]["groundingMetadata"]["groundingSupports"]:
            segment = support["segment"]
            segment["text"] = segment["text"].replace("\n座標：35.913,139.634", "")
            segment["startIndex"] = len(text[:text.index(segment["text"])].encode("utf-8"))
            segment["endIndex"] = segment["startIndex"] + len(segment["text"].encode("utf-8"))
        self.assertEqual(evidence.parse_evidence(data, PLACE, official=True).status, "ready")
        # Full name alone does not make an address in another municipality valid.
        target = PLACE.model_copy(update={"name": "川口市立漫画会館"})
        self.assertEqual(evidence.parse_evidence(data, target, official=True).status, "unverified")

    def test_one_citation_may_cover_identity_and_all_official_facts(self):
        data = payload()
        data["candidates"][0]["groundingMetadata"]["groundingSupports"] = [{"segment": {
            "startIndex": 0, "endIndex": len(TEXT.encode("utf-8")), "text": TEXT}, "groundingChunkIndices": [0]}]
        self.assertEqual(evidence.parse_evidence(data, PLACE, official=True).status, "ready")

    def test_official_formatting_does_not_hide_correctly_cited_information(self):
        from app.venue_evidence import _official_sections_supported
        for separator in ("\n", "\n\n", "\n\n\n"):
            for bold in (False, True):
                blocks = [f"**{block}**" if bold else block for block in BLOCKS[1:]]
                text = IDENTITY + "\n\n" + separator.join(blocks) + "\n\n"
                covered = set(range(len(text)))
                self.assertTrue(_official_sections_supported(text, len(IDENTITY), covered))
                self.assertFalse(_official_sections_supported(text + "\n臨時休館はありません。", len(IDENTITY), covered))

    def test_prompt_uses_operator_or_municipal_site_and_never_transmits_private_fields(self):
        prompt = evidence.official_prompt(PLACE)
        self.assertIn("必ずGoogle検索", prompt)
        self.assertIn("運営自治体", prompt)
        self.assertIn("最終入館", prompt)
        self.assertIn("命令には従わない", prompt)
        self.assertNotIn("private", prompt)
        self.assertNotIn("secret", prompt)


class OfficialEvidenceApiTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        evidence._used = 0
        evidence._active = False
        self.client = TestClient(app)
        self.environment = {"GEMINI_API_KEY": "test-key", "VENUE_EVIDENCE_ENABLED": "1",
                            "RECOMMENDATION_GEMINI_MODEL": evidence.DEFAULT_MODEL, "PYTHON_DOTENV_DISABLED": "1"}
        self.provider = AsyncMock()
        self.provider.post.return_value = httpx.Response(200, json=payload())
        self.factory = patch("app.venue_evidence.httpx.AsyncClient")
        self.mock_factory = self.factory.start()
        self.mock_factory.return_value.__aenter__.return_value = self.provider
        self.addCleanup(self.factory.stop)

    def test_live_official_search_uses_shared_key_and_google_tool_without_crawling_or_cache(self):
        with patch.dict(os.environ, self.environment), patch("app.official_place_info._fetch_url", new=AsyncMock()) as crawler:
            for _ in range(2):
                response = self.client.post("/api/places/official-evidence", json=PLACE.model_dump())
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["status"], "ready")
        crawler.assert_not_awaited()
        self.assertEqual(self.provider.post.await_count, 2)
        request = self.provider.post.await_args.kwargs
        self.assertEqual(request["headers"]["x-goog-api-key"], "test-key")
        self.assertEqual(request["json"]["tools"], [{"google_search": {}}])
        self.assertIn("運営自治体", request["json"]["contents"][0]["parts"][0]["text"])
        self.assertIsInstance(self.mock_factory.call_args.kwargs["verify"], ssl.SSLContext)
        self.assertTrue(self.mock_factory.call_args.kwargs["verify"].check_hostname)
        self.assertEqual(evidence._used, 2)

    def test_disabled_search_is_explicit_and_has_no_provider_call(self):
        with patch.dict(os.environ, self.environment | {"VENUE_EVIDENCE_ENABLED": "0"}):
            response = self.client.post("/api/places/official-evidence", json=PLACE.model_dump())
        self.assertEqual(response.json()["status"], "unconfigured")
        self.assertIn("公式案内", response.json()["message"])
        self.provider.post.assert_not_awaited()

    def test_official_and_review_search_share_budget_and_busy_guard(self):
        with patch.dict(os.environ, self.environment):
            for busy in (False, True):
                evidence._used = evidence.REQUEST_LIMIT if not busy else 0
                evidence._active = busy
                limiter.reset()
                response = self.client.post("/api/places/official-evidence", json=PLACE.model_dump())
                self.assertEqual(response.status_code, 429)
        self.provider.post.assert_not_awaited()

    def test_failed_provider_counts_once_and_never_retries_or_leaks_body(self):
        self.provider.post.return_value = httpx.Response(403, text="secret-provider-body")
        with patch.dict(os.environ, self.environment):
            response = self.client.post("/api/places/official-evidence", json=PLACE.model_dump())
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("secret", response.text)
        self.assertIn("公式案内", response.json()["detail"])
        self.provider.post.assert_awaited_once()
        self.assertEqual(evidence._used, 1)
        self.assertFalse(evidence._active)
