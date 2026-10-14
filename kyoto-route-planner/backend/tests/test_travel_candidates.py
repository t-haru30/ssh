import unittest
from unittest.mock import AsyncMock, patch

from app.models import Origin
from app.travel_candidates import TravelCandidatesRequest, extra_stations, google_candidates, parse_place, suggest_travel_candidates
from app.station_search import StationCandidate
from app.travel_wishes import wish_score
from app.discovery import DiscoverRequest, assemble_route, build_discover_routes, discover_routes, eligible_candidates
from app.models import CatalogPlace


ORIGIN = Origin(name="岐阜駅", latitude=35.4097, longitude=136.7564)


def row(name="岐阜", kind="station", lat=35.4097, lon=136.7564):
    return {"type": "node", "id": 1, "lat": lat, "lon": lon,
            "tags": {"name": name, "railway": "station"} if kind == "station" else {"name": name, "tourism": "hotel"}}


class TravelCandidateTests(unittest.IsolatedAsyncioTestCase):
    async def test_ai_omission_does_not_erase_a_feasible_written_wish(self):
        def place(i, name, category):
            return CatalogPlace(id=f"w{i}", name=name, category=category, region="岐阜県", address="", latitude=35.41,
                                longitude=136.7564, description="", tags={})
        museum, cafe = place(1,"歴史博物館","博物館"), place(2,"庭の喫茶店","カフェ")
        request = DiscoverRequest(area="gifu", prefecture_name="岐阜県", origin=ORIGIN, theme="history", course="half_day", meals=[], priority_text="カフェでコーヒーを飲みたい")
        fallback = {**build_discover_routes(request,(museum,cafe)), "catalog":{}}
        omitted = {**fallback, "routes":[assemble_route(request,[museum])]}
        with patch("app.discovery._discover_catalog", new=AsyncMock(return_value=(fallback,(museum,cafe)))), \
             patch("app.discovery_agent.recommend_routes", new=AsyncMock(return_value=omitted)), \
             patch("app.discovery_review.record", return_value=False):
            result = await discover_routes(request)
        self.assertIn(cafe.id, [s["place_id"] for s in result["routes"][0]["spots"]])

    async def test_places_can_add_a_station_resolved_independently_by_ekispert(self):
        station = StationCandidate(name="名鉄岐阜駅", code="123", prefecture="岐阜県", latitude=35.411, longitude=136.762)
        google = {"id": "not-saved", "displayName": {"text": station.name}, "location": {"latitude": 35.4111, "longitude": 136.7621}}
        with patch("app.travel_candidates.search_stations", new=AsyncMock(return_value=[station])):
            result = await extra_stations([google], [], ORIGIN, "gifu", 12)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].latitude, station.latitude)
        self.assertEqual(result[0].tags["source"], "駅すぱあと")
        self.assertNotIn("not-saved", str(result[0].model_dump()))

    def test_station_and_hotel_candidates_stay_inside_selected_prefecture(self):
        self.assertIsNotNone(parse_place(row(), ORIGIN, "gifu", "station", 12))
        self.assertIsNone(parse_place(row("名古屋", lat=35.1709, lon=136.8815), ORIGIN, "gifu", "station", 100))
        self.assertIsNotNone(parse_place(row("地域のホテル", "lodging"), ORIGIN, "gifu", "lodging", 5))
        self.assertIsNone(parse_place(row("カフェ"), ORIGIN, "gifu", "lodging", 5))

    async def test_places_matches_rank_independent_station_records_without_copying_content(self):
        near = parse_place(row("岐阜"), ORIGIN, "gifu", "station", 12)
        other = parse_place({**row("加納", lat=35.408), "id": 2}, ORIGIN, "gifu", "station", 12)
        google = {"id": "google-only", "displayName": {"text": "加納駅"},
                  "location": {"latitude": other.latitude, "longitude": other.longitude}, "businessStatus": "OPERATIONAL", "editorialSummary": "GOOGLE_ONLY"}
        with patch("app.travel_candidates.osm_candidates", new=AsyncMock(return_value=[near, other])), patch("app.travel_candidates.google_candidates", new=AsyncMock(return_value=[google])):
            result = await suggest_travel_candidates(TravelCandidatesRequest(origin=ORIGIN, area="gifu"), "station")
        self.assertEqual(result["places"][0]["name"], "加納")
        self.assertEqual(result["places"][0]["id"], other.id)
        self.assertNotIn("google-only", str(result))
        self.assertNotIn("GOOGLE_ONLY", str(result))

    async def test_closed_lodging_is_excluded_and_original_records_are_unchanged(self):
        hotel = parse_place(row("地域のホテル", "lodging"), ORIGIN, "gifu", "lodging", 5)
        before = hotel.model_dump()
        closed = {"id": "google", "displayName": {"text": hotel.name}, "location": {"latitude": hotel.latitude, "longitude": hotel.longitude}, "businessStatus": "CLOSED_PERMANENTLY"}
        with patch("app.travel_candidates.osm_candidates", new=AsyncMock(return_value=[hotel])), patch("app.travel_candidates.google_candidates", new=AsyncMock(return_value=[closed])):
            result = await suggest_travel_candidates(TravelCandidatesRequest(origin=ORIGIN, area="gifu"), "lodging")
        self.assertEqual(result["places"], [])
        self.assertEqual(hotel.model_dump(), before)

    async def test_existing_google_budget_is_respected(self):
        client = AsyncMock()
        with patch("app.travel_candidates.google_api_key", return_value="test"), patch("app.travel_candidates.reserve_lookup", return_value=False):
            self.assertEqual(await google_candidates(client, ORIGIN, "station", 12), [])
        client.post.assert_not_awaited()


class WrittenWishTests(unittest.TestCase):
    def test_written_cafe_wish_survives_category_filter_and_is_first_without_bypassing_radius(self):
        origin = Origin(name="京都駅", latitude=34.98585, longitude=135.75877)
        def place(i, name, category, lat=34.99):
            return CatalogPlace(id=f"p{i}", name=name, category=category, region="京都府", address="", latitude=lat,
                                longitude=135.76, description="", tags={})
        museum, cafe, outside = place(1, "歴史博物館", "博物館"), place(2, "庭の喫茶店", "カフェ"), place(3, "遠くのカフェ", "カフェ", lat=36)
        request = DiscoverRequest(area="kyoto", prefecture_name="京都府", origin=origin, theme="history", course="half_day", meals=[],
                                  priority_text="カフェでコーヒーを飲みたい", radius_km=10, cross_prefecture=False)
        self.assertEqual({p.id for p in eligible_candidates(request, (museum, cafe, outside))}, {museum.id, cafe.id})
        routes = build_discover_routes(request, (museum, cafe, outside))["routes"]
        self.assertTrue(routes)
        self.assertIn(cafe.id, [s["place_id"] for s in routes[0]["spots"]])
        self.assertEqual(wish_score("カフェには行きたくない", cafe), 0)
