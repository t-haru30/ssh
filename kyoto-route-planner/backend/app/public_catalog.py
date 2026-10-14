"""Search the bundled OSM catalog; never access P12, Yahoo, or a shared database."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
import unicodedata

from app.models import CatalogPlace, ParsedPlaceQuery, PlaceSearchHit, PlaceSearchResponse
from app.search import _distance_m

PUBLIC_CATALOG_PATH = Path(__file__).resolve().parent / "data" / "facility_catalog.json"
PUBLIC_CATALOG_NOTE = "OpenStreetMapの事前候補を検索しました。全国の施設を網羅せず、営業時間・営業状況は未確認です。"


@lru_cache(maxsize=1)
def load_public_places() -> tuple[CatalogPlace, ...]:
    data = json.loads(PUBLIC_CATALOG_PATH.read_text(encoding="utf-8"))
    if data.get("version") != 1 or data.get("license", {}).get("name") != "ODbL-1.0":
        raise ValueError("Invalid public catalog license or format")
    places = tuple(CatalogPlace.model_validate(place) for place in data["places"])
    if not places or any(not place.id.startswith(("osm-node-", "osm-way-", "osm-relation-")) for place in places):
        raise ValueError("Public catalog must contain only OSM facilities")
    return places


def public_catalog_status() -> dict:
    return {"source": "OpenStreetMap", "state": "ready" if PUBLIC_CATALOG_PATH.is_file() else "unavailable",
            "warning": "同梱の事前候補のみ検索します。営業時間・営業状況は未確認です。"}


def _normalized(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


def _genre(place: CatalogPlace) -> str:
    category = place.category
    if category in {"観光名所", "史跡"}:
        if any(term in place.name for term in ("神社", "大社", "神宮")):
            return "0424002"
        if any(term in place.name for term in ("寺", "観音堂")):
            return "0424001"
    for terms, code in ((('レストラン', 'カフェ', '飲食', '食堂', 'グルメ', 'ラーメン', '喫茶', '料理'), '01'),
                        (('ホテル', '旅館', '宿泊'), '0304'), (('神社', '神宮', '大社'), '0424002'), (('寺院', '寺'), '0424001'),
                        (('美術館',), '0305002'), (('博物館', '科学館', '史跡', '記念館'), '0305003'),
                        (('動物園',), '0303002'), (('水族館',), '0303003'), (('植物園',), '0303004'),
                        (('公園', '自然', '庭園', '展望', '山', '海'), '0305007')):
        if any(term in category for term in terms):
            return code
    return ""


def search_public_catalog(intent: ParsedPlaceQuery, query_text: str, limit: int,
                          genre_codes: tuple[str, ...] | None = None) -> PlaceSearchResponse:
    # The shared natural-language parser has legacy Kyoto-only notices. This catalog is nationwide.
    intent = intent.model_copy(deep=True)
    has_center = intent.center_latitude is not None and intent.center_longitude is not None
    intent.warnings = [warning for warning in intent.warnings if "京都府内" not in warning
                       and not (has_center and ("基準地点" in warning or "距離条件" in warning))]
    if has_center:
        intent.location_unresolved = False
    elif intent.location_unresolved:
        return PlaceSearchResponse(query=intent, results=[], note="出発駅を指定してから施設を検索してください。")
    try:
        places = load_public_places()
    except (OSError, ValueError, KeyError):
        return PlaceSearchResponse(query=intent, results=[], note="施設候補データを読み込めませんでした。")
    hits = []
    generic = {"観光", "観光地", "自然", "歴史", "食", "おまかせ", "おすすめ", "検索"}
    if genre_codes:
        generic.update({"神社", "寺", "寺院", "教会", "城", "城跡", "文化財", "名所",
                        "公園", "鑑賞", "景色", "史跡"})
    keywords = [_normalized(word) for word in intent.keywords if word not in generic]
    for place in places:
        code = _genre(place)
        if intent.region and intent.region != place.region:
            continue
        if genre_codes and not any(code.startswith(genre) for genre in genre_codes if code):
            continue
        if intent.category == "food" and code != "01":
            continue
        if intent.category == "lodging" and code != "0304":
            continue
        if intent.category == "tourism" and code in {"01", "0304"}:
            continue
        name = _normalized(place.name)
        searchable = _normalized(place.name + place.category + place.address)
        if keywords and not any(word in searchable or (word == "神社" and code == "0424002")
                                or (word in {"寺", "寺院"} and code == "0424001") for word in keywords):
            continue
        distance = round(_distance_m(intent.center_latitude, intent.center_longitude,
                                    place.latitude, place.longitude)) if has_center else None
        if distance is not None and intent.max_distance_m is not None and distance > intent.max_distance_m:
            continue
        score = 100.0 if name in _normalized(query_text) else 50.0
        if distance is not None:
            score -= min(distance / 10000, 20)
        hits.append(PlaceSearchHit(place=place.model_copy(update={"genre_code": code}), score=score, distance_m=distance))
    hits.sort(key=lambda hit: (-hit.score, hit.distance_m or 0, hit.place.id))
    return PlaceSearchResponse(query=intent, results=hits[:limit],
                              note=PUBLIC_CATALOG_NOTE if hits else "同梱のOpenStreetMap候補に一致する施設がありません。条件を変えてください。")
