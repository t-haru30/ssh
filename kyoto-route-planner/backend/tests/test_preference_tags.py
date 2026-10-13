import unittest
from unittest.mock import AsyncMock, patch
import httpx
from app.preference_tags import PreferenceTagsRequest, suggest_tags, parse_tags, _cache

class PreferenceTagTests(unittest.IsolatedAsyncioTestCase):
    def test_validation(self):
        self.assertEqual(parse_tags('{"tags":["庭園でひと休み","庭園でひと休み"]}'), ["庭園でひと休み"])
        for value in ['{"tags":[]}', '{"tags":[42]}', '{"tags":["<script>"]}', '{"tags":["' + '長' * 21 + '"]}']:
            with self.assertRaises(ValueError):
                parse_tags(value)

    async def test_model_output_and_context(self):
        payload = PreferenceTagsRequest(theme="food", traveler={"companion":"solo", "age_group":"65_plus", "gender":"female"})
        response = httpx.Response(200, request=httpx.Request("POST", "https://example.test"), json={"candidates":[{"finishReason":"STOP", "content":{"parts":[{"text":'{"tags":["地元の市場巡り","喫茶店でひと休み"]}'}]}}]})
        with patch('app.preference_tags._cache.get', return_value=(False, None)), patch('app.preference_tags.gemini_api_key', return_value='test'), patch('app.preference_tags.setting', return_value='gemini-test'), patch('httpx.AsyncClient.post', new=AsyncMock(return_value=response)) as post:
            result = await suggest_tags(payload)
        self.assertEqual(result['source'], 'ai')
        context = post.call_args.kwargs['json']['contents'][0]['parts'][0]['text']
        self.assertIn('food', context)
        self.assertNotIn('female', context)
        self.assertNotIn('65_plus', context)

    async def test_no_key_is_not_presented_as_ai(self):
        with patch('app.preference_tags._cache.get', return_value=(False, None)), patch('app.preference_tags.gemini_api_key', return_value=''):
            self.assertEqual(await suggest_tags(PreferenceTagsRequest()), {'tags': [], 'source':'unavailable', 'reason':'configuration'})

    async def test_provider_error_is_safe_and_actionable(self):
        response = httpx.Response(429, request=httpx.Request("POST", "https://example.test"))
        with patch('app.preference_tags._cache.get', return_value=(False, None)), patch('app.preference_tags.gemini_api_key', return_value='test'), patch('app.preference_tags.setting', return_value='gemini-test'), patch('httpx.AsyncClient.post', new=AsyncMock(return_value=response)):
            result = await suggest_tags(PreferenceTagsRequest())
        self.assertEqual(result, {'tags': [], 'source':'unavailable', 'reason':'rate_limit'})

    async def test_more_tags_excludes_seen_tags_and_uses_distinct_cache_key(self):
        payload = PreferenceTagsRequest(theme="nature", exclude_tags=["庭園でひと休み"])
        response = httpx.Response(200, request=httpx.Request("POST", "https://example.test"), json={"candidates":[{"finishReason":"STOP", "content":{"parts":[{"text":'{"tags":["庭園でひと休み","湖畔を散歩"]}'}]}}]})
        with patch('app.preference_tags._cache.get', return_value=(False, None)) as cache_get, patch('app.preference_tags.gemini_api_key', return_value='test'), patch('app.preference_tags.setting', return_value='gemini-test'), patch('httpx.AsyncClient.post', new=AsyncMock(return_value=response)) as post:
            result = await suggest_tags(payload)
        self.assertEqual(result['tags'], ["湖畔を散歩"])
        self.assertIn('exclude_tags', cache_get.call_args.args[0])
        self.assertIn('庭園でひと休み', post.call_args.kwargs['json']['contents'][0]['parts'][0]['text'])
