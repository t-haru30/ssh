"""Revalidate entry pages and serve WebP correctly on minimal runtimes."""
from fastapi.staticfiles import StaticFiles


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Minimal Linux images may lack a system MIME database for WebP, causing
        # FileResponse to fall back to text/plain despite serving image bytes.
        if path.casefold().endswith(".webp") and response.status_code in {200, 206}:
            response.headers["Content-Type"] = "image/webp"
        if response.headers.get("content-type", "").startswith("text/html") or response.status_code == 304:
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
