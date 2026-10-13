"""Bounded, application-owned review and repair; never replaces the original deck."""
import asyncio
from contextlib import contextmanager
import json
import os
from math import ceil
import sqlite3
from pathlib import Path
from uuid import uuid4

from app.discovery import build_discover_routes, distance_km, eligible_candidates, place_themes
from app.regional_food import regional_score, specialties

DB_PATH = Path(os.getenv("DISCOVERY_REVIEW_DB_PATH", str(Path(__file__).resolve().parents[1] / "data" / "journey_reviews.sqlite3")))
LABELS = {
    "empty": "条件を満たす旅程候補が不足しています。",
    "identity": "施設情報と旅程の場所が一致していません。",
    "region": "選択した地域・観光範囲から外れた施設があります。",
    "duration": "指定したコースの観光時間に収まりません。",
    "meals": "飲食店が多い、または連続しています。",
    "regional_food": "ご当地料理の根拠がある飲食店が含まれていません。",
    "duplicates": "同じ施設が重複しています。",
}


def audit(request, route, pool):
    if route is None:
        return ["empty"]
    catalog = {p.id: p for p in pool}
    spots = route.get("spots", [])
    issues = [] if spots else ["empty"]
    places = []
    for spot in spots:
        p = catalog.get(spot["place_id"])
        if not p or p.name != spot["name"] or abs(p.latitude - spot["lat"]) > .00001 or abs(p.longitude - spot["lng"]) > .00001:
            issues.append("identity")
            continue
        places.append(p)
        if (not request.cross_prefecture and p.region != request.prefecture_name) or distance_km(request.origin, p) > request.radius_km:
            issues.append("region")
    start = route.get("start", {})
    if start.get("lat") != request.origin.latitude or start.get("lng") != request.origin.longitude:
        issues.append("region")
    if len({p.id for p in places}) != len(places):
        issues.append("duplicates")
    meals = ["food" in place_themes(p) for p in places]
    if sum(meals) > 2 or any(a and b for a, b in zip(meals, meals[1:])):
        issues.append("meals")
    if request.theme == "food" and not any(regional_score(request.origin, p) and "food" in place_themes(p) for p in places):
        issues.append("regional_food")
    points = [request.origin, *places, request.origin]
    computed = sum(ceil(distance_km(a, b) / 25 * 60) + 10 for a, b in zip(points, points[1:])) + sum(s.get("stay_minutes", 0) for s in spots)
    minutes = max(route.get("estimated_minutes", 0), computed)
    if minutes <= 0 or minutes > (300 if request.course == "half_day" else 600) or (request.course == "full_day" and (minutes < 360 or computed < 360 or len(spots) < 4)):
        issues.append("duration")
    return list(dict.fromkeys(issues))


@contextmanager
def _connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=1)
    try:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, created REAL DEFAULT (unixepoch()), report TEXT NOT NULL, decision TEXT)")
            yield db
    finally:
        db.close()


def record(report):
    # No free-text preferences, precise origins, credentials or full provider text.
    event = {"status": report["status"], "issues": report["issues"], "actions": report["actions"],
             "changes": [{"original_id": p["original_id"], "proposed_id": p["route"]["id"], "original_place_ids": p["original_place_ids"], "proposed_place_ids": [s["place_id"] for s in p["route"]["spots"]], "before_minutes": p["original_minutes"], "after_minutes": p["route"]["estimated_minutes"]} for p in report["proposals"]]}
    try:
        with _connection() as db:
            db.execute("INSERT INTO reviews (id, report) VALUES (?, ?)", (report["id"], json.dumps(event, ensure_ascii=False)))
            db.execute("DELETE FROM reviews WHERE created < unixepoch() - 2592000")
            db.execute("DELETE FROM reviews WHERE id NOT IN (SELECT id FROM reviews ORDER BY created DESC LIMIT 2000)")
        return True
    except (sqlite3.Error, OSError):
        return False


def record_decision(identifier, decision):
    try:
        with _connection() as db:
            row = db.execute("SELECT report FROM reviews WHERE id=? AND created >= unixepoch() - 2592000", (identifier,)).fetchone()
            if not row or (decision != "keep" and decision not in ["adopt:" + change["proposed_id"] for change in json.loads(row[0])["changes"]]):
                return False
            return db.execute("UPDATE reviews SET decision=? WHERE id=?", (decision, identifier)).rowcount == 1
    except (sqlite3.Error, OSError):
        return False


async def review_journeys(request, result, pool):
    from app.openpoi import enrich_candidates
    originals = result["routes"]
    reports = [(route, audit(request, route, pool)) for route in originals] or [(None, ["empty"])]
    codes = list(dict.fromkeys(code for _, issues in reports for code in issues))
    report = {"id": uuid4().hex, "status": "passed", "issues": [LABELS[c] for c in codes],
              "actions": [], "proposals": [], "unresolved": [],
              "limitations": "観光範囲・構成・概算時間の点検です。営業日・営業時間、実際の交通経路、往復移動は未確認です。"}
    if codes:
        candidates = eligible_candidates(request, tuple(pool))
        has_regional = any(regional_score(request.origin, p) and "food" in place_themes(p) for p in candidates)
        # Choose a specific search only when evidence is missing; otherwise repair locally.
        query = None
        if request.theme == "food" and not has_regional:
            query = next(iter(specialties(request.origin)), f"{request.prefecture_name} 郷土料理")
        elif "empty" in codes:
            query = "博物館 庭園 観光"
        if query:
            try:
                pool, state = await asyncio.wait_for(enrich_candidates(request, tuple(pool), query=query), timeout=8)
                report["actions"].append(f"候補不足のため「{query}」の追加検索を試みました。" + ("施設候補を取得しました。" if state == "ready" else "確認済みの追加候補は取得できませんでした。"))
            except (TimeoutError, ValueError, OSError):
                report["actions"].append("追加検索は時間内に確認できなかったため終了しました。")
        else:
            report["actions"].append("必要な施設情報があるため、追加検索せずに組み合わせを見直しました。")
        # Reserve food slots for grounded local food and interleave sights and food.
        repair_pool = tuple(p for p in pool if request.theme != "food" or "food" not in place_themes(p) or regional_score(request.origin, p))
        rebuilt = build_discover_routes(request, repair_pool)["routes"]
        valid = [r for r in rebuilt if not audit(request, r, pool)]
        used = set()
        for original, issues in reports:
            if not issues:
                continue
            original_ids = {s["place_id"] for s in original["spots"]} if original else set()
            ranked = sorted(valid, key=lambda r: -len(original_ids & {s["place_id"] for s in r["spots"]}))
            proposal = next((r for r in ranked if r["id"] not in used), None)
            if proposal and len(report["proposals"]) < 3:
                used.add(proposal["id"])
                report["proposals"].append({"original_id": original["id"] if original else None,
                    "original_title": original["title"] if original else "候補なし",
                    "original_stops": [s["name"] for s in original["spots"]] if original else [],
                    "original_minutes": original["estimated_minutes"] if original else 0,
                    "original_place_ids": sorted(original_ids),
                    "reasons": [LABELS[c] for c in issues], "route": proposal})
            else:
                report["unresolved"].extend(LABELS[c] for c in issues)
        report["unresolved"] = list(dict.fromkeys(report["unresolved"]))
        report["status"] = "proposal" if report["proposals"] else "unresolved"
    report["recorded"] = record(report)
    return report
