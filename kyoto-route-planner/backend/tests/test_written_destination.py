import json
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import HTTPException
from app import written_destination as written
from app.destination_suggestion import DestinationRequest, suggest_destination
from app.station_search import StationCandidate


class WrittenDestinationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        written._cache.clear()
        self.station = StationCandidate(name='修善寺駅', latitude=34.98, longitude=138.95, code='123', prefecture='静岡県')
        self.choice = {'place_name':'伊豆','station':'修善寺駅','prefecture':'静岡県','municipality':'伊豆市'}
        self.client = AsyncMock()
        for name, value in [('gemini_api_key','test'), ('setting','gemini-test')]:
            p = patch.object(written, name, return_value=value); p.start(); self.addCleanup(p.stop)
        p = patch.object(written.httpx,'AsyncClient'); factory = p.start(); self.addCleanup(p.stop)
        factory.return_value.__aenter__.return_value = self.client
        p = patch.object(written,'search_stations',new=AsyncMock(return_value=[self.station])); self.search=p.start(); self.addCleanup(p.stop)

    def model(self, choices):
        self.client.post.return_value=httpx.Response(200,request=httpx.Request('POST','https://example.test'),json={
            'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':json.dumps({'locations':choices},ensure_ascii=False)}]}}]})

    async def test_izu_uses_gemini_for_the_name_and_provider_for_coordinates(self):
        self.model([self.choice])
        result=await suggest_destination(DestinationRequest(text='伊豆に行きたい',explicit_only=True))
        self.assertEqual(result['locations'][0]['origin'],{'name':'修善寺駅','latitude':34.98,'longitude':138.95})
        self.search.assert_awaited_once_with('修善寺駅',prefecture_code='22')
        self.assertIn('伊豆',self.client.post.call_args.kwargs['json']['contents'][0]['parts'][0]['text'])
        again=await written.resolve_written_destination('伊豆に行きたい')
        self.assertEqual(again,result);self.assertEqual(self.client.post.await_count,1)

    async def test_generic_wish_does_not_invent_a_location_or_search_stations(self):
        self.model([])
        self.assertEqual(await written.resolve_written_destination('庭園で休みたい'),{'status':'no_location','locations':[]})
        self.search.assert_not_awaited()

    async def test_provider_outage_uses_verified_station_without_more_external_calls(self):
        self.model([self.choice]);self.search.side_effect=HTTPException(503,'Station provider unavailable')
        result=await written.resolve_written_destination('伊豆に行きたい')
        self.assertEqual(result['locations'][0]['origin'],{'name':'修善寺駅','latitude':34.97921395,'longitude':138.9504675})
        self.assertEqual(self.client.post.await_count,1)

    async def test_bundled_station_must_match_the_prefecture(self):
        choice=written.Location(**dict(self.choice,prefecture='京都府',municipality='京都市'))
        # No network rows: the same station name in a different prefecture is invalid.
        self.client.post.return_value=httpx.Response(200,json={'elements':[]})
        with patch.object(written,'google_api_key',return_value=''):
            with self.assertRaises(ValueError): await written.osm_station(choice)

    async def test_unbundled_station_accepts_only_independent_osm_station_data(self):
        choice=written.Location(**dict(self.choice,station='伊豆高原駅',municipality='伊東市'))
        row={'type':'node','id':123,'lat':34.88,'lon':139.1,'tags':{'name':'伊豆高原','railway':'station'}}
        self.client.post.return_value=httpx.Response(200,json={'elements':[row]})
        with patch.object(written,'google_api_key',return_value=''),patch.object(written,'in_prefecture',return_value=True):
            station=await written.osm_station(choice)
            self.assertEqual(station.name,'伊豆高原駅')
            self.assertEqual((station.latitude,station.longitude),(34.88,139.1))
            self.client.post.return_value=httpx.Response(200,json={'elements':[dict(row,tags={'name':'伊豆高原','railway':'platform'})]})
            with self.assertRaises(ValueError): await written.osm_station(choice)

    async def test_unwritten_location_and_generated_coordinates_are_rejected(self):
        for choice in [dict(self.choice,place_name='京都'),dict(self.choice,latitude=35.0)]:
            self.model([choice])
            with self.assertRaises(HTTPException): await written.resolve_written_destination('伊豆に行きたい')
        self.search.assert_not_awaited()

    async def test_station_without_an_exact_prefecture_and_name_match_is_rejected(self):
        self.model([self.choice]);self.search.return_value=[self.station.model_copy(update={'prefecture':'京都府'})]
        with self.assertRaises(HTTPException): await written.resolve_written_destination('伊豆に行きたい')
        self.assertEqual(written._cache.get(written.sha256('伊豆に行きたい'.encode()).hexdigest())[0],False)

    async def test_equal_station_names_at_different_coordinates_require_confirmation(self):
        self.model([self.choice]);self.search.return_value=[self.station,self.station.model_copy(update={'latitude':35.5})]
        with self.assertRaises(HTTPException): await written.resolve_written_destination('伊豆に行きたい')

    async def test_distinct_named_places_remain_choices(self):
        self.model([self.choice,dict(self.choice,place_name='箱根',station='箱根湯本駅',prefecture='神奈川県',municipality='箱根町')])
        self.search.side_effect=[[self.station],[self.station.model_copy(update={'name':'箱根湯本駅','prefecture':'神奈川県','code':'456'})]]
        result=await written.resolve_written_destination('伊豆と箱根に行きたい')
        self.assertEqual([p['place_name'] for p in result['locations']],['伊豆','箱根'])

    async def test_missing_key_does_not_call_any_provider(self):
        with patch.object(written,'gemini_api_key',return_value=''):
            with self.assertRaises(HTTPException) as error: await written.resolve_written_destination('伊豆に行きたい')
        self.assertEqual(error.exception.status_code,503)
        self.client.post.assert_not_awaited();self.search.assert_not_awaited()
