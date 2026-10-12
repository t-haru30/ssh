import asyncio
import base64
import binascii
import json
from io import BytesIO
from PIL import Image
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app import route_illustrations as images


def request(title="金沢の工芸と文学を巡る", reverse=False):
    places = [dict(id="museum-1", name="金箔工芸館", category="博物館", description="金箔の技と文化", latitude=36.57, longitude=136.66), dict(id="museum-2", name="文学記念館", category="記念館", description="作家の生涯と文学", latitude=36.58, longitude=136.67)]
    return images.RouteIllustrationRequest(title=title, theme="history", places=list(reversed(places)) if reverse else places)


def image_bytes(format="WEBP", size=(6, 4)):
    output = BytesIO()
    Image.new("RGB", size, (40, 90, 70)).save(output, format=format)
    return output.getvalue()


def webp():
    return image_bytes()


def interaction(image=None, mime="image/jpeg", status="completed"):
    data = image if image is not None else image_bytes("JPEG")
    return {"status": status, "steps": [{"type": "model_output", "content": [{"type": "image", "data": base64.b64encode(data).decode(), "mime_type": mime}]}]}


class RouteIllustrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict("os.environ", {"ROUTE_ILLUSTRATION_CACHE_DIR": self.directory.name, "ROUTE_ILLUSTRATIONS_ENABLED": "1", "GEMINI_API_KEY": "test-only-not-real", "GEMINI_IMAGE_MODEL": "gemini-nano-banana-2.1", "PYTHON_DOTENV_DISABLED": "1", "RECOMMENDATION_GEMINI_API_KEY": "", "ROUTE_ILLUSTRATION_DAILY_LIMIT": "10"})
        self.env.start()
        self.addCleanup(self.env.stop)
        images._tasks.clear()

    async def asyncTearDown(self):
        tasks = list(images._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        images._tasks.clear()

    async def finish(self):
        if images._tasks:
            await asyncio.gather(*list(images._tasks.values()))

    async def test_missing_key_or_opt_in_disables_without_network_or_budget(self):
        for env in ({"GEMINI_API_KEY": ""}, {"ROUTE_ILLUSTRATIONS_ENABLED": "0"}):
            with self.subTest(env=env), patch.dict("os.environ", env), patch("app.route_illustrations._generate_bytes", new=AsyncMock()) as generate:
                result = await images.request_illustration(request())
                self.assertEqual(result.status, "disabled")
                generate.assert_not_awaited()
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    async def test_pending_then_ready_and_same_key_uses_cache(self):
        with patch("app.route_illustrations._generate_bytes", new=AsyncMock(return_value=webp())) as generate:
            result = await images.request_illustration(request())
            self.assertEqual(result.status, "pending")
            await self.finish()
            ready = images.get_illustration(result.key)
            reused = await images.request_illustration(request())
        self.assertEqual(ready.status, "ready")
        self.assertEqual(reused.status, "ready")
        self.assertEqual(ready.image_url, f"/api/route-illustrations/{result.key}/image")
        self.assertEqual(generate.await_count, 1)
        self.assertEqual(images.illustration_path(result.key).read_bytes(), webp())

    async def test_preexisting_cache_works_without_enabled_or_api_key(self):
        key = images.illustration_key(request())
        (Path(self.directory.name) / (key + ".webp")).write_bytes(webp())
        with patch.dict("os.environ", {"GEMINI_API_KEY": "", "ROUTE_ILLUSTRATIONS_ENABLED": "0"}), patch("app.route_illustrations._generate_bytes", new=AsyncMock()) as generate:
            result = await images.request_illustration(request())
        self.assertEqual(result.status, "ready")
        generate.assert_not_awaited()

    async def test_duplicate_pending_is_not_charged_twice_and_other_route_is_busy(self):
        waiting = asyncio.Event()
        async def slow(*args):
            await waiting.wait()
            return webp()
        with patch("app.route_illustrations._generate_bytes", side_effect=slow) as generate:
            first = await images.request_illustration(request())
            duplicate = await images.request_illustration(request())
            other = await images.request_illustration(request("別の旅"))
            self.assertEqual((first.status, duplicate.status, other.status), ("pending", "pending", "busy"))
            waiting.set()
            await self.finish()
        self.assertEqual(generate.await_count, 1)
        budget = next(Path(self.directory.name).glob("budget-*.json"))
        self.assertEqual(json.loads(budget.read_text())["attempts"], 1)

    async def test_daily_budget_survives_task_state_reset(self):
        with patch.dict("os.environ", {"ROUTE_ILLUSTRATION_DAILY_LIMIT": "1"}), patch("app.route_illustrations._generate_bytes", new=AsyncMock(return_value=webp())) as generate:
            await images.request_illustration(request())
            await self.finish()
            images._tasks.clear()
            result = await images.request_illustration(request("次の旅"))
        self.assertEqual(result.status, "busy")
        self.assertIn("本日", result.note)
        self.assertEqual(generate.await_count, 1)

    async def test_failure_retained_five_minutes_and_counts_toward_daily_budget(self):
        with patch("app.route_illustrations._generate_bytes", new=AsyncMock(side_effect=ValueError("private provider error and secret"))) as generate:
            first = await images.request_illustration(request())
            await self.finish()
            result = await images.request_illustration(request())
        self.assertEqual(result.status, "error")
        self.assertNotIn("secret", result.model_dump_json())
        self.assertEqual(generate.await_count, 1)
        state = json.loads((Path(self.directory.name) / (first.key + ".error.json")).read_text())
        self.assertGreater(state["expires_at"], images.time.time() + 295)
        budget = next(Path(self.directory.name).glob("budget-*.json"))
        self.assertEqual(json.loads(budget.read_text())["attempts"], 1)

    async def test_failure_retry_requires_expiry_and_new_explicit_request(self):
        key = images.illustration_key(request())
        (Path(self.directory.name) / (key + ".error.json")).write_text(json.dumps({"expires_at": images.time.time() - 1}))
        with patch("app.route_illustrations._generate_bytes", new=AsyncMock(return_value=webp())) as generate:
            result = await images.request_illustration(request())
            await self.finish()
        self.assertEqual(result.status, "pending")
        self.assertEqual(generate.await_count, 1)

    async def test_existing_process_lock_blocks_new_task(self):
        (Path(self.directory.name) / ".generation.lock").write_text(json.dumps({"key": "a" * 64, "started": images.time.time()}))
        with patch("app.route_illustrations._generate_bytes", new=AsyncMock()) as generate:
            result = await images.request_illustration(request())
        self.assertEqual(result.status, "busy")
        generate.assert_not_awaited()

    async def test_invalid_budget_fails_closed_without_paid_request(self):
        day = images.datetime.now(images.timezone.utc).date().isoformat()
        (Path(self.directory.name) / ("budget-" + day + ".json")).write_text("bad json")
        with patch("app.route_illustrations._generate_bytes", new=AsyncMock()) as generate:
            result = await images.request_illustration(request())
        self.assertEqual(result.status, "error")
        generate.assert_not_awaited()

    def test_route_specific_key_and_prompt_include_order_title_and_all_attributes(self):
        first = request()
        self.assertNotEqual(images.illustration_key(first), images.illustration_key(request(reverse=True)))
        self.assertNotEqual(images.illustration_key(first), images.illustration_key(request("違うタイトル")))
        changed = first.model_copy(deep=True)
        changed.places[0].longitude += 0.001
        self.assertNotEqual(images.illustration_key(first), images.illustration_key(changed))
        prompt = images.illustration_prompt(first)
        for expected in (first.title, "金箔工芸館", "文学記念館", "金箔の技と文化", "36.57", "history", "not a photograph"):
            self.assertIn(expected, prompt)
        self.assertLess(prompt.index("金箔工芸館"), prompt.index("文学記念館"))

    def test_path_rejects_traversal_wrong_format_and_corrupt_cache(self):
        for key in ("../secret", "a" * 63, "A" * 64, "a" * 64 + "/secret"):
            self.assertIsNone(images.illustration_path(key))
            self.assertEqual(images.get_illustration(key).status, "error")
        key = "a" * 64
        (Path(self.directory.name) / (key + ".webp")).write_bytes(b"not an image")
        self.assertIsNone(images.illustration_path(key))


class ImageProviderTests(unittest.IsolatedAsyncioTestCase):
    def context(self, payload, status=200):
        response = Mock(status_code=status)
        async def chunks():
            yield json.dumps(payload).encode()
        response.aiter_bytes = chunks
        stream = AsyncMock()
        stream.__aenter__.return_value = response
        client = AsyncMock()
        client.stream = Mock(return_value=stream)
        context = AsyncMock()
        context.__aenter__.return_value = client
        return client, context

    async def test_exact_api_parameters_single_request_and_valid_base64(self):
        client, context = self.context(interaction())
        with patch("app.route_illustrations.httpx.AsyncClient", return_value=context) as factory, patch.dict("os.environ", {"GEMINI_IMAGE_MODEL": "gemini-nano-banana-2.1", "PYTHON_DOTENV_DISABLED": "1"}):
            result = await images._generate_bytes(request(), "test-only")
        self.assertTrue(images._valid_webp(result))
        with Image.open(BytesIO(result)) as image:
            self.assertEqual(image.size, (6, 4))
        self.assertEqual(client.stream.call_count, 1)
        self.assertEqual(client.stream.call_args.args[:2], ("POST", "https://generativelanguage.googleapis.com/v1beta/interactions"))
        self.assertEqual(client.stream.call_args.kwargs["headers"], {"x-goog-api-key": "test-only"})
        body = client.stream.call_args.kwargs["json"]
        self.assertEqual(body["model"], "gemini-nano-banana-2.1")
        self.assertEqual(body["response_format"], {"type": "image", "aspect_ratio": "3:2", "image_size": "1K", "mime_type": "image/jpeg"})
        self.assertFalse(body["store"])
        self.assertEqual(body["input"][0]["type"], "text")
        self.assertIn(request().title, body["input"][0]["text"])
        self.assertEqual(factory.call_args.kwargs["timeout"], 120)
        self.assertFalse(factory.call_args.kwargs["follow_redirects"])

    async def test_bad_base64_wrong_magic_and_http_failure_are_rejected(self):
        bad = interaction()
        bad["steps"][0]["content"][0]["data"] = "bad%%%"
        for payload, status in ((bad, 200), (interaction(b"not an image"), 200), ({"status": "completed", "steps": []}, 200), ({"error": "private failure"}, 429)):
            with self.subTest(status=status):
                client, context = self.context(payload, status)
                with patch("app.route_illustrations.httpx.AsyncClient", return_value=context):
                    with self.assertRaises((ValueError, binascii.Error)):
                        await images._generate_bytes(request(), "test-only")
                self.assertEqual(client.stream.call_count, 1)

    async def test_encoded_and_decoded_size_limits(self):
        client, context = self.context(interaction())
        with patch("app.route_illustrations.httpx.AsyncClient", return_value=context), patch("app.route_illustrations.MAX_IMAGE_BYTES", 10):
            with self.assertRaises(ValueError):
                await images._generate_bytes(request(), "test-only")

    def test_png_jpeg_and_webp_decode_and_convert(self):
        for format, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            with self.subTest(format=format):
                converted = images._interaction_image(interaction(image_bytes(format), mime))
                self.assertTrue(images._valid_webp(converted))
                with Image.open(BytesIO(converted)) as image:
                    self.assertEqual(image.format, "WEBP")
                    self.assertEqual(image.size, (6, 4))

    def test_incomplete_status_and_thought_only_images_are_rejected(self):
        for status in ("in_progress", "requires_action", "cancelled", "failed", None):
            with self.subTest(status=status), self.assertRaises(ValueError):
                images._interaction_image(interaction(status=status))
        thought = interaction()
        thought["steps"][0]["type"] = "thought"
        thought["steps"][0]["summary"] = thought["steps"][0].pop("content")
        with self.assertRaises(ValueError):
            images._interaction_image(thought)

    def test_final_image_does_not_use_thought_image(self):
        result = interaction()
        result["steps"].insert(0, {"type": "thought", "summary": [{"type": "image", "data": "not-a-final-image", "mime_type": "image/jpeg"}]})
        self.assertTrue(images._valid_webp(images._interaction_image(result)))
        result["steps"][-1]["content"][0]["thought"] = True
        with self.assertRaises(ValueError):
            images._interaction_image(result)

    def test_multiple_images_uri_only_and_mime_mismatch_rejected(self):
        multiple = interaction()
        multiple["steps"][0]["content"] *= 2
        uri_only = interaction()
        uri_only["steps"][0]["content"][0] = {"type": "image", "mime_type": "image/jpeg", "uri": "https://example.com/image"}
        for result in (multiple, uri_only, interaction(image_bytes("PNG"), "image/jpeg"), interaction(image_bytes("GIF"), "image/gif")):
            with self.assertRaises(ValueError):
                images._interaction_image(result)

    def test_dimension_pixel_and_animation_limits(self):
        with patch("app.route_illustrations.MAX_IMAGE_EDGE", 5), self.assertRaises(ValueError):
            images._interaction_image(interaction())
        with patch("app.route_illustrations.MAX_IMAGE_PIXELS", 20), self.assertRaises(ValueError):
            images._interaction_image(interaction())
        animated = BytesIO()
        Image.new("RGB", (6, 4), "red").save(animated, format="PNG", save_all=True, append_images=[Image.new("RGB", (6, 4), "blue")], duration=100)
        with self.assertRaises(ValueError):
            images._interaction_image(interaction(animated.getvalue(), "image/png"))


class SharedImageConfigurationTests(unittest.TestCase):
    def test_provider_uses_shared_settings_and_gemini_key(self):
        with patch("app.route_illustrations.setting", side_effect=lambda name, default="": {"GEMINI_IMAGE_MODEL": "test-image-model", "ROUTE_ILLUSTRATION_CACHE_DIR": ""}.get(name, default)) as setting:
            self.assertEqual(images._model(), "test-image-model")
            self.assertTrue(images._root().name == "route-illustrations")
        self.assertEqual(setting.call_args_list[0].args[0], "GEMINI_IMAGE_MODEL")

    def test_cache_identity_includes_gemini_provider_and_image_configuration(self):
        with patch("app.route_illustrations.setting", side_effect=lambda name, default="": default):
            key = images.illustration_key(request())
            with patch("app.route_illustrations._model", return_value="another-image-model"):
                self.assertNotEqual(key, images.illustration_key(request()))
        self.assertEqual(len(key), 64)
