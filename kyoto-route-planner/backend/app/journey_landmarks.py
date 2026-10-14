"""Named facilities beyond the editor's finite list. OSM facts stay independent."""
import asyncio
import json
import re
from pathlib import Path
import httpx
from app.public_catalog import load_public_places, _normalized
from app.google_place_photos import BASE, google_api_key, reserve_lookup, same_google_venue
from app.models import Place

SEEDS=Path(__file__).parent/'data/landmark_seeds.json'

def record(place):
    tags={**place.tags,'source':'OpenStreetMap','license':'ODbL-1.0','source_url':'https://www.openstreetmap.org/'+place.id.removeprefix('osm-').replace('-','/',1)}
    return dict(id=place.id,name=place.name,category=place.category,latitude=place.latitude,longitude=place.longitude,
        description=place.description,access_point='',themes=[],address=place.address,tags=tags)

def parse_records(rows,norm):
    result=[]
    for row in rows[:30]:
        try:
            tags=row.get('tags',{});point=row.get('center',row)
            name=tags.get('name:ja') or tags.get('name','')
            if _normalized(name)!=norm or row.get('type') not in {'node','way','relation'} or type(row.get('id')) is not int:continue
            if not (20<=point.get('lat',0)<=46 and 122<=point.get('lon',0)<=154):continue
            if tags.get('access')=='private' or any(k.startswith(('disused:','abandoned:','demolished:')) for k in tags):continue
            if tags.get('railway') in {'station','halt','platform'}:continue
            category='寺院' if tags.get('religion')=='buddhist' or name.endswith('寺') else '神社' if tags.get('religion')=='shinto' else '観光名所'
            kept={k:v for k,v in tags.items() if k in {'name','name:ja','name:en','website','wikidata','wikipedia','opening_hours','tourism','historic','religion'} and isinstance(v,str) and len(v)<500}
            result.append(record(Place(id=f"osm-{row['type']}-{row['id']}",name=name,category=category,latitude=point['lat'],longitude=point['lon'],description='',access_point='',themes=[],tags=kept)))
        except (ValueError,TypeError,KeyError,AttributeError):continue
    return result

def seed_records(norm):
    try:
        data=json.loads(SEEDS.read_text(encoding='utf-8'))
        return parse_records(data.get('elements',[]),norm) if data.get('license')=='ODbL-1.0' else []
    except (OSError,ValueError,TypeError):return []

async def named_landmarks(client,query,origin=None):
    query=query.strip()
    if not 2<=len(query)<=60 or not re.search(r'[\w\u3040-\u9fff]',query):return []
    norm=_normalized(query)
    from app.discovery import distance_km,distinct_venues
    def ranked(rows):
        places=distinct_venues([Place(**p) for p in rows])
        if origin:places.sort(key=lambda p:distance_km(origin,p))
        return [record(p) for p in places[:16]]
    found=[record(p) for p in load_public_places() if norm in _normalized(p.name)]
    found.extend(seed_records(norm))
    exact=[p for p in found if _normalized(p['name'])==norm]
    if exact:return ranked(exact)
    literal=json.dumps(query,ensure_ascii=False)
    osm_query=f'[out:json][timeout:6];(nwr["name"={literal}](24,122,46,146);nwr["name:ja"={literal}](24,122,46,146););out center tags 30;'
    async def osm():
        for endpoint in ['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter']:
            try:
                r=await client.post(endpoint,data={'data':osm_query},timeout=5)
                if r.status_code!=200 or len(r.content)>150_000:continue
                data=r.json()
                if data.get('remark'):continue
                return parse_records(data.get('elements',[]),norm)
            except (httpx.HTTPError,ValueError,TypeError,KeyError,AttributeError):continue
        return []
    async def google():
        key=google_api_key()
        if not key or not reserve_lookup():return []
        try:
            r=await client.post(BASE+'/places:searchText',headers={'X-Goog-Api-Key':key,'X-Goog-FieldMask':'places.displayName,places.location,places.businessStatus'},
                json={'textQuery':query+' 日本','languageCode':'ja','pageSize':3},timeout=8)
            return r.json().get('places',[])[:3] if r.status_code==200 and len(r.content)<50_000 else []
        except (httpx.HTTPError,ValueError,TypeError,KeyError,AttributeError):return []
    rows,google_rows=await asyncio.gather(osm(),google())
    found.extend(rows)
    independent=[]
    for row in found:
        matched=[p for p in google_rows if same_google_venue(Place(**row),p)]
        if matched and all(p.get('businessStatus') in {'CLOSED_PERMANENTLY','CLOSED_TEMPORARILY'} for p in matched):continue
        independent.append(row)
    return ranked(independent)
