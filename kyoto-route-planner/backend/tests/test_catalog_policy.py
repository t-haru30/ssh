import unittest
from types import SimpleNamespace
from app.public_catalog import load_public_places
from app.discovery import DiscoverRequest, build_discover_routes, eligible_candidates
from app.models import Origin
from app.catalog_policy import mix, tier, kind, hidden_requested, allowed


def request(text='', **kwargs):
    return DiscoverRequest(area='tokyo',prefecture_name='東京都',origin=Origin(name='東京駅',latitude=35.681236,longitude=139.767125),radius_km=15,count=10,meals=[],preference_text=text,**kwargs)


class CatalogPolicyTests(unittest.TestCase):
    def test_every_prefecture_has_reviewed_classics_and_every_record_has_reason(self):
        places=load_public_places()
        prefectures={p.region for p in places}
        self.assertEqual(len(prefectures),47)
        self.assertEqual(prefectures,{p.region for p in places if tier(p)=='classic' and allowed(p)})
        for p in places:
            self.assertIn(p.tags['review_version'],{'national-audit-v2','national-expansion-v3'},p.name)
            self.assertTrue(p.tags['review_reason'],p.name)
            self.assertNotIn('unreviewed',p.tags['tier_basis'])

    def test_closure_and_review_holds_survive_storage_and_explicit_requests(self):
        for name in ['東海大学海洋科学博物館','川村記念美術館','Western village']:
            p=next(p for p in load_public_places() if p.name==name)
            self.assertFalse(allowed(p,explicit=True),name)
            self.assertFalse(allowed(p.model_copy(update={'tags':{}}),explicit=True),name)

    def test_named_landmarks_are_not_signs_or_bus_stops(self):
        for name in ['二条城','京都御所','伏見稲荷大社','日光東照宮','姫路城','鉄道博物館','厳島神社']:
            matches=[p for p in load_public_places() if p.name==name and allowed(p) and tier(p)=='classic']
            self.assertEqual(len(matches),1,name)
            self.assertTrue(matches[0].id.startswith(('osm-way-','osm-relation-')),name)

    def test_chain_cafe_is_excluded_even_for_explicit_preference(self):
        p=next(p for p in load_public_places() if p.name=='タリーズコーヒー')
        self.assertFalse(allowed(p))
        self.assertFalse(allowed(p,explicit=True))

    def test_named_landmarks_are_real_independent_records(self):
        places=load_public_places()
        for name in ['東京タワー','東京スカイツリー','浅草寺','明治神宮','清水寺','法隆寺']:
            matches=[p for p in places if p.name==name and tier(p)=='classic']
            self.assertTrue(matches,name)
            self.assertIn(matches[0].id.split('-')[1],['way','relation'])
            self.assertTrue(matches[0].tags['source_url'].startswith('https://www.openstreetmap.org/'))

    def test_default_and_hidden_recommendations_differ(self):
        places=load_public_places()
        regular=build_discover_routes(request(),places)['routes']
        hidden=build_discover_routes(request('穴場がいい'),places)['routes']
        by_id={p.id:p for p in places}
        self.assertEqual(tier(by_id[regular[0]['spots'][0]['place_id']]),'classic')
        self.assertEqual(tier(by_id[hidden[0]['spots'][0]['place_id']]),'hidden')
        self.assertIn('穴場',hidden[0]['recommendation_reason'])

    def test_mix_is_six_three_one_or_two_three_five(self):
        places=[SimpleNamespace(tags={'recommendation_tier':t}) for t in ['classic','regional','hidden'] for _ in range(10)]
        for text,expected in [('',[6,3,1]),('穴場がいい',[2,3,5])]:
            actual=mix(request(text),places)[:10]
            self.assertEqual([sum(tier(p)==t for p in actual) for t in ['classic','regional','hidden']],expected)
        self.assertFalse(hidden_requested(request('穴場ではなく定番がいい')))

    def test_parts_do_not_become_main_stops(self):
        places=load_public_places()
        parts=[p for p in places if kind(p)!='facility']
        self.assertTrue(any('二条城' in p.name for p in parts))
        r=DiscoverRequest(area='kyoto',prefecture_name='京都府',origin=Origin(name='京都駅',latitude=34.9858,longitude=135.7588),radius_km=20)
        self.assertTrue(all(kind(p)=='facility' for p in eligible_candidates(r,places)))

    def test_storage_metadata_does_not_change_tier(self):
        tower=next(p for p in load_public_places() if p.name=='東京タワー')
        saved=tower.model_copy(update={'tags':{'source':'OpenStreetMap','last_seen':'now'}})
        self.assertEqual(tier(tower),tier(saved))
        r=request()
        a=build_discover_routes(r,(tower,))['routes']
        b=build_discover_routes(r,(saved,))['routes']
        self.assertEqual([x['id'] for x in a],[x['id'] for x in b])

    def test_radius_is_still_a_hard_constraint(self):
        r=request();r.radius_km=1
        self.assertNotIn('東京タワー',[p.name for p in eligible_candidates(r,load_public_places())])

    def test_sparse_landmark_is_not_required_in_every_itinerary(self):
        from app.models import CatalogPlace
        places=tuple(CatalogPlace(id=f'local-{i}',name=f'独立した公園{i}',category='公園・庭園',
            region='東京都',address='',description='',latitude=35.68+i*.001,longitude=139.76,
            tags={'recommendation_tier':t,'leisure':'park'})
            for i,t in enumerate(['classic','regional','regional','regional','hidden','hidden','hidden']))
        result=build_discover_routes(request(),places)
        self.assertGreaterEqual(len(result['routes']),3)
        sets=[{s['place_id'] for s in r['spots']} for r in result['routes']]
        self.assertIn('local-0',sets[0])
        self.assertTrue(any('local-0' not in ids for ids in sets))
        self.assertTrue(any(ids & {'local-4','local-5','local-6'} for ids in sets))
        self.assertIn('地域の見どころ・穴場',result['note'])

    def test_no_landmarks_still_produces_local_itineraries(self):
        from app.models import CatalogPlace
        places=tuple(CatalogPlace(id=f'local-{i}',name=f'地域の庭園{i}',category='公園・庭園',
            region='東京都',address='',description='',latitude=35.68+i*.001,longitude=139.76,
            tags={'recommendation_tier':'hidden' if i%2 else 'regional','leisure':'park'}) for i in range(6))
        self.assertGreaterEqual(len(build_discover_routes(request(),places)['routes']),2)
