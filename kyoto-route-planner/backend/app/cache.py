from collections import OrderedDict
from copy import deepcopy
from threading import Lock
from time import monotonic
from typing import Generic, TypeVar

Key = TypeVar("Key")
Value = TypeVar("Value")


class TTLCache(Generic[Key, Value]):
    def __init__(self, ttl_seconds: float, max_entries: int):
        if ttl_seconds <= 0 or max_entries < 1:
            raise ValueError("TTL and max_entries must be positive")
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: OrderedDict[Key, tuple[float, Value]] = OrderedDict()
        self._lock = Lock()

    def get(self, key: Key) -> tuple[bool, Value | None]:
        now = monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            expires_at, value = entry
            if expires_at <= now:
                del self._entries[key]
                return False, None
            self._entries.move_to_end(key)
            return True, deepcopy(value)

    def set(self, key: Key, value: Value) -> None:
        with self._lock:
            self._entries[key] = (monotonic() + self._ttl_seconds, deepcopy(value))
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
