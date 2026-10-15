import asyncio
import json
import unittest
from unittest.mock import patch, AsyncMock
from app.catalog_url_search import candidate_from_response, discover, address_key
from app.models import Place
from app.official_html import Document
from tests.test_catalog_updater import observation

class URLSearchTests(unittest.TestCase):
    def setUp(self):
        self.location_patch=patch("app.catalog_url_search.location_context",AsyncMock(return_value=None))
        self.location_patch.start();self.addCleanup(self.location_patch.stop)
        self.place=Place(id='test',name='試験博物館',category='博物館',description='',access_point='',themes=[],latitude=35,longitude=135,address='京都府')
        self.found={'official':True,'name':'試験博物館','url':'https://museum.example/visit','address':'京都府京都市中京区試験町1番地','latitude':35.0001,'longitude':135.0001}
    def payload(self):
        return {'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':json.dumps(self.found)}]},'groundingMetadata':{'webSearchQueries':['試験博物館 公式'], 'groundingChunks':[{'web':{'uri':'https://museum.example/','title':'公式'}}]}}]}
    def test_no_grounding_is_rejected(self):
        p=self.payload();p['candidates'][0]['groundingMetadata']['groundingChunks']=[]
        with self.assertRaises(ValueError): candidate_from_response(p,self.place)
    def test_wrong_branch_is_rejected(self):
        self.found['latitude']=36
        with self.assertRaises(ValueError): candidate_from_response(self.payload(),self.place)
    def test_review_site_is_rejected(self):
        self.found['url']='https://tabelog.com/test'
        with self.assertRaises(ValueError): candidate_from_response(self.payload(),self.place)
    def test_prefecture_only_address_is_rejected(self):
        self.found['address']='京都府'
        with self.assertRaises(ValueError): candidate_from_response(self.payload(),self.place)
    def test_live_name_and_address_are_required(self):
        from app import catalog_url_search as search
        response=unittest.mock.Mock(content=b'{}');response.json.return_value=self.payload()
        client=AsyncMock();client.__aenter__.return_value=client;client.post.return_value=response
        wrong=Document(title='試験博物館',lines=['大阪府大阪市中央区別町2'])
        with patch.object(search,'gemini_api_key',return_value='fake'), patch.object(search.httpx,'AsyncClient',return_value=client), patch.object(search,'read_page',AsyncMock(return_value=(self.found['url'],wrong))), patch.object(search,'fetch_matched_official_info',AsyncMock()) as fetch:
            result,trace=asyncio.run(discover(self.place))
        self.assertIsNone(result);self.assertIn('address mismatch',trace['reason']);fetch.assert_not_called()
    def test_verified_url_is_returned_only_after_live_check(self):
        from app import catalog_url_search as search
        response=unittest.mock.Mock(content=b'{}');response.json.return_value=self.payload()
        client=AsyncMock();client.__aenter__.return_value=client;client.post.return_value=response
        page=Document(title='試験博物館',lines=[self.found['address']])
        with patch.object(search,'gemini_api_key',return_value='fake'), patch.object(search.httpx,'AsyncClient',return_value=client), patch.object(search,'read_page',AsyncMock(return_value=(self.found['url'],page))), patch.object(search,'fetch_matched_official_info',AsyncMock(return_value=observation())):
            result,trace=asyncio.run(discover(self.place))
        self.assertIsNotNone(result);self.assertEqual(trace['status'],'verified')

    def test_plain_grounded_response_and_address_numbers(self):
        p=self.payload()
        p['candidates'][0]['content']['parts'][0]['text']='施設名：試験博物館\n公式URL：https://museum.example/visit\n所在地：京都府京都市中京区試験町1番地\n緯度：35.0001\n経度：135.0001\n公式確認：確認済み'
        found,_,_=candidate_from_response(p,self.place)
        self.assertEqual(found['name'],self.place.name)
        self.assertEqual(address_key('盛岡市鉈屋町10番8号'),address_key('盛岡市鉈屋町10-8'))
        self.assertNotEqual(address_key('試験町1-23'),address_key('試験町12-3'))

    def test_unknown_coordinates_have_explicit_reason(self):
        from app.catalog_url_search import parse_candidate, SearchResponseError
        text='施設名：名古屋浅田\n公式URL：https://www.asadayaihei.co.jp/nagoya/\n所在地：名古屋市中村区名駅1-1-4\n緯度：UNKNOWN\n経度：UNKNOWN\n公式確認：UNKNOWN'
        with self.assertRaises(SearchResponseError) as caught: parse_candidate(text)
        self.assertEqual(caught.exception.code,'position_unknown')

    def test_unknown_answer_is_not_parser_failure(self):
        from app.catalog_url_search import parse_candidate, SearchResponseError
        with self.assertRaises(SearchResponseError) as caught: parse_candidate('UNKNOWN')
        self.assertEqual(caught.exception.code,'not_found')

    def test_markdown_bullets_and_fullwidth_coordinates(self):
        from app.catalog_url_search import parse_candidate
        text='- **施設名：試験博物館**\n- 公式URL：[公式](https://museum.example/visit)\n- 所在地：京都府京都市中京区試験町1番地\n- 緯度：３５.０００１\n- 経度：１３５.０００１\n- 公式確認：確認済み'
        found=parse_candidate(text)
        self.assertEqual(found['latitude'],35.0001)
        self.assertEqual(found['url'],'https://museum.example/visit')

    def test_missing_fields_and_empty_candidates_are_explicit(self):
        from app.catalog_url_search import candidate_from_response, parse_candidate, SearchResponseError
        with self.assertRaises(SearchResponseError): parse_candidate('施設名：試験博物館')
        with self.assertRaises(SearchResponseError): candidate_from_response({'candidates':[]},self.place)

    def test_unknown_url_gets_only_one_repair_without_accepting_unknown(self):
        from app import catalog_url_search as search
        from app import catalog_metrics
        p=self.payload();p['candidates'][0]['content']['parts'][0]['text']=json.dumps({**self.found,'url':'UNKNOWN'})
        p['usageMetadata']={'promptTokenCount':10,'candidatesTokenCount':5}
        response=unittest.mock.Mock(content=b'{}');response.json.return_value=p
        client=AsyncMock();client.__aenter__.return_value=client;client.post.return_value=response
        state=catalog_metrics.start('test-repair')
        try:
            with patch.object(search,'gemini_api_key',return_value='fake'), patch.object(search.httpx,'AsyncClient',return_value=client), patch.object(search,'fetch_matched_official_info',AsyncMock()) as fetch:
                result,trace=asyncio.run(search.discover(self.place))
            self.assertIsNone(result);fetch.assert_not_called()
            self.assertEqual(client.post.await_count,2)
            self.assertEqual(trace['reason_code'],'official_url_unknown')
            self.assertEqual(len(trace['attempts']),2)
            self.assertEqual(trace['query_count'],2)
            self.assertEqual(state['prompt_tokens'],20)
        finally:
            catalog_metrics.current.set(None)

    def test_unknown_url_in_six_line_answer_is_not_format_error(self):
        from app.catalog_url_search import parse_candidate, SearchResponseError
        text='施設名：店舗\n公式URL：UNKNOWN\n所在地：UNKNOWN\n緯度：UNKNOWN\n経度：UNKNOWN\n公式確認：UNKNOWN'
        with self.assertRaises(SearchResponseError) as caught: parse_candidate(text)
        self.assertEqual(caught.exception.code,'official_url_unknown')

    def test_unknown_position_requires_independent_official_address(self):
        from app import catalog_url_search as search
        self.found['latitude']=None;self.found['longitude']=None
        response=unittest.mock.Mock(content=b'{}');response.json.return_value=self.payload()
        client=AsyncMock();client.__aenter__.return_value=client;client.post.return_value=response
        page=Document(title='試験博物館',lines=[self.found['address']])
        context={'prefecture':'京都府','city':'京都市中京区','neighbourhood':'試験町'}
        for location,expected in ((None,False),(context,True),({**context,'neighbourhood':'別町'},False)):
            with patch.object(search,'location_context',AsyncMock(return_value=location)), patch.object(search,'gemini_api_key',return_value='fake'), patch.object(search.httpx,'AsyncClient',return_value=client), patch.object(search,'read_page',AsyncMock(return_value=(self.found['url'],page))), patch.object(search,'fetch_matched_official_info',AsyncMock(return_value=observation())):
                result,trace=asyncio.run(discover(self.place))
            self.assertEqual(result is not None,expected)
            if expected: self.assertEqual(trace['position_check']['precision'],'neighbourhood_not_point')

    def test_address_corroboration_keeps_chome_and_block_boundaries(self):
        from app.catalog_location import corroborates, address_key
        c={'prefecture':'愛知県','city':'名古屋市中村区','neighbourhood':'名駅一丁目'}
        self.assertTrue(corroborates('名古屋市中村区名駅1-1-4',c))
        self.assertFalse(corroborates('名古屋市中村区名駅2-1-4',c))
        self.assertFalse(corroborates('名古屋市中村区名駅1丁目',c))
        self.assertFalse(corroborates('名古屋市中村区名駅11-1-4',c))
        self.assertFalse(corroborates('東京都名古屋市中村区名駅1-1-4',c))
        self.assertEqual(address_key('名駅一丁目1番4号'),address_key('名駅1-1-4'))

    def test_social_profile_is_not_official_website(self):
        from app.catalog_url_search import allowed_official
        for url in ('https://page.line.me/shop','https://lin.ee/abc','https://x.com/shop','https://www.tiktok.com/@shop'):
            self.assertFalse(allowed_official(url))
