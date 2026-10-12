"""Slow optional photos must not prevent an otherwise valid AI title."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.copywriting import RouteCopywriting, _parse_copywriting, generate_route_copywriting
from app.idea_service import generate_idea_from_places
from app.models import Place


def places():
    museum = Place(id='museum', name='小樽市立 小樽美術館', category='博物館', description='',
        access_point='', latitude=43.1966451, longitude=141.0002996, themes=['history'])
    return [museum, museum.model_copy(update={'id': 'museum-2', 'name': 'テスト資料館'})]


class TitleDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_title_completes_even_when_photo_never_returns(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def photo(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def title(*args):
            await started.wait()
            return RouteCopywriting('小樽で出会うアート', '街歩きの合間に、美術館へ。')

        with patch('app.idea_service.search_commercial_image', side_effect=photo), patch(
                'app.idea_service.generate_route_copywriting', side_effect=title):
            result = await asyncio.wait_for(generate_idea_from_places(places(), 'history', '歴史と文化', ''), 1)
        self.assertEqual(result.copywriting_source, 'gemini')
        self.assertIsNone(result.image_url)
        self.assertTrue(cancelled.is_set())

    async def test_request_cancellation_also_cancels_photo(self):
        photo_started, title_started, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def photo(*args):
            photo_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def title(*args):
            title_started.set()
            await asyncio.Event().wait()

        with patch('app.idea_service.search_commercial_image', side_effect=photo), patch(
                'app.idea_service.generate_route_copywriting', side_effect=title):
            task = asyncio.create_task(generate_idea_from_places(places(), 'history', '歴史と文化', ''))
            await asyncio.wait_for(asyncio.gather(photo_started.wait(), title_started.wait()), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(cancelled.is_set())

    async def test_short_copy_uses_low_reasoning_and_one_paid_attempt(self):
        response = httpx.Response(200, json={'candidates': [{'content': {'parts': [
            {'text': '{"title":"小樽のアート","story":"美術館を訪ねます。"}'}]}}]})
        with patch.dict('os.environ', {'GEMINI_API_KEY': 'test-only', 'GEMINI_MODEL': 'gemini-3.8-flash'}), patch(
                'app.copywriting.load_dotenv'), patch('app.copywriting.request_with_retry',
                new=AsyncMock(return_value=response)) as request:
            result = await generate_route_copywriting(places(), 'history')
        self.assertEqual(result.title, '小樽のアート')
        self.assertEqual(request.await_args.kwargs['attempts'], 1)
        self.assertEqual(request.await_args.kwargs['json']['generationConfig']['thinkingConfig'], {'thinkingLevel': 'LOW'})

    def test_provider_thought_parts_are_not_parsed_as_final_json(self):
        result = _parse_copywriting({'candidates': [{'content': {'parts': [
            {'thought': True, 'text': 'internal reasoning'},
            {'text': '{"title":"美術館へ","story":"小樽を歩く。"}'}]}}]})
        self.assertEqual(result.title, '美術館へ')
