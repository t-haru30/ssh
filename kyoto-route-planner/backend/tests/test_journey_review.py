import asyncio
from datetime import date
import unittest
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from app import journey_review as review
from app.models import Place
from app.official_place_info import OfficialPlaceInfo
from app.venue_evidence import VenueEvidence, EvidenceSource, EvidenceCitation


def place(index):
    return Place(id=str(index), name="施設" + str(index), category="博物館", description="",
                 access_point="", latitude=35, longitude=135, themes=["history"])


def request(count=3):
    return review.JourneyReviewRequest(places=[place(i) for i in range(count)], departure_date=date(2026, 10, 12))


def description(complete=False):
    return OfficialPlaceInfo(status="verified", note="fixture",
        opening_hours="9–17" if complete else None, closed_days="月曜日" if complete else None,
        admission="500円" if complete else None)


class JourneyReviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.source = patch.object(review, "fetch_official_place_info", new=AsyncMock(return_value=description()))
        self.search = patch.object(review, "fetch_venue_evidence", new=AsyncMock(return_value=VenueEvidence(
            place_id="0", status="ready", text="公式案内を確認してください。",
            sources=[EvidenceSource(number=1, title="公式", url="https://museum.example/")],
            citations=[EvidenceCitation(end=4, sources=[1])], search_suggestions_html="")))
        self.enabled = patch.object(review, "configured", return_value=True)
        self.source_mock = self.source.start()
        self.search_mock = self.search.start()
        self.enabled.start()
        self.addCleanup(self.source.stop)
        self.addCleanup(self.search.stop)
        self.addCleanup(self.enabled.stop)
        self.gate = patch.object(review, "_reviews", asyncio.Semaphore(1))
        self.gate.start()
        self.addCleanup(self.gate.stop)

    async def test_free_checks_first_then_at_most_two_searches_for_three_places(self):
        order = []
        async def source(p):
            order.append("source" + p.id)
            return description()
        async def search(p, *, official):
            self.assertTrue(official)
            order.append("search" + p.id)
            return VenueEvidence(place_id=p.id, status="unverified")
        self.source_mock.side_effect = source
        self.search_mock.side_effect = search
        result = await review.review_journey(request(8))
        self.assertEqual(order, ["source0", "source1", "source2", "search0", "search1"])
        self.assertEqual((result.remaining_count, result.ai_searches, len(result.results)), (5, 2, 3))
        self.assertEqual(result.results[-1].steps[-1].status, "skipped")

    async def test_complete_official_fields_skip_paid_search(self):
        self.source_mock.return_value = description(True)
        result = await review.review_journey(request(1))
        self.search_mock.assert_not_awaited()
        self.assertEqual(result.results[0].missing_fields, [])
        self.assertEqual(result.results[0].steps[0].status, "ready")

    async def test_disabled_ai_still_reads_sources(self):
        with patch.object(review, "configured", return_value=False):
            result = await review.review_journey(request())
        self.assertEqual(self.source_mock.await_count, 3)
        self.search_mock.assert_not_awaited()
        self.assertEqual(result.ai_searches, 0)

    async def test_search_preserves_citations_without_treating_text_as_verified_fields(self):
        result = await review.review_journey(request(1))
        item = result.results[0]
        self.assertEqual(item.evidence.citations[0].sources, [1])
        self.assertEqual(item.missing_fields, list(review.FIELDS))
        self.assertEqual(item.steps[-1].status, "needs_check")

    async def test_timeout_keeps_partial_source_and_releases_review_slot(self):
        cancelled = asyncio.Event()
        async def never(*args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        self.search_mock.side_effect = never
        with patch.object(review, "TOTAL_SECONDS", 0.03), patch.object(review, "SEARCH_SECONDS", 0.01):
            result = await review.review_journey(request(1))
        self.assertIsNotNone(result.results[0].official)
        self.assertEqual(result.results[0].steps[-1].status, "unavailable")
        self.assertTrue(cancelled.is_set())
        self.assertFalse(review._reviews.locked())

    async def test_failure_does_not_expose_provider_error_or_prevent_other_sources(self):
        self.source_mock.side_effect = [ValueError("secret-provider-body"), description(True)]
        self.search_mock.side_effect = ValueError("secret-key")
        result = await review.review_journey(request(2))
        self.assertEqual(result.results[0].steps[0].status, "unavailable")
        self.assertEqual(result.results[1].missing_fields, [])
        self.assertNotIn("secret", result.model_dump_json())

    async def test_cancellation_releases_review_slot(self):
        started = asyncio.Event()
        async def never(*args):
            started.set()
            await asyncio.Event().wait()
        self.source_mock.side_effect = never
        task = asyncio.create_task(review.review_journey(request(1)))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(review._reviews.locked())

    async def test_busy_review_wait_is_bounded_and_does_not_release_another_slot(self):
        await review._reviews.acquire()
        try:
            with patch.object(review, "TOTAL_SECONDS", 0.01):
                result = await review.review_journey(request(1))
            self.source_mock.assert_not_awaited()
            self.search_mock.assert_not_awaited()
            self.assertTrue(review._reviews.locked())
            self.assertEqual(result.results[0].steps[0].status, "unavailable")
        finally:
            review._reviews.release()

    def test_input_requires_one_to_eight_places_and_valid_date(self):
        for count in (0, 9):
            with self.assertRaises(ValidationError):
                request(count)


class JourneyReviewEndpointTests(unittest.TestCase):
    def test_endpoint_serializes_review_and_rejects_empty_places(self):
        from fastapi.testclient import TestClient
        from app.main import app
        payload = request(1)
        response = review.JourneyReviewResponse(checked_at="2026-10-12T00:00:00+00:00",
            departure_date=payload.departure_date, results=[], remaining_count=1,
            ai_searches=0, elapsed_ms=1, note="fixture")
        with patch("app.main.limiter.enabled", False), patch("app.main.review_journey", new=AsyncMock(return_value=response)) as agent:
            with TestClient(app) as client:
                result = client.post("/api/journey/review", json=payload.model_dump(mode="json"))
                invalid = client.post("/api/journey/review", json={"places": [], "departure_date": "2026-10-12"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["departure_date"], "2026-10-12")
        self.assertEqual(invalid.status_code, 422)
        agent.assert_awaited_once()
