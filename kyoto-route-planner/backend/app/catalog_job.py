"""Finite Cloud Run Job with configurable, measured facility checks."""
import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from app.ai_settings import configure_ai_environment
from app import catalog_updater, catalog_metrics


def main():
    if not catalog_updater.cloud.active():
        raise RuntimeError('Cloud job requires CATALOG_STORE=firestore')
    limit = int(os.getenv('CATALOG_BATCH_SIZE', '100'))
    if not 1 <= limit <= 500:
        raise ValueError('CATALOG_BATCH_SIZE must be between 1 and 500')
    trial_path = os.getenv('CATALOG_TRIAL_IDS_PATH')
    facility_ids = json.loads(Path(trial_path).read_text(encoding='utf-8')) if trial_path else None
    if facility_ids is not None and (not isinstance(facility_ids,list) or not all(isinstance(v,str) for v in facility_ids)):
        raise ValueError('Trial IDs must be a list of strings')
    configure_ai_environment()
    run_id = os.getenv('CLOUD_RUN_EXECUTION') or str(uuid.uuid4())
    state = catalog_metrics.start(run_id)
    catalog_metrics.emit('catalog_batch_started', requested=limit)
    started = time.monotonic()
    try:
        result = asyncio.run(catalog_updater.run_batch(limit, facility_ids=facility_ids))
    except Exception as error:
        catalog_metrics.emit('catalog_batch_failed', error_type=type(error).__name__,
                             seconds=round(time.monotonic()-started, 3), metrics=state)
        raise
    summary = {**result, 'requested':limit, 'seconds':round(time.monotonic()-started, 3),
               'metrics':state, 'complete': result['processed'] == limit}
    # Persist one summary for later cost/status review, independently of the 50-row UI history.
    catalog_updater.cloud.collection('runs').document(run_id).set(summary)
    catalog_metrics.emit('catalog_batch_finished', **summary)


if __name__ == '__main__':
    main()
