import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from datetime import date
from pathlib import Path

import shapefile

from app.database import initialize_database
from app.ingest_p12 import DATASET_ID, ingest_p12
from app.labeling import enrich_database
from app.search import search_places


def create_p12_archive(path: Path) -> None:
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    writer = shapefile.Writer(
        shp=shp,
        shx=shx,
        dbf=dbf,
        shapeType=shapefile.POINT,
        encoding="cp932",
    )
    writer.field("P12_001", "N", size=8, decimal=0)
    writer.field("P12_002", "C", size=80)
    writer.field("P12_005", "C", size=40)
    writer.field("P12_006", "C", size=80)
    writer.point(135.771, 35.011)
    writer.record(42, "清水寺", "寺院", "京都市東山区")
    writer.point(135.8, 35.0)
    writer.record(43, "名称なし", "観光資源", "")
    writer.close()

    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("P12a-14_26.shp", shp.getvalue())
        archive.writestr("P12a-14_26.shx", shx.getvalue())
        archive.writestr("P12a-14_26.dbf", dbf.getvalue())


class P12IngestionTests(unittest.TestCase):
    def test_imports_point_attributes_and_replaces_dataset_idempotently(self):
        with tempfile.TemporaryDirectory() as temp_directory:
            root = Path(temp_directory)
            archive = root / "P12-14_26_GML.zip"
            database = initialize_database(root / "travel.sqlite3")
            create_p12_archive(archive)

            self.assertEqual(
                ingest_p12(archive, database, fetched_at=date(2026, 10, 5)),
                2,
            )
            self.assertEqual(
                ingest_p12(archive, database, fetched_at=date(2026, 10, 5)),
                2,
            )
            self.assertEqual(enrich_database(database), 2)

            with closing(sqlite3.connect(database)) as connection:
                places = connection.execute(
                    """
                    SELECT name, category, region, address, latitude, longitude,
                           description, source_record_id, source_attributes_json
                    FROM places WHERE dataset_id = ? ORDER BY source_record_id
                    """,
                    (DATASET_ID,),
                ).fetchall()
                dataset = connection.execute(
                    """
                    SELECT license_name, source_version, attribution_text
                    FROM datasets WHERE dataset_id = ?
                    """,
                    (DATASET_ID,),
                ).fetchone()
                labels = connection.execute(
                    "SELECT label FROM place_labels WHERE place_id = (SELECT id FROM places WHERE source_record_id = '42')"
                ).fetchall()

            self.assertEqual(len(places), 2)
            self.assertEqual(places[0][:8], ("清水寺", "tourism", "京都府", "京都市東山区", 35.011, 135.771, "", "42"))
            self.assertEqual(json.loads(places[0][8])["P12_002"], "清水寺")
            self.assertEqual(json.loads(places[0][8])["P12_005"], "寺院")
            self.assertEqual(dataset[0], "非商用（複製物の再配布を除く）")
            self.assertIn("第2.2版", dataset[1])
            self.assertIn("取得日 2026-10-05", dataset[2])
            self.assertTrue(labels)
            self.assertTrue(search_places("京都の寺", path=database).results)


if __name__ == "__main__":
    unittest.main()
