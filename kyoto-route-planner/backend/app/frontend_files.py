"""Revalidate the entry page so new visits do not reuse an old chunk manifest."""
from fastapi.staticfiles import StaticFiles


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.headers.get("content-type", "").startswith("text/html") or response.status_code == 304:
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
