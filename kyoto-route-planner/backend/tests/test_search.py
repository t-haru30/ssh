import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app.database import initialize_database
from app.search import parse_place_query, search_places


class PlaceQueryTests(unittest.TestCase):
    def test_natural_language_query_extracts_region_station_preferences_and_distance(self):
        intent = parse_place_query(
            "京都駅周辺で自然を感じられて子連れで楽しめる場所"
        )

        self.assertEqual(intent.region, "京都府")
        self.assertEqual(intent.center_station, "京都駅")
        self.assertEqual(intent.max_distance_m, 1000)
        self.assertEqual(
            {(item.label_type, item.label) for item in intent.preferences},
            {
                ("atmosphere", "自然豊か"),
                ("target_audience", "ファミリー"),
            },
        )

    def test_distance_and_category_are_extracted_without_unsupported_location_assumptions(self):
        intent = parse_place_query("京都府のホテルを半径2.5km以内")

        self.assertEqual(intent.region, "京都府")
        self.assertEqual(intent.category, "lodging")
        self.assertEqual(intent.max_distance_m, 2500)
        self.assertIsNone(intent.center_station)
        self.assertTrue(intent.warnings)

    def test_unregistered_station_is_flagged_and_never_falls_back_to_all_places(self):
        intent = parse_place_query("浜松駅周辺で自然を感じられる場所")

        self.assertTrue(intent.location_unresolved)
        self.assertIsNone(intent.center_station)
        self.assertTrue(intent.warnings)

        with tempfile.TemporaryDirectory() as temp_directory:
            response = search_places(
                "浜松駅周辺で自然を感じられる場所",
                path=Path(temp_directory) / "places.sqlite3",
            )

        self.assertEqual(response.results, [])

    def test_search_combines_labels_keywords_and_exact_distance_filter(self):
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
                connection.executemany(
                    """
                    INSERT INTO places (
                        id, name, category, region, address, latitude, longitude,
                        description, dataset_id
                    ) VALUES (?, ?, 'tourism', '京都府', '京都府京都市', ?, ?, ?, 'd')
                    """,
                    [
                        (
                            "near",
                            "自然の庭園",
                            34.98585,
                            135.76000,
                            "自然を散策できる場所",
                        ),
                        (
                            "far",
                            "遠方の自然公園",
                            35.20,
                            135.90,
                            "自然を楽しめる公園",
                        ),
                    ],
                )
                connection.execute(
                    """
                    INSERT INTO place_labels (
                        place_id, label_type, label, confidence, evidence,
                        method, prompt_version
                    ) VALUES ('near', 'atmosphere', '自然豊か', 0.8, '自然', 'rule', 'rules-v1')
                    """
                )
                connection.execute(
                    """
                    INSERT INTO place_labels (
                        place_id, label_type, label, confidence, evidence,
                        method, prompt_version
                    ) VALUES ('far', 'atmosphere', '自然豊か', 0.8, '自然', 'rule', 'rules-v1')
                    """
                )
                connection.commit()

            response = search_places(
                "京都駅周辺で自然を感じられる観光スポット",
                path=database,
            )

        self.assertEqual([hit.place.id for hit in response.results], ["near"])
        self.assertLessEqual(response.results[0].distance_m or 0, 1000)
        self.assertIn("意味ベクトル検索は未導入", response.note)


if __name__ == "__main__":
    unittest.main()
