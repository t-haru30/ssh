import json
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from app.models import Place
from app.google_place_info import fetch_google_info

class GoogleInfoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.place = Place(id="osm-1",name="天ぷらの店",category="飲食店",description="",access_point="",themes=["food"],latitude=35,longitude=135,address="京都府")
        self.item = {"id":"google-id","displayName":{"text":"天ぷらの店"},"location":{"latitude":35,"longitude":135},"editorialSummary":{"text":"季節の天ぷらを提供する店。"},"primaryType":"tempura_restaurant","primaryTypeDisplayName":{"text":"天ぷら店"},"rating":4.3,"userRatingCount":120,"googleMapsUri":"https://maps.google.com/?cid=1","businessStatus":"OPERATIONAL","regularOpeningHours":{"weekdayDescriptions":["月曜日: 11時～20時"]}}

    async def fetch(self, items):
        response = httpx.Response(200,json={"places":items})
        with patch("app.google_place_info.google_api_key",return_value="test-server"), patch("app.google_place_info.reserve_lookup",return_value=True), patch("httpx.AsyncClient.post",new=AsyncMock(return_value=response)) as post:
            result = await fetch_google_info(self.place)
        return result,post

    async def test_identity_summary_sources_and_no_catalog_mutation(self):
        before = self.place.model_dump()
        result,post = await self.fetch([self.item])
        self.assertEqual(result.status,"ready")
        self.assertEqual(result.summary,self.item["editorialSummary"]["text"])
        self.assertEqual(result.category,"天ぷら店")
        self.assertEqual(result.rating_count,120)
        self.assertEqual(self.place.model_dump(),before)
        mask = post.call_args.kwargs["headers"]["X-Goog-FieldMask"]
        self.assertNotIn("reviews",mask)
        self.assertNotIn("test-server",json.dumps(result.model_dump()))

    async def test_wrong_branch_ambiguous_and_unsafe_source_are_not_displayed(self):
        for items in [[{**self.item,"location":{"latitude":36,"longitude":135}}], [self.item,self.item], [{**self.item,"googleMapsUri":"https://attacker.test"}], [{**self.item,"displayName":{"text":"天ぷらの店 別支店"}}]]:
            result,_ = await self.fetch(items)
            self.assertEqual(result.status,"unavailable")

    async def test_budget_exhausted_never_calls_provider(self):
        with patch("app.google_place_info.google_api_key",return_value="test"),patch("app.google_place_info.reserve_lookup",return_value=False),patch("httpx.AsyncClient.post",new=AsyncMock()) as post:
            self.assertEqual((await fetch_google_info(self.place)).status,"unavailable")
        post.assert_not_awaited()

    def test_location_prefix_retains_complete_branch_identity(self):
        from app.google_place_photos import same_google_venue
        place=self.place.model_copy(update={"name":"天ぷら圓堂 岡ざき邸"})
        exact={**self.item,"displayName":{"text":"京都祇園 天ぷら圓堂 岡ざき邸"}}
        self.assertTrue(same_google_venue(place,exact))
        self.assertFalse(same_google_venue(place,{**exact,"displayName":{"text":"京都祇園 天ぷら圓堂 岡ざき邸 別店"}}))
        self.assertFalse(same_google_venue(place,{**exact,"location":{"latitude":35.002,"longitude":135}}))

    def test_bilingual_sign_requires_complete_latin_name_delimiters_and_nearby_position(self):
        from app.google_place_photos import same_google_venue
        place = self.place.model_copy(update={"name":"Sanzuian"})
        candidate = {**self.item,"displayName":{"text":"氵庵 -sanzuian-"}}
        self.assertTrue(same_google_venue(place, candidate))
        for name in ["氵庵 -sanzuian- 別店", "氵庵 -sanzuian annex-", "Sanzuian Kyoto", "氵庵 -sanzuianother-"]:
            self.assertFalse(same_google_venue(place, {**candidate,"displayName":{"text":name}}))
        self.assertFalse(same_google_venue(place, {**candidate,"location":{"latitude":35.002,"longitude":135}}))

    def test_cuisine_labels_and_delimited_prefix_keep_branch_and_position_checks(self):
        from app.google_place_photos import same_google_venue
        p = self.place.model_copy(update={"name":"京料理 矢尾定"})
        candidate = {**self.item,"displayName":{"text":"ごはん処 矢尾定"}}
        self.assertTrue(same_google_venue(p,candidate))
        self.assertFalse(same_google_venue(p,{**candidate,"location":{"latitude":35.01,"longitude":135}}))
        self.assertFalse(same_google_venue(p,{**candidate,"displayName":{"text":"ごはん処 矢尾定 別店"}}))
        p = self.place.model_copy(update={"name":"順正"})
        self.assertTrue(same_google_venue(p,{**candidate,"displayName":{"text":"南禅寺 順正"}}))
        self.assertFalse(same_google_venue(p,{**candidate,"displayName":{"text":"南禅寺 順正 別館"}}))

    async def test_opened_details_read_only_the_matched_website_and_keep_google_out_of_catalog(self):
        from app.official_place_info import OfficialPlaceInfo
        self.item.update(websiteUri="https://venue.example.jp/",formattedAddress="京都市の所在地")
        response = httpx.Response(200,json={"places":[self.item]})
        official = OfficialPlaceInfo(description="公式ページの紹介",url="https://venue.example.jp/",status="verified",note="取得")
        before = self.place.model_dump()
        with patch("app.google_place_info.google_api_key",return_value="test"), patch("app.google_place_info.reserve_lookup",return_value=True), patch("httpx.AsyncClient.post",new=AsyncMock(return_value=response)) as post, patch("app.google_place_info.fetch_matched_official_info",new=AsyncMock(return_value=official)) as fetch:
            result = await fetch_google_info(self.place, include_official=True)
        fetch.assert_awaited_once_with(self.place,"https://venue.example.jp/")
        self.assertEqual(post.await_count,1)
        self.assertEqual(result.official.description,official.description)
        self.assertEqual(result.address,"京都市の所在地")
        self.assertEqual(self.place.model_dump(),before)

    async def test_cards_and_unmatched_venues_never_fetch_a_website(self):
        self.item["websiteUri"] = "https://venue.example.jp/"
        with patch("app.google_place_info.fetch_matched_official_info",new=AsyncMock()) as fetch:
            await self.fetch([self.item])
            await self.fetch([{**self.item,"displayName":{"text":"別の店"}}])
        fetch.assert_not_awaited()

    async def test_matched_website_uses_page_identity_and_rejects_private_urls(self):
        from app.official_place_info import fetch_matched_official_info
        with patch("app.official_place_info._seed_entry",return_value=None), patch("app.official_place_info._fetch_url",new=AsyncMock()) as fetch:
            result = await fetch_matched_official_info(self.place,"http://127.0.0.1/private")
            self.assertEqual(result.status,"unavailable")
            fetch.assert_not_awaited()
        body = '<html><head><title>別の支店</title><meta name="description" content="このページは別の支店について紹介しています。"></head><body>別の支店</body></html>'.encode()
        with patch("app.official_place_info._seed_entry",return_value=None), patch("app.official_place_info._fetch_url",new=AsyncMock(return_value=(200,{"content-type":"text/html; charset=utf-8"},body))):
            result = await fetch_matched_official_info(self.place,"https://venue.example.jp/")
            self.assertIsNone(result.description)
            self.assertEqual(result.status,"link_only")

    async def test_maps_config_only_releases_separate_browser_key(self):
        from app.main import maps_config
        with patch("app.google_place_photos.google_api_key",return_value="server"),patch.dict("os.environ",{"GOOGLE_PLACES_API_KEY":"server","GOOGLE_MAPS_BROWSER_API_KEY":"server"}):
            self.assertIsNone(json.loads((await maps_config()).body)["browser_key"])
        with patch("app.google_place_photos.google_api_key",return_value="server"),patch.dict("os.environ",{"GOOGLE_PLACES_API_KEY":"server","GOOGLE_MAPS_BROWSER_API_KEY":"browser"}):
            self.assertEqual(json.loads((await maps_config()).body)["browser_key"],"browser")
