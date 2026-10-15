import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.frontend_files import FrontendFiles


class FrontendFilesTests(unittest.TestCase):
    def test_webp_is_an_image_even_without_a_system_mime_mapping(self):
        with tempfile.TemporaryDirectory() as folder:
            image = b"RIFF\x04\x00\x00\x00WEBP"
            Path(folder, "generated.webp").write_bytes(image)
            app = FastAPI()
            app.mount("/", FrontendFiles(directory=folder, html=True))
            with patch("starlette.responses.guess_type", return_value=(None, None)), TestClient(app) as client:
                response = client.get("/generated.webp")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "image/webp")
                self.assertEqual(response.content, image)
                partial = client.get("/generated.webp", headers={"Range": "bytes=0-3"})
                self.assertEqual(partial.status_code, 206)
                self.assertEqual(partial.headers["content-type"], "image/webp")
                self.assertEqual(partial.content, b"RIFF")

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
