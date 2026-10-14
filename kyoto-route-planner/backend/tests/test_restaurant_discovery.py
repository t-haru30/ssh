import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.discovery import DiscoverRequest, assemble_route, build_discover_routes, diversify_dining_routes, discover_routes
from app.restaurant_discovery import RestaurantDiscovery, discover_restaurants, parse_osm_restaurant, _osm_cache, _google_candidates, _osm_restaurants
from app.models import CatalogPlace


def request(**changes):
    data = dict(area="kyoto",prefecture_name="京都府",origin={"name":"京都駅","latitude":35,"longitude":135.7},
        theme="food",course="half_day",meals=[{"kind":"lunch"}],count=12)
    return DiscoverRequest(**(data | changes))


def osm(i=1, name="京料理の店", **tags):
    return {"type":"node","id":i,"lat":35.001,"lon":135.701,"tags":{"name":name,"amenity":"restaurant",**tags}}


def place(i, name=None, food=True, lat=35.001):
    return CatalogPlace(id=f"osm-node-{i}",name=name or f"飲食店{i}",category="飲食店" if food else "博物館",
        region="京都府",address="京都府",latitude=lat,longitude=135.701,description="",genre_code="01" if food else "0305003",tags={"source":"OpenStreetMap"})


class RestaurantParsingTests(unittest.TestCase):
    def test_osm_identity_radius_category_closure_and_prefecture(self):
        with patch("app.restaurant_discovery._in_prefecture",return_value=True):
            p = parse_osm_restaurant(osm(cuisine="japanese",website="https://venue.example.jp/"),request(),6)
            self.assertEqual(p.id,"osm-node-1")
            self.assertEqual(p.tags["cuisine"],"japanese")
            self.assertEqual(p.tags["source"],"OpenStreetMap")
            for invalid in [osm(amenity="cafe"),osm(**{"disused:amenity":"restaurant"}),osm(access="private"),
                {**osm(),"lat":True},{**osm(),"lat":float("nan")},{**osm(),"lat":36}, {**osm(),"id":True}]:
                self.assertIsNone(parse_osm_restaurant(invalid,request(),6))
        with patch("app.restaurant_discovery._in_prefecture",return_value=False):
            self.assertIsNone(parse_osm_restaurant(osm(),request(cross_prefecture=False),6))

    def test_cache_contains_only_independent_osm_data_and_expires(self):
        with tempfile.TemporaryDirectory() as temp, patch("app.restaurant_discovery.OSM_CACHE_PATH",Path(temp)/"osm.sqlite3"), patch("app.restaurant_discovery.time.time",return_value=1000):
            self.assertIsNone(_osm_cache(request(),6))
            _osm_cache(request(),6,(place(1),))
            self.assertEqual(_osm_cache(request(),6)[0].model_dump(),place(1).model_dump())
            with patch("app.restaurant_discovery.time.time",return_value=30000):
                self.assertIsNone(_osm_cache(request(),6))


class RestaurantProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_overpass_failure_uses_only_independent_osm_seeds_in_the_requested_region(self):
        client = type("Client",(),{"get":AsyncMock(side_effect=httpx.ReadTimeout("unavailable"))})()
        with patch("app.restaurant_discovery._osm_cache",return_value=None), \
             patch("app.restaurant_discovery._in_prefecture",side_effect=lambda req,lat,lon:lat<36), \
             patch("pathlib.Path.read_text",return_value=json.dumps({"license":"ODbL-1.0","places":[place(1).model_dump(),place(2,lat=37).model_dump()]})):
            result = await _osm_restaurants(client,request(),6)
        self.assertEqual([p.id for p in result],["osm-node-1"])
        self.assertEqual(client.get.await_count,2)
        self.assertTrue(all(call.kwargs["timeout"]==6 for call in client.get.call_args_list))

    async def test_unavailable_google_or_osm_is_distinguished_without_private_diagnostics(self):
        self.assertEqual((await self.run_provider([], (place(1),))).status,"google_unavailable")
        self.assertEqual((await self.run_provider([{"id":"g"}], ())).status,"osm_unavailable")

    async def run_provider(self, google, venues):
        with patch.dict(os.environ,{"GOOGLE_RESTAURANTS_ENABLED":"1"}), patch("app.restaurant_discovery.google_api_key",return_value="server-key"), \
                patch("app.restaurant_discovery._google_candidates",new=AsyncMock(return_value=(google,[]))), \
                patch("app.restaurant_discovery._osm_restaurants",new=AsyncMock(return_value=venues)):
            return await discover_restaurants(request())

    async def test_google_discovery_preserves_osm_facts_and_does_not_store_google_content(self):
        venue = place(1,"京料理の店")
        google = {"id":"google-1","displayName":{"text":venue.name},"location":{"latitude":venue.latitude,"longitude":venue.longitude},
            "businessStatus":"OPERATIONAL","primaryType":"japanese_restaurant","rating":4.9,"editorialSummary":{"text":"GOOGLE-ONLY-SUMMARY"}}
        before = venue.model_dump()
        result = await self.run_provider([google],(venue,))
        self.assertEqual(result.status,"ready")
        self.assertEqual(result.verified_count,1)
        self.assertEqual(result.local_match_ids,(venue.id,))
        self.assertEqual(result.places[0].model_dump(),before)
        self.assertNotIn("GOOGLE-ONLY-SUMMARY",json.dumps(result.places[0].model_dump()))
        self.assertNotIn("google-1",json.dumps(result.places[0].model_dump()))

    async def test_closed_venues_are_excluded_and_cafes_cannot_replace_meals(self):
        a,b,c = place(1),place(2),place(3)
        def item(p,status,kind="restaurant"):
            return {"id":f"g-{p.id}","displayName":{"text":p.name},"location":{"latitude":p.latitude,"longitude":p.longitude},"businessStatus":status,"primaryType":kind}
        result = await self.run_provider([item(a,"CLOSED_PERMANENTLY"),item(b,"CLOSED_TEMPORARILY"),item(c,"OPERATIONAL","cafe")],(a,b,c))
        self.assertEqual(result.verified_count,0)
        self.assertNotIn(a.id,[p.id for p in result.places])
        self.assertNotIn(b.id,[p.id for p in result.places])
        self.assertNotIn(c.id,[p.id for p in result.places])

    async def test_nonmatching_branch_remains_osm_only_and_not_google_verified(self):
        p = place(1,"食堂 京都店")
        result = await self.run_provider([{"id":"g-1","displayName":{"text":"食堂 大阪店"},"location":{"latitude":p.latitude,"longitude":p.longitude},"businessStatus":"OPERATIONAL"}],(p,))
        self.assertEqual(result.verified_count,0)
        self.assertEqual(result.local_match_ids,())
        self.assertEqual(result.places,())

    async def test_old_osm_position_is_not_added_even_with_same_business_name(self):
        p = place(1,"京料理 矢尾定")
        result = await self.run_provider([{"id":"moved","displayName":{"text":"ごはん処 矢尾定"},
            "location":{"latitude":35.011,"longitude":135.701},"businessStatus":"OPERATIONAL"}],(p,))
        self.assertEqual(result.places,())
        self.assertEqual(result.verified_count,0)

    async def test_no_meals_disabled_or_unconfigured_never_start_provider_search(self):
        for flag,req,key in [("1",request(meals=[]),"test"),("0",request(),"test"),("1",request(),"")]:
            with patch.dict(os.environ,{"GOOGLE_RESTAURANTS_ENABLED":flag}),patch("app.restaurant_discovery.google_api_key",return_value=key),patch("app.restaurant_discovery._google_candidates",new=AsyncMock()) as search:
                await discover_restaurants(req)
                search.assert_not_awaited()

    async def test_bounded_separate_regional_queries_no_reviews_no_key_in_urls(self):
        post = AsyncMock(return_value=httpx.Response(200,json={"places":[]}))
        client = type("Client",(),{"post":post})()
        with patch("app.restaurant_discovery.specialties",return_value=("京料理","湯豆腐")),patch("app.restaurant_discovery.reserve_lookup",return_value=True):
            await _google_candidates(client,request(),2,"private-server-key")
        self.assertEqual(post.await_count,5)
        bodies = [call.kwargs["json"] for call in post.call_args_list]
        self.assertEqual(sum("textQuery" in body for body in bodies),2)
        self.assertEqual(max(body["locationRestriction"]["circle"]["radius"] for body in bodies if "locationRestriction" in body),2000)
        for call in post.call_args_list:
            self.assertNotIn("private-server-key",call.args[0])
            self.assertNotIn("reviews",call.kwargs["headers"]["X-Goog-FieldMask"])
        post.reset_mock()
        with patch("app.restaurant_discovery.reserve_lookup",return_value=False):
            await _google_candidates(client,request(),2,"private-server-key")
        post.assert_not_awaited()


class DiningDiversityTests(unittest.TestCase):
    def test_regeneration_prefers_an_unseen_meal_venue(self):
        a,b,sight = place(1,"京料理の店"),place(2,"別の食堂"),place(9,"博物館",food=False)
        req = request(viewed_dining_ids=[a.id])
        routes = diversify_dining_routes(req,[assemble_route(req,[sight,a])],(a,b,sight))
        self.assertEqual(next(s["place_id"] for s in routes[0]["spots"] if s["role"] == "lunch"),b.id)

    def test_regional_first_then_distinct_meals_with_hard_conditions_preserved(self):
        req = request()
        meals = [place(1,"京料理の店"),place(2,"普通の食堂"),place(3,"別の食堂")]
        sights = [place(10+i,f"博物館{i}",food=False,lat=35.002 + i*.001) for i in range(6)]
        originals = [assemble_route(req,[sight,meals[0]]) for sight in sights]
        before = json.dumps(originals)
        routes = diversify_dining_routes(req,originals,(*sights,*meals))
        chosen = [next(s["place_id"] for s in r["spots"] if s["role"] == "lunch") for r in routes]
        self.assertEqual(chosen[0],meals[0].id)
        self.assertEqual(len(set(chosen[:3])),3)
        self.assertEqual(max(chosen.count(i) for i in chosen),2)
        self.assertEqual(json.dumps(originals),before)
        for r in routes:
            self.assertLessEqual(r["estimated_minutes"],300)
            self.assertEqual(sum(s["role"] == "lunch" for s in r["spots"]),1)
            self.assertEqual(len(r["legs"]),len(r["spots"])+1)

    def test_replacement_outside_explicit_meal_time_is_not_adopted(self):
        req = request(meals=[{"kind":"lunch","time":"12:00"}],radius_km=30)
        a,b = place(1),place(2,lat=35.25)
        sight = place(9,"博物館",food=False)
        original = assemble_route(req,[sight,a])
        routes = diversify_dining_routes(req,[original],(a,b,sight),{b.id})
        self.assertEqual(routes[0]["spots"],original["spots"])


class RestaurantFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_regional_search_hint_is_a_preference_and_keeps_menu_unconfirmed(self):
        from app.discovery_review import review_journeys
        req = request()
        diner,sight = place(1,"地域の店"),place(2,"博物館",food=False)
        route = assemble_route(req,[sight,diner])
        with patch("app.discovery_review.record",return_value=False):
            report = await review_journeys(req,{"routes":[route],"catalog":{"local_dining_ids":[diner.id]}},(diner,sight))
        self.assertEqual(report["status"],"passed")
        self.assertIn("メニュー",report["limitations"])

    async def test_places_results_enter_route_pool_and_balancing_also_applies_to_ai_deck(self):
        from app.discovery_review import review_journeys
        req = request()
        old = place(1,"同じ食堂")
        regional = place(2,"京料理の店")
        other = place(3,"別の食堂")
        sights = [place(10+i,f"博物館{i}",food=False,lat=35.002+i*.001) for i in range(4)]
        base = tuple([old,*sights])
        fallback = build_discover_routes(req,base)
        async def ai(_request,_pool,_fallback):
            return {**_fallback,"routes":[assemble_route(req,[p,old]) for p in sights],"agent":{"status":"ready","message":"AIの候補"}}
        with patch("app.discovery._base_discover_catalog",new=AsyncMock(return_value=(fallback,base))), \
             patch("app.openpoi.enrich_candidates",new=AsyncMock(return_value=(base,"disabled"))), \
             patch("app.restaurant_discovery.discover_restaurants",new=AsyncMock(return_value=RestaurantDiscovery(places=(regional,other),status="ready",local_match_ids=(regional.id,),verified_count=2))), \
             patch("app.discovery_agent.recommend_routes",side_effect=ai),patch("app.discovery_review.record",return_value=False):
            result = await discover_routes(req)
        self.assertEqual(result["catalog"]["restaurants_added"],2)
        self.assertIn("Google Places",result["source"])
        lunches = [next(s["place_id"] for s in r["spots"] if s["role"] == "lunch") for r in result["routes"]]
        self.assertEqual(lunches[0],regional.id)
        self.assertGreaterEqual(len(set(lunches)),3)
        self.assertEqual(result["review"]["status"],"passed")
