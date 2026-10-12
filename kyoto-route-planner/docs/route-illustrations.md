# Route-specific illustrations

Discover cards now use verified facility photographs through `/api/routes/photo`; see [real-place-photos.md](real-place-photos.md). They do not call this illustration service or use the generated theme assets as a fallback. This module is retained for future explicitly enabled illustration features. Local automatic generation is disabled.

`backend/app/route_illustrations.py` generates an original illustration for a specific route title and its ordered destinations. It never claims to provide a facility photograph, an accurate exterior, or a reproduction of a collection or artwork. The prompt explicitly treats incoming route strings as data rather than instructions.

## Service contract

`RouteIllustrationRequest` contains `title` (1–500 characters), `theme` (`all`, `history`, `temple`, `nature`, or `food`), and `places` (1–8). Each place has `id`, `name`, `category`, `description` (up to 600 characters), `latitude`, and `longitude`.

- `await request_illustration(request)` immediately returns `RouteIllustrationResponse` with `status`, `key`, nullable `image_url`, and `note`.
- `get_illustration(key)` synchronously returns the current response without starting generation or incurring a cost.
- `illustration_path(key)` returns a validated local WebP Path or None for the image-serving endpoint.
- `illustration_key(request)` computes the stable 64-character lowercase SHA-256 cache key.
- `illustration_prompt(request)` exposes the exact prompt for reviewed preview generation.

Statuses are `pending`, `ready`, `disabled`, `busy`, and `error`. Ready image URLs are `/api/route-illustrations/{key}/image`; pending jobs can be polled at `/api/route-illustrations/{key}`. An unknown or invalid key returns error rather than creating a job. Handlers and frontend polling live outside this module.

## Configuration

For local use, put the server credential and `ROUTE_ILLUSTRATIONS_ENABLED=1` in the project's private `.local/personal-api.env` file. Do not put credentials in frontend files or browser storage. Resolution is **environment variables → project/.local/personal-api.env → backend/.env → defaults**. An environment variable explicitly set to an empty string prevents fallback to a file. Shared `app.ai_settings.setting` and `gemini_api_key` resolve settings using `dotenv_values(interpolate=False)`. Reads alone do not modify `os.environ`; at server startup, `configure_ai_environment()` installs only the resolved AI settings with `setdefault` before legacy clients load `backend/.env`. This prevents a blank template key or disabled flag in that file from overriding the private configuration, while preserving explicit process environment values. Within each source, `GEMINI_API_KEY` takes precedence over the compatible legacy `RECOMMENDATION_GEMINI_API_KEY`; an explicit empty value is respected. With `PYTHON_DOTENV_DISABLED=1`, local dotenv files are never read; this preserves the container's environment-only policy.

| Variable | Default | Behavior |
| --- | --- | --- |
| `ROUTE_ILLUSTRATIONS_ENABLED` | disabled | Must equal `1` to start new jobs. |
| `GEMINI_API_KEY` | absent | Server-only credential; never sent to a browser or logged. |
| `GEMINI_IMAGE_MODEL` | `gemini-nano-banana-2.1` | Explicit model used for new images and included in cache identity. |
| `ROUTE_ILLUSTRATION_DAILY_LIMIT` | `10` | UTC daily attempted generations, clamped to 1–100; invalid settings use 10. |
| `ROUTE_ILLUSTRATION_CACHE_DIR` | `backend/.local/route-illustrations` | Persistent private directory outside the application package. |

Already cached images are returned before checking credentials or opt-in, so disabling paid generation does not discard existing images. Without both opt-in and a server API key, a new request returns disabled and makes no external request.

Generation makes one POST to `https://generativelanguage.googleapis.com/v1beta/interactions` using the `x-goog-api-key` header, a 120-second httpx timeout, no redirects and no retries. Its JSON has `model`, an `input` text block containing the route-specific prompt, `store:false`, and `response_format:{type:"image",aspect_ratio:"3:2",image_size:"1K",mime_type:"image/jpeg"}`. The surrounding task deadline remains 125 seconds. No previous interaction, tools, server-side background job, or streaming response is requested.

The official [Nano Banana image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation) identifies `gemini-nano-banana-2.1` and its Interactions endpoint. The [Interactions REST reference](https://ai.google.dev/api/interactions-api) defines image response formats and the completed response structure: `status:"completed"`, with image blocks in `steps[].type="model_output"` / `content[].type="image"`, whose `data` is base64 and whose `mime_type` identifies the format. `output_image` is an SDK convenience, not the REST parser contract used here. Images in thought steps or blocks are never selected. Pending, requires-action, cancelled, failed or missing statuses are rejected; there must be exactly one final image. URI-only outputs are rejected rather than fetched. Account access and billing are separate deployment prerequisites. Unit tests never call the paid API; a separately authorized one-image live check is recorded in [gemini-image-verification.md](gemini-image-verification.md).


## Cache and cost controls

The key includes prompt version, provider (`gemini`), API (`v1beta/interactions`), model, 3:2 aspect ratio, 1K size, requested JPEG format, cached WebP format, title, theme, and every ordered destination's ID/name/category/description/coordinates. Reordering destinations or changing the title, place data, or generation settings produces a different key. Prior-provider cache keys are intentionally distinct; reviewed preview migration must explicitly recompute keys. These are route-specific assets, not five generic theme covers.

There is at most one running generation. Duplicate requests for its key return pending; other keys return busy. An exclusive `.generation.lock` also coordinates processes sharing the same directory. A crashed-process lock is considered stale after 180 seconds, longer than the job deadline. A malformed lock fails closed.

Before a paid attempt starts, the UTC day's count is atomically persisted in `budget-YYYY-MM-DD.json`. Failures and cancellations still consume that attempt because the provider may have billed them. Restarting the server preserves this count. Missing state begins at zero; corrupted state prevents generation instead of resetting the budget. Limits apply per shared cache directory, so deployments with several replicas must use a shared persistent directory or enforce an additional central quota. Ephemeral or different replica directories cannot provide an account-wide quota.

Errors create `<key>.error.json` with a five-minute cooldown. There are no automatic retry loops. A new explicit request after cooldown may make one new charged attempt, still subject to the daily limit. Successful files are `<key>.webp`, written through an exclusive temporary file and atomic replacement. Cached files have no required metadata sidecar. Persist the cache directory across restarts to retain images, budgets, locks, and failure cooldowns.

Response bodies are capped at 29 MiB; decoded images at 20 MiB. Base64 is decoded strictly. Only PNG, JPEG and WebP are accepted; the declared MIME type, file magic and Pillow-detected format must agree. Pillow verifies and fully decodes a single-frame image, capped at 4096 pixels per edge and 12×1024×1024 pixels total, then converts it to WebP without cropping or resizing. The resulting WebP is capped at 20 MiB and checked for RIFF/type/length magic before storage and again before serving. Animated images, oversized dimensions/pixel counts, truncated payloads, other formats and mismatched MIME types are rejected. Pillow is a required server dependency. Only exact lowercase 64-hex keys are accepted for file paths, and symlink or out-of-directory image paths are rejected. Raw provider errors, credentials and base64 are never included in responses or application logs.

## Reviewed preview installation

To install a separately generated, reviewed illustration without a paid runtime request, construct the exact request, call `illustration_key(request)`, and place the approved WebP at `<cacheDir>/<key>.webp`. The image must meet the same WebP envelope and size checks. No metadata file is required. Do not put the image under a guessed key or a key computed from different places/order/settings. A reviewed preview must retain the visible AI-illustration disclosure.

## Tests

The dedicated mocked tests verify disabled mode, immediate pending and ready transitions, cached reuse with no key, route-specific order-sensitive identity, concurrent/deduplicated requests, persistent daily budgets, five-minute errors, explicit post-cooldown retry, existing process locks, corrupted-budget failure, safe paths, API parameters, completed REST response parsing, exclusion of thought images, exactly one final image, PNG/JPEG/WebP conversion, MIME/magic agreement, animation/dimension/pixel limits, strict base64, and byte-size bounds. Shared configuration precedence is tested by the ai_settings tests. Tests never call the live Gemini API.
