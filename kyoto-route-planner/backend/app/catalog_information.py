"""Read accepted facility facts for public cards; never expose jobs or agent traces."""
import asyncio
from contextlib import closing
from datetime import datetime
from hashlib import sha256
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit
from typing import Annotated

from pydantic import BaseModel, Field
from app.cache import TTLCache
from app import catalog_firestore
from app.official_place_info import FIELDS, OfficialPlaceInfo
from app.public_catalog import load_public_places

log=logging.getLogger(__name__)
_cache=TTLCache(30,2048)
_slots=asyncio.Semaphore(4)
ID_PATTERN=r'^osm-(node|way|relation)-[0-9]+$'

class CatalogInformationRequest(BaseModel):
    ids: list[Annotated[str,Field(max_length=80,pattern=ID_PATTERN)]] = Field(min_length=1,max_length=60)

def public_url(value):
    if not isinstance(value,str) or len(value)>2048: return None
    try:
        p=urlsplit(value);host=p.hostname or ''
        if p.scheme not in {'http','https'} or p.username or p.password or not host or not '.' in host or host.endswith(('.local','.internal','.localhost')): return None
        try:
            if not ipaddress.ip_address(host).is_global: return None
        except ValueError: pass
        return value
    except ValueError: return None

def timestamp(value):
    if not isinstance(value,str): return None
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        return value if parsed.tzinfo else None
    except ValueError: return None

def read_rows(ids):
    if catalog_firestore.active():
        return catalog_firestore.accepted_rows(ids)
    path=Path(os.getenv('CATALOG_AGENT_DB',str(Path(__file__).resolve().parents[1]/'data/catalog_agent.sqlite3')))
    if not path.is_file(): return {}
    # Reading a public card must never create a DB or initialize the update queue.
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=1)) as db:
        db.row_factory=sqlite3.Row
        return {r['id']:dict(r) for r in db.execute('SELECT id,status,accepted FROM jobs WHERE id IN ('+','.join('?' for _ in ids)+')',ids)}

def store_key():
    if catalog_firestore.active():
        return ('firestore',os.getenv('GOOGLE_CLOUD_PROJECT'),os.getenv('CATALOG_FIRESTORE_DATABASE'))
    path=Path(os.getenv('CATALOG_AGENT_DB',str(Path(__file__).resolve().parents[1]/'data/catalog_agent.sqlite3')))
    def version(p):
        try:
            s=p.stat();return (s.st_mtime_ns,s.st_size)
        except OSError: return None
    return ('sqlite',str(path.resolve()),version(path),version(Path(str(path)+'-wal')))

def record(place,row):
    try:
        accepted=json.loads(row['accepted']) if isinstance(row.get('accepted'),str) else row.get('accepted')
        if not isinstance(accepted,dict): return None
        fields=accepted.get('fields',{})
        values={};sources={};dates={}
        for key in FIELDS:
            field=fields.get(key,{})
            value=field.get('value');url=public_url(field.get('url'));date=timestamp(field.get('checked_at'))
            if isinstance(value,str) and 0<len(value.strip())<=4000 and url and date:
                values[key]=value.strip();sources[key]=url;dates[key]=date
        if not values: return None
        official=OfficialPlaceInfo(url=public_url(accepted.get('url')) or next(iter(sources.values())),
            **values,field_sources=sources,checked_at=timestamp(accepted.get('checked_at')) or max(dates.values()),
            status='verified',note='施設DBに保存された確認済みの公式情報です。')
        status=row.get('status') if row.get('status') in {'updated','conflict','needs_review','failed'} else 'updated'
        result={'place_id':place.id,'name':place.name,'latitude':place.latitude,'longitude':place.longitude,
                'status':status,'official':official.model_dump(mode='json'),'field_checked_at':dates}
        result['revision']=sha256(json.dumps(result,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        return result
    except (ValueError,TypeError,KeyError,AttributeError): return None

async def catalog_information(ids):
    try:
        known={p.id:p for p in load_public_places()}
        ids=list(dict.fromkeys(i for i in ids if isinstance(i,str) and re.fullmatch(ID_PATTERN,i) and i in known))
        if not ids: return {'status':'ready','records':[],'refresh_seconds':60}
        key=store_key();found={};missing=[]
        for identifier in ids:
            hit,value=_cache.get((key,identifier))
            if hit: found[identifier]=value
            else: missing.append(identifier)
        if missing:
            async with asyncio.timeout(5),_slots:
                rows=await asyncio.to_thread(read_rows,missing)
            for identifier in missing:
                value=record(known[identifier],rows.get(identifier,{}))
                found[identifier]=value;_cache.set((key,identifier),value)
        return {'status':'ready','records':[found[i] for i in ids if found[i]],'refresh_seconds':60}
    except Exception as error:
        log.warning('Catalog information unavailable (%s)',type(error).__name__)
        return {'status':'unavailable','records':[],'refresh_seconds':60}

async def enrich_places(places):
    """Attach current accepted facts without mutating the bundled OSM catalog."""
    places=tuple(places);info={}
    for start in range(0,len(places),60):
        result=await catalog_information([p.id for p in places[start:start+60]])
        info.update({r['place_id']:r for r in result['records']})
    result=[]
    for place in places:
        value=info.get(place.id)
        if not value: result.append(place);continue
        official=value['official'];tags={**place.tags,'agent_status':value['status'],'official_checked_at':official['checked_at'],
                                      'official_source_url':official['url'],'catalog_revision':value['revision']}
        for key,source in official['field_sources'].items():
            tags.update({f'official_{key}':official[key],f'official_{key}_source_url':source,
                         f'official_{key}_checked_at':value['field_checked_at'][key]})
        result.append(place.model_copy(update={'tags':tags}))
    return tuple(result)
