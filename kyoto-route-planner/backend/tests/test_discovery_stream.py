import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from app.discovery import DiscoverRequest, build_discover_routes, discover_route_events, _discover_catalog
from app.models import CatalogPlace
from app.restaurant_discovery import RestaurantDiscovery


def fixture():
    request=DiscoverRequest(area="kyoto",prefecture_name="京都府",origin={"name":"京都駅","latitude":35,"longitude":135.7},course="half_day",theme="history",meals=[])
    pool=tuple(CatalogPlace(id=f"p{i}",name=f"博物館{i}",category="博物館",region="京都府",address="",description="",latitude=35+i*.001,longitude=135.7) for i in range(4))
    return request,pool,build_discover_routes(request,pool)


class DiscoveryStreamTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        async def verified_fixture(request, candidates, existing_google=()):
            return tuple(candidates), {'status':'ready'}
        gate=patch('app.facility_quality.filter_quality',side_effect=verified_fixture)
        gate.start();self.addCleanup(gate.stop)
    async def test_first_deck_arrives_before_ai_finishes_without_a_second_catalog_lookup(self):
        request,pool,fallback=fixture()
        started,finish=asyncio.Event(),asyncio.Event()
        async def select(*args):
            started.set()
            await finish.wait()
            return {**fallback,"agent":{"status":"ready","message":"AIの候補"}}
        with patch("app.discovery._discover_catalog",new=AsyncMock(return_value=(fallback,pool))) as catalog, \
             patch("app.discovery._select_discover_routes",side_effect=select):
            stream=discover_route_events(request)
            first=await asyncio.wait_for(anext(stream),1)
            self.assertEqual(first["stage"],"initial")
            self.assertTrue(first["result"]["routes"])
            self.assertFalse(started.is_set())
            final=asyncio.create_task(anext(stream))
            await asyncio.wait_for(started.wait(),1)
            self.assertFalse(final.done())
            finish.set()
            self.assertEqual((await final)["result"]["agent"]["status"],"ready")
            catalog.assert_awaited_once()
            await stream.aclose()

    async def test_catalog_and_supplement_searches_do_not_wait_for_each_other(self):
        request,pool,fallback=fixture()
        base_started,extra_started=asyncio.Event(),asyncio.Event()
        async def base(_request):
            base_started.set()
            await extra_started.wait()
            return fallback,pool
        async def extra(_request,_base):
            extra_started.set()
            await base_started.wait()
            return (),"disabled"
        with patch("app.discovery._base_discover_catalog",side_effect=base), \
             patch("app.openpoi.enrich_candidates",side_effect=extra), \
             patch("app.restaurant_discovery.discover_restaurants",new=AsyncMock(return_value=RestaurantDiscovery(status="disabled"))):
            result,returned=await asyncio.wait_for(_discover_catalog(request),2)
        self.assertEqual(returned,pool)
        self.assertTrue(result["routes"])


class DiscoveryStreamApiTests(unittest.TestCase):
    def test_post_accepts_streaming_without_gzip_buffering_or_caching(self):
        from app.main import app
        request,_,_=fixture()
        async def events(_request):
            for stage in ("initial","complete"):
                yield {"stage":stage,"result":{"routes":[],"note":"テスト"*500}}
        with patch("app.main.discover_route_events",events):
            response=TestClient(app).post("/api/discover",json=request.model_dump(mode="json"),
                headers={"Accept":"text/event-stream","Accept-Encoding":"gzip"})
        self.assertEqual(response.status_code,200)
        self.assertIn("text/event-stream",response.headers["content-type"])
        self.assertNotIn("content-encoding",response.headers)
        self.assertIn("no-store",response.headers["cache-control"])
        stages=[json.loads(line[6:])["stage"] for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual(stages,["initial","complete"])
