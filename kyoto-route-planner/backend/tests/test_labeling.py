import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app.database import initialize_database
from app.labeling import PROMPT_VERSION, enrich_database, label_text


class RuleLabelingTests(unittest.TestCase):
    def test_labels_have_explicit_evidence_and_do_not_infer_unknown_audience(self):
        labels = label_text(
            "京都御苑",
            "歴史ある庭園と自然を散策できます。",
        )

        keys = {(label.label_type, label.label) for label in labels}
        self.assertIn(("atmosphere", "歴史的"), keys)
        self.assertIn(("atmosphere", "自然豊か"), keys)
        self.assertIn(("activity_type", "リラックス"), keys)
        self.assertNotIn(("target_audience", "ファミリー"), keys)
        self.assertTrue(all(label.evidence for label in labels))

    def test_database_enrichment_is_repeatable_and_preserves_llm_labels(self):
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
                connection.execute(
                    """
                    INSERT INTO places (
                        id, name, category, latitude, longitude, description, dataset_id
                    ) VALUES ('p1', '京都自然公園', 'tourist_resource', 35, 135, '自然を楽しむ公園', 'd')
                    """
                )
                connection.execute(
                    """
                    INSERT INTO place_labels (
                        place_id, label_type, label, confidence, method,
                        model_name, prompt_version
                    ) VALUES ('p1', 'atmosphere', 'LLMラベル', 0.9, 'llm', 'test-model', 'prompt-v1')
                    """
                )
                connection.commit()

            self.assertEqual(enrich_database(database), 1)
            self.assertEqual(enrich_database(database), 1)

            with closing(sqlite3.connect(database)) as connection:
                labels = connection.execute(
                    "SELECT label, method, prompt_version FROM place_labels WHERE place_id = ? ORDER BY method",
                    ("p1",),
                ).fetchall()

            self.assertEqual(len(labels), 3)
            self.assertIn(("LLMラベル", "llm", "prompt-v1"), labels)
            self.assertIn(("自然豊か", "rule", PROMPT_VERSION), labels)


if __name__ == "__main__":
    unittest.main()
