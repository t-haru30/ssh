"""TLS-compatible public-page GETs using the same verified DNS and CA roots."""
from pathlib import Path
import ssl
import tempfile
from urllib.parse import urlsplit

from curl_cffi import AsyncSession, CurlOpt
from curl_cffi.requests.exceptions import RequestException
import httpx


async def compatible_fetch(url: str, address: str, headers: dict[str, str], *,
                           max_bytes: int, timeout: float) -> tuple[int, dict[str, str], bytes]:
    """One bounded fallback for servers that reject the OpenSSL handshake.

    The caller has already validated every DNS answer. RESOLVE keeps the same
    public address, while the original hostname is used for SNI and certificate
    verification. No proxy, redirect, cookies, browser identity or JS execution.
    """
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    pinned = f"[{address}]" if ":" in address else address
    roots = "".join(ssl.DER_cert_to_PEM_cert(cert) for cert in
                    ssl.create_default_context().get_ca_certs(binary_form=True))
    if not roots:
        raise httpx.ConnectError("No trusted certificate authorities")
    # curl's TLS implementation needs a CA file. Use exactly the OS trust roots,
    # and remove this public certificate bundle even on cancellation/failure.
    with tempfile.TemporaryDirectory(prefix="conciergo-ca-") as directory:
        ca_file = Path(directory) / "trusted.pem"
        ca_file.write_text(roots, encoding="ascii")
        try:
            async with AsyncSession(
                trust_env=False, verify=str(ca_file), timeout=timeout, retry=0,
                curl_options={CurlOpt.RESOLVE: [f"{parsed.hostname}:{port}:{pinned}".encode("ascii")],
                              CurlOpt.PROXY: b"", CurlOpt.MAXFILESIZE_LARGE: max_bytes},
            ) as client:
                async with client.stream("GET", url, headers=headers, allow_redirects=False) as response:
                    body = bytearray()
                    async for chunk in response.aiter_content():
                        body.extend(chunk)
                        if len(body) > max_bytes:
                            raise ValueError("Response too large")
                    return response.status_code, {str(k).lower(): str(v) for k, v in response.headers.items()}, bytes(body)
        except RequestException:
            raise httpx.ConnectError("Official site TLS connection failed") from None
