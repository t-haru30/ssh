import unittest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import HTTPException
from app.destination_suggestion import DestinationRequest, suggest_destination
from app.station_search import StationCandidate

class DestinationTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirms_station_coordinates(self):
        response=MagicMock()
        response.json.return_value={"candidates":[{"content":{"parts":[{"text":'{"station":"京都駅","prefecture":"京都府","municipality":"京都市"}'}]}}]}
        client=AsyncMock()
        client.post.return_value=response
        station=StationCandidate(name="京都駅",latitude=34.98,longitude=135.75,code="1",prefecture="京都府")
        with patch("app.destination_suggestion.gemini_api_key",return_value="test"), patch("app.destination_suggestion.httpx.AsyncClient") as factory, patch("app.destination_suggestion.search_stations",new=AsyncMock(return_value=[station])):
            factory.return_value.__aenter__.return_value=client
            result=await suggest_destination(DestinationRequest(text="京都の庭園"))
            self.assertEqual(result["origin"]["latitude"],34.98)
            self.assertEqual(result["prefecture"],"京都府")

    async def test_missing_key_fails_clearly(self):
        with patch("app.destination_suggestion.gemini_api_key",return_value=""):
            with self.assertRaises(HTTPException) as caught:
                await suggest_destination(DestinationRequest(text="庭園"))
            self.assertEqual(caught.exception.status_code,503)
