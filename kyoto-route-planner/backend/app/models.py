from datetime import date, time
from typing import Annotated, Literal, Union
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator, model_validator

Theme = Literal["all", "history", "temple", "nature", "food"]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
Coordinate = tuple[Latitude, Longitude]

class Place(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(max_length=100)
    description: str = Field(max_length=2000)
    access_point: str = Field(max_length=500)
    latitude: Latitude
    longitude: Longitude
    themes: list[Theme] = Field(max_length=10)
    address: str = Field(default="", max_length=500)
    tags: dict[str, str] = Field(default_factory=dict)

class Origin(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    latitude: Latitude
    longitude: Longitude

class RouteSuggestionRequest(BaseModel):
    origin: str = Field(min_length=1, max_length=80)
    theme: Theme = "all"
    stop_count: int = Field(default=3, ge=1, le=3)
    departure_date: date
    departure_time: time
    variation: int = Field(default=0, ge=0, le=2_147_483_647)

class RouteLeg(BaseModel):
    from_name: str = Field(min_length=1, max_length=200)
    to_name: str = Field(min_length=1, max_length=200)
    line_name: str = Field(min_length=1, max_length=200)
    mode: str = Field(min_length=1, max_length=80)
    duration_minutes: int | None = Field(default=None, ge=0)

class RouteTimelineSpot(BaseModel):
    type: Literal["spot"] = "spot"
    role: Literal["start", "stop", "finish"]
    place_id: str | None = None
    name: str
    category: str = ""
    time: str | None = None
    stay_minutes: int = 0

class RouteTimelineTransit(BaseModel):
    type: Literal["transit"] = "transit"
    from_name: str
    to_name: str
    mode: Literal["public_transport"] = "public_transport"
    start_time: str | None = None
    end_time: str | None = None
    duration_minutes: int | None = None
    is_estimate: bool = True

RouteTimelineItem = Annotated[
    Union[RouteTimelineSpot, RouteTimelineTransit],
    Field(discriminator="type"),
]

class RouteSuggestion(BaseModel):
    places: list[Place]
    origin: Origin
    legs: list[RouteLeg]
    title: str | None = None
    story: str | None = None
    total_minutes: int | None = None
    departure_time: str | None = None
    arrival_time: str | None = None
    timeline: list[RouteTimelineItem] = Field(default_factory=list)
    note: str
    coordinates: list[Coordinate] = Field(default_factory=list, max_length=1000)

class RouteSuggestions(BaseModel):
    routes: list[RouteSuggestion] = Field(min_length=1, max_length=3)

class RouteIdeaResponse(BaseModel):
    theme: Theme
    prefecture_code: str | None = Field(default=None, pattern=r"^(0[1-9]|[1-3][0-9]|4[0-7])$")
    prefecture_name: str | None = Field(default=None, min_length=1, max_length=10)
    title: str = Field(min_length=1)
    story: str = Field(min_length=1)
    places: list[Place] = Field(min_length=2, max_length=3)
    image_url: str | None = Field(default=None, max_length=2048)
    author_name: str | None = Field(default=None, max_length=300)
    source_url: str | None = Field(default=None, max_length=2048)
    license_name: str | None = Field(default=None, max_length=120)
    license_url: str | None = Field(default=None, max_length=2048)
    copywriting_source: Literal["gemini", "fallback"]
    note: str

    @field_validator("image_url", "source_url", "license_url")
    @classmethod
    def validate_https_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("image and attribution URLs must be absolute HTTPS URLs")
        return value

    @model_validator(mode="after")
    def validate_image_attribution(self):
        if self.image_url is not None and not all((
            self.author_name,
            self.source_url,
            self.license_name,
            self.license_url,
        )):
            raise ValueError("commercial images require author, source, and license attribution")
        return self

    @model_validator(mode="after")
    def validate_prefecture_tag(self):
        if (self.prefecture_code is None) != (self.prefecture_name is None):
            raise ValueError("prefecture code and name must be provided together")
        return self

class RouteIdeaBatchResponse(BaseModel):
    ideas: list[RouteIdeaResponse] = Field(min_length=1, max_length=10)
    requested_count: int = Field(ge=1, le=10)
    shortfall: int = Field(ge=0, le=10)
    used_fallback: bool
    fallback_count: int = Field(ge=0, le=10)

class LabelPreference(BaseModel):
    label_type: Literal["atmosphere", "target_audience", "activity_type"]
    label: str

class ParsedPlaceQuery(BaseModel):
    region: str | None = None
    location_unresolved: bool = False
    category: str | None = None
    keywords: list[str] = Field(default_factory=list)
    preferences: list[LabelPreference] = Field(default_factory=list)
    center_station: str | None = None
    center_latitude: Latitude | None = None
    center_longitude: Longitude | None = None
    max_distance_m: int | None = None
    warnings: list[str] = Field(default_factory=list)

class PlaceSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)

class CatalogPlace(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(max_length=100)
    region: str = Field(max_length=100)
    address: str = Field(max_length=500)
    latitude: Latitude
    longitude: Longitude
    description: str = Field(max_length=2000)
    source_record_id: str | None = None
    genre_code: str = ""
    tags: dict[str, str] = Field(default_factory=dict)

class PlaceSearchHit(BaseModel):
    place: CatalogPlace
    score: float
    distance_m: int | None = None

class PlaceSearchResponse(BaseModel):
    query: ParsedPlaceQuery
    results: list[PlaceSearchHit]
    note: str

class ItineraryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    departure_station: str = Field(min_length=1, max_length=80)
    departure_date: date
    departure_time: time
    stop_count: int = Field(default=3, ge=1, le=3)
    selected_places: list[CatalogPlace] | None = Field(default=None, min_length=1, max_length=3)
    return_by: time = time(18, 0)
    stay_minutes_per_place: int = Field(default=90, ge=0, le=360)

class ItinerarySuggestion(BaseModel):
    query: ParsedPlaceQuery
    origin: Origin
    places: list[CatalogPlace]
    legs: list[RouteLeg]
    departure_at: str
    estimated_return_at: str | None = None
    return_by: str
    transit_minutes: int | None = None
    stay_minutes: int
    estimated_total_minutes: int | None = None
    feasible: bool | None = None
    route_search_calls: int
    note: str
    coordinates: list[Coordinate] = Field(default_factory=list, max_length=1000)

class OvernightItineraryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    departure_station: str = Field(min_length=1, max_length=80)
    departure_date: date
    departure_time: time = time(9, 0)
    stops_per_day: int = Field(default=2, ge=1, le=3)
    hotel_query: str | None = Field(default=None, max_length=100)

class DailyItinerary(BaseModel):
    day: int
    date: date
    places: list[CatalogPlace]
    legs: list[RouteLeg]
    schedule: list["ItineraryScheduleItem"] = Field(default_factory=list)
    lunch: "LunchPlan"
    transit_minutes: int | None = None
    stay_minutes: int
    estimated_arrival_at: str | None = None
    coordinates: list[Coordinate] = Field(default_factory=list, max_length=1000)

class ItineraryScheduleItem(BaseModel):
    start_time: str | None = None
    end_time: str | None = None
    title: str
    detail: str
    kind: Literal["travel", "visit", "hotel", "lunch"]

class LunchPlan(BaseModel):
    type: Literal["lunch"] = "lunch"
    place: CatalogPlace | None = None
    start_time: str = "12:00"
    end_time: str = "13:00"
    reason: str

class OvernightItinerarySuggestion(BaseModel):
    query: ParsedPlaceQuery
    origin: Origin
    hotel: CatalogPlace
    days: list[DailyItinerary]
    feasible: bool = True
    route_search_calls: int
    note: str
