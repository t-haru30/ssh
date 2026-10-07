import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app.database import initialize_database


class DatabaseSchemaTests(unittest.TestCase):
    def test_osm_cache_migrates_legacy_quota_columns(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = Path(temp_directory) / "places.sqlite3"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    CREATE TABLE osm_places_cache (
                        cache_key TEXT PRIMARY KEY,
                        fetched_at TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        free_requests_remaining INTEGER,
                        quota_resets_at TEXT
                    )
                    """
                )
                connection.commit()

            initialize_database(database)

            with closing(sqlite3.connect(database)) as connection:
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(osm_places_cache)")
                }

            self.assertIn("rate_limited", columns)
            self.assertIn("retry_after", columns)

    def test_popularity_tables_are_created(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")

            with closing(sqlite3.connect(database)) as connection:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                popularity_columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(place_popularity)")
                }
                score_columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(place_scores)")
                }

            self.assertIn("place_popularity", tables)
            self.assertIn("place_scores", tables)
            self.assertIn("open_data_match", popularity_columns)
            self.assertIn("open_data_score", score_columns)

    def test_schema_initializes_repeatably_and_supports_hybrid_search_records(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = Path(temp_directory) / "places.sqlite3"
            initialize_database(database)
            initialize_database(database)

            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO datasets (
                        dataset_id, title, publisher, source_url, license_name,
                        attribution_text, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "ksj-tourism",
                        "Tourism resources",
                        "MLIT",
                        "https://example.gov/dataset",
                        "CC BY 4.0",
                        "Source: MLIT",
                        "2026-10-05",
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO places (
                        id, name, category, address, latitude, longitude,
                        description, dataset_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "kyoto-park",
                        "京都自然公園",
                        "tourist_resource",
                        "京都府京都市",
                        35.01,
                        135.76,
                        "自然を楽しめる公園",
                        "ksj-tourism",
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO place_labels (
                        place_id, label_type, label, confidence, method,
                        model_name, prompt_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    ("kyoto-park", "atmosphere", "自然豊か", 0.94, "llm", "test-model", "v1"),
                )

                text_match = connection.execute(
                    "SELECT rowid FROM places_fts WHERE places_fts MATCH ?",
                    ("自然公園",),
                ).fetchone()
                spatial_match = connection.execute(
                    """
                    SELECT p.id
                    FROM places_geo g JOIN places p ON p.rowid = g.rowid
                    WHERE g.min_latitude BETWEEN 34.9 AND 35.1
                      AND g.min_longitude BETWEEN 135.6 AND 135.9
                    """
                ).fetchone()
                label_match = connection.execute(
                    "SELECT label FROM place_labels WHERE place_id = ?",
                    ("kyoto-park",),
                ).fetchone()
                connection.commit()

            self.assertIsNotNone(text_match)
            self.assertEqual(spatial_match[0], "kyoto-park")
            self.assertEqual(label_match[0], "自然豊か")

    def test_place_coordinates_are_validated(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO datasets (
                        dataset_id, title, publisher, source_url, license_name,
                        attribution_text, fetched_at
                    ) VALUES ('d', 'dataset', 'publisher', 'https://example.gov', 'CC BY 4.0', 'source', '2026-10-05')
                    """
                )
                connection.commit()
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        """
                        INSERT INTO places (
                            id, name, category, latitude, longitude, dataset_id
                        ) VALUES ('bad', 'bad point', 'tourist_resource', 100, 135, 'd')
                        """
                    )


if __name__ == "__main__":
    unittest.main()
