import json,unittest
from unittest.mock import patch
import httpx
from app import journey_landmarks as landmarks

class NamedPlaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_live_named_osm_and_places_but_returns_only_independent_facts(self):
        calls=[]
        def respond(r):
            calls.append(str(r.url))
            if r.url.host=='places.googleapis.com':return httpx.Response(200,json={'places':[{'displayName':{'text':'法隆寺'},'location':{'latitude':34.614,'longitude':135.734},'businessStatus':'OPERATIONAL','secret_google_summary':'not savable'}]})
            return httpx.Response(200,json={'elements':[{'type':'way','id':123,'center':{'lat':34.614,'lon':135.734},'tags':{'name':'法隆寺','religion':'buddhist'}}]})
        with patch.object(landmarks,'load_public_places',return_value=()),patch.object(landmarks,'seed_records',return_value=[]),patch.object(landmarks,'google_api_key',return_value='test'),patch.object(landmarks,'reserve_lookup',return_value=True):
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:result=await landmarks.named_landmarks(client,'法隆寺')
        self.assertEqual(result[0]['name'],'法隆寺')
        self.assertEqual(result[0]['tags']['source_url'],'https://www.openstreetmap.org/way/123')
        self.assertEqual(len(calls),2)
        self.assertNotIn('not savable',json.dumps(result))

    async def test_bundled_horyuji_and_nearest_kiyomizu_are_available_without_network(self):
        from app.models import Origin
        from unittest.mock import AsyncMock
        client=AsyncMock()
        origin=Origin(name='京都駅',latitude=34.98585,longitude=135.75877)
        with patch.object(landmarks,'load_public_places',side_effect=FileNotFoundError):
            horyuji=await landmarks.named_landmarks(client,'法隆寺',origin)
            kiyomizu=await landmarks.named_landmarks(client,'清水寺',origin)
        self.assertEqual(horyuji[0]['id'],'osm-way-43549741')
        self.assertEqual(kiyomizu[0]['name'],'清水寺')
        self.assertLess(abs(kiyomizu[0]['latitude']-35),.1)
        client.post.assert_not_awaited()
