import unittest
from datetime import date
from app.venue_hours import osm_windows,google_regular_windows
from app.discovery import DiscoverRequest,assemble_route
from app.discovery import build_discover_routes
from app.models import CatalogPlace

class HoursTests(unittest.TestCase):
    def test_split_hours_and_closed_weekday(self):
        hours='Mo-Tu,Th-Su 11:00-15:00,17:00-21:00; We off'
        self.assertEqual(osm_windows(hours,date(2026,10,13)),[(660,900),(1020,1260)])
        self.assertEqual(osm_windows(hours,date(2026,10,14)),[])
        self.assertIsNone(osm_windows('PH off; Mo-Su 11:00-21:00',date(2026,10,13)))
    def test_rejects_breakfast_in_a_lunch_only_restaurant_without_changing_meal_time(self):
        restaurant=CatalogPlace(id='r',name='釜春',category='飲食店',region='愛知県',address='',latitude=35.1,longitude=137,description='',tags={'opening_hours':'Mo-Su 11:00-15:00,17:00-21:00'})
        request=DiscoverRequest(area='aichi',prefecture_name='愛知県',origin={'name':'駅','latitude':35.1,'longitude':137},course='all',departure_date='2026-10-13',meals=[{'kind':'breakfast','time':'08:30'}])
        self.assertIsNone(assemble_route(request,[restaurant]))
        request.meals[0].time='12:30'
        self.assertIsNotNone(assemble_route(request,[restaurant]))
    def test_google_regular_hours_cover_overnight_and_unknown(self):
        hours={'periods':[{'open':{'day':2,'hour':17},'close':{'day':3,'hour':2}}]}
        self.assertEqual(google_regular_windows(hours,date(2026,10,13)),[(1020,1560)])
        self.assertEqual(google_regular_windows(hours,date(2026,10,14)),[(0,120)])
        self.assertIsNone(google_regular_windows({},date(2026,10,13)))

    def test_chooses_an_open_breakfast_alternative_instead_of_returning_no_plans(self):
        origin={'name':'駅','latitude':35.1,'longitude':137}
        request=DiscoverRequest(area='aichi',prefecture_name='愛知県',origin=origin,course='all',departure_date='2026-10-13',meals=[{'kind':'breakfast','time':'08:30'}])
        def p(id,name,category,hours):return CatalogPlace(id=id,name=name,category=category,region='愛知県',address='',description='',latitude=35.1,longitude=137,tags={'opening_hours':hours})
        late=p('late','ランチ食堂','飲食店','Mo-Su 11:00-21:00')
        early=p('early','朝ごはん食堂','飲食店','Mo-Su 07:00-10:00')
        museum=p('museum','歴史博物館','博物館','')
        routes=build_discover_routes(request,(late,early,museum))['routes']
        self.assertTrue(routes)
        self.assertTrue(all('late' not in [s['place_id'] for s in r['spots']] for r in routes))
