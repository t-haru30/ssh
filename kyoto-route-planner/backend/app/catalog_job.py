"""Finite Cloud Run Job: python -m app.catalog_job (never starts web workers)."""
import asyncio
import json
from app.ai_settings import configure_ai_environment
from app import catalog_updater


def main():
    if not catalog_updater.cloud.active():
        raise RuntimeError('Cloud job requires CATALOG_STORE=firestore')
    configure_ai_environment()
    result = asyncio.run(catalog_updater.run_batch(3))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
