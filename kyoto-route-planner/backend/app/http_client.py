import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

MAX_ATTEMPTS = 2
MAX_RETRY_AFTER_SECONDS = 1.5
RETRYABLE_STATUS_CODES = {429}


def provider_timeout(total_seconds: float) -> httpx.Timeout:
    return httpx.Timeout(
        timeout=total_seconds,
        connect=min(3.0, total_seconds),
        read=total_seconds,
        write=min(5.0, total_seconds),
        pool=min(3.0, total_seconds),
    )


def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                return min(max(float(retry_after), 0.0), MAX_RETRY_AFTER_SECONDS)
            except ValueError:
                pass
    return min(0.2 * (2**attempt) + random.uniform(0.0, 0.1), 0.5)


async def request_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    attempts: int = MAX_ATTEMPTS,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    **kwargs: Any,
) -> httpx.Response:
    if attempts < 1:
        raise ValueError("attempts must be at least one")

    last_error: httpx.RequestError | None = None
    for attempt in range(attempts):
        try:
            request: Callable[..., Awaitable[httpx.Response]] = getattr(client, method.lower())
            response = await request(url, **kwargs)
        except httpx.RequestError as error:
            last_error = error
            if attempt + 1 == attempts:
                raise
            await sleep(_retry_delay(attempt, None))
            continue

        retryable_status = (
            response.status_code in RETRYABLE_STATUS_CODES
            or response.status_code >= 500
        )
        if not retryable_status or attempt + 1 == attempts:
            return response

        delay = _retry_delay(attempt, response)
        await response.aclose()
        await sleep(delay)

    if last_error is not None:
        raise last_error
    raise RuntimeError("HTTP retry loop ended without a response")
