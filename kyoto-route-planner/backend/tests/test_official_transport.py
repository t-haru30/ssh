from pathlib import Path
import ssl
import unittest
from unittest.mock import AsyncMock, Mock, patch

from curl_cffi import CurlOpt
from app.official_transport import compatible_fetch, verified_context


class OfficialCertificateTests(unittest.TestCase):
    def test_incomplete_server_chain_still_requires_a_trusted_root_and_hostname(self):
        context = verified_context("www.edu.city.kyoto.jp")
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertFalse(context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN)
        names = [cert['subject'] for cert in context.get_ca_certs()]
        self.assertTrue(any((('commonName', 'GlobalSign RSA OV SSL CA 2018'),) in name for name in names))

    def test_intermediate_is_not_added_for_unrelated_or_suffix_lookalike_hosts(self):
        system_certificates = set(ssl.create_default_context().get_ca_certs(binary_form=True))
        for hostname in ("museum.example", "www.edu.city.kyoto.jp.evil.example"):
            with self.subTest(hostname=hostname):
                with patch("app.official_transport.Path.read_text") as read_certificate:
                    context = verified_context(hostname)
                    read_certificate.assert_not_called()
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(context.check_hostname)
                self.assertEqual(set(context.get_ca_certs(binary_form=True)), system_certificates)

    def test_modified_intermediate_fails_closed(self):
        with patch("app.official_transport.Path.read_text", return_value=ssl.DER_cert_to_PEM_cert(b"unexpected")):
            with self.assertRaisesRegex(ValueError, "Unexpected"):
                verified_context("www.edu.city.kyoto.jp")


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
