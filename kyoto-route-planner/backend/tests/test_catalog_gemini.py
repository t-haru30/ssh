import asyncio
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from app import catalog_updater as agent
from app.catalog_gemini import Judgment
from tests.test_catalog_updater import observation


class GeminiAgentTests(unittest.TestCase):
    def run_case(self, actions, result=None):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            path = Path(directory)
            stack.enter_context(patch.dict(agent.os.environ, {'CATALOG_AGENT_DB':str(path/'state.db')}))
            master=path/'catalog.json'
            master.write_text(json.dumps({'places':[{'id':'osm-node-1','name':'試験施設',
                'category':'博物館','description':'','latitude':35,'longitude':135,
                'tags':{'catalog_kind':'facility','recommendation_status':'eligible'}}]}),encoding='utf-8')
            stack.enter_context(patch.object(agent,'PUBLIC_CATALOG_PATH',master))
            fetch=stack.enter_context(patch.object(agent,'fetch_matched_official_info',AsyncMock(return_value=result or observation())))
            judge=stack.enter_context(patch.object(agent,'judge',AsyncMock(side_effect=actions)))
            asyncio.run(agent.run_batch(1))
            return agent.report()['events'][0], fetch.await_count, judge.await_count

    def test_recheck_then_accept_is_persisted_with_trace(self):
        e,f,j=self.run_case([(Judgment(action='recheck',fields=[],reason='再取得'), 'test'),
                            (Judgment(action='accept',fields=['opening_hours'],reason='照合'), 'test')])
        self.assertEqual((e['status'],f,j),('updated',2,2))
        self.assertEqual(len(e['evidence']['agent_trace']),2)

    def test_recheck_budget_cannot_loop_forever(self):
        action=(Judgment(action='recheck',fields=[],reason='再取得'), 'test')
        e,f,j=self.run_case([action,action])
        self.assertEqual((e['status'],f,j),('needs_review',2,2))

    def test_model_failure_does_not_save(self):
        e,_,_=self.run_case([TimeoutError()])
        self.assertEqual(e['status'],'failed')
        self.assertEqual(e['changes'],{})

    def test_accept_cannot_override_absent_confirmation(self):
        result=observation(); result.checked_at=None
        e,_,_=self.run_case([(Judgment(action='accept',fields=['opening_hours'],reason='採用'), 'test')],result)
        self.assertEqual(e['status'],'needs_review')
