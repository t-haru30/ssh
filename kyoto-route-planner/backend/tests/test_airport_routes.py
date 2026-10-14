import unittest
from unittest.mock import AsyncMock
from app.airport_routes import selected_airports,airport_via,_codes
from app.route_preferences import routing_preferences,options

class AirportTests(unittest.IsolatedAsyncioTestCase):
    async def test_nagoya_uses_chubu_not_kobe_and_checks_plane_station_codes(self):
        _codes.clear()
        points=['35.1709,136.8815','26.2042,127.6466']
        self.assertEqual([p['iata'] for p in selected_airports(points)],['NGO','OKA'])
        resolve=AsyncMock(side_effect=[[{'Station':{'code':'NGO-code','Type':'plane'}}],[{'Station':{'code':'OKA-code','Type':'plane'}}]])
        self.assertEqual(await airport_via(points,resolve),[points[0],'NGO-code','OKA-code',points[1]])
        self.assertTrue(all(call.kwargs['transport_type']=='plane' for call in resolve.call_args_list))
        self.assertEqual(await airport_via(points,resolve),[points[0],'NGO-code','OKA-code',points[1]])
        self.assertEqual(resolve.await_count,2)
        _codes.clear()
    def test_preference_is_request_local_and_normal_trips_do_not_add_airports(self):
        self.assertIsNone(selected_airports(['35,135','35.1,135.1']))
        with routing_preferences('price',False):self.assertEqual(options.get(),('price',False))
        self.assertEqual(options.get(),('time',True))
