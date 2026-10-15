"""Per-execution usage accounting; never logs prompts or credentials."""
from contextvars import ContextVar
import json
import time

current = ContextVar('catalog_metrics', default=None)


def start(run_id):
    state = {'run_id': run_id, 'started_at': time.time(), 'gemini_calls': 0,
             'search_calls': 0, 'search_queries': 0, 'usage_responses': 0, 'prompt_tokens': 0, 'output_tokens': 0,
             'thought_tokens': 0, 'cached_tokens': 0, 'statuses': {}}
    current.set(state)
    return state


def emit(event, **values):
    state = current.get()
    if state is not None:
        print(json.dumps({'event': event, 'run_id': state['run_id'], **values}, ensure_ascii=False), flush=True)


def call_started(model):
    state = current.get()
    if state is not None:
        state['gemini_calls'] += 1


def response_received(model, data):
    state = current.get()
    if state is None:
        return
    usage = data.get('usageMetadata')
    if not isinstance(usage, dict):
        emit('catalog_gemini_usage_missing', model=model)
        return
    state['usage_responses'] += 1
    counts = {key: int(usage.get(source, 0) or 0) for key, source in (
        ('prompt_tokens', 'promptTokenCount'), ('output_tokens', 'candidatesTokenCount'),
        ('thought_tokens', 'thoughtsTokenCount'), ('cached_tokens', 'cachedContentTokenCount'))}
    for key, value in counts.items():
        state[key] += value
    emit('catalog_gemini_usage', model=model, **counts)


def facility_finished(facility_id, status, seconds):
    state = current.get()
    if state is not None:
        state['statuses'][status] = state['statuses'].get(status, 0) + 1
        emit('catalog_facility_finished', facility_id=facility_id, status=status, seconds=round(seconds, 3))


def search_finished(query_count):
    state = current.get()
    if state is not None:
        state['search_calls'] += 1
        state['search_queries'] += query_count
        emit('catalog_search_usage', queries=query_count)
