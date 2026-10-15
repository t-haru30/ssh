"""Firestore persistence for catalog updates, with transactional leases and daily cap."""
import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache


def active():
    backend = os.getenv('CATALOG_STORE', 'sqlite')
    if backend not in {'sqlite', 'firestore'}:
        raise ValueError('CATALOG_STORE must be sqlite or firestore')
    return backend == 'firestore'


@lru_cache(maxsize=1)
def client():
    from google.cloud import firestore
    project = os.environ['GOOGLE_CLOUD_PROJECT']
    database = os.environ['CATALOG_FIRESTORE_DATABASE']
    return firestore.Client(project=project, database=database)


def collection(name):
    return client().collection('catalog_' + name)


def seed(rows):
    """Create-only, restartable migration; never reset prior checks."""
    from google.api_core.exceptions import AlreadyExists
    created = 0
    for start in range(0, len(rows), 100):
        group = rows[start:start+100]
        batch = client().batch()
        for row in group:
            batch.create(collection('jobs').document(row['id']), row)
        try:
            batch.commit()
            created += len(group)
        except AlreadyExists:
            # A partially migrated group must never overwrite previously verified rows.
            for row in group:
                try:
                    collection('jobs').document(row['id']).create(row)
                    created += 1
                except AlreadyExists:
                    pass
    return created


def claim(now=None):
    from google.cloud import firestore
    from google.cloud.firestore_v1.base_query import FieldFilter
    now = time.time() if now is None else now
    limit = int(os.getenv('CATALOG_DAILY_LIMIT', '100'))
    if limit < 0:
        raise ValueError('CATALOG_DAILY_LIMIT must be nonnegative')
    day = datetime.fromtimestamp(now, timezone(timedelta(hours=9))).date().isoformat()
    budget = collection('days').document(day)
    candidates = list(collection('jobs').where(filter=FieldFilter('next_check', '<=', now)).order_by('next_check').limit(30).stream())
    candidates.sort(key=lambda d:(d.to_dict()['next_check'], -d.to_dict().get('priority',0)))
    for candidate in candidates:
        token = uuid.uuid4().hex
        @firestore.transactional
        def reserve(tx):
            row = candidate.reference.get(transaction=tx).to_dict()
            usage = budget.get(transaction=tx).to_dict() or {}
            if not row or row['next_check'] > now or usage.get('reserved',0) >= limit:
                return None
            tx.update(candidate.reference, {'next_check':now+900, 'lease':token})
            tx.set(budget, {'reserved':usage.get('reserved',0)+1})
            return {**row, 'lease':token}
        row = reserve(client().transaction())
        if row:
            return row
    return None


def finish(row, event, accepted, failures):
    from google.cloud import firestore
    ref = collection('jobs').document(row['id'])
    # Token also identifies the event, making transaction retries idempotent.
    event_ref = collection('events').document(row['lease'])
    @firestore.transactional
    def commit(tx):
        current = ref.get(transaction=tx).to_dict()
        if not current or current.get('lease') != row['lease']:
            raise RuntimeError('Catalog lease expired or replaced')
        tx.update(ref, {'attempted':event['at'], 'next_check':event['next_check'],
            'status':event['status'], 'note':event['note'], 'failures':failures,
            'accepted':json.dumps(accepted,ensure_ascii=False) if accepted else row.get('accepted'), 'lease':None})
        tx.create(event_ref, {**event, 'seq':row['lease']})
    commit(client().transaction())


def report_data():
    from google.cloud import firestore
    from google.cloud.firestore_v1.base_query import FieldFilter
    def count(query):
        return query.count().get()[0][0].value
    counts = {s:count(collection('jobs').where(filter=FieldFilter('status','==',s)))
              for s in ('pending','updated','needs_review','conflict','failed')}
    events = [d.to_dict() for d in collection('events').order_by('at',direction=firestore.Query.DESCENDING).limit(50).stream()]
    due = count(collection('jobs').where(filter=FieldFilter('next_check','<=',time.time())))
    return counts, events, due


def checked_rows():
    from google.cloud.firestore_v1.base_query import FieldFilter
    return {d.id:d.to_dict() for d in collection('jobs').where(filter=FieldFilter('attempted','>',0)).stream()}


def accepted_rows(ids):
    """Bounded read for visible cards; no full collection scan or history access."""
    refs=[collection('jobs').document(identifier) for identifier in ids]
    return {d.id:{'status':d.to_dict().get('status'),'accepted':d.to_dict().get('accepted')}
            for d in client().get_all(refs,field_paths=['status','accepted'],retry=None,timeout=3) if d.exists}


def import_events(rows, source):
    from google.api_core.exceptions import AlreadyExists
    count = 0
    for row in rows:
        identifier=hashlib.sha256(f'{source}:{row["seq"]}'.encode()).hexdigest()
        try:
            collection('events').document(identifier).create({**row,'seq':identifier})
            count += 1
        except AlreadyExists:
            pass
    return count
