"""Use an independently sourced nearby airport for long journeys to/from Naha."""
import json
from math import asin,cos,radians,sin,sqrt
from pathlib import Path
from fastapi import HTTPException
from app.cache import TTLCache
_codes=TTLCache(21600,64)

def km(a,b):
    x=sin(radians(a[0]-b[0])/2)**2+cos(radians(a[0]))*cos(radians(b[0]))*sin(radians(a[1]-b[1])/2)**2
    return 12742*asin(sqrt(min(1,x)))

def selected_airports(points):
    if len(points)!=2:return None
    try:a,b=[tuple(map(float,p.split(','))) for p in points]
    except (TypeError,ValueError):return None
    if any(len(p)!=2 for p in [a,b]):return None
    naha=lambda p:25.9<=p[0]<=26.65 and 127.4<=p[1]<=128.15
    if naha(a)==naha(b) or km(a,b)<500:return None
    airports=json.loads((Path(__file__).parent/'data/airports.json').read_text(encoding='utf-8'))['airports']
    other=b if naha(a) else a
    nearest=min((p for p in airports if p['iata']!='OKA'),key=lambda p:km(other,(p['latitude'],p['longitude'])))
    if km(other,(nearest['latitude'],nearest['longitude']))>150:return None
    oka=next(p for p in airports if p['iata']=='OKA')
    return [oka,nearest] if naha(a) else [nearest,oka]

async def airport_via(points,resolve):
    airports=selected_airports(points)
    if not airports:return points
    codes=[]
    for airport in airports:
        hit,code=_codes.get(airport['iata'])
        if not hit:
            found=await resolve(airport['latitude'],airport['longitude'],radius_m=5000,station_count=5,transport_type='plane')
            valid=[p for p in found if isinstance(p.get('Station'),dict) and p['Station'].get('code') and p['Station'].get('Type') in ['plane',{'text':'plane'}]]
            if not valid:raise HTTPException(404,'近隣空港の航空経路を確認できません。「近くの空港を優先」を解除すると、ほかの空港も含めて検索できます。')
            code=str(valid[0]['Station']['code']);_codes.set(airport['iata'],code)
        codes.append(code)
    return [points[0],*codes,points[1]]
