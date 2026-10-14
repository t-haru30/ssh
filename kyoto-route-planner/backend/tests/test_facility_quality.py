import unittest
from unittest.mock import AsyncMock,patch
from app.models import CatalogPlace
from app.discovery import DiscoverRequest
from app.facility_quality import chain,passes_reviews,select_reviewed,filter_quality

def place(identifier='local',name='地域の美術館',category='美術館',tier='regional',tags=None):
    return CatalogPlace(id=identifier,name=name,category=category,region='東京都',address='東京都',description='',latitude=35.68,longitude=139.76,
        tags={'recommendation_tier':tier,**(tags or {})})

def review(p,rating=4.2,count=50,**overrides):
    return {'id':'g-'+p.id,'displayName':{'text':p.name},'location':{'latitude':p.latitude,'longitude':p.longitude},
            'businessStatus':'OPERATIONAL','rating':rating,'userRatingCount':count,**overrides}

class QualityTests(unittest.TestCase):
    def test_rating_and_count_are_both_required(self):
        p=place()
        self.assertTrue(passes_reviews(review(p)))
        for r,n in [(4.1,500),(5,49),(None,100),(5,None),(float('nan'),100),(True,100),(5,True)]:
            self.assertFalse(passes_reviews(review(p,r,n)))
        self.assertFalse(passes_reviews(review(p,businessStatus='CLOSED_PERMANENTLY')))

    def test_only_landmarks_bypass_reviews_and_chains_never_do(self):
        classic=place('landmark',tier='classic');ordinary=place();chain_place=place('chain','スターバックス','カフェ','classic')
        self.assertEqual(select_reviewed((classic,ordinary,chain_place),()),(classic,))
        self.assertEqual(select_reviewed((classic,ordinary,chain_place),(review(ordinary),review(chain_place,5,10000))),(classic,ordinary))

    def test_identity_branch_and_ambiguity_are_checked(self):
        p=place(name='独立食堂 本店',category='飲食店')
        self.assertEqual(select_reviewed((p,),[review(p,displayName={'text':'独立食堂 支店'})]),())
        self.assertEqual(select_reviewed((p,),[review(p,location={'latitude':36,'longitude':139})]),())
        self.assertEqual(select_reviewed((p,),[review(p),review(p,id='different')]),())

    def test_google_fields_do_not_mutate_independent_records(self):
        p=place();before=p.model_dump()
        chosen=select_reviewed((p,),[review(p)])
        self.assertEqual(chosen,(p,));self.assertEqual(p.model_dump(),before)
        self.assertNotIn('rating',p.tags)

    def test_brand_metadata_and_chain_names_are_excluded(self):
        self.assertTrue(chain(place(category='飲食店',tags={'brand:wikidata':'Q123'})))
        self.assertTrue(chain(place(name='無名店 支店',category='飲食店')))
        self.assertFalse(chain(place(name='独立食堂',category='飲食店')))

class QualityAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_sparse_area_checks_local_and_hidden_sights_without_lowering_reviews(self):
        import httpx
        import json
        req=DiscoverRequest(area='tokyo',prefecture_name='東京都',origin={'name':'東京駅','latitude':35.68,'longitude':139.76},meals=[])
        classic=place('landmark','有名な城',tier='classic')
        regional=place('regional','地域の美術館')
        hidden=place('hidden','山あいの庭園',tier='hidden')
        low=place('low','低評価の資料館')
        pool=(classic,regional,hidden,low)
        calls=[]
        def respond(request):
            body=json.loads(request.content);calls.append(body)
            if request.url.path.endswith('searchNearby'):return httpx.Response(200,json={'places':[review(classic)]})
            matched=next(p for p in pool if body['textQuery']==p.name+' '+p.region)
            return httpx.Response(200,json={'places':[review(matched,4.1 if matched.id=='low' else 4.5)]})
        client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch('app.google_place_photos.google_api_key',return_value='test'), patch('app.google_place_photos.reserve_lookup',return_value=True), patch('app.facility_quality.httpx.AsyncClient',return_value=client):
            chosen,status=await filter_quality(req,pool)
        self.assertEqual({p.id for p in chosen},{'landmark','regional','hidden'})
        self.assertEqual(status['verified_count'],2)
        self.assertLessEqual(sum('textQuery' in c for c in calls),6)

    async def test_missing_key_does_not_recommend_unknown_ratings(self):
        req=DiscoverRequest(area='tokyo',prefecture_name='東京都',origin={'name':'東京駅','latitude':35.68,'longitude':139.76},meals=[])
        p=place(name='地域の資料館');classic=place('landmark',tier='classic')
        with patch('app.google_place_photos.google_api_key',return_value=''):
            chosen,status=await filter_quality(req,(p,classic))
        self.assertEqual(chosen,(classic,));self.assertEqual(status['status'],'reviews_unavailable')
