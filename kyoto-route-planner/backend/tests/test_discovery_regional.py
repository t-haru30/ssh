import unittest
from app.discovery import DiscoverRequest, build_discover_routes, assemble_route, eligible_candidates
from app.models import CatalogPlace, Origin

class RegionalTests(unittest.TestCase):
    def place(self, i, name, category="博物館", region="岩手県", lat=39.703, lon=141.137):
        return CatalogPlace(id=str(i), name=name, category=category, region=region, latitude=lat, longitude=lon, address=region, description="")

    def test_food_day_includes_local_specialty_and_sightseeing(self):
        req = DiscoverRequest(area="iwate", prefecture_name="岩手県", origin=Origin(name="盛岡駅", latitude=39.702, longitude=141.136), theme="food", course="full_day")
        pool = tuple([self.place(0, "普通のレストラン", "レストラン"), self.place(1, "盛岡冷麺の店", "飲食店", lat=39.72)] + [self.place(i, f"博物館{i}", lat=39.703+i*.001) for i in range(2, 8)])
        routes = build_discover_routes(req, pool)["routes"]
        self.assertTrue(routes)
        for route in routes:
            self.assertIn("1", [p["place_id"] for p in route["spots"]])
            self.assertGreaterEqual(len(route["spots"]), 4)
            self.assertGreaterEqual(route["estimated_minutes"], 360)
            self.assertLessEqual(route["estimated_minutes"], 600)
            self.assertLessEqual(sum(p["category"] in ("飲食店", "レストラン") for p in route["spots"]), 2)
        self.assertIsNone(assemble_route(req, list(pool[:2])))

    def test_gifu_does_not_default_to_nagoya_with_enough_local_places(self):
        req = DiscoverRequest(area="gifu", prefecture_name="岐阜県", origin=Origin(name="岐阜（岐阜県）", latitude=35.41, longitude=136.757))
        local = [self.place(i, f"岐阜の博物館{i}", region="岐阜県", lat=35.42+i*.001, lon=136.757) for i in range(6)]
        other = self.place(9, "名古屋の施設", region="愛知県", lat=35.182, lon=136.882)
        self.assertNotIn(other, eligible_candidates(req, tuple([other, *local])))
