import tempfile
import unittest
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.frontend_files import FrontendFiles


class FrontendFilesTests(unittest.TestCase):
    def test_entry_page_and_conditional_response_require_revalidation(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "index.html").write_text('<script src="/assets/new.js"></script>', encoding="utf-8")
            app = FastAPI()
            app.mount("/", FrontendFiles(directory=folder, html=True))
            with TestClient(app) as client:
                page = client.get("/")
                self.assertEqual(page.status_code, 200)
                self.assertEqual(page.headers["cache-control"], "no-cache, must-revalidate")
                cached = client.get("/", headers={"If-None-Match": page.headers["etag"]})
                self.assertEqual(cached.status_code, 304)
                self.assertEqual(cached.headers["cache-control"], "no-cache, must-revalidate")
