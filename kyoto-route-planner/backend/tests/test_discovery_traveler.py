"""Traveler preferences stay soft; geography and duration remain enforced."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from app import discovery_agent as agent
from app.discovery import DiscoverRequest, assemble_route, build_discover_routes, max_stops, stay_minutes
from app.models import CatalogPlace, Origin


def request(**kwargs):
    return DiscoverRequest(area="kyoto", prefecture_name="京都府",
        origin=Origin(name="駅", latitude=35, longitude=135.7), count=1, **kwargs)


def place(identifier, category, latitude=35.001, region="京都府"):
    return CatalogPlace(id=identifier, name=category + identifier, category=category,
        region=region, address=region, description="", latitude=latitude, longitude=135.7)


class TravelerTests(unittest.TestCase):
    def test_lunch_venues_vary_without_inserting_extra_meals(self):
        pool = [place(f"museum-{i}","博物館",35 + i * .001) for i in range(5)] + [place(f"restaurant-{i}","飲食店",35.002 + i * .001) for i in range(3)]
        options = request(theme="food", course="half_day", meals=[{"kind":"lunch"}]).model_copy(update={"count":8})
        routes = build_discover_routes(options,tuple(pool))["routes"]
        self.assertGreaterEqual(len({s["place_id"] for r in routes for s in r["spots"] if s["role"] == "lunch"}),3)
        for route in routes:
            self.assertEqual(sum(s["role"] == "lunch" for s in route["spots"]),1)

    def test_optional_and_validated(self):
        self.assertIsNone(request().traveler)
        self.assertEqual(request(traveler={}).traveler.gender, "unspecified")
        for field in ("age_group", "gender", "companion", "pace"):
            with self.assertRaises(ValidationError):
                request(traveler={field: "invalid"})

    def test_companion_preferences_and_gender_neutrality(self):
        pool = (place("temple", "寺"), place("park", "公園", 35.002),
                place("cafe", "カフェ", 35.003), place("museum", "博物館", 35.004))
        family = build_discover_routes(request(traveler={"companion": "family"}), pool)["routes"][0]
        couple = build_discover_routes(request(traveler={"companion": "couple"}), pool)["routes"][0]
        self.assertEqual(family["spots"][0]["place_id"], "park")
        self.assertIn("cafe", [s["place_id"] for s in couple["spots"]])
        self.assertNotEqual(couple["spots"][0]["place_id"], "cafe")
        self.assertEqual(next(s["stay_minutes"] for s in couple["spots"] if s["place_id"] == "cafe"), 30)
        female = build_discover_routes(request(traveler={"gender": "female"}), pool)
        male = build_discover_routes(request(traveler={"gender": "male"}), pool)
        self.assertEqual(female, male)

    def test_explicit_pacing_and_hard_filters(self):
        pool = (place("one", "寺"), place("two", "寺", 35.002), place("three", "寺", 35.003),
                place("far", "公園", 36), place("outside", "公園", region="大阪府"))
        req = request(theme="temple", radius_km=5, cross_prefecture=False,
                      course="half_day", traveler={"age_group": "65_plus", "companion": "family", "pace": "relaxed"})
        route = build_discover_routes(req, pool)["routes"][0]
        self.assertEqual(len(route["spots"]), 2)
        self.assertTrue(all(s["stay_minutes"] == 75 for s in route["spots"]))
        self.assertLessEqual(route["estimated_minutes"], 300)
        self.assertTrue(all(s["place_id"] in ("one", "two", "three") for s in route["spots"]))
        self.assertIsNone(assemble_route(req, list(pool[:3])))

    def test_pace_controls_counts_and_stays_independently_of_demographics(self):
        pool = tuple(place(str(i), "公園", 35.001 + i * .001) for i in range(6))
        for pace, count, half_stay, full_stay in (("relaxed", 2, 75, 120), ("standard", 3, 60, 105), ("packed", 4, 45, 75)):
            for course, stay in (("all", half_stay), ("half_day", half_stay), ("full_day", full_stay)):
                req = request(course=course, traveler={"pace": pace, "age_group": "65_plus", "companion": "family"})
                self.assertEqual(max_stops(req), count + (2 if course == "full_day" else 0))
                self.assertEqual(stay_minutes(req), stay)
                route = build_discover_routes(req, (*pool[:-1], place("dinner", "レストラン"), place("extra", "公園")) if course == "full_day" else pool)["routes"][0]
                self.assertEqual(len(route["spots"]), count + (2 if course == "full_day" else 0))
                self.assertIn(f"観光は各{stay}分", route["recommendation_reason"])
                self.assertIn("公園", route["recommendation_reason"])
                self.assertIn("家族", route["recommendation_reason"])
        self.assertEqual(max_stops(request(traveler={"age_group": "under_18", "companion": "family"})), 3)
        self.assertEqual(stay_minutes(request()), 60)

    def test_agent_selection_allows_four_only_for_packed(self):
        pool = [place(str(i), "公園", 35.001 + i * .001) for i in range(4)]
        inspected = {p.id: p for p in pool}
        facts = {p.id: {"category": p.category} for p in pool}
        args = {"routes": [{"places": [{"id": p.id, "name": p.name, "latitude": p.latitude,
            "longitude": p.longitude, "fact_ids": ["category"], "fit": "distance"} for p in pool]}]}
        route = agent._select(args, inspected, facts, request(traveler={"pace": "packed"}))[0]
        self.assertEqual(len(route["spots"]), 4)
        self.assertIn("たくさん巡る", route["recommendation_reason"])
        official_facts = {p.id: {"category": p.category, "official_highlight_1": f"{p.name}の庭園を見渡せます。"} for p in pool}
        sources = {p.id: {"official_highlight_1": "https://example.com/" + p.id} for p in pool}
        grounded = agent._select(args, inspected, official_facts, request(traveler={"pace": "packed"}), sources)[0]
        self.assertTrue(grounded["recommendation_reason"].startswith(pool[0].name + "："))
        self.assertIn("たくさん巡る", grounded["recommendation_reason"])
        self.assertEqual(len(grounded["reason_sources"]), len(pool))
        self.assertTrue(all(spot["reason_sources"] and "庭園" in spot["reason"] for spot in grounded["spots"]))
        for pace in ("standard", "relaxed"):
            with self.assertRaises(ValueError):
                agent._select(args, inspected, facts, request(traveler={"pace": pace}))


class TravelerAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_traveler_separates_cache_and_reaches_ai_context(self):
        pool = [place("one", "公園")]
        agent._cache.clear()
        agent._calls.clear()
        agent._flights.clear()
        agent._lock = asyncio.Lock()
        run = AsyncMock(return_value={"routes": [], "agent": {"status": "ready"}})
        with patch.object(agent, "gemini_api_key", return_value="test"), \
             patch.object(agent, "setting", side_effect=lambda name, default="": default), \
             patch.object(agent, "_run", run):
            for traveler in ({"companion": "family"}, {"companion": "solo"}, {"companion": "family"}):
                req = request(traveler=traveler)
                await agent.recommend_routes(req, pool, build_discover_routes(req, tuple(pool)))
        self.assertEqual(run.await_count, 2)
        req = request(traveler={"age_group": "under_18", "companion": "family", "gender": "other", "pace": "relaxed"})
        call = AsyncMock(side_effect=ValueError("stop after capturing input"))
        with patch.object(agent, "_call", call):
            with self.assertRaises(ValueError):
                await agent._run(req, pool, "test", agent.DEFAULT_MODEL)
        constraints = json.loads(call.await_args.args[3][0]["parts"][0]["text"].split("\n", 1)[0])
        self.assertEqual(constraints["request"]["traveler"], req.traveler.model_dump())
        self.assertEqual(constraints["max_stops"], 2)
        self.assertEqual(constraints["stay_minutes"], 75)


if __name__ == "__main__":
    unittest.main()
