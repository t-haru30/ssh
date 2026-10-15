import asyncio
import json
import sqlite3
from app import catalog_updater as agent
from app.official_place_info import OfficialPlaceInfo


def observation(hours='9:00–17:00', **kwargs):
    return OfficialPlaceInfo(status='verified', checked_at='2026-10-15T00:00:00+00:00',
        opening_hours=hours, field_sources={'opening_hours':'https://example.org/guide'},
        url='https://example.org/', note='根拠', **kwargs)


def test_decisions_preserve_last_good_and_require_field_evidence():
    status, _, saved, _ = agent.decide(None, observation())
    assert status == 'updated'
    assert saved['fields']['opening_hours']['url'].endswith('/guide')
    status, _, changed, delta = agent.decide(saved, observation('10:00–16:00'))
    assert status == 'conflict' and changed is None
    assert delta['opening_hours']['before'] == '9:00–17:00'
    no_evidence = observation(); no_evidence.field_sources = {}
    assert agent.decide(saved, no_evidence)[0] == 'needs_review'
    no_date = observation(); no_date.checked_at = None
    assert agent.decide(saved, no_date)[2] is None


def test_queue_persistence_failure_retry_and_overlay(tmp_path, monkeypatch):
    monkeypatch.setenv('CATALOG_AGENT_DB', str(tmp_path/'agent.sqlite3'))
    place = {'id':'osm-node-1','name':'試験施設','category':'博物館','description':'',
        'latitude':35,'longitude':135,'tags':{'catalog_kind':'facility','recommendation_status':'eligible'}}
    master = tmp_path/'master.json'; master.write_text(json.dumps({'places':[place]}), encoding='utf-8')
    monkeypatch.setattr(agent, 'PUBLIC_CATALOG_PATH', master)
    async def good(*args): return observation()
    from app.catalog_gemini import Judgment
    async def accept(*args): return Judgment(action='accept', fields=['opening_hours'], reason='根拠を照合'), 'test-model'
    monkeypatch.setattr(agent, 'judge', accept)
    monkeypatch.setattr(agent, 'fetch_matched_official_info', good)
    assert asyncio.run(agent.run_batch())['processed'] == 1
    assert asyncio.run(agent.run_batch())['processed'] == 0
    assert agent.merged_catalog()['places'][0]['tags']['official_opening_hours'] == '9:00–17:00'
    assert 'official_checked_at' not in json.loads(master.read_text())['places'][0]['tags']
    from contextlib import closing
    with closing(sqlite3.connect(tmp_path/'agent.sqlite3')) as db, db:
        db.execute('UPDATE jobs SET next_check=0')
    async def bad(*args): raise TimeoutError()
    monkeypatch.setattr(agent, 'fetch_matched_official_info', bad)
    assert asyncio.run(agent.run_batch())['processed'] == 1
    assert agent.report()['events'][0]['status'] == 'failed'
    assert agent.merged_catalog()['places'][0]['tags']['official_opening_hours'] == '9:00–17:00'
    assert asyncio.run(agent.run_batch())['processed'] == 0


def test_closure_requires_review():
    result = observation()
    from app.official_place_info import ClosureNotice
    result.notices = [ClosureNotice(text='休館',url='https://example.org/news',starts_on='2026-10-15',ends_on='2026-10-16')]
    assert agent.decide(None, result)[0] == 'conflict'


import tempfile
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import unittest
class AgentTests(unittest.TestCase):
    def test_decisions(self):
        test_decisions_preserve_last_good_and_require_field_evidence()
    def test_closures(self):
        test_closure_requires_review()
    def test_persistence(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            class Patches:
                def setenv(self, key, value):
                    stack.enter_context(patch.dict(agent.os.environ, {key: value}))
                def setattr(self, obj, name, value):
                    stack.enter_context(patch.object(obj, name, value))
            test_queue_persistence_failure_retry_and_overlay(Path(directory), Patches())

if __name__ == '__main__':
    unittest.main()
