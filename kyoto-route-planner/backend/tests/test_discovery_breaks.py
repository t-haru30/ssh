import unittest
from unittest.mock import AsyncMock, patch

from app.discovery import DiscoverRequest, assemble_route, build_discover_routes, dinner_place, place_themes, preserves_choices
from app.models import CatalogPlace, Origin
from app.place_kinds import is_cafe
from app.travel_wishes import wish_coverage, wish_queries
from app import openpoi


def place(name, category="施設", **changes):
    return CatalogPlace(id=name, name=name, category=category, description="", region="京都府", address="京都府京都市",
                        latitude=35.001, longitude=135.7, **changes)


def request(**changes):
    return DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=Origin(name="駅", latitude=35, longitude=135.7),
                           cross_prefecture=False, **changes)


class CafeBreakTests(unittest.TestCase):
    def test_classifies_cafes_from_osm_tags_or_english_names_as_food_not_meals(self):
        for cafe in (place("L'orma attiva", tags={"amenity":"cafe"}), place("Blue Coffee"), place("Café repos"), place("小さな喫茶店")):
            self.assertTrue(is_cafe(cafe))
            self.assertEqual(place_themes(cafe), ["food"])
            self.assertFalse(dinner_place(cafe))
        self.assertTrue(dinner_place(place("Cafe Restaurant", "レストラン", tags={"amenity":"restaurant"})))

    def test_many_cafes_become_at_most_one_short_break_with_requested_lunch(self):
        cafes = tuple(place(f"店{i}", tags={"amenity":"cafe"}) for i in range(6))
        sights = tuple(place(f"博物館{i}", "博物館") for i in range(5))
        meal = place("地域の食堂", "飲食店")
        req = request(course="half_day", meals=[{"kind":"lunch", "time":"12:30"}], priority_text="カフェにも寄りたい")
        routes = build_discover_routes(req, (*cafes, *sights, meal))["routes"]
        self.assertTrue(routes)
        self.assertTrue(any(s["role"] == "break" for s in routes[0]["spots"]))
        for route in routes:
            breaks = [s for s in route["spots"] if s["role"] == "break"]
            self.assertLessEqual(len(breaks), 1)
            self.assertTrue(all(s["stay_minutes"] == 30 for s in breaks))
            self.assertEqual(sum(s["role"] == "lunch" for s in route["spots"]), 1)
            self.assertLessEqual(route["estimated_minutes"], 300)
        self.assertIsNone(assemble_route(req, [*cafes[:2], meal]))

    def test_no_meals_can_still_have_a_break_and_cafe_does_not_replace_dinner(self):
        cafe = place("店", tags={"amenity":"cafe"})
        museum = place("博物館", "博物館")
        route = assemble_route(request(meals=[], course="half_day"), [cafe, museum])
        self.assertEqual([s["role"] for s in route["spots"]], ["stop", "break"])
        self.assertEqual(route["spots"][1]["stay_minutes"], 30)
        self.assertIsNone(assemble_route(request(meals=[{"kind":"dinner"}]), [museum, cafe]))
        lunch = place("昼の食堂", "飲食店")
        route = assemble_route(request(meals=[{"kind":"lunch"}]), [cafe, lunch])
        self.assertEqual([s["role"] for s in route["spots"]], ["lunch", "break"])

    def test_covers_different_written_wishes_instead_of_repeating_one_kind(self):
        cafes = [place(f"喫茶{i}", "カフェ") for i in range(4)]
        garden = place("日本庭園", "庭園")
        museum = place("美術館", "美術館")
        req = request(course="half_day", meals=[], priority_text="庭園を歩いてカフェに寄りたい", traveler={"pace":"packed"})
        routes = build_discover_routes(req, tuple([*cafes, garden, museum]))["routes"]
        self.assertTrue(routes)
        ids = {s["place_id"] for s in routes[0]["spots"]}
        self.assertIn(garden.id, ids)
        self.assertEqual(sum(c.id in ids for c in cafes), 1)
        self.assertGreater(wish_coverage(req.priority_text, [garden, cafes[0]]), wish_coverage(req.priority_text, cafes))
        self.assertEqual(wish_queries("カフェには寄らない。庭園へ行きたい"), ["庭園"])
        self.assertFalse(preserves_choices(req, [garden], [garden, cafes[0]]))

    def test_relaxed_full_day_keeps_sights_and_two_meals_with_a_short_break(self):
        pool=(place("博物館", "博物館"),place("日本庭園", "庭園"),place("昼の食堂", "飲食店"),place("夜の食堂", "飲食店"),place("喫茶ひと休み", "カフェ"))
        req=request(course="full_day",meals=[{"kind":"lunch"},{"kind":"dinner"}],traveler={"pace":"relaxed"},priority_text="庭園とカフェに寄りたい")
        route=assemble_route(req,list(pool))
        self.assertIsNotNone(route)
        self.assertEqual(len(route["spots"]),5)
        self.assertEqual({s["role"] for s in route["spots"]},{"stop","lunch","dinner","break"})
        self.assertLessEqual(route["estimated_minutes"],720)


class WishSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_wish_changes_do_not_reuse_another_wish_catalog(self):
        openpoi._cache.clear()
        with patch.dict("os.environ", {"OPENPOI_ENABLED":"1"}), patch.object(openpoi, "_search", new=AsyncMock(return_value=())) as search:
            await openpoi.enrich_candidates(request(priority_text="庭園を見たい"), ())
            await openpoi.enrich_candidates(request(priority_text="美術館を見たい"), ())
            self.assertEqual(search.await_count, 2)

    async def test_wishes_add_parallel_queries_without_removing_general_candidates(self):
        queries=[]
        async def empty(client, url, params=None):
            if url == openpoi.SEARCH_URL:
                queries.append(params["q"])
            return {"results":[]}
        with patch.object(openpoi, "_json", new=empty):
            await openpoi._search(request(priority_text="庭園とカフェを巡りたい"))
        self.assertTrue({"庭園", "カフェ", ""} <= set(queries))
        self.assertEqual(len(queries), len(set(queries)))
