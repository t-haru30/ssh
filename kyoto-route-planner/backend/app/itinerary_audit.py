"""Bounded evidence -> schedule -> repair -> recheck. Never mutates a saved trip."""
import asyncio
from datetime import date, datetime, time, timedelta, timezone
from math import ceil
import ssl
from typing import Literal

import httpx
from pydantic import BaseModel, Field, model_validator
from app.models import Place, Origin, RouteTimelineTransit
from app.discovery import distance_km
from app.google_place_photos import BASE, safe_url, reserve_lookup, google_api_key, same_google_venue
from app.official_place_info import fetch_official_place_info
from app.ekispert import search_route

JST = timezone(timedelta(hours=9))


class AuditStop(BaseModel):
    place: Place
    dwell: int = Field(ge=15, le=360)
    locked: bool = False
    start: int = Field(ge=0, le=2879)
    anchor: int | None = Field(default=None, ge=0, le=1439)


class AuditRequest(BaseModel):
    origin: Origin
    return_to: Origin
    departure_date: date
    departure_time: time
    available_minutes: int = Field(ge=30, le=720)
    stops: list[AuditStop] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def unique(self):
        if len({s.place.id for s in self.stops}) != len(self.stops):
            raise ValueError("施設が重複しています。")
        for stop in self.stops:
            if stop.dwell < 30 and stop.place.id not in {"trip-arrival", "trip-return"}:
                raise ValueError("施設の滞在時間は30分以上必要です。")
        return self


class VenueCheck(BaseModel):
    place_id: str
    name: str
    business: Literal["operational", "closed", "temporary", "unknown"] = "unknown"
    windows: list[tuple[int, int]] | None = None
    confirmed_date: bool = False
    source: str | None = None
    official_source: str | None = None
    notes: list[str] = Field(default_factory=list)


def opening_windows(data: dict, day: date, today: date):
    """Only dated current periods establish visit-date hours. Regular hours are advisory."""
    current = data.get("currentOpeningHours")
    if not isinstance(current, dict) or not 0 <= (day - today).days <= 6:
        return None
    periods = current.get("periods")
    if not isinstance(periods, list):
        return None
    windows = []
    try:
        for period in periods:
            start, end = period["open"], period.get("close")
            # The API's explicit always-open representation.
            if not end and start.get("day") == 0 and start.get("hour", 0) == 0 and start.get("minute", 0) == 0 and not start.get("truncated"):
                return [(0, 1440)]
            if not end:
                return None
            def minute(point):
                d = point.get("date")
                if not isinstance(d, dict):
                    raise ValueError("Undated hours")
                offset = (date(d["year"], d["month"], d["day"]) - day).days
                hour, mins = point.get("hour", 0), point.get("minute", 0)
                if not isinstance(hour, int) or not isinstance(mins, int) or not 0 <= hour <= 23 or not 0 <= mins <= 59:
                    raise ValueError("Invalid time")
                return offset * 1440 + hour * 60 + mins
            a, b = minute(start), minute(end)
            if b <= a:
                return None
            if b > 0 and a < 1440:
                windows.append((max(0, a), min(1440, b)))
        return sorted(windows)
    except (KeyError, TypeError, ValueError):
        return None


async def google_check(place: Place, day: date) -> VenueCheck:
    check = VenueCheck(place_id=place.id, name=place.name)
    key = google_api_key()
    if not key or not reserve_lookup():
        check.notes.append("営業状態・営業時間の取得が未設定、または利用上限です。")
        return check
    try:
        async with httpx.AsyncClient(timeout=8, trust_env=False, follow_redirects=False, verify=ssl.create_default_context()) as client:
            r = await client.post(BASE + "/places:searchText", headers={"X-Goog-Api-Key":key,
                "X-Goog-FieldMask":"places.displayName,places.location,places.googleMapsUri,places.businessStatus,places.currentOpeningHours"},
                json={"textQuery":place.name + " " + place.address,"languageCode":"ja","pageSize":3,
                      "locationBias":{"circle":{"center":{"latitude":place.latitude,"longitude":place.longitude},"radius":500}}})
            r.raise_for_status()
            candidates = [p for p in r.json().get("places", []) if same_google_venue(place, p)]
            if len(candidates) != 1 or not safe_url(candidates[0].get("googleMapsUri")):
                check.notes.append("施設名・位置を一意に照合できません。")
                return check
            p = candidates[0]
            check.source = p["googleMapsUri"]
            check.business = {"OPERATIONAL":"operational","CLOSED_PERMANENTLY":"closed","CLOSED_TEMPORARILY":"temporary"}.get(p.get("businessStatus"), "unknown")
            check.windows = opening_windows(p, day, datetime.now(JST).date())
            check.confirmed_date = check.windows is not None
            if not check.confirmed_date:
                check.notes.append("訪問日固有の営業時間は未確認です（取得範囲は原則、本日から7日間）。")
            if check.business == "closed":
                check.notes.append("Google Mapsでは閉業・閉館として登録されています。移転の可能性も含め公式情報をご確認ください。")
            elif check.business == "temporary":
                check.notes.append("Google Mapsでは一時休業です。訪問日の再開は未確認です。")
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        check.notes.append("営業情報を取得できませんでした。営業中とは判定していません。")
    return check


async def venue_check(stop: AuditStop, day: date):
    if stop.place.id in {"trip-arrival", "trip-return"}:
        return VenueCheck(place_id=stop.place.id, name=stop.place.name, business="operational", windows=[(0,1440)], confirmed_date=True, notes=["観光の起点・終点です。施設営業の対象外です。"])
    check = await google_check(stop.place, day)
    try:
        official = await asyncio.wait_for(fetch_official_place_info(stop.place), 8)
        if official and official.status == "verified":
            for notice in official.notices:
                if notice.starts_on <= day <= notice.ends_on:
                    check.windows = []
                    check.confirmed_date = True
                    check.official_source = notice.url
                    check.notes.append("訪問日に該当する公式の休業告知：" + notice.text)
    except (Exception,):
        check.notes.append("公式の休業告知は追加確認できませんでした。")
    return check


async def transit(a: Origin | Place, b: Origin | Place, day: date, minute: int):
    if distance_km(a, b) < .001:
        return RouteTimelineTransit(from_name=a.name, to_name=b.name, duration_minutes=0, is_estimate=False, fare_yen=0)
    result = await asyncio.wait_for(search_route([f"{a.latitude},{a.longitude}", f"{b.latitude},{b.longitude}"],
        (day + timedelta(days=minute // 1440)).isoformat(), f"{minute % 1440 // 60:02d}:{minute % 60:02d}"), 8)
    legs, minutes, departure, arrival = result
    # Coordinate routes often expose dates on legs but leave course times empty.
    # Use the final arrival relative to the requested departure, including waits.
    timed = False
    if legs and legs[-1].arrival_at:
        requested = datetime.combine(day, time(), tzinfo=JST) + timedelta(minutes=minute)
        arrived = datetime.fromisoformat(legs[-1].arrival_at)
        if arrived.tzinfo is None:
            arrived = arrived.replace(tzinfo=JST)
        minutes = ceil((arrived - requested).total_seconds() / 60)
        if minutes < 0:
            raise ValueError("Arrival before requested departure")
        timed = True
        departure = legs[0].departure_at or departure
        arrival = legs[-1].arrival_at
    elif minutes is not None and departure:
        parsed = time.fromisoformat(departure)
        first = parsed.hour * 60 + parsed.minute
        minutes += (first - minute % 1440) % 1440
        timed = True
    return RouteTimelineTransit(from_name=a.name, to_name=b.name, duration_minutes=minutes,
        is_estimate=minutes is None or not timed, fare_yen=getattr(result, "fare_yen", None), legs=legs,
        start_time=departure, end_time=arrival, transit_line=" / ".join(dict.fromkeys(l.line_name for l in legs)))


async def schedule(payload: AuditRequest, stops: list[AuditStop], checks: dict[str, VenueCheck], repair=False):
    cursor = payload.departure_time.hour * 60 + payload.departure_time.minute
    previous = payload.origin
    rows, legs, problems, unknown = [], [], [], []
    for stop in stops:
        try:
            leg = await transit(previous, stop.place, payload.departure_date, cursor)
            if leg.duration_minutes is None or leg.is_estimate:
                raise ValueError("Unknown travel")
        except Exception:
            unknown.append(f"{previous.name} → {stop.place.name}：移動時間未確認")
            return {"stops":rows,"transits":legs,"problems":problems,"unknown":unknown,"return_minute":None}
        legs.append(leg.model_dump())
        cursor += leg.duration_minutes
        target = stop.start if stop.locked else stop.anchor
        if target is not None:
            if cursor > target:
                problems.append(f"{stop.place.name}：指定した開始時刻に間に合いません。")
            cursor = max(cursor, target)
        evidence = checks[stop.place.id]
        windows = evidence.windows
        if repair and not stop.locked and target is None and windows:
            fitting = [max(cursor, a) for a,b in windows if max(cursor,a) + stop.dwell <= b]
            if fitting:
                cursor = min(fitting)
        if evidence.business in {"closed", "temporary"}:
            problems.append(f"{stop.place.name}：閉業または一時休業の登録があります。")
        elif evidence.business == "unknown":
            unknown.append(f"{stop.place.name}：営業状態未確認")
        if windows is None:
            unknown.append(f"{stop.place.name}：訪問日の営業時間未確認")
        elif not any(a <= cursor and cursor + stop.dwell <= b for a,b in windows):
            problems.append(f"{stop.place.name}：滞在が営業時間に収まりません。")
        rows.append({"id":stop.place.id,"start":cursor,"end":cursor + stop.dwell})
        cursor += stop.dwell
        previous = stop.place
    try:
        leg = await transit(previous, payload.return_to, payload.departure_date, cursor)
        if leg.duration_minutes is None or leg.is_estimate:
            raise ValueError("Unknown return")
        cursor += leg.duration_minutes
        legs.append(leg.model_dump())
    except Exception:
        unknown.append("帰着地点までの移動時間未確認")
        cursor = None
    if cursor is not None and cursor > payload.departure_time.hour * 60 + payload.departure_time.minute + payload.available_minutes:
        problems.append("移動と滞在の合計が使える時間を超えています。")
    return {"stops":rows,"transits":legs,"problems":problems,"unknown":unknown,"return_minute":cursor}


async def audit(payload: AuditRequest):
    result = {"checked_at":datetime.now(JST).isoformat(),"checks":[],"original":None,"proposal":None,"actions":[],"note":"情報は取得時点の登録内容です。臨時変更や最終入場時刻は施設へご確認ください。"}
    try:
        async with asyncio.timeout(100):
            # At most two simultaneous venue checks, eight places, two route passes.
            semaphore = asyncio.Semaphore(2)
            async def check(stop):
                async with semaphore:
                    return await venue_check(stop, payload.departure_date)
            evidence = await asyncio.gather(*(check(s) for s in payload.stops))
            result["checks"] = [e.model_dump() for e in evidence]
            checks = {e.place_id:e for e in evidence}
            result["actions"].append("施設名・位置を照合し、営業状態・訪問日の営業時間・公式の休業告知を確認しました。")
            original = await schedule(payload, payload.stops, checks)
            result["original"] = original
            result["actions"].append("出発時刻から各区間を順に検索し、帰着までの時間を点検しました。")
            if not original["problems"]:
                return result
            kept = [s for s in payload.stops if s.locked or (checks[s.place.id].business not in {"closed","temporary"} and checks[s.place.id].windows != [])]
            reasons = [f"{s.place.name}を今回の訪問から外す" for s in payload.stops if s not in kept]
            if original["return_minute"] is not None:
                over = original["return_minute"] - (payload.departure_time.hour*60 + payload.departure_time.minute + payload.available_minutes)
                over -= sum(s.dwell for s in payload.stops if s not in kept)
                for stop in reversed(kept[:]):
                    if over <= 0 or len(kept) <= 1:
                        break
                    if not stop.locked:
                        kept.remove(stop); over -= stop.dwell
                        reasons.append(f"時間枠に合わせて{stop.place.name}を今回の訪問から外す")
            if not kept:
                result["actions"].append("訪問できる施設が残らないため、自動修正を見送りました。")
                return result
            proposed = await schedule(payload, kept, checks, repair=True)
            result["actions"].append("固定した施設と滞在時間を守り、開館待ち・訪問数の調整後に全区間を再検索しました（修正は1回まで）。")
            if not proposed["problems"] and not proposed["unknown"] and all(row["start"] < 1440 for row in proposed["stops"]):
                proposed["reasons"] = reasons + ["営業時間に合わせた開始時刻と、再検索した移動時間を反映します。"]
                result["proposal"] = proposed
            else:
                result["actions"].append("修正後も問題または未確認項目が残るため、採用可能な変更案は提示しません。")
    except TimeoutError:
        result["actions"].append("確認の時間上限に達しました。未完了の確認を成立とは扱いません。")
    return result
