import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from app import google_place_photos as photos
from app.models import Place

class GooglePhotosTests(unittest.IsolatedAsyncioTestCase):
    async def test_station_photo_rejects_nearby_shops_wrong_stations_and_distant_namesakes(self):
        station = Place(id='trip-arrival',name='京都駅',latitude=35,longitude=135,category='到着・観光の起点',description='',access_point='',themes=[])
        real_client = httpx.AsyncClient
        for name, latitude, kinds, expected in [
            ('京都駅',35,['train_station','transit_station'],'ready'),
            ('京都駅',35,[],'unavailable'),
            ('京都駅',35,['cafe'],'unavailable'),
            ('京都駅',35,['shopping_mall'],'unavailable'),
            ('京都駅前店',35,['train_station'],'unavailable'),
            ('京都駅',36,['train_station'],'unavailable'),
        ]:
            with self.subTest(name=name,latitude=latitude,kinds=kinds):
                calls=[]
                def respond(request):
                    calls.append(request)
                    if request.method=='POST':
                        return httpx.Response(200,json={'places':[{'id':'abc','displayName':{'text':name},'location':{'latitude':latitude,'longitude':135},'types':kinds,'googleMapsUri':'https://maps.google.com/?cid=1','photos':[{'name':'places/abc/photos/xyz'}]}]})
                    return httpx.Response(200,json={'photoUri':'https://lh3.googleusercontent.com/station'})
                with patch.object(photos,'google_api_key',return_value='test'),patch.object(photos,'reserve_lookup',return_value=True),patch.object(photos.httpx,'AsyncClient',side_effect=lambda **kwargs:real_client(transport=httpx.MockTransport(respond))):
                    result=await photos.fetch_google_photo(station)
                self.assertEqual(result.status,expected)
                self.assertEqual(len(calls),2 if expected=='ready' else 1)

    async def test_closed_venues_and_wrong_types_never_supply_photos(self):
        real_client = httpx.AsyncClient
        for status, kinds in [('CLOSED_PERMANENTLY',['museum']),('CLOSED_TEMPORARILY',['museum']),('OPERATIONAL',['restaurant'])]:
            calls = []
            def respond(request):
                calls.append(request)
                return httpx.Response(200,json={'places':[{'id':'abc','displayName':{'text':'資料館'},
                    'location':{'latitude':35,'longitude':135},'businessStatus':status,'types':kinds,
                    'googleMapsUri':'https://maps.google.com/?cid=1','photos':[{'name':'places/abc/photos/xyz'}]}]})
            with patch.object(photos,'google_api_key',return_value='test'), patch.object(photos,'reserve_lookup',return_value=True), patch.object(photos.httpx,'AsyncClient',side_effect=lambda **kwargs:real_client(transport=httpx.MockTransport(respond))):
                result = await photos.fetch_google_photo(self.place)
            self.assertEqual(result.status,'unavailable')
            self.assertEqual(len(calls),1)
    def setUp(self):
        self.place = Place(id="museum", name="資料館", latitude=35, longitude=135, category="博物館", description="", access_point="", themes=[])

    async def test_missing_key_does_not_request(self):
        with patch.dict(os.environ, {"GOOGLE_PLACES_API_KEY":""}), patch.object(photos, "reserve_lookup") as reserve:
            self.assertEqual((await photos.fetch_google_photo(self.place)).status, "unavailable")
            reserve.assert_not_called()

    async def test_matching_photo_and_distant_branch(self):
        real_client = httpx.AsyncClient
        for latitude, expected, count in [(35,"ready",2),(36,"unavailable",1)]:
            calls = []
            def respond(request):
                calls.append(request)
                if request.method == "POST":
                    return httpx.Response(200,json={"places":[{"id":"abc", "displayName":{"text":"資料館"}, "location":{"latitude":latitude,"longitude":135}, "googleMapsUri":"https://maps.google.com/?cid=1", "photos":[{"name":"places/abc/photos/xyz", "authorAttributions":[{"displayName":"撮影者", "uri":"https://www.google.com/maps/contrib/1"}]}]}]})
                return httpx.Response(200,json={"photoUri":"https://lh3.googleusercontent.com/photo"})
            with patch.dict(os.environ,{"GOOGLE_PLACES_API_KEY":"test-key"}), patch.object(photos,"reserve_lookup",return_value=True), patch.object(photos.httpx,"AsyncClient",side_effect=lambda **kwargs:real_client(transport=httpx.MockTransport(respond))):
                result = await photos.fetch_google_photo(self.place)
            self.assertEqual(result.status,expected)
            self.assertEqual(len(calls),count)
            self.assertNotIn("test-key",result.model_dump_json())
            if expected == "ready":
                self.assertEqual(result.authors[0].name,"撮影者")

    def test_quota_persists_and_urls_are_restricted(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(photos,"QUOTA_DB",Path(tmp)/"usage.sqlite3"), patch.dict(os.environ,{"GOOGLE_PLACES_MONTHLY_LIMIT":"1"}):
            self.assertTrue(photos.reserve_lookup())
            self.assertFalse(photos.reserve_lookup())
        self.assertIsNone(photos.safe_url("https://evil.example/photo",image=True))
        self.assertIsNone(photos.safe_url("https://www.google.com/?key=secret"))

    async def test_landscape_is_preferred_to_first_portrait_without_extra_searches(self):
        calls=[];real_client=httpx.AsyncClient
        def respond(request):
            calls.append(request)
            if request.method=='POST':return httpx.Response(200,json={'places':[{'id':'abc','displayName':{'text':'資料館'},'location':{'latitude':35,'longitude':135},'googleMapsUri':'https://maps.google.com/?cid=1',
                'photos':[{'name':'places/abc/photos/portrait','widthPx':600,'heightPx':1000},{'name':'places/abc/photos/landscape','widthPx':1200,'heightPx':800}]}]})
            return httpx.Response(200,json={'photoUri':'https://lh3.googleusercontent.com/photo'})
        with patch.object(photos,'google_api_key',return_value='test'),patch.object(photos,'reserve_lookup',return_value=True),patch.object(photos.httpx,'AsyncClient',side_effect=lambda **kwargs:real_client(transport=httpx.MockTransport(respond))):
            result=await photos.fetch_google_photo(self.place)
        self.assertEqual(result.status,'ready')
        self.assertIn('/landscape/media',str(calls[-1].url))
        self.assertEqual(len(calls),2)
