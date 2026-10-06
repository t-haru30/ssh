import hashlib
import json
import sqlite3
import zipfile
from contextlib import closing
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any

import shapefile

from app.database import database_path, initialize_database

DATASET_ID = "ksj-p12-2014-26"
DATASET_TITLE = "国土数値情報 観光資源データ（京都府）"
DATASET_PAGE_URL = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P12-2014.html"
LICENSE_URL = "https://nlftp.mlit.go.jp/ksj/other/agreement_02.html"
ARCHIVE_NAME = "P12-14_26_GML.zip"
ATTRIBUTION = (
    "出典：国土数値情報（観光資源データ）第2.2版（国土交通省）"
    f"（{DATASET_PAGE_URL}、取得日 {{fetched_at}}）。"
    "観光資源のポイントデータを検索用に加工。"
)


def _field_value(attributes: dict[str, Any], *names: str) -> str:
    missing_values = {"-", "‐", "－", "―"}
    for name in names:
        value = attributes.get(name)
        if value is not None:
            text = str(value).strip()
            if text and text not in missing_values:
                return text
    return ""


def _iter_point_records(archive: Path):
    with zipfile.ZipFile(archive) as bundle:
        members = {Path(name).name.casefold(): name for name in bundle.namelist()}
        stem = "p12a-14_26"
        try:
            shp_name, shx_name, dbf_name = (
                members[f"{stem}.{extension}"] for extension in ("shp", "shx", "dbf")
            )
        except KeyError as error:
            raise ValueError(
                f"{ARCHIVE_NAME} に京都府のP12aポイントデータが見つかりません。"
            ) from error

        reader = shapefile.Reader(
            shp=BytesIO(bundle.read(shp_name)),
            shx=BytesIO(bundle.read(shx_name)),
            dbf=BytesIO(bundle.read(dbf_name)),
            encoding="cp932",
        )
        try:
            if reader.shapeType not in (shapefile.POINT, shapefile.MULTIPOINT):
                raise ValueError("P12aデータがポイント形式ではありません。")

            field_names = [field[0] for field in reader.fields[1:]]
            for record_number, shape_record in enumerate(reader.iterShapeRecords()):
                if not shape_record.shape.points:
                    continue
                properties = dict(zip(field_names, shape_record.record))
                longitude, latitude = shape_record.shape.points[0]
                if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                    continue
                yield record_number, properties, latitude, longitude
        finally:
            reader.close()


def ingest_p12(
    archive: Path,
    database: Path | None = None,
    fetched_at: date | None = None,
) -> int:
    if not archive.is_file():
        raise FileNotFoundError(f"P12データZIPが見つかりません: {archive}")

    target = initialize_database(database or database_path())
    import_date = (fetched_at or date.today()).isoformat()
    attribution = ATTRIBUTION.format(fetched_at=import_date)

    with closing(sqlite3.connect(target)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN")
        connection.execute(
            """
            INSERT INTO datasets (
                dataset_id, title, publisher, source_url, license_name,
                license_url, attribution_text, source_version, fetched_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dataset_id) DO UPDATE SET
                title = excluded.title,
                publisher = excluded.publisher,
                source_url = excluded.source_url,
                license_name = excluded.license_name,
                license_url = excluded.license_url,
                attribution_text = excluded.attribution_text,
                source_version = excluded.source_version,
                fetched_at = excluded.fetched_at,
                notes = excluded.notes
            """,
            (
                DATASET_ID,
                DATASET_TITLE,
                "国土交通省",
                DATASET_PAGE_URL,
                "非商用（複製物の再配布を除く）",
                LICENSE_URL,
                attribution,
                "製品仕様書第2.2版・データ基準年2014年",
                import_date,
                "京都府の観光資源ポイントのみ取り込み。説明文は原典にないため空欄。",
            ),
        )
        connection.execute("DELETE FROM places WHERE dataset_id = ?", (DATASET_ID,))

        imported = 0
        for record_number, attributes, latitude, longitude in _iter_point_records(archive):
            source_id = _field_value(attributes, "P12_001", "観光資源_ID")
            name = _field_value(attributes, "P12_002", "観光資源名")
            address = _field_value(attributes, "P12_006", "所在地住所")
            if not name:
                continue

            stable_source_id = source_id or str(record_number)
            place_id = hashlib.sha256(
                f"{DATASET_ID}:{stable_source_id}".encode("utf-8")
            ).hexdigest()[:24]
            connection.execute(
                """
                INSERT INTO places (
                    id, name, category, region, address, latitude, longitude,
                    description, source_record_id, dataset_id, source_attributes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
                """,
                (
                    place_id,
                    name,
                    "tourism",
                    "京都府",
                    address,
                    latitude,
                    longitude,
                    source_id or None,
                    DATASET_ID,
                    json.dumps(attributes, ensure_ascii=False, default=str),
                ),
            )
            imported += 1

        connection.commit()
    return imported


if __name__ == "__main__":
    default_archive = Path(__file__).resolve().parents[1] / "data" / "raw" / ARCHIVE_NAME
    imported_count = ingest_p12(default_archive)
    print(f"京都府P12観光資源ポイントを{imported_count}件取り込みました。")
