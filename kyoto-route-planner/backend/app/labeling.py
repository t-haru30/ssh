import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from app.database import database_path, initialize_database

PROMPT_VERSION = "rules-v1"


@dataclass(frozen=True)
class LabelRule:
    label_type: str
    label: str
    pattern: re.Pattern[str]
    confidence: float


@dataclass(frozen=True)
class PlaceLabel:
    label_type: str
    label: str
    confidence: float
    evidence: str


RULES = (
    LabelRule(
        "atmosphere",
        "自然豊か",
        re.compile(r"自然|山|森|森林|公園|海|湖|川|滝|渓谷|竹林|庭園|緑|高原|湿原"),
        0.72,
    ),
    LabelRule(
        "atmosphere",
        "歴史的",
        re.compile(r"寺|神社|城|史跡|遺跡|古墳|文化財|伝統|歴史|門|塔"),
        0.72,
    ),
    LabelRule(
        "atmosphere",
        "都会的",
        re.compile(r"市場|商店街|繁華街|市街|商業施設"),
        0.68,
    ),
    LabelRule(
        "target_audience",
        "ファミリー",
        re.compile(r"ファミリー向け|子ども向け|子供向け|児童向け|遊具|子ども広場"),
        0.70,
    ),
    LabelRule(
        "target_audience",
        "カップル",
        re.compile(r"カップル向け|ロマンチック|恋人|デートスポット"),
        0.70,
    ),
    LabelRule(
        "target_audience",
        "シニア",
        re.compile(r"シニア向け|高齢者向け|高齢者に配慮"),
        0.70,
    ),
    LabelRule(
        "activity_type",
        "食べ歩き",
        re.compile(r"食べ歩き|市場|飲食店|グルメ|料理|食文化"),
        0.72,
    ),
    LabelRule(
        "activity_type",
        "鑑賞",
        re.compile(r"鑑賞|眺望|景色|美術館|博物館|展望|庭園"),
        0.68,
    ),
    LabelRule(
        "activity_type",
        "リラックス",
        re.compile(r"温泉|休養|森林浴|公園|庭園|自然"),
        0.66,
    ),
    LabelRule(
        "activity_type",
        "アクティブ",
        re.compile(r"登山|ハイキング|サイクリング|アスレチック|遊歩道"),
        0.72,
    ),
)


def label_text(name: str, description: str) -> list[PlaceLabel]:
    text = f"{name}\n{description}"
    labels: list[PlaceLabel] = []
    seen: set[tuple[str, str]] = set()

    for rule in RULES:
        match = rule.pattern.search(text)
        key = (rule.label_type, rule.label)
        if match and key not in seen:
            labels.append(
                PlaceLabel(
                    label_type=rule.label_type,
                    label=rule.label,
                    confidence=rule.confidence,
                    evidence=match.group(0),
                )
            )
            seen.add(key)

    return labels


def enrich_database(path: Path | None = None) -> int:
    target = initialize_database(path or database_path())
    with closing(sqlite3.connect(target)) as connection:
        connection.row_factory = sqlite3.Row
        places = connection.execute(
            "SELECT id, name, description FROM places ORDER BY id"
        ).fetchall()
        connection.execute("BEGIN")
        for place in places:
            connection.execute(
                "DELETE FROM place_labels WHERE place_id = ? AND method = 'rule'",
                (place["id"],),
            )
            connection.executemany(
                """
                INSERT INTO place_labels (
                    place_id, label_type, label, confidence, evidence,
                    method, model_name, prompt_version
                ) VALUES (?, ?, ?, ?, ?, 'rule', NULL, ?)
                """,
                [
                    (
                        place["id"],
                        label.label_type,
                        label.label,
                        label.confidence,
                        label.evidence,
                        PROMPT_VERSION,
                    )
                    for label in label_text(place["name"], place["description"])
                ],
            )
        connection.commit()
    return len(places)


if __name__ == "__main__":
    processed = enrich_database()
    print(f"Rule labels refreshed for {processed} places.")
