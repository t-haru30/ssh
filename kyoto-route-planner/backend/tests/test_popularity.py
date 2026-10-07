import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from app.database import initialize_database
from app.models import Place
from app.popularity import (
    _cached_popularity_is_fresh,
    _log_score,
    _sparql_rows,
    _upsert_results,
    load_cached_scores,
)


def place_with_wikidata() -> Place:
    return Place(
        id="osm-1",
        name="清水寺",
        category="place_of_worship",
        description="",
        access_point="座標から経路検索",
        latitude=34.9949,
        longitude=135.785,
        themes=["history", "temple"],
        tags={
            "wikidata": "Q160236",
            "wikipedia": "ja:清水寺",
            "tourism": "attraction",
        },
    )


class PopularityTests(unittest.TestCase):
    def test_sparql_bindings_are_normalized(self):
        rows = _sparql_rows({
            "results": {
                "bindings": [
                    {
                        "item": {"value": "http://www.wikidata.org/entity/Q160236"},
                        "sitelinks": {"value": "42"},
                    }
                ]
            }
        })

        self.assertEqual(rows[0]["sitelinks"], "42")
        self.assertEqual(rows[0]["item"].rsplit("/", 1)[-1], "Q160236")

    def test_upsert_persists_external_data_and_scores(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            _upsert_results(
                database,
                [place_with_wikidata()],
                {
                    "Q160236": {
                        "sitelinks": "42",
                        "jaTitle": "清水寺",
                        "enTitle": "Kiyomizu-dera",
                    }
                },
                {"osm-1": 120000},
            )

            with closing(sqlite3.connect(database)) as connection:
                popularity = connection.execute(
                    "SELECT wikidata_id, wikipedia_pageviews_30d FROM place_popularity"
                ).fetchone()
                score = connection.execute(
                    "SELECT total_score, open_data_score, score_version FROM place_scores"
                ).fetchone()

            self.assertEqual(popularity, ("Q160236", 120000))
            self.assertEqual(score[1], 0)
            self.assertEqual(score[2], "v3")
            self.assertGreater(score[0], 0)
            self.assertEqual(load_cached_scores(database)["osm-1"], score[0])

    def test_p12_match_contributes_open_data_score(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    """
                    INSERT INTO datasets (
                        dataset_id, title, publisher, source_url, license_name,
                        attribution_text, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    ("ksj-p12-2014-26", "P12", "MLIT", "https://example.gov",
                     "license", "source", "2026-10-07"),
                )
                connection.execute(
                    """
                    INSERT INTO places (
                        id, name, category, latitude, longitude, dataset_id
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    ("p12-1", "清水寺", "tourism", 34.9949, 135.785,
                     "ksj-p12-2014-26"),
                )
                connection.commit()
            _upsert_results(database, [place_with_wikidata()], {}, {})

            with closing(sqlite3.connect(database)) as connection:
                row = connection.execute(
                    "SELECT open_data_match, open_data_score FROM place_popularity JOIN place_scores USING (place_id)"
                ).fetchone()

            self.assertEqual(row, (1, 100.0))

    def test_pageview_score_is_logarithmic_and_bounded(self):
        self.assertLess(_log_score(100), _log_score(100000))
        self.assertLessEqual(_log_score(10**12), 100)

    def test_fresh_cache_skips_missing_external_refresh(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            _upsert_results(database, [place_with_wikidata()], {}, {})

            self.assertTrue(_cached_popularity_is_fresh(database, [place_with_wikidata()]))

    def test_stale_cache_is_detected(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            _upsert_results(database, [place_with_wikidata()], {}, {})
            stale = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
            with closing(sqlite3.connect(database)) as connection:
                connection.execute(
                    "UPDATE place_popularity SET source_fetched_at = ?",
                    (stale,),
                )
                connection.commit()

            self.assertFalse(_cached_popularity_is_fresh(database, [place_with_wikidata()]))

    def test_missing_refresh_values_preserve_previous_cache(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            database = initialize_database(Path(temp_directory) / "places.sqlite3")
            place = place_with_wikidata()
            _upsert_results(
                database,
                [place],
                {"Q160236": {"sitelinks": "42", "jaTitle": "清水寺"}},
                {"osm-1": 120000},
            )
            _upsert_results(database, [place], {}, {})

            with closing(sqlite3.connect(database)) as connection:
                row = connection.execute(
                    """
                    SELECT wikipedia_ja_title, wikipedia_sitelink_count,
                           wikipedia_pageviews_30d
                    FROM place_popularity
                    """
                ).fetchone()

            self.assertEqual(row, ("清水寺", 42, 120000))
