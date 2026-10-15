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
    def test_latest_explicit_removal_duration_and_order_are_checked(self):
        p = payload(); p.stops[0].locked = False
        p.message = "美術館を外して、カフェを60分にして"
        self.assertTrue(chat.requested_edit_errors(p, proposal(("a", 90), ("b", 60))))
        self.assertEqual(chat.requested_edit_errors(p, proposal(("b", 60))), [])
        p.message = "美術館で30分長く過ごしたい。美術館のあとにカフェを追加して"
        self.assertTrue(chat.requested_edit_errors(p, proposal(("b", 30), ("a", 90))))
        self.assertTrue(chat.requested_edit_errors(p, proposal(("a", 60), ("b", 30))))
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 90), ("b", 30))), [])
        p.message = "最後の場所で３０分長く過ごしたい"
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 90))), [])

    def test_does_not_treat_negated_removal_as_removal_or_history_as_current_request(self):
        p = payload(message="美術館を削除しないで、カフェを追加して", history=[dict(role="user", text="美術館を削除して")])
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 60), ("b", 30))), [])
        p.message = "美術館の滞在を２時間に増やして"
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 120))), [])

    def test_original_fixed_visits_cannot_be_lost_in_a_follow_up(self):
        p = payload(); p.applied_stops = p.stops
        p.stops = []
        self.assertIn("固定・訪問済み", " ".join(chat.validate(p, proposal(("b", 30)))))

    def test_generic_cafe_follow_up_targets_the_current_visit_among_many_candidates(self):
        p = payload(message="そのカフェを30分にして")
        p.stops.append(chat.Stop(place=p.candidates[0], dwell=60, locked=False, start=600, end=660, travel=0))
        p.candidates.append(p.candidates[0].model_copy(update={"id":"c", "name":"別の喫茶店"}))
        self.assertTrue(chat.requested_edit_errors(p, proposal(("a", 90), ("b", 60))))
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 60), ("b", 30))), [])

    def test_quoted_and_corrected_requests_do_not_force_the_old_edit(self):
        p = payload(message="前は「美術館を外して」と言ったけど、やっぱり残して30分長くして")
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 90))), [])
        p.message = "前は『カフェを追加して』と言ったけど、やっぱり美術館の時間だけ増やして"
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 90))), [])
        p.message = "カフェを増やして"
        p.stops.append(chat.Stop(place=p.candidates[0], dwell=60, locked=False, start=600, end=660, travel=0))
        p.candidates.append(p.candidates[0].model_copy(update={"id":"c", "name":"別のカフェ"}))
        self.assertEqual(chat.requested_edit_errors(p, proposal(("a", 60), ("b", 60), ("c", 30))), [])

    def test_rejects_unknown_duplicate_and_fixed_changes(self):
        for p in [proposal(("unknown", 60)), proposal(("a", 60), ("a", 60)), proposal(("b", 30)), proposal(("a", 30))]:
            self.assertTrue(chat.validate(payload(), p))

    def test_ignores_removed_budget_and_duration_settings_but_keeps_fixed_appointments(self):
        self.assertEqual(chat.validate(payload(available_minutes=30, budget=0), proposal(("a", 60), ("b", 360))), [])
        request = payload().model_dump(exclude={"available_minutes", "budget"})
        self.assertEqual(chat.validate(chat.ChatRequest(**request), proposal(("a", 60), ("b", 90))), [])
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
            call("validate_proposal", proposal(("a", 30), ("b", 90)).model_dump()),
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

    async def test_unchanged_proposal_is_repaired_instead_of_reported_as_success(self):
        sequence = [call("validate_proposal", proposal(("a", 60)).model_dump()),
                    call("validate_proposal", proposal(("a", 60), ("b", 30)).model_dump())]
        with patch.object(chat, "model_call", new=AsyncMock(side_effect=sequence)) as model:
            result = await chat.run(payload(message="カフェを追加して"), "test", "gemini-test")
        self.assertEqual(model.await_count, 2)
        self.assertIn("変更がありません", result.steps[0])
        self.assertEqual([s.id for s in result.proposal.stops], ["a", "b"])

    async def test_removing_cafe_after_a_search_does_not_require_adding_it_back(self):
        p = payload(message="カフェを外して", history=[dict(role="user", text="カフェを追加して")])
        p.stops.append(chat.Stop(place=p.candidates[0], dwell=60, locked=False, start=600, end=660, travel=0))
        sequence = [call("search_candidates", {"query": "カフェ"}), call("validate_proposal", proposal(("a", 60)).model_dump())]
        with patch.object(chat, "model_call", new=AsyncMock(side_effect=sequence)):
            result = await chat.run(p, "test", "gemini-test")
        self.assertEqual([s.id for s in result.proposal.stops], ["a"])

    async def test_follow_up_uses_preview_snapshot_and_supplies_original_for_undo(self):
        import json
        p = payload(message="カフェはもう少し短くして")
        p.applied_stops = list(p.stops)
        p.stops.append(chat.Stop(place=p.candidates[0], dwell=60, locked=False, start=600, end=660, travel=0))
        with patch.object(chat, "model_call", new=AsyncMock(return_value=call("validate_proposal", proposal(("a", 60), ("b", 30)).model_dump()))) as model:
            result = await chat.run(p, "test", "gemini-test")
        contents = model.call_args.args[-1]
        context = json.loads(contents[0]["parts"][0]["text"])
        self.assertEqual(context["editing_target"], "pending_proposal")
        self.assertEqual([s["place"]["id"] for s in context["stops"]], ["a", "b"])
        self.assertEqual([s["place"]["id"] for s in context["applied_stops"]], ["a"])
        self.assertEqual(contents[0]["parts"][-1]["text"], "Latest user request — prioritize this edit: " + p.message)
        self.assertEqual(result.proposal.stops[-1].dwell, 30)

    async def test_legacy_limits_are_not_sent_to_the_model_or_used_to_reject_edits(self):
        import json
        snapshots = []
        async def fake(client, key, model, contents):
            snapshots.append(contents)
            return call("validate_proposal", proposal(("a", 60), ("b", 360)).model_dump())
        with patch.object(chat, "model_call", side_effect=fake):
            result = await chat.run(payload(available_minutes=30, budget=0), "test", "gemini-test")
        context = json.loads(snapshots[0][0]["parts"][0]["text"])
        self.assertNotIn("budget", context)
        self.assertNotIn("available_minutes", context)
        self.assertEqual(result.proposal.stops[-1].dwell, 360)
        self.assertNotIn("予算", " ".join(result.steps))

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
