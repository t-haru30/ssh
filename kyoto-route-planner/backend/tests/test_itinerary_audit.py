import unittest
from datetime import date, time
from unittest.mock import AsyncMock, patch
from app.itinerary_audit import AuditRequest, AuditStop, VenueCheck, audit, opening_windows, transit
from app.models import Place, Origin, RouteTimelineTransit, RouteLeg
from app.official_place_info import OfficialPlaceInfo, ClosureNotice
from app.itinerary_audit import venue_check, google_check
import httpx
import os


def place(id="museum"):
    return Place(id=id,name=id,category="博物館",description="",access_point="",latitude=35,longitude=135,themes=[])


def request(stops=None):
    return AuditRequest(origin=Origin(name="駅",latitude=35,longitude=135),return_to=Origin(name="駅",latitude=35,longitude=135),departure_date=date(2026,10,13),departure_time=time(9),available_minutes=360,stops=stops or [AuditStop(place=place(),dwell=60,start=550)])


def evidence(stop, day):
    return VenueCheck(place_id=stop.place.id,name=stop.place.name,business="operational",windows=[(600,1020)],confirmed_date=True)


async def leg(a,b,day,minute):
    return RouteTimelineTransit(from_name=a.name,to_name=b.name,duration_minutes=10,is_estimate=False,fare_yen=200)


class OpeningTests(unittest.TestCase):
    def test_date_periods_and_lunch_break(self):
        d={"year":2026,"month":10,"day":13}
        data={"currentOpeningHours":{"periods":[{"open":{"date":d,"hour":9},"close":{"date":d,"hour":12}},{"open":{"date":d,"hour":13},"close":{"date":d,"hour":17}}]}}
        self.assertEqual(opening_windows(data,date(2026,10,13),date(2026,10,13)),[(540,720),(780,1020)])
        self.assertIsNone(opening_windows(data,date(2026,10,20),date(2026,10,13)))

    def test_overnight_and_closed_day(self):
        data={"currentOpeningHours":{"periods":[{"open":{"date":{"year":2026,"month":10,"day":12},"hour":22},"close":{"date":{"year":2026,"month":10,"day":13},"hour":2}}]}}
        self.assertEqual(opening_windows(data,date(2026,10,13),date(2026,10,13)),[(0,120)])
        self.assertEqual(opening_windows(data,date(2026,10,14),date(2026,10,13)),[])

    def test_missing_or_undated_hours_are_unknown(self):
        self.assertIsNone(opening_windows({},date(2026,10,13),date(2026,10,13)))
        self.assertIsNone(opening_windows({"currentOpeningHours":{"periods":[{"open":{"day":2,"hour":9},"close":{"day":2,"hour":17}}]}},date(2026,10,13),date(2026,10,13)))

    def test_always_open(self):
        self.assertEqual(opening_windows({"currentOpeningHours":{"periods":[{"open":{"day":0,"hour":0,"minute":0}}]}},date(2026,10,13),date(2026,10,13)),[(0,1440)])


class AuditTests(unittest.IsolatedAsyncioTestCase):
    async def run_audit(self,payload,check=evidence,travel=leg):
        with patch("app.itinerary_audit.venue_check",side_effect=check),patch("app.itinerary_audit.transit",side_effect=travel) as routes:
            result=await audit(payload)
            self.assertLessEqual(routes.call_count,18)
            return result

    async def test_wait_for_opening_and_recheck_without_mutating_original(self):
        payload=request();before=payload.model_dump()
        result=await self.run_audit(payload)
        self.assertTrue(result["original"]["problems"])
        self.assertEqual(result["original"]["stops"][0]["start"],550)
        self.assertEqual(result["proposal"]["stops"][0]["start"],600)
        self.assertEqual(payload.model_dump(),before)

    async def test_locked_closed_facility_cannot_be_removed(self):
        def closed(s,d):return VenueCheck(place_id=s.place.id,name=s.place.name,business="closed",windows=[])
        result=await self.run_audit(request([AuditStop(place=place(),dwell=60,start=600,locked=True)]),closed)
        self.assertIsNone(result["proposal"])

    async def test_remove_closed_facility_and_research_changed_route(self):
        def check(s,d):return VenueCheck(place_id=s.place.id,name=s.place.name,business="closed" if s.place.id=="closed" else "operational",windows=[] if s.place.id=="closed" else [(0,1440)])
        result=await self.run_audit(request([AuditStop(place=place("closed"),dwell=60,start=550),AuditStop(place=place("open"),dwell=60,start=620)]),check)
        self.assertEqual([s["id"] for s in result["proposal"]["stops"]],["open"])
        self.assertEqual(len(result["proposal"]["transits"]),2)

    async def test_uncertain_hours_never_become_confirmed_proposal(self):
        def unknown(s,d):return VenueCheck(place_id=s.place.id,name=s.place.name,business="operational")
        result=await self.run_audit(request(),unknown)
        self.assertTrue(result["original"]["unknown"])
        self.assertIsNone(result["proposal"])

    async def test_failed_transit_does_not_become_zero_minutes(self):
        result=await self.run_audit(request(),travel=AsyncMock(side_effect=TimeoutError))
        self.assertIsNone(result["original"]["return_minute"])
        self.assertTrue(result["original"]["unknown"])
        self.assertIsNone(result["proposal"])

    async def test_lunch_break_full_dwell_must_fit(self):
        def check(s,d):return VenueCheck(place_id=s.place.id,name=s.place.name,business="operational",windows=[(540,570),(780,1020)])
        result=await self.run_audit(request(),check)
        self.assertEqual(result["proposal"]["stops"][0]["start"],780)

    async def test_overtime_does_not_shorten_stays_below_minimum(self):
        payload=request([AuditStop(place=place("a"),dwell=60,start=550),AuditStop(place=place("b"),dwell=60,start=620)])
        payload.available_minutes=100
        def check(s,d):return VenueCheck(place_id=s.place.id,name=s.place.name,business="operational",windows=[(0,1440)])
        result=await self.run_audit(payload,check)
        self.assertEqual(len(result["proposal"]["stops"]),1)
        self.assertEqual(result["proposal"]["stops"][0]["end"]-result["proposal"]["stops"][0]["start"],60)

    async def test_transit_waits_for_departure(self):
        a=Origin(name="a",latitude=35,longitude=135);b=Origin(name="b",latitude=35.01,longitude=135)
        with patch("app.itinerary_audit.search_route",new=AsyncMock(return_value=([],30,"09:20","09:50"))):
            result=await transit(a,b,date(2026,10,13),540)
        self.assertEqual(result.duration_minutes,50)

    async def test_official_dated_closure_overrides_google_hours(self):
        stop=request().stops[0]
        info=OfficialPlaceInfo(status="verified",note="",notices=[ClosureNotice(text="臨時休館",url="https://museum.example/notice",starts_on=date(2026,10,13),ends_on=date(2026,10,14))])
        with patch("app.itinerary_audit.google_check",new=AsyncMock(return_value=evidence(stop,date(2026,10,13)))),patch("app.itinerary_audit.fetch_official_place_info",new=AsyncMock(return_value=info)):
            result=await venue_check(stop,date(2026,10,13))
        self.assertEqual(result.windows,[])
        self.assertEqual(result.official_source,"https://museum.example/notice")

    async def test_leg_arrival_includes_wait_even_when_course_times_are_empty(self):
        a=Origin(name="a",latitude=35,longitude=135);b=Origin(name="b",latitude=35.01,longitude=135)
        legs=[RouteLeg(from_name="a",to_name="b",line_name="列車",mode="train",duration_minutes=26,departure_at="2026-10-14T10:27:00+09:00",arrival_at="2026-10-14T10:53:00+09:00")]
        with patch("app.itinerary_audit.search_route",new=AsyncMock(return_value=(legs,26,"",""))):
            result=await transit(a,b,date(2026,10,14),625)
        self.assertEqual(result.duration_minutes,28)
        self.assertFalse(result.is_estimate)

    async def test_duration_without_departure_or_arrival_is_only_an_estimate(self):
        with patch("app.itinerary_audit.search_route",new=AsyncMock(return_value=([],20,"",""))):
            result=await transit(Origin(name="a",latitude=35,longitude=135),Origin(name="b",latitude=35.01,longitude=135),date(2026,10,14),540)
        self.assertTrue(result.is_estimate)

    async def test_google_lookup_requires_identity_and_handles_closed_business(self):
        client=httpx.AsyncClient
        calls=[]
        def respond(r):
            calls.append(r)
            return httpx.Response(200,json={"places":[{"displayName":{"text":"museum"},"location":{"latitude":35,"longitude":135},"googleMapsUri":"https://maps.google.com/?cid=1","businessStatus":"CLOSED_PERMANENTLY"}]})
        with patch.dict(os.environ,{"GOOGLE_PLACES_API_KEY":"fixture"}),patch("app.itinerary_audit.reserve_lookup",return_value=True),patch("app.itinerary_audit.httpx.AsyncClient",side_effect=lambda **kw:client(transport=httpx.MockTransport(respond))):
            result=await google_check(place(),date(2026,10,13))
        self.assertEqual(result.business,"closed")
        self.assertIn("places.currentOpeningHours",calls[0].headers["X-Goog-FieldMask"])
        self.assertNotIn("fixture",result.model_dump_json())

    async def test_api_returns_no_store_and_never_applies_a_plan(self):
        from fastapi.testclient import TestClient
        from app.main import app
        result={"checks":[],"original":None,"proposal":None,"actions":[],"note":"fixture","checked_at":"2026-10-13T00:00:00+09:00"}
        with patch("app.main.audit_itinerary",new=AsyncMock(return_value=result)):
            response=TestClient(app).post("/api/itinerary/audit",json=request().model_dump(mode="json"))
        self.assertEqual(response.status_code,200)
        self.assertIn("no-store",response.headers["cache-control"])
