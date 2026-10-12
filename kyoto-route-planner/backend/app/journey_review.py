"""Bounded departure-information review; grounded responses are never persisted."""
import asyncio
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

from app.models import Place
from app.official_place_info import OfficialPlaceInfo, fetch_official_place_info
from app.venue_evidence import VenueEvidence, configured, fetch_venue_evidence

TOTAL_SECONDS = 45.0
OFFICIAL_SECONDS = 7.0
SEARCH_SECONDS = 12.0
MAX_PLACES = 3
MAX_SEARCHES = 2
_reviews = asyncio.Semaphore(1)
FIELDS = ("opening_hours", "closed_days", "admission")


class JourneyReviewRequest(BaseModel):
    places: list[Place] = Field(min_length=1, max_length=8)
    departure_date: date


class ReviewStep(BaseModel):
    label: str
    status: Literal["ready", "needs_check", "unavailable", "skipped"]


class PlaceReview(BaseModel):
    place_id: str
    place_name: str
    official: OfficialPlaceInfo | None = None
    evidence: VenueEvidence | None = None
    steps: list[ReviewStep] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=lambda: list(FIELDS))


class JourneyReviewResponse(BaseModel):
    checked_at: str
    departure_date: date
    results: list[PlaceReview]
    remaining_count: int
    ai_searches: int
    elapsed_ms: int
    note: str


async def review_journey(payload: JourneyReviewRequest) -> JourneyReviewResponse:
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + TOTAL_SECONDS
    selected = payload.places[:MAX_PLACES]
    results = [PlaceReview(place_id=p.id, place_name=p.name) for p in selected]
    searches = 0
    acquired = False
    try:
        try:
            await asyncio.wait_for(_reviews.acquire(), max(0.001, deadline - loop.time()))
            acquired = True
        except TimeoutError:
            for result in results:
                result.steps.append(ReviewStep(label="確認待ちの時間上限", status="unavailable"))
        if acquired:
            # Give every selected venue a free source check before spending on search.
            for place, result in zip(selected, results):
                remaining = deadline - loop.time()
                if remaining <= 0:
                    result.steps.append(ReviewStep(label="公式情報の確認（時間上限）", status="skipped"))
                    continue
                try:
                    result.official = await asyncio.wait_for(fetch_official_place_info(place), min(OFFICIAL_SECONDS, remaining))
                    if result.official and result.official.status == "verified":
                        result.missing_fields = [field for field in FIELDS if not getattr(result.official, field)]
                    status = "needs_check" if result.missing_fields else "ready"
                    if not result.official or result.official.status not in ("verified", "link_only"):
                        status = "unavailable"
                    result.steps.append(ReviewStep(label="公式ページの情報を確認", status=status))
                except Exception:
                    result.steps.append(ReviewStep(label="公式ページの取得失敗・時間上限", status="unavailable"))
            for place, result in zip(selected, results):
                if not result.missing_fields:
                    result.steps.append(ReviewStep(label="項目がそろっているため追加検索を省略", status="skipped"))
                    continue
                if not configured():
                    result.steps.append(ReviewStep(label="AI検索が無効のため省略", status="skipped"))
                    continue
                remaining = deadline - loop.time()
                if searches >= MAX_SEARCHES or remaining <= 0:
                    result.steps.append(ReviewStep(label="検索回数・時間の上限により省略", status="skipped"))
                    continue
                searches += 1
                try:
                    result.evidence = await asyncio.wait_for(fetch_venue_evidence(place, official=True), min(SEARCH_SECONDS, remaining))
                    usable = bool(result.evidence.status == "ready" and result.evidence.sources and result.evidence.citations)
                    result.steps.append(ReviewStep(label="不足項目を出典付き検索で確認", status="needs_check" if usable else "unavailable"))
                except Exception:
                    result.steps.append(ReviewStep(label="出典付き検索の取得失敗・時間上限", status="unavailable"))
    finally:
        if acquired:
            _reviews.release()
    return JourneyReviewResponse(
        checked_at=datetime.now(timezone.utc).isoformat(), departure_date=payload.departure_date,
        results=results, remaining_count=len(payload.places) - len(selected), ai_searches=searches,
        elapsed_ms=round((loop.time() - started) * 1000),
        note="先頭3施設まで、公式情報を先に確認し、不足時のみ最大2回検索します。出発日は確認の参考情報です。当日の営業や旅程の実行を保証しません。検索結果の出典を開き、臨時休館・最終入館・予約条件をご確認ください。",
    )
