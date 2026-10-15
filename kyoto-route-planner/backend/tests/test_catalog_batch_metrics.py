import asyncio
import unittest
from unittest.mock import patch, AsyncMock
from app import catalog_updater as agent, catalog_metrics as metrics
from app.catalog_gemini import Judgment
from tests.test_catalog_updater import observation


class BatchMetricsTests(unittest.TestCase):
    def tearDown(self):
        metrics.current.set(None)

    def test_hundred_are_processed_and_counted(self):
        places = [{'id':str(i), 'name':'試験施設', 'category':'博物館',
                   'description':'', 'latitude':35, 'longitude':135} for i in range(100)]
        rows = [{'id':p['id'], 'accepted':None, 'failures':0} for p in places]
        state = metrics.start('test')
        with patch.object(agent.cloud,'active',return_value=True), \
             patch.object(agent.cloud,'claim',side_effect=rows), \
             patch.object(agent.cloud,'finish') as finish, \
             patch.object(agent,'catalog',return_value={'places':places}), \
             patch.object(agent,'fetch_matched_official_info',AsyncMock(return_value=observation())), \
             patch.object(agent,'judge',AsyncMock(return_value=(Judgment(action='accept',fields=['opening_hours'],reason='確認'),'test'))), \
             patch.object(metrics,'emit'):
            result=asyncio.run(agent.run_batch(100))
        self.assertEqual(result['processed'],100)
        self.assertEqual(finish.call_count,100)
        self.assertEqual(state['statuses'],{'updated':100})

    def test_usage_counts_thinking_and_missing_response(self):
        state=metrics.start('test')
        with patch.object(metrics,'emit'):
            metrics.call_started('test')
            metrics.response_received('test',{'usageMetadata':{'promptTokenCount':100,
                'candidatesTokenCount':20,'thoughtsTokenCount':30,'cachedContentTokenCount':10}})
            metrics.call_started('test')
            metrics.response_received('test',{})
        self.assertEqual(state['gemini_calls'],2)
        self.assertEqual(state['usage_responses'],1)
        self.assertEqual(state['output_tokens']+state['thought_tokens'],50)
        self.assertEqual(state['cached_tokens'],10)

    def test_batch_rejects_invalid_size(self):
        for size in (0,501,-1):
            with self.assertRaises(ValueError):
                asyncio.run(agent.run_batch(size))

    def test_budget_exhaustion_stops_early(self):
        with patch.object(agent.cloud,'active',return_value=True), \
             patch.object(agent.cloud,'claim',return_value=None), \
             patch.object(agent,'catalog',return_value={'places':[]}):
            self.assertEqual(asyncio.run(agent.run_batch(100))['processed'],0)

    def test_job_persists_summary_and_marks_short_run(self):
        from app import catalog_job
        with patch.dict(catalog_job.os.environ, {'CATALOG_BATCH_SIZE':'100', 'CLOUD_RUN_EXECUTION':'test-run'}), \
             patch.object(agent.cloud,'active',return_value=True), \
             patch.object(agent.cloud,'collection') as collection, \
             patch.object(agent,'run_batch',AsyncMock(return_value={'processed':1,'busy':False})), \
             patch.object(catalog_job,'configure_ai_environment'), \
             patch.object(metrics,'emit'):
            catalog_job.main()
        summary=collection.return_value.document.return_value.set.call_args.args[0]
        self.assertEqual(summary['requested'],100)
        self.assertFalse(summary['complete'])
        self.assertEqual(summary['metrics']['run_id'],'test-run')
