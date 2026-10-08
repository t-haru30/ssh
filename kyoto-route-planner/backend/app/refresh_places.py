import asyncio
import sqlite3
from contextlib import closing
from datetime import date
from pathlib import Path

from app.database import database_path, initialize_database
from app.overpass import list_osm_places


async def refresh_places(database: Path | None = None) -> int:
    target = initialize_database(database or database_path())
    places = await list_osm_places(target, force_refresh=True)
    with closing(sqlite3.connect(target)) as connection:
        connection.execute(
            """
            INSERT INTO datasets (
                dataset_id, title, publisher, source_url, license_name,
                attribution_text, source_version, fetched_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dataset_id) DO UPDATE SET
                fetched_at = excluded.fetched_at,
                notes = excluded.notes
            """,
            (
                "osm-overpass",
                "OpenStreetMap京都POI",
                "OpenStreetMap contributors",
                "https://www.openstreetmap.org/copyright",
                "Open Database License",
                "© OpenStreetMap contributors",
                "Overpass API",
                date.today().isoformat(),
                "明示的な更新コマンドで取得したPOIをローカル検索用に保存。",
            ),
        )
        connection.execute("DELETE FROM places WHERE dataset_id = ?", ("osm-overpass",))
        connection.executemany(
            """
            INSERT INTO places (
                id, name, category, region, address, latitude, longitude,
                description, source_record_id, dataset_id, source_attributes_json
            ) VALUES (?, ?, ?, '京都府', ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    place.id,
                    place.name,
                    place.category,
                    place.address,
                    place.latitude,
                    place.longitude,
                    place.description,
                    place.id,
                    "osm-overpass",
                    "{}",
                )
                for place in places
            ],
        )
        connection.commit()
    return len(places)


if __name__ == "__main__":
    count = asyncio.run(refresh_places())
    print(f"ローカルSQLiteに{count}件のPOIを保存しました。")
