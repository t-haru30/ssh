"""Identity checks for official URL discovery; these sources never supply hours."""
from math import asin, cos, isfinite, radians, sin, sqrt
from functools import wraps
import re
import unicodedata

from app.models import Place


def _structured(reader):
    @wraps(reader)
    def checked(*args):
        try:
            return reader(*args)
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            return None
    return checked


def normalize(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def nearby(place: Place, latitude, longitude) -> bool:
    if type(latitude) not in (int, float) or type(longitude) not in (int, float):
        return False
    if not isfinite(latitude) or not isfinite(longitude) or abs(latitude) > 90 or abs(longitude) > 180:
        return False
    h = sin(radians(latitude - place.latitude) / 2) ** 2 + cos(radians(latitude)) * cos(radians(place.latitude)) * sin(radians(longitude - place.longitude) / 2) ** 2
    return 6371000 * 2 * asin(sqrt(min(1, h))) <= 500


@_structured
def osm_element(payload: object, place: Place, kind: str, identifier: int) -> dict | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        return None
    elements = payload["elements"]
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != kind or element.get("id") != identifier:
            continue
        tags = element.get("tags")
        if not isinstance(tags, dict) or not any(isinstance(tags.get(key), str) and normalize(tags[key]) == normalize(place.name) for key in ("name", "name:ja", "official_name")):
            continue
        center = element.get("center", element)
        if isinstance(center, dict) and nearby(place, center.get("lat"), center.get("lon")):
            return element
        # /full includes the actual nodes for a way/relation, unlike /way.json.
        if kind not in ("way", "relation"):
            continue
        ids = element.get("nodes") if kind == "way" else None
        nodes = [node for node in elements if isinstance(node, dict) and node.get("type") == "node"
                 and (ids is None or node.get("id") in ids)
                 and type(node.get("lat")) in (int, float) and type(node.get("lon")) in (int, float)
                 and isfinite(node["lat"]) and isfinite(node["lon"])
                 and -90 <= node["lat"] <= 90 and -180 <= node["lon"] <= 180]
        if not nodes or (kind == "way" and (not isinstance(ids, list) or {n["id"] for n in nodes} != set(ids))):
            continue
        latitude = (min(n["lat"] for n in nodes) + max(n["lat"] for n in nodes)) / 2
        longitude = (min(n["lon"] for n in nodes) + max(n["lon"] for n in nodes)) / 2
        if nearby(place, latitude, longitude):
            return element
    return None


@_structured
def wikidata_website(payload: object, item: str, place: Place) -> str | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("entities"), dict):
        return None
    entity = payload["entities"].get(item)
    if not isinstance(entity, dict) or entity.get("id") != item:
        return None
    label = entity.get("labels", {}).get("ja", {}).get("value", "")
    aliases = entity.get("aliases", {}).get("ja", [])
    names = [label] + [alias.get("value", "") for alias in aliases if isinstance(alias, dict)]
    if not any(isinstance(name, str) and normalize(name) == normalize(place.name) for name in names):
        return None
    claims = entity.get("claims", {})
    def value(claim):
        return claim.get("mainsnak", {}).get("datavalue", {}).get("value") if isinstance(claim, dict) and claim.get("rank") != "deprecated" else None
    coordinates = [value(claim) for claim in claims.get("P625", [])]
    if not any(isinstance(coord, dict) and coord.get("globe", "http://www.wikidata.org/entity/Q2").endswith("/Q2")
               and nearby(place, coord.get("latitude"), coord.get("longitude")) for coord in coordinates):
        return None
    match = re.fullmatch(r"osm-node-(\d+)", place.id)
    reciprocal = [value(claim) for claim in claims.get("P11693", []) if value(claim)]
    if match and reciprocal and match[1] not in reciprocal:
        return None
    websites = [claim for claim in claims.get("P856", []) if isinstance(value(claim), str)
                and not claim.get("qualifiers", {}).get("P582")]
    def priority(claim):
        languages = [qualifier.get("datavalue", {}).get("value", {}).get("id")
                     for qualifier in claim.get("qualifiers", {}).get("P407", []) if isinstance(qualifier, dict)]
        return (bool(languages) and "Q5287" not in languages, claim.get("rank") != "preferred")
    websites.sort(key=priority)
    return value(websites[0]) if websites else None


@_structured
def wikipedia_website(payload: object, place: Place) -> str | None:
    if not isinstance(payload, dict) or "error" in payload or not isinstance(payload.get("query"), dict):
        return None
    query = payload["query"]
    pages = query.get("pages", [])
    if not isinstance(pages, list) or len(pages) != 1 or not isinstance(pages[0], dict):
        return None
    page = pages[0]
    title = normalize(place.name)
    for redirect in query.get("redirects", []):
        if isinstance(redirect, dict) and normalize(redirect.get("from", "")) == title:
            title = normalize(redirect.get("to", ""))
    if (page.get("ns") != 0 or "missing" in page or "disambiguation" in page.get("pageprops", {})
            or normalize(page.get("title", "")) != title):
        return None
    points = page.get("coordinates", [])
    if not isinstance(points, list) or len(points) != 1 or not isinstance(points[0], dict):
        return None
    point = points[0]
    if point.get("globe", "earth") != "earth" or not nearby(place, point.get("lat"), point.get("lon")):
        return None
    revisions = page.get("revisions", [])
    if not isinstance(revisions, list) or not revisions or not isinstance(revisions[0], dict):
        return None
    content = revisions[0].get("slots", {}).get("main", {}).get("content", "")
    if not isinstance(content, str):
        return None
    for field in re.finditer(r"^\|\s*(?:公式サイト|公式HP|ウェブサイト|ホームページ|URL|website)\s*=\s*([^\n]+)", content, re.I | re.M):
        url = re.search(r"https?://[^\s\]|}<]+", field[1])
        if url:
            return url[0]
    # Some matched articles have no website field in their infobox. Accept
    # only an explicitly marked official-site link with the exact venue name
    # in the external-links section, never citations or another institution.
    section = re.search(r"^==\s*外部リンク\s*==\s*\n(.*?)(?=^==|\Z)", content, re.M | re.S)
    if section:
        for line in section[1].splitlines():
            link = re.fullmatch(r"\*\s*\[(https?://[^\s\]]+)\s+([^\]]+)\]\s*[（(]公式(?:サイト|ホームページ|ウェブサイト)[）)]\s*", line)
            if link and normalize(link[2]) == normalize(place.name):
                return link[1]
    return None
