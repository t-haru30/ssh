"""Exact facility search and explicitly requested, separately labelled alternatives."""
import os

from app.models import Origin, PlaceSearchHit, PlaceSearchRequest
from app.poi_search import search_yahoo_catalog
from app.search import _distance_m, parse_place_query
from app.public_catalog import _genre, _normalized, search_public_catalog


def matches_query(place, intent):
    generic = {"観光", "観光地", "自然", "歴史", "食", "おまかせ", "おすすめ", "検索"}
    words = [_normalized(word) for word in intent.keywords if word not in generic]
    text = _normalized(place.name + place.category + place.address)
    code = _genre(place)
    return not words or any(word in text or (word == "神社" and code == "0424002")
                            or (word in {"寺", "寺院"} and code == "0424001") for word in words)


RELATED_GROUPS = (
    (("神社", "神宮", "大社", "寺院", "寺"), ("0424001", "0424002"), "寺社"),
    (("カフェ", "喫茶", "飲食", "グルメ", "食べ歩き", "レストラン", "料理", "食堂"), ("01",), "飲食店"),
    (("博物館", "美術館", "科学館", "資料館", "記念館"), ("0305002", "0305003"), "博物館・美術館"),
    (("公園", "庭園", "自然", "展望", "植物園"), ("0305007", "0303004"), "公園・庭園"),
    (("動物園",), ("0303002",), "動物園"),
    (("水族館",), ("0303003",), "水族館"),
    (("ホテル", "旅館", "宿泊"), ("0304",), "宿泊施設"),
)


def related_group(query, results):
    for terms, codes, label in RELATED_GROUPS:
        if any(term in query for term in terms):
            return codes, label
    # A named venue can establish a category only when all exact hits agree.
    groups = {(codes, label) for _, codes, label in RELATED_GROUPS
              for hit in results if any((hit.place.genre_code or _genre(hit.place)).startswith(code) for code in codes)}
    return next(iter(groups)) if len(groups) == 1 else None


async def search_catalog(payload: PlaceSearchRequest, search=None):
    # Keep the endpoint's provider dependency injectable for offline integration tests.
    search = search or search_yahoo_catalog
    intent = parse_place_query(payload.query)
    center = ((payload.center_latitude, payload.center_longitude) if payload.center_latitude is not None
              else (intent.center_latitude, intent.center_longitude) if intent.center_latitude is not None else None)
    radius = intent.max_distance_m or 20_000
    base = (await search(payload.query, **({"center": center, "radius_m": radius} if center else {}))).model_copy(deep=True)
    base.related_results = []
    base.related_note = None
    fallback_intent = intent.model_copy(deep=True)
    if center:
        fallback_intent.center_latitude, fallback_intent.center_longitude = center
        fallback_intent.max_distance_m = radius
    if len(base.results) < 5 and os.getenv("PLACE_SEARCH_PROVIDER") != "public_catalog":
        fallback = search_public_catalog(fallback_intent, payload.query, 20)
        ids = {hit.place.id for hit in base.results}
        added = []
        for hit in fallback.results:
            if hit.place.id not in ids and matches_query(hit.place, fallback_intent):
                hit.place.tags = {**hit.place.tags, "source": "OpenStreetMap"}
                added.append(hit)
                ids.add(hit.place.id)
        if added:
            base.results = (base.results + added)[:20]
            base.note += " 同じ条件のOpenStreetMap登録候補で補完しました。営業時間・料金・営業状況は未確認です。"
    if os.getenv("PLACE_SEARCH_PROVIDER") == "public_catalog" and center:
        from app.discovery import DiscoverRequest
        from app.openpoi import enrich_candidates
        scope = DiscoverRequest(area="editor", prefecture_name=base.query.region or "全国",
            origin=Origin(name="観光の起点", latitude=center[0], longitude=center[1]), radius_km=radius / 1000)
        pool, status = await enrich_candidates(scope, tuple(hit.place for hit in base.results), query=payload.query)
        ids = {hit.place.id for hit in base.results}
        for place in pool:
            distance = round(_distance_m(*center, place.latitude, place.longitude))
            if place.id in ids or distance > radius or (base.query.region and place.region != base.query.region):
                continue
            if matches_query(place, base.query):
                base.results.append(PlaceSearchHit(place=place, score=50, distance_m=distance))
                ids.add(place.id)
        base.results.sort(key=lambda hit: (-hit.score, hit.distance_m or 0, hit.place.id))
        base.results = base.results[:20]
        if status == "ready":
            base.note = "OpenStreetMapとOpenPOIの候補を検索しました。営業時間・料金・営業状況は未確認です。"
    group = related_group(payload.query, base.results)
    base.related_available = bool(center and group)
    if payload.include_related and base.related_available:
        codes, label = group
        extra = await search(f"{base.query.region or ''} {'グルメ' if codes == ('01',) else '観光'}",
                             center=center, radius_m=radius, genre_codes=codes)
        candidates = list(extra.results)
        if len(candidates) < 5 and os.getenv("PLACE_SEARCH_PROVIDER") != "public_catalog":
            fallback = search_public_catalog(fallback_intent, "観光", 20, codes)
            candidates.extend(fallback.results)
        ids = {hit.place.id for hit in base.results}
        seen = set(ids)
        for hit in candidates:
            code = hit.place.genre_code or _genre(hit.place)
            if (hit.place.id in seen or not any(code.startswith(genre) for genre in codes)
                or (base.query.region and hit.place.region != base.query.region)):
                continue
            distance = round(_distance_m(*center, hit.place.latitude, hit.place.longitude))
            if distance > radius:
                continue
            base.related_results.append(hit.model_copy(update={"distance_m": distance}))
            seen.add(hit.place.id)
            if len(base.related_results) >= 10:
                break
        base.related_note = f"条件を広げた近隣の{label}候補です。営業時間・料金・営業状況は未確認です。"
    if len(base.results) < 5:
        base.suggestions = ["施設名を短くするか、神社・寺院など種類を指定してください。",
                            "地域名や距離条件を変えて再検索してください。"]
        if base.related_available:
            base.suggestions.append("同じ種類・関連する種類の近隣施設も候補に含められます。")
        elif not center:
            base.suggestions.append("出発地点を指定すると、近隣の候補も検索できます。")
    return base
