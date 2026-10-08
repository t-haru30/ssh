import sys

def fix_indentation(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    new_lines = []
    for line in lines:
        stripped = line.lstrip()
        if not stripped:
            new_lines.append('\n')
            continue
        
        # Calculate current indent level based on common Python structure
        # This is a bit naive but we can target specific lines that were broken
        if stripped.startswith(('class ', 'def ', 'from ', 'import ', 'Theme =')):
            new_lines.append(stripped)
        else:
            new_lines.append('    ' + stripped)
            
    with open(filepath, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

# A safer approach: manually rewrite the file content to be absolutely sure
content = """from datetime import date, time
from typing import Literal

from pydantic import BaseModel, Field

Theme = Literal["all", "history", "temple", "nature", "food"]

class Place(BaseModel):
    id: str
    name: str
    category: str
    description: str
    access_point: str
    latitude: float
    longitude: float
    themes: list[Theme]
    address: str = ""
    tags: dict[str, str] = Field(default_factory=dict)

class Origin(BaseModel):
    name: str
    latitude: float
    longitude: float

class RouteSuggestionRequest(BaseModel):
    origin: str = Field(min_length=1, max_length=80)
    theme: Theme = "all"
    stop_count: int = Field(default=3, ge=1, le=3)
    departure_date: date
    departure_time: time
    variation: int = Field(default=0, ge=0, le=2_147_483_647)

class RouteLeg(BaseModel):
    from_name: str
    to_name: str
    line_name: str
    mode: str
    duration_minutes: int | None = None

class RouteSuggestion(BaseModel):
    places: list[Place]
    origin: Origin
    legs: list[RouteLeg]
    title: str | None = None
    story: str | None = None
    total_minutes: int | None = None
    departure_time: str | None = None
    arrival_time: str | None = None
    note: str
    coordinates: list[list[float]] = Field(default_factory=list)

class RouteSuggestions(BaseModel):
    routes: list[RouteSuggestion] = Field(min_length=1, max_length=3)

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
    center_latitude: float | None = None
    center_longitude: float | None = None
    max_distance_m: int | None = None
    warnings: list[str] = Field(default_factory=list)

class PlaceSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)

class CatalogPlace(BaseModel):
    id: str
    name: str
    category: str
    region: str
    address: str
    latitude: float
    longitude: float
    description: str
    source_record_id: str | None = None

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
    coordinates: list[list[float]] = Field(default_factory=list)

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
    transit_minutes: int | None = None
    stay_minutes: int
    estimated_arrival_at: str | None = None
    coordinates: list[list[float]] = Field(default_factory=list)

class OvernightItinerarySuggestion(BaseModel):
    query: ParsedPlaceQuery
    origin: Origin
    hotel: CatalogPlace
    days: list[DailyItinerary]
    feasible: bool = True
    route_search_calls: int
    note: str
"""

with open('app/models.py', 'w', encoding='utf-8') as f:
    f.write(content)
