import unittest
from unittest.mock import AsyncMock, patch

from app import journey_chat as chat


def payload(**changes):
    place = dict(id="a", name="美術館", category="文化", latitude=35, longitude=135)
    values = dict(message="カフェで休憩したい", origin=dict(name="駅", latitude=35, longitude=135),
        return_to=dict(name="駅", latitude=35, longitude=135), departure="09:00", available_minutes=120, budget=3000,
        stops=[dict(place=place, dwell=60, locked=True, start=540, end=600, travel=0, spending=500)],
        candidates=[dict(place, id="b", name="カフェ", category="カフェ")], return_travel=0, travel_cost=100)
    values.update(changes)
    return chat.ChatRequest(**values)


def proposal(*stops):
    return chat.Proposal(stops=[dict(id=i, dwell=d) for i, d in stops])


def call(name, args):
    tool = dict(name=name, args=args, id="turn-id")
    return dict(role="model", parts=[dict(functionCall=tool, thoughtSignature="preserve-me")]), tool


class ValidationTests(unittest.TestCase):
    def test_rejects_unknown_duplicate_and_fixed_changes(self):
        for p in [proposal(("unknown", 60)), proposal(("a", 60), ("a", 60)), proposal(("b", 30)), proposal(("a", 30))]:
            self.assertTrue(chat.validate(payload(), p))

    def test_checks_time_appointments_and_known_budget(self):
        self.assertIn("帰着", " ".join(chat.validate(payload(), proposal(("a", 60), ("b", 90)))))
        self.assertIn("予算", " ".join(chat.validate(payload(budget=100), proposal(("a", 60)))))
        p = payload()
        p.stops[0].anchor = "09:00"
        self.assertIn("固定開始", " ".join(chat.validate(p, proposal(("b", 30), ("a", 60)))))

    def test_preserves_completed_prefix_and_estimates_unknown_cost(self):
        p = payload()
        p.stops[0].completed = True
        self.assertTrue(chat.validate(p, proposal(("b", 30), ("a", 60))))
        self.assertEqual(chat.validate(p, proposal(("a", 60), ("b", 30))), [])


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        client = patch.object(chat.httpx, "AsyncClient")
        client.start()
        self.addCleanup(client.stop)
        search = patch.object(chat, "nearby_cafes", new=AsyncMock(return_value=([], "OSM test")))
        search.start()
        self.addCleanup(search.stop)

    async def test_search_validation_feedback_then_repair(self):
        outputs = [call("search_candidates", {"query": "カフェ"}),
            call("validate_proposal", proposal(("a", 60), ("b", 90)).model_dump()),
            call("validate_proposal", proposal(("a", 60), ("b", 30)).model_dump())]
        snapshots = []
        async def fake(client, key, model, contents):
            import copy
            snapshots.append(copy.deepcopy(contents))
            return outputs[len(snapshots)-1]
        with patch.object(chat, "model_call", side_effect=fake):
            result = await chat.run(payload(), "test", "gemini-test")
        self.assertEqual(len(snapshots), 3)
        self.assertEqual(result.proposal.stops[-1].dwell, 30)
        feedback = snapshots[2][-1]["parts"][0]["functionResponse"]
        self.assertFalse(feedback["response"]["valid"])
        self.assertEqual(feedback["id"], "turn-id")
        self.assertEqual(snapshots[1][1]["parts"][0]["thoughtSignature"], "preserve-me")
        self.assertIn("再検討", result.steps[1])

    async def test_can_ask_instead_of_silently_dropping_request(self):
        with patch.object(chat, "model_call", new=AsyncMock(return_value=call("ask_user", {"question": "固定予定を手動で解除しますか？"}))):
            result = await chat.run(payload(), "test", "gemini-test")
        self.assertIsNone(result.proposal)
        self.assertIn("固定予定", result.message)

    async def test_stops_after_six_unsuccessful_turns(self):
        with patch.object(chat, "model_call", new=AsyncMock(return_value=call("validate_proposal", proposal(("b", 30)).model_dump()))) as model:
            result = await chat.run(payload(), "test", "gemini-test")
        self.assertEqual(model.await_count, 6)
        self.assertIsNone(result.proposal)

    async def test_missing_key_never_calls_model(self):
        with patch.object(chat, "gemini_api_key", return_value=""), patch.object(chat, "model_call", new=AsyncMock()) as model:
            with self.assertRaises(chat.HTTPException) as error:
                await chat.chat_journey(payload())
        self.assertEqual(error.exception.status_code, 503)
        model.assert_not_awaited()
