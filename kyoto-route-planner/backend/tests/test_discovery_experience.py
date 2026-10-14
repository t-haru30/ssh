import unittest
from app.discovery import DiscoverRequest, assemble_route, build_discover_routes, eligible_candidates, place_themes
from app.models import CatalogPlace, Origin


class ExperienceTests(unittest.TestCase):
    def setUp(self):
        self.origin = Origin(name="駅", latitude=35, longitude=135)
        self.pool = tuple(CatalogPlace(id=str(i), name=name, category=category,
            region="京都府", address="京都府", description="", latitude=35 + i * .001, longitude=135)
            for i, (name, category) in enumerate([
                ("庭園", "公園"), ("川の公園", "公園"), ("森の公園", "公園"),
                ("資料館", "博物館"), ("地域料理の店", "レストラン"), ("食堂", "飲食店")]))

    def request(self, **kwargs):
        return DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=self.origin, **kwargs)

    def test_multiple_themes_cover_nature_and_food_without_unrelated_museum(self):
        req = self.request(themes=["nature", "food"], course="half_day")
        candidates = eligible_candidates(req, self.pool)
        self.assertNotIn("3", [p.id for p in candidates])
        routes = build_discover_routes(req, self.pool)["routes"]
        self.assertTrue(routes)
        for route in routes:
            represented = {t for s in route["spots"] for t in place_themes(self.pool[int(s["place_id"])])}
            self.assertTrue({"nature", "food"} <= represented)

    def test_evening_meal_is_last_and_wait_does_not_inflate_stay(self):
        req = self.request(course="full_day")
        route = assemble_route(req, [self.pool[4], *self.pool[:3]])
        self.assertIsNotNone(route)
        self.assertEqual(route["spots"][-1]["role"], "dinner")
        self.assertEqual(route["spots"][-1]["stay_minutes"], 75)
        self.assertGreaterEqual(route["estimated_minutes"], 615)
        self.assertLessEqual(route["estimated_minutes"], 720)
        self.assertEqual([p.id for p in self.pool[:3]], [s["place_id"] for s in route["spots"][:-1]])

    def test_missing_dinner_never_becomes_fake_meal(self):
        result = build_discover_routes(self.request(course="full_day"), self.pool[:4])
        self.assertEqual(result["routes"], [])
        self.assertIn("食事", result["note"])

    def test_half_day_does_not_wait_until_evening(self):
        route = assemble_route(self.request(course="half_day"), [self.pool[0], self.pool[4]])
        self.assertLessEqual(route["estimated_minutes"], 300)
        self.assertNotIn("dinner", [s["role"] for s in route["spots"]])

    def test_requested_lunch_time_and_explicit_no_meals(self):
        req = self.request(course="half_day", meals=[{"kind": "lunch", "time": "13:00"}])
        routes = build_discover_routes(req, self.pool)["routes"]
        self.assertTrue(routes)
        for route in routes:
            meals = [s for s in route["spots"] if s["role"] != "stop"]
            self.assertEqual([(s["role"], s["meal_time"]) for s in meals], [("lunch", "13:00")])
            self.assertLessEqual(route["estimated_minutes"], 300)
        no_meals = build_discover_routes(self.request(course="full_day", meals=[]), self.pool)["routes"]
        self.assertTrue(no_meals)
        self.assertTrue(all(s["role"] == "stop" and s["category"] not in ("飲食店", "レストラン") for r in no_meals for s in r["spots"]))

    def test_three_meals_and_impossible_half_day(self):
        meal = self.pool[4].model_copy(update={"id": "third", "name": "別の食堂"})
        pool = (*self.pool, meal)
        selected = [{"kind": "breakfast"}, {"kind": "lunch"}, {"kind": "dinner", "time": "18:30"}]
        routes = build_discover_routes(self.request(course="full_day", meals=selected), pool)["routes"]
        self.assertTrue(routes)
        for r in routes:
            self.assertEqual([s["role"] for s in r["spots"] if s["role"] != "stop"], ["breakfast", "lunch", "dinner"])
            self.assertEqual(next(s["meal_time"] for s in r["spots"] if s["role"] == "dinner"), "18:30")
            self.assertLessEqual(r["estimated_minutes"], 720)
        self.assertEqual(build_discover_routes(self.request(course="half_day", meals=selected), pool)["routes"], [])

    def test_nearby_search_does_not_discard_the_second_requested_restaurant(self):
        sights = tuple(self.pool[0].model_copy(update={"id": f"sight-{i}", "name": f"公園{i}", "latitude": 35 + i * .002}) for i in range(8))
        restaurants = (self.pool[4], self.pool[5].model_copy(update={"latitude": 35.055}))
        request = self.request(theme="food", course="full_day", meals=[{"kind": "lunch"}, {"kind": "dinner"}], traveler={"pace": "relaxed"})
        routes = build_discover_routes(request, (*sights, *restaurants))["routes"]
        self.assertTrue(routes)
        for route in routes:
            self.assertEqual([s["role"] for s in route["spots"] if s["role"] != "stop"], ["lunch", "dinner"])
            self.assertIn(restaurants[1].id, [s["place_id"] for s in route["spots"]])
