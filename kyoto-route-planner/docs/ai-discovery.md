# AI destination selection

`POST /api/discover` uses the existing server-only `GEMINI_API_KEY` (or its legacy
`RECOMMENDATION_GEMINI_API_KEY` alias). `GEMINI_MODEL` defaults to
`gemini-3.8-flash`. No additional API key or browser credential is required.

The endpoint first loads its finite facility catalog, using one Yahoo facility
search when configured and the existing bundled OpenStreetMap fallback. Radius,
theme, prefecture boundary, lodging and unsuitable-destination exclusions apply
before any model sees candidates. The nearest 80 eligible, distinct facilities
form the agent's entire search space; this is not a complete regional directory.

The agent makes exactly three Gemini function-calling turns:

1. `search_candidates` searches that catalog using a model-selected name/category
   query and a bounded result limit.
2. `inspect_candidates` inspects up to 60 returned IDs, receiving their exact
   names, coordinates, categories, distances and permitted evidence fact IDs.
3. `select_routes` chooses actual destination combinations, visit order and
   evidence fact IDs for each stop. It can propose up to the requested number
   of routes, each with one to three stops.

Only inspected IDs can be selected. Full names and coordinates must match,
including branch identity; repeated stops, repeated destination sets, invalid
counts, unsupported facts, extra/free-form fields, incomplete model output and
overlong routes fail closed to the existing deterministic suggestions.
All route coordinates, stop names, leg estimates and total duration are computed
by the application. Half-day routes are capped at 300 estimated minutes; other
routes at 600. These estimates include the return to the origin and are not live
transport timetables.

The model selects evidence rather than authoring unchecked factual claims.
Reasons use its chosen catalog category or curated official description/highlight
with matching facility ID, full name and nearby coordinates, combined with a
supported request fit. Free-form catalog descriptions/tags and model text are
not rendered as evidence. Per-stop reasons remain under 400 characters, and
route-level explanations under 600. Opening status, fees and actual transport
availability remain unverified during discovery.

## Response additions

Existing `routes`, `note` and `source` fields remain. `source` identifies the
facility catalog. A new `agent` object has `status: "ready" | "unavailable"` and
a user-facing `message`. Every route has `recommendation_source: "gemini" |
"rules"` and `recommendation_reason`. Each `spots[].reason` explains the selected
destination using permitted evidence. A rules fallback is explicitly identified;
it must never be presented as an AI selection.

## Time and spend bounds

The live facility lookup has its existing 12-second deadline. The complete agent
job has a 30-second deadline (including all three turns), each HTTP request has
a 20-second timeout, and connection setup has a 3-second timeout. There are no
model retries or model-controlled external URLs. Gemini 3 uses low thinking,
an 8192 output-token cap per turn, and preserved function-call IDs/thought
signatures. Deprecated sampling parameters are not sent.

Successes are cached for 15 minutes in an LRU cache of 128 condition/candidate
fingerprints. Identical in-flight requests share a task. A disconnected waiter
cannot cancel other waiters' work; the shared task still ends within its deadline
and releases capacity. Failures are not cached.

Each server process permits two active agent jobs and reserves the full three-call
budget before starting. Rolling ceilings of 30 calls per minute and 300 per hour
renew with time; exhausted budgets return an honest fallback without queuing.
These are per-process safeguards, so total service spend also depends on the
number of deployed workers/instances. They are not an account-wide billing cap.

## Verification

`backend/tests/test_discovery_agent.py` mocks every model response. It covers
actual selection/order, exact identities and branch confusion, stage boundaries,
hard filters, duration/count caps, malformed and truncated responses, injection,
fallback, cache isolation/expiry, concurrency, cancellation, renewed budgets,
timeouts, reason length and the Gemini wire format. Run with
`PYTHON_DOTENV_DISABLED=1` and an explicitly empty `GEMINI_API_KEY` when also
running existing integration tests; those tests should not use local credentials.

API implementation follows Google's official
[function-calling reference](https://ai.google.dev/gemini-api/docs/generate-content/function-calling),
[thought-signature guidance](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
and [Gemini 3.8 migration guidance](https://ai.google.dev/gemini-api/docs/generate-content/latest-model).
