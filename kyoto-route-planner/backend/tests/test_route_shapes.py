import unittest
from unittest.mock import AsyncMock,patch
import httpx
from app import route_shapes as shapes

def fixture():
    return {"ResultSet":{"Course":{"OperationLinePattern":[{"routeLineIndex":"2","Line":{"Name":"地下鉄","Type":"train","Shape":[{"GeoPoint":{"lati_d":"35","longi_d":"135","gcs":"wgs84"}},{"GeoPoint":{"lati_d":"35.01","longi_d":"135.02","gcs":"wgs84"}},{"GeoPoint":{"lati_d":"35.02","longi_d":"135","gcs":"wgs84"}}]}},{"routeLineIndex":"3","Line":{"Name":"徒歩","Type":"walk","Shape":[{"GeoPoint":{"lati_d":"35.02","longi_d":"135","gcs":"wgs84"}},{"GeoPoint":{"lati_d":"35.021","longi_d":"135","gcs":"wgs84"}}]}}]}}}

class ShapeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        shapes._courses.clear(); shapes._shapes.clear()
    def test_preserves_curves_and_distinguishes_approximate_walking(self):
        result = shapes.parse_shapes(fixture())
        self.assertEqual(result[0]["coordinates"][1],[35.01,135.02])
        self.assertFalse(result[0]["approximate"])
        self.assertTrue(result[1]["approximate"])
        data=fixture(); data["ResultSet"]["Course"]["OperationLinePattern"][0]["Line"]["Shape"][0]["GeoPoint"]["gcs"]="tokyo"
        self.assertEqual(shapes.parse_shapes(data),[])
    async def test_unknown_token_cannot_trigger_provider_and_valid_token_is_reused(self):
        with patch("httpx.AsyncClient.get",new=AsyncMock()) as get:
            self.assertEqual((await shapes.course_shape("a"*32))["status"],"expired")
        get.assert_not_awaited()
        token=shapes.register_course({"SerializeData":"opaque-course-not-a-key"})
        with patch.dict("os.environ",{"EKISPERT_API_KEY":"test-secret"}),patch("httpx.AsyncClient.get",new=AsyncMock(return_value=httpx.Response(200,json=fixture()))) as get:
            first=await shapes.course_shape(token)
            self.assertEqual(first["status"],"ready")
            self.assertEqual(await shapes.course_shape(token),first)
            self.assertEqual(get.await_count,1)
            self.assertEqual(get.call_args.kwargs["params"]["type"],"all")
            self.assertNotIn("opaque-course",str(first))
    async def test_provider_failure_does_not_return_a_fake_straight_route(self):
        token=shapes.register_course({"SerializeData":"opaque"})
        with patch.dict("os.environ",{"EKISPERT_API_KEY":"test"}),patch("httpx.AsyncClient.get",new=AsyncMock(return_value=httpx.Response(403))):
            result=await shapes.course_shape(token)
        self.assertEqual(result["segments"],[])
        self.assertEqual(result["status"],"unavailable")
