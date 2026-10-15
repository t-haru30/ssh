"""Deployment invariants: public mode must never expose the management service."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('cloud_catalog', Path(__file__).resolve().parents[2] / 'scripts/cloud_catalog.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentTests(unittest.TestCase):
    def test_admin_private_and_public_routes_disabled(self):
        for public in (False, True):
            args = SimpleNamespace(action='deploy', project='test-project', region='asia-northeast1',
                                   name='test-web', database='test-db', tag='abc123', daily_limit=100,
                                   public_web=public)
            commands = list(module.commands(args))
            web = next(c for c in commands if c[1:4] == ['run', 'deploy', 'test-web'])
            admin = next(c for c in commands if c[1:4] == ['run', 'deploy', 'test-web-admin'])
            self.assertIn('CATALOG_ADMIN_ENABLED=0', web[web.index('--update-env-vars')+1])
            self.assertIn('--no-allow-unauthenticated', admin)
            self.assertIn('--invoker-iam-check', admin)
            self.assertNotIn('--allow-unauthenticated', admin)
            self.assertIn('CATALOG_ADMIN_ENABLED=1', admin[admin.index('--update-env-vars')+1])


if __name__ == '__main__':
    unittest.main()
