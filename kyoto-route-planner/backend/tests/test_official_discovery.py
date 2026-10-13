import copy
from datetime import datetime
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import official_place_info as info
from app.models import Place
from app.official_sources import osm_element, wikidata_website, wikipedia_website


PLACE = Place(id="osm-node-123", name="旅の美術館", category="美術館", description="", access_point="",
              latitude=35, longitude=135, themes=["history"])
URL = "https://museum.example/"


def osm(tags=None):
    return {"elements": [{"type": "node", "id": 123, "lat": 35, "lon": 135,
                          "tags": {"name": PLACE.name, **(tags or {})}}]}


def wikidata():
    claim = lambda value: {"rank": "normal", "mainsnak": {"datavalue": {"value": value}}}
    return {"entities": {"Q123": {"id": "Q123", "labels": {"ja": {"value": PLACE.name}},
        "claims": {"P625": [claim({"latitude": 35, "longitude": 135})], "P856": [claim(URL)]}}}}


def wikipedia(url=URL):
    return {"query": {"pages": [{"ns": 0, "title": PLACE.name, "coordinates": [{"lat": 35, "lon": 135}],
        "revisions": [{"slots": {"main": {"content": "{{博物館\n| URL = " + url + "\n}}"}}}]}]}}


def response(payload):
    return 200, {"content-type": "application/json"}, json.dumps(payload).encode()


def html(body):
    return 200, {"content-type": "text/html; charset=utf-8"}, body.encode()


GUIDE = '<title>旅の美術館</title><h2>開館時間</h2><p>9:00〜17:00（入館16:30まで）</p><h2>休館日</h2><p>月曜日（祝日は翌平日）・年末年始</p><h2>入館料</h2><p>一般500円</p>'


class SourceIdentityTests(unittest.TestCase):
    def test_wikidata_requires_both_exact_venue_name_and_nearby_coordinates(self):
        self.assertEqual(wikidata_website(wikidata(), "Q123", PLACE), URL)
        wrong_name = wikidata(); wrong_name["entities"]["Q123"]["labels"]["ja"]["value"] = "別支店"
        wrong_location = wikidata(); wrong_location["entities"]["Q123"]["claims"]["P625"][0]["mainsnak"]["datavalue"]["value"]["latitude"] = 36
        for data in (wrong_name, wrong_location):
            self.assertIsNone(wikidata_website(data, "Q123", PLACE))

    def test_retired_or_foreign_language_sites_do_not_override_current_japanese_site(self):
        data = wikidata(); sites = data["entities"]["Q123"]["claims"]["P856"]
        english = copy.deepcopy(sites[0]); english["mainsnak"]["datavalue"]["value"] += "english"
        english["qualifiers"] = {"P407": [{"datavalue": {"value": {"id": "Q1860"}}}]}
        retired = copy.deepcopy(sites[0]); retired["mainsnak"]["datavalue"]["value"] += "retired"
        retired["qualifiers"] = {"P582": [{"datavalue": {"value": "old"}}]}
        sites[:0] = [retired, english]
        self.assertEqual(wikidata_website(data, "Q123", PLACE), URL)

    def test_wikipedia_reads_only_a_matched_infobox_website_not_an_arbitrary_reference(self):
        self.assertEqual(wikipedia_website(wikipedia(), PLACE), URL)
        data = wikipedia(); data["query"]["pages"][0]["revisions"][0]["slots"]["main"]["content"] = '* [https://other.example/ reference]'
        self.assertIsNone(wikipedia_website(data, PLACE))
        data = wikipedia(); data["query"]["pages"][0]["coordinates"][0]["lat"] = 36
        self.assertIsNone(wikipedia_website(data, PLACE))

    def test_exact_named_explicit_official_external_link_requires_matched_article_identity(self):
        data = wikipedia()
        page = data["query"]["pages"][0]
        content = page["revisions"][0]["slots"]["main"]
        content["content"] = f"== 外部リンク ==\n* [{URL} {PLACE.name}]（公式サイト）\n"
        self.assertEqual(wikipedia_website(data, PLACE), URL)
        for unsafe in (f"* [{URL} {PLACE.name}]（公式サイト）",  # Outside external links.
                       f"== 参考文献 ==\n* [{URL} {PLACE.name}]（公式サイト）",
                       f"== 外部リンク ==\n* [{URL} 別の博物館]（公式サイト）",
                       f"== 外部リンク ==\n* [{URL} {PLACE.name}]",  # Unmarked external link.
                       f"== 外部リンク ==\n* [{URL} {PLACE.name}]（紹介サイト）"):
            content["content"] = unsafe
            self.assertIsNone(wikipedia_website(data, PLACE))
        content["content"] = f"== 外部リンク ==\n* [{URL} {PLACE.name}]（公式サイト）\n"
        page["coordinates"][0]["lat"] = 36
        self.assertIsNone(wikipedia_website(data, PLACE))

    def test_full_way_geometry_supplies_a_verifiable_center(self):
        place = PLACE.model_copy(update={"id": "osm-way-321"})
        way = {"type": "way", "id": 321, "nodes": [1, 2], "tags": {"name": PLACE.name, "website": URL}}
        data = {"elements": [way, {"type": "node", "id": 1, "lat": 34.9999, "lon": 135}, {"type": "node", "id": 2, "lat": 35.0001, "lon": 135}]}
        self.assertEqual(osm_element(data, place, "way", 321), way)
        data["elements"].pop()
        self.assertIsNone(osm_element(data, place, "way", 321))

    def test_malformed_external_payloads_fail_without_raising(self):
        for value in (None, [], "text", {"entities": {"Q123": {"id": "Q123", "labels": []}}}, {"query": {"pages": [1]}}):
            self.assertIsNone(wikidata_website(value, "Q123", PLACE))
            self.assertIsNone(wikipedia_website(value, PLACE))


class OfficialDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        info._cache.clear()
        seed = patch.object(info, "_seed_entry", return_value=None)
        seed.start(); self.addCleanup(seed.stop)

    async def test_direct_hours_link_precedes_container_and_fee_links_with_same_guide_budget(self):
        home = ('<title>旅の美術館</title><a href="/guide">ご利用案内</a>'
                '<a href="/fees">入場料金</a><a href="/hours">休園日、開園・開場時間</a>')
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html(home), html(GUIDE)])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(fetch.await_count, 3)
        self.assertEqual(fetch.await_args.args[0], URL + "hours")
        self.assertEqual(result.field_sources, {field: URL + "hours" for field in info.FIELDS})

    async def test_missing_osm_website_uses_identity_checked_wikidata_url(self):
        fetch = AsyncMock(side_effect=[response(osm({"wikidata": "Q123"})), response(wikidata()), html(GUIDE)])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.status, "verified")
        self.assertEqual(fetch.await_count, 3)
        self.assertIn("Special:EntityData/Q123.json", fetch.await_args_list[1].args[0])
        self.assertEqual(result.field_sources, {field: URL for field in info.FIELDS})

    async def test_linked_article_meta_refresh_and_visitor_guide_are_followed(self):
        home = '<title>旅の美術館</title><a href="/access">アクセス</a><a href="/guide">利 用 案 内</a>'
        fetch = AsyncMock(side_effect=[response(osm({"wikipedia": "ja:" + PLACE.name})), response(wikipedia()),
            html('<meta http-equiv="refresh" content="0;URL=home.html">'), html(home), html(GUIDE)])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.url, URL + "guide")
        self.assertEqual(fetch.await_count, 5)
        self.assertIn("9:00", result.opening_hours)
        self.assertNotIn("access", fetch.await_args.args[0])

    async def test_retired_domain_falls_back_to_matched_article(self):
        fetch = AsyncMock(side_effect=[response(osm({"wikidata": "Q123"})), response(wikidata()),
            OSError("retired DNS"), response(wikipedia("https://new.example/")), html(GUIDE)])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.status, "verified")
        self.assertEqual(result.url, "https://new.example/")
        self.assertEqual(fetch.await_count, 5)

    async def test_meta_refresh_to_private_address_is_never_fetched(self):
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html('<meta http-equiv="refresh" content="0;url=http://127.0.0.1/secret">')])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.status, "unavailable")
        self.assertEqual(fetch.await_count, 2)

    async def test_partial_result_survives_guide_failure_and_keeps_actual_field_source(self):
        home = '<title>旅の美術館</title><p>入館料 無料</p><a href="/guide">利用案内</a>'
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html(home), (503, {}, b"")])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.status, "verified")
        self.assertIn("無料", result.admission)
        self.assertEqual(result.field_sources, {"admission": URL})

    async def test_incomplete_cached_page_is_refetched_and_fields_can_be_completed(self):
        partial = '<title>旅の美術館</title><p>入館料 無料</p>'
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html(partial), response(osm({"website": URL})), html(GUIDE)])
        with patch.object(info, "_fetch_url", new=fetch):
            first = await info.fetch_official_place_info(PLACE)
            self.assertEqual(info.known_official_url(PLACE), URL)
            second = await info.fetch_official_place_info(PLACE)
        self.assertIsNone(first.opening_hours)
        self.assertIn("9:00", second.opening_hours)
        self.assertEqual(fetch.await_count, 4)

    async def test_guide_does_not_adopt_a_facility_name_only_in_shared_navigation(self):
        wrong = '<title>別の施設</title><nav>旅の美術館</nav><p>開館時間 8:00〜18:00</p>'
        with patch.object(info, "_fetch_url", new=AsyncMock(side_effect=[response(osm({"website": URL})), html(wrong)])):
            result = await info.fetch_official_place_info(PLACE)
        self.assertIsNone(result.opening_hours)
        self.assertEqual(result.status, "link_only")

    async def test_tls_fallback_reuses_validated_public_address(self):
        fallback = AsyncMock(return_value=html(GUIDE))
        with patch.object(info, "_resolve_public", new=AsyncMock(return_value=(URL, "93.184.216.34"))) as resolve, \
             patch.object(info, "_fetch_httpx", new=AsyncMock(side_effect=httpx.ConnectError("TLS EOF"))), \
             patch.object(info, "compatible_fetch", new=fallback):
            status, _, _ = await info._fetch_url(URL)
        self.assertEqual(status, 200)
        resolve.assert_awaited_once()
        self.assertEqual(fallback.await_args.args[:2], (URL, "93.184.216.34"))
        self.assertEqual(fallback.await_args.kwargs["max_bytes"], info.MAX_BODY_BYTES)

    async def test_notice_index_redirect_and_targeted_closure_are_separate_from_regular_hours(self):
        year = datetime.now().year
        guide = GUIDE.replace('月曜日（祝日は翌平日）・年末年始', '年中無休') + '<a href="/news">新着情報</a>'
        index = '<a href="/gallery">別館の臨時休館</a><a href="/closure">旅の美術館の臨時休館</a>'
        notice = f'<title>旅の美術館の臨時休館</title><h1>旅の美術館の臨時休館</h1><p>{year}年1月1日〜12月31日まで臨時休館します。</p>'
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html(guide),
            (301, {"location": "/news/"}, b""), html(index), html(notice)])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertIn("年中無休", result.closed_days)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].url, URL + "closure")
        self.assertEqual(result.notices[0].ends_on.isoformat(), f"{year}-12-31")
        self.assertEqual(fetch.await_count, 5)

    async def test_failed_notice_check_keeps_the_verified_regular_schedule(self):
        guide = GUIDE + '<a href="/closure">旅の美術館の臨時休館</a>'
        fetch = AsyncMock(side_effect=[response(osm({"website": URL})), html(guide), (503, {}, b"")])
        with patch.object(info, "_fetch_url", new=fetch):
            result = await info.fetch_official_place_info(PLACE)
        self.assertEqual(result.status, "verified")
        self.assertIn("9:00", result.opening_hours)
        self.assertEqual(result.notices, [])
