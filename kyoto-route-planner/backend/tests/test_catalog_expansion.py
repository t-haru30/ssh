from collections import Counter
import unittest
from app.public_catalog import load_public_places
from app.facility_quality import chain,dining

class CatalogExpansionTests(unittest.TestCase):
    def test_every_prefecture_has_at_least_50_new_sights_and_30_dining_candidates(self):
        places=load_public_places();new=[p for p in places if p.tags.get('addition_batch')=='prefecture-50-v1']
        self.assertEqual(len(places),len({p.id for p in places}))
        sights=Counter(p.region for p in new if not dining(p));food=Counter(p.region for p in new if dining(p))
        self.assertEqual(len(sights),47);self.assertEqual(len(food),47)
        self.assertGreaterEqual(min(sights.values()),50);self.assertGreaterEqual(min(food.values()),30)
        for region in ['東京都','京都府','大阪府','北海道','福岡県']:
            self.assertGreaterEqual(sights[region],120);self.assertGreaterEqual(food[region],80)

    def test_new_food_never_gets_rating_exemption_or_chain_metadata(self):
        for p in load_public_places():
            if p.tags.get('addition_batch')!='prefecture-50-v1':continue
            self.assertFalse(chain(p),p.name)
            self.assertEqual(p.tags['catalog_kind'],'facility',p.name)
            self.assertTrue(p.tags['source_url'].endswith(p.source_record_id),p.name)
            self.assertNotIn('rating',p.tags);self.assertNotIn('userRatingCount',p.tags)
            if dining(p):self.assertEqual(p.tags['quality_policy'],'live_reviews_required',p.name)

    def test_same_name_local_shrine_does_not_inherit_landmark_exemption(self):
        shrines=[p for p in load_public_places() if p.name=='榛名神社' and p.tags.get('recommendation_tier')=='classic']
        self.assertEqual(len(shrines),1)
        self.assertEqual(shrines[0].tags.get('wikidata'),'Q3128007')
