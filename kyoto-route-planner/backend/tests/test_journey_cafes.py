import unittest
from unittest.mock import AsyncMock, patch

from app.journey_cafes import parse_cafes
from app import journey_chat as chat
from tests.test_journey_chat import payload, proposal, call


class CafeTests(unittest.TestCase):
    def test_only_named_nearby_operating_type_cafes_with_source(self):
        base = dict(type="node", id=123, lat=35.001, lon=135, tags={"name": "試験喫茶", "amenity": "cafe"})
        rows = [base, dict(base, id=124, tags={"name": "飲食店", "amenity": "restaurant"}),
                dict(base, id=125, tags={"amenity": "cafe"}), dict(base, id=126, lat=36),
                dict(base, id=127, tags={"name": "旧喫茶", "amenity": "cafe", "disused": "yes"})]
        found = parse_cafes({"elements": rows}, [(35, 135)])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["tags"]["source_url"], "https://www.openstreetmap.org/node/123")

    def test_insertion_hints_protect_completed_and_fixed_appointments(self):
        p = payload(); p.stops[0].completed = True
        hint = chat.insertion_hint(p, p.candidates[0])
        self.assertEqual(hint['best_insertion_index'], 1)
        self.assertEqual(hint['insertion_errors'], [])
        self.assertTrue(chat.validate(payload(budget=1000), proposal(('a', 60), ('b', 30))))
        self.assertTrue(chat.validate(payload(), proposal(('a', 60), ('b', 15))))


class CafeAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_source_candidates_returned_not_model_places(self):
        record = parse_cafes({"elements": [dict(type="node", id=123, lat=35.001, lon=135, tags={"name": "試験喫茶", "amenity": "cafe"})]}, [(35, 135)])[0]
        sequence = [call('search_candidates', {'query': 'カフェ'}), call('search_candidates', {'query': 'coffee'}),
                    call('validate_proposal', proposal(('a', 60), (record['id'], 30)).model_dump())]
        p = payload(candidates=[])
        with patch.object(chat.httpx, 'AsyncClient'), patch.object(chat, 'nearby_cafes', new=AsyncMock(return_value=([record], 'OSM'))) as search, patch.object(chat, 'model_call', new=AsyncMock(side_effect=sequence)):
            result = await chat.run(p, 'test', 'gemini-test')
        search.assert_awaited_once()
        self.assertEqual(result.discovered_candidates, [record])
        self.assertEqual(p.candidates, [])

    async def test_generic_restaurant_not_accepted_as_cafe(self):
        p = payload(); p.candidates[0].name = 'Sanzuian'; p.candidates[0].category = '飲食店'
        sequence = [call('search_candidates', {'query': 'カフェ'}), call('validate_proposal', proposal(('a', 60), ('b', 30)).model_dump()), call('ask_user', {'question': '近隣カフェが見つかりませんでした。'})]
        with patch.object(chat.httpx, 'AsyncClient'), patch.object(chat, 'nearby_cafes', new=AsyncMock(return_value=([], '取得失敗'))), patch.object(chat, 'model_call', new=AsyncMock(side_effect=sequence)):
            result = await chat.run(p, 'test', 'gemini-test')
        self.assertIsNone(result.proposal)
        self.assertIn('カフェと確認', result.steps[1])
