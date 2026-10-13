from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

from curl_cffi import CurlOpt
from app.official_transport import compatible_fetch


class OfficialTransportTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, chunks):
        response = Mock(status_code=200, headers={"Content-Type": "text/html"})
        async def body():
            for chunk in chunks:
                yield chunk
        response.aiter_content = body
        stream = AsyncMock(); stream.__aenter__.return_value = response
        client = AsyncMock(); client.stream = Mock(return_value=stream)
        context = AsyncMock(); context.__aenter__.return_value = client
        return client, context

    async def test_trust_roots_pin_redirect_and_proxy_policy_are_preserved(self):
        client, context = self.fixture([b"hello"])
        checked = []
        def factory(**options):
            certificate = Path(options["verify"])
            self.assertTrue(certificate.is_file())
            self.assertIn("BEGIN CERTIFICATE", certificate.read_text())
            self.assertFalse(options["trust_env"])
            self.assertEqual(options["curl_options"][CurlOpt.RESOLVE], [b"museum.example:443:93.184.216.34"])
            self.assertEqual(options["curl_options"][CurlOpt.PROXY], b"")
            self.assertEqual(options["curl_options"][CurlOpt.MAXFILESIZE_LARGE], 10)
            checked.append(certificate)
            return context
        with patch("app.official_transport.AsyncSession", side_effect=factory):
            status, headers, body = await compatible_fetch("https://museum.example/", "93.184.216.34", {}, max_bytes=10, timeout=1)
        self.assertEqual((status, headers, body), (200, {"content-type": "text/html"}, b"hello"))
        self.assertFalse(client.stream.call_args.kwargs["allow_redirects"])
        self.assertFalse(checked[0].exists())

    async def test_stream_size_limit_also_covers_chunked_or_decompressed_bodies(self):
        _, context = self.fixture([b"12345", b"67890"])
        with patch("app.official_transport.AsyncSession", return_value=context):
            with self.assertRaisesRegex(ValueError, "too large"):
                await compatible_fetch("https://museum.example/", "93.184.216.34", {}, max_bytes=8, timeout=1)
