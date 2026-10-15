import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch,Mock
from contextlib import closing
from app import catalog_information as info
from app.models import CatalogPlace

PLACE=CatalogPlace(id='osm-node-1',name='試験資料館',category='博物館',region='京都府',address='京都市',latitude=35,longitude=135,description='',tags={'source':'OpenStreetMap'})
def accepted(value='9:00〜17:00'):
    return {'checked_at':'2026-10-15T01:00:00+00:00','url':'https://museum.example.jp/',
            'fields':{'opening_hours':{'value':value,'url':'https://museum.example.jp/guide','checked_at':'2026-10-15T01:00:00+00:00'}}}

class CatalogInformationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'db.sqlite3'
        self.addCleanup(patch.stopall)
        patch.dict(os.environ,{'CATALOG_STORE':'sqlite','CATALOG_AGENT_DB':str(self.path)}).start()
        patch.object(info,'load_public_places',return_value=(PLACE,)).start();info._cache.clear()
    def save(self,value,status='updated'):
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT,accepted TEXT,note TEXT)')
            db.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?)',('osm-node-1',status,json.dumps(value),'private internal trace'))
    async def test_update_after_initial_read_is_visible_without_restart(self):
        self.save(accepted());first=await info.catalog_information(['osm-node-1'])
        self.save(accepted('10:00〜18:30'))
        second=await info.catalog_information(['osm-node-1'])
        self.assertEqual(second['records'][0]['official']['opening_hours'],'10:00〜18:30')
        self.assertNotEqual(first['records'][0]['revision'],second['records'][0]['revision'])
        self.assertNotIn('private internal trace',json.dumps(second))
    async def test_enrichment_reaches_route_spots_without_mutating_the_master(self):
        self.save(accepted());places=await info.enrich_places((PLACE,))
        self.assertEqual(places[0].tags['official_opening_hours'],'9:00〜17:00')
        self.assertNotIn('official_opening_hours',PLACE.tags)
        from app.discovery import DiscoverRequest,assemble_route
        request=DiscoverRequest(area='kyoto',prefecture_name='京都府',origin={'name':'京都駅','latitude':35,'longitude':135})
        route=assemble_route(request,list(places))
        self.assertEqual(route['spots'][0]['tags']['official_opening_hours'],'9:00〜17:00')
    async def test_pending_conflicts_keep_last_accepted_facts(self):
        self.save(accepted(),status='conflict')
        record=(await info.catalog_information(['osm-node-1']))['records'][0]
        self.assertEqual(record['status'],'conflict');self.assertEqual(record['official']['opening_hours'],'9:00〜17:00')
    async def test_unconfirmed_values_and_nonpublic_sources_are_omitted(self):
        for change in [{'url':'javascript:alert(1)'},{'url':'http://127.0.0.1/'},{'checked_at':'bad'},{'url':None}]:
            data=accepted();data['fields']['opening_hours'].update(change);self.save(data)
            self.assertEqual((await info.catalog_information(['osm-node-1']))['records'],[])
    async def test_absent_store_is_read_only_and_does_not_initialize_jobs(self):
        self.assertEqual((await info.catalog_information(['osm-node-1']))['records'],[])
        self.assertFalse(self.path.exists())
    async def test_unknown_ids_never_read_firestore(self):
        with patch.dict(os.environ,{'CATALOG_STORE':'firestore'}),patch.object(info.catalog_firestore,'accepted_rows') as read:
            self.assertEqual((await info.catalog_information(['osm-node-999']))['records'],[]);read.assert_not_called()
    async def test_firestore_uses_targeted_reads_and_refreshes_after_cache_expiry(self):
        with patch.dict(os.environ,{'CATALOG_STORE':'firestore'}),patch.object(info.catalog_firestore,'accepted_rows',return_value={'osm-node-1':{'status':'updated','accepted':json.dumps(accepted())}}) as read:
            await info.catalog_information(['osm-node-1']);await info.catalog_information(['osm-node-1'])
            self.assertEqual(read.call_count,1)
            info._cache.clear();read.return_value={'osm-node-1':{'status':'updated','accepted':json.dumps(accepted('10:00〜18:00'))}}
            result=await info.catalog_information(['osm-node-1'])
            self.assertEqual(result['records'][0]['official']['opening_hours'],'10:00〜18:00')
    async def test_failure_is_not_mistaken_for_deleted_information(self):
        with patch.object(info,'read_rows',side_effect=OSError('offline')):
            self.assertEqual((await info.catalog_information(['osm-node-1']))['status'],'unavailable')
    def test_firestore_projects_only_public_fields(self):
        client=Mock();snapshot=Mock(id='osm-node-1',exists=True)
        snapshot.to_dict.return_value={'status':'updated','accepted':'{}','note':'private'};client.get_all.return_value=[snapshot]
        with patch.object(info.catalog_firestore,'client',return_value=client):
            result=info.catalog_firestore.accepted_rows(['osm-node-1'])
        self.assertEqual(result,{'osm-node-1':{'status':'updated','accepted':'{}'}})
        self.assertEqual(client.get_all.call_args.kwargs,{'field_paths':['status','accepted'],'retry':None,'timeout':3})

    def test_public_facts_endpoint_preserves_admin_boundary_and_limits(self):
        from fastapi.testclient import TestClient
        from app.main import app
        self.save(accepted())
        with patch.dict(os.environ,{'CATALOG_ADMIN_ENABLED':'0'}):
            client=TestClient(app)
            response=client.post('/api/places/current-information',json={'ids':['osm-node-1']})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['cache-control'],'no-store')
            self.assertEqual(response.json()['records'][0]['official']['opening_hours'],'9:00〜17:00')
            self.assertEqual(client.post('/api/places/current-information',json={'ids':['osm-node-1']*61}).status_code,422)
            self.assertEqual(client.get('/api/catalog-agent/catalog').status_code,403)

    async def test_startup_loads_db_settings_before_serving_requests(self):
        from app import main
        order=[]
        with patch.dict(os.environ,{'PYTHON_DOTENV_DISABLED':'0'}), \
             patch.object(main,'configure_ai_environment',side_effect=lambda:order.append('ai')), \
             patch.object(main,'load_dotenv',side_effect=lambda *a,**k:order.append('dotenv')) as load, \
             patch.object(main,'initialize_database',side_effect=lambda:order.append('database')), \
             patch.object(main,'load_fallback_ideas',return_value=[]):
            async with main.lifespan(Mock()):
                self.assertEqual(order,['ai','dotenv','database'])
            self.assertEqual(load.call_args.args[0],Path(main.__file__).resolve().parents[1]/'.env')
            self.assertEqual(load.call_args.kwargs,{'override':False})
