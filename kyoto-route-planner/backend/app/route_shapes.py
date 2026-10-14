"""Fetch Ekispert geometry only when the traveller selects the route map."""
import asyncio
import math
import os
import ssl
from uuid import uuid4
import httpx
from app.cache import TTLCache

_courses = TTLCache(900, 256)
_shapes = TTLCache(900, 256)

def register_course(course: dict) -> str | None:
    serialized = course.get("SerializeData")
    if not isinstance(serialized, str) or not 1 <= len(serialized) <= 30000:
        return None
    token = uuid4().hex
    _courses.set(token, serialized)
    return token

def parse_shapes(payload: dict) -> list[dict]:
    from app.ekispert import _as_list, _text
    course = payload.get("ResultSet", {}).get("Course", {})
    if not isinstance(course, dict):
        return []
    result = []
    count = 0
    for pattern in _as_list(course.get("OperationLinePattern")):
        for line in _as_list(pattern.get("Line")):
            coordinates = []
            for point in _as_list(line.get("Shape")):
                geo = point.get("GeoPoint", {})
                try:
                    lat, lng = float(geo["lati_d"]), float(geo["longi_d"])
                    if geo.get("gcs") != "wgs84" or not math.isfinite(lat) or not math.isfinite(lng) or not -90 <= lat <= 90 or not -180 <= lng <= 180:
                        return []
                except (ValueError, TypeError, KeyError):
                    return []
                count += 1
                if count > 10000:
                    return []
                if not coordinates or coordinates[-1] != [lat, lng]:
                    coordinates.append([lat,lng])
            if len(coordinates) >= 2:
                mode = _text(line.get("Type")) or "other"
                result.append({"line_name":_text(line.get("Name")), "mode":mode, "coordinates":coordinates, "approximate":mode != "train"})
    return result

async def course_shape(token: str) -> dict:
    hit, cached = _shapes.get(token)
    if hit:
        return cached
    hit, serialized = _courses.get(token)
    unavailable = {"token":token,"segments":[],"status":"unavailable"}
    if not hit:
        return {**unavailable,"status":"expired"}
    key = os.getenv("EKISPERT_API_KEY", "").strip()
    if not key:
        return unavailable
    try:
        async with asyncio.timeout(8), httpx.AsyncClient(timeout=6, verify=ssl.create_default_context(), follow_redirects=False) as client:
            response = await client.get("https://api.ekispert.jp/v1/json/course/shape", params={"key":key,"serializeData":serialized,"type":"all"},
                headers={"Referer":os.getenv("EKISPERT_APPLICATION_URL", "http://127.0.0.1:8000")})
            if response.status_code != 200 or len(response.content) > 2000000:
                return {**unavailable,"reason":"access" if response.status_code == 403 else "provider"}
            segments = parse_shapes(response.json())
            if not segments:
                return unavailable
            result = {"token":token,"segments":segments,"status":"ready"}
            _shapes.set(token,result)
            return result
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
        return unavailable

async def fetch_shapes(tokens: list[str]) -> dict:
    semaphore = asyncio.Semaphore(2)
    async def one(token):
        async with semaphore:
            return await course_shape(token)
    results = await asyncio.gather(*(one(token) for token in dict.fromkeys(tokens)))
    return {"routes":results,"source":"駅すぱあと","note":"鉄道は線路に沿った経路、バスは停留所間、徒歩は接続地点間の目安です。施設と最寄り駅の間の道順は含みません。"}
