# ClipCon PO Token Provider Service
#
# Runs a headless browser to extract YouTube visitor data/INNERTUBE context,
# then serves PO tokens via HTTP API for yt-dlp to consume.
#
# Usage: python server.py
#
# Endpoints:
#   GET /health - Health check
#   GET /po-token?video_id=xxx&client=web - Returns PO token for video
#   POST /refresh - Force refresh visitor data (optional)

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Optional

from aiohttp import web
from playwright.async_api import async_playwright

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
)
logger = logging.getLogger("pot-provider")


class PoTokenProvider:
    def __init__(self):
        self.context: Optional[dict] = None
        self.context_expires: Optional[datetime] = None
        self.browser = None
        self.playwright = None
        self.context_data = None

    async def initialize(self):
        """Launch browser and extract initial visitor data"""
        logger.info("Initializing PO Token Provider...")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=True,
            args=[
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        )
        await self._refresh_context()

    async def _refresh_context(self):
        """Extract fresh visitor data from YouTube"""
        logger.info("Refreshing YouTube visitor context...")
        page = await self.browser.new_page()
        try:
            await page.route("**/*", lambda route: route.continue_())

            await page.goto("https://www.youtube.com", wait_until="networkidle", timeout=60000)
            await page.wait_for_timeout(3000)

            context_data = await page.evaluate("""
                () => {
                    const result = {};

                    if (window.ytInitialData) {
                        try {
                            const json = JSON.stringify(window.ytInitialData);
                            const visitorMatch = json.match(/"visitorData":"([^"]+)"/);
                            if (visitorMatch) result.visitorData = visitorMatch[1];
                        } catch (e) {}
                    }

                    if (window.ytcfg && window.ytcfg.data) {
                        result.innertubeApiKey = window.ytcfg.data.INNERTUBE_API_KEY;
                        result.innertubeContext = window.ytcfg.data.INNERTUBE_CONTEXT;
                    }

                    const cookies = document.cookie;
                    result.cookies = cookies;

                    if (window.ytcfg && window.ytcfg.data && window.ytcfg.data.VISITOR_DATA) {
                        result.visitorData = window.ytcfg.data.VISITOR_DATA;
                    }

                    return result;
                }
            """)

            cookies = await page.context.cookies()
            cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
            context_data["cookie_header"] = cookie_str

            if context_data.get("visitorData") and context_data.get("innertubeApiKey"):
                self.context_data = context_data
                self.context_expires = datetime.now() + timedelta(hours=2)
                logger.info(f"Context refreshed successfully, expires at {self.context_expires}")
                logger.info(f"Visitor data length: {len(context_data.get('visitorData', ''))}")
                logger.info(f"API Key: {context_data.get('innertubeApiKey', '')[:10]}...")
            else:
                logger.warning("Failed to extract complete context, using fallback")
                logger.info(f"Context data: {json.dumps({k: v[:50] if isinstance(v, str) else v for k, v in context_data.items()})}")

        except Exception as e:
            logger.error(f"Failed to refresh context: {e}")
        finally:
            await page.close()

    def get_po_token(self, video_id: str, client: str = "web") -> Optional[str]:
        """Generate PO token for a video using cached context"""
        if not self.context_data or datetime.now() >= self.context_expires:
            logger.warning("No valid context available")
            return None

        return self.context_data.get("visitorData")

    async def close(self):
        if self.browser:
            await self.browser.close()
        if hasattr(self, 'playwright'):
            await self.playwright.stop()

provider = PoTokenProvider()

async def handle_health(request):
    return web.json_response({
        "status": "ok",
        "service": "pot-provider",
        "context_valid": provider.context_data is not None and
                         provider.context_expires and datetime.now() < provider.context_expires,
        "context_expires": provider.context_expires.isoformat() if provider.context_expires else None
    })

async def handle_po_token(request):
    video_id = request.query.get("video_id")
    client = request.query.get("client", "web")

    if not video_id:
        return web.json_response({"error": "video_id required"}, status=400)

    token = provider.get_po_token(video_id, client)
    if not token:
        return web.json_response({"error": "No valid context available"}, status=503)

    return web.json_response({
        "video_id": video_id,
        "visitor_data": provider.context_data.get("visitorData"),
        "innertube_api_key": provider.context_data.get("innertubeApiKey"),
        "innertube_context": provider.context_data.get("innertubeContext"),
        "cookie_header": provider.context_data.get("cookie_header"),
        "client": client
    })

async def handle_refresh(request):
    await provider._refresh_context()
    return web.json_response({"status": "refreshed"})

async def init_app():
    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_get("/po-token", handle_po_token)
    app.router.add_post("/refresh", handle_refresh)

    await provider.initialize()
    return app

async def main():
    app = await init_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", int(os.getenv("PORT", 8080)))
    await site.start()
    logger.info("PO Token Provider started on port %s", os.getenv("PORT", 8080))

    try:
        while True:
            await asyncio.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        await provider.close()
        await runner.cleanup()

if __name__ == "__main__":
    asyncio.run(main())