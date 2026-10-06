import math
import re
import sqlite3
from contextlib import closing
from pathlib import Path

from app.database import database_path, initialize_database
from app.models import (
    CatalogPlace,
    LabelPreference,
    ParsedPlaceQuery,
    Place,
    PlaceSearchHit,
    PlaceSearchResponse,
)
from app.places import list_origins

DISTANCE_PATTERN = re.compile(
    r"(?:半径\s*)?(\d+(?:\.\d+)?)\s*(km|キロメートル|キロ|m|メートル)\s*以内",
    re.IGNORECASE,
)
WALK_TIME_PATTERN = re.compile(r"徒歩\s*(\d+)\s*分")
STOP_WORDS = (
    "周辺",
    "近く",
    "近辺",
    "以内",
    "感じられて",
    "感じる",
    "楽しめる",
    "楽しみたい",
    "できる",
    "場所",
    "ところ",
    "スポット",
    "子連れ",
    "子ども連れ",
    "子供連れ",
    "ファミリー",
    "京都府",
    "京都",
    "で",
    "の",
    "を",
    "が",
    "に",
    "は",
    "と",
    "から",
    "まで",
)

PREFERENCE_RULES: tuple[tuple[re.Pattern[str], str, str, str], ...] = (
    (re.compile(r"自然|緑|森林|山|海"), "atmosphere", "自然豊か", "自然"),
    (re.compile(r"歴史|文化|伝統"), "atmosphere", "歴史的", "歴史"),
    (re.compile(r"都会|街歩き"), "atmosphere", "都会的", "都会"),
    (re.compile(r"子連れ|子ども連れ|子供連れ|ファミリー"), "target_audience", "ファミリー", "子連れ"),
    (re.compile(r"カップル|デート"), "target_audience", "カップル", "カップル"),
    (re.compile(r"シニア|高齢者"), "target_audience", "シニア", "シニア"),
    (re.compile(r"食べ歩き|グルメ|食"), "activity_type", "食べ歩き", "食"),
    (re.compile(r"鑑賞|景色|眺望|展望"), "activity_type", "鑑賞", "鑑賞"),
    (re.compile(r"リラックス|のんびり|温泉"), "activity_type", "リラックス", "リラックス"),
    (re.compile(r"アクティブ|登山|ハイキング"), "activity_type", "アクティブ", "登山"),
)

CATEGORY_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"宿泊|ホテル|旅館"), "lodging"),
    (re.compile(r"飲食|レストラン|カフェ|食べ歩き|グルメ"), "food"),
    (re.compile(r"バス停|公共交通"), "transport"),
    (re.compile(r"観光|観光地|観光スポット|神社|寺|文化財|名所"), "tourism"),
)
CATEGORY_KEYWORDS = ("神社", "寺", "寺院", "教会", "城", "城跡", "文化財", "名所")
PREFECTURE_NAMES = (
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
)


def parse_place_query(text: str) -> ParsedPlaceQuery:
    query = text.strip()
    station = next(
        (
            origin
            for origin in sorted(list_origins(), key=lambda item: len(item.name), reverse=True)
            if any(
                marker in query
                for marker in (
                    f"{origin.name}駅",
                    f"{origin.name}周辺",
                    f"{origin.name}近く",
                    f"{origin.name}から",
                )
            )
        ),
        None,
    )
    requested_prefecture = next(
        (prefecture for prefecture in PREFECTURE_NAMES if prefecture in query),
        None,
    )
    region = requested_prefecture or (
        "京都府" if any(term in query for term in ("京都", "Kyoto")) else None
    )
    preferences: list[LabelPreference] = []
    keywords: list[str] = []
    consumed_terms: list[str] = []

    for pattern, label_type, label, keyword in PREFERENCE_RULES:
        if pattern.search(query):
            preferences.append(LabelPreference(label_type=label_type, label=label))
            keywords.append(keyword)
            consumed_terms.extend(pattern.findall(query))

    category = next(
        (category for pattern, category in CATEGORY_RULES if pattern.search(query)),
        None,
    )
    keywords.extend(term for term in CATEGORY_KEYWORDS if term in query)
    distance_match = DISTANCE_PATTERN.search(query)
    max_distance_m: int | None = None
    if distance_match:
        amount = float(distance_match.group(1))
        unit = distance_match.group(2).lower()
        multiplier = 1000 if unit in ("km", "キロ", "キロメートル") else 1
        max_distance_m = round(amount * multiplier)
    else:
        walk_match = WALK_TIME_PATTERN.search(query)
        if walk_match:
            max_distance_m = int(walk_match.group(1)) * 80
        elif station and any(term in query for term in ("周辺", "近く", "近辺")):
            max_distance_m = 1000

    residual = query
    for term in sorted(
        set((*STOP_WORDS, *consumed_terms, *(origin.name for origin in list_origins()))),
        key=len,
        reverse=True,
    ):
        residual = residual.replace(term, " ")
    for pattern, _category in CATEGORY_RULES:
        residual = pattern.sub(" ", residual)
    for pattern, _label_type, _label, _keyword in PREFERENCE_RULES:
        residual = pattern.sub(" ", residual)
    residual = DISTANCE_PATTERN.sub(" ", residual)
    residual = WALK_TIME_PATTERN.sub(" ", residual)
    keywords.extend(
        token for token in re.findall(r"[A-Za-z0-9]{3,}|[\u4e00-\u9fff]{2,}", residual)
        if token not in keywords
    )

    warnings: list[str] = []
    if region and region != "京都府":
        warnings.append("この試作の検索対象は京都府内です。")
    if max_distance_m is not None and station is None:
        warnings.append("距離条件は出発駅・基準地点が特定できる場合にのみ適用します。")
    location_unresolved = (
        station is None
        and any(term in query for term in ("駅", "周辺", "近く", "近辺", "半径", "徒歩"))
    )
    if location_unresolved:
        warnings.append("入力された基準地点を登録済み駅から特定できません。距離検索は行いません。")

    return ParsedPlaceQuery(
        region=region,
        location_unresolved=location_unresolved,
        category=category,
        keywords=keywords,
        preferences=preferences,
        center_station=station.name if station else None,
        center_latitude=station.latitude if station else None,
        center_longitude=station.longitude if station else None,
        max_distance_m=max_distance_m,
        warnings=warnings,
    )


def _distance_m(
    first_latitude: float,
    first_longitude: float,
    second_latitude: float,
    second_longitude: float,
) -> float:
    earth_radius_m = 6_371_000
    latitude_delta = math.radians(second_latitude - first_latitude)
    longitude_delta = math.radians(second_longitude - first_longitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(first_latitude))
        * math.cos(math.radians(second_latitude))
        * math.sin(longitude_delta / 2) ** 2
    )
    return earth_radius_m * 2 * math.asin(math.sqrt(haversine))


def _text_match_scores(
    connection: sqlite3.Connection,
    keywords: list[str],
) -> dict[int, float]:
    searchable_terms = [term for term in keywords if len(term) >= 3]
    scores: dict[int, float] = {}
    if searchable_terms:
        fts_expression = " OR ".join(
            f'"{term.replace(chr(34), chr(34) * 2)}"' for term in searchable_terms
        )
        rows = connection.execute(
            """
            SELECT rowid, bm25(places_fts) AS rank
            FROM places_fts
            WHERE places_fts MATCH ?
            """,
            (fts_expression,),
        ).fetchall()
        ranks = {int(row["rowid"]): float(row["rank"]) for row in rows}
        if ranks:
            best = min(ranks.values())
            worst = max(ranks.values())
            if math.isclose(best, worst):
                scores.update({rowid: 1.0 for rowid in ranks})
            else:
                scores.update(
                    {
                        rowid: 1.0 - (rank - best) / (worst - best)
                        for rowid, rank in ranks.items()
                    }
                )

    short_terms = [term for term in keywords if len(term) < 4]
    if short_terms:
        rows = connection.execute(
            """
            SELECT rowid, name, category, address, description, source_attributes_json
            FROM places
            """
        ).fetchall()
        for row in rows:
            searchable_text = " ".join(
                (
                    row["name"],
                    row["category"],
                    row["address"],
                    row["description"],
                    row["source_attributes_json"],
                )
            )
            if any(term in searchable_text for term in short_terms):
                scores[int(row["rowid"])] = max(
                    scores.get(int(row["rowid"]), 0.0),
                    1.0,
                )
    return scores


def search_places(
    query_text: str,
    path: Path | None = None,
    limit: int = 20,
) -> PlaceSearchResponse:
    intent = parse_place_query(query_text)
    target = initialize_database(path or database_path())
    if intent.location_unresolved or (intent.region and intent.region != "京都府"):
        return PlaceSearchResponse(
            query=intent,
            results=[],
            note=(
                "検索対象の地域・基準地点をこの京都府内データベースでは解決できません。"
                "対象範囲を確認してください。"
            ),
        )

    where = ["1 = 1"]
    params: list[object] = []
    for preference in intent.preferences:
        where.append(
            """
            EXISTS (
                SELECT 1 FROM place_labels l
                WHERE l.place_id = p.id AND l.label_type = ? AND l.label = ?
            )
            """
        )
        params.extend([preference.label_type, preference.label])
    if intent.region:
        where.append("p.region = ?")
        params.append(intent.region)
    if intent.category:
        where.append("p.category = ?")
        params.append(intent.category)

    with closing(sqlite3.connect(target)) as connection:
        connection.row_factory = sqlite3.Row
        text_scores = _text_match_scores(connection, intent.keywords)
        if intent.max_distance_m is not None and intent.center_latitude is not None:
            latitude_margin = intent.max_distance_m / 110_000
            longitude_scale = max(
                0.01,
                math.cos(math.radians(intent.center_latitude)),
            )
            longitude_margin = intent.max_distance_m / (110_000 * longitude_scale)
            where.extend(
                [
                    "g.min_latitude <= ? AND g.max_latitude >= ?",
                    "g.min_longitude <= ? AND g.max_longitude >= ?",
                ]
            )
            params.extend(
                [
                    intent.center_latitude + latitude_margin,
                    intent.center_latitude - latitude_margin,
                    intent.center_longitude + longitude_margin,
                    intent.center_longitude - longitude_margin,
                ]
            )

        join = (
            " JOIN places_geo g ON g.rowid = p.rowid"
            if intent.max_distance_m is not None and intent.center_latitude is not None
            else ""
        )
        rows = connection.execute(
            f"""
            SELECT p.rowid, p.id, p.name, p.category, p.region, p.address,
                   p.latitude, p.longitude, p.description, p.source_record_id
            FROM places p{join}
            WHERE {" AND ".join(where)}
            """,
            params,
        ).fetchall()

        results: list[PlaceSearchHit] = []
        for row in rows:
            distance = None
            distance_score = 0.0
            if intent.center_latitude is not None and intent.center_longitude is not None:
                distance = _distance_m(
                    intent.center_latitude,
                    intent.center_longitude,
                    row["latitude"],
                    row["longitude"],
                )
                if intent.max_distance_m is not None and distance > intent.max_distance_m:
                    continue
                if intent.max_distance_m:
                    distance_score = 1 - min(distance / intent.max_distance_m, 1)
                else:
                    distance_score = 1 / (1 + distance / 1000)

            matched_labels = connection.execute(
                """
                SELECT label_type, label
                FROM place_labels
                WHERE place_id = ?
                """,
                (row["id"],),
            ).fetchall()
            label_set = {
                (label["label_type"], label["label"])
                for label in matched_labels
            }
            preference_score = (
                sum(
                    (preference.label_type, preference.label) in label_set
                    for preference in intent.preferences
                ) / len(intent.preferences)
                if intent.preferences
                else 0.0
            )
            text_score = text_scores.get(row["rowid"], 0.0)
            score_parts: list[tuple[float, float]] = []
            if intent.keywords:
                score_parts.append((0.45, text_score))
            if intent.preferences:
                score_parts.append((0.35, preference_score))
            if intent.center_station:
                score_parts.append((0.20, distance_score))
            score = (
                sum(weight * value for weight, value in score_parts)
                / sum(weight for weight, _value in score_parts)
                if score_parts
                else 0.0
            )
            place = CatalogPlace(
                id=row["id"],
                name=row["name"],
                category=row["category"],
                region=row["region"],
                address=row["address"],
                description=row["description"],
                latitude=row["latitude"],
                longitude=row["longitude"],
                source_record_id=row["source_record_id"],
            )
            results.append(
                PlaceSearchHit(
                    place=place,
                    score=round(score, 4),
                    distance_m=round(distance) if distance is not None else None,
                )
            )

    results.sort(
        key=lambda hit: (
            -hit.score,
            hit.distance_m if hit.distance_m is not None else math.inf,
            hit.place.name,
        )
    )
    note = (
        "検索はキーワード・ルールラベル・距離によるものです。意味ベクトル検索は未導入です。"
        "検索結果が空の場合、国土数値情報等のスポット取込とラベル付けを先に実行してください。"
    )
    return PlaceSearchResponse(query=intent, results=results[:limit], note=note)
