import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx

from app.models import Place
from app.official_place_info import (
    MAX_BODY_BYTES, UnsafeURL, FetchFailure, _basic_url, _cache,
    _extract_page, _fetch_url, _resolve_public, fetch_official_place_info,
)


def place(**changes):
    values = dict(id="osm-node-123", name="旅の美術館", category="博物館", description="", access_point="", latitude=35, longitude=135, themes=["history"])
    return Place(**(values | changes))


def osm(**changes):
    element = {"type": "node", "id": 123, "lat": 35, "lon": 135,
               "tags": {"name": "旅の美術館", "website": "https://museum.example/", "opening_hours": "24/7"}}
    element.update(changes)
    return (200, {"content-type": "application/json"}, json.dumps({"elements": [element]}).encode())


def page(html=None):
    html = html or """<html><head><title>旅の美術館 | ご利用案内</title><meta name="description" content="旅の美術館では地域の工芸品を紹介しています。"></head><body>
    <nav>開館時間 0:00-24:00</nav><script>休館日 なし</script>
    <h1>旅の美術館</h1><dl><dt><img alt="開館時間"></dt><dd>9:00〜17:00（入館受付16:30まで）</dd>
    <dt>休館日</dt><dd>毎週月曜日・年末年始</dd><dt>観覧料</dt><dd>一般500円</dd></dl></body></html>"""
    return (200, {"content-type": "text/html; charset=utf-8"}, html.encode())


class OfficialPlaceInfoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _cache.clear()
        seed = patch("app.official_place_info._seed_entry", return_value=None)
        seed.start()
        self.addCleanup(seed.stop)

    async def test_verified_official_fields_image_alt_and_cache(self):
        fetch = AsyncMock(side_effect=[osm(), page()])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
            cached = await fetch_official_place_info(place())
        self.assertEqual(result, cached)
        self.assertEqual(fetch.await_count, 2)
        self.assertEqual(result.status, "verified")
        self.assertIn("9:00", result.opening_hours)
        self.assertNotIn("0:00", result.opening_hours)
        self.assertIn("月曜日", result.closed_days)
        self.assertIn("500円", result.admission)
        self.assertEqual(result.description_source_url, "https://museum.example/")
        self.assertTrue(result.checked_at)
        self.assertNotIn("24/7", result.model_dump_json())

    async def test_osm_identity_must_match_name_coordinates_and_id(self):
        for changes in ({"tags": {"name": "別の美術館", "website": "https://museum.example/"}}, {"lat": 36}, {"id": 999}, {"lat": None}):
            with self.subTest(changes=changes), patch("app.official_place_info._fetch_url", new=AsyncMock(return_value=osm(**changes))) as fetch:
                result = await fetch_official_place_info(place())
                self.assertEqual(result.status, "unavailable")
                self.assertIsNone(result.url)
                self.assertEqual(fetch.await_count, 1)

    async def test_arbitrary_place_tags_url_is_never_fetched(self):
        with patch("app.official_place_info._fetch_url", new=AsyncMock()) as fetch:
            result = await fetch_official_place_info(place(id="user-123", tags={"website": "http://127.0.0.1/secret"}))
        self.assertEqual(result.status, "unavailable")
        fetch.assert_not_awaited()

    async def test_official_http_failure_leaves_link_and_is_not_cached(self):
        fetch = AsyncMock(side_effect=[osm(), (503, {}, b""), osm(), page()])
        with patch("app.official_place_info._fetch_url", new=fetch):
            failure = await fetch_official_place_info(place())
            success = await fetch_official_place_info(place())
        self.assertEqual(failure.status, "link_only")
        self.assertEqual(failure.url, "https://museum.example/")
        self.assertIsNone(failure.checked_at)
        self.assertEqual(success.status, "verified")
        self.assertEqual(fetch.await_count, 4)

    async def test_wrong_page_name_never_supplies_hours(self):
        with patch("app.official_place_info._fetch_url", new=AsyncMock(side_effect=[osm(), page("<title>別の施設</title><p>開館時間 9〜17時</p>")])):
            result = await fetch_official_place_info(place())
        self.assertEqual(result.status, "link_only")
        self.assertIsNone(result.opening_hours)
        self.assertIsNone(result.description)

    async def test_missing_fields_remain_null_and_prompt_confirmation(self):
        with patch("app.official_place_info._fetch_url", new=AsyncMock(side_effect=[osm(), page("<title>旅の美術館</title><p>ようこそ</p>")])):
            result = await fetch_official_place_info(place())
        self.assertEqual(result.status, "link_only")
        self.assertIsNone(result.opening_hours)
        self.assertIsNone(result.closed_days)
        self.assertIsNone(result.admission)
        self.assertIn("公式サイトで確認", result.note)

    async def test_total_timeout_returns_known_link_and_no_cache(self):
        async def slow(url):
            if "openstreetmap" in url:
                return osm()
            await asyncio.sleep(1)
        with patch("app.official_place_info._fetch_url", side_effect=slow), patch("app.official_place_info.TOTAL_TIMEOUT_SECONDS", 0.01):
            result = await fetch_official_place_info(place())
        self.assertEqual(result.status, "link_only")
        self.assertEqual(result.url, "https://museum.example/")
        self.assertIsNone(result.checked_at)

    async def test_safe_redirect_maximum_three_calls(self):
        fetch = AsyncMock(side_effect=[osm(), (302, {"location": "/guide"}, b""), page()])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
        self.assertEqual(result.status, "verified")
        self.assertEqual(result.url, "https://museum.example/guide")
        self.assertEqual(fetch.await_count, 3)

    async def test_private_redirect_is_rejected_without_following(self):
        fetch = AsyncMock(side_effect=[osm(), (302, {"location": "http://127.0.0.1/"}, b"")])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
        self.assertEqual(result.status, "unavailable")
        self.assertIsNone(result.url)
        self.assertEqual(fetch.await_count, 2)

    async def test_seed_bypasses_osm_and_keeps_intro_separate_from_live_hours(self):
        seed = {"url": "https://museum.example/", "description": "地域の工芸を紹介する美術館。", "description_source_url": "https://museum.example/about", "highlights": ["工芸の道具と作品を見比べられます。"], "reviewed_at": "2026-10-12"}
        with patch("app.official_place_info._seed_entry", return_value=seed), patch("app.official_place_info._fetch_url", new=AsyncMock(return_value=page())) as fetch:
            result = await fetch_official_place_info(place())
        self.assertEqual(fetch.await_count, 1)
        self.assertEqual(result.description, seed["description"])
        self.assertEqual(result.description_source_url, seed["description_source_url"])
        self.assertEqual(result.highlights, seed["highlights"])
        self.assertIn("2026-10-12", result.note)

    async def test_one_same_host_guide_link_can_supply_missing_fields(self):
        home = page('<title>旅の美術館</title><nav><a href="/guide">ご利用案内</a></nav>')
        fetch = AsyncMock(side_effect=[osm(), home, page()])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
        self.assertEqual(fetch.await_count, 3)
        self.assertEqual(fetch.await_args.args[0], "https://museum.example/guide")
        self.assertIn("9:00", result.opening_hours)

    async def test_external_guide_links_are_not_followed(self):
        home = page('<title>旅の美術館</title><a href="https://other.example/guide">ご利用案内</a>')
        fetch = AsyncMock(side_effect=[osm(), home])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
        self.assertEqual(fetch.await_count, 2)
        self.assertEqual(result.status, "link_only")

    async def test_legacy_domain_redirect_leaves_a_request_for_the_visitor_guide(self):
        home = page('<title>旅の美術館</title><meta name="description" content="利用案内"><a href="/guide">利用案内</a>')
        fetch = AsyncMock(side_effect=[osm(), (301, {"location": "https://new-museum.example/"}, b""), home, page()])
        with patch("app.official_place_info._fetch_url", new=fetch):
            result = await fetch_official_place_info(place())
        self.assertEqual(fetch.await_count, 4)
        self.assertEqual(result.url, "https://new-museum.example/guide")
        self.assertIn("9:00", result.opening_hours)

    async def test_partial_home_fields_survive_a_guide_with_additional_hours(self):
        home = page('<title>旅の美術館</title><p>入館料 無料</p><a href="/guide">利用案内</a>')
        guide = page('<title>旅の美術館</title><p>開館時間 9時〜17時</p><p>休館日 月曜日</p>')
        with patch("app.official_place_info._fetch_url", new=AsyncMock(side_effect=[osm(), home, guide])):
            result = await fetch_official_place_info(place())
        self.assertIn("無料", result.admission)
        self.assertIn("9時", result.opening_hours)


class OfficialURLSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_private_mixed_and_loopback_are_rejected(self):
        loop = asyncio.get_running_loop()
        for addresses in (["127.0.0.1"], ["169.254.169.254"], ["10.0.0.1"], ["::1"], ["93.184.216.34", "192.168.1.1"]):
            with self.subTest(addresses=addresses), patch.object(loop, "getaddrinfo", new=AsyncMock(return_value=[(None, None, None, None, (ip, 443)) for ip in addresses])):
                with self.assertRaises(UnsafeURL):
                    await _resolve_public("https://museum.example/")

    async def test_pinned_request_preserves_host_and_tls_sni(self):
        response = Mock(status_code=200, headers={"content-type": "text/html"})
        async def chunks():
            yield b"hello"
        response.aiter_bytes = chunks
        stream = AsyncMock()
        stream.__aenter__.return_value = response
        client = AsyncMock()
        client.stream = Mock(return_value=stream)
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        with patch("app.official_place_info._resolve_public", new=AsyncMock(return_value=("https://museum.example/guide", "93.184.216.34"))), patch("app.official_place_info.httpx.AsyncClient", return_value=client_context) as factory:
            status, _, body = await _fetch_url("https://museum.example/guide")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"hello")
        self.assertEqual(client.stream.call_args.args[1].host, "93.184.216.34")
        self.assertEqual(client.stream.call_args.kwargs["headers"]["Host"], "museum.example")
        self.assertEqual(client.stream.call_args.kwargs["extensions"]["sni_hostname"], "museum.example")
        self.assertFalse(factory.call_args.kwargs["follow_redirects"])
        self.assertFalse(factory.call_args.kwargs["trust_env"])

    async def test_ipv4_is_preferred_when_both_public_families_exist(self):
        loop = asyncio.get_running_loop()
        answers = [(None, None, None, None, (ip, 443)) for ip in ("2606:4700:4700::1111", "93.184.216.34")]
        with patch.object(loop, "getaddrinfo", new=AsyncMock(return_value=answers)):
            _, address = await _resolve_public("https://museum.example/")
        self.assertEqual(address, "93.184.216.34")

    async def test_stream_size_limit_even_without_content_length(self):
        response = Mock(status_code=200, headers={})
        async def chunks():
            yield b"a" * (MAX_BODY_BYTES + 1)
        response.aiter_bytes = chunks
        stream = AsyncMock()
        stream.__aenter__.return_value = response
        client = AsyncMock()
        client.stream = Mock(return_value=stream)
        context = AsyncMock()
        context.__aenter__.return_value = client
        with patch("app.official_place_info._resolve_public", new=AsyncMock(return_value=("https://museum.example/", "93.184.216.34"))), patch("app.official_place_info.httpx.AsyncClient", return_value=context):
            with self.assertRaises(FetchFailure):
                await _fetch_url("https://museum.example/")


class OfficialPageParsingTests(unittest.TestCase):
    def test_unsafe_url_forms(self):
        for url in ("file:///secret", "http://localhost/", "https://user:pass@example.com", "http://[::1]/", "http://10.0.0.1/", "https://example.com:8080/", "http://169.254.169.254/", "http://2130706433/\n", "https://example.com\\@localhost/"):
            with self.subTest(url=url), self.assertRaises(UnsafeURL):
                _basic_url(url)

    def test_shift_jis_meta_charset_and_img_alt(self):
        html = '<meta charset="Shift_JIS"><title>旅の美術館</title><p><img alt="開館時間">9時〜17時</p><p><img alt="休館日">月曜日</p>'
        result = _extract_page(html.encode("shift_jis"), {"content-type": "text/html"}, "https://museum.example/", place())
        self.assertIn("9時", result.opening_hours)
        self.assertIn("月曜日", result.closed_days)
        self.assertIsNone(result.admission)

    def test_binary_content_rejected(self):
        with self.assertRaises(FetchFailure):
            _extract_page(b"PNG", {"content-type": "image/png"}, "https://museum.example/", place())

    def test_closure_alias_keeps_year_end_and_exhibition_changes(self):
        html = '<title>旅の美術館</title><h2>休館日</h2><p>定休日：火曜日</p><p>年末年始（12月29日〜1月3日）</p><p>展示替期間</p><h2>観覧料</h2><p>一般500円</p>'
        result = _extract_page(html.encode(), {"content-type": "text/html"}, "https://museum.example/", place())
        for text in ("火曜日", "年末年始", "展示替期間"):
            self.assertIn(text, result.closed_days)
        self.assertNotIn("500円", result.closed_days)

    def test_navigation_without_actual_values_is_not_facility_information(self):
        html = '<title>旅の美術館</title><p>開館時間についてはこちら</p><p>休館日についてはこちら</p><p>料金についてはこちら</p>'
        result = _extract_page(html.encode(), {"content-type": "text/html"}, "https://museum.example/", place())
        self.assertIsNone(result.opening_hours)
        self.assertIsNone(result.closed_days)
        self.assertIsNone(result.admission)

    def test_park_and_temple_labels_and_free_admission(self):
        html = '<title>旅の美術館</title><p>拝観時間：午前9時〜午後5時</p><p>休園日：水曜日</p><p>料金：無料</p>'
        result = _extract_page(html.encode(), {"content-type": "text/html"}, "https://museum.example/", place())
        self.assertIn("9時", result.opening_hours)
        self.assertIn("水曜日", result.closed_days)
        self.assertIn("無料", result.admission)

    def test_seed_requires_id_name_and_location_match(self):
        from app.official_place_info import _seed_entry
        seed = {"id": "osm-node-123", "name": "旅の美術館", "latitude": 35, "longitude": 135, "url": "https://museum.example/"}
        for changes in ({}, {"id": "osm-node-999"}, {"name": "別の施設"}, {"latitude": 36}):
            with patch("pathlib.Path.read_text", return_value=json.dumps({"version": 1, "places": [seed | changes]})):
                result = _seed_entry(place())
            self.assertEqual(result is not None, not bool(changes))

    def test_municipal_guide_meta_label_does_not_replace_introduction_and_fee_stops_at_access(self):
        html = '<title>旅の美術館</title><meta name="description" content="利用案内"><p>入館料 無料</p><p>アクセス 最寄駅から徒歩5分</p><p>所在地 京都市</p>'
        result = _extract_page(html.encode(), {"content-type": "text/html"}, "https://museum.example/", place())
        self.assertIsNone(result.description)
        self.assertEqual(result.admission, "入館料 無料")
