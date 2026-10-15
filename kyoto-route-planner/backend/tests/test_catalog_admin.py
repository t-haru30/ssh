import os
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.catalog_admin import CatalogAdminGuard, protected, router


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.add_middleware(CatalogAdminGuard)
        self.app.include_router(router)
        @self.app.get('/')
        def public():
            return {'public': True}

    def test_public_denies_all_admin_surfaces_and_spoofed_identity(self):
        with patch.dict(os.environ, {'K_SERVICE': 'public', 'CATALOG_ADMIN_ENABLED': '0'}):
            client = TestClient(self.app)
            self.assertEqual(client.get('/').status_code, 200)
            for path in ['/facility-catalog.html', '/catalog-admin.mjs', '/api/catalog-agent',
                         '/api/catalog-agent/catalog', '/api/facility-memory', '/%66acility-catalog.html']:
                self.assertEqual(client.get(path, headers={'X-Goog-Authenticated-User-Email': 'admin@example.com'}).status_code, 403)
            self.assertEqual(client.post('/api/catalog-agent/run').status_code, 403)

    def test_private_service_reads_but_cannot_trigger_cloud_jobs(self):
        with patch.dict(os.environ, {'K_SERVICE': 'private-admin', 'CATALOG_ADMIN_ENABLED': '1'}), patch('app.catalog_updater.report', return_value={'events': []}):
            client = TestClient(self.app)
            response = client.get('/api/catalog-agent')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertEqual(client.post('/api/catalog-agent/run').status_code, 403)

    def test_local_remote_access_denied(self):
        with patch.dict(os.environ, {'K_SERVICE': '', 'CATALOG_ADMIN_ENABLED': '1'}):
            self.assertEqual(TestClient(self.app).get('/api/catalog-agent').status_code, 403)

    def test_normalized_paths_protected(self):
        for path in ['/x/../facility-catalog.html', '/%66acility-catalog.html', '/%2566acility-catalog.html', '//api/catalog-agent/catalog']:
            self.assertTrue(protected(path), path)


if __name__ == '__main__':
    unittest.main()
