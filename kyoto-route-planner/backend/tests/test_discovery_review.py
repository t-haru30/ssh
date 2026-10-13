import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.discovery import DiscoverRequest, assemble_route
from app.models import CatalogPlace, Origin
from app.discovery_review import audit, review_journeys, record_decision


def place(i, category="博物館", name=None, region="岩手県", lat=39.703, lon=141.137):
    return CatalogPlace(id=str(i), name=name or f"施設{i}", category=category, region=region,
        address=region, description="", latitude=lat+i*.0001, longitude=lon)


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = patch("app.discovery_review.DB_PATH", Path(self.temp.name) / "reviews.sqlite3")
        self.db.start()
        self.req = DiscoverRequest(area="iwate", prefecture_name="岩手県", origin=Origin(name="盛岡駅", latitude=39.702, longitude=141.136), theme="food", course="full_day", cross_prefecture=False)
        self.pool = tuple([place(0, "飲食店", "普通の食堂")] + [place(i) for i in range(1, 7)])

    def tearDown(self):
        self.db.stop()
        self.temp.cleanup()

    async def test_morioka_search_repairs_without_replacing_original(self):
        original = assemble_route(self.req, list(self.pool[:5]))
        saved = deepcopy(original)
        noodle = place(8, "飲食店", "盛岡冷麺の店")
        search = AsyncMock(return_value=((*self.pool, noodle), "ready"))
        with patch("app.openpoi.enrich_candidates", search):
            review = await review_journeys(self.req, {"routes":[original]}, self.pool)
        self.assertEqual(original, saved)
        self.assertEqual(search.await_count, 1)
        self.assertEqual(search.call_args.kwargs["query"], "盛岡冷麺")
        self.assertEqual(review["status"], "proposal")
        proposal = review["proposals"][0]["route"]
        self.assertIn(noodle.id, [s["place_id"] for s in proposal["spots"]])
        self.assertEqual(audit(self.req, proposal, (*self.pool, noodle)), [])
        self.assertTrue(record_decision(review["id"], "adopt:" + proposal["id"]))
        self.assertTrue(record_decision(review["id"], "keep"))
        self.assertFalse(record_decision(review["id"], "adopt:unknown"))

    async def test_kanazawa_two_restaurants_are_rebuilt_without_search(self):
        req = self.req.model_copy(update={"area":"ishikawa", "prefecture_name":"石川県", "theme":"all", "origin":Origin(name="金沢駅",latitude=36.578,longitude=136.648)})
        pool = tuple(place(i, "飲食店" if i < 2 else "博物館", region="石川県",lat=36.579,lon=136.648) for i in range(7))
        short = assemble_route(req.model_copy(update={"course":"all"}), list(pool[:2]))
        with patch("app.openpoi.enrich_candidates", new=AsyncMock()) as search:
            review = await review_journeys(req, {"routes":[short]}, pool)
        search.assert_not_awaited()
        self.assertEqual(review["status"], "proposal")
        self.assertGreaterEqual(review["proposals"][0]["route"]["estimated_minutes"], 360)

    async def test_gifu_rejects_nagoya_even_when_it_is_inside_radius(self):
        req = self.req.model_copy(update={"area":"gifu", "prefecture_name":"岐阜県", "theme":"all", "course":"all", "origin":Origin(name="岐阜駅",latitude=35.41,longitude=136.757)})
        local = [place(i, region="岐阜県",lat=35.42,lon=136.757) for i in range(4)]
        wrong = place(9, region="愛知県",lat=35.18,lon=136.88)
        original = assemble_route(req, [wrong])
        self.assertIn("region", audit(req, original, (*local, wrong)))
        with patch("app.openpoi.enrich_candidates", new=AsyncMock()) as search:
            review = await review_journeys(req, {"routes":[original]}, (*local, wrong))
        search.assert_not_awaited()
        self.assertEqual(review["status"], "proposal")
        self.assertNotIn(wrong.id, [s["place_id"] for s in review["proposals"][0]["route"]["spots"]])

    async def test_timeout_stops_once_and_keeps_unresolved(self):
        with patch("app.openpoi.enrich_candidates", new=AsyncMock(side_effect=TimeoutError)) as search:
            review = await review_journeys(self.req, {"routes":[]}, ())
        self.assertEqual(search.await_count, 1)
        self.assertEqual(review["status"], "unresolved")
        self.assertEqual(review["proposals"], [])

    async def test_valid_route_does_not_search_and_logging_failure_is_nonfatal(self):
        noodle = place(8, "飲食店", "盛岡冷麺の店")
        route = assemble_route(self.req, [noodle, *self.pool[1:5]])
        with patch("app.openpoi.enrich_candidates", new=AsyncMock()) as search, patch("app.discovery_review.record", return_value=False):
            review = await review_journeys(self.req, {"routes":[route]}, (*self.pool,noodle))
        search.assert_not_awaited()
        self.assertEqual(review["status"], "passed")
        self.assertFalse(review["recorded"])
