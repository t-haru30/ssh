import unittest
import asyncio
import tempfile
from unittest.mock import AsyncMock, call, patch
from pathlib import Path

from fastapi.testclient import TestClient
from fastapi import HTTPException

from app.ekispert import _make_url, _parse_legs, _redact_access_key
from app.main import (
    ROUTE_GENRE_CODES,
    _build_route_timeline,
    _route_candidates,
    app,
    limiter,
)
from app.copywriting import RouteCopywriting
from app.models import (
    CatalogPlace,
    ParsedPlaceQuery,
    Place,
    PlaceSearchHit,
    PlaceSearchResponse,
    RouteLeg,
)
from app.places import calculate_place_score, choose_place_sets, choose_places, list_origins


def sample_places() -> list[Place]:
    return [
        Place(
            id="yahoo-1-1",
            name="京都自然公園",
            category="park",
            description="",
            access_point="座標から経路検索",
            latitude=35.01,
            longitude=135.76,
            themes=["nature"],
        ),
        Place(
            id="yahoo-1-2",
            name="京都寺院",
            category="place_of_worship",
            description="",
            access_point="座標から経路検索",
            latitude=35.02,
            longitude=135.77,
            themes=["history", "temple"],
        ),
        Place(
            id="yahoo-1-3",
            name="京都の市場",
            category="marketplace",
            description="",
            access_point="座標から経路検索",
            latitude=35.03,
            longitude=135.78,
            themes=["food"],
        ),
    ]


class RoutePlannerTests(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        self.search_places_patch = patch(
            "app.main.search_yahoo_catalog",
            new=AsyncMock(return_value=PlaceSearchResponse(
                query=ParsedPlaceQuery(),
                results=[],
                note="",
            )),
        )
        self.search_places_patch.start()

    def tearDown(self):
        self.search_places_patch.stop()

    def test_route_generation_uses_yahoo_places(self):
        client = TestClient(app)
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-shrine-1",
                        name="伏見稲荷大社",
                        category="神社",
                        region="京都府",
                        address="京都市伏見区",
                        latitude=34.9671,
                        longitude=135.7727,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        route_search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))
        with (
            patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=yahoo_response)) as poi_search,
            patch("app.main.search_route", route_search),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "京都駅",
                    "theme": "temple",
                    "stop_count": 1,
                    "departure_date": "2026-10-09",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["routes"][0]["places"][0]["id"], "yahoo-shrine-1")
        self.assertIn("Yahoo", response.json()["routes"][0]["note"])
        timeline = response.json()["routes"][0]["timeline"]
        self.assertEqual(
            [item["type"] for item in timeline],
            ["spot", "transit", "spot", "transit", "spot"],
        )
        self.assertEqual(timeline[2]["stay_minutes"], 90)
        self.assertEqual(timeline[-1]["role"], "finish")
        self.assertEqual(
            poi_search.await_args_list,
            [
                call("京都", limit=100, genre_codes=("0424001", "0424002")),
                call("清水寺", limit=100, genre_codes=("0424001",)),
                call("平安神宮", limit=100, genre_codes=("0424002",)),
            ],
        )

    def test_route_search_uses_location_query_and_yahoo_genre_filter(self):
        base_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-local-temple",
                        name="地域の寺院",
                        category="寺院",
                        region="京都府",
                        address="京都市東山区",
                        latitude=34.986,
                        longitude=135.759,
                        description="",
                        genre_code="0424001",
                    ),
                    score=80.0,
                )
            ],
            note="",
        )
        landmark_responses = [
            PlaceSearchResponse(
                query=ParsedPlaceQuery(region="京都府"),
                results=[
                    PlaceSearchHit(
                        place=CatalogPlace(
                            id=f"yahoo-{name}",
                            name=name,
                            category=category,
                            region="京都府",
                            address="京都市",
                            latitude=latitude,
                            longitude=longitude,
                            description="",
                            genre_code=genre_code,
                        ),
                        score=80.0,
                    )
                ],
                note="",
            )
            for name, category, latitude, longitude, genre_code in (
                ("清水寺", "寺院", 34.9949, 135.785, "0424001"),
                ("平安神宮", "神社", 35.0154, 135.7833, "0424002"),
            )
        ]
        search = AsyncMock(side_effect=[base_response, *landmark_responses])

        with patch("app.main.search_yahoo_catalog", search):
            candidates, _ = asyncio.run(_route_candidates("history"))

        self.assertEqual(
            {candidate.name for candidate in candidates},
            {"地域の寺院", "清水寺", "平安神宮"},
        )
        self.assertEqual(
            search.await_args_list,
            [
                call("京都", limit=100, genre_codes=ROUTE_GENRE_CODES["history"]),
                call("清水寺", limit=100, genre_codes=("0424001",)),
                call("平安神宮", limit=100, genre_codes=("0424002",)),
            ],
        )

    def test_route_search_reports_empty_yahoo_results_without_substitute_places(self):
        client = TestClient(app)
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[],
            note="Yahoo!ローカルサーチで該当する候補が見つかりませんでした。",
        )
        with patch(
            "app.main.search_yahoo_catalog",
            new=AsyncMock(return_value=yahoo_response),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "京都駅",
                    "theme": "temple",
                    "stop_count": 1,
                    "departure_date": "2026-10-09",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 404)
        self.assertIn("Yahoo", response.json()["detail"])

    def test_all_theme_accepts_yahoo_places_without_a_recognized_category(self):
        client = TestClient(app)
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-viewpoint-1",
                        name="京都展望スポット",
                        category="観光スポット",
                        region="京都府",
                        address="京都市",
                        latitude=34.99,
                        longitude=135.76,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        route_search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="展望地",
                line_name="市バス",
                mode="bus",
                duration_minutes=10,
            )],
            20,
            "09:00",
            "09:20",
        ))
        poi_search = AsyncMock(return_value=yahoo_response)
        with (
            patch("app.main.search_yahoo_catalog", new=poi_search),
            patch("app.main.search_route", route_search),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "京都駅",
                    "theme": "all",
                    "stop_count": 1,
                    "departure_date": "2026-10-09",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["routes"][0]["places"][0]["id"], "yahoo-viewpoint-1")
        self.assertEqual(
            poi_search.await_args_list[0],
            call(
                "京都",
                limit=100,
                genre_codes=(
                    "0424001",
                    "0424002",
                    "0305002",
                    "0305003",
                    "0305007",
                    "0303002",
                    "0303003",
                    "0303004",
                ),
            ),
        )

    def test_yahoo_route_uses_partial_yahoo_results_when_too_few_stops_are_found(self):
        client = TestClient(app)
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-shrine-1",
                        name="伏見稲荷大社",
                        category="神社",
                        region="京都府",
                        address="京都市伏見区",
                        latitude=34.9671,
                        longitude=135.7727,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        route_search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))
        with (
            patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=yahoo_response)),
            patch("app.main.search_route", route_search),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "京都駅",
                    "theme": "temple",
                    "stop_count": 3,
                    "departure_date": "2026-10-09",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"][0]["places"]), 1)
        self.assertIn("Yahoo", response.json()["routes"][0]["note"])

    def test_health_origins_and_place_status_are_available(self):
        client = TestClient(app)

        self.assertEqual(
            client.get("/api/health").json(),
            {"status": "ok", "route_timeline_version": "1"},
        )
        self.assertEqual(
            [origin["name"] for origin in client.get("/api/origins").json()],
            ["京都駅"],
        )
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-1",
                        name="京都自然公園",
                        category="公園",
                        region="京都府",
                        address="京都市",
                        latitude=35.01,
                        longitude=135.76,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        with patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=yahoo_response)):
            places_response = client.get("/api/places")
            self.assertEqual(places_response.status_code, 200)
            self.assertEqual(places_response.json()[0]["id"], "yahoo-1")
        self.assertEqual(
            client.get("/api/places/status").json()["source"],
            "Yahoo! Local Search",
        )

    def test_natural_language_search_endpoint_uses_priority_search(self):
        client = TestClient(app)
        result = PlaceSearchResponse(
            query=ParsedPlaceQuery(region="京都府"),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="yahoo-1-123",
                        name="京都の神社",
                        category="place_of_worship",
                        region="京都府",
                        address="",
                        latitude=35.0,
                        longitude=135.7,
                        description="",
                    ),
                    score=1.0,
                )
            ],
            note="Yahoo!ローカルサーチ",
        )
        search = AsyncMock(return_value=result)
        with patch("app.main.search_yahoo_catalog", search):
            response = client.post(
                "/api/search/places",
                json={"query": "京都の神社"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"][0]["place"]["id"], "yahoo-1-123")
        search.assert_awaited_once_with("京都の神社")

    def test_itinerary_uses_selected_theme_and_stop_limit(self):
        places = choose_places("nature", 1, "京都駅", sample_places())

        self.assertEqual(len(places), 1)
        self.assertTrue(all("nature" in place.themes for place in places))

    def test_route_timeline_interleaves_spots_and_transit_with_stay_times(self):
        places = sample_places()[:2]
        timeline = _build_route_timeline(
            list_origins()[0],
            places,
            "09:00",
            50,
        )

        self.assertEqual(
            [item.type for item in timeline],
            ["spot", "transit", "spot", "transit", "spot", "transit", "spot"],
        )
        transit = [item for item in timeline if item.type == "transit"]
        self.assertEqual(sum(item.duration_minutes or 0 for item in transit), 50)
        stops = [item for item in timeline if item.type == "spot" and item.role == "stop"]
        self.assertEqual([item.stay_minutes for item in stops], [90, 90])
        self.assertEqual(timeline[0].time, "09:00")
        self.assertEqual(timeline[-1].time, "12:50")

    def test_route_timeline_omits_arrival_times_when_total_is_unknown(self):
        timeline = _build_route_timeline(
            list_origins()[0],
            sample_places()[:1],
            "09:00",
            None,
        )

        self.assertIsNone(timeline[1].duration_minutes)
        self.assertIsNone(timeline[2].time)
        self.assertIsNone(timeline[-1].time)

    def test_yahoo_score_prioritizes_relevant_complete_place_records(self):
        popular = sample_places()[0].model_copy(update={
            "category": "文化財",
            "description": "歴史ある寺院",
            "address": "京都市東山区",
            "themes": ["history", "nature"],
        })
        ordinary = sample_places()[1]

        self.assertGreater(
            calculate_place_score(popular, "history"),
            calculate_place_score(ordinary, "history"),
        )
        self.assertEqual(
            choose_places("nature", 1, "京都駅", [ordinary, popular])[0].id,
            popular.id,
        )

    def test_yahoo_score_uses_category_and_description_completeness(self):
        restaurant = sample_places()[2].model_copy(update={
            "category": "レストラン",
            "description": "地元の料理を提供",
            "address": "京都市",
        })
        lodging = sample_places()[0].model_copy(update={
            "category": "ホテル",
        })

        self.assertGreater(calculate_place_score(restaurant, "food"), 0)
        self.assertGreater(calculate_place_score(lodging, "all"), 0)

    def test_well_known_yahoo_landmarks_rank_above_ordinary_sites(self):
        famous = Place(
            id="yahoo-kiyomizu",
            name="清水寺",
            category="寺院",
            description="",
            access_point="",
            latitude=34.9949,
            longitude=135.785,
            themes=["history", "temple"],
            tags={"yahoo_genre_code": "0424001"},
        )
        ordinary = Place(
            id="yahoo-local-temple",
            name="地域の寺院",
            category="寺院",
            description="",
            access_point="",
            latitude=34.986,
            longitude=135.759,
            themes=["history", "temple"],
            tags={"yahoo_genre_code": "0424001"},
        )

        self.assertGreater(
            calculate_place_score(famous, "temple"),
            calculate_place_score(ordinary, "temple"),
        )
        with tempfile.TemporaryDirectory() as directory:
            selected = choose_places(
                "temple",
                1,
                "京都駅",
                [ordinary, famous],
                database=Path(directory) / "scores.sqlite3",
            )
        self.assertEqual(selected[0].id, "yahoo-kiyomizu")

    def test_unknown_origin_is_rejected(self):
        with self.assertRaises(ValueError):
            choose_places("all", 2, "知らない駅", sample_places())

    def test_equivalent_origin_names_are_treated_as_the_same_station(self):
        selected = choose_places("all", 2, "京都", sample_places())
        self.assertEqual(len(selected), 2)

    def test_access_points_use_ekispert_station_names_not_bus_stop_names(self):
        selected = choose_places("all", 3, "京都駅", sample_places())
        self.assertTrue(all(place.access_point == "座標から経路検索" for place in selected))

    def test_route_search_url_keeps_via_delimiters_unescaped(self):
        url = _make_url({"key": "safe-test-key", "viaList": "京都:稲荷:京都"})

        self.assertIn("viaList=%E4%BA%AC%E9%83%BD:%E7%A8%B2%E8%8D%B7:%E4%BA%AC%E9%83%BD", url)

    def test_ekispert_access_key_is_redacted_from_loggable_url(self):
        url = _make_url({"key": "secret-test-key", "viaList": "京都:稲荷:京都"})

        self.assertNotIn("secret-test-key", _redact_access_key(url))
        self.assertIn("key=[REDACTED]", _redact_access_key(url))

    def test_ekispert_course_is_normalized_to_segments(self):
        course = {
            "Route": {
                "timeOnBoard": "25",
                "timeOther": "10",
                "Point": [
                    {"Station": {"Name": "京都"}},
                    {"Station": {"Name": "稲荷"}},
                ],
                "Line": [
                    {
                        "Name": "JR奈良線",
                        "Type": "train",
                        "timeOnBoard": "25",
                    }
                ],
            }
        }

        legs, total_minutes = _parse_legs(course)

        self.assertEqual(len(legs), 1)
        self.assertEqual(legs[0].from_name, "京都")
        self.assertEqual(legs[0].to_name, "稲荷")
        self.assertEqual(legs[0].line_name, "JR奈良線")
        self.assertEqual(total_minutes, 35)

    def test_zero_route_total_falls_back_to_positive_segment_durations(self):
        course = {
            "Route": {
                "timeOnBoard": "0",
                "timeOther": "0",
                "Point": [
                    {"Station": {"Name": "京都"}},
                    {"Station": {"Name": "稲荷"}},
                    {"Station": {"Name": "京都"}},
                ],
                "Line": [
                    {"Name": "移動", "Type": "other", "timeOnBoard": "1"},
                    {"Name": "移動", "Type": "other", "timeOnBoard": "1"},
                ],
            }
        }

        legs, total_minutes = _parse_legs(course)

        self.assertEqual(len(legs), 2)
        self.assertEqual(total_minutes, 2)

    def test_route_search_reports_missing_api_key(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.ekispert.load_dotenv"),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(sample_places(), "test candidates"))),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 503)
        self.assertIn("EKISPERT_API_KEY", response.json()["detail"])

    def test_route_suggestion_returns_only_top_scored_route(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 3,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))

        candidates = sample_places()
        with patch("app.main.search_route", search), patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(candidates, "test candidates")),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["routes"]), 1)
        self.assertEqual(body["routes"][0]["legs"][0]["line_name"], "JR奈良線")
        self.assertEqual(body["routes"][0]["total_minutes"], 35)
        search.assert_awaited_once()
        self.assertEqual(len(choose_place_sets("all", 3, "京都駅", candidates)), 3)

    def test_random_route_selects_backend_conditions_and_returns_one_route(self):
        client = TestClient(app)
        search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))

        with (
            patch("app.main.random.choice", return_value="nature"),
            patch("app.main.random.randint", return_value=1),
            patch("app.main.search_route", search),
            patch(
                "app.main.generate_route_copywriting",
                new=AsyncMock(return_value=RouteCopywriting(
                    title="喧騒を離れて、京都の余白へ",
                    story="静かな自然に身をゆだねる、短い寄り道の物語です。",
                )),
            ),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(sample_places(), "test candidates"))),
        ):
            response = client.get("/api/routes/random")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 1)
        self.assertEqual(response.json()["routes"][0]["places"][0]["name"], "京都自然公園")
        self.assertEqual(response.json()["routes"][0]["title"], "喧騒を離れて、京都の余白へ")
        self.assertIn("静かな自然", response.json()["routes"][0]["story"])
        search.assert_awaited_once()
        self.assertEqual(search.await_args.kwargs["via_points"][0], "34.98585,135.75877")
        self.assertEqual(search.await_args.kwargs["via_points"][-1], "34.98585,135.75877")

    def test_random_route_uses_fallback_copy_when_gemini_fails(self):
        client = TestClient(app)
        search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            35,
            "09:00",
            "09:35",
        ))

        with (
            patch("app.main.random.choice", return_value="nature"),
            patch("app.main.random.randint", return_value=1),
            patch("app.main.search_route", search),
            patch(
                "app.main.generate_route_copywriting",
                new=AsyncMock(side_effect=HTTPException(502, "Gemini unavailable")),
            ),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(sample_places(), "test candidates"))),
        ):
            response = client.get("/api/routes/random")

        self.assertEqual(response.status_code, 200)
        route = response.json()["routes"][0]
        self.assertIn("で楽しむ", route["title"])
        self.assertIn("を巡るルートです", route["story"])
        self.assertIn("Geminiを利用できなかった", route["note"])

    def test_route_suggestion_retries_with_fewer_stops_when_exact_route_is_unavailable(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 3,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        candidates = sample_places()
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(side_effect=[
            HTTPException(404, "no route for three points"),
            success,
        ])

        with patch("app.main.search_route", search), patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(candidates, "test candidates")),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 1)
        self.assertEqual(len(response.json()["routes"][0]["places"]), 2)
        self.assertEqual(search.await_count, 2)

    def test_route_suggestion_does_not_search_other_variants_after_success(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(return_value=success)

        with patch("app.main.search_route", search), patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(sample_places(), "test candidates")),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 1)
        search.assert_awaited_once()

    def test_route_suggestion_reports_temporary_failure_for_selected_route(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }
        success = (
            [RouteLeg(
                from_name="京都",
                to_name="稲荷",
                line_name="JR奈良線",
                mode="train",
                duration_minutes=5,
            )],
            20,
            "09:00",
            "09:20",
        )
        search = AsyncMock(side_effect=HTTPException(504, "temporary outage"))

        with patch("app.main.search_route", search), patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(sample_places(), "test candidates")),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 504)
        search.assert_awaited_once()

    def test_route_suggestion_returns_timeout_when_no_route_finishes_in_budget(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }

        async def slow_search(**_kwargs):
            raise asyncio.TimeoutError

        with patch("app.main.search_route", new=slow_search), patch(
            "app.main._route_candidates",
            new=AsyncMock(return_value=(sample_places(), "test candidates")),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 504)

    def test_route_suggestion_returns_timeout_when_place_loading_exceeds_budget(self):
        client = TestClient(app)
        request = {
            "origin": "京都駅",
            "theme": "all",
            "stop_count": 1,
            "departure_date": "2026-10-05",
            "departure_time": "09:00",
        }

        async def slow_places(*_args, **_kwargs):
            raise asyncio.TimeoutError

        with patch("app.main._route_candidates", new=slow_places):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 504)
        self.assertIn("候補", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
