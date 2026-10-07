import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from app.database import initialize_database
from app.overpass import (
    API_URL,
    CACHE_KEY,
    QUERY_BUFFER_METERS,
    _parse_places,
    get_osm_status,
    list_osm_places,
    search_osm_places,
)


def osm_element(
    osm_type: str = "node",
    osm_id: int = 1234,
    name: str = "京都の神社",
    tags: dict[str, str] | None = None,
) -> dict:
    base = {
        "type": osm_type,
        "id": osm_id,
        "tags": {
            "name": name,
            "religion": "shinto",
            **(tags or {}),
        },
    }
    if osm_type == "node":
        return {**base, "lat": 35.002, "lon": 135.768}
    return {**base, "center": {"lat": 35.002, "lon": 135.768}}


class OverpassTests(unittest.IsolatedAsyncioTestCase):
    async def test_places_are_cached_and_query_uses_public_overpass_api(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            response = httpx.Response(
                200,
                json={"elements": [osm_element()]},
            )
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client = client_factory.return_value.__aenter__.return_value
                client.post = AsyncMock(return_value=response)
                first = await list_osm_places()
                second = await list_osm_places()

            self.assertEqual([place.name for place in first], ["京都の神社"])
            self.assertEqual(first[0].themes, ["temple"])
            self.assertEqual(second, first)
            client.post.assert_awaited_once()
            request = client.post.await_args
            self.assertEqual(request.args[0], API_URL)
            self.assertEqual(request.kwargs["data"]["data"].count("nwr("), 10)
            self.assertIn(
                '[tourism~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|hotel|hostel|guest_house|motel|apartment|camp_site)$"]',
                request.kwargs["data"]["data"],
            )
            self.assertIn('[heritage]', request.kwargs["data"]["data"])
            self.assertIn(
                '[religion~"^(buddhist|shinto)$"]',
                request.kwargs["data"]["data"],
            )
            self.assertIn(f"around:{QUERY_BUFFER_METERS}", request.kwargs["data"]["data"])
            self.assertIn("KyotoRoutePlanner", request.kwargs["headers"]["User-Agent"])
            self.assertNotIn("Authorization", request.kwargs.get("headers", {}))

    async def test_corrupt_cache_is_discarded_and_refetched(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO osm_places_cache (
                        cache_key, fetched_at, payload_json,
                        rate_limited, retry_after
                    ) VALUES (?, ?, ?, 0, NULL)
                    """,
                    (
                        CACHE_KEY,
                        datetime.now(timezone.utc).isoformat(),
                        "{not-json",
                    ),
                )
                connection.commit()

            response = httpx.Response(200, json={"elements": [osm_element()]})
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client_factory.return_value.__aenter__.return_value.post = AsyncMock(
                    return_value=response
                )
                places = await list_osm_places()

            self.assertEqual([place.name for place in places], ["京都の神社"])

    def test_way_centers_and_osm_tags_are_parsed(self):
        places = _parse_places(
            [osm_element(
                osm_type="way",
                osm_id=77,
                name="京都自然公園",
                tags={"leisure": "park", "name:ja": "京都自然公園"},
            )]
        )

        self.assertEqual(len(places), 1)
        self.assertEqual(places[0].id, "osm-way-77")
        self.assertEqual((places[0].latitude, places[0].longitude), (35.002, 135.768))
        self.assertIn("nature", places[0].themes)

    async def test_natural_language_search_uses_cached_osm_tags(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            elements = [
                osm_element(),
                osm_element(
                    osm_id=5678,
                    name="京都自然公園",
                    tags={"name": "京都自然公園", "leisure": "park"},
                ),
            ]
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO osm_places_cache (
                        cache_key, fetched_at, payload_json,
                        rate_limited, retry_after
                    ) VALUES (?, ?, ?, 0, NULL)
                    """,
                    (
                        CACHE_KEY,
                        datetime.now(timezone.utc).isoformat(),
                        json.dumps(elements),
                    ),
                )
                connection.commit()

            with patch("app.overpass.database_path", return_value=database):
                response = await search_osm_places("京都駅から神社")

            self.assertEqual(response.results[0].place.name, "京都の神社")
            self.assertTrue(response.results[0].place.source_record_id.startswith("osm-node-"))
            self.assertEqual(response.query.center_station, "京都駅")
            self.assertIn("OpenStreetMap", response.note)

    async def test_no_api_key_is_required_to_query(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            response = httpx.Response(200, json={"elements": [osm_element()]})
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client_factory.return_value.__aenter__.return_value.post = AsyncMock(
                    return_value=response
                )
                places = await list_osm_places()

            self.assertEqual(len(places), 1)

    async def test_rate_limited_server_is_paused_without_retries(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            response = httpx.Response(429, headers={"Retry-After": "3600"})
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client = client_factory.return_value.__aenter__.return_value
                client.post = AsyncMock(return_value=response)
                with self.assertRaises(HTTPException) as raised:
                    await list_osm_places()
                with self.assertRaises(HTTPException) as blocked:
                    await list_osm_places()

            self.assertEqual(raised.exception.status_code, 429)
            self.assertEqual(blocked.exception.status_code, 429)
            self.assertIn("Overpass API", raised.exception.detail)
            client.post.assert_awaited_once()
            self.assertTrue(get_osm_status(database)["requests_paused"])

    async def test_stale_cache_is_used_and_warned_when_provider_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            fetched_at = datetime.now(timezone.utc) - timedelta(days=2)
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO osm_places_cache (
                        cache_key, fetched_at, payload_json, rate_limited, retry_after
                    ) VALUES (?, ?, ?, 0, NULL)
                    """,
                    (
                        CACHE_KEY,
                        fetched_at.isoformat(),
                        json.dumps([osm_element()]),
                    ),
                )
                connection.commit()

            response = httpx.Response(503)
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client = client_factory.return_value.__aenter__.return_value
                client.post = AsyncMock(return_value=response)
                places = await list_osm_places()
                warning = get_osm_status(database)
                cached_again = await list_osm_places()

            self.assertEqual([place.name for place in places], ["京都の神社"])
            self.assertEqual(cached_again, places)
            self.assertTrue(warning["using_stale_cache"])
            self.assertIn("24時間以上経過したキャッシュ", warning["warning"])
            self.assertTrue(warning["requests_paused"])
            client.post.assert_awaited_once()

    async def test_provider_outage_is_reported_explicitly(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "travel.sqlite3")
            response = httpx.Response(503)
            with (
                patch("app.overpass.database_path", return_value=database),
                patch("app.overpass.httpx.AsyncClient") as client_factory,
            ):
                client_factory.return_value.__aenter__.return_value.post = AsyncMock(
                    return_value=response
                )
                with self.assertRaises(HTTPException) as raised:
                    await list_osm_places()

            self.assertEqual(raised.exception.status_code, 503)
            self.assertIn("一時的に利用できません", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
