"""Display-only Places information. Never copied to the OSM catalog or saved plans."""
import asyncio
import math
import ssl
import httpx
from pydantic import BaseModel, Field
from app.models import Place
from app.google_place_photos import BASE, google_api_key, same_google_venue, reserve_lookup, safe_url
from app.official_place_info import OfficialPlaceInfo, _basic_url, fetch_matched_official_info

class GoogleVenueInfo(BaseModel):
    place_id: str
    status: str = "unavailable"
    google_place_id: str | None = None
    summary: str = ""
    category: str = ""
    primary_type: str = ""
    rating: float | None = None
    rating_count: int | None = None
    business_status: str = "unknown"
    opening_hours: list[str] = Field(default_factory=list)
    source_url: str | None = None
    display_name: str = ""
    address: str = ""
    website_url: str | None = None
    official: OfficialPlaceInfo | None = None

async def fetch_google_info(place: Place, include_official: bool = False) -> GoogleVenueInfo:
    unavailable = GoogleVenueInfo(place_id=place.id)
    key = google_api_key()
    if not key or not reserve_lookup():
        return unavailable
    try:
        async with asyncio.timeout(8), httpx.AsyncClient(timeout=6, trust_env=False, follow_redirects=False, verify=ssl.create_default_context()) as client:
            response = await client.post(BASE + "/places:searchText", headers={"X-Goog-Api-Key":key,
                "X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.editorialSummary,places.rating,places.userRatingCount,places.businessStatus,places.regularOpeningHours,places.googleMapsUri,places.websiteUri"},
                json={"textQuery":place.name + " " + place.address,"languageCode":"ja","pageSize":3,
                      "locationBias":{"circle":{"center":{"latitude":place.latitude,"longitude":place.longitude},"radius":500.0}}})
            if response.status_code != 200 or len(response.content) > 100000:
                return unavailable
            matches = []
            for item in response.json().get("places", [])[:3]:
                if same_google_venue(place, item):
                    matches.append(item)
            if len(matches) != 1 or not safe_url(matches[0].get("googleMapsUri")):
                return unavailable
            item = matches[0]
            rating = item.get("rating")
            count = item.get("userRatingCount")
            summary = item.get("editorialSummary", {}).get("text", "")
            website = None
            try:
                website = _basic_url(item.get("websiteUri"))
            except ValueError:
                pass
            result = GoogleVenueInfo(place_id=place.id, status="ready", google_place_id=item.get("id"),
                display_name=str(item.get("displayName", {}).get("text", ""))[:200],
                address=str(item.get("formattedAddress", ""))[:500], website_url=website,
                summary=summary if isinstance(summary,str) and len(summary)<=2000 else "",
                category=str(item.get("primaryTypeDisplayName", {}).get("text", ""))[:100], primary_type=str(item.get("primaryType", ""))[:100],
                rating=rating if type(rating) in (int, float) and math.isfinite(rating) and 0 <= rating <= 5 else None,
                rating_count=count if type(count) is int and count >= 0 else None,
                business_status={"OPERATIONAL":"operational","CLOSED_PERMANENTLY":"closed","CLOSED_TEMPORARILY":"temporary"}.get(item.get("businessStatus"), "unknown"),
                opening_hours=[s for s in item.get("regularOpeningHours", {}).get("weekdayDescriptions", [])[:7] if isinstance(s,str) and len(s)<=300],
                source_url=safe_url(item.get("googleMapsUri")))
        # Only opened details read the matched website. No additional Places
        # request, no client-supplied URL and no Google-content cache/database.
        if include_official and website:
            result.official = await fetch_matched_official_info(place, website)
        return result
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError, AttributeError):
        return unavailable

async def fetch_google_infos(places: list[Place], include_official: bool = False) -> list[GoogleVenueInfo]:
    semaphore = asyncio.Semaphore(2)
    async def one(place):
        async with semaphore:
            return await fetch_google_info(place, include_official)
    return await asyncio.gather(*(one(p) for p in places))
