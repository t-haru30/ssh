"""Opt-in live API verification; only independent names and counts are saved."""
import asyncio,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import facility_quality as quality
from app.discovery import DiscoverRequest,_discover_catalog
from app.catalog_policy import tier
from app.google_place_photos import same_google_venue

original=quality.select_reviewed
checks=[]
def checked(candidates,google):
    chosen=original(candidates,google)
    for p in chosen:
        assert not quality.chain(p),p.name
        if tier(p)!='classic' or quality.dining(p):
            matched={g['id']:g for g in google if isinstance(g.get('id'),str) and same_google_venue(p,g)}
            assert len(matched)==1 and quality.passes_reviews(next(iter(matched.values()))),p.name
    checks.append({'candidates':len(candidates),'selected':len(chosen),'reviewed':sum(tier(p)!='classic' or quality.dining(p) for p in chosen)})
    return chosen
quality.select_reviewed=checked

async def main():
    req=DiscoverRequest(area='tokyo',prefecture_name='東京都',origin={'name':'東京駅','latitude':35.681236,'longitude':139.767125},radius_km=15,count=10,meals=[{'kind':'lunch'}])
    result,pool=await _discover_catalog(req)
    output={'quality':result['catalog']['quality'],'checks':checks,'names':[p.name for p in pool],
            'dining':[p.name for p in pool if quality.dining(p)],'routes':len(result['routes'])}
    print(json.dumps(output,ensure_ascii=False,indent=2),flush=True)
    (Path(__file__).resolve().parents[2]/'.runtime/quality-live-summary.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    assert output['quality']['status']=='ready', 'Live ratings could not be checked'
    assert checks and checks[-1]['reviewed']>0,'No non-landmark facility passed live ratings'
    assert output['dining'],'No independent dining venue passed live ratings'

if __name__=='__main__':asyncio.run(main())
