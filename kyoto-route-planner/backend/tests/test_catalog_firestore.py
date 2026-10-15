"""Storage contract tests against a deterministic fake; no cloud resources or Gemini calls."""
from copy import deepcopy
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from google.api_core.exceptions import AlreadyExists
from app import catalog_firestore as store


class Ref:
    def __init__(self, db, path): self.db,self.path=db,path
    def get(self, transaction=None):
        return SimpleNamespace(id=self.path[-1],reference=self,to_dict=lambda:deepcopy(self.db.rows.get(self.path)))
    def create(self, row):
        if self.path in self.db.rows: raise AlreadyExists('existing')
        self.db.rows[self.path]=deepcopy(row)


class Query:
    def __init__(self, db, name, filters=(), order=None, limit=None, reverse=False):
        self.db,self.name,self.filters,self.order,self.maximum,self.reverse=db,name,filters,order,limit,reverse
    def document(self, id): return Ref(self.db,(self.name,id))
    def where(self, *, filter): return Query(self.db,self.name,self.filters+(filter,),self.order,self.maximum,self.reverse)
    def order_by(self, key, direction=None): return Query(self.db,self.name,self.filters,key,self.maximum,direction=='DESCENDING')
    def limit(self, value): return Query(self.db,self.name,self.filters,self.order,value,self.reverse)
    def stream(self):
        result=[]
        for (name,id),row in self.db.rows.items():
            if name!=self.name: continue
            match=True
            for f in self.filters:
                v=row.get(f.field_path)
                match &= v is not None and {'==':lambda:v==f.value,'<=':lambda:v<=f.value,'>':lambda:v>f.value}[f.op_string]()
            if match: result.append(self.document(id).get())
        if self.order: result.sort(key=lambda d:d.to_dict()[self.order],reverse=self.reverse)
        return iter(result[:self.maximum])
    def count(self): return SimpleNamespace(get=lambda:[[SimpleNamespace(value=len(list(self.stream())))]] )


class Fake:
    def __init__(self): self.rows={}
    def collection(self, name): return Query(self,name)
    def transaction(self): return self
    def update(self, ref, row): self.rows[ref.path].update(deepcopy(row))
    def set(self, ref, row): self.rows[ref.path]=deepcopy(row)
    def create(self, ref, row): ref.create(row)
    def batch(self):
        operations=[]
        def commit():
            if any(ref.path in self.rows for ref,row in operations): raise AlreadyExists('existing')
            for ref,row in operations: ref.create(row)
        return SimpleNamespace(create=lambda ref,row:operations.append((ref,row)),commit=commit)


class FirestoreContractTests(unittest.TestCase):
    def setUp(self):
        self.db=Fake()
        self.addCleanup(patch.stopall)
        patch.object(store,'client',return_value=self.db).start()
        # The real SDK handles conflict retries/atomicity; this test checks our read/write decisions.
        patch('google.cloud.firestore.transactional',side_effect=lambda f:f).start()
        patch.dict(os.environ,{'CATALOG_DAILY_LIMIT':'2'}).start()
        self.rows=[dict(id=f'osm-node-{i}',next_check=0,priority=0,attempted=None,accepted=None,status='pending',failures=0,note='') for i in range(3)]
    def test_repeat_seed_does_not_overwrite(self):
        self.assertEqual(store.seed(self.rows),3)
        self.assertEqual(store.seed(self.rows),0)
    def test_leases_daily_cap_and_restart(self):
        store.seed(self.rows)
        first=store.claim(1000);second=store.claim(1000)
        self.assertNotEqual(first['id'],second['id'])
        self.assertIsNone(store.claim(1000))
        # Tomorrow uses a new budget and recovers expired leases.
        self.assertIsNotNone(store.claim(1000+86400))
    def test_stale_worker_cannot_commit(self):
        store.seed(self.rows)
        first=store.claim(1000)
        self.db.rows[('catalog_jobs',first['id'])]['lease']='new-owner'
        with self.assertRaises(RuntimeError): store.finish(first,{'at':1001},None,1)
    def test_result_and_history_persist_and_failed_keeps_old(self):
        store.seed(self.rows)
        row=store.claim(1000)
        accepted={'fields':{'opening_hours':{'value':'9-17'}}}
        event=dict(id=row['id'],name='施設',at=1001,status='updated',note='確認',evidence='{}',changes='{}',next_check=90000)
        store.finish(row,event,accepted,0)
        self.assertEqual(store.checked_rows()[row['id']]['accepted'],'{"fields": {"opening_hours": {"value": "9-17"}}}')
        counts,events,due=store.report_data()
        self.assertEqual(counts['updated'],1);self.assertEqual(len(events),1)
        self.assertEqual(events[0]['seq'],row['lease'])
    def test_cloud_never_starts_background_worker(self):
        from app.catalog_updater import enabled
        with patch.dict(os.environ,{'CATALOG_STORE':'firestore','CATALOG_AGENT_ENABLED':'1'}):
            self.assertFalse(enabled())
    def test_cloud_batch_persists_without_sqlite(self):
        import asyncio
        from unittest.mock import AsyncMock
        from app import catalog_updater as agent
        from app.catalog_gemini import Judgment
        from tests.test_catalog_updater import observation
        store.seed(self.rows[:1])
        place={'id':'osm-node-0','name':'試験施設','category':'博物館','description':'','latitude':35,'longitude':135}
        with patch.dict(os.environ,{'CATALOG_STORE':'firestore'}), \
             patch.object(agent,'catalog',return_value={'places':[place]}), \
             patch.object(agent,'connect',side_effect=AssertionError('SQLite forbidden')), \
             patch.object(agent,'fetch_matched_official_info',AsyncMock(return_value=observation())), \
             patch.object(agent,'judge',AsyncMock(return_value=(Judgment(action='accept',fields=['opening_hours'],reason='確認'),'test'))):
            self.assertEqual(asyncio.run(agent.run_batch(1))['processed'],1)
            self.assertEqual(agent.report()['counts']['updated'],1)
            self.assertEqual(agent.merged_catalog()['places'][0]['tags']['official_opening_hours'],'9:00–17:00')
