import os
import sqlite3
from contextlib import closing
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE_PATH = BACKEND_ROOT / "data" / "travel.sqlite3"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS datasets (
    dataset_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    publisher TEXT NOT NULL,
    source_url TEXT NOT NULL,
    license_name TEXT NOT NULL,
    license_url TEXT,
    attribution_text TEXT NOT NULL,
    source_version TEXT,
    fetched_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    description TEXT NOT NULL DEFAULT '',
    description_source_url TEXT,
    source_record_id TEXT,
    dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
    source_attributes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS places_category_idx ON places(category);
CREATE INDEX IF NOT EXISTS places_coordinates_idx ON places(latitude, longitude);
CREATE INDEX IF NOT EXISTS places_dataset_idx ON places(dataset_id);

CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(
    name,
    category,
    address,
    description,
    content='places',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS places_fts_insert AFTER INSERT ON places BEGIN
    INSERT INTO places_fts(rowid, name, category, address, description)
    VALUES (new.rowid, new.name, new.category, new.address, new.description);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_delete AFTER DELETE ON places BEGIN
    INSERT INTO places_fts(places_fts, rowid, name, category, address, description)
    VALUES ('delete', old.rowid, old.name, old.category, old.address, old.description);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_update AFTER UPDATE ON places BEGIN
    INSERT INTO places_fts(places_fts, rowid, name, category, address, description)
    VALUES ('delete', old.rowid, old.name, old.category, old.address, old.description);
    INSERT INTO places_fts(rowid, name, category, address, description)
    VALUES (new.rowid, new.name, new.category, new.address, new.description);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS places_geo USING rtree(
    rowid,
    min_latitude, max_latitude,
    min_longitude, max_longitude
);

CREATE TRIGGER IF NOT EXISTS places_geo_insert AFTER INSERT ON places BEGIN
    INSERT INTO places_geo(rowid, min_latitude, max_latitude, min_longitude, max_longitude)
    VALUES (new.rowid, new.latitude, new.latitude, new.longitude, new.longitude);
END;

CREATE TRIGGER IF NOT EXISTS places_geo_delete AFTER DELETE ON places BEGIN
    DELETE FROM places_geo WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS places_geo_update AFTER UPDATE OF latitude, longitude ON places BEGIN
    UPDATE places_geo
    SET min_latitude = new.latitude,
        max_latitude = new.latitude,
        min_longitude = new.longitude,
        max_longitude = new.longitude
    WHERE rowid = new.rowid;
END;

CREATE TABLE IF NOT EXISTS place_labels (
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    label_type TEXT NOT NULL CHECK (
        label_type IN ('atmosphere', 'target_audience', 'activity_type')
    ),
    label TEXT NOT NULL,
    confidence REAL CHECK (confidence BETWEEN 0 AND 1),
    evidence TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL CHECK (method IN ('llm', 'rule', 'human')),
    model_name TEXT,
    prompt_version TEXT NOT NULL DEFAULT 'v1',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (place_id, label_type, label, method, prompt_version)
);

CREATE INDEX IF NOT EXISTS place_labels_lookup_idx
    ON place_labels(label_type, label, place_id);

CREATE TABLE IF NOT EXISTS place_embeddings (
    place_id TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
    embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
    embedding_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS place_popularity (
    place_id TEXT PRIMARY KEY,
    wikidata_id TEXT,
    wikipedia_ja_title TEXT,
    wikipedia_en_title TEXT,
    wikipedia_sitelink_count INTEGER NOT NULL DEFAULT 0,
    wikipedia_pageviews_30d INTEGER NOT NULL DEFAULT 0,
    has_japanese_wikipedia INTEGER NOT NULL DEFAULT 0,
    has_english_wikipedia INTEGER NOT NULL DEFAULT 0,
    is_world_heritage INTEGER NOT NULL DEFAULT 0,
    is_cultural_property INTEGER NOT NULL DEFAULT 0,
    open_data_match INTEGER NOT NULL DEFAULT 0,
    source_fetched_at TEXT NOT NULL,
    source_status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS place_scores (
    place_id TEXT PRIMARY KEY,
    osm_score REAL NOT NULL,
    wikidata_score REAL NOT NULL DEFAULT 0,
    pageview_score REAL NOT NULL DEFAULT 0,
    open_data_score REAL NOT NULL DEFAULT 0,
    total_score REAL NOT NULL,
    score_version TEXT NOT NULL,
    calculated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS place_scores_total_idx
    ON place_scores(total_score DESC);
"""


def database_path() -> Path:
    configured_path = os.getenv("TRAVEL_DATABASE_PATH")
    if configured_path:
        return Path(configured_path).expanduser().resolve()
    return DEFAULT_DATABASE_PATH


def initialize_database(path: Path | None = None) -> Path:
    target = path or database_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(target)) as connection:
        connection.executescript(SCHEMA)
        place_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(places)")
        }
        if "region" not in place_columns:
            connection.execute(
                "ALTER TABLE places ADD COLUMN region TEXT NOT NULL DEFAULT ''"
            )
        popularity_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(place_popularity)")
        }
        if "open_data_match" not in popularity_columns:
            connection.execute(
                "ALTER TABLE place_popularity ADD COLUMN "
                "open_data_match INTEGER NOT NULL DEFAULT 0"
            )
        score_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(place_scores)")
        }
        if "open_data_score" not in score_columns:
            connection.execute(
                "ALTER TABLE place_scores ADD COLUMN "
                "open_data_score REAL NOT NULL DEFAULT 0"
            )
        connection.commit()
    return target
