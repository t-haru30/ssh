"""Admin-only catalog surfaces. Cloud access is authenticated by private Cloud Run IAM.

Enable CATALOG_ADMIN_ENABLED only on a separate IAM-private service. The public
service denies these paths before static files or API handlers can read the DB.
Local access is opt-in and restricted to loopback. No browser-supplied identity
header grants access.
"""
import os
import posixpath
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

router = APIRouter()


def protected(path):
    for _ in range(4):
        decoded = unquote(path)
        if decoded == path:
            break
        path = decoded
    path = '/' + posixpath.normpath(path.replace('\\', '/')).lstrip('/')
    name = path.rsplit('/', 1)[-1]
    return (path.startswith('/api/catalog-agent') or path.startswith('/api/facility-memory')
            or name == 'facility-catalog.html' or name.startswith('catalog-'))


class CatalogAdminGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and protected(scope['path']):
            enabled = os.getenv('CATALOG_ADMIN_ENABLED') == '1'
            local = (scope.get('client') or ('',))[0] in {'127.0.0.1', '::1'}
            if not enabled or (not os.getenv('K_SERVICE') and not local):
                await JSONResponse({'detail': '施設管理は認証付き管理サービスから利用してください。'},
                                   status_code=403, headers={'Cache-Control': 'no-store'})(scope, receive, send)
                return
            async def private_send(message):
                if message['type'] == 'http.response.start':
                    message['headers'] = [(k, v) for k, v in message.get('headers', [])
                                          if k.lower() != b'cache-control']
                    message['headers'].append((b'cache-control', b'no-store'))
                    message['headers'].append((b'x-robots-tag', b'noindex, nofollow'))
                await send(message)
            await self.app(scope, receive, private_send)
            return
        await self.app(scope, receive, send)


@router.get('/api/catalog-agent')
def report():
    from app.catalog_updater import report
    return report()


@router.get('/api/catalog-agent/catalog')
def catalog():
    from app.catalog_updater import merged_catalog
    return merged_catalog()


@router.post('/api/catalog-agent/run')
async def run(request: Request):
    from app.catalog_firestore import active
    if active() or os.getenv('K_SERVICE'):
        raise HTTPException(403, 'Use authenticated Cloud Run Job execution')
    origin = request.headers.get('origin')
    if origin and urlsplit(origin).netloc != request.headers.get('host'):
        raise HTTPException(403, 'Same origin required')
    from app.catalog_updater import initialize, run_batch
    initialize()
    return await run_batch()
