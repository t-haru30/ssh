"""Per-request routing preferences; never shared between concurrent travelers."""
from contextlib import contextmanager
from contextvars import ContextVar
options=ContextVar('routing_options',default=('time',True))
@contextmanager
def routing_preferences(priority='time',nearby_airport=True):
    token=options.set((priority,nearby_airport))
    try:yield
    finally:options.reset(token)
