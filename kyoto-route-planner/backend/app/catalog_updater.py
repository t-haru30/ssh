"""Persistent observe/decide/act/recheck agent for the experimental catalog.

Gemini selects bounded actions; deterministic rules gate source-backed facts.
Official observations are a separate overlay; original OSM/editorial data survive.
"""
import asyncio
from contextlib import closing
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import sqlite3
import time

from app.models import Place
from app.official_place_info import FIELDS, SEED_PATH, fetch_matched_official_info
from app.public_catalog import PUBLIC_CATALOG_PATH
from app.catalog_gemini import judge, model_name
from app import catalog_firestore as cloud
from app import catalog_metrics
from app.catalog_url_search import discover
from app.catalog_extraction import enrich

DAY = 86400
INTERVAL = 300
STALE = 30 * DAY
log = logging.getLogger(__name__)
lock = asyncio.Lock()


def enabled():
    return os.getenv('CATALOG_AGENT_ENABLED', '0') == '1' and not cloud.active() and not os.getenv('K_SERVICE')


def connect():
    path = Path(os.getenv('CATALOG_AGENT_DB', str(Path(__file__).resolve().parents[1] / 'data/catalog_agent.sqlite3')))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.executescript('''
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, next_check REAL NOT NULL, attempted REAL,
        status TEXT NOT NULL DEFAULT 'pending', failures INTEGER NOT NULL DEFAULT 0,
        accepted TEXT, note TEXT NOT NULL DEFAULT '未確認', priority INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL,
        at REAL NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
        evidence TEXT NOT NULL, changes TEXT NOT NULL, next_check REAL NOT NULL);
    ''')
    return db


def catalog():
    return json.loads(PUBLIC_CATALOG_PATH.read_text(encoding='utf-8'))


def initialize():
    places = catalog()['places']
    seeds = {p['id'] for p in json.loads(SEED_PATH.read_text(encoding='utf-8'))['places']}
    rows = []
    for p in places:
        tags = p.get('tags', {})
        if tags.get('catalog_kind') != 'facility' or tags.get('recommendation_status') != 'eligible':
            continue
        try:
            due = datetime.fromisoformat(tags['official_checked_at'].replace('Z', '+00:00')).timestamp() + STALE
        except (KeyError, ValueError, TypeError):
            due = 0
        priority = (2 if p['id'] in seeds else 0) + (1 if tags.get('recommendation_tier') == 'classic' else 0)
        rows.append({'id':p['id'], 'next_check':due, 'priority':priority, 'attempted':None,
                     'status':'pending', 'failures':0, 'accepted':None, 'note':'未確認'})
    if cloud.active():
        return cloud.seed(rows)
    with closing(connect()) as db, db:
        for row in rows:
            db.execute('INSERT OR IGNORE INTO jobs(id,next_check,priority) VALUES(?,?,?)',
                       (row['id'],row['next_check'],row['priority']))



def decide(previous, result):
    facts = {k: getattr(result, k) for k in FIELDS if getattr(result, k) and result.field_sources.get(k)}
    if not result.checked_at or not facts:
        return 'needs_review', '施設名・具体的な営業時間等の根拠が不足。確認日時は更新しません', None, {}
    evidence = {'checked_at': result.checked_at, 'url': result.url, 'facts': facts,
                'sources': {k: result.field_sources[k] for k in facts},
                'notices': [n.model_dump(mode='json') for n in result.notices]}
    old_facts = {k: f['value'] for k, f in (previous or {}).get('fields', {}).items()}
    changes = {k: {'before': old_facts.get(k), 'after': v}
               for k, v in facts.items() if old_facts.get(k) != v}
    if result.notices or any(v['before'] is not None for v in changes.values()):
        return 'conflict', '以前の確認値との差分または休業告知あり。前回値を保持して要確認', None, changes
    # Fields not found on this pass retain their own old timestamps.
    fields = dict((previous or {}).get('fields', {}))
    fields.update({k: {'value': v, 'url': evidence['sources'][k], 'checked_at': result.checked_at,
                      **({'evidence': result.field_evidence[k]} if k in result.field_evidence else {})} for k, v in facts.items()})
    evidence['fields'] = fields
    return 'updated', '施設名と公式ページの記載を照合。根拠のある項目だけ保存', evidence, changes


async def run_batch(limit=3, facility_ids=None):
    if not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("Batch size must be between 1 and 500")
    if facility_ids is not None and (not cloud.active() or len(facility_ids) != limit or len(set(facility_ids)) != limit):
        raise ValueError('Explicit trial requires unique IDs matching batch size and Firestore')
    if lock.locked():
        return {'processed': 0, 'busy': True}
    async with lock:
        if not cloud.active():
            initialize()
        places = {p['id']: p for p in catalog()['places']}
        processed = 0
        for index in range(limit):
            facility_started = time.monotonic()
            now = time.time()
            if cloud.active():
                row = cloud.claim(now, facility_id=facility_ids[index]) if facility_ids is not None else cloud.claim(now)
                if not row:
                    break
            else:
                with closing(connect()) as db, db:
                    db.execute('BEGIN IMMEDIATE')
                    row = db.execute('SELECT * FROM jobs WHERE next_check<=? ORDER BY attempted IS NOT NULL, next_check, priority DESC, id LIMIT 1', (now,)).fetchone()
                    if not row:
                        break
                    # Lease survives a crash and prevents concurrent processes selecting this job.
                    db.execute('UPDATE jobs SET next_check=? WHERE id=?', (now + 900, row['id']))
            p = places.get(row['id'])
            if not p:
                continue
            previous = json.loads(row['accepted']) if row['accepted'] else None
            evidence, changes, accepted = {}, {}, None
            trace = []
            search_trace = None
            matched_url = (previous or {}).get("url", "")
            try:
                place = Place.model_validate({**p, 'access_point': '', 'themes': []})
                # Empty matched URL invokes identity-checked OSM/Wikipedia discovery.
                # Existing seed URLs take precedence. Bypass response cache for fresh evidence.
                extracted = None
                for attempt in range(2):
                    result = await asyncio.wait_for(fetch_matched_official_info(place, matched_url), 30)
                    if not result.checked_at and search_trace is None and os.getenv('CATALOG_URL_SEARCH_ENABLED', '0') == '1':
                        found, search_trace = await discover(place)
                        if found is not None:
                            result = found
                            matched_url = search_trace['verified_url']
                    if extracted is None:
                        result = await enrich(place, result)
                        if result.extraction_trace:
                            extracted = result
                    elif result.checked_at and (extracted.extraction_trace.get('status') == 'extracted' or not any(getattr(result, f) for f in FIELDS)):
                        result = extracted
                    evidence = result.model_dump(mode='json')
                    decision, model = await asyncio.wait_for(judge(place, result, previous, attempt), 40)
                    trace.append({'step':attempt+1, 'model':model, **decision.model_dump(),
                                  'observation':result.model_dump(mode='json')})
                    if decision.action == 'review' and attempt == 0 and extracted is None and result.checked_at:
                        refined = await enrich(place, result, force=True)
                        if refined.extraction_trace:
                            extracted = refined
                            continue
                    if decision.action == 'recheck' and attempt == 0:
                        continue
                    # Evaluate conflicts against ALL observations before any model filtering.
                    status, note, accepted, changes = decide(previous, result)
                    if decision.action != 'accept':
                        status, note, accepted = 'needs_review', 'Gemini判断：'+decision.reason, None
                    elif status == 'updated':
                        selected = result.model_copy(deep=True)
                        for field in FIELDS:
                            if field not in decision.fields:
                                setattr(selected, field, None)
                                selected.field_sources.pop(field, None)
                        status, note, accepted, changes = decide(previous, selected)
                        note += '。Gemini判断：'+decision.reason
                    break
            except Exception as error:
                log.warning('Catalog check failed: %s (%s)', p['id'], type(error).__name__)
                status, note, accepted = 'failed', '取得またはGemini判断に失敗。前回値を保持して再試行', None
                trace.append({'error':type(error).__name__})
            evidence['agent_trace'] = trace
            if search_trace is not None:
                evidence['url_search'] = search_trace
                if accepted is not None and search_trace.get('status') == 'verified':
                    accepted['url_search'] = search_trace
            if catalog_metrics.current.get() is not None:
                evidence['run_id'] = catalog_metrics.current.get()['run_id']
            failures = 0 if accepted else row['failures'] + 1
            delay = STALE if accepted else min(7 * DAY, 3600 * 2 ** min(failures - 1, 8))
            now = time.time()
            if cloud.active():
                cloud.finish(row, {'id':p['id'],'name':p['name'],'at':now,'status':status,'note':note,
                    'evidence':json.dumps(evidence,ensure_ascii=False),'changes':json.dumps(changes,ensure_ascii=False),
                    'next_check':now+delay}, accepted, failures)
            else:
                with closing(connect()) as db, db:
                    db.execute('UPDATE jobs SET attempted=?,next_check=?,status=?,failures=?,accepted=?,note=? WHERE id=?',
                               (now, now+delay, status, failures, json.dumps(accepted, ensure_ascii=False) if accepted else row['accepted'], note, p['id']))
                    db.execute('INSERT INTO events(id,name,at,status,note,evidence,changes,next_check) VALUES(?,?,?,?,?,?,?,?)',
                               (p['id'], p['name'], now, status, note, json.dumps(evidence, ensure_ascii=False), json.dumps(changes, ensure_ascii=False), now+delay))
            processed += 1
            catalog_metrics.facility_finished(p["id"], status, time.monotonic() - facility_started)
        return {'processed': processed, 'busy': False}


def report():
    if cloud.active():
        counts, events, due = cloud.report_data()
    else:
        with closing(connect()) as db:
            counts = dict(db.execute('SELECT status,COUNT(*) FROM jobs GROUP BY status').fetchall())
            events = [dict(r) for r in db.execute('SELECT * FROM events ORDER BY seq DESC LIMIT 50')]
            due = db.execute('SELECT COUNT(*) FROM jobs WHERE next_check<=?', (time.time(),)).fetchone()[0]
    for e in events:
        e['evidence'] = json.loads(e['evidence'])
        e['changes'] = json.loads(e['changes'])
    return {'enabled': enabled(), 'running': lock.locked(), 'interval_seconds': INTERVAL,
            'recheck_days': 30, 'due': due, 'counts': counts, 'events': events,
            'engine': 'Gemini + server rules', 'model': model_name(),
            'scheduled': cloud.active(), 'daily_limit': int(os.getenv('CATALOG_DAILY_LIMIT','100')) if cloud.active() else None}


def merged_catalog():
    data = catalog()
    if cloud.active():
        rows = cloud.checked_rows()
    else:
        with closing(connect()) as db:
            rows = {r['id']: r for r in db.execute('SELECT * FROM jobs WHERE attempted IS NOT NULL')}
    for p in data['places']:
        r = rows.get(p['id'])
        if not r:
            continue
        t = p.setdefault('tags', {})
        t['agent_status'] = r['status']
        if r['accepted']:
            accepted = json.loads(r['accepted'])
            t['official_checked_at'] = accepted['checked_at']
            t['official_source_url'] = accepted['url'] or ''
            for k, field in accepted['fields'].items():
                t['official_' + k] = field['value']
                t['official_' + k + '_checked_at'] = field['checked_at']
                t['official_' + k + '_source_url'] = field['url']
    return data


async def worker():
    while True:
        try:
            await run_batch()
        except Exception:
            log.exception('Catalog agent batch failed')
        await asyncio.sleep(INTERVAL)
