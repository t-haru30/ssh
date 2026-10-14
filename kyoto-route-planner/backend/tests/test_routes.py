import unittest
import asyncio
import tempfile
from unittest.mock import AsyncMock, Mock, call, patch
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from fastapi import HTTPException

from app.ekispert import (
    _make_url,
    _parse_fare_yen,
    _parse_legs,
    _redact_access_key,
    estimate_route_fare,
    find_nearby_stations,
    find_nearest_train_station,
)
from app.main import (
    ROUTE_GENRE_CODES,
    _build_route_timeline,
    _correct_route_timeline,
    _route_candidates,
    app,
    limiter,
)
from app.copywriting import RouteCopywriting
from app.models import (
    CatalogPlace,
    Origin,
    ParsedPlaceQuery,
    Place,
    PlaceSearchHit,
    PlaceSearchResponse,
    RouteLeg,
)
from app.places import (
    calculate_place_score,
    choose_place_sets,
    choose_places,
    is_unsuitable_place,
    list_origins,
    score_breakdown,
)
from app.popularity import enrich_places_with_fame
import httpx


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
        public_patch = patch("app.public_catalog.search_public_catalog", return_value=PlaceSearchResponse(query=ParsedPlaceQuery(), results=[], note="test empty catalog"))
        public_patch.start()
        self.addCleanup(public_patch.stop)
        self.fare_estimate = AsyncMock(return_value=620)
        self.fare_estimate_patch = patch(
            "app.main.estimate_route_fare",
            new=self.fare_estimate,
        )
        self.fare_estimate_patch.start()
        self.search_places_patch = patch(
            "app.main.search_yahoo_catalog",
            new=AsyncMock(return_value=PlaceSearchResponse(
                query=ParsedPlaceQuery(),
                results=[],
                note="",
            )),
        )
        self.search_places_patch.start()
        self.segment_search = AsyncMock(return_value=([], None, None, None))
        self.segment_search_patch = patch(
            "app.main._search_route_segment",
            new=self.segment_search,
        )
        self.segment_search_patch.start()

    def tearDown(self):
        self.segment_search_patch.stop()
        self.search_places_patch.stop()
        self.fare_estimate_patch.stop()

    def test_health_reports_missing_fallback_dataset(self):
        with (
            TestClient(app) as client,
            patch("app.main.FALLBACK_DATASET_PATH") as dataset_path,
        ):
            dataset_path.is_file.return_value = False
            response = client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "degraded")
        self.assertEqual(response.json()["fallback_dataset"], "missing")

    def test_route_timeline_accepts_zero_and_one_spot(self):
        origin = Origin(name="京都駅", latitude=34.98585, longitude=135.75877)
        empty_timeline = _build_route_timeline(origin, [], "09:00", 30)
        single_timeline = _build_route_timeline(origin, sample_places()[:1], "09:00", 30)

        self.assertEqual([item.role for item in empty_timeline if hasattr(item, "role")], ["start", "finish"])
        self.assertEqual(
            [item.role for item in single_timeline if hasattr(item, "role")],
            ["start", "stop", "finish"],
        )

    def test_route_search_with_no_spots_returns_validation_response(self):
        with (
            TestClient(app) as client,
            patch("app.main._route_candidates", new=AsyncMock(return_value=([], "empty"))),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "京都駅",
                    "theme": "nature",
                    "stop_count": 1,
                    "departure_date": "2026-10-12",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 422)
        self.assertIn("スポット", response.json()["detail"])

    def test_route_selection_deduplicates_duplicate_spot_ids(self):
        candidates = sample_places()
        duplicate = candidates[0].model_copy(update={"name": "重複データ"})
        second_nature_spot = candidates[0].model_copy(
            update={"id": "yahoo-unique-nature", "name": "別の自然公園"},
        )

        selected = choose_places(
            "nature",
            2,
            "京都駅",
            [candidates[0], duplicate, second_nature_spot],
            origin_coordinates=(34.98585, 135.75877),
        )

        self.assertEqual(len(selected), 2)
        self.assertEqual(len({place.id for place in selected}), 2)

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
                call(
                    "神社 寺",
                    limit=100,
                    genre_codes=("0424001", "0424002"),
                    center=(34.98585, 135.75877),
                    radius_m=20_000,
                ),
                call("観光", limit=100, genre_codes=("0424001", "0424002"), center=(34.98585, 135.75877), radius_m=20_000),
                call("清水寺", limit=100, genre_codes=("0424001",)),
                call("平安神宮", limit=100, genre_codes=("0424002",)),
            ],
        )

    def test_discover_route_preview_returns_corrected_segment_timetable(self):
        origin = Origin(name="出発駅", latitude=35.0, longitude=135.0)
        places = sample_places()[:1]
        route_search = AsyncMock(return_value=(
            [RouteLeg(
                from_name="出発駅",
                to_name=places[0].name,
                line_name="JR東海道本線",
                mode="train",
                duration_minutes=40,
            )],
            90,
            "09:00",
            "10:30",
        ))
        self.segment_search.return_value = (
            [RouteLeg(
                from_name="出発駅",
                to_name=places[0].name,
                line_name="JR東海道本線",
                mode="train",
                duration_minutes=40,
            )],
            40,
            "09:05",
            "09:45",
        )

        with patch("app.main.search_route", route_search):
            response = TestClient(app).post(
                "/api/routes/preview",
                json={
                    "origin": origin.model_dump(),
                    "places": [place.model_dump() for place in places],
                    "departure_date": "2026-10-12",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["timeline"][1]["transit_line"],
            "JR東海道本線",
        )
        self.assertEqual(
            (
                response.json()["timeline"][1]["start_time"],
                response.json()["timeline"][1]["end_time"],
            ),
            ("09:05", "09:45"),
        )
        route_search.assert_not_awaited()
        self.assertEqual(self.segment_search.await_count, 2)
        self.assertEqual(
            self.segment_search.await_args_list[0].args[:2],
            (
                "35.0,135.0",
                f"{places[0].latitude},{places[0].longitude}",
            ),
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

        with patch("app.main.search_yahoo_catalog", search), \
             patch("app.main.enrich_places_with_fame", new=AsyncMock(side_effect=lambda places: places)):
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

    def test_national_route_candidates_are_centered_on_the_selected_station(self):
        origin = Origin(name="高尾駅", latitude=35.6575, longitude=139.2828)
        response = PlaceSearchResponse(
            query=ParsedPlaceQuery(),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="local-spot",
                        name="高尾山",
                        category="自然",
                        region="東京都",
                        address="東京都八王子市",
                        latitude=35.6254,
                        longitude=139.2431,
                        description="",
                        genre_code="0305007",
                    ),
                    score=80.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        search = AsyncMock(return_value=response)

        with patch("app.main.search_yahoo_catalog", new=search), \
             patch("app.main.enrich_places_with_fame", new=AsyncMock(side_effect=lambda places: places)):
            candidates, _ = asyncio.run(_route_candidates("all", origin))

        self.assertEqual([candidate.name for candidate in candidates], ["高尾山"])
        self.assertEqual(search.await_count, 2)
        search.assert_awaited_with(
            "観光",
            limit=100,
            genre_codes=ROUTE_GENRE_CODES["all"],
            center=(35.6575, 139.2828),
            radius_m=20_000,
        )

    def test_route_generation_accepts_a_dynamic_national_station(self):
        client = TestClient(app)
        yahoo_response = PlaceSearchResponse(
            query=ParsedPlaceQuery(),
            results=[
                PlaceSearchHit(
                    place=CatalogPlace(
                        id="local-spot",
                        name="高尾山",
                        category="自然",
                        region="東京都",
                        address="東京都八王子市",
                        latitude=35.6254,
                        longitude=139.2431,
                        description="",
                        genre_code="0305007",
                    ),
                    score=80.0,
                )
            ],
            note="Yahoo!ローカルサーチAPIの検索結果です。",
        )
        route_search = AsyncMock(return_value=([], 30, "09:00", "09:30"))

        with (
            patch("app.main.search_yahoo_catalog", new=AsyncMock(return_value=yahoo_response)) as place_search,
            patch("app.main.search_route", route_search),
        ):
            response = client.post(
                "/api/routes",
                json={
                    "origin": "高尾駅",
                    "origin_latitude": 35.6575,
                    "origin_longitude": 139.2828,
                    "theme": "all",
                    "stop_count": 1,
                    "departure_date": "2026-10-12",
                    "departure_time": "09:00",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["routes"][0]["origin"]["name"], "高尾駅")
        self.assertEqual(place_search.await_count, 2)
        self.assertEqual(
            place_search.await_args.kwargs["center"],
            (35.6575, 139.2828),
        )
        self.assertEqual(
            route_search.await_args.kwargs["via_points"][0],
            "高尾",
        )
        self.assertEqual(
            route_search.await_args.kwargs["via_points"][-1],
            "高尾",
        )

    def test_nearest_station_lookup_uses_train_station_results(self):
        payload = {
            "ResultSet": {
                "Point": [
                    {
                        "Distance": "5",
                        "Station": {"Name": "バス停", "Type": "bus"},
                        "GeoPoint": {"lati_d": "35.0", "longi_d": "139.0"},
                    },
                    {
                        "Distance": "120",
                        "Station": {"Name": "JR駅", "Type": "train"},
                        "GeoPoint": {"lati_d": "35.1", "longi_d": "139.1"},
                    },
                    {
                        "Distance": "250",
                        "Station": {"Name": "私鉄駅", "Type": "train"},
                        "GeoPoint": {"lati_d": "35.2", "longi_d": "139.2"},
                    },
                ]
            }
        }
        response = Mock(status_code=200, is_error=False)
        response.json.return_value = payload

        class MockStationClient:
            request_params = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, _url, **kwargs):
                self.request_params = kwargs["params"]
                return response

        station_client = MockStationClient()
        with (
            patch.dict("os.environ", {"EKISPERT_API_KEY": "test-key"}),
            patch("app.ekispert.load_dotenv"),
            patch("app.ekispert.httpx.AsyncClient", return_value=station_client),
        ):
            station = asyncio.run(find_nearest_train_station(35.0, 139.0))

        self.assertEqual(station, ("JR駅", 35.1, 139.1))
        self.assertEqual(station_client.request_params["type"], "train")
        self.assertNotIn("corporationBind", station_client.request_params)

    def test_station_names_are_normalized_for_any_railway_operator(self):
        from app.ekispert import _normalize_station_name

        self.assertEqual(_normalize_station_name("大手町(東京メトロ)"), "大手町駅")
        self.assertEqual(_normalize_station_name("京橋(東京都)"), "京橋(東京都)")
        self.assertEqual(_normalize_station_name("新宿"), "新宿駅")
        self.assertEqual(_normalize_station_name("京都駅"), "京都駅")

    def test_nearby_station_lookup_includes_all_types_sorted_and_limited(self):
        points = []
        for index in range(12):
            station_type = (
                {"text": "train", "detail": "subway"}
                if index % 2
                else "bus"
            )
            qualifier = "(東京メトロ)" if index % 2 else "(バス乗り場)"
            points.append({
                "Distance": str(1_000 - index * 50),
                "Station": {
                    "Name": f"候補{index}{qualifier}",
                    "Type": station_type,
                },
                "GeoPoint": {
                    "lati_d": str(35.0 + index / 1000),
                    "longi_d": str(139.0 + index / 1000),
                },
            })
        response = Mock(status_code=200, is_error=False)
        response.json.return_value = {"ResultSet": {"Point": points}}

        class MockStationClient:
            request_params = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, _url, **kwargs):
                self.request_params = kwargs["params"]
                return response

        station_client = MockStationClient()
        with (
            patch.dict("os.environ", {"EKISPERT_API_KEY": "test-key"}),
            patch("app.ekispert.load_dotenv"),
            patch("app.ekispert.httpx.AsyncClient", return_value=station_client),
        ):
            stations = asyncio.run(find_nearby_stations(35.0, 139.0))

        self.assertEqual(len(stations), 10)
        self.assertEqual(
            [station.name for station in stations],
            [
                "候補11駅",
                "候補10",
                "候補9駅",
                "候補8",
                "候補7駅",
                "候補6",
                "候補5駅",
                "候補4",
                "候補3駅",
                "候補2",
            ],
        )
        self.assertEqual(stations[0].latitude, 35.011)
        self.assertEqual(station_client.request_params["geoPoint"], "35.0,139.0,wgs84,5000")
        self.assertEqual(station_client.request_params["stationCount"], "10")
        self.assertNotIn("type", station_client.request_params)
        self.assertNotIn("corporationBind", station_client.request_params)

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
                "観光",
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
                center=(34.98585, 135.75877),
                radius_m=20_000,
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

    @patch.dict("os.environ", {"PLACE_SEARCH_PROVIDER": "yahoo"})
    def test_health_origins_and_place_status_are_available(self):
        client = TestClient(app)

        self.assertEqual(
            client.get("/api/health").json(),
            {
                "status": "ok",
                "fallback_dataset": "available",
                "route_timeline_version": "1",
            },
        )
        self.assertEqual(
            [origin["name"] for origin in client.get("/api/origins").json()],
            ["京都駅", "大阪駅", "新大阪駅", "三ノ宮駅", "奈良駅", "名古屋駅", "東京駅"],
        )
        with patch(
            "app.main.find_nearest_train_station",
            new=AsyncMock(return_value=("大阪駅", 34.70248, 135.49595)),
        ) as nearest_station:
            nearest = client.get(
                "/api/origins/nearest?latitude=34.7030&longitude=135.4960"
            )
        self.assertEqual(nearest.status_code, 200)
        self.assertEqual(nearest.json()["name"], "大阪駅")
        nearest_station.assert_awaited_once_with(34.703, 135.496)
        nearby_values = [
            Origin(name="バス停", latitude=34.702, longitude=135.495),
            Origin(name="地下鉄駅", latitude=34.701, longitude=135.494),
        ]
        with patch(
            "app.main.find_nearby_stations",
            new=AsyncMock(return_value=nearby_values),
        ) as nearby_search:
            nearby = client.get(
                "/api/nearby-stations?latitude=34.703&longitude=135.496"
            )
        self.assertEqual(nearby.status_code, 200)
        self.assertEqual(
            [item["name"] for item in nearby.json()],
            ["バス停", "地下鉄駅"],
        )
        nearby_search.assert_awaited_once_with(34.703, 135.496)
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

    def test_route_timeline_is_corrected_with_segment_timetable_and_line(self):
        origin = list_origins()[0]
        places = sample_places()[:1]
        timeline = _build_route_timeline(origin, places, "09:00", 60)
        self.segment_search.side_effect = [
            (
                [RouteLeg(
                    from_name=origin.name,
                    to_name=places[0].name,
                    line_name="JR東海道本線",
                    mode="train",
                    duration_minutes=40,
                )],
                40,
                "09:05",
                "09:45",
            ),
            (
                [RouteLeg(
                    from_name=places[0].name,
                    to_name=origin.name,
                    line_name="遠鉄バス 駅行き",
                    mode="bus",
                    duration_minutes=15,
                )],
                15,
                "11:30",
                "11:45",
            ),
        ]

        corrected = asyncio.run(_correct_route_timeline(
            timeline,
            origin,
            places,
            "2026-10-12",
            timeout=2,
        ))
        transit = [item for item in corrected if item.type == "transit"]

        self.assertEqual(
            [item.transit_line for item in transit],
            ["JR東海道本線", "遠鉄バス 駅行き"],
        )
        self.assertEqual(
            [(item.start_time, item.end_time) for item in transit],
            [("09:05", "09:45"), ("11:30", "11:45")],
        )
        self.assertTrue(all(not item.is_estimate for item in transit))
        self.assertEqual(corrected[0].time, "09:05")
        self.assertEqual(corrected[2].time, "09:45")
        self.assertEqual(corrected[-1].time, "11:45")

    def test_route_timeline_preserves_estimates_when_a_segment_has_no_route(self):
        origin = list_origins()[0]
        places = sample_places()[:1]
        timeline = _build_route_timeline(origin, places, "09:00", 60)
        self.segment_search.side_effect = HTTPException(404, "no route")

        corrected = asyncio.run(_correct_route_timeline(
            timeline,
            origin,
            places,
            "2026-10-12",
            timeout=2,
        ))
        transit = [item for item in corrected if item.type == "transit"]
        original_transit = [item for item in timeline if item.type == "transit"]

        self.assertEqual(
            [(item.start_time, item.end_time) for item in transit],
            [(item.start_time, item.end_time) for item in original_transit],
        )
        self.assertTrue(all(item.is_estimate for item in transit))
        self.assertTrue(all(item.transit_line == "公共交通機関" for item in transit))

    def test_yahoo_score_prioritizes_relevant_complete_place_records(self):
        popular = sample_places()[0].model_copy(update={
            "themes": ["history", "nature"],
            "tags": {"sitelinks": "40", "pageviews_30d": "3000"},
        })
        ordinary = sample_places()[1].model_copy(update={
            "category": "文化財",
            "description": "歴史ある寺院",
            "address": "京都市東山区",
            "themes": ["history", "nature"],
        })

        self.assertGreater(
            calculate_place_score(popular, "history"),
            calculate_place_score(ordinary, "history"),
        )
        self.assertEqual(
            choose_places("nature", 1, "京都駅", [ordinary, popular])[0].id,
            popular.id,
        )

    def test_information_completeness_does_not_add_score(self):
        bare = sample_places()[0]
        complete = bare.model_copy(update={
            "category": "公園",
            "description": "説明あり",
            "address": "京都市",
        })

        self.assertEqual(
            calculate_place_score(bare, "nature"),
            calculate_place_score(complete, "nature"),
        )
        self.assertGreater(score_breakdown(complete, "nature")["confidence"], score_breakdown(bare, "nature")["confidence"])

    def test_cemeteries_and_hospitals_are_excluded_from_selection(self):
        base = sample_places()[0]
        cemetery = base.model_copy(update={"id": "cemetery", "name": "中沢墓園", "category": "公園", "latitude": 35.0, "longitude": 135.76})
        park = base.model_copy(update={"id": "park", "name": "蜆塚公園", "latitude": 35.05, "longitude": 135.8})
        famous_graveyard = base.model_copy(update={"id": "okunoin", "name": "高野山奥の院墓地"})
        notable_cemetery = base.model_copy(update={"id": "notable", "name": "有名霊園", "tags": {"sitelinks": "12"}})

        self.assertTrue(is_unsuitable_place(cemetery))
        self.assertFalse(is_unsuitable_place(famous_graveyard))
        self.assertFalse(is_unsuitable_place(notable_cemetery))
        selected = choose_places("all", 1, "京都駅", [cemetery, park])
        self.assertEqual([place.id for place in selected], ["park"])

    def test_missing_fame_data_uses_neutral_value_and_records_breakdown(self):
        place = sample_places()[0]
        breakdown = score_breakdown(place, "nature")

        self.assertEqual(breakdown["fame_measured"], 0.0)
        self.assertEqual(breakdown["fame"], 6.0)
        selected = choose_places("nature", 1, "京都駅", [place])
        self.assertEqual(selected[0].score_breakdown, score_breakdown(place, "nature"))

    def test_negative_fame_counts_are_unknown_instead_of_zero_popularity(self):
        base = sample_places()[0].model_copy(update={"tags": {}})
        unknown = score_breakdown(base, "nature")
        for tags in ({"sitelinks": "-1"}, {"pageviews_30d": "-2"},
                     {"sitelinks": "-100", "pageviews_30d": "-100"}):
            with self.subTest(tags=tags):
                self.assertEqual(score_breakdown(base.model_copy(update={"tags": tags}), "nature"), unknown)
        self.assertEqual(unknown["fame_measured"], 0.0)
        self.assertEqual(unknown["fame"], 6.0)

    def test_negative_fame_count_does_not_dilute_a_valid_signal(self):
        base = sample_places()[0].model_copy(update={"tags": {}})
        for valid, invalid in (({"sitelinks": "40"}, {"pageviews_30d": "-1"}),
                               ({"pageviews_30d": "3000"}, {"sitelinks": "-1"}),
                               ({"wikidata": "Q123"}, {"sitelinks": "-1", "pageviews_30d": "-1"})):
            with self.subTest(valid=valid):
                expected = score_breakdown(base.model_copy(update={"tags": valid}), "nature")
                actual = score_breakdown(base.model_copy(update={"tags": {**valid, **invalid}}), "nature")
                self.assertEqual(actual, expected)
        zero = score_breakdown(base.model_copy(update={"tags": {"sitelinks": "0"}}), "nature")
        self.assertEqual(zero["fame_measured"], 1.0)
        self.assertEqual(zero["fame"], 0.0)

    def test_fame_enrichment_failure_leaves_places_unchanged(self):
        places = sample_places()

        with patch("app.popularity._fetch_fame", new=AsyncMock(side_effect=httpx.ConnectError("down"))):
            enriched = asyncio.run(enrich_places_with_fame(places))

        self.assertEqual(enriched, places)

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

    def test_fare_parser_sums_fare_and_selected_route_charges(self):
        self.assertEqual(
            _parse_fare_yen({
                "Price": [
                    {"kind": "FareSummary", "Oneway": "460"},
                    {"kind": "ChargeSummary", "Oneway": "300"},
                    {"kind": "Teiki1Summary", "Oneway": "12000"},
                ],
            }),
            760,
        )
        self.assertIsNone(_parse_fare_yen({"Price": [{"kind": "ChargeSummary", "Oneway": "300"}]}))

    def test_fare_search_uses_plain_search_without_date_or_time(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "ResultSet": {
                "Course": {
                    "Price": [
                        {"kind": "FareSummary", "Oneway": "460"},
                        {"kind": "ChargeSummary", "Oneway": "300"},
                    ],
                },
            },
        }
        request = AsyncMock(return_value=response)

        with (
            patch.dict("os.environ", {"EKISPERT_API_KEY": "test-key"}),
            patch("app.ekispert.load_dotenv"),
            patch("app.ekispert.request_with_retry", request),
        ):
            fare_yen = asyncio.run(estimate_route_fare(["35.0,135.0", "35.1,135.1"]))

        self.assertEqual(fare_yen, 760)
        requested_url = request.await_args.args[2]
        query = parse_qs(urlparse(requested_url).query)
        self.assertEqual(query["searchType"], ["plain"])
        self.assertNotIn("date", query)
        self.assertNotIn("time", query)
        self.assertNotIn("test-key", _redact_access_key(requested_url))

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
        with (
            patch("app.main.search_route", search),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(candidates, "test candidates"))),
        ):
            response = client.post("/api/routes", json=request)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["routes"]), 1)
        self.assertEqual(body["routes"][0]["legs"][0]["line_name"], "JR奈良線")
        self.assertEqual(body["routes"][0]["total_minutes"], 35)
        self.assertEqual(body["routes"][0]["fare_yen"], 620)
        search.assert_awaited_once()
        expected_fare_points = [
            "京都",
            *(
                f"{latitude},{longitude}"
                for latitude, longitude in body["routes"][0]["coordinates"][1:-1]
            ),
            "京都",
        ]
        self.fare_estimate.assert_awaited_once_with(expected_fare_points)
        self.assertEqual(len(choose_place_sets("all", 3, "京都駅", candidates)), 3)

    def test_route_suggestion_is_returned_when_fare_estimate_fails(self):
        client = TestClient(app)
        self.fare_estimate.side_effect = HTTPException(502, "fare service unavailable")
        search = AsyncMock(return_value=([], 35, "09:00", "09:35"))

        with (
            patch("app.main.search_route", search),
            patch("app.main.generate_route_copywriting", new=AsyncMock(return_value=RouteCopywriting(
                title="京都の寄り道",
                story="スポットを巡ります。",
            ))),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(sample_places(), "test candidates"))),
        ):
            response = client.post("/api/routes", json={
                "origin": "京都駅",
                "theme": "all",
                "stop_count": 1,
                "departure_date": "2026-10-05",
                "departure_time": "09:00",
            })

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["routes"][0]["fare_yen"])

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
            patch("app.main.datetime") as mocked_datetime,
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
            from datetime import datetime as real_datetime
            mocked_datetime.now.return_value = real_datetime(2026, 10, 12, 9, 0)
            mocked_datetime.combine.side_effect = real_datetime.combine
            response = client.get("/api/routes/random")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["routes"]), 1)
        self.assertEqual(response.json()["routes"][0]["places"][0]["name"], "京都自然公園")
        self.assertEqual(response.json()["routes"][0]["title"], "喧騒を離れて、京都の余白へ")
        self.assertIn("静かな自然", response.json()["routes"][0]["story"])
        search.assert_awaited_once()
        self.assertEqual(search.await_args.kwargs["via_points"][0], "京都")
        self.assertEqual(search.await_args.kwargs["via_points"][-1], "京都")

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
            patch("app.main.datetime") as mocked_datetime,
            patch("app.main.random.choice", return_value="nature"),
            patch("app.main.random.randint", return_value=1),
            patch("app.main.search_route", search),
            patch(
                "app.main.generate_route_copywriting",
                new=AsyncMock(side_effect=HTTPException(502, "Gemini unavailable")),
            ),
            patch("app.main._route_candidates", new=AsyncMock(return_value=(sample_places(), "test candidates"))),
        ):
            from datetime import datetime as real_datetime
            mocked_datetime.now.return_value = real_datetime(2026, 10, 12, 9, 0)
            mocked_datetime.combine.side_effect = real_datetime.combine
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
