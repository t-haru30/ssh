import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.models import Place
from app.official_place_info import OfficialPlaceInfo
from app.official_html import parse_document
from app import official_attractions as attractions


def place(**changes):
    return Place(**(dict(id="osm-node-1", name="旅の美術館", category="博物館", description="", access_point="", latitude=35, longitude=135, themes=["history"]) | changes))


def page(body):
    return 200, {"content-type": "text/html; charset=utf-8"}, body.encode()


class AttractionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        attractions._cache.clear()
        attractions._negative_cache.clear()
        seed = patch("app.official_attractions.official._seed_entry", return_value=None)
        seed.start()
        self.addCleanup(seed.stop)

    async def test_extracts_actual_distinctive_sentences_and_cites_detail_page(self):
        fact = "当館では明治時代の陶芸家が制作した作品を中心に約千点を収蔵しています。"
        info = OfficialPlaceInfo(url="https://museum.example/", checked_at="2026-10-13", note="")
        fetch = AsyncMock(side_effect=[page('<title>旅の美術館</title><nav>国宝の仏像を多数展示しています。ぜひ見に来てください。</nav><a href="/collection">収蔵品について</a><a href="https://other.example/">歴史</a>'), page(f'<title>旅の美術館の収蔵品</title><p>{fact}</p>')])
        with patch.object(attractions.official, "fetch_official_place_info", AsyncMock(return_value=info)), patch.object(attractions.official, "_fetch_url", fetch):
            result = await attractions.fetch_official_attractions(place())
            cached = await attractions.fetch_official_attractions(place())
        self.assertEqual(result, cached)
        self.assertEqual([f.text for f in result.facts], [fact])
        self.assertEqual(result.facts[0].source_url, "https://museum.example/collection")
        self.assertEqual(fetch.await_count, 2)
        self.assertTrue(result.checked_at)

    async def test_rejects_other_facility_on_shared_domain_and_private_links(self):
        info = OfficialPlaceInfo(url="https://city.example/museum/", checked_at="2026-10-13", note="")
        fetch = AsyncMock(side_effect=[page('<title>旅の美術館</title><a href="http://127.0.0.1/">歴史</a><a href="/other">施設について</a>'), page('<title>別の博物館</title><p>明治時代の陶芸家が制作した作品を中心に約千点を収蔵しています。</p><nav>旅の美術館</nav>')])
        with patch.object(attractions.official, "fetch_official_place_info", AsyncMock(return_value=info)), patch.object(attractions.official, "_fetch_url", fetch):
            result = await attractions.fetch_official_attractions(place())
        self.assertEqual(result.facts, [])
        self.assertEqual(fetch.await_count, 2)

    def test_rejects_boilerplate_category_hours_and_keyword_lists(self):
        document = parse_document(page('<title>旅の美術館</title><meta name="description" content="旅の美術館の公式サイトです。歴史と文化を学べる人気の博物館です。"><p>開館時間は午前九時から午後五時までです。国宝の展示もあります。</p><p>展示・歴史・コレクション・庭園・建築・文化財・作品・収蔵品</p>')[2], {"content-type": "text/html"})
        self.assertEqual(attractions._sentences(document), [])

    def test_past_event_is_not_presented_as_a_permanent_attraction(self):
        document = parse_document(page('<title>旅の美術館</title><p>2021年10月1日から、江戸時代の絵画を紹介する特別展を開催します。</p>')[2], {"content-type": "text/html"})
        self.assertEqual(attractions._sentences(document), [])

    def test_unrelated_header_cannot_establish_identity(self):
        document = parse_document(page('<title>別の文化施設</title><header>旅の美術館</header><p>明治時代の陶芸家が制作した作品を中心に約千点を収蔵しています。</p>')[2], {"content-type": "text/html"})
        self.assertFalse(attractions._identity(document, place()))

    async def test_guide_url_falls_back_to_facility_directory_for_about_link(self):
        fact = "当館では明治時代の陶芸家が制作した作品を中心に約千点を収蔵しています。"
        info = OfficialPlaceInfo(url="https://museum.example/museum/guide/index.html", note="")
        fetch = AsyncMock(side_effect=[page('<title>旅の美術館</title>'), page('<title>旅の美術館</title><a href="about.html">資料館紹介</a>'), page(f'<title>旅の美術館</title><p>{fact}</p>')])
        with patch.object(attractions.official, "fetch_official_place_info", AsyncMock(return_value=info)), patch.object(attractions.official, "_fetch_url", fetch):
            result = await attractions.fetch_official_attractions(place())
        self.assertEqual([call.args[0] for call in fetch.await_args_list], ['https://museum.example/museum/guide/index.html', 'https://museum.example/museum/', 'https://museum.example/museum/about.html'])
        self.assertEqual(result.facts[0].text, fact)

    async def test_coalesces_concurrent_requests_without_shared_mutable_results(self):
        async def load(p, result):
            await asyncio.sleep(.01)
            return attractions.OfficialAttractions(place_id=p.id, facts=[attractions.AttractionFact(text="根拠", source_url="https://museum.example/")])
        with patch.object(attractions, "_load", new=AsyncMock(side_effect=load)) as fetch:
            left, right = await asyncio.gather(attractions.fetch_official_attractions(place()), attractions.fetch_official_attractions(place()))
        self.assertEqual(fetch.await_count, 1)
        left.facts.clear()
        self.assertEqual(len(right.facts), 1)

    async def test_reviewed_seed_uses_review_date_and_never_claims_live_check(self):
        seed = {"reviewed_at": "2026-09-01", "description": "親鸞聖人の足跡を伝える寺院です。", "description_source_url": "https://temple.example/about"}
        with patch.object(attractions.official, "_seed_entry", return_value=seed), patch.object(attractions.official, "fetch_official_place_info", new=AsyncMock()) as live:
            result = await attractions.fetch_official_attractions(place())
        live.assert_not_awaited()
        self.assertEqual(result.reviewed_at, "2026-09-01")
        self.assertIsNone(result.checked_at)

    async def test_batch_caps_candidates_and_concurrency(self):
        active = peak = 0
        async def fetch(p):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.01)
            active -= 1
            return attractions.OfficialAttractions(place_id=p.id)
        with patch.object(attractions, "fetch_official_attractions", new=AsyncMock(side_effect=fetch)) as mock:
            result = await attractions.enrich_official_attractions([place(id=str(i)) for i in range(20)])
        self.assertEqual(len(result), 12)
        self.assertEqual(mock.await_count, 12)
        self.assertLessEqual(peak, 4)

    async def test_failure_uses_short_negative_cache(self):
        with patch.object(attractions, "_load", new=AsyncMock(side_effect=ValueError("offline"))) as load:
            first = await attractions.fetch_official_attractions(place())
            await attractions.fetch_official_attractions(place())
        self.assertEqual(first.facts, [])
        self.assertEqual(load.await_count, 1)
        self.assertFalse(attractions._cache.get(attractions._key(place()))[0])
        self.assertTrue(attractions._negative_cache.get(attractions._key(place()))[0])

    async def test_timeout_preserves_fact_already_extracted(self):
        async def load(p, result):
            result.facts.append(attractions.AttractionFact(text="確認済みの見どころ", source_url="https://museum.example/"))
            await asyncio.sleep(1)
        with patch.object(attractions, "_load", new=load), patch.object(attractions, "TOTAL_TIMEOUT_SECONDS", .02):
            results = await attractions.enrich_official_attractions([place()])
            self.assertEqual(len(results[place().id].facts), 1)
            await asyncio.sleep(.01)
