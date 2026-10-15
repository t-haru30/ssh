"""Create-only migration. Run before enabling Scheduler; repeat safely after interruption."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from app import catalog_updater as agent


def snapshot(path):
    # SQLite read-only connection also sees committed WAL data from a running server.
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory=sqlite3.Row
        db.execute('BEGIN')
        jobs=[dict(r) for r in db.execute('SELECT * FROM jobs')]
        events=[dict(r) for r in db.execute('SELECT * FROM events ORDER BY seq')]
    return jobs,events


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sqlite',type=Path,help='Optional existing catalog_agent.sqlite3; imported BEFORE missing seeds')
    p.add_argument('--apply',action='store_true',help='Without this flag, validate and report only')
    args=p.parse_args()
    jobs,events=snapshot(args.sqlite) if args.sqlite else ([],[])
    print(json.dumps({'sqlite_jobs':len(jobs),'sqlite_events':len(events),
        'catalog_records':len(agent.catalog()['places']),'apply':args.apply}))
    if not args.apply:
        return
    if not agent.cloud.active():
        raise RuntimeError('Set CATALOG_STORE=firestore and target project/database explicitly')
    imported=agent.cloud.seed(jobs)
    # Stable namespace from source content's first event; retries never duplicate history.
    source=hashlib.sha256(json.dumps(events[0] if events else {},sort_keys=True).encode()).hexdigest()
    history=agent.cloud.import_events(events,source)
    seeded=agent.initialize()
    print(json.dumps({'imported_jobs':imported,'imported_events':history,'seeded_jobs':seeded,
        'skipped_existing_jobs':len(jobs)-imported}))


if __name__ == '__main__':
    main()
